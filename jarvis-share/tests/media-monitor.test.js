'use strict';
// Tests for the media monitor: parsing of the real capture/session output, the
// NDJSON fan-out to the orb, and the capture lifecycle (started on demand,
// stopped when idle, restart-limited, Windows-only honesty).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const monitorModule = require('../media-monitor.js');

test('capture lines from the loopback helper parse into frames', () => {
  assert.equal(monitorModule.parseCaptureLine(''), null);
  assert.equal(monitorModule.parseCaptureLine('garbage output'), null);
  const ready = monitorModule.parseCaptureLine('READY 48000 2 1024 30');
  assert.deepEqual(ready, { type: 'ready', sampleRate: 48000, channels: 2, fftSize: 1024, fps: 30 });
  const frame = monitorModule.parseCaptureLine('F 0.8400 0.1000 0.2000 0.3000 0.9602 -4.6 -4.6 0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.000 0.010 0.999 0.000 0.000');
  assert.equal(frame.type, 'frame');
  assert.equal(frame.level, 0.84);
  assert.equal(frame.high, 0.9602);
  assert.equal(frame.rmsDb, -4.6);
  assert.equal(frame.bars.length, 12, 'frames always carry 12 buckets');
  assert.equal(frame.bars[9], 0.999, 'the treble bucket reaches the orb');
  assert.equal(frame.bars[11], 0, 'missing buckets are zero-filled, never invented');
  assert.equal(monitorModule.parseCaptureLine('ERR no audio device').type, 'error');
  assert.equal(monitorModule.parseCaptureLine('ERR no audio device').message, 'no audio device');
  assert.equal(monitorModule.parseCaptureLine('STOPPED').type, 'stopped');
  assert.equal(monitorModule.parseCaptureLine('F 1 2 3'), null, 'short frames are ignored, not guessed');
});

