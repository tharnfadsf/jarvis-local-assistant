'use strict';
// JARVIS media monitor — the media/audio pipeline behind the Media Orb.
//
// Design (and why):
// - PRIMARY signal is real system audio: jarvis-audio-loopback.ps1 captures the
//   Windows output mix with WASAPI loopback and streams FFT frames. This works
//   for ANY app that produces sound — Chrome, Edge, Spotify, games, movies —
//   and does not depend on browser automation, browser control, or a permission
//   prompt. Measured on this machine: Chrome web audio, SoundPlayer, and an
//   isolated-profile Chrome page all arrive with correct bands.
// - SECONDARY signal is Windows media sessions (GSMTC via
//   jarvis-media-sessions.ps1) for title/artist and precise transport. It is
//   optional on purpose: Chrome did NOT register a session here even while
//   playing web media, so detection must never depend on it. An empty session
//   list means "unknown", never "nothing is playing".
// - Existing Edge browser-control media status stays as a third source of
//   metadata. None of the three can block the orb from appearing.
//
// The capture process only runs while a client (the JARVIS window) is watching,
// and it is stopped again after a grace period so JARVIS never leaves a capture
// session or a PowerShell process running on its own.
const { spawn, execFile } = require('child_process');
const path = require('path');

const DEFAULT_FPS = 30;
const RESTART_DELAY_MS = 2500;
const IDLE_STOP_MS = 30000;
const MAX_RESTARTS_PER_MINUTE = 6;
// The helper now emits on a fixed schedule whether or not packets arrive, so
// gaps longer than this mean the process is wedged (device change, suspended
// audio service, a hung pipe) rather than a quiet moment.
const STALL_MS = 1500;
const STARTUP_GRACE_MS = 9000;
const WATCHDOG_MS = 1000;

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// Parse one line from the loopback capture process.
function parseCaptureLine(line) {
  const text = String(line == null ? '' : line).trim();
  if (!text) return null;
  if (text === 'STOPPED') return { type: 'stopped' };
  if (text.startsWith('READY')) {
    const parts = text.split(/\s+/);
    return {
      type: 'ready',
      sampleRate: toNumber(parts[1]),
      channels: toNumber(parts[2]),
      fftSize: toNumber(parts[3]),
      fps: toNumber(parts[4])
    };
  }
  if (text.startsWith('ERR')) return { type: 'error', message: text.slice(3).trim() };
  if (text.startsWith('F ') || text === 'F') {
    const parts = text.slice(1).trim().split(/\s+/).map(Number);
    if (parts.length < 7 || parts.some(value => !Number.isFinite(value))) return null;
    const [level, bass, lowMid, mid, high, peakDb, rmsDb] = parts;
    // Always hand the orb exactly 12 buckets, padded or trimmed, so the client
    // never renders a partially formed spectrum.
    const bars = new Array(12).fill(0);
    const raw = parts.slice(7, 19);
    for (let index = 0; index < bars.length; index++) {
      const value = Number(raw[index]);
      bars[index] = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    }
    return { type: 'frame', level, bass, lowMid, mid, high, peakDb, rmsDb, bars };
  }
  return null;
}

// Parse one line from the media-session monitor.
function parseSessionLine(line) {
  const text = String(line == null ? '' : line).trim();
  if (!text) return null;
  const isResult = text.startsWith('R ');
  if (!isResult && !text.startsWith('S ')) return null;
  let payload = null;
  try { payload = JSON.parse(text.slice(2)); } catch { return { type: isResult ? 'command' : 'sessions', ok: false, message: 'The media session monitor returned unreadable data.' }; }
  if (isResult) return { type: 'command', ...payload };
  const sessions = Array.isArray(payload && payload.sessions) ? payload.sessions : [];
  return {
    type: 'sessions',
    ok: payload && payload.ok !== false,
    message: (payload && payload.message) || '',
    sessions,
    playing: sessions.filter(session => session && session.status === 'Playing')
  };
}

function sessionLabel(session) {
  if (!session) return '';
  return String(session.title || '').trim();
}

function appName(appId) {
  const raw = String(appId || '').trim();
  if (!raw) return '';
  const base = raw.split('!')[0].split('\\').pop() || raw;
  return base.replace(/\.exe$/i, '');
}

