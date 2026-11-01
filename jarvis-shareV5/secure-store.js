'use strict';
// JARVIS Share — secure credential store (2026-10-28 upgrade).
//
// Goal: API keys are never written as plaintext files by default.
//   Windows  -> CryptProtectData (DPAPI, protects under the user account).
//   macOS    -> security CLI against the login Keychain (generic item).
//   Linux    -> Secret Service (GNOME Keyring / KWallet via secret-tool) when present.
// Fallback: an encrypted file (AES-256-GCM) whose key itself is wrapped by the
//   OS credential mechanism; if BOTH the OS mechanism and the wrapped key are
//   unavailable, the store REFUSES to persist secrets instead of quietly
//   dropping them to plaintext. Saving plaintext requires the user's explicit
//   allowPlaintext consent flag, surfaced in the setup wizard with a warning.
//
// Layout (per platform data dir from platform-capabilities):
//   <data>/secrets/secret-blob.bin   -> {v, iv, tag, data} AES-256-GCM envelope
//   <data>/secrets/keywrap.bin       -> wrapped 32-byte key (OS-protected)
// A value named in secure-store is still readable by loadLocalEnv-style code:
// server.js merges these into process.env at startup when the user has saved
// credentials through the setup wizard. Keys stay OUT of the project folder.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawnSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const SERVICE_NAME = 'JARVIS-Share';       // macOS Keychain service name
const COLLECTION_LABEL = 'jarvis-share';   // Linux secret-tool attribute
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

function dataDir() {
  if (IS_WIN) return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}
function storeDir() {
  const dir = path.join(dataDir(), 'JARVIS', 'secrets');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const BLOB_FILE = () => path.join(storeDir(), 'secret-blob.bin');
const KEYWRAP_FILE = () => path.join(storeDir(), 'keywrap.bin');
const META_FILE = () => path.join(storeDir(), 'store-meta.json');

// ---------- Windows DPAPI ----------
// Windows PowerShell (5.1) does not load the ProtectedData type by default,
// so Add-Type -AssemblyName System.Security must run first. Only verified
// base64 comes back; anything else is a hard failure (never a silent block).
const DPAPI_B64 = /^[A-Za-z0-9+/=\r\n]+$/;
function dpapiRun(expression, inputB64) {
  const ps = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.Security;` +
    ` [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${expression}([Convert]::FromBase64String('${inputB64}'), $null, 'CurrentUser'))`
  ], { windowsHide: true, encoding: 'utf8' });
  if (ps.error && ps.error.code === 'ENOENT') throw new Error('powershell.exe not found on this Windows install');
  const out = String(ps.stdout || '').trim();
  if (ps.status !== 0 || !out || !DPAPI_B64.test(out)) {
    const reason = String(ps.stderr || '').split(/\r?\n/).find(l => l.trim()) || `exit ${ps.status}`;
    throw new Error(`DPAPI ${expression} failed: ${reason.slice(0, 120)}`);
  }
  return Buffer.from(out, 'base64');
}
function dpapiProtect(input) { return dpapiRun('Protect', input.toString('base64')); }
function dpapiUnprotect(input) { return dpapiRun('Unprotect', input.toString('base64')); }

// ---------- Secret storage backends ----------
// Each backend stores ONE opaque envelope string under this service name.
// The envelope is the AES key wrapped by whatever the backend natively
// protects; the payload itself lives in the AES-encrypted blob file so a
// single round-trip to the OS store is needed, not one per credential.
const backends = {
  async available() {
    if (IS_WIN) {
      try { dpapiProtect(Buffer.from('probe')); return true; } catch { return false; }
    }
    if (IS_MAC) {
      try { await execFileAsync('security', [], { timeout: 3000 }); return true; } catch (e) { return e.code === 'ENOENT' ? false : true; }
    }
    if (IS_LINUX) {
      try { await execFileAsync('which', ['secret-tool'], { timeout: 2500 }); return true; } catch { return false; }
    }
    return false;
  },
  async put(value) {
    if (IS_WIN) {
      const wrapped = dpapiProtect(value).toString('base64');
      fs.writeFileSync(KEYWRAP_FILE(), wrapped, 'utf8');
      return;
    }
    if (IS_MAC) {
      // security add-generic-password; overwrite any previous version.
      try { await execFileAsync('security', ['delete-generic-password', '-s', SERVICE_NAME], { timeout: 5000 }); } catch {}
      await execFileAsync('security', ['add-generic-password', '-a', 'jarvis', '-s', SERVICE_NAME, '-w', value.toString('base64'), '-U'], { timeout: 8000 });
      return;
    }
    if (IS_LINUX) {
      await execFileAsync('secret-tool', ['store', '--label=JARVIS Share key', `application=${COLLECTION_LABEL}`, 'jarvis', 'keywrap'], { input: value.toString('base64'), timeout: 8000 });
      return;
    }
    throw new Error('No supported OS credential store on this platform.');
  },
  async get() {
    if (IS_WIN) {
      const raw = fs.existsSync(KEYWRAP_FILE()) ? fs.readFileSync(KEYWRAP_FILE(), 'utf8') : '';
      if (!raw) return null;
      // keywrap.bin holds DPAPI(wrapped key bytes), so it must be UNprotected
      // here; returning the wrapped bytes would look like a 32+ byte blob and
      // make every read rotate the key (and then fail GCM authentication).
      return dpapiUnprotect(Buffer.from(raw.trim(), 'base64'));
    }
    if (IS_MAC) {
      const { stdout } = await execFileAsync('security', ['find-generic-password', '-a', 'jarvis', '-s', SERVICE_NAME, '-w'], { timeout: 8000 });
      const text = String(stdout || '').trim();
      if (!text) return null;
      return Buffer.from(text.replace(/^"|"$/g, ''), 'base64');
    }
    if (IS_LINUX) {
      const { stdout } = await execFileAsync('secret-tool', ['lookup', `application=${COLLECTION_LABEL}`, 'jarvis', 'keywrap'], { timeout: 8000 });
      const text = String(stdout || '').trim();
      return text ? Buffer.from(text, 'base64') : null;
    }
    return null;
  },
  async remove() {
    if (IS_WIN) { try { fs.rmSync(KEYWRAP_FILE(), { force: true }); } catch {} return; }
    if (IS_MAC) { try { await execFileAsync('security', ['delete-generic-password', '-s', SERVICE_NAME], { timeout: 5000 }); } catch {} return; }
    if (IS_LINUX) { try { await execFileAsync('secret-tool', ['clear', `application=${COLLECTION_LABEL}`, 'jarvis', 'keywrap'], { timeout: 5000 }); } catch {} return; }
  }
};

// ---------- AES-256-GCM blob around the actual map ----------
function encryptMap(map, keyBuffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(map), 'utf8'), cipher.final()]);
  return { v: 2, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decryptMap(envelope, keyBuffer) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// The master key: random 32 bytes, wrapped by the OS store, then used for the
// AES envelope holding every value.
async function obtainMasterKey() {
  try {
    const wrapped = await backends.get();
    if (wrapped && wrapped.length === 32) return wrapped;
    if (wrapped) // old-format or corrupted item: reset it
      { try { await backends.remove(); } catch {} }
    const fresh = crypto.randomBytes(32);
    await backends.put(fresh);
    writeMeta({ backend: backendName(), created: new Date().toISOString() });
    return fresh;
  } catch (error) {
    throw new Error(`OS credential store unavailable: ${String(error.message || error).slice(0, 160)}`);
  }
}
function backendName() {
  if (IS_WIN) return 'dpapi';
  if (IS_MAC) return 'keychain';
  if (IS_LINUX) return 'secret-service';
  return 'none';
}

function writeMeta(patch) {
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(META_FILE(), 'utf8')); } catch {}
  fs.writeFileSync(META_FILE(), JSON.stringify({ ...meta, ...patch }, null, 2), 'utf8');
}
function readMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE(), 'utf8')); } catch { return {}; }
}

// -------- public API --------
async function status() {
  const meta = readMeta();
  const encryptedBlob = fs.existsSync(BLOB_FILE());
  try {
    const ok = await backends.available();
    return {
      ok,
      backend: ok ? backendName() : 'none',
      hasStoredSecrets: encryptedBlob,
      plaintext: false,
      meta,
      message: ok
        ? `Credential store ready (${backendName()}). Keys are wrapped by the operating system's own protected storage; no readable secret files are written.`
        : 'No OS credential store is available. JARVIS will not persist API keys until one is available or you explicitly allow an encrypted fallback with a shown warning.'
    };
  } catch (error) {
    return { ok: false, backend: 'none', hasStoredSecrets: encryptedBlob, plaintext: false, meta, message: String(error.message || error).slice(0, 200) };
  }
}

