'use strict';
// =====================================================================
// JARVIS MEMORY VAULT (Obsidian-compatible Markdown storage)
//
// Direct filesystem access to a plain Markdown "vault" folder so JARVIS has
// persistent, human-readable memory and conversation logs that survive
// restarts and browser-storage wipes. The folder is a valid Obsidian vault:
// if the user installs Obsidian later, they can open it directly.
//
// Default location: <user>/Documents/JARVIS  (override: JARVIS_VAULT_PATH)
// Structure:
//   Index.md
//   Conversation Logs/YYYY-MM-DD.md   (chronological, grouped per day)
//   Memory/User Preferences.md
//   Memory/Important Context.md
//   Memory/Ongoing Topics.md
//   Memory/Projects and Goals.md
//
// EVERY public function is failure-tolerant: a missing folder, a locked
// file, or a bad path returns { ok:false } and never throws, so a vault
// problem can never crash the conversation (spec test G).
// Nothing is ever sent anywhere: all access is local filesystem only.
// =====================================================================
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_VAULT = path.join(os.homedir(), 'Documents', 'JARVIS');
const LOG_DIR = 'Conversation Logs';
const MEM_DIR = 'Memory';
const MEMORY_FILES = ['User Preferences.md', 'Important Context.md', 'Ongoing Topics.md', 'Projects and Goals.md'];

function vaultPath() {
  const configured = typeof process.env.JARVIS_VAULT_PATH === 'string' ? process.env.JARVIS_VAULT_PATH.trim() : '';
  return configured || DEFAULT_VAULT;
}
// Routing heuristics only decide WHICH file a saved note lives in. They never
// decide whether a note is saved (that is the existing sensitive-data gate).
function memoryFileFor(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(?:prefer|likes?|loves?|hates?|favourite|favorite|dislike|always want|don't like|dont like|my usual)\b/.test(t)) return 'User Preferences.md';
  if (/\b(?:project|goal|building|making|working on|roblox|game|channel|upload|exam|assignment|portfolio)\b/.test(t)) return 'Projects and Goals.md';
  if (/\b(?:currently|right now|these days|still|ongoing|waiting for|planning)\b/.test(t)) return 'Ongoing Topics.md';
  return 'Important Context.md';
}
function normalizeForCompare(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}
function stamp(at) {
  // Fixed 24-hour format (locale-independent) so the state()/recall() parsers
  // match every line the log writer produces — toLocaleTimeString can emit
  // "8:32 PM" or "08.32" depending on the OS locale and would never parse.
  const d = Number(at) ? new Date(Number(at)) : new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function dayKey(at) {
  const d = Number(at) ? new Date(Number(at)) : new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function safeRun(fn) {
  try { return fn(); } catch (error) { return { ok: false, error: String(error && error.message || error).slice(0, 160) }; }
}

function ensureStructure() {
  return safeRun(() => {
    const root = vaultPath();
    fs.mkdirSync(path.join(root, LOG_DIR), { recursive: true });
    fs.mkdirSync(path.join(root, MEM_DIR), { recursive: true });
    for (const name of MEMORY_FILES) {
      const file = path.join(root, MEM_DIR, name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${name.replace(/\.md$/, '')}\n\n`, 'utf8');
    }
    const index = path.join(root, 'Index.md');
    if (!fs.existsSync(index)) {
      fs.writeFileSync(index, [
        '# JARVIS Memory Index', '',
        'Plain Markdown memory for JARVIS. Open this folder in Obsidian to browse it.', '',
        `## Memory`, '',
        ...MEMORY_FILES.map(name => `- [[${name.replace(/\.md$/, '')}]]`),
        '', `## ${LOG_DIR}`, '', 'Daily conversation logs live in this folder, one file per day.', ''
      ].join('\n'), 'utf8');
    }
    return { ok: true, path: root };
  });
}

function logTurn({ who, text, at } = {}) {
  return safeRun(() => {
    const body = oneLine(text);
    if (!body) return { ok: false, reason: 'empty' };
    const ready = ensureStructure();
    if (!ready.ok) return ready;
    const key = dayKey(at);
    const file = path.join(vaultPath(), LOG_DIR, `${key}.md`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `# JARVIS conversation log — ${key}\n\n`, 'utf8');
    const speaker = String(who || '').toUpperCase() === 'YOU' ? 'USER' : 'JARVIS';
    // 600 characters cut long answers mid-word in the Markdown log ("... Once
    // it is secured, y"), which reads like the assistant broke off. Keep the
    // whole turn up to a generous limit and mark a real truncation.
    const logged = body.length > 4000 ? `${body.slice(0, 4000).trimEnd()}…` : body;
    fs.appendFileSync(file, `- ${stamp(at)} **${speaker}**: ${logged}\n`, 'utf8');
    return { ok: true };
  });
}

function parseMemoryFile(name) {
  const file = path.join(vaultPath(), MEM_DIR, name);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+(.+)$/);
    if (match) out.push({ text: oneLine(match[1]).slice(0, 300), file: name });
  }
  return out;
}
function loadMemories() {
  return safeRun(() => {
    const ready = ensureStructure();
    if (!ready.ok) return ready;
    const list = [];
    for (const name of MEMORY_FILES) list.push(...parseMemoryFile(name));
    return { ok: true, memories: list };
  });
}

