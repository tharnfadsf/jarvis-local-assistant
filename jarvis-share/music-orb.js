'use strict';
/* JARVIS Media Orb — interactive holographic media/audio interface.
 *
 * Companion overlay to the HUD (which is untouched). It visualizes whatever the
 * computer is playing, from any application.
 *
 * Where the audio comes from (real measured audio, never a decorative loop):
 * - The orb subscribes to /api/media/stream, an NDJSON stream produced by
 *   media-monitor.js. That module runs jarvis-audio-loopback.ps1, which
 *   captures the Windows output mix with WASAPI loopback and streams real FFT
 *   frames (level, bass, low-mid, mid, high, 12 log-spaced buckets).
 * - That is application agnostic: Chrome, Edge, Spotify, movies, games and
 *   local players all reach the same output mix. It needs no permission prompt,
 *   no screen sharing and no browser automation, and it is verified to pick up
 *   Chrome web audio.
 * - Windows media sessions (GSMTC) are used only for title/artist and precise
 *   transport, when a session exists. Chrome did not register one on this
 *   machine, so nothing about appearing, animating or reacting depends on it.
 *   Edge browser-control metadata stays as a third optional source.
 * - With no capture (for example a non-Windows host or a capture failure) the
 *   orb says so and stays calm instead of faking movement.
 *
 * Interaction: click the orb to expand/collapse, drag anywhere on the panel to
 * move it, hover for a holographic response, and transport controls that only
 * light up when a source actually supports them. The overlay never takes focus.
 */
