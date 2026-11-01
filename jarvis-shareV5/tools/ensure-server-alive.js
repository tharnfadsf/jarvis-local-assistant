// Repairs the bridge after a concurrent work stream replaced server.js with a
// snapshot that no longer works.
//
//   node tools/ensure-server-alive.js
//
// A candidate is only accepted when it PARSES and actually BOOTS (the server
// starts and answers /api/health). The newest working copy is restored, the
// push-to-talk channel state and the fast ASR decode are re-applied, and the
// desktop host restarts the bridge by itself.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const http = require('http');

const root = path.join(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const PORT = 42317;

function parses(file) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
function get(pathname, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port: PORT, path: pathname, timeout: timeoutMs }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
  });
}
async function boots(file) {
  const child = spawn(process.execPath, [file], {
    cwd: root,
    env: { ...process.env, JARVIS_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const started = Date.now();
  let healthy = null;
  while (Date.now() - started < 9000) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    healthy = await get('/api/health');
    if (healthy) break;
    if (child.exitCode !== null) break;
  }
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const ok = Boolean(healthy && /"online":\s*true/.test(healthy));
  return { ok, detail: ok ? 'healthy' : (output.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 220) || 'no response') };
}

function markers(file) {
  const text = fs.readFileSync(file, 'utf8');
  return {
    hotkey: text.includes('/api/ptt/event'),
    state: text.includes('let pttEvent = { id: 0'),
    greedy: text.includes("'-bs', '1', '-nf'"),
    trace: text.includes('[JARVIS asr-trace]'),
  };
}

(async () => {
  const current = markers(serverPath);
  if (parses(serverPath) && current.hotkey && current.state && current.greedy) {
    const check = await boots(serverPath);
    if (check.ok) { console.log('server.js is healthy and complete.'); process.exit(0); }
    console.log('server.js does not boot: ' + check.detail);
  } else {
    console.log('server.js is incomplete: ' + JSON.stringify(current));
  }

  const candidates = fs.readdirSync(root)
    .filter((name) => name.startsWith('backup-'))
    .map((name) => path.join(root, name, 'server.js'))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const candidate of candidates) {
    if (!parses(candidate.file)) continue;
    const check = await boots(candidate.file);
    if (!check.ok) { console.log('skip (does not boot): ' + path.basename(path.dirname(candidate.file)) + ' - ' + check.detail); continue; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(serverPath, path.join(root, 'server.js.replaced-' + stamp + '.bak'));
    fs.copyFileSync(candidate.file, serverPath);
    console.log('restored: ' + path.basename(path.dirname(candidate.file)));
    try { execFileSync(process.execPath, [path.join(root, 'tools', 'apply-ptt-hotkey-server.js')], { stdio: 'inherit' }); } catch { }
    try { execFileSync(process.execPath, [path.join(root, 'tools', 'ensure-ptt-channel-state.js')], { stdio: 'inherit' }); } catch { }
    const after = await boots(serverPath);
    console.log('server.js repaired: ' + JSON.stringify(markers(serverPath)) + ' boot=' + (after.ok ? 'healthy' : after.detail));
    process.exit(after.ok ? 0 : 1);
  }
  console.error('No working server.js found in any backup.');
  process.exit(1);
})();