function addMemory({ text } = {}) {
  return safeRun(() => {
    const body = oneLine(text);
    if (!body) return { ok: false, reason: 'empty' };
    const ready = ensureStructure();
    if (!ready.ok) return ready;
    const normalized = normalizeForCompare(body);
    for (const name of MEMORY_FILES) {
      for (const item of parseMemoryFile(name)) {
        if (normalizeForCompare(item.text) === normalized) return { ok: true, added: false, reason: 'duplicate' };
      }
    }
    const name = memoryFileFor(body);
    fs.appendFileSync(path.join(vaultPath(), MEM_DIR, name), `- ${body.slice(0, 300)}\n`, 'utf8');
    return { ok: true, added: true, file: name };
  });
}

function removeMemory({ query } = {}) {
  return safeRun(() => {
    const needle = normalizeForCompare(query);
    if (!needle) return { ok: false, reason: 'empty', removed: [] };
    const ready = ensureStructure();
    if (!ready.ok) return ready;
    const removed = [];
    for (const name of MEMORY_FILES) {
      const file = path.join(vaultPath(), MEM_DIR, name);
      if (!fs.existsSync(file)) continue;
      const original = fs.readFileSync(file, 'utf8');
      const kept = [];
      for (const line of original.split(/\r?\n/)) {
        const match = line.match(/^\s*-\s+(.+)$/);
        if (match && normalizeForCompare(match[1]).includes(needle)) { removed.push(oneLine(match[1]).slice(0, 200)); continue; }
        kept.push(line);
      }
      if (removed.length) fs.writeFileSync(file, kept.join('\n'), 'utf8');
    }
    return { ok: true, removed };
  });
}

function clearMemories() {
  return safeRun(() => {
    const ready = ensureStructure();
    if (!ready.ok) return ready;
    for (const name of MEMORY_FILES) {
      fs.writeFileSync(path.join(vaultPath(), MEM_DIR, name), `# ${name.replace(/\.md$/, '')}\n\n`, 'utf8');
    }
    return { ok: true };
  });
}

