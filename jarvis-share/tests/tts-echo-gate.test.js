'use strict';
// Playback-gated capture tests (2026-10-14). Pin the central rule: own TTS
// audio never seeds normal capture; only a barge latch opens an
// interruption-only candidate. Live echo behavior is verified in the desktop
// app per the task checklist (Tests A-G).
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../jarvis-core.js');

test('idle seeds, playback and tail-hold suppress', () => {
  assert.deepEqual(Core.playbackGateDecision({}), { seed: true, reason: 'idle' });
  assert.deepEqual(Core.playbackGateDecision({ ttsActive: true }), { seed: false, reason: 'playback' });
  assert.deepEqual(Core.playbackGateDecision({ holdActive: true }), { seed: false, reason: 'tail-hold' });
  assert.deepEqual(Core.playbackGateDecision({ ttsActive: true, holdActive: true }), { seed: false, reason: 'playback' });
});

test('barge latch bypasses playback and hold, never inverts to suppress', () => {
  assert.deepEqual(Core.playbackGateDecision({ ttsActive: true, bargeLatch: true }), { seed: true, reason: 'barge' });
  assert.deepEqual(Core.playbackGateDecision({ holdActive: true, bargeLatch: true }), { seed: true, reason: 'barge' });
  assert.deepEqual(Core.playbackGateDecision({ bargeLatch: true }), { seed: true, reason: 'barge' });
});

test('barge energy needs real loudness over both floor and playback level', () => {
  // Quiet room, quiet speech: no latch.
  assert.equal(Core.bargeFrame({ rms: 0.004, commandFloor: 0.003, speakLevel: 0.004 }), false);
  // Own TTS at its own level: no latch (single-mic self-trigger guard).
  assert.equal(Core.bargeFrame({ rms: 0.012, commandFloor: 0.003, speakLevel: 0.012 }), false);
  // Deliberate loud interruption over quiet playback: latch.
  assert.equal(Core.bargeFrame({ rms: 0.06, commandFloor: 0.003, speakLevel: 0.008 }), true);
  // Loud over loud playback: needs clearly-above-playback energy.
  assert.equal(Core.bargeFrame({ rms: 0.05, commandFloor: 0.003, speakLevel: 0.03 }), false);
  assert.equal(Core.bargeFrame({ rms: 0.12, commandFloor: 0.003, speakLevel: 0.03 }), true);
  // Degenerate inputs never latch.
  assert.equal(Core.bargeFrame({}), false);
  assert.equal(Core.bargeFrame({ rms: -1 }), false);
});

test('gate defaults are sane and bounded', () => {
  const d = Core.PLAYBACK_DEFAULTS;
  assert.ok(d.tailCooldownMs >= 0 && d.tailCooldownMs <= 3000);
  assert.ok(d.bargeFloorMult >= 3 && d.bargeSpeakMult >= 2 && d.bargeFrames >= 2);
});
