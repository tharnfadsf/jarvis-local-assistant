'use strict';
// Integration tests for the local JARVIS server. The server is spawned on a
// dedicated port with a temporary planner file, temporary search roots, and
// an isolated LOCALAPPDATA dir so the user's real calendar, files, drafts,
// and tasks are never touched. Nothing in this file launches programs or
// opens windows. One alarm test briefly registers a Windows task and removes
// it in a finally block; the due-loop test uses task-free events only.
const test = require('node:test');
const { after, before } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
const plannerFile = path.join(temp, 'planner-data.json');
const emptyEnvFile = path.join(temp, 'test.env');
fs.writeFileSync(emptyEnvFile, '');

fs.writeFileSync(path.join(temp, 'report.txt'), 'quarterly report draft');
fs.writeFileSync(path.join(temp, 'report-2026.pdf'), '%PDF-1.4 test');
fs.writeFileSync(path.join(temp, 'setup.exe'), 'MZ fake binary for confirmation-gate test');
const oldNote = path.join(temp, 'old-note.txt');
fs.writeFileSync(oldNote, 'aged note');
const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
fs.utimesSync(oldNote, thirtyDaysAgo, thirtyDaysAgo);
const probeDir = path.join(temp, 'probedir');
fs.mkdirSync(probeDir, { recursive: true });
fs.writeFileSync(path.join(probeDir, 'alpha.txt'), 'alpha contents');
fs.writeFileSync(path.join(probeDir, 'beta.md'), 'beta contents');

let child = null;
let output = '';

before(async () => {
  // Refuse to run against an already-listening instance (a leftover test
  // server would silently satisfy every assertion with stale data).
  try {
    const probe = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) });
    if (probe.ok) throw new Error(`Port ${PORT} already serves a JARVIS instance; refusing to test against it.`);
  } catch (error) {
    if (/refusing to test/.test(String(error.message))) throw error;
  }
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      JARVIS_PORT: String(PORT),
      JARVIS_PLANNER_FILE: plannerFile,
      JARVIS_SEARCH_ROOTS: JSON.stringify([{ key: 'Documents', path: temp }]),
      LOCALAPPDATA: path.join(temp, 'localappdata'),
      JARVIS_NOTIFY_POLL_MS: '1500',
      JARVIS_ENV_FILE: emptyEnvFile,
      JARVIS_TAB_CONTROL: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await waitForServer();
});

after(() => {
  try {
    if (child && child.exitCode === null) {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/f', '/T']);
      else child.kill('SIGKILL');
    }
  } catch {}
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${output}`);
    try {
      const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy:\n${output}`);
}

async function action(body, headers = {}) {
  const response = await fetch(`${BASE}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test('server boots and reports health', async () => {
  await waitForServer();
  const response = await fetch(`${BASE}/api/health`);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.online, true);
});

test('search-files uses the provided roots and returns ranked results', async () => {
  const { status, body } = await action({ action: 'search-files', query: 'report' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.results));
  assert.ok(body.results.length >= 1);
  assert.ok(body.results.some(item => item.name === 'report.txt'), 'report.txt should be found');
  assert.ok(body.results[0].id, 'results carry ids for open-file');
});

test('search-files honors extension and age filters', async () => {
  const pdf = await action({ action: 'search-files', query: '', extension: '.pdf' });
  assert.equal(pdf.body.ok, true);
  assert.ok(pdf.body.results.some(item => item.name === 'report-2026.pdf'));

  const recent = await action({ action: 'search-files', query: 'note', withinDays: 7 });
  assert.equal(recent.body.ok, true);
  assert.ok(!recent.body.results.some(item => item.name === 'old-note.txt'), '30-day-old file excluded from a 7-day search');

  const aged = await action({ action: 'search-files', query: 'note', withinDays: 60 });
  assert.ok(aged.body.results.some(item => item.name === 'old-note.txt'), 'same file visible with a wider window');
});

test('opening a program requires explicit confirmation', async () => {
  const search = await action({ action: 'search-files', query: 'setup' });
  const exe = search.body.results.find(item => item.name === 'setup.exe');
  assert.ok(exe, 'fixture executable should be found');
  const gated = await action({ action: 'open-file', id: exe.id });
  assert.equal(gated.status, 400, 'unconfirmed dangerous open must not succeed');
  assert.equal(gated.body.ok, false);
  assert.equal(gated.body.needsConfirmation, true);
  assert.match(gated.body.message, /program or script/i);

  const missing = await action({ action: 'open-file', id: 'nope' });
  assert.equal(missing.body.ok, false);
  assert.ok(!missing.body.needsConfirmation);
});

test('local actions reject foreign browser origins', async () => {
  const response = await fetch(`${BASE}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ action: 'search-files', query: 'report' }),
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.ok, false);
});

