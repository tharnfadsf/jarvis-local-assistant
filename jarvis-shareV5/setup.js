'use strict';
// JARVIS Share — in-app setup wizard backend (2026-10-28 upgrade).
//
// The wizard needs server-side truth: what platform this is, what features
// actually work here, which AI providers are configured, whether Ollama is
// reachable and which models it has, and whether the TTS/ASR runtimes exist.
// It never returns secret VALUES — only masked hints and booleans — and the
// Test Connection button performs a real, small probe against the endpoint
// the user chose, only when they click it.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const capabilities = require('./platform-capabilities.js');
const secureStore = require('./secure-store.js');

// Keys the wizard knows how to save. Everything else is rejected so an
// attacker-picked payload cannot grow the file arbitrarily.
const SECRET_KEYS = [
  'FISH_API_KEY', 'FISH_REFERENCE_ID', 'FISH_MODEL',
  'OPENCODE_API_KEY', 'OPENCODE_MODEL', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL',
  'JARVIS_GOOGLE_ACCOUNT', 'DISCORD_WEBHOOK_URL'
];
// Non-secret settings the wizard may write into .env. Everything else is
// rejected so a tampered wizard payload cannot add arbitrary env keys.
const ENV_KEYS = ['JARVIS_TAB_CONTROL', 'JARVIS_VAULT_PATH', 'JARVIS_SYSTEM_INTERVAL'];
const ENV_VALUE_LIMIT = 'auto:off:on';
const PROVIDERS = [
  { id: 'local', label: 'Local AI (Ollama)', needsKey: false, note: 'Conversations stay on this machine. Requires the Ollama app and a pulled model.' },
  { id: 'opencode', label: 'OpenCode Zen (OpenAI-compatible)', needsKey: true, note: 'Free-tier models by default. External service: your messages are processed on their servers.' },
  { id: 'openrouter', label: 'OpenRouter (OpenAI-compatible)', needsKey: true, note: 'Free models carry a ":free" suffix. External service: your messages are processed on their servers.' }
];

function maskKey(value) {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 8) return '*'.repeat(v.length);
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

async function probeOllama(ollamaUrl) {
  const base = String(ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  try {
    const started = Date.now();
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, endpoint: base, message: `Ollama answered HTTP ${res.status}.` };
    const data = await res.json().catch(() => ({}));
    const models = Array.isArray(data.models) ? data.models.map(m => String(m.name || '')).filter(Boolean) : [];
    return { ok: true, endpoint: base, models, ms: Date.now() - started, message: models.length ? `Ollama is running with ${models.length} model(s).` : 'Ollama is running but has no models yet.' };
  } catch (error) {
    return { ok: false, endpoint: base, message: `Ollama is not reachable at ${base}. Install it from ollama.com and start the app, then retry.` };
  }
}

async function probeOpenAiCompatible({ baseUrl, apiKey, model }) {
  const url = `${String(baseUrl || '').replace(/\/$/, '')}/chat/completions`;
  if (!/^https:\/\//.test(url)) return { ok: false, message: 'The endpoint must be an https:// URL.' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(apiKey || '')}` },
      body: JSON.stringify({ model: String(model || ''), messages: [{ role: 'user', content: 'Reply with exactly: ok' }], max_tokens: 16, stream: false }),
      signal: AbortSignal.timeout(30000)
    });
    const text = await res.text();
    if (!res.ok) {
      const hint = text.slice(0, 140).replace(/\s+/g, ' ');
      return { ok: false, httpStatus: res.status, message: `The provider answered HTTP ${res.status}. ${/401|403/.test(String(res.status)) ? 'Check the API key.' : hint}` };
    }
    let answer = '';
    try { answer = String(JSON.parse(text).choices?.[0]?.message?.content || '').trim(); } catch { answer = ''; }
    return answer
      ? { ok: true, message: `Connected. ${model || 'model'} replied: "${answer.slice(0, 40)}"` }
      : { ok: false, message: 'The endpoint answered but returned no message content.' };
  } catch (error) {
    return { ok: false, message: `Could not reach ${url}: ${String(error.name === 'TimeoutError' ? 'timed out after 30 s' : error.message || error).slice(0, 160)}` };
  }
}

