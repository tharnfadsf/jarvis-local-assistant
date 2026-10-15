'use strict';
// PATH A low-volume wake detector tests (2026-10-14). Synthetic RMS frame
// envelopes only (no microphone/audio needed). Thresholds here are
// unit-calibrated defaults; live measurement per WAKEWORD-TEST-PROCEDURE.md
// decides the final tuning.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../jarvis-core.js');

const FRAME_MS = 85; // ~4096 samples @ 48 kHz, the real capture frame size
function run(det, rmsSeq, { speaking = false, stepMs = 100 } = {}) {
  let t = 1000000;
  const out = [];
  for (const rms of rmsSeq) { t += stepMs; out.push(det.sample(rms, FRAME_MS, { speaking, now: t })); }
  return out;
}
const quiet = (n, v = 0.002) => Array(n).fill(v);
// "hey JAR-vis": quiet onset, two bursts with a valley, ~600 ms total.
const HEY_JARVIS = [...quiet(3), 0.007, 0.011, 0.006, 0.013, 0.009, 0.004, ...quiet(3)];

test('two-burst wake envelope fires while silent (2 consecutive frames)', () => {
  const det = new Core.WakeSyllableDetector({ cooldownMs: 0 });
  const res = run(det, HEY_JARVIS);
  assert.ok(res.some(r => r.fired), 'quiet hey-jarvis pattern must fire');
  const fireIdx = res.findIndex(r => r.fired);
  assert.ok(fireIdx >= 4, 'must smooth over frames, never a single isolated frame');
});

test('silence and steady fan noise never fire', () => {
  for (const seq of [quiet(20, 0.001), quiet(20, 0.003), quiet(30, 0.0025)]) {
    const det = new Core.WakeSyllableDetector({ cooldownMs: 0 });
    assert.ok(run(det, seq).every(r => !r.fired), 'flat noise must never fire');
  }
});

test('a single click/clap never fires (needs consecutive frames)', () => {
  const det = new Core.WakeSyllableDetector({ cooldownMs: 0 });
  const res = run(det, [...quiet(5), 0.06, ...quiet(8)]);
  assert.ok(res.every(r => !r.fired), 'isolated burst must never fire');
});

test('sustained loud audio without quiet onset is suppressed', () => {
  const det = new Core.WakeSyllableDetector({ cooldownMs: 0 });
  const res = run(det, Array(16).fill(0.02));
  assert.ok(res.every(r => !r.fired), 'continuous loud audio must not force captures');
});

test('cooldown prevents immediate refire', () => {
  const det = new Core.WakeSyllableDetector({ cooldownMs: 2500 });
  const seq = [...HEY_JARVIS, ...quiet(2), ...HEY_JARVIS];
  const res = run(det, seq, { stepMs: 100 });
  const fires = res.filter(r => r.fired).length;
  assert.equal(fires, 1, 'second pattern inside cooldown must not refire');
});

test('speaking mode needs stronger evidence (3 frames + higher threshold)', () => {
  const silent = new Core.WakeSyllableDetector({ cooldownMs: 0 });
  const speaking = new Core.WakeSyllableDetector({ cooldownMs: 0 });
  const sRes = run(silent, HEY_JARVIS);
  // Feed only the first burst worth of frames while "speaking": not enough.
  const partial = [...quiet(3), 0.007, 0.011];
  const pRes = run(speaking, partial);
  assert.ok(sRes.some(r => r.fired), 'full pattern fires while silent');
  assert.ok(pRes.every(r => !r.fired), 'partial pattern must not fire while speaking');
  const full = run(new Core.WakeSyllableDetector({ cooldownMs: 0 }), HEY_JARVIS, { speaking: true });
  assert.ok(full.some(r => r.fired), 'full pattern still fires while speaking');
});

test('floor adapts: loud room desensitizes slowly, quiet recovery is faster', () => {
  const det = new Core.WakeSyllableDetector({ cooldownMs: 0 });
  run(det, quiet(10, 0.002));
  const f0 = det.floor;
  run(det, Array(10).fill(0.02));
  assert.ok(det.floor > f0, 'floor rises toward sustained loud audio');
  assert.ok(det.floor < 0.01, 'floor rises slowly (capped tracking)');
});

test('score helper is bounded and handles bad input', () => {
  assert.equal(Core.wakeTemplateScore([], 0.003), 0);
  assert.equal(Core.wakeTemplateScore(null, 0.003), 0);
  const s = Core.wakeTemplateScore(HEY_JARVIS.map(rms => ({ rms, ms: FRAME_MS })), 0.0025);
  assert.ok(s >= 0.5 && s <= 1, `pattern score ${s} must clear the default threshold`);
});