test('ai-diagnose reports an unknown model without probing anything', async () => {
  const result = await action({ action: 'ai-diagnose', model: 'no-such-model-xyz' });
  assert.ok(typeof result.body.endpoint === 'string' && result.body.endpoint.length > 0);
  assert.equal(typeof result.body.running, 'boolean');
  assert.ok(typeof result.body.ms === 'number' && result.body.ms >= 0);
  assert.ok(typeof result.body.message === 'string' && result.body.message.length > 0);
  if (result.body.running) {
    assert.equal(result.body.modelInstalled, false);
    assert.match(result.body.message, /not installed/);
    assert.equal(result.body.probeMs, undefined, 'no generation probe for a missing model');
  }
});

test('ai-diagnose probes generation when the service is up', async () => {
  const response = await fetch(`${BASE}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'ai-diagnose', model: '' }),
    signal: AbortSignal.timeout(150000)
  });
  const body = await response.json();
  assert.ok(typeof body.message === 'string' && body.message.length > 0);
  if (!body.running) {
    assert.equal(body.ok, false, 'a stopped service must report failure, not success');
    return;
  }
  assert.ok(typeof body.probeMs === 'number', 'a running service gets a timed probe');
  assert.equal(typeof body.generationOk, 'boolean');
});

test('planner writes go to the temporary file and can be cleaned up', async () => {
  const start = new Date(Date.now() + 400 * 86400000);
  const create = await fetch(`${BASE}/api/planner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create-event', title: 'test-only event', start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), reminderMinutes: 0 }),
    signal: AbortSignal.timeout(10000)
  }).then(response => response.json());
  assert.equal(create.ok, true, create.message);
  assert.ok(fs.existsSync(plannerFile), 'planner data written to the temp file');
  const onDisk = JSON.parse(fs.readFileSync(plannerFile, 'utf8'));
  assert.ok(onDisk.events.some(item => item.title === 'test-only event'));

  const remove = await fetch(`${BASE}/api/planner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'cancel-event', id: create.event.id }),
    signal: AbortSignal.timeout(10000)
  }).then(response => response.json());
  assert.equal(remove.ok, true, remove.message);
  const afterRemove = JSON.parse(fs.readFileSync(plannerFile, 'utf8'));
  assert.ok(!afterRemove.events.some(item => item.id === create.event.id));
});

test('email drafts persist locally and inbox reports honest status', async () => {
  const saved = await action({ action: 'mail-save-draft', to: 'John', subject: 'Hello', body: 'Test body here.' });
  assert.equal(saved.body.ok, true, saved.body.message);
  assert.ok(typeof saved.body.id === 'string' && saved.body.id.length > 0);
  const listed = await action({ action: 'mail-list-drafts' });
  assert.equal(listed.body.ok, true);
  assert.ok(listed.body.drafts.some(item => item.id === saved.body.id && item.subject === 'Hello'));
  const inbox = await fetch(`${BASE}/api/mail/list?limit=3`).then(response => response.json());
  assert.equal(inbox.ok, false, 'no SMTP keys in this environment, so the inbox must say so');
  assert.match(inbox.message, /not configured|IMAP/i);
});

test('cancelling an alarm clears it everywhere including active state', async () => {
  const start = new Date(Date.now() + 400 * 86400000);
  const planner = body => fetch(`${BASE}/api/planner`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  }).then(response => response.json());
  const create = await planner({ action: 'create-alarm', when: start.toISOString(), title: 'test-only alarm' });
  assert.equal(create.ok, true, create.message);
  try {
    const triggered = await planner({ action: 'alarm-trigger', id: create.alarm.id });
    assert.equal(triggered.ok, true);
    const remove = await planner({ action: 'cancel-alarm', id: create.alarm.id });
    assert.equal(remove.ok, true, remove.message);
    const snapshot = await fetch(`${BASE}/api/planner`).then(response => response.json());
    assert.ok(!(snapshot.alarms || []).some(item => item.id === create.alarm.id), 'alarm gone from the list');
    const disk = JSON.parse(fs.readFileSync(plannerFile, 'utf8'));
    assert.notEqual(disk.activeAlarmId, create.alarm.id, 'stale active alarm cleared');
    assert.ok(!(disk.alarms || []).some(item => item.title === 'test-only alarm'), 'no NEXT ALARM residue');
  } finally {
    await planner({ action: 'cancel-alarm', id: create.alarm.id }).catch(() => ({}));
  }
});

test('due notifications retry boundedly, never duplicate, keep the schedule', async () => {
  const start = new Date(Date.now() + 4000);
  const planner = body => fetch(`${BASE}/api/planner`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  }).then(response => response.json());
  // Task-free event (reminderMinutes 0 schedules no Windows task).
  const create = await planner({ action: 'create-event', title: 'test-only due event', start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), reminderMinutes: 0 });
  assert.equal(create.ok, true, create.message);
  assert.ok(create.event.notify && typeof create.event.notify === 'object', 'notify tracking attached at creation');
  let seen = null;
  for (let i = 0; i < 25; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const snapshot = await fetch(`${BASE}/api/planner`).then(response => response.json());
    const found = (snapshot.events || []).find(item => item.id === create.event.id);
    if (found && found.notify && found.notify.dueSent) { seen = found.notify; break; }
  }
  assert.ok(seen, 'due loop processed the record');
  assert.equal(seen.dueSent, 'failed', 'unconfigured webhook fails honestly after bounded retries');
  assert.ok(seen.attempts >= 3, 'retried before giving up');
  const attempts = seen.attempts;
  await new Promise(resolve => setTimeout(resolve, 4000));
  const again = await fetch(`${BASE}/api/planner`).then(response => response.json());
  const refound = (again.events || []).find(item => item.id === create.event.id);
  assert.equal(refound.notify.attempts, attempts, 'no duplicate sends after terminal state');
  assert.equal(refound.title, 'test-only due event', 'schedule record untouched by notification failures');
  await planner({ action: 'cancel-event', id: create.event.id });
});

test('deleted events never generate due notifications', async () => {
  const start = new Date(Date.now() + 4000);
  const planner = body => fetch(`${BASE}/api/planner`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  }).then(response => response.json());
  const create = await planner({ action: 'create-event', title: 'test-only gone-early', start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), reminderMinutes: 0 });
  assert.equal(create.ok, true, create.message);
  const cancelled = await planner({ action: 'cancel-event', id: create.event.id });
  assert.equal(cancelled.ok, true, cancelled.message);
  // Wait past the due time plus two poll cycles: the loop must stay silent.
  await new Promise(resolve => setTimeout(resolve, 8000));
  const snapshot = await fetch(`${BASE}/api/planner`).then(response => response.json());
  assert.ok(!(snapshot.events || []).some(item => item.id === create.event.id), 'deleted event stays deleted');
  assert.ok(!output.includes('"test-only gone-early" due notification sent'), 'no due alert may fire for a deleted event');
});

test('tab control answers honestly when no controlled browser is running', async () => {
  const status = await action({ action: 'browser-control-status' }, undefined);
  assert.ok(typeof status.body.message === 'string' && status.body.message.length > 0);

  const tabs = await action({ action: 'tabs-list' });
  if (tabs.body.ok) {
    assert.ok(Array.isArray(tabs.body.tabs));
  } else {
    assert.ok(typeof tabs.body.message === 'string' && tabs.body.message.length > 0, 'failure replies explain what is missing');
  }

  const opened = status.body.connected
    ? null // a connected session is the user's live window: never open stray tabs in tests
    : await action({ action: 'tabs-open' });
  if (!opened) return;
  if (opened.body.ok) {
    assert.equal(opened.body.verified, true, 'an opened tab must be verified in the list');
    assert.ok(typeof opened.body.remaining === 'number');
  } else {
    assert.equal(opened.body.verified || false, false, 'must never claim an unverified open');
    assert.ok(typeof opened.body.message === 'string' && opened.body.message.length > 0);
  }
});

test('planner move-event updates the start and unknown ids fail safely', async () => {
  const start = new Date(Date.now() + 410 * 86400000);
  const planner = async body => fetch(`${BASE}/api/planner`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
  }).then(response => response.json());
  const create = await planner({ action: 'create-event', title: 'test-only move me', start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), reminderMinutes: 0 });
  assert.equal(create.ok, true, create.message);
  const movedStart = new Date(start.getTime() + 2 * 3600000);
  const moved = await planner({ action: 'move-event', id: create.event.id, start: movedStart.toISOString() });
  assert.equal(moved.ok, true, moved.message);
  assert.equal(Date.parse(moved.event.start), movedStart.getTime(), 'stored start matches the requested move');
  const snapshot = await fetch(`${BASE}/api/planner`).then(response => response.json());
  assert.ok(snapshot.events.some(item => item.id === create.event.id && Date.parse(item.start) === movedStart.getTime()), 'moved event visible in the snapshot list');
  const unknown = await planner({ action: 'cancel-event', id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /not found/);
  const remove = await planner({ action: 'cancel-event', id: create.event.id });
  assert.equal(remove.ok, true, remove.message);
  const after = JSON.parse(fs.readFileSync(plannerFile, 'utf8'));
  assert.ok(!after.events.some(item => item.id === create.event.id), 'only the test event was removed');
});

test('music status never claims playback it cannot verify', async () => {
  // 'status' only reads the Windows media session; it never starts audio.
  const status = await action({ action: 'music-status' });
  assert.equal(typeof status.body.ok, 'boolean');
  assert.ok(typeof status.body.message === 'string' || typeof status.body.status === 'string');
  if (status.body.ok) {
    assert.ok(['Paused', 'Playing', 'Stopped', 'Closed'].includes(status.body.status) || typeof status.body.status === 'string');
  } else {
    assert.match(status.body.message, /media session|YouTube Music|browser media/i);
  }
});

test('discord-ping without configuration fails honestly without network', async () => {
  const result = await action({ action: 'discord-ping', what: 'test' });
  assert.equal(result.body.ok, false);
  assert.equal(result.body.status, 'not-configured');
  assert.match(result.body.message, /JARVIS_DISCORD_WEBHOOK_URL/);
  assert.ok(!/webhooks\/\d+/.test(JSON.stringify(result.body)), 'no webhook URL can leak');
});
test('closing a nonexistent tab fails safely without touching anything', async () => {
  const result = await action({ action: 'tabs-close', query: 'tab-that-cannot-exist-xyz-123' });
  assert.equal(result.body.ok, false, 'must never claim an unmatched close succeeded');
  assert.ok(typeof result.body.message === 'string' && result.body.message.length > 0);
});

test('static HUD files are served', async () => {
  const page = await fetch(`${BASE}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /JARVIS/);
  assert.match(html, /id="hero"/);
  const core = await fetch(`${BASE}/jarvis-core.js`);
  assert.equal(core.status, 200);
  assert.match(await core.text(), /JarvisCore/);
});

test('list-directory reads real folder contents by search-result ID only', async () => {
  const search = await action({ action: 'search-files', query: 'probedir' });
  assert.equal(search.body.ok, true);
  const dir = (search.body.results || []).find(item => item.type === 'folder' && item.name === 'probedir');
  assert.ok(dir, 'the fixture folder must be found with folder type');
  const listed = await action({ action: 'list-directory', id: dir.id });
  assert.equal(listed.body.ok, true, listed.body.message);
  const names = (listed.body.items || []).map(item => item.name).sort();
  assert.deepEqual(names, ['alpha.txt', 'beta.md']);
  assert.ok((listed.body.items || []).every(item => item.type === 'file'));
  const fileTarget = (search.body.results || []).find(item => item.type === 'file');
  if (fileTarget) {
    const notDir = await action({ action: 'list-directory', id: fileTarget.id });
    assert.equal(notDir.body.ok, false, 'a file ID must not list as a folder');
  }
  const missing = await action({ action: 'list-directory', id: 'nope1234' });
  assert.equal(missing.body.ok, false, 'unknown IDs fail honestly');
});
