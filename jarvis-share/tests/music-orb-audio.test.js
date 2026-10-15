'use strict';
// Tests for the Media Orb's audio path: the NDJSON stream client that carries
// real system-audio frames, the metrics promotion, media identity precedence,
// honest labels, and the visibility reducer across audio-only, session-only,
// paused and stopped media.
const test = require('node:test');
const assert = require('node:assert/strict');
const orb = require('../music-orb.js');

function readerFrom(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    async read() {
      if (index >= chunks.length) return { done: true, value: undefined };
      const value = encoder.encode(chunks[index]);
      index += 1;
      return { done: false, value };
    }
  };
}

function fakeFetch(chunks, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, body: { getReader: () => readerFrom(chunks) } });
}

const frameLine = (level, bass = level, lowMid = level, mid = level, high = level, bars = null) =>
  JSON.stringify({ type: 'frame', level, bass, lowMid, mid, high, peakDb: -10, rmsDb: -20, bars: bars || new Array(12).fill(level) }) + '\n';

test('stream client connects, promotes real frames, and exposes measured bands', async () => {
  const frames = [];
  const states = [];
  const client = orb.createMediaStream({
    fetch: fakeFetch([
      JSON.stringify({ type: 'hello', capture: { running: true, ready: false, fps: 30 }, sessions: [{ appId: 'chrome.exe', status: 'Playing', title: 'Video' }] }) + '\n',
      JSON.stringify({ type: 'ready', sampleRate: 48000, fps: 30 }) + '\n',
      frameLine(0.9, 0.9, 0.5, 0.2, 0.05, [1, 0.9, 0.6, 0.2, 0, 0, 0, 0, 0, 0, 0, 0])
    ]),
    setTimeout: () => 0,
    onFrame: frame => frames.push(frame),
    onState: state => states.push(Boolean(state && state.linked))
  });
  await client.open();
  assert.ok(states.includes(true), 'a hello frame links the stream');
  assert.equal(client.capture.ready, true, 'the ready line marks the capture active');
  assert.equal(client.capture.sampleRate, 48000);
  assert.equal(client.sessions.length, 1, 'Chrome sessions from GSMTC reach the client');
  assert.equal(frames.length, 1, 'exactly one measured frame was promoted');
  assert.ok(client.metrics.level > 0.4, `level must rise from the measured frame, got ${client.metrics.level}`);
  assert.ok(client.metrics.bass > client.metrics.high, 'bass-heavy frames must keep their shape');
  assert.deepEqual(client.bars.slice(0, 3), [1, 0.9, 0.6], 'the 12 real spectrum buckets are carried through');
  assert.ok(Array.isArray(client.peaks) && client.peaks.length >= 12, 'per-band peak hold is exposed to the orb');
  assert.ok(client.peaks[0] >= 1, 'the first band peak holds the measured peak');
  assert.ok(client.metrics.peaks && client.metrics.peaks.length >= 12, 'smoothed metrics also expose peak hold for the renderer');
  assert.ok(client.metrics.peaks[0] >= 1, 'smoothed metrics peak hold holds the measured peak');
  assert.ok(states.length >= 1, 'state changes are reported to the orb');
  client.close(); // the client retries by design; a closed client stops the timers
});

test('measured frames drive audio activity with the same debounce as before', async () => {
  const client = orb.createMediaStream({
    fetch: fakeFetch([frameLine(0.8) + frameLine(0.8) + frameLine(0.8)]),
    setTimeout: () => 0
  });
  await client.open();
  assert.ok(client.frames >= 1, 'frames were promoted from the stream');
  client.close();
  const activity = orb.updateAudioActivity(null, 0.8, 1000, {});
  assert.equal(activity.active, false, 'a single loud frame is not enough');
  const hold = orb.updateAudioActivity({ ...activity, active: true, lastLoudAt: 2000 }, 0, 2500, {});
  assert.equal(hold.active, true, 'a short gap keeps the orb up');
  const released = orb.updateAudioActivity({ ...hold, lastLoudAt: 2000 }, 0, 4000, {});
  assert.equal(released.active, false, 'a real stop releases the activity');
});

