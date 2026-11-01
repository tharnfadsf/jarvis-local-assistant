// =====================================================================
// JARVIS AI Router (2026-10-19)
//
// Small shared routing layer for authorized AI providers. Features keep
// their own logic (system prompt, tool loop, quality gates); this module
// only decides WHICH provider serves a call and normalizes the wire
// format so switching providers never changes the conversation shape.
//
// Providers:
//   opencode — OpenCode Zen (documented OpenAI-compatible endpoint
//              https://opencode.ai/inference/openai/v1/chat/completions,
//              Bearer API key from the OpenCode console). The default
//              model is a documented free-tier model; paid models are
//              refused unless AI_ALLOW_PAID=1 is set.
//   freebuff — Disabled placeholder. No authorized, documented public API
//              exists for it (checked 2026-10-19). It activates only when
//              the user configures AI_FREEBUFF_URL + AI_FREEBUFF_KEY +
//              AI_FREEBUFF_MODEL to an endpoint they are authorized to
//              use. No third-party proxies are installed automatically.
//   local    — the existing Ollama service (behavior unchanged; when no
//              remote provider is configured the router is bypassed).
//
// Modes (ai-config.json):
//   auto  — try configured remote providers first, fall back to Ollama.
//           With no remote provider configured this behaves exactly like
//           the historical local-only path.
//   local — Local AI Only. Remote providers are never contacted; no
//           conversation content leaves the device, even if a key exists.
//
// Secrets never reach logs or errors: redact() masks every configured
// key before anything is recorded or returned.
// =====================================================================
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_OPENCODE_BASE = 'https://opencode.ai/inference/openai/v1';
const DEFAULT_OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
// Documented free on OpenCode Zen as of 2026-10 (docs: /docs/zen).
const OPENCODE_FREE_MODELS = ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free'];
const DEFAULT_OPENCODE_MODEL = 'glm-5.3-flash-free';
// Documented free OpenRouter model (user-verified snippet, 2026-10-19).
const DEFAULT_OPENROUTER_MODEL = 'nvidia/nemotron-3.5-super-vl:free';
const VALID_MODES = ['auto', 'local'];

function nowMs() { return Date.now(); }

function maskKey(key) {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 10) return '*'.repeat(value.length);
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function redact(text, secrets) {
  let out = String(text || '');
  for (const secret of secrets || []) {
    const value = String(secret || '').trim();
    if (value.length >= 8) out = out.split(value).join('[redacted]');
  }
  return out;
}

function readJsonSafe(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

// Parses the project's .env the same way loadLocalEnv does in server.js,
// so the router can read keys without coupling to the server module.
function readEnvKeys(envFile, wanted) {
  const found = {};
  try {
    const source = fs.readFileSync(envFile, 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || !wanted.has(match[1])) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      found[match[1]] = value;
    }
  } catch {}
  return found;
}