async function setSecrets(values) {
  // values: { FISH_API_KEY: '...', OPENCODE_API_KEY: '...' , ...}
  const existing = await readAll();
  const merged = { ...existing.values, ...values };
  for (const key of Object.keys(merged)) if (merged[key] === '' || merged[key] === undefined) delete merged[key];
  const key = await obtainMasterKey();
  fs.writeFileSync(BLOB_FILE(), JSON.stringify(encryptMap(merged, key)), 'utf8');
  writeMeta({ backend: backendName(), updatedAt: new Date().toISOString() });
  return { ok: true, count: Object.keys(merged).length, backend: backendName() };
}

async function readAll() {
  try {
    const raw = fs.existsSync(BLOB_FILE()) ? JSON.parse(fs.readFileSync(BLOB_FILE(), 'utf8')) : null;
    if (!raw) return { ok: true, values: {}, backend: backendName() };
    const key = await obtainMasterKey();
    return { ok: true, values: decryptMap(raw, key), backend: backendName() };
  } catch (error) {
    return { ok: false, values: {}, backend: backendName(), message: `Could not unlock the credential store: ${String(error && error.message || error).slice(0, 160)}` };
  }
}

async function clearAll() {
  try { await backends.remove(); } catch {}
  try { fs.rmSync(BLOB_FILE(), { force: true }); } catch {}
  try { fs.rmSync(META_FILE(), { force: true }); } catch {}
  return { ok: true };
}

module.exports = { status, setSecrets, readAll, clearAll, SERVICE_NAME, dataDir, _internal: { encryptMap, decryptMap, backendName } };