function createMediaMonitor(options = {}) {
  const root = options.root || __dirname;
  const spawnImpl = options.spawn || spawn;
  const runPowerShell = options.execFile || execFile;
  const fps = toNumber(options.fps, DEFAULT_FPS) || DEFAULT_FPS;
  const idleStopMs = toNumber(options.idleStopMs, IDLE_STOP_MS) || IDLE_STOP_MS;
  const restartDelayMs = toNumber(options.restartDelayMs, RESTART_DELAY_MS) || RESTART_DELAY_MS;
  const stallMs = toNumber(options.stallMs, STALL_MS) || STALL_MS;
  const startupGraceMs = toNumber(options.startupGraceMs, STARTUP_GRACE_MS) || STARTUP_GRACE_MS;
  const watchdogMs = toNumber(options.watchdogMs, WATCHDOG_MS) || WATCHDOG_MS;
  const log = options.log || console;
  const captureScript = path.join(root, 'jarvis-audio-loopback.ps1');
  const sessionScript = path.join(root, 'jarvis-media-sessions.ps1');

  const state = {
    capture: { running: false, ready: false, error: '', stalled: false, sampleRate: 0, channels: 0, fftSize: 0, fps: 0, restarts: 0, startedAt: 0 },
    frame: null,
    frameAt: 0,
    frames: 0,
    droppedLines: 0,
    sessions: { ok: false, list: [], playing: [], at: 0, message: '' },
    clients: 0,
    lastClientAt: 0
  };

  const clients = new Set();
  let captureProcess = null;
  let sessionProcess = null;
  let restartTimer = null;
  let idleTimer = null;
  let restartTimes = [];
  let stopping = false;
  let watchdogTimer = null;

  // A stale frame stream is worse than no stream: the orb would keep rendering
  // whatever the last frame said. Detect it and rebuild the capture so the orb
  // always either receives live data or knows the capture is down.
  function stallReason(now) {
    if (!clients.size || stopping) return '';
    if (!state.capture.running) return '';
    // A freshly (re)started capture gets the full startup grace: PowerShell has
    // to compile the WASAPI interop before the first frame lands (~1-3 s here).
    // Without this the watchdog killed every retry during startup, so a stalled
    // capture could never come back at all.
    const age = state.capture.startedAt ? now - state.capture.startedAt : 0;
    if (age < startupGraceMs) return '';
    if (!state.frameAt) return 'the system audio capture never produced a frame';
    if (now - state.frameAt > stallMs) return `the system audio capture stopped sending frames (${now - state.frameAt} ms silent)`;
    return '';
  }

  function checkStall(now = Date.now()) {
    const reason = stallReason(now);
    if (!reason) return false;
    state.capture.stalled = true;
    if (!state.capture.error) state.capture.error = 'The system audio capture stalled; restarting it.';
    log.error(`[JARVIS media] ${reason}`);
    broadcast({ type: 'capture', running: false, stalled: true, error: state.capture.error });
    stopCapture('stalled');
    scheduleRestart(reason);
    return true;
  }

  function startWatchdog() {
    if (watchdogTimer || watchdogMs <= 0) return;
    watchdogTimer = setInterval(() => checkStall(), watchdogMs);
    watchdogTimer.unref?.();
  }

  function stopWatchdog() {
    if (!watchdogTimer) return;
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  function sendClient(client, payload) {
    try { client.write(`${JSON.stringify(payload)}\n`); } catch { removeClient(client); }
  }

  function broadcast(payload) {
    for (const client of [...clients]) sendClient(client, payload);
  }

  function stopCapture(reason) {
    if (captureProcess) {
      const child = captureProcess;
      captureProcess = null;
      try { child.kill(); } catch { }
    }
    if (sessionProcess) {
      const child = sessionProcess;
      sessionProcess = null;
      try { child.kill(); } catch { }
    }
    state.capture.running = false;
    state.capture.ready = false;
    if (reason && reason !== 'idle') log.log(`[JARVIS media] capture stopped (${reason})`);
    broadcast({ type: 'capture', running: false, reason: reason || 'stopped' });
  }

  function scheduleRestart(reason) {
    if (!clients.size || stopping) return;
    const now = Date.now();
    restartTimes = restartTimes.filter(at => now - at < 60000);
    if (restartTimes.length >= MAX_RESTARTS_PER_MINUTE) {
      state.capture.error = `System audio capture keeps failing (${reason}). Restart JARVIS or check the Windows audio device.`;
      log.error('[JARVIS media] capture restart limit reached:', reason);
      broadcast({ type: 'capture', running: false, error: state.capture.error });
      return;
    }
    restartTimes.push(now);
    if (restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (clients.size && !captureProcess) startCapture();
    }, restartDelayMs);
    restartTimer.unref?.();
  }

  function startCapture() {
    if (captureProcess) return;
    if (process.platform !== 'win32') {
      state.capture.error = 'System audio capture is only available on Windows.';
      return;
    }
    state.capture.error = '';
    state.capture.restarts += 1;
    state.capture.startedAt = Date.now();
    let child;
    try {
      child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', captureScript, '-Fps', String(fps)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      scheduleRestart(error.message);
      return;
    }
    captureProcess = child;
    state.capture.running = true;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const parsed = parseCaptureLine(line);
        if (parsed) handleCaptureEvent(parsed);
        else if (line.trim()) state.droppedLines += 1;
        index = buffer.indexOf('\n');
      }
      if (buffer.length > 65536) buffer = '';
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      const text = String(chunk).trim();
      if (text) state.capture.error = text.slice(0, 300);
    });
    child.on('error', error => {
      state.capture.error = error.message;
      state.capture.running = false;
      captureProcess = null;
      scheduleRestart(error.message);
    });
    child.on('exit', () => {
      const wasCurrent = captureProcess === child;
      captureProcess = null;
      state.capture.running = false;
      state.capture.ready = false;
      if (wasCurrent && clients.size && !stopping) scheduleRestart('capture process exited');
    });
    startSessions();
  }

  function handleCaptureEvent(event) {
    if (event.type === 'ready') {
      state.capture.ready = true;
      state.capture.sampleRate = event.sampleRate;
      state.capture.channels = event.channels;
      state.capture.fftSize = event.fftSize;
      state.capture.fps = event.fps;
      state.capture.error = '';
      broadcast({ type: 'ready', sampleRate: event.sampleRate, channels: event.channels, fftSize: event.fftSize, fps: event.fps });
      return;
    }
    if (event.type === 'frame') {
      state.frame = event;
      state.frameAt = Date.now();
      state.frames += 1;
      if (state.capture.stalled) { state.capture.stalled = false; state.capture.error = ''; broadcast({ type: 'capture', running: true, stalled: false }); }
      broadcast({ type: 'frame', level: event.level, bass: event.bass, lowMid: event.lowMid, mid: event.mid, high: event.high, peakDb: event.peakDb, rmsDb: event.rmsDb, bars: event.bars, at: state.frameAt });
      return;
    }
    if (event.type === 'error') {
      state.capture.error = event.message;
      state.capture.ready = false;
      broadcast({ type: 'capture', running: false, error: event.message });
      return;
    }
    if (event.type === 'stopped') {
      state.capture.ready = false;
      return;
    }
  }

  function startSessions() {
    if (sessionProcess || process.platform !== 'win32') return;
    let child;
    try {
      child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', sessionScript, '-Interval', '2'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return; }
    sessionProcess = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const parsed = parseSessionLine(line);
        if (parsed && parsed.type === 'sessions') {
          state.sessions = {
            ok: parsed.ok,
            list: parsed.sessions || [],
            playing: parsed.playing || [],
            at: Date.now(),
            message: parsed.message || ''
          };
          broadcast({ type: 'sessions', sessions: state.sessions.list, playing: state.sessions.playing, ok: state.sessions.ok, message: state.sessions.message });
        }
        index = buffer.indexOf('\n');
      }
      if (buffer.length > 65536) buffer = '';
    });
    child.on('error', () => { sessionProcess = null; });
    child.on('exit', () => {
      if (sessionProcess === child) sessionProcess = null;
      if (clients.size && !stopping) {
        const timer = setTimeout(() => { if (clients.size && !stopping) startSessions(); }, RESTART_DELAY_MS);
        timer.unref?.();
      }
    });
  }

  function addClient(res) {
    clients.add(res);
    state.clients = clients.size;
    state.lastClientAt = Date.now();
    sendClient(res, {
      type: 'hello',
      capture: { running: state.capture.running, ready: state.capture.ready, error: state.capture.error, sampleRate: state.capture.sampleRate, fps: state.capture.fps },
      sessions: state.sessions.list,
      playing: state.sessions.playing
    });
    if (state.frame) sendClient(res, { type: 'frame', ...state.frame, at: state.frameAt });
    startCapture();
    startWatchdog();
    return () => removeClient(res);
  }

  function removeClient(res) {
    if (!clients.delete(res)) return;
    state.clients = clients.size;
    state.lastClientAt = Date.now();
    if (!clients.size) stopWatchdog();
    if (!idleTimer) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (!clients.size) stopCapture('idle');
      }, idleStopMs);
      idleTimer.unref?.();
    }
  }

  // Diagnostics snapshot for /api/media/status and the orb's debug panel.
  function status() {
    const frameAge = state.frame ? Date.now() - state.frameAt : null;
    return {
      ok: true,
      platform: process.platform,
      capture: {
        running: state.capture.running,
        ready: state.capture.ready,
        error: state.capture.error,
        stalled: state.capture.stalled,
        sampleRate: state.capture.sampleRate,
        channels: state.capture.channels,
        fftSize: state.capture.fftSize,
        fps: state.capture.fps,
        restarts: state.capture.restarts,
        frames: state.frames,
        droppedLines: state.droppedLines,
        frameAgeMs: frameAge
      },
      clients: state.clients,
      sessions: state.sessions.list,
      playing: state.sessions.playing,
      sessionMessage: state.sessions.message,
      activeMedia: state.sessions.playing.map(session => appName(session.appId)).filter(Boolean),
      playingTitles: state.sessions.playing.map(sessionLabel).filter(Boolean)
    };
  }

  function health() {
    const captureOk = state.capture.running && state.capture.ready && state.frame && Date.now() - state.frameAt < STALL_MS;
    return {
      running: state.capture.running,
      ready: state.capture.ready,
      receiving: Boolean(captureOk),
      stalled: Boolean(state.capture.stalled),
      clients: state.clients,
      frames: state.frames,
      frameAgeMs: state.frameAt ? Date.now() - state.frameAt : null,
      playing: state.sessions.playing.length,
      error: state.capture.error || ''
    };
  }

  // Precise transport through Windows media sessions when one exists. Returns
  // null when there is no session so callers can fall back to the system media
  // keys that already work for every player.
  function command(action, app) {
    const allowed = new Set(['play-pause', 'play', 'pause', 'next', 'previous', 'stop']);
    const requested = String(action || '').toLowerCase();
    if (!allowed.has(requested)) return Promise.resolve({ ok: false, message: 'That media command is not supported.' });
    if (process.platform !== 'win32') return Promise.resolve({ ok: false, message: 'Windows media sessions are required for that control.' });
    if (!state.sessions.list.length) return Promise.resolve(null);
    const run = options.execFileAsync || require('util').promisify(runPowerShell);
    return run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', sessionScript, '-Action', requested, ...(app ? ['-App', String(app)] : [])], { windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024 })
      .then(result => {
        const line = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
        const parsed = parseSessionLine(line);
        if (!parsed) return null;
        return { ok: Boolean(parsed.ok), appId: parsed.appId || '', status: parsed.status || '', title: parsed.title || '', action: parsed.action || requested, message: parsed.message || '' };
      })
      .catch(error => ({ ok: false, message: `The media session did not answer: ${error.message}` }));
  }

  function stop() {
    stopping = true;
    stopWatchdog();
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    stopCapture('shutdown');
  }

  return { addClient, removeClient, status, health, command, stop, startCapture, checkStall, stallReason, state, parseCaptureLine, parseSessionLine, appName };
}

module.exports = { createMediaMonitor, parseCaptureLine, parseSessionLine, appName, sessionLabel, DEFAULT_FPS, IDLE_STOP_MS, STALL_MS };