// Rewrites (or appends) KEY=value lines in .env atomically, preserving the
// rest of the file. Same approach as saveFishConfig in server.js.
function writeEnvKeys(envFile, values) {
  let lines = [];
  try { lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line !== ''); } catch {}
  let changed = false;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue; // leave this entry untouched
    const expression = new RegExp(`^\\s*${key}\\s*=`);
    const index = lines.findIndex(line => expression.test(line));
    const line = `${key}=${value}`;
    if (index >= 0) { if (lines[index] !== line) { lines[index] = line; changed = true; } }
    else { lines.push(line); changed = true; }
  }
  if (!changed) return false;
  const temporary = `${envFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${lines.join('\r\n')}\r\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, envFile);
  return true;
}

// The conversation tool loop pushes Ollama-shaped messages:
//   {role:'assistant', content, tool_calls:[{function:{name, arguments}}]}
//   {role:'tool', tool_name, content}
// OpenAI-compatible endpoints need tool_call ids, stringified arguments and
// no extra fields. Conversion is deterministic and pairwise correct: ids are
// handed out to each assistant's calls in order and tool responses consume
// them from a FIFO queue, so a tool message always references the exact call
// it answers — matching the loop, which executes and pushes results in order.
// Multimodal content (OpenAI chat-completions shape):
//   [{type:'text', text}, {type:'image_url', image_url:{url:'data:image/jpeg;base64,…'}}]
// Only inline data-URL images are allowed through: a remote URL would make the
// provider fetch a third-party address on our behalf. Anything else is dropped
// so a malformed part can never turn into an unexpected outbound request.
function normalizeContentParts(parts) {
  const out = [];
  for (const part of (parts || []).slice(0, 8)) {
    if (!part || typeof part !== 'object') continue;
    const url = part.type === 'image_url'
      ? String(part.image_url?.url || part.image_url || '')
      : '';
    if (url) {
      if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(url)) out.push({ type: 'image_url', image_url: { url } });
      continue;
    }
    const text = String(part.text ?? (typeof part.content === 'string' ? part.content : '')).trim();
    if (text) out.push({ type: 'text', text });
  }
  return out.length ? out : '';
}

function normalizeMessagesForOpenAI(messages, { includeReasoningDetails = false } = {}) {
  const out = [];
  let callIndex = 0;
  let pending = [];
  let lastEmittedId = 'call_0';
  for (const raw of (messages || []).slice(-40)) {
    if (!raw || typeof raw !== 'object') continue;
    const role = String(raw.role || '');
    const content = typeof raw.content === 'string' ? raw.content : normalizeContentParts(raw.content);
    const hasContent = typeof content === 'string' ? content.trim().length > 0 : content.length > 0;
    if (role === 'system' || role === 'user') {
      if (hasContent) out.push({ role, content });
    } else if (role === 'assistant') {
      const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls.slice(0, 8) : [];
      if (calls.length) {
        out.push({
          role: 'assistant',
          content: content || null,
          tool_calls: calls.map(call => {
            const id = `call_${callIndex++}`;
            pending.push(id);
            lastEmittedId = id;
            return {
              id,
              type: 'function',
              function: {
                name: String(call.function?.name || ''),
                arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments || {}),
              },
            };
          }),
        });
      } else if (content.trim() || (includeReasoningDetails && Array.isArray(raw.reasoning_details))) {
        const entry = { role: 'assistant', content: content || null };
        // OpenRouter reasoning passthrough: reasoning_details must be returned
        // unmodified for continuation; other providers do not want the field.
        if (includeReasoningDetails && Array.isArray(raw.reasoning_details) && raw.reasoning_details.length) entry.reasoning_details = raw.reasoning_details;
        out.push(entry);
      }
    } else if (role === 'tool') {
      const id = pending.length ? pending.shift() : lastEmittedId;
      out.push({ role: 'tool', tool_call_id: id, content });
    }
  }
  return out;
}

function openAiChatBody({ model, messages, tools, maxTokens, stream, includeReasoningDetails, reasoningEnabled }) {
  const body = {
    model,
    messages: normalizeMessagesForOpenAI(messages, { includeReasoningDetails }),
    max_tokens: Math.max(64, Math.min(4096, Number(maxTokens) || 768)),
    stream: Boolean(stream),
  };
  if (reasoningEnabled === true) body.reasoning = { enabled: true }; // OpenRouter-compatible reasoning opt-in
  else if (reasoningEnabled === false) body.reasoning = { enabled: false }; // reasoning models default ON; plain JARVIS asks must not spend the token budget on hidden reasoning
  if (Array.isArray(tools) && tools.length) {
    // Same function schema the local loop uses (Ollama adopted the OpenAI
    // shape), so the array can be passed through unchanged.
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  return body;
}

function isFreeModel(model) {
  return OPENCODE_FREE_MODELS.includes(model) || /(^|[-_:])(free)([-_:.]|$)/i.test(String(model || ''));
}

function createAiGateway(options = {}) {
  const root = options.root || process.cwd();
  const envFile = options.envFile || path.join(root, '.env');
  const configFile = options.configPath || path.join(root, 'ai-config.json');
  const ollamaUrl = String(options.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl || ((url, init) => fetch(url, init)); // injectable for tests
  const log = options.log || (() => {});

  // ---- per-process provider state ----
  const PROVIDER_IDS = ['opencode', 'openrouter', 'freebuff', 'local'];
  function resetState(id) {
    const defaults = { id, calls: 0, ok: 0, failed: 0, lastErrorClass: '', lastError: '', lastLatencyMs: 0, avgLatencyMs: 0, consecutiveFails: 0, cooldownUntil: 0, lastModel: '' };
    return defaults;
  }
  const state = new Map();
  for (const id of PROVIDER_IDS) state.set(id, resetState(id));

  // ---- configuration (ai-config.json) ----
  let configCache = null;
  function sanitizeOrder(stored) {
    const valid = ['opencode', 'openrouter', 'freebuff'];
    const list = Array.isArray(stored) ? stored.filter(id => valid.includes(id)) : valid.slice();
    for (const id of valid) if (!list.includes(id)) list.push(id);
    return list;
  }
  function loadConfig() {
    if (configCache) return configCache;
    const stored = readJsonSafe(configFile, {});
    configCache = {
      version: 1,
      mode: VALID_MODES.includes(String(stored.mode || '').toLowerCase()) ? String(stored.mode).toLowerCase() : 'auto',
      order: sanitizeOrder(stored.order),
      conversation: String(stored.conversation || 'auto').toLowerCase() === 'local' ? 'local' : 'auto',
    };
    return configCache;
  }
  function saveConfig(patch = {}) {
    const current = loadConfig();
    const merged = {
      version: 1,
      mode: VALID_MODES.includes(String(patch.mode || '').toLowerCase()) ? String(patch.mode).toLowerCase() : current.mode,
      order: patch.order ? sanitizeOrder(patch.order) : current.order,
      conversation: patch.conversation === 'local' ? 'local' : patch.conversation === 'auto' ? 'auto' : current.conversation,
    };
    writeJsonAtomic(configFile, merged);
    configCache = null;
    return loadConfig();
  }

  // ---- credentials & settings from .env ----
  const ENV_KEYS = new Set(['OPENCODE_API_KEY', 'OPENCODE_MODEL', 'AI_ALLOW_PAID', 'AI_REMOTE_TIMEOUT_MS', 'AI_OPENCODE_URL', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'AI_OPENROUTER_URL', 'AI_FREEBUFF_URL', 'AI_FREEBUFF_KEY', 'AI_FREEBUFF_MODEL']);
  function envSettings() {
    const env = readEnvKeys(envFile, ENV_KEYS);
    const placeholder = v => /^(your_|example|placeholder|xxx)/i.test(String(v || '').trim());
    let opencodeKey = (process.env.OPENCODE_API_KEY || env.OPENCODE_API_KEY || '').trim();
    if (placeholder(opencodeKey)) opencodeKey = '';
    let openrouterKey = (process.env.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY || '').trim();
    if (placeholder(openrouterKey)) openrouterKey = '';
    const freebuffUrl = (process.env.AI_FREEBUFF_URL || env.AI_FREEBUFF_URL || '').trim();
    const freebuffKey = (process.env.AI_FREEBUFF_KEY || env.AI_FREEBUFF_KEY || '').trim();
    const freebuffModel = (process.env.AI_FREEBUFF_MODEL || env.AI_FREEBUFF_MODEL || '').trim();
    let remoteTimeout = Number(process.env.AI_REMOTE_TIMEOUT_MS || env.AI_REMOTE_TIMEOUT_MS) || 45000;
    remoteTimeout = Math.max(5000, Math.min(120000, remoteTimeout));
    return {
      opencodeKey,
      opencodeBase: ((process.env.AI_OPENCODE_URL || env.AI_OPENCODE_URL || '').trim() || DEFAULT_OPENCODE_BASE).replace(/\/$/, ''),
      opencodeModel: (process.env.OPENCODE_MODEL || env.OPENCODE_MODEL || '').trim() || DEFAULT_OPENCODE_MODEL,
      openrouterKey,
      openrouterBase: ((process.env.AI_OPENROUTER_URL || env.AI_OPENROUTER_URL || '').trim() || DEFAULT_OPENROUTER_BASE).replace(/\/$/, ''),
      openrouterModel: (process.env.OPENROUTER_MODEL || env.OPENROUTER_MODEL || '').trim() || DEFAULT_OPENROUTER_MODEL,
      allowPaid: /^(1|true|yes)$/i.test(String(process.env.AI_ALLOW_PAID || env.AI_ALLOW_PAID || '0')),
      remoteTimeoutMs: remoteTimeout,
      freebuff: freebuffUrl && freebuffKey && freebuffModel && /^https?:\/\//i.test(freebuffUrl)
        ? { baseUrl: freebuffUrl.replace(/\/$/, ''), key: freebuffKey, model: freebuffModel }
        : null,
    };
  }

  function secrets() {
    const settings = envSettings();
    return [settings.opencodeKey, settings.openrouterKey, settings.freebuff ? settings.freebuff.key : ''].filter(Boolean);
  }

  function configured() {
    const settings = envSettings();
    return { opencode: Boolean(settings.opencodeKey), openrouter: Boolean(settings.openrouterKey), freebuff: Boolean(settings.freebuff), local: true };
  }

  function isCoolingDown(id) {
    const entry = state.get(id) || resetState(id);
    return entry.cooldownUntil > nowMs();
  }

  // Effective remote order for the next call: configured providers in the
  // configured order, skipping ones in cooldown. Local AI Only returns [].
  function eligibleRemoteIds() {
    if (loadConfig().mode === 'local') return [];
    if (loadConfig().conversation === 'local') return [];
    const ready = configured();
    const list = [];
    for (const id of loadConfig().order) {
      if (id !== 'opencode' && id !== 'openrouter' && id !== 'freebuff') continue;
      if (!ready[id]) continue;
      if (isCoolingDown(id)) continue;
      list.push(id);
    }
    return list;
  }

  function hasRemote() { return eligibleRemoteIds().length > 0; }

  // ---- metrics ----
  function recordResult(id, ok, extra = {}) {
    const entry = state.get(id) || resetState(id);
    entry.calls += 1;
    entry.lastLatencyMs = Math.max(0, Number(extra.latencyMs) || 0);
    if (extra.model) entry.lastModel = String(extra.model).slice(0, 100);
    if (ok) {
      entry.ok += 1;
      entry.consecutiveFails = 0;
      entry.lastErrorClass = '';
      entry.lastError = '';
      entry.avgLatencyMs = entry.ok > 1 ? Math.round((entry.avgLatencyMs * (entry.ok - 1) + entry.lastLatencyMs) / entry.ok) : entry.lastLatencyMs;
    } else {
      entry.failed += 1;
      entry.consecutiveFails += 1;
      entry.lastErrorClass = String(extra.errorClass || 'unknown').slice(0, 40);
      entry.lastError = redact(String(extra.error || '').slice(0, 200), secrets());
      if (Number(extra.cooldownUntil) > entry.cooldownUntil) entry.cooldownUntil = Number(extra.cooldownUntil);
      // Simple circuit breaker: three consecutive failures give the provider
      // two quiet minutes so repeated asks do not hammer a broken provider.
      if (entry.consecutiveFails >= 3) entry.cooldownUntil = Math.max(entry.cooldownUntil, nowMs() + 120000);
    }
    state.set(id, entry);
    log(`[JARVIS ai-router] ${id} ${ok ? 'ok' : 'failed'} class=${extra.errorClass || '-'} latency=${entry.lastLatencyMs}ms model=${entry.lastModel || '-'}`);
  }

  async function classifyHttp(id, response, bodyText) {
    const status = Number(response.status) || 0;
    let parsed = {};
    try { parsed = JSON.parse(bodyText || '{}'); } catch {}
    const message = redact(String(parsed.error?.message || parsed.error || parsed.detail || `HTTP ${status}`).slice(0, 300), secrets());
    if (status === 401 || status === 403) return { errorClass: 'auth', message, cooldownMs: 900000 };
    if (status === 429) {
      let retryAfterMs = 60000;
      let raw = null;
      try { raw = response.headers?.get('retry-after'); } catch {}
      if (raw) {
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0) retryAfterMs = seconds * 1000;
        else {
          const asDate = Date.parse(raw);
          if (!Number.isNaN(asDate)) retryAfterMs = Math.max(1000, asDate - nowMs());
        }
      }
      return { errorClass: 'rate-limited', message: message || 'Rate limited by the provider.', cooldownMs: Math.min(3600000, Math.max(1000, retryAfterMs)) };
    }
    if (status === 404 || status === 400) {
      const unknown = /model|not[_ ]?found|unsupported|does not exist/i.test(message || '');
      return unknown
        ? { errorClass: 'unsupported-model', message, cooldownMs: 600000 }
        : { errorClass: 'invalid-request', message, cooldownMs: 0 };
    }
    if (status >= 500) return { errorClass: 'server', message, cooldownMs: 30000 };
    return { errorClass: 'unknown', message, cooldownMs: 10000 };
  }

  function friendlyError(errorClass) {
    if (errorClass === 'auth') return 'The remote AI provider rejected its API key, so JARVIS answered with the local model instead.';
    if (errorClass === 'rate-limited') return 'The remote AI provider rate limited this request, so JARVIS answered with the local model instead.';
    if (errorClass === 'unsupported-model') return 'The configured remote AI model is not available right now, so JARVIS answered with the local model instead.';
    return 'The remote AI provider was unavailable, so JARVIS answered with the local model instead.';
  }

  // ---- OpenAI-compatible adapters ----
  async function* openAiStreamToOllamaLines({ url, headers, body, signal }) {
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      const verdict = await classifyHttp('remote', response, text);
      throw Object.assign(new Error(verdict.message), { errorClass: verdict.errorClass, cooldownMs: verdict.cooldownMs });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawAnything = false;
    let doneSeen = false;
    const feedLine = trimmed => {
      if (!trimmed || !trimmed.startsWith('data:')) return null;
      const payload = trimmed.slice(5).trim();
      if (!payload) return null;
      if (payload === '[DONE]') return { done: true };
      let chunk; try { chunk = JSON.parse(payload); } catch { return null; }
      const choice = Array.isArray(chunk.choices) && chunk.choices.length ? chunk.choices[0] : null;
      if (!choice) return null;
      const delta = choice.delta || {};
      const packet = { message: {} };
      const text = typeof delta.content === 'string' ? delta.content : '';
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      if (text) packet.message.content = text;
      if (calls.length) {
        packet.message.tool_calls = calls.map(call => ({
          index: Number.isInteger(call.index) ? call.index : 0,
          function: {
            name: String(call.function?.name || ''),
            arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : (call.function?.arguments ? JSON.stringify(call.function.arguments) : ''),
          },
        }));
      }
      if (!packet.message.content && !packet.message.tool_calls) {
        // Some providers stream reasoning only; finish_reason arrives separately.
        return chunk.finish_reason === 'stop' ? { done: true } : null;
      }
      return { packet };
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const outcome = feedLine(rawLine.trim());
        if (!outcome) continue;
        if (outcome.done) { doneSeen = true; break; }
        sawAnything = true;
        yield JSON.stringify(outcome.packet);
      }
      if (doneSeen) break;
    }
    if (!doneSeen) {
      // Provider closed without a [DONE] sentinel; still honor a trailing
      // data line so nothing visible is lost.
      const tailOutcome = feedLine(buffer.trim());
      if (tailOutcome && tailOutcome.packet) { sawAnything = true; yield JSON.stringify(tailOutcome.packet); }
    }
    if (!sawAnything) {
      // A stream that ends with nothing usable is treated as a failure so the
      // failover can try the next provider instead of emitting an empty turn.
      throw Object.assign(new Error('The remote provider returned an empty response stream.'), { errorClass: 'empty-response' });
    }
  }

  async function openAiOnceToOllamaData({ url, headers, body, signal }) {
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      const verdict = await classifyHttp('remote', response, raw);
      throw Object.assign(new Error(verdict.message), { errorClass: verdict.errorClass, cooldownMs: verdict.cooldownMs });
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
      throw Object.assign(new Error('The remote provider returned an unreadable response.'), { errorClass: 'invalid-response' });
    }
    const choice = Array.isArray(parsed.choices) && parsed.choices.length ? parsed.choices[0] : null;
    const message = choice ? (choice.message || {}) : {};
    const content = String(message.content || '');
    const calls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map(call => ({ function: { name: String(call.function?.name || ''), arguments: call.function?.arguments ?? {} } }))
      : [];
    if (!content.trim() && !calls.length) {
      throw Object.assign(new Error('The remote provider returned an empty response.'), { errorClass: 'empty-response' });
    }
    return { message: calls.length ? { content, tool_calls: calls } : { content } };
  }

  // ---- provider request builders ----
  function remoteTargetFor(id, settings) {
    if (id === 'opencode') {
      const model = settings.opencodeModel;
      if (!settings.allowPaid && !isFreeModel(model)) {
        throw Object.assign(new Error(`Model "${model}" is not a documented free model with this OpenCode credential. Set OPENCODE_MODEL to a -free model, or set AI_ALLOW_PAID=1 to opt in to metered models.`), { errorClass: 'paid-model-blocked', cooldownMs: 3600000 });
      }
      const base = settings.opencodeBase;
      const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
      return { url, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.opencodeKey}` }, model };
    }
    if (id === 'openrouter') {
      const model = settings.openrouterModel;
      // OpenRouter model ids mark their free tier with a ":free" suffix, e.g.
      // nvidia/nemotron-3.5-super-vl:free. Without the suffix the call costs
      // credits, so it needs the same explicit allowPaid opt-in as Zen.
      if (!settings.allowPaid && !isFreeModel(model)) {
        throw Object.assign(new Error(`Model "${model}" is not a free-tier OpenRouter model. Set OPENROUTER_MODEL to a ":free" model, or set AI_ALLOW_PAID=1 to opt in to metered models.`), { errorClass: 'paid-model-blocked', cooldownMs: 3600000 });
      }
      const base = settings.openrouterBase;
      const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
      return { url, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.openrouterKey}` }, model, providerFlavor: 'openrouter' };
    }
    if (id === 'freebuff' && settings.freebuff) {
      const base = settings.freebuff.baseUrl;
      const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
      return { url, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.freebuff.key}` }, model: settings.freebuff.model };
    }
    return null;
  }

  function combineSignals(signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  // ---- public turn API ----
  // Streaming: yields Ollama ndjson LINES (strings), exactly the byte shape
  // the historical direct-Ollama reader consumed, so the caller's parsing,
  // envelope suppression and tool accumulation stay untouched.
  async function* turnStream({ messages, tools, model, maxTokens, think, signal, meta }) {
    const settings = envSettings();
    const ids = eligibleRemoteIds();
    for (const id of ids) {
      const started = nowMs();
      let target = null;
      try { target = remoteTargetFor(id, settings); } catch (error) {
        recordResult(id, false, { errorClass: error.errorClass || 'config', error: error.message, cooldownUntil: nowMs() + (error.cooldownMs || 0), model: '—' });
        continue;
      }
      if (!target) continue;
      let metaSet = false;
      try {
        for await (const line of openAiStreamToOllamaLines({
          url: target.url,
          headers: target.headers,
          body: openAiChatBody({
            model: target.model, messages, tools, maxTokens, stream: true,
            includeReasoningDetails: target.providerFlavor === 'openrouter',
            reasoningEnabled: target.providerFlavor === 'openrouter' ? Boolean(think) : undefined,
          }),
          signal: combineSignals(signal, settings.remoteTimeoutMs),
        })) {
          if (!metaSet && meta) { meta.provider = id; meta.model = target.model; metaSet = true; }
          yield line;
        }
        recordResult(id, true, { latencyMs: nowMs() - started, model: target.model });
        return;
      } catch (error) {
        const clientCancelled = error.name === 'AbortError' && signal && signal.aborted;
        if (clientCancelled) {
          recordResult(id, false, { errorClass: 'cancelled', error: 'The client closed the stream while JARVIS was waiting for the answer.' });
          throw error;
        }
        recordResult(id, false, {
          errorClass: error.errorClass || 'server',
          error: error.message,
          cooldownUntil: nowMs() + (Number(error.cooldownMs) || 0),
          model: target.model,
        });
        // Failover only before the first visible chunk: once anything was
        // yielded, silently restarting risks duplicate partial answers, so
        // the turn fails and the user sees the honest error path instead.
        if (metaSet) throw Object.assign(new Error(friendlyError(error.errorClass || 'server')), { providerId: id, errorClass: error.errorClass || 'server' });
        continue;
      }
    }
    // local (unchanged direct Ollama call; wires the same abort signal)
    if (meta) { meta.provider = 'local'; meta.model = model; }
    const started = nowMs();
    let remoteTriedStream = ids.length > 0;
    try {
      for await (const line of ollamaStreamLocally({ messages, tools, model, maxTokens, think, signal })) yield line;
      recordResult('local', true, { latencyMs: nowMs() - started, model });
    } catch (error) {
      recordResult('local', false, { errorClass: error.name === 'AbortError' && signal && signal.aborted ? 'cancelled' : 'server', error: error.message, model });
      if (error.name === 'AbortError' && signal && signal.aborted) throw error;
      const unreachable = error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED' || /fetch failed|bad port|ENOTFOUND|ECONNRESET/i.test(String(error.message) + String(error.cause?.message || ''));
      let message = unreachable ? 'Could not reach the local Ollama service.' : 'The local model stream stopped before it finished. Try asking that again.';
      if (remoteTriedStream) message += ' The remote provider was also unavailable just now, so there was nothing to fall back to.';
      throw Object.assign(new Error(message), { errorClass: 'server', cause: error });
    }
  }

  async function* ollamaStreamLocally({ messages, tools, model, maxTokens, think, signal }) {
    const response = await fetchImpl(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        tools: tools || undefined,
        stream: true,
        think: think ? undefined : false,
        keep_alive: '30m',
        options: { num_ctx: 8192, num_predict: maxTokens, num_thread: Math.max(2, Math.min(8, (require('os').cpus().length || 4))) },
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(response.ok ? 'Ollama did not provide a streaming response.' : `Ollama returned HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) yield line;
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer;
  }

  // Non-streaming: returns an Ollama-shaped turn {message:{content, tool_calls?}}
  // plus attribution, with the same provider walk and failover.
  async function turnData({ messages, tools, model, maxTokens, think, signal, meta }) {
    const settings = envSettings();
    const ids = eligibleRemoteIds();
    let remoteTried = false;
    for (const id of ids) {
      const started = nowMs();
      let target = null;
      try { target = remoteTargetFor(id, settings); } catch (error) {
        recordResult(id, false, { errorClass: error.errorClass || 'config', error: error.message, cooldownUntil: nowMs() + (error.cooldownMs || 0), model: '—' });
        continue;
      }
      if (!target) continue;
      try {
        const data = await openAiOnceToOllamaData({
          url: target.url,
          headers: target.headers,
          body: openAiChatBody({
            model: target.model, messages, tools, maxTokens, stream: false,
            includeReasoningDetails: target.providerFlavor === 'openrouter',
            reasoningEnabled: target.providerFlavor === 'openrouter' ? Boolean(think) : undefined,
          }),
          signal: combineSignals(signal, settings.remoteTimeoutMs),
        });
        recordResult(id, true, { latencyMs: nowMs() - started, model: target.model });
        if (meta) { meta.provider = id; meta.model = target.model; }
        return { data, provider: id, model: target.model };
      } catch (error) {
        const clientCancelled = error.name === 'AbortError' && signal && signal.aborted;
        remoteTried = true;
        recordResult(id, false, {
          errorClass: clientCancelled ? 'cancelled' : (error.errorClass || 'server'),
          error: error.message,
          cooldownUntil: nowMs() + (Number(error.cooldownMs) || 0),
          model: target.model,
        });
        if (clientCancelled) throw error;
        continue;
      }
    }
    if (meta) { meta.provider = 'local'; meta.model = model; }
    const started = nowMs();
    try {
      const response = await fetchImpl(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          tools: tools || undefined,
          stream: false,
          think: think ? undefined : false,
          keep_alive: '30m',
          options: { num_ctx: 8192, num_predict: maxTokens, num_thread: Math.max(2, Math.min(8, (require('os').cpus().length || 4))) },
        }),
        signal,
      });
      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        let message = `Ollama returned HTTP ${response.status}.`;
        try { const parsed = JSON.parse(raw); message = String(parsed.error || message).slice(0, 500); } catch {}
        throw Object.assign(new Error(message), { errorClass: 'server' });
      }
      const data = await response.json();
      recordResult('local', true, { latencyMs: nowMs() - started, model });
      return { data, provider: 'local', model };
    } catch (error) {
      if (error.errorClass) throw error;
      let message = error.name === 'TimeoutError' ? 'The local model took too long to respond. Try a smaller model or ask a shorter question.' : 'Could not reach the local Ollama service.';
      if (remoteTried) message += ' The remote provider was also unavailable just now, so there was nothing to fall back to.';
      recordResult('local', false, { errorClass: 'server', error: error.message, model });
      throw Object.assign(new Error(message), { errorClass: 'server', remoteTried });
    }
  }

  // ---- Vision turns (multimodal: text + base64 image) ----
  // Same provider walk, same failover, same Local AI Only gate. The image is
  // always an inline data URL (never a remote URL), so no third-party fetch is
  // ever triggered on our behalf. Remote providers that don't support vision
  // simply fail with unsupported-model and are skipped.
  async function turnVisionStream({ messages, imageB64, model, maxTokens, signal, meta }) {
    // Merge the image into the last user message (OpenAI multimodal shape).
    const mmMessages = (messages || []).map((m, i, arr) => {
      if (i === arr.length - 1 && m.role === 'user' && typeof m.content === 'string') {
        return { role: 'user', content: [
          { type: 'text', text: m.content },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } }
        ]};
      }
      return m;
    });
    return turnStream({ messages: mmMessages, tools: undefined, model, maxTokens, think: false, signal, meta });
  }

  async function turnVisionData({ messages, imageB64, model, maxTokens, signal, meta }) {
    const mmMessages = (messages || []).map((m, i, arr) => {
      if (i === arr.length - 1 && m.role === 'user' && typeof m.content === 'string') {
        return { role: 'user', content: [
          { type: 'text', text: m.content },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } }
        ]};
      }
      return m;
    });
    return turnData({ messages: mmMessages, tools: undefined, model, maxTokens, think: false, signal, meta });
  }

  function status() {
    const settings = envSettings();
    const config = loadConfig();
    return {
      mode: config.mode,
      order: config.order,
      conversation: config.conversation,
      configured: configured(),
      remoteEligible: eligibleRemoteIds(),
      masked: { opencodeKey: maskKey(settings.opencodeKey), opencodeModel: settings.opencodeModel, openrouterKey: maskKey(settings.openrouterKey), openrouterModel: settings.openrouterModel },
      providers: Object.fromEntries(PROVIDER_IDS.map(id => {
        const entry = state.get(id) || resetState(id);
        return [id, {
          calls: entry.calls, ok: entry.ok, failed: entry.failed,
          lastErrorClass: entry.lastErrorClass,
          lastError: entry.lastError,
          lastLatencyMs: entry.lastLatencyMs,
          avgLatencyMs: entry.avgLatencyMs,
          coolingDown: entry.cooldownUntil > nowMs(),
          cooldownRemainingMs: Math.max(0, entry.cooldownUntil - nowMs()),
          lastModel: entry.lastModel,
        }];
      })),
    };
  }

  // Saves user-facing settings: mode (and optional provider credentials).
  // Empty-string values clear; undefined leaves the existing value alone.
  // Secrets are written only to .env (never to ai-config.json or the share).
  function saveSettings(patch = {}) {
    const envValues = {};
    let messages = [];
    if (typeof patch.zenKey === 'string' && patch.zenKey.trim()) {
      const key = patch.zenKey.trim();
      if (!/^[A-Za-z0-9._~+-]{16,240}$/.test(key)) return { ok: false, message: 'That does not look like a valid API key. Nothing was saved.' };
      envValues.OPENCODE_API_KEY = key;
      messages.push('OpenCode API key saved.');
    } else if (patch.zenKey === '') envValues.OPENCODE_API_KEY = '';
    if (typeof patch.zenModel === 'string') {
      const model = patch.zenModel.trim();
      if (model && !/^[\w.:/-]{1,120}$/.test(model)) return { ok: false, message: 'That model name contains unsupported characters. Nothing was saved.' };
      envValues.OPENCODE_MODEL = model;
      if (model) messages.push(`Remote model set to ${model}.`);
    }
    if (typeof patch.openrouterKey === 'string' && patch.openrouterKey.trim()) {
      const key = patch.openrouterKey.trim();
      if (!/^[A-Za-z0-9._~+-]{16,240}$/.test(key)) return { ok: false, message: 'That does not look like a valid OpenRouter API key. Nothing was saved.' };
      envValues.OPENROUTER_API_KEY = key;
      messages.push('OpenRouter API key saved.');
    } else if (patch.openrouterKey === '') envValues.OPENROUTER_API_KEY = '';
    if (typeof patch.openrouterModel === 'string') {
      const model = patch.openrouterModel.trim();
      if (model && !/^[\w.:/-]{1,160}$/.test(model)) return { ok: false, message: 'That OpenRouter model name contains unsupported characters. Nothing was saved.' };
      envValues.OPENROUTER_MODEL = model;
      if (model) messages.push(`OpenRouter model set to ${model}.`);
    }
    for (const [patchKey, envKey] of [['freebuffUrl', 'AI_FREEBUFF_URL'], ['freebuffKey', 'AI_FREEBUFF_KEY'], ['freebuffModel', 'AI_FREEBUFF_MODEL']]) {
      if (typeof patch[patchKey] === 'string') envValues[envKey] = patch[patchKey].trim();
    }
    if (envValues.AI_FREEBUFF_URL !== undefined || envValues.AI_FREEBUFF_KEY !== undefined || envValues.AI_FREEBUFF_MODEL !== undefined) {
      messages.push('Freebuff slot updated. It stays disabled until all three Freebuff values are set.')
    }
    if (Object.keys(envValues).length) writeEnvKeys(envFile, envValues);
    if (patch.mode !== undefined) {
      if (!VALID_MODES.includes(patch.mode)) return { ok: false, message: 'Choose Automatic with local fallback, or Local AI only.' };
      saveConfig({ mode: patch.mode });
      messages.push(patch.mode === 'local' ? 'Local AI only: remote providers will not be contacted.' : 'Automatic: configured remote providers are tried first, with local fallback.');
    }
    let config = null;
    try { config = loadConfig(); } catch {}
    return { ok: true, config, message: messages.join(' ') || 'Settings saved.' };
  }

  // Cheap real call against a remote provider, same shape aiDiagnose uses for
  // Ollama. Returns { ok, provider, model, ms, text } or { ok:false, message }.
  async function verifyRemote(id = 'opencode', signal) {
    const settings = envSettings();
    let target = null;
    try { target = remoteTargetFor(id, settings); } catch (error) { return { ok: false, message: friendlyError(error.errorClass || 'config'), errorClass: error.errorClass }; }
    if (!target) return { ok: false, message: `${id} is not configured.` };
    const started = nowMs();
    try {
      const response = await fetchImpl(target.url, {
        method: 'POST',
        headers: target.headers,
        body: JSON.stringify({ model: target.model, messages: [{ role: 'user', content: 'Reply with exactly: ok' }], max_tokens: 64, stream: false }),
        signal: combineSignals(signal, 30000),
      });
      const raw = await response.text().catch(() => '');
      if (!response.ok) {
        const verdict = await classifyHttp(id, response, raw);
        recordResult(id, false, { errorClass: verdict.errorClass, error: verdict.message, cooldownUntil: nowMs() + verdict.cooldownMs, model: target.model });
        return { ok: false, message: verdict.message, errorClass: verdict.errorClass };
      }
      let parsed; try { parsed = JSON.parse(raw); } catch { return { ok: false, message: 'Unreadable response from the provider.' }; }
      const text = String(parsed.choices?.[0]?.message?.content || '').trim();
      const latencyMs = nowMs() - started;
      if (!text) {
        recordResult(id, false, { errorClass: 'empty-response', error: 'Verification probe returned no text.', model: target.model });
        return { ok: false, message: 'The provider answered without text. Try again in a moment.' };
      }
      recordResult(id, true, { latencyMs, model: target.model });
      return { ok: true, provider: id, model: target.model, ms: latencyMs, text };
    } catch (error) {
      if (error.name !== 'AbortError') {
        recordResult(id, false, { errorClass: error.errorClass || 'server', error: error.message, model: target.model });
      }
      return { ok: false, message: error.name === 'TimeoutError' ? 'The provider took too long to answer.' : redact(String(error.message || 'Remote verification failed.'), secrets()), errorClass: error.errorClass || 'network' };
    }
  }

  return {
    // routing
    hasRemote,
    eligibleRemoteIds,
    turnStream,
    turnData,
    turnVisionStream,
    turnVisionData,
    // config & diagnosis
    loadConfig,
    saveConfig,
    saveSettings,
    status,
    verifyRemote,
    // exposed for tests / honest reporting
    _internal: { classifyHttp, normalizeMessagesForOpenAI, isFreeModel, friendlyError, recordResult, readEnvKeys, writeEnvKeys, envSettings, state },
  };
}

module.exports = { createAiGateway, maskKey, redact, normalizeMessagesForOpenAI, DEFAULT_OPENCODE_MODEL, OPENCODE_FREE_MODELS };
