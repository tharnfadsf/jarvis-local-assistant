'use strict';
// JARVIS Computer Tools — broad, permission-gated local file and desktop
// access on top of the existing Windows capabilities.
//
// Design (and why):
// - Nothing here runs arbitrary shell commands from the model. Every operation
//   is a validated, named capability with its own gate.
// - A master switch (enabled) must be on for any tool to run. File writes,
//   moves, renames, and copies additionally need allowAiFileOperations.
//   Deletions additionally need allowAiDeletions — and they are reversible:
//   deleted items are moved into %LOCALAPPDATA%\JARVIS\Recycle Bin, never
//   unlinked, so "restore" stays possible.
// - Anything the model requests that a user must sanction (overwriting a
//   file, deleting something) lands in a pending-operation store; the model
//   receives "ask the user to confirm", and the desktop/voice UI presents the
//   confirmation. The server never auto-confirms.
// - Paths are validated (expanded env vars/ //~), probed for existence, and
//   scripts/scripts (exe, ps1, ...) never start without an explicit user
//   confirmation, mirroring the existing DANGEROUS_FILE_PATTERN rule.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { execFile, spawn } = require('child_process');

const execFileAsync = promisify(execFile);
const DIRECTORY = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'JARVIS');
const RECYCLE_NAME = 'Recycle Bin';
const PENDING_TTL_MS = 2 * 60 * 1000;
const DANGEROUS_FILE_PATTERN = /\.(?:exe|bat|cmd|ps1|psm1|msi|scr|js|jse|vbs|vbe|wsf|wsh|hta|jar|com|pif|reg|lnk)$/i;
const TEXT_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.log', '.ini', '.cfg', '.xml', '.yaml', '.yml', '.toml', '.env.example', '.cs', '.js'];
const READ_MAX_BYTES = 30000;

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// ---- Pure helpers (unit-tested without Windows) ----
function expandHomePath(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  value = value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  value = value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => process.env[name] || m);
  if (value === '~') value = os.homedir();
  else if (/^~[\\/]/.test(value)) value = path.join(os.homedir(), value.slice(2));
  return value;
}

// Returns { ok, path, exists, kind, isDangerous } or { ok:false, message }.
function validatePath(raw, { mustExist = false, kind = 'any' } = {}) {
  const candidate = expandHomePath(raw);
  if (!candidate) return { ok: false, message: 'A file or folder path is required.' };
  // Windows rejects these in file/folder names; reject them up front instead
  // of letting a broken path fail deep inside an operation.
  if (/[\0<>|?*]/.test(candidate) || /"/.test(candidate)) {
    return { ok: false, message: 'That path contains characters Windows does not allow in file names.' };
  }
  const absolute = /^[A-Za-z]:[\\/]./.test(candidate) || /^\\\\/.test(candidate);
  if (!absolute) return { ok: false, message: 'Use an absolute path (for example C:\\Users\\...). Relative paths are not accepted.' };
  let stat = null, exists = false;
  try { stat = fs.statSync(candidate); exists = true; } catch (e) { if (e.code !== 'ENOENT') return { ok: false, message: `${candidate}: ${String(e.message).slice(0, 120)}` }; }
  if (mustExist && !exists) return { ok: false, message: `That path does not exist: ${candidate}` };
  const isFolder = Boolean(stat && stat.isDirectory());
  if (kind === 'file' && exists && isFolder) return { ok: false, message: `That is a folder, not a file: ${candidate}` };
  if (kind === 'folder' && exists && !isFolder) return { ok: false, message: `That is a file, not a folder: ${candidate}` };
  return {
    ok: true,
    path: path.normalize(candidate),
    exists,
    isFolder,
    isDangerous: DANGEROUS_FILE_PATTERN.test(candidate)
  };
}