(function () {
  const STREAM_RETRY_MS = 3000;
  const STREAM_RETRY_MAX_MS = 15000;
  const SESSION_POLL_MS = 5000;
  const GRACE_MS = 8000;
  const DISMISS_KEY = 'jarvis-orb-dismissed';
  const POS_KEY = 'jarvis-orb-pos';
  const DEBUG_KEY = 'jarvis-orb-debug';

  const METRIC_DEFAULTS = { attack: 0.45, release: 0.1, bandAttack: 0.42, bandRelease: 0.11, transientRise: 0.06, pulseDecay: 0.82, pulseHold: 0.05, waves: 12 };
  const ACTIVITY_DEFAULTS = { floor: 0.018, bandFloor: 0.05, attackMs: 120, holdMs: 1100 };
  // A frame stream that goes quiet for longer than this is not "a quiet moment":
  // the capture is stalled or gone. The orb must settle and say so rather than
  // keep rendering the last frame as if it were live.
  const STALE_MS = 1400;
  const STYLE_DEFAULTS = { style: 'spectrum', sensitivity: 1, smoothing: 1, glow: 1, peaks: true, bars: 12 };

  function clamp01(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return number < 0 ? 0 : number > 1 ? 1 : number;
  }

  function emptyMetrics() { return { level: 0, bass: 0, lowMid: 0, mid: 0, high: 0, pulse: 0 }; }

  function asBars(value) {
    const list = Array.isArray(value) ? value : [];
    const bars = new Array(12).fill(0);
    for (let index = 0; index < bars.length; index++) bars[index] = clamp01(list[index] || 0);
    return bars;
  }

  // One server frame -> raw metrics plus the real measured spectrum. Frames are
  // already measured audio.
  function metricsFromFrame(frame) {
    if (!frame || frame.type !== 'frame') return null;
    return {
      level: clamp01(frame.level),
      bass: clamp01(frame.bass),
      lowMid: clamp01(frame.lowMid),
      mid: clamp01(frame.mid),
      high: clamp01(frame.high),
      bars: Array.isArray(frame.bars) ? frame.bars.slice() : null
    };
  }

  // Envelope follower: fast attack so a beat lands immediately, slower release
  // so the orb settles instead of flickering, plus a peak pulse for transients.
  // Each band also keeps a peak hold that decays separately so the bars remember
  // the loudest recent hit for each frequency range.
  function smoothMetrics(prev, raw, config) {
    const cfg = { ...METRIC_DEFAULTS, ...(config || {}) };
    const base = prev && typeof prev.level === 'number' ? prev : emptyMetrics();
    const source = raw || emptyMetrics();
    const approach = (current, target, up, down) => current + (target - current) * (target > current ? up : down);
    const next = emptyMetrics();
    next.level = approach(base.level, clamp01(source.level), cfg.attack, cfg.release);
    next.bass = approach(base.bass, clamp01(source.bass), cfg.bandAttack, cfg.bandRelease);
    next.lowMid = approach(base.lowMid, clamp01(source.lowMid), cfg.bandAttack, cfg.bandRelease);
    next.mid = approach(base.mid, clamp01(source.mid), cfg.bandAttack, cfg.bandRelease);
    next.high = approach(base.high, clamp01(source.high), cfg.bandAttack, cfg.bandRelease);
    next.pulse = next.level - base.level > cfg.transientRise ? 1 : Math.max(0, base.pulse * cfg.pulseDecay - cfg.pulseHold);
    next.peaks = new Array(cfg.waves).fill(0);
    const rawBars = Array.isArray(source.bars) ? source.bars : [];
    const basePeaks = Array.isArray(base.peaks) ? base.peaks : new Array(cfg.waves).fill(0);
    for (let index = 0; index < cfg.waves; index++) {
      const value = clamp01(rawBars[index] || 0);
      const smoothed = approach(base.bass + (index >= 4 ? index < 7 ? base.lowMid : index < 10 ? base.mid : base.high : base.bass) - base.bass, value, cfg.bandAttack, cfg.bandRelease);
      next.peaks[index] = Math.max(value, basePeaks[index] * 0.92);
    }
    return next;
  }

  // Is audio playing right now? Sustained onset plus a hold window, so brief
  // gaps (buffering, silence between tracks, a breath) never flicker the orb.
  // Quiet media (a video at low volume) still carries real band energy, so the
  // band check keeps it triggering while true silence — level 0 across every
  // band, which is what a stopped stream measures — never does.
  function updateAudioActivity(prev, level, now, config, bandEnergy) {
    const cfg = { ...ACTIVITY_DEFAULTS, ...(config || {}) };
    const state = {
      active: Boolean(prev && prev.active),
      since: (prev && prev.since) || 0,
      candidateSince: (prev && prev.candidateSince) || 0,
      lastLoudAt: (prev && prev.lastLoudAt) || 0
    };
    const bands = Number.isFinite(Number(bandEnergy)) ? clamp01(bandEnergy) : null;
    const measurable = clamp01(level) > cfg.floor && (bands == null || bands > cfg.bandFloor);
    if (measurable) {
      if (!state.candidateSince) state.candidateSince = now;
      state.lastLoudAt = now;
      if (!state.active && now - state.candidateSince >= cfg.attackMs) { state.active = true; state.since = now; }
    } else {
      state.candidateSince = 0;
      if (state.active && now - state.lastLoudAt > cfg.holdMs) { state.active = false; state.since = now; }
    }
    return state;
  }

  // Pure session identity for the verified Edge player path.
  function orbSessionKey(status) {
    if (!status || !status.ok || !status.title) return '';
    const url = (status.tab && status.tab.url) || '';
    return `${status.title} ${url}`.trim();
  }

  // Smoothly sample the measured spectrum at a normalized position (0 = lowest
  // bucket, 1 = highest). It only interpolates between the buckets the capture
  // actually measured, so silent bands stay silent.
  function spectrumAt(bars, position) {
    const list = Array.isArray(bars) ? bars : [];
    if (!list.length) return 0;
    const scaled = clamp01(position) * (list.length - 1);
    const index = Math.floor(scaled);
    const next = Math.min(list.length - 1, index + 1);
    const blend = scaled - index;
    return clamp01(list[index] * (1 - blend) + list[next] * blend);
  }

  // Frames arrive on a fixed schedule (30 fps). Missing them means the capture
  // is stalled, not that the media went quiet.
  function isFrameStale(lastFrameAt, now, staleAfterMs = STALE_MS) {
    if (!lastFrameAt) return false;
    return now - lastFrameAt > staleAfterMs;
  }

  function sessionTitle(session) { return String((session && session.title) || '').trim(); }
  function sessionArtist(session) { return String((session && session.artist) || '').trim(); }
  function sessionApp(session) { return String((session && session.appId) || '').split('!')[0].split('\\').pop().replace(/\.exe$/i, ''); }

  // Best available identity for what is playing, in order of trust:
  // verified Edge player -> Windows media session -> none.
  function identifyMedia(status, sessions) {
    const verified = status && status.ok && status.title ? status : null;
    const playing = (Array.isArray(sessions) ? sessions : []).filter(session => session && session.status === 'Playing');
    const session = playing.find(item => sessionTitle(item)) || playing[0] || null;
    if (verified) {
      return {
        title: String(verified.title),
        artist: String(verified.artist || ''),
        source: verified.source ? String(verified.source).toUpperCase() : 'MEDIA',
        app: 'edge',
        controlled: true
      };
    }
    if (session) {
      return {
        title: sessionTitle(session) || 'MEDIA ACTIVE',
        artist: sessionArtist(session),
        source: sessionApp(session).toUpperCase() || 'MEDIA',
        app: session.appId || '',
        controlled: false
      };
    }
    return { title: '', artist: '', source: '', app: '', controlled: false };
  }

  // Pure visibility/state reducer — no DOM, unit-testable.
  // prev: { visible, mode, trackKey, lastSeenAt, dismissedKey, expanded, visual }
  // status: verified Edge player result or null.
  // audio: { linked, active } — linked means the audio stream is delivering.
  // sessions: Windows media sessions array.
  function nextOrbState(prev, status, now, config, audio, sessions) {
    const graceMs = (config && config.graceMs) || GRACE_MS;
    const state = {
      visible: Boolean(prev.visible),
      mode: prev.mode || 'idle',
      trackKey: prev.trackKey || '',
      lastSeenAt: prev.lastSeenAt || 0,
      dismissedKey: prev.dismissedKey || '',
      expanded: Boolean(prev.expanded),
      visual: prev.visual || 'idle',
      activityActive: Boolean(prev.activityActive)
    };
    const key = orbSessionKey(status);
    const liveActive = Boolean(audio && audio.linked && audio.active);
    const captureStalled = Boolean(audio && audio.stalled);
    const metadataPlaying = Boolean(status && status.ok && status.status === 'Playing');
    const list = Array.isArray(sessions) ? sessions.filter(session => session && session.appId) : [];
    // A paused session still identifies the media, so the orb stays available
    // and shows a calm paused state instead of vanishing.
    const activeSession = list.find(session => session.status === 'Playing') || list.find(session => session.status === 'Paused') || null;
    const identity = identifyMedia(status, sessions);
    void identity;
    const sessionKey = key || (activeSession ? `${sessionApp(activeSession)}:${sessionTitle(activeSession) || 'playing'}` : '') || (liveActive ? 'media:live' : '');
    if (sessionKey) {
      state.lastSeenAt = now;
      if (sessionKey !== state.trackKey) {
        state.trackKey = sessionKey;
        state.trackChangedAt = now;
        if (state.dismissedKey && state.dismissedKey !== sessionKey) state.dismissedKey = '';
      }
      state.visual = captureStalled ? 'stalled' : (liveActive ? 'live' : (audio && audio.linked ? 'silent' : 'unavailable'));
      state.activityActive = liveActive;
      state.mode = liveActive || metadataPlaying || (activeSession && activeSession.status === 'Playing') ? 'playing' : 'paused';
      state.visible = !(state.dismissedKey && state.dismissedKey === sessionKey);
      return state;
    }
    state.visual = captureStalled ? 'stalled' : (audio && audio.linked ? (liveActive ? 'live' : 'silent') : state.visual);
    state.activityActive = false;
    // Media that is still there but measured silent (paused, muted, buffering a
    // quiet intro) reads as paused: the orb dims and calms instead of pretending.
    if (!captureStalled && audio && audio.linked && !liveActive) state.mode = 'paused';
    if (state.visible && (now - (state.lastSeenAt || 0) > graceMs)) {
      state.visible = false;
      state.mode = 'idle';
      state.trackKey = '';
    }
    return state;
  }

  // Honest label for what is actually driving the visualization.
  function visualizationLabel(capture, state, sessions) {
    if (capture && capture.stalled) return { text: 'AUDIO CAPTURE · STALLED · RESTARTING', live: false };
    if (!capture || !capture.linked) {
      if (capture && capture.error) return { text: 'AUDIO CAPTURE · UNAVAILABLE', live: false };
      return { text: 'AUDIO CAPTURE · CONNECTING', live: false };
    }
    if (state && state.visual === 'stalled') return { text: 'AUDIO CAPTURE · STALLED · RESTARTING', live: false };
    if (state && state.visual === 'live') return { text: 'LIVE AUDIO · SYSTEM MIX', live: true };
    if (state && state.visual === 'silent') return { text: 'CAPTURE READY · NO SOUND', live: true };
    return { text: 'AUDIO CAPTURE · READY', live: false };
  }

  function mediaHeadline(identity, state) {
    const playing = state && state.mode === 'playing';
    const title = identity && identity.title ? identity.title : '';
    return {
      title: title || (playing ? 'MEDIA ACTIVE' : 'AUDIO IDLE'),
      artist: (identity && identity.artist) || '',
      source: (identity && identity.source) || 'MEDIA'
    };
  }

  // Stream client for /api/media/stream: NDJSON frames over fetch, with backoff
  // reconnects. Keeps smoothing/activity local so the visuals stay fluid even if
  // a frame is dropped. No second audio capture is ever started here.
  function createMediaStream(env = {}) {
    const fetchImpl = env.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    const onFrame = typeof env.onFrame === 'function' ? env.onFrame : () => {};
    const onState = typeof env.onState === 'function' ? env.onState : () => {};
    const setTimeoutImpl = env.setTimeout || setTimeout;
    const staleAfterMs = Number(env.staleAfterMs) > 0 ? Number(env.staleAfterMs) : STALE_MS;
    const client = {
      linked: false,
      stale: false,
      staleAfter: staleAfterMs,
      error: '',
      capture: { ready: false, fps: 0, sampleRate: 0 },
      sessions: [],
      metrics: emptyMetrics(),
      bars: new Array(12).fill(0),
      activity: { active: false, since: 0, candidateSince: 0, lastLoudAt: 0 },
      frames: 0,
      lastFrameAt: 0,
      bandEnergy: 0,
      closed: false,
      abort: null,
      retry: STREAM_RETRY_MS,

      // Frames stop arriving when the capture stalls. Without this the orb would
      // keep drawing its last frame — lit and "live" — forever.
      refresh(now) {
        const at = Number.isFinite(now) ? now : Date.now();
        const stale = isFrameStale(client.lastFrameAt, at, client.staleAfter);
        if (stale !== client.stale) {
          client.stale = stale;
          onState(client);
        }
        return client.stale;
      },

      handleLine(line, now) {
        const text = String(line || '').trim();
        if (!text) return;
        let payload = null;
        try { payload = JSON.parse(text); } catch { return; }
        if (!payload || typeof payload !== 'object') return;
        if (payload.type === 'hello') {
          client.linked = true;
          client.error = '';
          client.capture = { ready: Boolean(payload.capture && payload.capture.ready), fps: (payload.capture && payload.capture.fps) || 0, sampleRate: (payload.capture && payload.capture.sampleRate) || 0 };
          if (Array.isArray(payload.sessions)) client.sessions = payload.sessions;
          onState(client);
          return;
        }
        if (payload.type === 'ready') {
          client.linked = true;
          client.capture = { ready: true, fps: payload.fps || 0, sampleRate: payload.sampleRate || 0 };
          onState(client);
          return;
        }
        if (payload.type === 'capture') {
          client.capture = { ...client.capture, ready: Boolean(payload.running) };
          if (payload.error) client.error = payload.error;
          onState(client);
          return;
        }
        if (payload.type === 'sessions') {
          client.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
          onState(client);
          return;
        }
        if (payload.type === 'frame') {
          const raw = metricsFromFrame(payload);
          if (!raw) return;
          client.linked = true;
          client.stale = false;
          client.frames += 1;
          client.lastFrameAt = now;
          const waves = Math.max(4, Number(env.metrics && env.metrics.waves) || METRIC_DEFAULTS.waves);
          const sensitivity = Math.max(0.2, Number(env.metrics && env.metrics.sensitivity) || STYLE_DEFAULTS.sensitivity);
          const bars = Array.isArray(raw.bars) ? asBars(raw.bars).map(value => clamp01(value * sensitivity)) : [];
          const scaled = { ...raw, bars };
          client.metrics = smoothMetrics(client.metrics, scaled, env.metrics);
          client.bandEnergy = Math.max(client.metrics.bass, client.metrics.lowMid, client.metrics.mid, client.metrics.high);
          client.activity = updateAudioActivity(client.activity, client.metrics.level, now, env.activity, client.bandEnergy);
          client.bars = bars;
          client.peaks = client.metrics.peaks.slice();
          onFrame({ metrics: client.metrics, bars: client.bars, peaks: client.peaks, activity: client.activity, frame: payload });
        }
      },

      async open() {
        if (!fetchImpl || client.closed) return { ok: false, reason: 'unsupported' };
        try {
          client.abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const response = await fetchImpl('/api/media/stream', { cache: 'no-store', signal: client.abort ? client.abort.signal : undefined });
          if (!response.ok || !response.body || typeof response.body.getReader !== 'function') throw new Error(`stream HTTP ${response.status}`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          client.retry = STREAM_RETRY_MS;
          while (!client.closed) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let index = buffer.indexOf('\n');
            while (index >= 0) {
              client.handleLine(buffer.slice(0, index), Date.now());
              buffer = buffer.slice(index + 1);
              index = buffer.indexOf('\n');
            }
            if (buffer.length > 262144) buffer = '';
          }
          if (!client.closed) throw new Error('stream ended');
        } catch (error) {
          if (!client.closed) {
            client.linked = false;
            client.error = client.error || `Media stream disconnected (${error && error.message ? error.message : 'error'}).`;
            onState(client);
            const delay = client.retry;
            client.retry = Math.min(STREAM_RETRY_MAX_MS, Math.round(client.retry * 1.8));
            setTimeoutImpl(() => { if (!client.closed) client.open(); }, delay);
          }
          return { ok: false, reason: 'disconnected' };
        }
        return { ok: true };
      },

      close() {
        client.closed = true;
        try { if (client.abort) client.abort.abort(); } catch { }
        client.linked = false;
        client.stale = false;
      }
    };
    return client;
  }

  // A manually shown orb stays up until dismissed, even with no media driving
  // it. Pure so it stays testable: the reducer itself is untouched.
  function applyManualHold(next, manualHold, now) {
    if (manualHold && next && !next.trackKey) { next.visible = true; next.lastSeenAt = now; }
    return next;
  }

  const api = {
    nextOrbState, orbSessionKey, identifyMedia, mediaHeadline, visualizationLabel,
    smoothMetrics, updateAudioActivity, metricsFromFrame, asBars, createMediaStream,
    emptyMetrics, clamp01, sessionApp, sessionTitle, isFrameStale, spectrumAt,
    applyManualHold,
    GRACE_MS, SESSION_POLL_MS, STALE_MS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.JarvisOrbAudio = api;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const reducedMotion = () =>
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const store = {
    get(key, fallback) { try { const value = window.localStorage.getItem(key); return value == null ? fallback : value; } catch { return fallback; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch {} },
    del(key) { try { window.localStorage.removeItem(key); } catch {} }
  };

  function fmtTime(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  async function fetchStatus() {
    try {
      const response = await fetch('/api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'music-status' }), signal: AbortSignal.timeout(6000)
      });
      return await response.json().catch(() => null);
    } catch { return null; }
  }

  // Transport: Windows media session first (precise, per-app), then the system
  // media keys the server already uses for everything else.
  async function sendControl(command, app) {
    try {
      const response = await fetch('/api/media/transport', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, app: app || '' }), signal: AbortSignal.timeout(15000)
      });
      const result = await response.json().catch(() => null);
      if (result && typeof result.ok === 'boolean') return result;
      return { ok: response.ok, message: result && result.message };
    } catch { return { ok: false, message: 'The local bridge did not answer.' }; }
  }

  const MusicOrb = {
    state: {
      visible: false, mode: 'idle', trackKey: '', lastSeenAt: 0,
      dismissedKey: store.get(DISMISS_KEY, ''),
      expanded: store.get('jarvis-orb-expanded', '') === '1',
      visual: 'idle', activityActive: false
    },
    root: null, canvas: null, ctx: null, raf: 0, pollTimer: 0, tickTimer: 0, fadeTimer: 0,
    stream: null, lastStatus: null, sessions: [], identity: { title: '', artist: '', source: '', app: '' },
    manualHold: false,
    displayTime: 0, hover: false, debug: store.get(DEBUG_KEY, '') === '1', diagTimer: 0,
    peaks: new Array(12).fill(0), sparks: [], resizeTimer: 0,
    settings: Object.assign({}, STYLE_DEFAULTS, (() => { try { const saved = JSON.parse(store.get('jarvis-orb-settings', 'null') || 'null'); return saved && typeof saved === 'object' ? saved : null; } catch { return null; } })() || {}),
    floating: null, floatingMode: store.get('jarvis-orb-floating', '') === '1', floatingRAF: 0, hiddenSince: 0,

    init() {
      if (document.getElementById('musicOrb')) return;
      const root = document.createElement('div');
      root.id = 'musicOrb';
      root.className = 'music-orb';
      root.hidden = true;
      root.setAttribute('role', 'region');
      root.setAttribute('aria-label', 'Media visualizer and player');
      root.innerHTML =
        '<div class="orb-bar" id="orbBar">' +
          '<button class="orb-btn orb-expand" data-orb="expand" tabindex="-1" aria-label="Expand or collapse" title="Expand / collapse">+</button>' +
          '<button class="orb-canvas-button" data-orb="toggle" tabindex="-1" aria-label="Toggle the media panel" title="Click the orb to expand or collapse">' +
            '<canvas class="orb-canvas" id="orbCanvas" width="220" height="112" aria-hidden="true"></canvas>' +
          '</button>' +
          '<div class="orb-meta"><div class="orb-source" id="orbSource">MEDIA</div>' +
          '<div class="orb-title" id="orbTitle">No media detected</div>' +
          '<div class="orb-artist" id="orbArtist"></div>' +
          '<div class="orb-capture" id="orbCapture">AUDIO CAPTURE · CONNECTING</div></div>' +
          '<div class="orb-controls">' +
            '<button class="orb-btn" data-orb="previous" tabindex="-1" aria-label="Previous track" title="Previous">|&#9664;</button>' +
            '<button class="orb-btn orb-play" data-orb="play" tabindex="-1" aria-label="Play or pause" title="Play / pause">&#9654;</button>' +
            '<button class="orb-btn" data-orb="next" tabindex="-1" aria-label="Next track" title="Next">&#9654;|</button>' +
          '</div>' +
          '<button class="orb-btn orb-close" data-orb="close" tabindex="-1" aria-label="Dismiss" title="Dismiss">&times;</button>' +
        '</div>' +
        '<div class="orb-extra" id="orbExtra">' +
          '<div class="orb-progress"><div class="orb-progress-fill" id="orbProgressFill"></div></div>' +
          '<div class="orb-extrarow"><span class="orb-time" id="orbTime"></span>' +
          '<span class="orb-vol"><button class="orb-btn orb-mini" data-orb="voldn" tabindex="-1" aria-label="Volume down" title="System volume down">&minus;</button>' +
          '<button class="orb-btn orb-mini" data-orb="volup" tabindex="-1" aria-label="Volume up" title="System volume up">+</button>' +
          '<button class="orb-btn orb-mini" data-orb="style" tabindex="-1" aria-label="Change visualization style" title="Visualization style">SYNC</button>' +
          '<button class="orb-btn orb-mini" data-orb="settings" tabindex="-1" aria-label="Show settings" title="Settings">&#9881;</button>' +
          '<button class="orb-btn orb-mini" data-orb="diag" tabindex="-1" aria-label="Toggle diagnostics" title="Media pipeline diagnostics">DIAG</button></span></div>' +
          '<div class="orb-diag" id="orbDiag" hidden></div>' +
          '<div class="orb-settings" id="orbSettings" hidden></div>' +
        '</div>';
      document.body.appendChild(root);
      this.root = root;
      this.canvas = document.getElementById('orbCanvas');
      this.ctx = this.canvas.getContext('2d');
      this.resizeCanvas();
      root.addEventListener('click', event => {
        const button = event.target.closest('[data-orb]');
        if (!button) return;
        this.press(button.getAttribute('data-orb'));
      });
      root.addEventListener('pointerenter', () => { this.hover = true; root.dataset.hover = 'true'; });
      root.addEventListener('pointerleave', () => { this.hover = false; delete root.dataset.hover; });
      this.makeDraggable(document.getElementById('orbBar'));
      this.restorePosition();
      this.applyExpanded();
      this.stream = createMediaStream({
        onFrame: () => this.onFrame(),
        onState: () => this.onStreamState(),
        metrics: this.settings
      });
      this.stream.open();
      this.poll();
      this.pollTimer = setInterval(() => this.poll(), SESSION_POLL_MS);
      this.tickTimer = setInterval(() => this.tick(), 1000);
      if (this.debug) this.updateDiagnostics();
      window.addEventListener('pagehide', () => { this.stream?.close(); this.stopLoop(); this.stopFloatingLoop(); });
      window.addEventListener('beforeunload', () => { this.stream?.close(); this.stopLoop(); this.stopFloatingLoop(); });
      window.addEventListener('visibilitychange', () => this.onVisibilityChange());
      // The expanded stage is laid out from the panel width, so re-measure on resize.
      window.addEventListener('resize', () => {
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => { this.resizeCanvas(); this.render(false); }, 250);
      });
      this.startFloatingIfNeeded();
    },

    onVisibilityChange() {
      // Keep the orb useful when the main JARVIS window is minimized or hidden.
      // The HUD sends the orb to a compact floating strip rather than killing the
      // audio stream or the animation loop.
      if (document.hidden) {
        if (this.floatingMode && !this.floating) this.createFloating();
        if (this.floating) this.floating.hidden = false;
        this.hiddenSince = 0;
      } else {
        if (this.floating) {
          this.floating.hidden = true;
          this.stopFloatingLoop();
        }
      }
      this.render(false);
    },

    startFloatingIfNeeded() {
      if (this.floatingMode && document.hidden) this.createFloating();
    },

    createFloating() {
      if (this.floating) return;
      const root = document.createElement('div');
      root.id = 'musicOrbFloating';
      root.className = 'music-orb-floating';
      root.hidden = true;
      root.setAttribute('aria-label', 'Compact media visualizer');
      root.innerHTML =
        '<div class="orb-floating-bar" id="orbFloatingBar">' +
          '<button class="orb-floating-pin" data-floating="pin" tabindex="-1" aria-label="Pin or unpin" title="Pin or unpin">&#9837;</button>' +
          '<canvas class="orb-floating-canvas" id="orbFloatingCanvas" width="260" height="46" aria-hidden="true"></canvas>' +
          '<div class="orb-floating-meta" id="orbFloatingMeta"><span class="orb-floating-title" id="orbFloatingTitle">Media</span></div>' +
          '<button class="orb-floating-close" data-floating="close" tabindex="-1" aria-label="Close" title="Close">&times;</button>' +
        '</div>';
      document.body.appendChild(root);
      this.floating = root;
      this.floatingCanvas = document.getElementById('orbFloatingCanvas');
      this.floatingCtx = this.floatingCanvas.getContext('2d');
      this.floatingTitle = document.getElementById('orbFloatingTitle');
      root.addEventListener('click', event => {
        const button = event.target.closest('[data-floating]');
        if (!button) return;
        this.floatingPress(button.getAttribute('data-floating'));
      });
      this.makeDraggableFloating(document.getElementById('orbFloatingBar'));
      this.restoreFloatingPosition();
    },

    destroyFloating() {
      if (!this.floating) return;
      this.stopFloatingLoop();
      if (this.floating.parentNode) this.floating.parentNode.removeChild(this.floating);
      this.floating = null;
      this.floatingCanvas = null;
      this.floatingCtx = null;
      this.floatingTitle = null;
    },

    floatingPress(kind) {
      if (kind === 'close') { this.closeFloating(); return; }
      if (kind === 'pin') {
        this.floatingMode = !this.floatingMode;
        store.set('jarvis-orb-floating', this.floatingMode ? '1' : '');
        this.updateFloatingPin();
        if (this.floatingMode) this.createFloating(); else this.destroyFloating();
        return;
      }
    },

    updateFloatingPin() {
      if (!this.floating) return;
      const pin = this.floating.querySelector('[data-floating="pin"]');
      if (pin) pin.textContent = this.floatingMode ? '&#9837;' : '&#9711;';
    },

    closeFloating() {
      this.floatingMode = false;
      store.set('jarvis-orb-floating', '');
      this.destroyFloating();
    },

    startFloatingLoop() {
      if (this.floatingRAF || reducedMotion() || document.hidden) { this.drawFloatingStatic(); return; }
      const frame = () => {
        this.floatingRAF = 0;
        if (!this.floating) return;
        this.drawFloating(performance.now());
        if (!reducedMotion() && document.hidden) this.floatingRAF = requestAnimationFrame(frame);
      };
      this.floatingRAF = requestAnimationFrame(frame);
    },

    stopFloatingLoop() {
      if (this.floatingRAF) cancelAnimationFrame(this.floatingRAF);
      this.floatingRAF = 0;
    },

    // What the reducer is allowed to believe about the audio right now: a stale
    // capture is not "linked", so the orb settles instead of freezing.
    audioFlags() {
      const stream = this.stream;
      if (!stream) return { linked: false, active: false, stalled: false };
      const activity = stream.activity || null;
      return {
        linked: Boolean(stream.linked) && !stream.stale,
        active: Boolean(activity && activity.active),
        stalled: Boolean(stream.stale)
      };
    },

    // A real measured frame arrived: promote it into the state reducer and draw.
    onFrame() {
      const previous = this.state;
      const next = applyManualHold(nextOrbState(previous, this.lastStatus, Date.now(), {}, this.audioFlags(), this.stream ? this.stream.sessions : []), this.manualHold, Date.now());
      const trackChanged = next.trackKey !== previous.trackKey;
      const needsRender = trackChanged || next.visible !== previous.visible || next.mode !== previous.mode || next.visual !== previous.visual;
      this.state = next;
      if (needsRender) this.render(trackChanged);
      if (!this.raf && this.state.visible) this.startLoop();
    },

    onStreamState() {
      this.sessions = this.stream ? this.stream.sessions : [];
      const previous = this.state;
      this.state = applyManualHold(nextOrbState(previous, this.lastStatus, Date.now(), {}, this.audioFlags(), this.sessions), this.manualHold, Date.now());
      this.render(false);
      if (this.debug) this.updateDiagnostics();
    },

    restorePosition() {
      try {
        const saved = JSON.parse(store.get(POS_KEY, '') || 'null');
        if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
          this.root.style.left = `${Math.max(0, saved.left)}px`;
          this.root.style.top = `${Math.max(0, saved.top)}px`;
          this.root.style.transform = 'none';
          this.root.style.bottom = 'auto';
        }
      } catch {}
    },

    makeDraggable(handle) {
      let startX = 0, startY = 0, baseLeft = 0, baseTop = 0, dragging = false;
      handle.addEventListener('pointerdown', event => {
        if (event.target.closest('button') && !event.target.closest('[data-orb="toggle"]')) return;
        // Never start a drag on a hidden or unmeasured panel: that used to
        // persist a degenerate 0,0 position and park the orb in the corner.
        if (this.root.hidden || !this.state.visible) return;
        const rect = this.root.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        if (this.floating) return; // floating strip has its own drag below
        dragging = true;
        startX = event.clientX; startY = event.clientY;
        baseLeft = rect.left; baseTop = rect.top;
        try { handle.setPointerCapture(event.pointerId); } catch {}
      });
      handle.addEventListener('pointermove', event => {
        if (!dragging) return;
        this.root.style.transform = 'none';
        this.root.style.bottom = 'auto';
        this.root.style.left = `${Math.max(0, baseLeft + event.clientX - startX)}px`;
        this.root.style.top = `${Math.max(0, baseTop + event.clientY - startY)}px`;
      });
      const stop = () => {
        if (!dragging) return;
        dragging = false;
        const rect = this.root.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        store.set(POS_KEY, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
      };
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    },

    makeDraggableFloating(handle) {
      let startX = 0, startY = 0, baseLeft = 0, baseTop = 0, dragging = false;
      handle.addEventListener('pointerdown', event => {
        if (event.target.closest('button')) return;
        if (!this.floating || this.floating.hidden) return;
        const rect = this.floating.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        if (rect.left === 0 && rect.top === 0 && !(this.floating.style.left || this.floating.style.top)) return;
        dragging = true;
        startX = event.clientX; startY = event.clientY;
        baseLeft = rect.left; baseTop = rect.top;
        try { handle.setPointerCapture(event.pointerId); } catch {}
      });
      handle.addEventListener('pointermove', event => {
        if (!dragging || !this.floating) return;
        this.floating.style.transform = 'none';
        this.floating.style.bottom = 'auto';
        this.floating.style.left = `${Math.max(0, baseLeft + event.clientX - startX)}px`;
        this.floating.style.top = `${Math.max(0, baseTop + event.clientY - startY)}px`;
      });
      const stop = () => {
        if (!dragging) return;
        dragging = false;
        if (!this.floating) return;
        const rect = this.floating.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        store.set('jarvis-orb-floating-pos', JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
      };
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    },

    restoreFloatingPosition() {
      if (!this.floating) return;
      try {
        const saved = JSON.parse(store.get('jarvis-orb-floating-pos', '') || 'null');
        if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
          this.floating.style.left = `${Math.max(0, saved.left)}px`;
          this.floating.style.top = `${Math.max(0, saved.top)}px`;
          this.floating.style.transform = 'none';
          this.floating.style.bottom = 'auto';
        }
      } catch {}
    },

    async poll() {
      const status = await fetchStatus();
      this.lastStatus = status && status.ok ? status : null;
      const next = nextOrbState(this.state, this.lastStatus, Date.now(), {}, this.audioFlags(), this.stream ? this.stream.sessions : []);
      const trackChanged = next.trackKey !== this.state.trackKey;
      this.state = applyManualHold(next, this.manualHold, Date.now());
      this.render(trackChanged);
      if (this.debug) this.updateDiagnostics();
    },

    // Runs once a second: ages the capture stream (so a stalled capture settles
    // the orb instead of leaving it frozen mid-animation), expires the grace
    // window when media is really gone, and advances the progress readout.
    tick() {
      const stream = this.stream;
      if (stream && typeof stream.refresh === 'function') stream.refresh();
      const previous = this.state;
      const next = applyManualHold(nextOrbState(previous, this.lastStatus, Date.now(), {}, this.audioFlags(), stream ? stream.sessions : []), this.manualHold, Date.now());
      const trackChanged = next.trackKey !== previous.trackKey;
      const changed = trackChanged || next.visible !== previous.visible || next.mode !== previous.mode || next.visual !== previous.visual;
      this.state = next;
      if (changed) { this.render(trackChanged); return; }
      if (!this.state.visible || this.state.mode !== 'playing') return;
      this.displayTime += 1;
      this.renderProgress();
    },

    show(manual) {
      this.state.dismissedKey = '';
      store.del(DISMISS_KEY);
      if (manual) this.manualHold = true;
      this.state.visible = true;
      this.state.lastSeenAt = Date.now();
      if (!this.state.trackKey) this.state.mode = 'idle';
      this.render(true);
      if (manual) this.poll();
    },

    hide(manual) {
      this.state.visible = false;
      if (manual) {
        this.manualHold = false;
        this.state.dismissedKey = this.state.trackKey || '*';
        store.set(DISMISS_KEY, this.state.dismissedKey);
      }
      this.render(false);
    },

    applyExpanded() {
      if (!this.root) return;
      this.root.classList.toggle('expanded', this.state.expanded);
      const button = this.root.querySelector('[data-orb="expand"]');
      if (button) button.textContent = this.state.expanded ? '–' : '+';
    },

    async press(kind) {
      if (kind === 'close') { this.hide(true); return; }
      if (kind === 'toggle' || kind === 'expand') {
        this.state.expanded = !this.state.expanded;
        store.set('jarvis-orb-expanded', this.state.expanded ? '1' : '');
        this.applyExpanded();
        this.resizeCanvas();
        if (this.state.expanded) { this.updateDiagnostics(); this.startLoop(); }
        return;
      }
      if (kind === 'style') {
        this.cycleStyle();
        return;
      }
      if (kind === 'settings') {
        this.toggleSettings();
        return;
      }
      if (kind === 'diag') {
        this.debug = !this.debug;
        store.set(DEBUG_KEY, this.debug ? '1' : '');
        this.updateDiagnostics();
        return;
      }
      const command = { previous: 'previous', play: 'play-pause', next: 'next', voldn: 'volume-down', volup: 'volume-up' }[kind];
      if (!command) return;
      const target = this.identity && this.identity.controlled ? '' : (this.identity && this.identity.app) || '';
      const result = await sendControl(command, target);
      if (result && result.ok === false && result.message) this.notify(result.message);
      this.poll();
    },

    updateFloatingStrip() {
      if (!this.floating) return;
      if (this.floatingTitle) {
        const identity = this.identity || {};
        const mode = this.state.mode;
        const live = Boolean(this.stream && this.stream.linked);
        const stalled = Boolean(this.stream && this.stream.stale);
        if (stalled) this.floatingTitle.textContent = 'CAPTURE STALLED';
        else if (!live && this.state.visible) this.floatingTitle.textContent = 'MEDIA IDLE';
        else if (identity.title) this.floatingTitle.textContent = identity.title;
        else if (mode === 'playing' && !identity.title) this.floatingTitle.textContent = 'MEDIA ACTIVE';
        else if (mode === 'playing') this.floatingTitle.textContent = identity.title;
        else if (mode === 'paused' && identity.title) this.floatingTitle.textContent = identity.title;
        else if (mode === 'paused') this.floatingTitle.textContent = 'PAUSED';
        else this.floatingTitle.textContent = 'MEDIA';
      }
      if (this.floating) {
        this.floating.dataset.mode = this.state.mode || 'idle';
        this.floating.dataset.capture = this.stream && this.stream.stale ? 'stalled' : (this.stream && this.stream.linked ? 'live' : 'idle');
      }
    },

    renderSettings() {
      if (!this.root) return;
      let panel = this.root.querySelector('.orb-settings');
      if (!panel) {
        panel = document.createElement('div');
        panel.className = 'orb-settings';
        panel.innerHTML =
          '<div class="orb-settings-row"><span class="orb-settings-label">Style</span>' +
            '<button class="orb-settings-chip" data-settings="style" title="Cycle visualization style">' +
            this.settings.style.charAt(0).toUpperCase() + this.settings.style.slice(1) + '</button></div>' +
          '<div class="orb-settings-row"><span class="orb-settings-label">SENS</span>' +
            '<input type="range" min="0.4" max="2.2" step="0.1" value="' + Math.max(0.4, Math.min(2.2, Number(this.settings.sensitivity) || 1)) + '" data-settings="sensitivity">' +
            '<span class="orb-settings-val" id="orbSettingsSensitivity">' + (Number(this.settings.sensitivity) || 1).toFixed(1) + '</span></div>' +
          '<div class="orb-settings-row"><span class="orb-settings-label">SMOOTH</span>' +
            '<input type="range" min="0.3" max="2.2" step="0.1" value="' + Math.max(0.3, Math.min(2.2, Number(this.settings.smoothing) || 1)) + '" data-settings="smoothing">' +
            '<span class="orb-settings-val" id="orbSettingsSmoothing">' + (Number(this.settings.smoothing) || 1).toFixed(1) + '</span></div>' +
          '<div class="orb-settings-row"><span class="orb-settings-label">GLOW</span>' +
            '<input type="range" min="0" max="2.2" step="0.1" value="' + Math.max(0, Math.min(2.2, Number(this.settings.glow) || 1)) + '" data-settings="glow">' +
            '<span class="orb-settings-val" id="orbSettingsGlow">' + (Number(this.settings.glow) || 1).toFixed(1) + '</span></div>' +
          '<div class="orb-settings-row"><span class="orb-settings-label">BARS</span>' +
            '<input type="range" min="6" max="24" step="1" value="' + Math.max(6, Math.min(24, Number(this.settings.bars) || 12)) + '" data-settings="bars">' +
            '<span class="orb-settings-val" id="orbSettingsBars">' + Math.max(6, Math.min(24, Number(this.settings.bars) || 12)) + '</span></div>' +
          '<div class="orb-settings-row"><label class="orb-settings-check"><input type="checkbox" data-settings="peaks"' + (this.settings.peaks !== false ? ' checked' : '') + '><span>PEAKS</span></label></div>' +
          '<div class="orb-settings-row"><label class="orb-settings-check"><input type="checkbox" data-settings="floating"' + (this.floatingMode ? ' checked' : '') + '><span>FLOATING</span></label></div>';
        this.root.appendChild(panel);
        panel.addEventListener('input', event => {
          const target = event.target;
          const kind = target.getAttribute('data-settings');
          if (!kind) return;
          if (target.type === 'range') {
            const value = parseFloat(target.value);
            if (Number.isFinite(value)) {
              if (kind === 'sensitivity') this.settings.sensitivity = value;
              else if (kind === 'smoothing') this.settings.smoothing = value;
              else if (kind === 'glow') this.settings.glow = value;
              else if (kind === 'bars') this.settings.bars = value;
              if (kind === 'smoothing') this.stream && (this.stream.metrics = this.settings);
              this.render(false);
            }
          } else if (target.type === 'checkbox') {
            if (kind === 'peaks') { this.settings.peaks = target.checked; this.render(false); }
            else if (kind === 'floating') {
              this.floatingMode = target.checked;
              store.set('jarvis-orb-floating', this.floatingMode ? '1' : '');
              if (this.floatingMode && document.hidden && !this.floating) this.createFloating();
              if (!this.floatingMode) this.destroyFloating();
              this.updateFloatingPin();
            }
          }
        });
        panel.addEventListener('click', event => {
          const button = event.target.closest('[data-settings="style"]');
          if (button) { this.cycleStyle(); event.stopPropagation(); }
        });
      }
      panel.hidden = !this.settingsOpen;
      const sens = panel.querySelector('#orbSettingsSensitivity'); if (sens) sens.value = Math.max(0.4, Math.min(2.2, Number(this.settings.sensitivity) || 1));
      const sm = panel.querySelector('#orbSettingsSmoothing'); if (sm) sm.value = Math.max(0.3, Math.min(2.2, Number(this.settings.smoothing) || 1));
      const gl = panel.querySelector('#orbSettingsGlow'); if (gl) gl.value = Math.max(0, Math.min(2.2, Number(this.settings.glow) || 1));
      const ba = panel.querySelector('#orbSettingsBars'); if (ba) ba.value = Math.max(6, Math.min(24, Number(this.settings.bars) || 12));
      const p = panel.querySelector('[data-settings="peaks"]'); if (p) p.checked = this.settings.peaks !== false;
      const f = panel.querySelector('[data-settings="floating"]'); if (f) f.checked = this.floatingMode;
      const st = panel.querySelector('[data-settings="style"]'); if (st) st.textContent = this.settings.style.charAt(0).toUpperCase() + this.settings.style.slice(1);
    },

    cycleStyle() {
      const styles = ['spectrum', 'mirror', 'waveform', 'circular'];
      const current = styles.indexOf(this.settings.style);
      this.settings.style = styles[(current + 1) % styles.length] || 'spectrum';
      this.saveSettings();
      this.render(false);
      if (this.debug) this.updateDiagnostics();
    },

    toggleSettings() {
      this.settingsOpen = !this.settingsOpen;
      this.render(false);
      if (this.settingsOpen) this.startLoop();
    },

    saveSettings() {
      try { store.set('jarvis-orb-settings', JSON.stringify(this.settings)); } catch {}
    },

    notify(message) {
      if (!message) return;
      const el = document.getElementById('notice');
      if (!el) return;
      el.textContent = message;
      el.classList.add('show');
      clearTimeout(this.notifyTimer);
      this.notifyTimer = setTimeout(() => el.classList.remove('show'), 3600);
    },

    // Diagnostics for the whole pipeline, hidden until DIAG is pressed so the
    // normal HUD stays clean.
    updateDiagnostics() {
      const panel = document.getElementById('orbDiag');
      if (!panel) return;
      if (!this.debug) { panel.hidden = true; panel.textContent = ''; return; }
      const stream = this.stream || {};
      const status = this.lastStatus;
      const playing = (stream.sessions || []).filter(session => session && session.status === 'Playing');
      const frameAge = stream.lastFrameAt ? Date.now() - stream.lastFrameAt : null;
      const stalled = Boolean(stream.stale) || Boolean(stream.capture && stream.capture.stalled);
      const rows = [
        ['MEDIA MONITOR', stalled ? 'STALLED (RESTARTING)' : stream.linked ? 'CONNECTED' : (stream.error ? `ERROR · ${stream.error}` : 'CONNECTING')],
        ['ACTIVE MEDIA', playing.length ? `${sessionApp(playing[0])}${sessionTitle(playing[0]) ? ` · ${sessionTitle(playing[0])}` : ''}` : (status && status.ok ? 'EDGE PLAYER (CONTROLLED)' : 'NONE DETECTED')],
        ['PLAYBACK', this.state.mode === 'playing' ? 'PLAYING' : (stream.linked ? 'PAUSED / IDLE' : 'UNKNOWN')],
        ['AUDIO CAPTURE', stalled ? 'NO FRAMES' : stream.capture && stream.capture.ready ? `ACTIVE · ${stream.capture.fps || 0} FPS · ${stream.capture.sampleRate || 0} HZ` : (stream.error || 'STARTING')],
        ['FFT', stalled ? 'STALE' : stream.capture && stream.capture.ready ? 'ACTIVE' : 'WAITING'],
        ['VISUALIZER', stalled ? `STALE · LAST FRAME ${frameAge != null ? `${frameAge} MS AGO` : 'NEVER'}` : stream.frames ? `RECEIVING · ${stream.frames} FRAMES${frameAge != null ? ` · ${frameAge} MS AGO` : ''}` : 'WAITING FOR DATA'],
        ['ORB WINDOW', this.root && !this.root.hidden ? 'VISIBLE' : 'HIDDEN']
      ];
      panel.replaceChildren();
      for (const [key, value] of rows) {
        const row = document.createElement('div');
        row.className = 'orb-diag-row';
        const label = document.createElement('span');
        label.textContent = key;
        const val = document.createElement('strong');
        val.textContent = value;
        row.append(label, val);
        panel.append(row);
      }
      panel.hidden = false;
    },

    render(trackChanged) {
      if (!this.root) return;
      const state = this.state;
      const wantVisible = state.visible;
      if (wantVisible) {
        clearTimeout(this.fadeTimer); this.fadeTimer = 0;
        if (this.root.hidden) {
          this.root.hidden = false;
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => this.root.classList.add('orb-in'));
          else this.root.classList.add('orb-in');
        } else this.root.classList.add('orb-in');
      } else {
        this.root.classList.remove('orb-in');
        this.stopLoop();
        if (!this.root.hidden && !this.fadeTimer) {
          this.fadeTimer = setTimeout(() => { this.fadeTimer = 0; if (!this.state.visible) this.root.hidden = true; }, 320);
        }
      }
      this.renderStatus();
      if (!wantVisible) return;
      this.root.dataset.mode = state.mode;
      this.identity = identifyMedia(this.lastStatus, this.stream ? this.stream.sessions : []);
      const headline = mediaHeadline(this.identity, state);
      const titleEl = document.getElementById('orbTitle');
      const artistEl = document.getElementById('orbArtist');
      const sourceEl = document.getElementById('orbSource');
      if (titleEl) titleEl.textContent = headline.title;
      if (artistEl) artistEl.textContent = headline.artist;
      if (sourceEl) sourceEl.textContent = headline.source;
      const status = this.lastStatus;
      const hasTransport = Boolean((status && status.ok && status.verified) || (this.stream && this.stream.sessions.find(session => session && session.status === 'Playing')));
      for (const kind of ['previous', 'play', 'next']) {
        const button = this.root.querySelector(`[data-orb="${kind}"]`);
        if (!button) continue;
        button.disabled = false; // media keys reach any player, so controls stay usable
        button.classList.toggle('orb-verified', hasTransport);
        button.title = hasTransport
          ? `${kind === 'play' ? 'Play / pause' : kind === 'previous' ? 'Previous' : 'Next'} (acts on ${sessionApp((this.stream.sessions.find(session => session && session.status === 'Playing')) || {}) || 'the verified player'})`
          : `${kind === 'play' ? 'Play / pause' : kind === 'previous' ? 'Previous' : 'Next'} (sent to the active Windows media session)`;
      }
      const playBtn = this.root.querySelector('[data-orb="play"]');
      if (playBtn) playBtn.innerHTML = state.mode === 'playing' ? '&#10074;&#10074;' : '&#9654;';
      if (status && typeof status.time === 'number') this.displayTime = status.time;
      if (trackChanged) {
        this.root.classList.remove('track-change');
        void this.root.offsetWidth;
        this.root.classList.add('track-change');
      }
      this.renderProgress();
      this.ensureCanvasSize();
      if (this.debug) this.updateDiagnostics();
      if (!reducedMotion() && !document.hidden) this.startLoop(); else this.drawStatic();
    },

    renderStatus() {
      const badge = document.getElementById('orbCapture');
      const label = visualizationLabel(this.stream, this.state, this.sessions);
      if (badge) {
        badge.textContent = label.text;
        badge.classList.toggle('live', label.live);
        badge.classList.toggle('stalled', Boolean(this.stream && this.stream.stale) || this.state.visual === 'stalled');
      }
      if (this.root) this.root.dataset.capture = this.state.visual;
    },

    renderProgress() {
      const fill = document.getElementById('orbProgressFill');
      const timeEl = document.getElementById('orbTime');
      if (!fill || !timeEl) return;
      const status = this.lastStatus;
      const duration = status && typeof status.duration === 'number' && status.duration > 0 ? status.duration : 0;
      if (duration > 0) {
        const clamped = Math.max(0, Math.min(this.displayTime, duration));
        fill.style.width = `${(clamped / duration) * 100}%`;
        timeEl.textContent = `${fmtTime(clamped)} / ${fmtTime(duration)}`;
      } else {
        fill.style.width = '0%';
        timeEl.textContent = this.state.mode === 'playing' ? 'LIVE' : '';
      }
    },

    startLoop() {
      if (this.raf || reducedMotion() || document.hidden) { this.drawStatic(); return; }
      const frame = () => {
        this.raf = 0;
        if (!this.state.visible) return;
        this.draw(performance.now());
        if (!reducedMotion() && !document.hidden) this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
    },

    stopLoop() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    },

    drawStatic() { this.draw(0, true); },

    // Canvas backing store. Compact bubble by default; the expanded panel becomes
    // a full-width holographic stage. Matched to the real laid-out size and only
    // reallocated when that size actually changes, so the one animation loop
    // stays cheap (measured: ~0.6 ms per frame at stage size).
    ensureCanvasSize() {
      const canvas = this.canvas;
      if (!canvas || !this.root) return;
      const density = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      // The compact backing size is fixed, so it must apply even while the panel
      // is hidden — otherwise the bubble keeps the stage-sized canvas and draws
      // the large layout squeezed into a 130 px bubble.
      let width = 260, height = 148;
      if (this.state.expanded) {
        const stage = this.root.querySelector('.orb-canvas-button');
        const measured = Math.round((stage && stage.clientWidth) || this.root.clientWidth || 0);
        if (!measured) return; // not laid out yet: keep the current backing store
        width = Math.min(1200, Math.round(Math.max(320, measured) * density));
        height = Math.round(220 * density);
      }
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      this.peaks = new Array(12).fill(0);
      this.sparks = [];
    },

    ensureFloatingCanvasSize() {
      const canvas = this.floatingCanvas;
      if (!canvas) return;
      const density = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const width = Math.round(260 * density);
      const height = Math.round(46 * density);
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
    },

    drawFloating(t) {
      this.ensureFloatingCanvasSize();
      const ctx = this.floatingCtx;
      if (!ctx) return;
      const W = this.floatingCanvas.width, H = this.floatingCanvas.height;
      ctx.clearRect(0, 0, W, H);
      const stream = this.stream;
      const live = Boolean(stream && stream.linked && stream.frames && !stream.stale);
      const metrics = stream && stream.metrics ? stream.metrics : emptyMetrics();
      const bars = stream && stream.bars ? stream.bars : new Array(12).fill(0);
      const peaks = stream && stream.peaks ? stream.peaks : new Array(12).fill(0);
      const level = clamp01(metrics.level), bass = clamp01(metrics.bass), lowMid = clamp01(metrics.lowMid);
      const mid = clamp01(metrics.mid), high = clamp01(metrics.high), pulse = clamp01(metrics.pulse);
      const intensity = Math.pow(level, 0.55);
      const dynamics = 0.2 + 0.8 * intensity;
      const hoverBoost = 1;
      const waves = Math.max(4, Number(this.settings && this.settings.bars) || 12);
      const sensitivity = Math.max(0.2, Number(this.settings && this.settings.sensitivity) || 1);
      const glow = Math.max(0.2, Number(this.settings && this.settings.glow) || 1);
      const showPeaks = Boolean(this.settings && this.settings.peaks !== false);
      // Lay the measured spectrum into 12 design buckets so the UI stays stable.
      const designBars = new Array(12).fill(0);
      const designPeaks = new Array(12).fill(0);
      for (let index = 0; index < bars.length; index++) {
        const designIndex = Math.round((index / (bars.length - 1 || 1)) * 11);
        designBars[designIndex] = Math.max(designBars[designIndex], bars[index]);
        designPeaks[designIndex] = Math.max(designPeaks[designIndex], peaks[index]);
      }
      this.drawFloatingBars(ctx, W, H, designBars, designPeaks, { level, bass, lowMid, mid, high, pulse, intensity, dynamics, live, hoverBoost, sensitivity, glow, showPeaks });
    },

    drawFloatingBars(ctx, W, H, bars, peaks, m) {
      const { level, bass, lowMid, mid, high, pulse, intensity, dynamics, live, hoverBoost, sensitivity, glow, showPeaks } = m;
      const baseX = 10, barAreaW = W - 20, barCount = bars.length || 1;
      const spacing = barAreaW / (barCount - 1 || 1);
      const maxH = Math.round((H * 0.52) / (window.devicePixelRatio || 1));
      const baseY = H - (maxH / (window.devicePixelRatio || 1)) - 4;
      // Background strip.
      const strip = ctx.createLinearGradient(0, 0, 0, H);
      strip.addColorStop(0, 'rgba(8,20,30,0.55)');
      strip.addColorStop(1, 'rgba(4,10,16,0.62)');
      ctx.fillStyle = strip;
      ctx.beginPath(); ctx.roundRect(0, 0, W, H, 6); ctx.fill();
      // Center glow that breathes with level.
      const aura = ctx.createRadialGradient(W / 2, H / 2, 2, W / 2, H / 2, W * 0.45);
      aura.addColorStop(0, `rgba(86,233,255,${(0.06 + 0.12 * intensity * glow).toFixed(3)})`);
      aura.addColorStop(1, 'rgba(86,233,255,0)');
      ctx.fillStyle = aura;
      ctx.beginPath(); ctx.arc(W / 2, H / 2, W * 0.45, 0, Math.PI * 2); ctx.fill();
      // Bars with per-band blue shading.
      for (let index = 0; index < barCount; index++) {
        const value = clamp01(bars[index]);
        const peak = clamp01(peaks[index]);
        const scaler = live ? (0.25 + 0.75 * intensity) * (1 + (bass > 0.4 ? 0.2 : 0)) : 0.12;
        const height = Math.max(2, maxH * value * scaler) / (window.devicePixelRatio || 1);
        const width = Math.max(2, Math.min(8, spacing * 0.55) / (window.devicePixelRatio || 1));
        const x = baseX + index * spacing / (window.devicePixelRatio || 1) - width / 2;
        const band = index < 3 ? 'bass' : index < 6 ? 'mid' : 'high';
        const color = band === 'bass' ? `rgba(25,169,228,0.95)` : (band === 'mid' ? `rgba(86,233,255,0.95)` : `rgba(232,253,255,0.9)`);
        const glowColor = band === 'bass' ? 'rgba(25,169,228,0.5)' : (band === 'mid' ? 'rgba(86,233,255,0.55)' : 'rgba(232,253,255,0.6)');
        const grad = ctx.createLinearGradient(0, baseY, 0, baseY - maxH);
        grad.addColorStop(0, color);
        grad.addColorStop(0.6, band === 'high' ? 'rgba(190,250,255,0.95)' : color);
        grad.addColorStop(1, band === 'bass' ? 'rgba(25,169,228,0.9)' : 'rgba(232,253,255,0.92)');
        ctx.fillStyle = grad;
        if (height > 3) { ctx.shadowColor = glowColor; ctx.shadowBlur = Math.min(10, height * 0.6) * glow; }
        ctx.fillRect(x, baseY - height, width, height);
        ctx.shadowBlur = 0;
        if (showPeaks && peak > 0.04) {
          const capY = baseY - Math.max(3, maxH * peak * scaler) / (window.devicePixelRatio || 1);
          ctx.fillStyle = 'rgba(67,233,196,0.85)';
          ctx.fillRect(x - 0.5 / (window.devicePixelRatio || 1), capY - 1 / (window.devicePixelRatio || 1), width + 1 / (window.devicePixelRatio || 1), 2 / (window.devicePixelRatio || 1));
        }
      }
      // Level glow line.
      if (live && level > 0.01) {
        ctx.save();
        ctx.fillStyle = `rgba(86,233,255,${(0.06 + 0.12 * level * glow).toFixed(3)})`;
        ctx.fillRect(0, 0, W, 2 / (window.devicePixelRatio || 1));
        ctx.restore();
      }
      // Transient pulse.
      if (pulse > 0.04) {
        ctx.save();
        ctx.strokeStyle = `rgba(232,253,255,${(0.5 * pulse * glow).toFixed(3)})`;
        ctx.lineWidth = Math.max(1, 2 / (window.devicePixelRatio || 1));
        ctx.beginPath(); ctx.arc(W / 2, H / 2, W * 0.22, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    },

    drawFloatingStatic() { this.drawFloating(0); },

    resizeCanvas() { this.ensureCanvasSize(); },

    draw(t, frozen) {
      const ctx = this.ctx;
      if (!ctx) return;
      const style = this.settings && this.settings.style || 'spectrum';
      if (style === 'spectrum') return this.drawSpectrum(t, frozen);
      if (style === 'mirror') return this.drawMirror(t, frozen);
      if (style === 'waveform') return this.drawWaveform(t, frozen);
      if (style === 'circular') return this.drawCircular(t, frozen);
      return this.drawSpectrum(t, frozen);
    },

    drawSpectrum(t, frozen) {
      this.drawOrbShell(t, frozen);
      this.drawBars(t, frozen, 'spectrum');
      this.drawOrbOverlay(t, frozen);
    },

    drawMirror(t, frozen) {
      this.drawOrbShell(t, frozen);
      this.drawBars(t, frozen, 'mirror');
      this.drawOrbOverlay(t, frozen);
    },

    drawWaveform(t, frozen) {
      this.drawOrbShell(t, frozen);
      this.drawBars(t, frozen, 'waveform');
      this.drawOrbOverlay(t, frozen);
    },

    drawCircular(t, frozen) {
      this.drawOrbShell(t, frozen);
      this.drawBars(t, frozen, 'circular');
      this.drawOrbOverlay(t, frozen);
    },

    drawOrbShell(t, frozen) {
      const ctx = this.ctx;
      if (!ctx) return;
      const W = this.canvas.width, H = this.canvas.height;
      const stream = this.stream;
      const live = Boolean(stream && stream.linked && stream.frames && !stream.stale);
      const metrics = live ? stream.metrics : emptyMetrics();
      const level = clamp01(metrics.level), bass = clamp01(metrics.bass), lowMid = clamp01(metrics.lowMid);
      const mid = clamp01(metrics.mid), high = clamp01(metrics.high), pulse = clamp01(metrics.pulse);
      const intensity = Math.pow(level, 0.6);
      const dynamics = 0.22 + 0.78 * intensity;
      const phase = frozen ? 0 : t;
      const hoverBoost = this.hover ? 1.06 : 1;
      const large = W > 460;
      const cx = large ? Math.round(W * 0.31) : Math.round(W * 0.245);
      const cy = large ? Math.round(H * 0.47) : Math.round(H / 2);
      const base = large ? Math.min(H * 0.2, 74) : Math.min(H * 0.185, 27);
      const coreR = base * (0.62 + 0.42 * intensity) * hoverBoost;
      const ringR = base * (1.02 + 0.1 * bass * dynamics);
      const glow = Math.max(0.2, Number(this.settings && this.settings.glow) || 1);
      // backdrop
      if (large) {
        ctx.save();
        ctx.strokeStyle = 'rgba(43,120,146,0.3)';
        ctx.lineWidth = 1;
        for (let step = 1; step <= 4; step++) {
          ctx.beginPath();
          ctx.arc(cx, cy, ringR + base * 0.62 * step, -Math.PI * 0.78, Math.PI * 0.78);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(43,120,146,0.22)';
        for (let index = 0; index < 36; index++) {
          const angle = (index / 36) * Math.PI * 2;
          const inner = ringR + base * 2.5, outer = inner + (index % 3 === 0 ? base * 0.16 : base * 0.07);
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
          ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
          ctx.stroke();
        }
        ctx.restore();
      }
      // outer aura
      const auraR = base * (1.95 + 0.75 * intensity);
      const aura = ctx.createRadialGradient(cx, cy, coreR * 0.35, cx, cy, auraR);
      aura.addColorStop(0, `rgba(86,233,255,${(0.15 + 0.22 * intensity * glow).toFixed(3)})`);
      aura.addColorStop(0.6, `rgba(52,200,240,${(0.05 + 0.1 * lowMid * glow).toFixed(3)})`);
      aura.addColorStop(1, 'rgba(25,169,228,0)');
      ctx.fillStyle = aura;
      ctx.beginPath(); ctx.arc(cx, cy, auraR, 0, Math.PI * 2); ctx.fill();
      // sphere body
      const core = ctx.createRadialGradient(cx - coreR * 0.3, cy - coreR * 0.34, coreR * 0.04, cx, cy, coreR);
      core.addColorStop(0, 'rgba(232,253,255,0.98)');
      core.addColorStop(0.32, `rgba(126,241,255,${(0.5 + 0.38 * intensity * glow).toFixed(3)})`);
      core.addColorStop(0.7, `rgba(52,200,240,${(0.32 + 0.42 * intensity * glow).toFixed(3)})`);
      core.addColorStop(1, 'rgba(19,120,180,0.06)');
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();
      // rim
      ctx.save();
      ctx.strokeStyle = `rgba(190,250,255,${(0.24 + 0.5 * intensity * glow).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, base * 0.022) + base * 0.03 * lowMid * dynamics;
      ctx.shadowColor = 'rgba(86,233,255,0.6)';
      ctx.shadowBlur = base * 0.12 * glow;
      ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      // internal filaments
      ctx.save();
      ctx.globalAlpha = 0.28 + 0.5 * Math.min(1, Math.max(bass, lowMid) * 1.3);
      const filaments = large ? 5 : 3;
      for (let index = 0; index < filaments; index++) {
        const radius = coreR * (0.34 + 0.15 * index);
        const angle = phase * (0.00022 + 0.0009 * high) * (2.4 + index * 0.6) + index * 1.7;
        ctx.strokeStyle = index % 2 ? 'rgba(67,233,196,0.65)' : 'rgba(121,240,255,0.7)';
        ctx.lineWidth = Math.max(1, base * 0.02);
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(angle) * coreR * 0.08, cy + Math.sin(angle) * coreR * 0.08, radius, radius * (0.72 + 0.18 * mid), angle / 2.6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
      // plasma arcs
      const arcCount = Math.round(6 + 24 * mid);
      ctx.save();
      ctx.lineWidth = Math.max(0.8, base * 0.016);
      for (let index = 0; index < arcCount; index++) {
        const a0 = (index / arcCount) * Math.PI * 2 + phase * (0.00022 + 0.0009 * high) * 3.1;
        const radius = coreR * (0.52 + 0.42 * ((index % 5) / 5));
        ctx.strokeStyle = index % 3 === 0
          ? `rgba(232,253,255,${(0.16 + 0.42 * mid * glow).toFixed(3)})`
          : `rgba(86,233,255,${(0.1 + 0.36 * lowMid * glow).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(cx, cy, radius, a0, a0 + 0.16 + 0.5 * mid); ctx.stroke();
      }
      ctx.restore();
      // bass ring
      ctx.save();
      ctx.strokeStyle = `rgba(86,233,255,${(0.26 + 0.5 * intensity * glow).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, base * 0.03) + base * 0.05 * lowMid * dynamics;
      ctx.shadowColor = 'rgba(86,233,255,0.5)';
      ctx.shadowBlur = base * 0.1 * glow;
      const wobble = base * 0.05 * bass * dynamics;
      ctx.beginPath();
      for (let index = 0; index <= 72; index++) {
        const angle = (index / 72) * Math.PI * 2;
        const radius = ringR + Math.sin(angle * 6 + phase * (0.00022 + 0.0009 * high) * 8) * wobble;
        const x = cx + Math.cos(angle) * radius, y = cy + Math.sin(angle) * radius;
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
      // mid ring
      ctx.save();
      ctx.strokeStyle = `rgba(67,233,196,${(0.18 + 0.5 * mid * glow).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, base * 0.022) + base * 0.02 * mid;
      ctx.setLineDash([Math.max(1.5, base * 0.045), Math.max(3, base * 0.14)]);
      ctx.lineDashOffset = live ? -phase * (0.00022 + 0.0009 * high) * base * 12 : 0;
      ctx.beginPath(); ctx.arc(cx, cy, ringR + base * 0.32 + base * 0.05 * mid * dynamics, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      // high ring
      ctx.save();
      ctx.strokeStyle = `rgba(190,250,255,${(0.1 + 0.5 * high * glow).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.8, base * 0.014);
      ctx.setLineDash([Math.max(0.8, base * 0.012), Math.max(2, base * 0.05)]);
      ctx.lineDashOffset = live ? phase * (0.00022 + 0.0009 * high) * base * 26 : 0;
      ctx.beginPath(); ctx.arc(cx, cy, ringR + base * 0.58 + base * 0.04 * high * dynamics, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    },

    drawBars(t, frozen, style) {
      const ctx = this.ctx;
      if (!ctx) return;
      const W = this.canvas.width, H = this.canvas.height;
      const stream = this.stream;
      const live = Boolean(stream && stream.linked && stream.frames && !stream.stale);
      const metrics = live ? stream.metrics : emptyMetrics();
      const level = clamp01(metrics.level), bass = clamp01(metrics.bass), lowMid = clamp01(metrics.lowMid);
      const mid = clamp01(metrics.mid), high = clamp01(metrics.high), pulse = clamp01(metrics.pulse);
      const intensity = Math.pow(level, 0.6);
      const dynamics = 0.22 + 0.78 * intensity;
      const glow = Math.max(0.2, Number(this.settings && this.settings.glow) || 1);
      const bars = live ? stream.bars : new Array(12).fill(0);
      const peaks = live ? stream.peaks : new Array(12).fill(0);
      const large = W > 460;
      const cx = large ? Math.round(W * 0.31) : Math.round(W * 0.245);
      const cy = large ? Math.round(H * 0.47) : Math.round(H / 2);
      const base = large ? Math.min(H * 0.2, 74) : Math.min(H * 0.185, 27);
      const waves = Math.max(4, Number(this.settings && this.settings.bars) || 12);
      const bands = Math.max(4, Math.min(24, waves));
      const interBars = new Array(bands).fill(0);
      for (let index = 0; index < bands; index++) {
        const position = index / (bands - 1 || 1);
        interBars[index] = spectrumAt(bars, position);
      }
      const interPeaks = new Array(bands).fill(0);
      for (let index = 0; index < bands; index++) {
        interPeaks[index] = spectrumAt(peaks, index / (bands - 1 || 1));
      }
      const showPeaks = Boolean(this.settings && this.settings.peaks !== false);
      if (style === 'circular') {
        this.drawCircularBars(ctx, W, H, interBars, interPeaks, { level, bass, lowMid, mid, high, pulse, intensity, dynamics, live, glow, showPeaks, base, cx, cy, large });
        return;
      }
      const startX = large ? 84 : 148;
      const endX = large ? W - 96 : W - 14;
      const barBaseY = large ? H - 46 : H - 24;
      const maxH = large ? H * 0.3 : H * 0.6;
      const maxWidth = large ? 30 : 9;
      if (style === 'mirror') {
        this.drawMirrorBars(ctx, W, H, interBars, interPeaks, { level, bass, lowMid, mid, high, pulse, intensity, dynamics, live, glow, showPeaks, base, cx, cy, large, startX, endX, barBaseY, maxH, maxWidth });
      } else if (style === 'waveform') {
        this.drawWaveformBars(ctx, W, H, interBars, interPeaks, { level, bass, lowMid, mid, high, pulse, intensity, dynamics, live, glow, showPeaks, base, cx, cy, large, startX, endX, barBaseY, maxH, maxWidth });
      } else {
        this.drawLinearBars(ctx, W, H, interBars, interPeaks, { level, bass, lowMid, mid, high, pulse, intensity, dynamics, live, glow, showPeaks, base, cx, cy, large, startX, endX, barBaseY, maxH, maxWidth });
      }
    },

    bandColor(bandIndex, value, glow) {
      const w = bandsCount();
      const section = w <= 8 ? (bandIndex < Math.ceil(w / 3) ? 'bass' : bandIndex < Math.ceil(w * 2 / 3) ? 'mid' : 'high') : (bandIndex < Math.round(w * 0.25) ? 'bass' : bandIndex < Math.round(w * 0.6) ? 'mid' : 'high');
      if (section === 'bass') return `rgba(25,169,228,${(0.85 + 0.15 * value * glow).toFixed(3)})`;
      if (section === 'mid') return `rgba(86,233,255,${(0.85 + 0.15 * value * glow).toFixed(3)})`;
      return `rgba(232,253,255,${(0.85 + 0.15 * value * glow).toFixed(3)})`;
    },

    bandGlowColor(bandIndex, glow) {
      const w = bandsCount();
      const section = w <= 8 ? (bandIndex < Math.ceil(w / 3) ? 'bass' : bandIndex < Math.ceil(w * 2 / 3) ? 'mid' : 'high') : (bandIndex < Math.round(w * 0.25) ? 'bass' : bandIndex < Math.round(w * 0.6) ? 'mid' : 'high');
      if (section === 'bass') return 'rgba(25,169,228,0.5)';
      if (section === 'mid') return 'rgba(86,233,255,0.55)';
      return 'rgba(232,253,255,0.6)';
    },

    bandsCount() {
      return Math.max(4, Number(this.settings && this.settings.bars) || 12);
    },

    drawLinearBars(ctx, W, H, bars, peaks, m) {
      const { level, bass, lowMid, mid, high, pulse, intensity, dynamics, live, glow, showPeaks, base, cx, cy, large, startX, endX, barBaseY, maxH, maxWidth } = m;
      const spacing = (endX - startX) / (bars.length - 1 || 1);
      for (let index = 0; index < bars.length; index++) {
        const value = clamp01(bars[index]);
        const scaler = live ? (0.3 + 0.7 * intensity) * (bass > 0.4 && index < 3 ? 1.15 : 1) : 0.12;
        const height = Math.max(2, maxH * value * scaler);
        const width = Math.max(2, Math.min(maxWidth, spacing * 0.44));
        const x = startX + index * spacing - width / 2;
        const color = this.bandColor(index, value, glow);
        const glowColor = this.bandGlowColor(index, glow);
        const grad = ctx.createLinearGradient(0, barBaseY, 0, barBaseY - maxH);
        grad.addColorStop(0, color);
        grad.addColorStop(0.6, color);
        grad.addColorStop(1, 'rgba(232,253,255,0.92)');
        ctx.fillStyle = grad;
        if (height > 4) { ctx.shadowColor = glowColor; ctx.shadowBlur = Math.min(14, height * 0.5) * glow; }
        ctx.fillRect(x, barBaseY - height, width, height);
        ctx.shadowBlur = 0;
        const peak = clamp01(peaks[index]);
        if (showPeaks && peak > 0.03) {
          const capY = barBaseY - Math.max(3, maxH * peak * scaler);
          ctx.fillStyle = 'rgba(67,233,196,0.9)';
          ctx.fillRect(x - 1, capY - 2, width + 2, 2.4);
        }
        ctx.fillStyle = 'rgba(86,233,255,0.32)';
        ctx.fillRect(x, barBaseY + 1.5, width, 1.4);
      }
    },

    drawMirrorBars(ctx, W, H, bars, peaks, m) {
      const { level, bass, lowMid, mid, high, pulse, intensity, dynamics, live, glow, showPeaks, base, cx, cy, large, startX, endX, barBaseY, maxH, maxWidth } = m;
      const center = (startX + endX) / 2;
      const halfSpan = (endX - startX) / 2;
      const spacing = (halfSpan - startX) / (Math.ceil(bars.length / 2) - 1 || 1);
      for (let index = 0; index < bars.length; index++) {
        const value = clamp01(bars[index]);
        const scaler = live ? (0.3 + 0.7 * intensity) : 0.12;
        const height = Math.max(2, maxH * value * scaler);
        const width = Math.max(2, Math.min(maxWidth, spacing * 0.44));
        const isLeft = index % 2 === 0;
        const localIndex = isLeft ? Math.floor(index / 2) : Math.floor((index - 1) / 2);
        const x = center + (isLeft ? -1 : 1) * localIndex * spacing;
        const color = this.bandColor(index, value, glow);
        const glowColor = this.bandGlowColor(index, glow);
        const grad = ctx.createLinearGradient(0, barBaseY, 0, barBaseY - maxH);
        grad.addColorStop(0, color);
        grad.addColorStop(0.6, color);
        grad.addColorStop(1, 'rgba(232,253,255,0.92)');
        ctx.fillStyle = grad;
        if (height > 4) { ctx.shadowColor = glowColor; ctx.shadowBlur = Math.min(14, height * 0.5) * glow; }
        ctx.fillRect(x, barBaseY - height, width, height);
        ctx.shadowBlur = 0;
        const peak = clamp01(peaks[index]);
        if (showPeaks && peak > 0.03) {
          const capY = barBaseY - Math.max(3, maxH * peak * scaler);
          ctx.fillStyle = 'rgba(67,233,196,0.9)';
          ctx.fillRect(x - 1, capY - 2, width + 2, 2.4);
        }
      }
    },

    drawWaveformBars(ctx, W, H, bars, peaks, m) {
      const { level, bass, lowMid, mid, high, pulse, intensity, dynamics, live, glow, showPeaks, base, cx, cy, large, startX, endX, barBaseY, maxH, maxWidth } = m;
      const spacing = (endX - startX) / (bars.length - 1 || 1);
      const topBaseY = barBaseY - maxH * (live ? (0.4 + 0.4 * intensity) : 0.12);
      for (let index = 0; index < bars.length; index++) {
        const value = clamp01(bars[index]);
        const scaler = live ? (0.25 + 0.75 * intensity) : 0.12;
        const halfH = Math.max(2, maxH * value * scaler / 2);
        const width = Math.max(2, Math.min(maxWidth * 1.6, spacing * 0.6));
        const x = startX + index * spacing - width / 2;
        const color = this.bandColor(index, value, glow);
        const glowColor = this.bandGlowColor(index, glow);
        const grad = ctx.createLinearGradient(0, barBaseY, 0, topBaseY);
        grad.addColorStop(0, 'rgba(10,30,46,0.6)');
        grad.addColorStop(0.5, color);
        grad.addColorStop(1, 'rgba(232,253,255,0.92)');
        ctx.fillStyle = grad;
        if (halfH > 4) { ctx.shadowColor = glowColor; ctx.shadowBlur = Math.min(14, halfH * 0.5) * glow; }
        ctx.fillRect(x, barBaseY - halfH, width, halfH * 2);
        ctx.shadowBlur = 0;
        const peak = clamp01(peaks[index]);
        if (showPeaks && peak > 0.03) {
          const capY = barBaseY - Math.max(3, maxH * peak * scaler);
          ctx.fillStyle = 'rgba(67,233,196,0.9)';
          ctx.fillRect(x - 1, capY - 2, width + 2, 2.4);
        }
      }
    },

    drawCircularBars(ctx, W, H, bars, peaks, m) {
      const { level, bass, lowMid, mid, high, pulse, intensity, dynamics, live, glow, showPeaks, base, cx, cy, large } = m;
      const count = bars.length || 1;
      const orbitBase = base * 1.7;
      const innerR = base * 0.5;
      for (let index = 0; index < count; index++) {
        const value = clamp01(bars[index]);
        const scaler = live ? (0.25 + 0.75 * intensity) : 0.12;
        const height = Math.max(2, base * 0.5 * value * scaler);
        const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
        const r = orbitBase + base * 0.1 + (large ? base * 0.4 : base * 0.2) * value;
        const x1 = cx + Math.cos(angle) * (r - height / 2);
        const y1 = cy + Math.sin(angle) * (r - height / 2);
        const x2 = cx + Math.cos(angle) * (r + height / 2);
        const y2 = cy + Math.sin(angle) * (r + height / 2);
        const color = this.bandColor(index, value, glow);
        const glowColor = this.bandGlowColor(index, glow);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ctx.fillStyle = color;
        if (height > 3) { ctx.shadowColor = glowColor; ctx.shadowBlur = Math.min(10, height * 0.5) * glow; }
        ctx.fillRect(-height / 2, -1.5, height, 3);
        ctx.shadowBlur = 0;
        ctx.restore();
        const peak = clamp01(peaks[index]);
        if (showPeaks && peak > 0.03) {
          const capR = r + height / 2 + peak * base * 0.4;
          const capX = cx + Math.cos(angle) * capR, capY = cy + Math.sin(angle) * capR;
          ctx.fillStyle = 'rgba(67,233,196,0.9)';
          ctx.beginPath(); ctx.arc(capX, capY, Math.max(1.5, base * 0.03), 0, Math.PI * 2); ctx.fill();
        }
      }
    },

    drawOrbOverlay(t, frozen) {
      const ctx = this.ctx;
      if (!ctx) return;
      const W = this.canvas.width, H = this.canvas.height;
      const stream = this.stream;
      const live = Boolean(stream && stream.linked && stream.frames && !stream.stale);
      const metrics = live ? stream.metrics : emptyMetrics();
      const level = clamp01(metrics.level), bass = clamp01(metrics.bass), lowMid = clamp01(metrics.lowMid);
      const mid = clamp01(metrics.mid), high = clamp01(metrics.high), pulse = clamp01(metrics.pulse);
      const intensity = Math.pow(level, 0.6);
      const dynamics = 0.22 + 0.78 * intensity;
      const phase = frozen ? 0 : t;
      const hoverBoost = this.hover ? 1.06 : 1;
      const large = W > 460;
      const base = large ? Math.min(H * 0.2, 74) : Math.min(H * 0.185, 27);
      if (large) {
        // smoothed spectrum line across the same measured buckets
        ctx.save();
        ctx.strokeStyle = 'rgba(190,250,255,0.5)';
        ctx.lineWidth = Math.max(1, base * 0.02);
        ctx.beginPath();
        for (let step = 0; step <= 120; step++) {
          const position = step / 120;
          const value = spectrumAt(stream && stream.bars ? stream.bars : new Array(12).fill(0), position);
          const x = 84 + position * (W - 96 - 84);
          const y = H - 46 - Math.max(2, H * 0.3 * value * (live ? dynamics : 0.12));
          if (step === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
        // level gauge
        ctx.save();
        const gaugeX = W - 52, gaugeY = 54, gaugeR = Math.max(18, base * 0.6);
        ctx.strokeStyle = 'rgba(43,120,146,0.55)';
        ctx.lineWidth = Math.max(2, base * 0.05);
        ctx.beginPath(); ctx.arc(gaugeX, gaugeY, gaugeR, Math.PI * 0.75, Math.PI * 2.25); ctx.stroke();
        ctx.strokeStyle = 'rgba(86,233,255,0.95)';
        ctx.beginPath(); ctx.arc(gaugeX, gaugeY, gaugeR, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * clamp01(level)); ctx.stroke();
        ctx.fillStyle = 'rgba(190,250,255,0.7)';
        ctx.font = `${Math.round(base * 0.3)}px Consolas, monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('LEVEL', gaugeX, gaugeY + gaugeR + base * 0.44);
        ctx.restore();
        // band labels
        ctx.save();
        ctx.fillStyle = 'rgba(97,187,207,0.75)';
        ctx.font = `${Math.round(base * 0.22)}px Consolas, monospace`;
        ctx.textAlign = 'left'; ctx.fillText('LOW', 84, H - 16);
        ctx.textAlign = 'center'; ctx.fillText('MID', (84 + W - 96) / 2, H - 16);
        ctx.textAlign = 'right'; ctx.fillText('HIGH', W - 96, H - 16);
        ctx.restore();
        this.drawSpectrumBars();
      } else {
        this.drawSpectrumBars();
      }
      // sparks
      const sparks = this.updateSparks(live ? pulse : 0);
      if (sparks.length) {
        ctx.save();
        for (const spark of sparks) {
          const radius = base * 1.2 + base * spark.radius + base * 0.5;
          const x = (large ? Math.round(W * 0.31) : Math.round(W * 0.245)) + Math.cos(spark.angle) * radius;
          const y = (large ? Math.round(H * 0.47) : Math.round(H / 2)) + Math.sin(spark.angle) * radius * 0.94;
          ctx.strokeStyle = `rgba(232,253,255,${(0.6 * spark.life).toFixed(3)})`;
          ctx.lineWidth = Math.max(0.8, base * 0.015);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(spark.angle) * base * 0.16 * spark.speed, y + Math.sin(spark.angle) * base * 0.16 * spark.speed);
          ctx.stroke();
        }
        ctx.restore();
      }
      // transient flash
      if (pulse > 0.04) {
        ctx.save();
        ctx.strokeStyle = `rgba(232,253,255,${(0.7 * pulse).toFixed(3)})`;
        ctx.lineWidth = Math.max(1, base * 0.04);
        ctx.beginPath(); ctx.arc((large ? Math.round(W * 0.31) : Math.round(W * 0.245)), (large ? Math.round(H * 0.47) : Math.round(H / 2)), base * (0.62 + 0.42 * intensity) * hoverBoost + (1 - pulse) * base * 1.1, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      // idle shell
      if (!live) {
        ctx.save();
        ctx.strokeStyle = 'rgba(86,233,255,0.16)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 7]);
        ctx.beginPath(); ctx.arc((large ? Math.round(W * 0.31) : Math.round(W * 0.245)), (large ? Math.round(H * 0.47) : Math.round(H / 2)), base * (1.02 + 0.1 * bass * dynamics) + base * 0.5, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    },

    drawSpectrumBars() {
      const ctx = this.ctx;
      if (!ctx) return;
      const W = this.canvas.width, H = this.canvas.height;
      const stream = this.stream;
      const live = Boolean(stream && stream.linked && stream.frames && !stream.stale);
      const metrics = live ? stream.metrics : emptyMetrics();
      const level = clamp01(metrics.level), bass = clamp01(metrics.bass), lowMid = clamp01(metrics.lowMid);
      const mid = clamp01(metrics.mid), high = clamp01(metrics.high);
      const intensity = Math.pow(level, 0.6);
      const dynamics = 0.22 + 0.78 * intensity;
      const glow = Math.max(0.2, Number(this.settings && this.settings.glow) || 1);
      const bars = live ? stream.bars : new Array(12).fill(0);
      const peaks = live ? stream.peaks : new Array(12).fill(0);
      const large = W > 460;
      const base = large ? Math.min(H * 0.2, 74) : Math.min(H * 0.185, 27);
      const startX = large ? 84 : 148;
      const endX = large ? W - 96 : W - 14;
      const barBaseY = large ? H - 46 : H - 24;
      const maxH = large ? H * 0.3 : H * 0.6;
      const maxWidth = large ? 30 : 9;
      const spacing = (endX - startX) / (bars.length - 1 || 1);
      for (let index = 0; index < bars.length; index++) {
        const value = clamp01(bars[index]);
        const scaler = live ? (0.3 + 0.7 * intensity) : 0.12;
        const height = Math.max(2, maxH * value * scaler);
        const width = Math.max(2, Math.min(maxWidth, spacing * 0.44));
        const x = startX + index * spacing - width / 2;
        const color = this.bandColor(index, value, glow);
        const glowColor = this.bandGlowColor(index, glow);
        const grad = ctx.createLinearGradient(0, barBaseY, 0, barBaseY - maxH);
        grad.addColorStop(0, color);
        grad.addColorStop(0.6, color);
        grad.addColorStop(1, 'rgba(232,253,255,0.92)');
        ctx.fillStyle = grad;
        if (height > 4) { ctx.shadowColor = glowColor; ctx.shadowBlur = Math.min(14, height * 0.5) * glow; }
        ctx.fillRect(x, barBaseY - height, width, height);
        ctx.shadowBlur = 0;
        const peak = clamp01(peaks[index]);
        if (this.settings && this.settings.peaks !== false && peak > 0.03) {
          const capY = barBaseY - Math.max(3, maxH * peak * scaler);
          ctx.fillStyle = 'rgba(67,233,196,0.9)';
          ctx.fillRect(x - 1, capY - 2, width + 2, 2.4);
        }
        ctx.fillStyle = 'rgba(86,233,255,0.32)';
        ctx.fillRect(x, barBaseY + 1.5, width, 1.4);
      }
    },

    // Transient sparks: only measured peaks spawn them, and each dies on its own.

    // Transient sparks: only measured peaks spawn them, and each dies on its own.
    updateSparks(pulse) {
      const sparks = this.sparks || (this.sparks = []);
      if (pulse > 0.3 && sparks.length < 64) {
        const count = 2 + Math.round(pulse * 6);
        for (let index = 0; index < count; index++) {
          sparks.push({ angle: Math.random() * Math.PI * 2, radius: 0.3 + Math.random() * 0.2, speed: 0.5 + Math.random() * 1.5, life: 1 });
        }
      }
      for (const spark of sparks) { spark.radius += spark.speed * 0.012; spark.life -= 0.04; }
      this.sparks = sparks.filter(spark => spark.life > 0);
      return this.sparks;
    },

    // Every layer is driven by measured values: level, bass, low-mid, mid, high
    // and the 12 real spectrum buckets (interpolated, never invented). With no
    // capture it draws a calm shell, and in silence every motion stops.
    draw(t, frozen) {
      const ctx = this.ctx;
      if (!ctx) return;
      const W = this.canvas.width, H = this.canvas.height;
      ctx.clearRect(0, 0, W, H);
      const stream = this.stream;
      const live = Boolean(stream && stream.linked && stream.frames && !stream.stale);
      const metrics = live ? stream.metrics : emptyMetrics();
      const bars = live ? stream.bars : new Array(12).fill(0);
      const peaks = this.peaks && this.peaks.length === 12 ? this.peaks : (this.peaks = new Array(12).fill(0));
      const level = clamp01(metrics.level), bass = clamp01(metrics.bass), lowMid = clamp01(metrics.lowMid);
      const mid = clamp01(metrics.mid), high = clamp01(metrics.high), pulse = clamp01(metrics.pulse);
      const intensity = Math.pow(level, 0.6);
      const dynamics = 0.22 + 0.78 * intensity;
      const phase = frozen ? 0 : t;
      const hoverBoost = this.hover ? 1.06 : 1;
      const large = W > 460;
      const sparks = this.updateSparks(live ? pulse : 0);
      for (let index = 0; index < 12; index++) {
        const value = clamp01(bars[index]);
        peaks[index] = value >= peaks[index] ? value : Math.max(0, peaks[index] - 0.01);
      }

      // ---- layout ----
      const cx = large ? Math.round(W * 0.31) : Math.round(W * 0.245);
      const cy = large ? Math.round(H * 0.47) : Math.round(H / 2);
      const base = large ? Math.min(H * 0.2, 74) : Math.min(H * 0.185, 27);
      const coreR = base * (0.62 + 0.42 * intensity) * hoverBoost;
      const ringR = base * (1.02 + 0.1 * bass * dynamics);
      const spokeBase = ringR + base * (large ? 0.8 : 0.5);
      const spokeScale = large ? 0.9 : 0.5;
      const spin = live ? 0.00022 + 0.0009 * high : 0.00004;
      const angleBase = phase * spin;

      // ---- holographic backdrop (expanded stage only) ----
      if (large) {
        ctx.save();
        ctx.strokeStyle = 'rgba(43,120,146,0.3)';
        ctx.lineWidth = 1;
        for (let step = 1; step <= 4; step++) {
          ctx.beginPath();
          ctx.arc(cx, cy, ringR + base * 0.62 * step, -Math.PI * 0.78, Math.PI * 0.78);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(43,120,146,0.22)';
        for (let index = 0; index < 36; index++) {
          const angle = (index / 36) * Math.PI * 2;
          const inner = ringR + base * 2.5, outer = inner + (index % 3 === 0 ? base * 0.16 : base * 0.07);
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
          ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
          ctx.stroke();
        }
        ctx.restore();
      }

      // ---- outer aura: loudness drives its reach ----
      const auraR = base * (1.95 + 0.75 * intensity);
      const aura = ctx.createRadialGradient(cx, cy, coreR * 0.35, cx, cy, auraR);
      aura.addColorStop(0, `rgba(86,233,255,${(0.15 + 0.22 * intensity).toFixed(3)})`);
      aura.addColorStop(0.6, `rgba(52,200,240,${(0.05 + 0.1 * lowMid).toFixed(3)})`);
      aura.addColorStop(1, 'rgba(25,169,228,0)');
      ctx.fillStyle = aura;
      ctx.beginPath(); ctx.arc(cx, cy, auraR, 0, Math.PI * 2); ctx.fill();

      // ---- the sphere: layered gradient body ----
      const core = ctx.createRadialGradient(cx - coreR * 0.3, cy - coreR * 0.34, coreR * 0.04, cx, cy, coreR);
      core.addColorStop(0, 'rgba(232,253,255,0.98)');
      core.addColorStop(0.32, `rgba(126,241,255,${(0.5 + 0.38 * intensity).toFixed(3)})`);
      core.addColorStop(0.7, `rgba(52,200,240,${(0.32 + 0.42 * intensity).toFixed(3)})`);
      core.addColorStop(1, 'rgba(19,120,180,0.06)');
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();

      // limb: bright rim that thickens with low-mid energy
      ctx.save();
      ctx.strokeStyle = `rgba(190,250,255,${(0.24 + 0.5 * intensity).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, base * 0.022) + base * 0.03 * lowMid * dynamics;
      ctx.shadowColor = 'rgba(86,233,255,0.6)';
      ctx.shadowBlur = base * 0.12;
      ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();

      // internal filaments: bass/low-mid energy swirling inside the sphere
      ctx.save();
      ctx.globalAlpha = 0.28 + 0.5 * Math.min(1, Math.max(bass, lowMid) * 1.3);
      const filaments = large ? 5 : 3;
      for (let index = 0; index < filaments; index++) {
        const radius = coreR * (0.34 + 0.15 * index);
        const angle = angleBase * (2.4 + index * 0.6) + index * 1.7;
        ctx.strokeStyle = index % 2 ? 'rgba(67,233,196,0.65)' : 'rgba(121,240,255,0.7)';
        ctx.lineWidth = Math.max(1, base * 0.02);
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(angle) * coreR * 0.08, cy + Math.sin(angle) * coreR * 0.08, radius, radius * (0.72 + 0.18 * mid), angle / 2.6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();

      // plasma arcs: count follows measured mid energy
      const arcCount = Math.round(6 + 24 * mid);
      ctx.save();
      ctx.lineWidth = Math.max(0.8, base * 0.016);
      for (let index = 0; index < arcCount; index++) {
        const a0 = (index / arcCount) * Math.PI * 2 + angleBase * 3.1;
        const radius = coreR * (0.52 + 0.42 * ((index % 5) / 5));
        ctx.strokeStyle = index % 3 === 0
          ? `rgba(232,253,255,${(0.16 + 0.42 * mid).toFixed(3)})`
          : `rgba(86,233,255,${(0.1 + 0.36 * lowMid).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(cx, cy, radius, a0, a0 + 0.16 + 0.5 * mid); ctx.stroke();
      }
      ctx.restore();

      // ---- bass ring: radius wobbles with the measured low end ----
      ctx.save();
      ctx.strokeStyle = `rgba(86,233,255,${(0.26 + 0.5 * intensity).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, base * 0.03) + base * 0.05 * lowMid * dynamics;
      ctx.shadowColor = 'rgba(86,233,255,0.5)';
      ctx.shadowBlur = base * 0.1;
      const wobble = base * 0.05 * bass * dynamics;
      ctx.beginPath();
      for (let index = 0; index <= 72; index++) {
        const angle = (index / 72) * Math.PI * 2;
        const radius = ringR + Math.sin(angle * 6 + angleBase * 8) * wobble;
        const x = cx + Math.cos(angle) * radius, y = cy + Math.sin(angle) * radius;
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.restore();

      // ---- mid ring: dashed and rotating with mid energy ----
      ctx.save();
      ctx.strokeStyle = `rgba(67,233,196,${(0.18 + 0.5 * mid).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, base * 0.022) + base * 0.02 * mid;
      ctx.setLineDash([Math.max(1.5, base * 0.045), Math.max(3, base * 0.14)]);
      ctx.lineDashOffset = live ? -angleBase * base * 12 : 0;
      ctx.beginPath(); ctx.arc(cx, cy, ringR + base * 0.32 + base * 0.05 * mid * dynamics, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();

      // ---- high ring: fine fast dashes ----
      ctx.save();
      ctx.strokeStyle = `rgba(190,250,255,${(0.1 + 0.5 * high).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.8, base * 0.014);
      ctx.setLineDash([Math.max(0.8, base * 0.012), Math.max(2, base * 0.05)]);
      ctx.lineDashOffset = live ? angleBase * base * 26 : 0;
      ctx.beginPath(); ctx.arc(cx, cy, ringR + base * 0.58 + base * 0.04 * high * dynamics, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();

      // ---- spectrum ring: the measured spectrum wraps the sphere, mirrored ----
      const spokes = large ? 96 : 56;
      ctx.save();
      for (let index = 0; index < spokes; index++) {
        const unit = index / spokes;
        const mirrored = unit <= 0.5 ? unit * 2 : (1 - unit) * 2;
        const value = spectrumAt(bars, mirrored);
        const peak = spectrumAt(peaks, mirrored);
        const angle = -Math.PI / 2 + unit * Math.PI * 2;
        const reach = spokeBase + base * 0.06 + base * spokeScale * value * dynamics;
        const x1 = cx + Math.cos(angle) * spokeBase, y1 = cy + Math.sin(angle) * spokeBase;
        const x2 = cx + Math.cos(angle) * reach, y2 = cy + Math.sin(angle) * reach;
        ctx.strokeStyle = value > 0.62 ? 'rgba(232,253,255,0.9)' : `rgba(86,233,255,${(0.26 + 0.5 * value).toFixed(3)})`;
        ctx.lineWidth = Math.max(1, base * 0.018) * (0.8 + 0.6 * value);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        if (peak > 0.05) {
          const capR = spokeBase + base * 0.06 + base * spokeScale * peak * dynamics + base * 0.05;
          const capX = cx + Math.cos(angle) * capR, capY = cy + Math.sin(angle) * capR;
          const capSize = Math.max(1.4, base * 0.035);
          ctx.fillStyle = 'rgba(67,233,196,0.9)';
          ctx.fillRect(capX - capSize / 2, capY - capSize / 2, capSize, capSize);
        }
      }
      ctx.restore();

      // ---- particles: high frequencies drive speed and size ----
      const particleCount = large ? 26 : 15;
      for (let index = 0; index < particleCount; index++) {
        const orbit = ringR + base * (0.15 + (index % 4) * 0.16);
        const speed = live ? (0.5 + 3.4 * high) : 0.12;
        const angle = (index / particleCount) * Math.PI * 2 + angleBase * (index % 2 ? 1.3 : -1.1) * (1 + speed);
        const px = cx + Math.cos(angle) * orbit, py = cy + Math.sin(angle) * orbit * 0.92;
        const size = Math.max(0.8, base * (0.02 + 0.055 * high * dynamics) * hoverBoost);
        ctx.fillStyle = index % 3 ? `rgba(86,233,255,${(0.32 + 0.5 * Math.min(1, high * 2)).toFixed(3)})` : 'rgba(67,233,196,0.8)';
        ctx.beginPath(); ctx.arc(px, py, size, 0, Math.PI * 2); ctx.fill();
      }

      // ---- sparks: measured transients only ----
      if (sparks.length) {
        ctx.save();
        for (const spark of sparks) {
          const radius = ringR + base * spark.radius + base * 0.5;
          const x = cx + Math.cos(spark.angle) * radius, y = cy + Math.sin(spark.angle) * radius * 0.94;
          ctx.strokeStyle = `rgba(232,253,255,${(0.6 * spark.life).toFixed(3)})`;
          ctx.lineWidth = Math.max(0.8, base * 0.015);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(spark.angle) * base * 0.16 * spark.speed, y + Math.sin(spark.angle) * base * 0.16 * spark.speed);
          ctx.stroke();
        }
        ctx.restore();
      }

      // ---- transient flash ----
      if (pulse > 0.04) {
        ctx.save();
        ctx.strokeStyle = `rgba(232,253,255,${(0.7 * pulse).toFixed(3)})`;
        ctx.lineWidth = Math.max(1, base * 0.04);
        ctx.beginPath(); ctx.arc(cx, cy, coreR + (1 - pulse) * base * 1.1, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }

      // ---- spectrum bars with peak caps ----
      const drawBars = (startX, endX, barBaseY, maxH, maxWidth) => {
        const spacing = (endX - startX) / (bars.length - 1 || 1);
        for (let index = 0; index < bars.length; index++) {
          const value = clamp01(bars[index]);
          const scaler = live ? dynamics : 0.12;
          const height = Math.max(2, maxH * value * scaler);
          const width = Math.max(2, Math.min(maxWidth, spacing * 0.44));
          const x = startX + index * spacing - width / 2;
          const grad = ctx.createLinearGradient(0, barBaseY, 0, barBaseY - maxH);
          grad.addColorStop(0, 'rgba(25,169,228,0.95)');
          grad.addColorStop(0.6, 'rgba(86,233,255,0.95)');
          grad.addColorStop(1, 'rgba(232,253,255,0.9)');
          ctx.fillStyle = grad;
          if (height > 4) { ctx.shadowColor = 'rgba(86,233,255,0.5)'; ctx.shadowBlur = Math.min(14, height * 0.5); }
          ctx.fillRect(x, barBaseY - height, width, height);
          ctx.shadowBlur = 0;
          const peak = clamp01(peaks[index]);
          if (peak > 0.03) {
            const capY = barBaseY - Math.max(3, maxH * peak * scaler);
            ctx.fillStyle = 'rgba(67,233,196,0.9)';
            ctx.fillRect(x - 1, capY - 2, width + 2, 2.4);
          }
          ctx.fillStyle = 'rgba(86,233,255,0.32)';
          ctx.fillRect(x, barBaseY + 1.5, width, 1.4);
        }
      };

      if (large) {
        const startX = 84, endX = W - 96, barBaseY = H - 46, maxH = H * 0.3;
        // smoothed spectrum line across the same measured buckets
        ctx.save();
        ctx.strokeStyle = 'rgba(190,250,255,0.5)';
        ctx.lineWidth = Math.max(1, base * 0.02);
        ctx.beginPath();
        for (let step = 0; step <= 120; step++) {
          const position = step / 120;
          const value = spectrumAt(bars, position);
          const x = startX + position * (endX - startX);
          const y = barBaseY - Math.max(2, maxH * value * (live ? dynamics : 0.12));
          if (step === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
        drawBars(startX, endX, barBaseY, maxH, 30);

        // level gauge
        ctx.save();
        const gaugeX = W - 52, gaugeY = 54, gaugeR = Math.max(18, base * 0.6);
        ctx.strokeStyle = 'rgba(43,120,146,0.55)';
        ctx.lineWidth = Math.max(2, base * 0.05);
        ctx.beginPath(); ctx.arc(gaugeX, gaugeY, gaugeR, Math.PI * 0.75, Math.PI * 2.25); ctx.stroke();
        ctx.strokeStyle = 'rgba(86,233,255,0.95)';
        ctx.beginPath(); ctx.arc(gaugeX, gaugeY, gaugeR, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * clamp01(level)); ctx.stroke();
        ctx.fillStyle = 'rgba(190,250,255,0.7)';
        ctx.font = `${Math.round(base * 0.3)}px Consolas, monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('LEVEL', gaugeX, gaugeY + gaugeR + base * 0.44);
        ctx.restore();

        // band labels
        ctx.save();
        ctx.fillStyle = 'rgba(97,187,207,0.75)';
        ctx.font = `${Math.round(base * 0.22)}px Consolas, monospace`;
        ctx.textAlign = 'left'; ctx.fillText('LOW', startX, H - 16);
        ctx.textAlign = 'center'; ctx.fillText('MID', (startX + endX) / 2, H - 16);
        ctx.textAlign = 'right'; ctx.fillText('HIGH', endX, H - 16);
        ctx.restore();
      } else {
        drawBars(148, W - 14, H - 24, H * 0.6, 9);
      }

      // Idle presence: no capture means a calm shell that claims nothing.
      if (!live) {
        ctx.save();
        ctx.strokeStyle = 'rgba(86,233,255,0.16)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 7]);
        ctx.beginPath(); ctx.arc(cx, cy, ringR + base * 0.5, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }
  };

  window.MusicOrb = MusicOrb;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => MusicOrb.init());
  } else {
    MusicOrb.init();
  }
})();