function createSetupWizard({ root, log = () => {}, onSecretsSaved = () => {} } = {}) {
  const setupStatePath = path.join(os.tmpdir(), 'jarvis-share-setup.json');
  const wizardStatePath = () => {
    const dir = capabilities.PLATFORM === 'win32'
      ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
      : capabilities.PLATFORM === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
    return path.join(dir, 'JARVIS', 'setup-state.json');
  };

  // Small non-secret persistence for wizard progress + non-sensitive prefs.
  function readSetupState() {
    try { return JSON.parse(fs.readFileSync(wizardStatePath(), 'utf8')); } catch { return {}; }
  }
  function writeSetupState(patch) {
    const file = wizardStatePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const next = { ...readSetupState(), ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  async function getStatus() {
    const runtime = capabilities.runtimeInfo();
    const store = await secureStore.status();
    const secrets = await secureStore.readAll();
    const configured = {};
    for (const key of SECRET_KEYS) configured[key] = Boolean((secrets.values || {})[key]);
    const ollama = await probeOllama(process.env.JARVIS_OLLAMA_URL || 'http://127.0.0.1:11434');
    const optionalTools = await capabilities.detectOptionalTools().catch(() => ({}));
    return {
      ok: true,
      platform: {
        os: runtime.os, osVersion: runtime.osVersion, arch: runtime.arch,
        isWindows: runtime.isWindows, isMacOS: runtime.isMacOS, isLinux: runtime.isLinux,
        isArchLinux: runtime.isArchLinux, distro: runtime.distro, node: runtime.node, host: runtime.host
      },
      features: capabilities.featureSupport(process.platform),
      asr: capabilities.asrBinaryLayout(process.platform),
      credentialStore: store,
      secretsConfigured: configured,
      providers: PROVIDERS,
      ollama,
      optionalTools,
      setupState: readSetupState()
    };
  }

  // Non-secret settings (e.g. JARVIS_TAB_CONTROL) go into .env, the same file
  // the rest of JARVIS reads. Only allowlisted keys, sanitized booleans/enums/numbers.
  function writeEnvNonSecrets(values) {
    // Same file readLocalEnv uses, so JARVIS_ENV_FILE (tests) keeps isolating.
    const envFile = process.env.JARVIS_ENV_FILE || path.join(root, '.env');
    const accepted = {};
    for (const [keyRaw, valueRaw] of Object.entries(values).slice(0, 10)) {
      const key = String(keyRaw).trim();
      if (!ENV_KEYS.includes(key)) continue;
      let value = String(valueRaw).trim().slice(0, 300);
      if (!value || /\r|\n|"/.test(value)) continue;
      if (key === 'JARVIS_TAB_CONTROL' && !['auto', 'off'].includes(value)) continue;
      if (key === 'JARVIS_SYSTEM_INTERVAL' && !/^(500|[1-9]\d{3,5})$/.test(value)) continue;
      accepted[key] = value;
    }
    if (!Object.keys(accepted).length) return { ok: true, written: 0 };
    let lines = [];
    try { lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line !== ''); } catch {}
    for (const [key, value] of Object.entries(accepted)) {
      const pattern = new RegExp(`^\\s*${key}\\s*=`);
      const index = lines.findIndex(line => pattern.test(line));
      const line = `${key}=${value}`;
      if (index >= 0) lines[index] = line;
      else lines.push(line);
    }
    try {
      const temporary = `${envFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${lines.join('\r\n')}\r\n`, 'utf8');
      fs.renameSync(temporary, envFile);
    } catch (error) {
      return { ok: false, message: `Could not update .env: ${String(error.message || error).slice(0, 160)}` };
    }
    return { ok: true, written: Object.keys(accepted).length, keys: Object.keys(accepted) };
  }

  async function saveStep({ step, provider, secrets, options, env }) {
    // Persist non-secrets into setup-state.json, secrets into secure-store.
    const patch = {};
    if (step !== undefined) patch.step = Math.max(0, Math.min(7, Number(step) || 0));
    if (provider) patch.provider = String(provider).slice(0, 40);
    if (options && typeof options === 'object') {
      const safeOptions = {};
      for (const [key, value] of Object.entries(options).slice(0, 40)) safeOptions[String(key).slice(0, 60)] = value === true || value === false || value === null || typeof value === 'number' ? value : String(value).slice(0, 400);
      patch.options = { ...(readSetupState().options || {}), ...safeOptions };
    }
    writeSetupState(patch);
    if (secrets && typeof secrets === 'object') {
      const clean = {};
      for (const key of SECRET_KEYS) if (typeof secrets[key] === 'string' && secrets[key].trim()) clean[key] = secrets[key].trim().slice(0, 300);
      if (Object.keys(clean).length) {
        const saved = await secureStore.setSecrets(clean);
        if (!saved.ok) return saved;
        // Let the host process re-read which keys exist now (it caches the
        // unlocked secret map for loadLocalEnv; it never sees the values).
        try { await onSecretsSaved(); } catch {}
      }
    }
    if (env && typeof env === 'object') {
      const applied = writeEnvNonSecrets(env);
      if (!applied.ok) return applied;
    }
    return { ok: true, state: readSetupState() };
  }

  async function testProvider({ provider, baseUrl, apiKey, model }) {
    const id = String(provider || '');
    if (id === 'local') return probeOllama(baseUrl || process.env.JARVIS_OLLAMA_URL || 'http://127.0.0.1:11434');
    if (id === 'opencode') return probeOpenAiCompatible({ baseUrl: baseUrl || 'https://opencode.ai/inference/openai/v1', apiKey, model: model || 'glm-5.3-flash-free' });
    if (id === 'openrouter') return probeOpenAiCompatible({ baseUrl: baseUrl || 'https://openrouter.ai/api/v1', apiKey, model: model || 'nvidia/nemotron-3.5-super-vl:free' });
    return { ok: false, message: 'Unknown provider.' };
  }

  async function ollamaInstallModel({ model }) {
    const name = String(model || '').trim().slice(0, 80);
    if (!/^[A-Za-z0-9._:-]+$/.test(name)) return { ok: false, message: 'That model name is not valid.' };
    const probe = await probeOllama(process.env.JARVIS_OLLAMA_URL);
    if (!probe.ok) return probe;
    try {
      log(`[setup] pulling ollama model ${name}`);
      const res = await fetch(`${probe.endpoint}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, stream: false }), signal: AbortSignal.timeout(30 * 60 * 1000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) return { ok: false, message: `Model pull failed: ${String(data.error || res.status).slice(0, 200)}` };
      return { ok: true, message: `Model ${name} downloaded.` };
    } catch (error) {
      return { ok: false, message: `Model pull failed or was interrupted: ${String(error.message || error).slice(0, 160)}` };
    }
  }

  async function finish({ clearWizard = false } = {}) {
    const state = readSetupState();
    writeSetupState({ completedAt: new Date().toISOString() });
    if (clearWizard) writeSetupState({ dismissed: true });
    return { ok: true, state: readSetupState(), message: 'Setup saved. You can reopen it any time from Settings.' };
  }

  async function reopen() {
    writeSetupState({ dismissed: false, reopenRequested: true });
    return { ok: true };
  }

  return { getStatus, saveStep, testProvider, ollamaInstallModel, finish, reopen, handleRequest, _internal: { maskKey, readSetupState, writeSetupState, wizardStatePath, PROVIDERS, SECRET_KEYS } };

  // ---------- HTTP routing (called by server.js BEFORE other routers) ----------
  // Returns true when the request was handled, so server.js can stop there.
  async function handleRequest(req, res) {
    const url = req.url && req.url.split('?')[0];
    const route =
      req.method === 'GET' && url === '/api/setup/status' ? () => getStatus() :
      req.method === 'POST' && url === '/api/setup/save' ? () => readBody(req).then(saveStep) :
      req.method === 'POST' && url === '/api/setup/test' ? () => readBody(req).then(b => testProvider({ provider: b.provider, baseUrl: b.baseUrl, apiKey: b.apiKey, model: b.model })) :
      req.method === 'POST' && url === '/api/setup/ollama/install' ? () => readBody(req).then(b => ollamaInstallModel({ model: b.model })) :
      req.method === 'POST' && url === '/api/setup/finish' ? () => readBody(req).then(b => finish({ clearWizard: b.clearWizard === true })) :
      req.method === 'POST' && url === '/api/setup/reopen' ? () => reopen() :
      null;
    if (!route) return false;
    try {
      const result = await route();
      sendJson(res, 200, result);
    } catch (error) {
      log(`[setup] ${error && error.message ? error.message : error}`);
      sendJson(res, 500, { ok: false, message: 'That setup step failed. The reason is in the JARVIS log, with no secrets included.' });
    }
    return true;
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const req = request; // the wizard's handleRequest passes its own req
      const parts = []; let bytes = 0;
      req.on('data', chunk => { bytes += chunk.length; if (bytes > 16000) { req.destroy(); reject(new Error('Setup payload too large.')); return; } parts.push(chunk); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (error) { reject(new Error('Invalid JSON in the setup request.')); } });
      req.on('error', reject);
    });
  }

  function sendJson(res, status, payload) {
    if (!res || res.finished) return;
    const body = JSON.stringify(payload || {});
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }
}

module.exports = { createSetupWizard, probeOllama, probeOpenAiCompatible, SECRET_KEYS, PROVIDERS, maskKey };