function knownFolders() {
  const h = os.homedir();
  return {
    Desktop: path.join(h, 'Desktop'),
    Documents: path.join(h, 'Documents'),
    Downloads: path.join(h, 'Downloads'),
    Pictures: path.join(h, 'Pictures'),
    Videos: path.join(h, 'Videos'),
    Music: path.join(h, 'Music')
  };
}

function searchRoots(extraRoots = []) {
  const base = knownFolders();
  const roots = [...Object.values(base)].filter(p => p && fs.existsSync(p));
  for (const extra of Array.isArray(extraRoots) ? extraRoots : []) {
    const expanded = expandHomePath(extra);
    if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(expanded)) roots.push(expanded);
  }
  return [...new Set(roots)];
}

async function powerSearch(script, env, timeout) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...env } });
  return stdout;
}

const SEARCH_SCRIPT = String.raw`
$ErrorActionPreference='SilentlyContinue'
$roots=$env:JARVIS_CT_ROOTS | ConvertFrom-Json
$tokens=@($env:JARVIS_CT_TOKENS | Where-Object { $_ })
$exts=@($env:JARVIS_CT_EXTS | Where-Object { $_ })
$minBytes=[long]$env:JARVIS_CT_MINBYTES
$cutoff=[datetime]::MinValue
if($env:JARVIS_CT_WITHIN_DAYS -gt 0){ $cutoff=(Get-Date).AddDays(-[int]$env:JARVIS_CT_WITHIN_DAYS) }
$limit=[int]$env:JARVIS_CT_LIMIT
$rows=@()
foreach($root in $roots){
  if(-not (Test-Path -LiteralPath $root)){ continue }
  $items=@(Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction SilentlyContinue -Depth 7 | Where-Object {
    if($cutoff -gt [datetime]::MinValue -and $_.LastWriteTime -lt $cutoff){ return $false }
    if($minBytes -gt 0 -and -not $_.PSIsContainer -and $_.Length -lt $minBytes){ return $false }
    if($exts.Count -gt 0 -and -not $_.PSIsContainer){ $e=$_.Extension.ToLower(); if(-not ($exts -contains $e)){ return $false } }
    foreach($t in $tokens){ if($_.Name.IndexOf($t,[System.StringComparison]::OrdinalIgnoreCase) -lt 0){ return $false } }
    return $true
  } | Select-Object -First $limit)
  $rows += $items
  if($rows.Count -ge $limit){ break }
}
$rows | Select-Object -First $limit | ForEach-Object { [pscustomobject]@{ FullName=$_.FullName; Name=$_.Name; LastWriteTime=$_.LastWriteTime.ToString('o'); Type=if($_.PSIsContainer){'folder'}else{'file'}; Size=$_.Length } } | ConvertTo-Json -Compress -Depth 3
`;