test('media session lines parse, including Chrome with no metadata', () => {
  assert.equal(monitorModule.parseSessionLine(''), null);
  const sessions = monitorModule.parseSessionLine('S {"ok":true,"sessions":[{"appId":"chrome.exe","status":"Playing","title":"Video","artist":"Channel"},{"appId":"Spotify.exe","status":"Paused","title":"Song","artist":"Band"}],"count":2}');
  assert.equal(sessions.type, 'sessions');
  assert.equal(sessions.ok, true);
  assert.equal(sessions.sessions.length, 2);
  assert.equal(sessions.playing.length, 1, 'only playing sessions count as active media');
  assert.equal(monitorModule.appName('chrome.exe'), 'chrome');
  assert.equal(monitorModule.appName('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), 'chrome');
  const untitled = monitorModule.parseSessionLine('S {"ok":true,"sessions":[{"appId":"chrome.exe","status":"Playing","title":"","artist":""}]}');
  assert.equal(untitled.playing.length, 1, 'a session without metadata is still active media');
  assert.equal(monitorModule.sessionLabel(untitled.playing[0]), '');
  const failure = monitorModule.parseSessionLine('S {"ok":false,"message":"Windows media sessions are unavailable"}');
  assert.equal(failure.ok, false);
  assert.match(failure.message, /unavailable/);
  const command = monitorModule.parseSessionLine('R {"ok":true,"appId":"chrome.exe","action":"play-pause","status":"Paused"}');
  assert.equal(command.type, 'command');
  assert.equal(command.status, 'Paused');
  assert.equal(monitorModule.parseSessionLine('not json at all'), null);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.killed = false;
  child.exited = false;
  child.on('exit', () => { child.exited = true; });
  child.kill = function kill() { child.killed = true; child.emit('exit', 0); };
  return child;
}

function fakeClient() {
  return { lines: [], write(line) { this.lines.push(line); return true; }, payloads() { return this.lines.map(line => JSON.parse(line)); } };
}

test('the capture starts on demand, fans out real frames, and stops when idle', async () => {
  const children = [];
  const monitor = monitorModule.createMediaMonitor({
    root: process.cwd(),
    fps: 30,
    idleStopMs: 20,
    spawn: () => { const child = fakeChild(); children.push(child); return child; },
    log: { log() {}, error() {} }
  });
  const client = fakeClient();
  monitor.addClient(client);
  assert.equal(children.length, 2, 'one capture process and one session monitor start');
  const capture = children[0];
  capture.stdout.emit('data', 'READY 48000 2 1024 30\nF 0.5 0.6 0.4 0.3 0.2 -8.0 -12.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 0.8 0.7\n');
  const types = client.payloads().map(payload => payload.type);
  assert.ok(types.includes('hello'), 'new clients get a hello');
  assert.ok(types.includes('ready'), 'the orb learns the capture format');
  const frame = client.payloads().find(payload => payload.type === 'frame');
  assert.ok(frame, 'measured frames reach the client');
  assert.equal(frame.level, 0.5);
  assert.equal(frame.bars.length, 12);
  const status = monitor.status();
  assert.equal(status.capture.running, true);
  assert.equal(status.capture.ready, true);
  assert.equal(status.capture.frames, 1);
  assert.equal(status.clients, 1);
  assert.equal(monitor.health().receiving, true, 'fresh frames mean the orb can trust the pipeline');

  const sessionsChild = children[1];
  sessionsChild.stdout.emit('data', 'S {"ok":true,"sessions":[{"appId":"chrome.exe","status":"Playing","title":"YouTube","artist":""}],"count":1}\n');
  assert.deepEqual(monitor.status().activeMedia, ['chrome'], 'the playing app is identified without browser control');
  assert.deepEqual(monitor.status().playingTitles, ['YouTube']);

  monitor.removeClient(client);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(capture.killed, true, 'the capture process is stopped once nobody is watching');
  assert.equal(sessionsChild.killed, true, 'the session monitor stops with it');
  assert.equal(monitor.status().capture.running, false);
  monitor.stop();
});

test('a failing capture is restarted, then reported instead of looping forever', async () => {
  const children = [];
  const captures = [];
  const errors = [];
  const monitor = monitorModule.createMediaMonitor({
    root: process.cwd(),
    idleStopMs: 50,
    restartDelayMs: 2,
    spawn: (file, args) => {
      const child = fakeChild();
      children.push(child);
      if (String((args || []).join(' ')).includes('jarvis-audio-loopback')) captures.push(child);
      return child;
    },
    log: { log() {}, error: message => errors.push(String(message)) }
  });
  monitor.addClient(fakeClient());
  assert.equal(captures.length, 1, 'the capture process starts first');
  for (let attempt = 0; attempt < 14; attempt++) {
    const child = captures[captures.length - 1];
    if (child && !child.killed) child.emit('exit', 1);
    await new Promise(resolve => setTimeout(resolve, 12));
  }
  const status = monitor.status();
  assert.ok(status.capture.restarts >= 2, `a dead capture is retried, restarts=${status.capture.restarts}`);
  assert.ok(status.capture.error.length > 0 || errors.join(' ').includes('keeps failing'), 'repeated failures surface as a clear error instead of looping silently');
  monitor.stop();
  assert.equal(children.filter(child => !child.exited).length, 0, 'stopping leaves no capture or session process running');
});

test('a wedged capture is detected and rebuilt instead of freezing the orb', async () => {
  const captures = [];
  const monitor = monitorModule.createMediaMonitor({
    root: process.cwd(),
    restartDelayMs: 5,
    startupGraceMs: 500, // the startup window only matters right after a (re)start
    spawn: (file, args) => {
      const child = fakeChild();
      if (String((args || []).join(' ')).includes('jarvis-audio-loopback')) captures.push(child);
      return child;
    },
    log: { log() {}, error() {} }
  });
  const client = fakeClient();
  monitor.addClient(client);
  assert.equal(captures.length, 1, 'the capture process starts');
  captures[0].stdout.emit('data', 'READY 48000 2 1024 30\nF 0.5 0.5 0.5 0.5 0.5 -8.0 -12.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 0.8 0.7\n');
  assert.equal(monitor.checkStall(Date.now()), false, 'fresh frames are healthy');
  assert.equal(monitor.status().capture.stalled, false);

  assert.equal(monitor.checkStall(Date.now() + 5000), true, 'a stream of frames that stops is a stall, not silence');
  assert.equal(monitor.status().capture.stalled, true, 'the stall is visible in the diagnostics');
  assert.equal(captures[0].killed, true, 'the wedged capture process is killed rather than left running');
  assert.ok(client.payloads().some(payload => payload.type === 'capture' && payload.stalled === true), 'the orb is told the capture stalled');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(captures.length, 2, 'a fresh capture is started');
  captures[1].stdout.emit('data', 'READY 48000 2 1024 30\nF 0.4 0.4 0.4 0.4 0.4 -9.0 -13.0 0.1 0.1 0.1 0.1 0.1 0.1 0.1 0.1 0.1 0.1 0.1\n');
  assert.equal(monitor.status().capture.stalled, false, 'receiving frames again clears the stall');
  assert.equal(monitor.health().receiving, true);

  monitor.removeClient(client);
  assert.equal(monitor.checkStall(Date.now() + 60000), false, 'nothing runs (or restarts) with no client watching');
  monitor.stop();
});

test('a restarted capture gets its startup window instead of being killed again', async () => {
  const captures = [];
  const monitor = monitorModule.createMediaMonitor({
    root: process.cwd(),
    restartDelayMs: 5,
    stallMs: 1500,
    startupGraceMs: 1000,
    spawn: (file, args) => {
      const child = fakeChild();
      if (String((args || []).join(' ')).includes('jarvis-audio-loopback')) captures.push(child);
      return child;
    },
    log: { log() {}, error() {} }
  });
  monitor.addClient(fakeClient());
  captures[0].stdout.emit('data', 'READY 48000 2 1024 30\nF 0.5 0.5 0.5 0.5 0.5 -8.0 -12.0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 0.8 0.7\n');
  assert.equal(monitor.checkStall(Date.now() + 5000), true, 'the wedged capture is detected');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(captures.length, 2, 'a retry was started');

  // PowerShell needs a moment to compile the WASAPI interop before the first
  // frame. Killing the retry in that window is the bug that made recovery loop.
  assert.equal(monitor.checkStall(Date.now()), false, 'the retry is not killed during its startup window');
  assert.equal(captures[1].killed, false, 'the retry is still running');
  assert.equal(monitor.checkStall(Date.now() + 20000), true, 'past the window with no frames is a real stall');
  monitor.stop();
});

test('transport prefers a Windows media session and defers to the media keys otherwise', async () => {
  const children = [];
  const monitor = monitorModule.createMediaMonitor({
    root: process.cwd(),
    spawn: () => { const child = fakeChild(); children.push(child); return child; },
    execFileAsync: async () => ({ stdout: 'R {"ok":true,"appId":"Spotify.exe","action":"next","status":"Playing","title":"Song"}\n' }),
    log: { log() {}, error() {} }
  });
  const noSessions = await monitor.command('next');
  assert.equal(noSessions, null, 'no session means the caller falls back to the system media keys');
  assert.equal((await monitor.command('explode')).ok, false, 'unknown commands are refused');

  const client = fakeClient();
  monitor.addClient(client);
  children[1].stdout.emit('data', 'S {"ok":true,"sessions":[{"appId":"Spotify.exe","status":"Playing","title":"Song","artist":"Band"}],"count":1}\n');
  const result = await monitor.command('next');
  assert.equal(result.ok, true);
  assert.equal(result.appId, 'Spotify.exe');
  assert.equal(result.status, 'Playing');
  monitor.stop();
});