test('quiet media still counts as audio, while measured silence does not', () => {
  // A video at low volume: a low level but real, measured band energy.
  const quietStart = orb.updateAudioActivity(null, 0.025, 1000, {}, 0.42);
  assert.equal(quietStart.active, false, 'one frame never flips it immediately');
  const quiet = orb.updateAudioActivity(quietStart, 0.025, 1200, {}, 0.42);
  assert.equal(quiet.active, true, 'sustained quiet playback with real band energy wakes the orb');
  // Silence from a stopped stream measures level 0 and no band energy.
  const silence = orb.updateAudioActivity(null, 0.015, 1000, {}, 0);
  const stillSilent = orb.updateAudioActivity(silence, 0.015, 1400, {}, 0);
  assert.equal(stillSilent.active, false, 'silence with flat bands never counts as media');
});

test('a stalled capture settles the orb and says so instead of freezing it', () => {
  assert.equal(orb.isFrameStale(0, 99999, 1400), false, 'a stream that has not delivered yet is not stale');
  assert.equal(orb.isFrameStale(1000, 2000, 1400), false, 'normal frame spacing is not stale');
  assert.equal(orb.isFrameStale(1000, 3000, 1400), true, 'no frames for over a second means the capture stalled');

  const visible = { visible: true, mode: 'playing', trackKey: 'media:live', lastSeenAt: 1000, dismissedKey: '', expanded: false, visual: 'live' };
  const stalled = orb.nextOrbState(visible, null, 2000, {}, { linked: false, active: false, stalled: true }, []);
  assert.equal(stalled.visual, 'stalled', 'a stalled capture is reported as stalled, never as live');
  assert.equal(stalled.activityActive, false, 'the animation settles instead of holding its last frame');
  assert.equal(stalled.visible, true, 'the orb stays visible through the grace window');
  const label = orb.visualizationLabel({ linked: true, stalled: true }, stalled, []);
  assert.equal(label.live, false);
  assert.match(label.text, /STALLED/);

  const fromState = orb.nextOrbState({ ...visible, visual: 'stalled' }, null, 2000, {}, { linked: true, active: false, stalled: true }, []);
  assert.equal(fromState.visual, 'stalled', 'the stalled visual survives even while the stream is still connected');
  const gone = orb.nextOrbState({ ...visible, visual: 'stalled' }, null, 30000, {}, { linked: false, active: false, stalled: true }, []);
  assert.equal(gone.visible, false, 'a capture that never recovers does not leave a zombie orb behind');

  // And the same media still animates again the moment frames return.
  const recovered = orb.nextOrbState({ ...visible, visual: 'stalled' }, null, 4000, {}, { linked: true, active: true, stalled: false }, []);
  assert.equal(recovered.visible, true);
  assert.equal(recovered.visual, 'live');
});

test('the stream client ages out a silent capture and revives on the next frame', async () => {
  const states = [];
  const client = orb.createMediaStream({
    fetch: fakeFetch([frameLine(0.7)]),
    setTimeout: () => 0,
    staleAfterMs: 1000,
    onState: state => states.push(Boolean(state && state.stale))
  });
  await client.open();
  assert.equal(client.frames, 1);
  assert.equal(client.refresh(client.lastFrameAt + 200), false, 'frames are flowing');
  assert.equal(client.refresh(client.lastFrameAt + 2000), true, 'a quiet stream is marked stale');
  assert.ok(states.includes(true), 'the orb is told the stream went stale');
  client.handleLine(frameLine(0.7).trim(), Date.now());
  assert.equal(client.refresh(Date.now()), false, 'the next real frame revives it');
  client.close();
});