// ---- Module factory ----
function createComputerTools(options = {}) {
  const fetchRootsExtra = options.getExtraRoots || (() => []);
  const getAppInfo = options.getAppInfo || (async () => []); // app discovery injected by the server
  const log = options.log || console;
  const settingsPath = path.join(DIRECTORY, 'computer-settings.json');

  const defaults = {
    enabled: false,
    allowAiFileOperations: false,
    allowAiDeletions: false,
    extraRoots: []
  };
  let settings = { ...defaults };
  let loaded = false;

  function loadSettings() {
    if (loaded) return settings;
    try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) }; } catch { settings = { ...defaults }; }
    if (!Array.isArray(settings.extraRoots)) settings.extraRoots = [];
    loaded = true;
    return settings;
  }
  function saveSettings() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    } catch (error) { log.error('[JARVIS computer settings]', error.message); }
  }

  function status() {
    loadSettings();
    return {
      ok: true,
      enabled: Boolean(settings.enabled),
      allowAiFileOperations: Boolean(settings.allowAiFileOperations),
      allowAiDeletions: Boolean(settings.allowAiDeletions),
      extraRoots: settings.extraRoots.slice(0, 12),
      searchRoots: searchRoots(settings.extraRoots),
      recycleDir: path.join(DIRECTORY, RECYCLE_NAME),
      pendingOps: pendingList()
    };
  }

  function setSettings(patch = {}) {
    loadSettings();
    if (typeof patch.enabled === 'boolean') settings.enabled = patch.enabled;
    if (typeof patch.allowAiFileOperations === 'boolean') settings.allowAiFileOperations = patch.allowAiFileOperations;
    if (typeof patch.allowAiDeletions === 'boolean') {
      if (patch.allowAiDeletions && !settings.enabled) return { ok: false, message: 'Enable Computer Access first, then allow deletions.' };
      settings.allowAiDeletions = patch.allowAiDeletions;
    }
    if (Array.isArray(patch.extraRoots)) {
      const cleaned = [];
      for (const raw of patch.extraRoots.slice(0, 12)) {
        const expanded = expandHomePath(raw);
        if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(expanded)) cleaned.push(expanded);
      }
      settings.extraRoots = cleaned;
    }
    saveSettings();
    return { ok: true, status: status(), message: 'Computer access settings saved.' };
  }

  // ---- Pending-operation store (user confirmations) ----
  const pendingOps = new Map();
  function pendingList() {
    const now = Date.now();
    for (const [id, op] of pendingOps) if (now - op.at > PENDING_TTL_MS) pendingOps.delete(id);
    return [...pendingOps.values()].map(op => ({ id: op.id, summary: op.summary }));
  }
  function beginPending(op, args, summary) {
    const id = Math.random().toString(36).slice(2, 10);
    pendingOps.set(id, { id, op, args, summary, at: Date.now() });
    return { ok: false, needsConfirmation: true, opId: id, summary, message: `${summary} Confirm this action on the JARVIS screen (or say "Jarvis confirm") to continue.` };
  }

  // ---- Search across known folders + configured roots ----
  let searchCache = new Map(); // id -> { path }
  function cacheEntry(id) {
    if (searchCache.size > 400) searchCache = new Map([...searchCache].slice(-200));
    return searchCache;
  }
  async function findFiles({ query = '', extensions = [], minSizeMB = 0, withinDays = 0, latest = false } = {}) {
    loadSettings();
    const tokens = String(query || '').split(/\s+/).filter(Boolean).slice(0, 6);
    const roots = searchRoots(settings.extraRoots);
    if (!roots.length) return { ok: false, message: 'None of your search folders exist right now.' };
    if (!tokens.length && !extensions?.length && !withinDays && !(minSizeMB > 0)) return { ok: false, message: 'Give me part of a name, an extension, a size, or a date filter.' };
    let rows = [];
    try {
      const json = await powerSearch(SEARCH_SCRIPT, {
        JARVIS_CT_ROOTS: JSON.stringify(roots),
        JARVIS_CT_TOKENS: tokens.join(' '),
        JARVIS_CT_EXTS: (Array.isArray(extensions) ? extensions : String(extensions || '').split(/\s*,\s*/)).filter(Boolean).map(e => `.${String(e).toLowerCase().replace(/^\./, '')}`),
        JARVIS_CT_MINBYTES: String(Math.max(0, toInt(minSizeMB, 0) * 1024 * 1024)),
        JARVIS_CT_WITHIN_DAYS: String(Math.max(0, toInt(withinDays, 0))),
        JARVIS_CT_LIMIT: '400'
      }, 45000);
      rows = JSON.parse(String(json || '').trim() || '[]');
      if (rows && !Array.isArray(rows)) rows = [rows];
    } catch (error) {
      return { ok: false, message: `The file search failed or timed out: ${String(error.message).slice(0, 160)}` };
    }
    const results = rows.filter(r => r && r.FullName).map(row => {
      const id = Math.random().toString(36).slice(2, 10);
      cacheEntry(id).set(id, row.FullName);
      return { id, name: row.Name || path.basename(row.FullName), path: row.FullName, modified: row.LastWriteTime || '', type: row.Type === 'folder' ? 'folder' : 'file', sizeMB: row.Size ? Number((row.Size / (1024 * 1024)).toFixed(2)) : undefined };
    });
    results.sort((a, b) => {
      if (latest) return a.modified > b.modified ? -1 : 1;
      const aExact = tokens.some(t => a.name.toLowerCase().includes(t.toLowerCase())) ? 1 : 0;
      const bExact = tokens.some(t => b.name.toLowerCase().includes(t.toLowerCase())) ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      return a.modified > b.modified ? -1 : 1;
    });
    return { ok: true, results: results.slice(0, 12), total: results.length, roots };
  }

  function resolveCached(id) {
    const file = searchCache.get(String(id || ''));
    if (!file || !fs.existsSync(file)) return null;
    return file;
  }

  function spawnExplorer(p) {
    const child = spawn('explorer.exe', [p], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  }

  // ---- Non-destructive operations ----
  async function openPath({ path: raw = '', confirmed = false } = {}) {
    const check = validatePath(raw);
    if (!check.ok) return check;
    if (check.exists && (check.isFolder === false) && DANGEROUS_FILE_PATTERN.test(check.path) && confirmed !== true) {
      return beginPending('openPath', { path: check.path }, `Opening the program or script ${path.basename(check.path)} could run code.`);
    }
    if (!check.exists) return { ok: false, message: `That path does not exist right now: ${check.path}` };
    spawnExplorer(check.path);
    return { ok: true, path: check.path, message: `Opened ${path.basename(check.path)}` };
  }

  async function listDirectoryByPath({ path: raw = '' } = {}) {
    const check = validatePath(raw, { mustExist: true, kind: 'folder' });
    if (!check.ok) return check;
    let entries;
    try { entries = await fs.promises.readdir(check.path, { withFileTypes: true }); }
    catch (error) { return { ok: false, message: `Could not read that folder: ${String(error.code || error.message).slice(0, 120)}` }; }
    const items = entries.slice(0, 60).map(entry => {
      const id = Math.random().toString(36).slice(2, 10);
      const childPath = path.join(check.path, entry.name);
      searchCache.set(id, childPath);
      return { id, name: entry.name, type: entry.isDirectory() ? 'folder' : 'file' };
    });
    return { ok: true, path: check.path, count: entries.length, items, message: entries.length ? `${path.basename(check.path)} contains ${entries.length} item${entries.length === 1 ? '' : 's'}.` : 'That folder is empty.' };
  }

  async function readTextFileByPath({ path: raw = '' } = {}) {
    const check = validatePath(raw, { mustExist: true, kind: 'file' });
    if (!check.ok) return check;
    const ext = path.extname(check.path).toLowerCase();
    if (!TEXT_EXTENSIONS.includes(ext)) return { ok: false, message: `I read only text-like files. ${path.basename(check.path)} is a ${ext || 'binary'} file; open it directly instead.` };
    const stat = await fs.promises.stat(check.path);
    if (stat.size > READ_MAX_BYTES) return { ok: false, message: `${path.basename(check.path)} is over the 30 KB reading limit. Open it directly to review.` };
    return { ok: true, name: path.basename(check.path), text: (await fs.promises.readFile(check.path, 'utf8')).slice(0, 20000) };
  }

  // ---- Mutating operations (gated + confirmed) ----
  function aiWriteGate() {
    loadSettings();
    if (!settings.enabled) return { ok: false, message: 'Computer access is disabled. Enable it in its settings card first.' };
    if (!settings.allowAiFileOperations) return { ok: false, message: 'AI file changes are not allowed. Turn on "Allow AI file operations" in the computer-access settings, or do it manually.' };
    return { ok: true };
  }
  function userGate() {
    loadSettings();
    if (!settings.enabled) return { ok: false, message: 'Computer access is disabled. Enable it in its settings card first.' };
    return { ok: true };
  }

  async function createFolder({ path: raw = '' } = {}) {
    const gate = aiWriteGate(); if (!gate.ok) return gate;
    const check = validatePath(raw);
    if (!check.ok) return check;
    if (check.exists) return { ok: false, message: `${check.path} already exists${check.isFolder ? ' as a folder' : ' as a file'}.` };
    try { fs.mkdirSync(check.path, { recursive: true }); } catch (error) { return { ok: false, message: `Could not create the folder: ${String(error.message).slice(0, 160)}` }; }
    return { ok: true, path: check.path, message: `Created folder ${check.path}` };
  }

  async function writeTextFile({ path: raw = '', content = '', confirmed = false } = {}) {
    const gate = aiWriteGate(); if (!gate.ok) return gate;
    const check = validatePath(raw);
    if (!check.ok) return check;
    const text = String(content ?? '').slice(0, 2000000);
    if (check.exists && confirmed !== true) {
      return beginPending('writeTextFile', { path: check.path, content: text }, `Overwriting ${path.basename(check.path)} replaces its current content.`);
    }
    try {
      fs.mkdirSync(path.dirname(check.path), { recursive: true });
      fs.writeFileSync(check.path, text, 'utf8');
    } catch (error) { return { ok: false, message: `Could not write the file: ${String(error.message).slice(0, 160)}` }; }
    return { ok: true, path: check.path, name: path.basename(check.path), message: `Wrote ${path.basename(check.path)} (${text.length} characters)` };
  }

  async function copyFile({ path: raw = '', to = '', confirmed = false } = {}) {
    const gate = aiWriteGate(); if (!gate.ok) return gate;
    const check = validatePath(raw, { mustExist: true, kind: 'file' });
    if (!check.ok) return check;
    const dest = validatePath(to);
    if (!dest.ok) return dest;
    const target = path.normalize(dest.path);
    let overwrite = false;
    try { fs.accessSync(target); overwrite = true; } catch { overwrite = fs.existsSync(target); }
    if (overwrite && confirmed !== true) {
      return beginPending('copyFile', { path: check.path, to: target }, `Copying over the existing ${path.basename(target)} destroys its current content.`);
    }
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(check.path, target); }
    catch (error) { return { ok: false, message: `Copy failed: ${String(error.message).slice(0, 160)}` }; }
    return { ok: true, from: check.path, to: target, message: `Copied ${path.basename(check.path)} to ${target}` };
  }

  async function moveFile({ path: raw = '', to = '', confirmed = false } = {}) {
    const gate = aiWriteGate(); if (!gate.ok) return gate;
    const check = validatePath(raw, { mustExist: true });
    if (!check.ok) return check;
    const dest = validatePath(to);
    if (!dest.ok) return dest;
    const isDir = check.isFolder;
    let target = path.normalize(dest.path);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory() && !isDir) target = path.join(target, path.basename(check.path));
    let overwrite = false;
    try { fs.accessSync(target); overwrite = true; } catch { overwrite = fs.existsSync(target); }
    if (overwrite && confirmed !== true) {
      return beginPending('moveFile', { path: check.path, to: target }, `Moving onto ${path.basename(target)} replaces that file.`);
    }
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(check.path, target); }
    catch (error) {
      // Same-volume rename failed can mean cross-drive move; fall back to
      // copy+delete through the reversible delete path so an undo survives.
      try {
        fs.copyFileSync(check.path, target);
      } catch (copyError) { return { ok: false, message: `Move failed: ${String(copyError.message).slice(0, 160)}` }; }
      return { ok: true, from: check.path, to: target, copiedFallback: true, message: `Copied ${path.basename(check.path)} to ${target}; the original still exists. Confirm a delete to remove it.` };
    }
    return { ok: true, from: check.path, to: target, message: `Moved ${path.basename(check.path)} to ${target}` };
  }

  async function renameFile({ path: raw = '', newName = '' } = {}) {
    const gate = aiWriteGate(); if (!gate.ok) return gate;
    const check = validatePath(raw, { mustExist: true });
    if (!check.ok) return check;
    const name = path.basename(String(newName || '').trim());
    if (!name || /[\\/:*?"<>|]/.test(name)) return { ok: false, message: 'A valid new name without slashes or special characters is required.' };
    const target = path.join(path.dirname(check.path), name);
    if (fs.existsSync(target)) return { ok: false, message: `A file or folder named ${name} already exists next to it. Rename blocked.` };
    try { fs.renameSync(check.path, target); }
    catch (error) { return { ok: false, message: `Rename failed: ${String(error.message).slice(0, 160)}` }; }
    return { ok: true, from: check.path, to: target, message: `Renamed to ${name}` };
  }

  // Deletion is reversible: items land in %LOCALAPPDATA%\JARVIS\Recycle Bin
  // under a timestamp folder, and restore puts the last removed item back.
  const recycleLog = new Map(); // recycleId -> { from, to }
  async function deletePath({ path: raw = '', confirmed = false } = {}) {
    const gate = userGate(); if (!gate.ok) return gate;
    const check = validatePath(raw, { mustExist: true });
    if (!check.ok) return check;
    if (!settings.allowAiDeletions && confirmed === true) return { ok: false, message: 'Deletions are not allowed by the current settings. Turn on "Allow AI deletions" first.' };
    if (confirmed !== true) {
      const summary = `Move ${check.isFolder ? 'folder' : 'file'} ${check.path}${check.isFolder ? ' and everything inside it' : ''} to the JARVIS Recycle Bin?`;
      return beginPending('deletePath', { path: check.path }, summary);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(DIRECTORY, RECYCLE_NAME, stamp, path.basename(check.path));
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(check.path, dest);
    } catch (error) { return { ok: false, message: `Could not move it to the recycle area (it was NOT deleted): ${String(error.message).slice(0, 160)}` }; }
    const id = Math.random().toString(36).slice(2, 10);
    recycleLog.set(id, { from: check.path, to: dest });
    return { ok: true, recycledTo: dest, undoId: id, message: `Moved ${path.basename(check.path)} to the JARVIS Recycle Bin. Say "Jarvis, restore that file" to undo.` };
  }

  async function restoreDeleted({ undoId = '' } = {}) {
    const entry = recycleLog.get(String(undoId || ''));
    if (!entry) return { ok: false, message: 'I do not have a matching recent deletion to restore.' };
    try { fs.renameSync(entry.to, entry.from); } catch (error) { return { ok: false, message: `Restore failed: ${String(error.message).slice(0, 160)}` }; }
    recycleLog.delete(String(undoId || ''));
    return { ok: true, path: entry.from, message: `Restored ${path.basename(entry.from)}` }; 
  }

  // ---- System queries and whitelisted settings pages ----
  async function diskSpace() {
    const gate = userGate(); if (!gate.ok) return gate;
    if (process.platform !== 'win32') return { ok: false, message: 'Windows is required.' };
    try {
      const json = await powerSearch(String.raw`
Get-PSDrive -PSProvider FileSystem | ForEach-Object { [pscustomobject]@{ name=$_.Name; usedGB=[math]::Round($_.Used/1GB,1); freeGB=[math]::Round($_.Free/1GB,1) } } | ConvertTo-Json -Compress
`, {}, 10000);
      let drives = JSON.parse(String(json || '[]').trim() || '[]');
      if (drives && !Array.isArray(drives)) drives = [drives];
      return { ok: true, drives };
    } catch (error) { return { ok: false, message: `Disk query failed: ${String(error.message).slice(0, 160)}` };
    }
  }

  async function processList() {
    const gate = userGate(); if (!gate.ok) return gate;
    if (process.platform !== 'win32') return { ok: false, message: 'Windows is required.' };
    try {
      const json = await powerSearch(String.raw`
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 | ForEach-Object { [pscustomobject]@{ name=$_.ProcessName; title=$_.MainWindowTitle; ramMB=[math]::Round($_.WorkingSet64/1MB,0) } } | ConvertTo-Json -Compress
`, {}, 10000);
      let rows = JSON.parse(String(json || '[]').trim() || '[]');
      if (rows && !Array.isArray(rows)) rows = [rows];
      return { ok: true, processes: rows };
    } catch (error) { return { ok: false, message: `Could not list running apps: ${String(error.message).slice(0, 160)}` };
    }
  }

  async function appLocation({ name = '' } = {}) {
    const apps = await getAppInfo(String(name || '').slice(0, 100));
    if (!apps || !apps.length) return { ok: false, message: `I could not find an installed app called ${name}.` };
    return { ok: true, apps: apps.slice(0, 4) };
  }

  const SETTINGS_PAGES = {
    sound: 'ms-settings:sound', display: 'ms-settings:display', bluetooth: 'ms-settings:bluetooth',
    wifi: 'ms-settings:network-wifi', apps: 'ms-settings:appsfeatures', 'default-apps': 'ms-settings:defaultapps',
    power: 'ms-settings:powersleep', notifications: 'ms-settings:notifications', taskbar: 'ms-settings:taskbar',
    storage: 'ms-settings:storagesense', privacy: 'ms-settings:privacy'
  };
  async function openWindowsSetting({ page = '' } = {}) {
    const gate = userGate(); if (!gate.ok) return gate;
    const key = String(page || '').toLowerCase().trim().replace(/\s+|-/g, m => (m === ' ' ? '-' : m));
    const target = SETTINGS_PAGES[key];
    if (!target) return { ok: false, message: `That settings page is not supported. Available pages: ${Object.keys(SETTINGS_PAGES).join(', ')}.` };
    spawnDetachedCmd('cmd.exe', ['/c', 'start', '', target]);
    return { ok: true, page: key, message: `Opening Windows ${key} settings.` };
  }

  function spawnDetachedCmd(file, args) {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  }

  // ---- Pending-op confirmation ----
  async function confirmPendingOp(id) {
    const entry = pendingOps.get(String(id || ''));
    if (!entry) return { ok: false, message: 'That confirmation has expired. Ask again and I will re-check with you.' };
    pendingOps.delete(String(id || ''));
    const handlers = {
      openPath: args => openPath({ ...args, confirmed: true }),
      writeTextFile: args => writeTextFile({ ...args, confirmed: true }),
      copyFile: args => copyFile({ ...args, confirmed: true }),
      moveFile: args => moveFile({ ...args, confirmed: true }),
      deletePath: args => deletePath({ ...args, confirmed: true })
    };
    const handler = handlers[entry.op];
    if (!handler) return { ok: false, message: 'That pending operation is no longer supported.' };
    return handler(entry.args);
  }

  function runTool(name, args = {}) {
    loadSettings();
    switch (name) {
      case 'find_files': return findFiles(args);
      case 'open_path': return openPath(args);
      case 'list_directory_path': return listDirectoryByPath(args);
      case 'read_text_file_path': return readTextFileByPath(args);
      case 'create_folder': return createFolder(args);
      case 'write_text_file': return writeTextFile(args);
      case 'copy_file': return copyFile(args);
      case 'move_file': return moveFile(args);
      case 'rename_file': return renameFile(args);
      case 'delete_path': return deletePath(args);
      case 'restore_deleted': return restoreDeleted(args);
      case 'disk_space': return diskSpace();
      case 'process_list': return processList();
      case 'app_location': return appLocation(args);
      case 'open_windows_setting': return openWindowsSetting(args);
      default: return { ok: false, message: 'That computer tool is not enabled.' };
    }
  }

  return {
    status, setSettings, runTool, confirmPendingOp, pendingList,
    _internal: { validatePath, expandHomePath, searchRoots, resolveCached }
  };
}

module.exports = { createComputerTools, validatePath, expandHomePath, searchRoots, DANGEROUS_FILE_PATTERN, TEXT_EXTENSIONS, READ_MAX_BYTES, PENDING_TTL_MS };