const RECALL_STOP = new Set(['the', 'and', 'that', 'this', 'with', 'have', 'what', 'when', 'where', 'about', 'their', 'were', 'been', 'from', 'into', 'just', 'like', 'your', 'youre', 'you', 'for', 'are', 'was', 'our', 'out', 'get', 'got', 'can', 'could', 'would', 'should']);
function recallTokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(word => word.length >= 3 && !RECALL_STOP.has(word));
}
function recentLogFiles(limit = 3) {
  const dir = path.join(vaultPath(), LOG_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map(name => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}
// Lightweight local retrieval: token overlap over memory bullets and the
// most recent daily logs, ranked by overlap then recency. No embeddings, no
// network, never the whole vault — only a small ranked slice.
function recallContext(query, { limit = 6 } = {}) {
  return safeRun(() => {
    const loaded = loadMemories();
    if (!loaded.ok) return loaded;
    const terms = recallTokens(query);
    if (!terms.length) return { ok: true, matches: [] };
    const candidates = [];
    for (const item of loaded.memories) candidates.push({ text: item.text, source: `Memory/${item.file}`, recency: 2 });
    for (const entry of recentLogFiles()) {
      const file = path.join(vaultPath(), LOG_DIR, entry.name);
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*-\s+\d{1,2}:\d{2}\s+\*\*(?:USER|JARVIS)\*\*:\s+(.+)$/);
        if (match) candidates.push({ text: oneLine(match[1]).slice(0, 240), source: `Conversation Logs/${entry.name}`, recency: 1 });
      }
    }
    const scored = [];
    for (const item of candidates) {
      const haystack = normalizeForCompare(item.text);
      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score += 1;
      if (score > 0) scored.push({ ...item, score: score + item.recency * 0.1 });
    }
    scored.sort((a, b) => b.score - a.score);
    return { ok: true, matches: scored.slice(0, Math.max(1, Number(limit) || 6)).map(item => ({ text: item.text, source: item.source })) };
  });
}

// Compact block for the model prompt: the saved notes plus a small ranked
// slice of matching history for THIS question. Returns '' on any failure.
function promptContext(query) {
  const loaded = loadMemories();
  const parts = [];
  if (loaded.ok && loaded.memories.length) {
    parts.push(`Saved notes about this user (authoritative, from persistent memory): ${JSON.stringify(loaded.memories.slice(-12).map(item => item.text))}`);
  }
  const recalled = recallContext(query, { limit: 5 });
  if (recalled.ok && recalled.matches.length) {
    parts.push(`Relevant lines from this user's own vault (background context; never claim anything not present): ${JSON.stringify(recalled.matches)}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function status() {
  return safeRun(() => {
    const root = vaultPath();
    // existsSync never throws, so a path blocked by a plain FILE would
    // otherwise report ok:true with exists:false forever. Walk up to the
    // nearest existing ancestor and confirm it is a directory.
    let probe = root;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    if (!fs.statSync(probe).isDirectory()) throw new Error('vault path is blocked by a non-directory entry');
    const exists = fs.existsSync(path.join(root, MEM_DIR));
    return { ok: true, path: root, exists, configured: Boolean(process.env.JARVIS_VAULT_PATH && process.env.JARVIS_VAULT_PATH.trim()) };
  });
}

// For startup hydration: saved memories plus the most recent log lines so a
// lost browser profile can rebuild recent context from the vault.
function state({ recentLimit = 40 } = {}) {
  return safeRun(() => {
    const ready = ensureStructure();
    if (!ready.ok) return ready;
    const loaded = loadMemories();
    const recent = [];
    for (const entry of recentLogFiles()) {
      const file = path.join(vaultPath(), LOG_DIR, entry.name);
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*-\s+(\d{1,2}:\d{2})\s+\*\*(USER|JARVIS)\*\*:\s+(.+)$/);
        if (match) recent.push({ who: match[2] === 'USER' ? 'YOU' : 'J.A.R.V.I.S.', text: oneLine(match[3]).slice(0, 400), day: entry.name.replace(/\.md$/, ''), time: match[1] });
      }
    }
    return {
      ok: true,
      memories: loaded.ok ? loaded.memories : [],
      recent: recent.slice(-(Math.max(1, Number(recentLimit) || 40))),
      ...status()
    };
  });
}

module.exports = { vaultPath, ensureStructure, logTurn, loadMemories, addMemory, removeMemory, clearMemories, recallContext, promptContext, status, state, MEMORY_FILES };