test('a dropped stream reports honestly and schedules a reconnect without duplicating capture', async () => {
  const retries = [];
  const client = orb.createMediaStream({
    fetch: async () => ({ ok: true, status: 200, body: { getReader: () => readerFrom([]) } }),
    setTimeout: (fn, delay) => { retries.push(delay); return 0; }
  });
  await client.open();
  assert.equal(client.linked, false, 'an empty stream is not treated as connected');
  assert.equal(retries.length, 1, 'exactly one reconnect was scheduled');
  assert.match(client.error, /disconnected|ended/i);
  const closed = orb.createMediaStream({
    fetch: async () => { throw new Error('refused'); },
    setTimeout: (fn, delay) => { retries.push(delay); return 0; }
  });
  closed.close();
  await closed.open();
  assert.equal(retries.length, 1, 'a closed client never schedules a reconnect');
  client.close();
});

test('the spectrum sampler interpolates measured buckets and invents nothing', () => {
  assert.equal(orb.spectrumAt([], 0.5), 0, 'no buckets means no signal');
  assert.equal(orb.spectrumAt([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 0), 0, 'the low end stays at the low bucket value');
  assert.equal(orb.spectrumAt([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 1), 1, 'the high end reads the top bucket');
  assert.equal(orb.spectrumAt([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0.5), 0, 'a silent middle stays silent, never filled in');
  const between = orb.spectrumAt([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 1 / 11);
  assert.equal(Math.round(between * 100) / 100, 1, 'positions between buckets blend their neighbours');
  assert.equal(orb.spectrumAt([2, 1, 3], 0), 1, 'over-loud buckets clamp to one');
  assert.equal(orb.spectrumAt([2, -1, 3], 0.5), 0, 'negative buckets clamp to zero');
});

test('metrics are only promoted from real frame payloads', () => {
  assert.equal(orb.metricsFromFrame(null), null);
  assert.equal(orb.metricsFromFrame({ type: 'hello' }), null);
  assert.equal(orb.metricsFromFrame({ type: 'frame' }).level, 0, 'a frame without numbers clamps to zero');
  assert.deepEqual(orb.metricsFromFrame({ type: 'frame', level: 2, bass: -1, lowMid: 0.5, mid: 0.25, high: 0.1 }), { level: 1, bass: 0, lowMid: 0.5, mid: 0.25, high: 0.1, bars: null });
  const bars = orb.asBars([1.4, -2, 0.5]);
  assert.equal(bars.length, 12, 'bundles are always 12 buckets');
  assert.deepEqual(bars.slice(0, 3), [1, 0, 0.5]);
});

test('media identity prefers the verified player, then a Windows session, never invented data', () => {
  const verified = { ok: true, status: 'Playing', title: 'Track', artist: 'Artist', source: 'music.youtube.com', verified: true };
  const session = { appId: 'chrome.exe', status: 'Playing', title: 'YouTube video', artist: 'Channel' };
  const fromVerified = orb.identifyMedia(verified, [session]);
  assert.equal(fromVerified.title, 'Track');
  assert.equal(fromVerified.source, 'MUSIC.YOUTUBE.COM');
  const fromSession = orb.identifyMedia(null, [session]);
  assert.equal(fromSession.title, 'YouTube video');
  assert.equal(fromSession.source, 'CHROME', 'the app name is used when no host exists');
  assert.equal(fromSession.controlled, false);
  const nothing = orb.identifyMedia(null, []);
  assert.equal(nothing.title, '', 'no metadata is invented when nothing is known');
  assert.equal(orb.mediaHeadline(nothing, { mode: 'playing' }).title, 'MEDIA ACTIVE');
  assert.equal(orb.mediaHeadline(nothing, { mode: 'idle' }).title, 'AUDIO IDLE');
  const untitled = orb.mediaHeadline(orb.identifyMedia(null, [{ appId: 'chrome.exe', status: 'Playing' }]), { mode: 'playing' });
  assert.equal(untitled.title, 'MEDIA ACTIVE', 'a playing session without metadata still shows MEDIA ACTIVE');
});

test('the orb labels the capture honestly in every state', () => {
  const playing = { mode: 'playing', visual: 'live' };
  assert.match(orb.visualizationLabel({ linked: false, error: '' }, playing, []).text, /CONNECTING/);
  assert.match(orb.visualizationLabel({ linked: false, error: 'device missing' }, playing, []).text, /UNAVAILABLE/);
  const live = orb.visualizationLabel({ linked: true, error: '' }, { mode: 'playing', visual: 'live' }, []);
  assert.equal(live.live, true);
  assert.match(live.text, /LIVE AUDIO/);
  const silent = orb.visualizationLabel({ linked: true, error: '' }, { mode: 'playing', visual: 'silent' }, []);
  assert.match(silent.text, /NO SOUND/);
});

test('Chrome playing with no metadata and no session still shows the orb', () => {
  const hidden = { visible: false, mode: 'idle', trackKey: '', lastSeenAt: 0, dismissedKey: '', expanded: false, visual: 'idle' };
  const shown = orb.nextOrbState(hidden, null, 5000, {}, { linked: true, active: true }, []);
  assert.equal(shown.visible, true, 'measured audio alone must wake the orb');
  assert.equal(shown.mode, 'playing');
  assert.equal(shown.visual, 'live');
  assert.equal(shown.trackKey, 'media:live');
});

test('a Windows media session shows the orb even before audio frames arrive', () => {
  const hidden = { visible: false, mode: 'idle', trackKey: '', lastSeenAt: 0, dismissedKey: '', expanded: false, visual: 'idle' };
  const state = orb.nextOrbState(hidden, null, 6000, {}, { linked: true, active: false }, [{ appId: 'chrome.exe', status: 'Playing', title: 'YouTube' }]);
  assert.equal(state.visible, true, 'a playing session is enough to appear');
  assert.equal(state.mode, 'playing');
  assert.equal(state.visual, 'silent', 'no measured sound yet is reported as silent, not as live');
  assert.match(state.trackKey, /^chrome:YouTube$/);
});

test('paused, stopped, grace and manual dismiss behave predictably', () => {
  const visible = { visible: true, mode: 'playing', trackKey: 'chrome:YouTube', lastSeenAt: 1000, dismissedKey: '', expanded: false, visual: 'live' };
  const paused = orb.nextOrbState(visible, null, 2000, {}, { linked: true, active: false }, [{ appId: 'chrome.exe', status: 'Paused', title: 'YouTube' }]);
  assert.equal(paused.visible, true, 'pausing keeps the orb up');
  assert.equal(paused.mode, 'paused');
  assert.equal(paused.trackKey, 'chrome:YouTube', 'a paused session keeps its identity');
  const stoppedSoon = orb.nextOrbState(visible, null, 3000, {}, { linked: true, active: false }, []);
  assert.equal(stoppedSoon.visible, true, 'the grace window prevents flicker');
  const stoppedLater = orb.nextOrbState(visible, null, 30000, {}, { linked: true, active: false }, []);
  assert.equal(stoppedLater.visible, false, 'the orb disappears once media is gone');
  const dismissed = { ...visible, dismissedKey: 'chrome:YouTube' };
  const held = orb.nextOrbState(dismissed, null, 4000, {}, { linked: true, active: true }, [{ appId: 'chrome.exe', status: 'Playing', title: 'YouTube' }]);
  assert.equal(held.visible, false, 'a manual dismiss holds for the same media');
  const other = orb.nextOrbState(dismissed, null, 5000, {}, { linked: true, active: true }, [{ appId: 'chrome.exe', status: 'Playing', title: 'Another video' }]);
  assert.equal(other.visible, true, 'new media clears the dismissal');
});
