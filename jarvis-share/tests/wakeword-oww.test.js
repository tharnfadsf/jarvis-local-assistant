'use strict';
// Wake-word 2026-10-14 tests: optional openWakeWord sidecar combiner +
// early-gate acceptance rules. All pure (no microphone, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../jarvis-core.js');
const Oww = require('../wakeword-oww.js');

test('wakeWordWithOwwScore leaves text decision unchanged when sidecar absent', () => {
  const wake = Core.parseWakeTranscript('Could you open Roblox, Jarvis?', 'Jarvis');
  assert.ok(wake.activated);
  assert.equal(wake.confidence, 0.6);
  const out = Core.wakeWordWithOwwScore(wake, null);
  assert.equal(out.activated, true);
  assert.equal(out.confidence, 0.6);
  assert.equal(out.owwBoosted, false);
});

test('oww score above threshold boosts a 0.6 anywhere-match to 0.9 (early gate only)', () => {
  const wake = Core.parseWakeTranscript('Could you open Roblox, Jarvis?', 'Jarvis');
  const out = Core.wakeWordWithOwwScore(wake, 0.82, { threshold: 0.5, now: 10000, lastAt: 0 });
  assert.equal(out.owwBoosted, true);
  assert.equal(out.confidence, 0.9);
});

test('oww cooldown prevents double-boost within 2.5 s', () => {
  const wake = Core.parseWakeTranscript('Could you open Roblox, Jarvis?', 'Jarvis');
  const out = Core.wakeWordWithOwwScore(wake, 0.9, { threshold: 0.5, now: 10000, lastAt: 9000 });
  assert.equal(out.owwBoosted, false);
  assert.equal(out.confidence, 0.6);
});

test('oww never creates activation from silence', () => {
  const wake = Core.parseWakeTranscript('turn off the kitchen light', 'Jarvis');
  assert.equal(wake.activated, false);
  const out = Core.wakeWordWithOwwScore(wake, 0.99, { threshold: 0.5, now: 20000, lastAt: 0 });
  assert.equal(out.activated, false);
  assert.equal(out.owwBoosted, false);
});

test('sidecar scoreToDecision honors threshold + cooldown', () => {
  assert.equal(Oww.scoreToDecision(0.7, { threshold: 0.5, now: 1000, lastAt: 0 }).fired, true);
  assert.equal(Oww.scoreToDecision(0.3, { threshold: 0.5, now: 1000, lastAt: 0 }).fired, false);
  const cooled = Oww.scoreToDecision(0.9, { threshold: 0.5, now: 1000, lastAt: 500 });
  assert.equal(cooled.fired, false);
  assert.equal(cooled.cooledDown, true);
});

test('to16kMono downsamples without throwing on empty input', () => {
  const out = Oww.to16kMono(new Float32Array([0.1, 0.2, 0.3, 0.4]), 48000, 16000);
  assert.ok(out.length >= 1);
  assert.deepEqual([...Oww.to16kMono(new Float32Array(0), 48000)], []);
});

test('early-gate rule: 0.6 + command + low no-speech passes; bare hallucination does not', () => {
  // Mirrors the app.js early-gate condition (kept in test so tuning is explicit).
  const accepts = (conf, hasCommand, noSpeech) =>
    conf >= 0.7 || (conf >= 0.6 && hasCommand && (noSpeech == null || noSpeech < 0.6));
  assert.equal(accepts(0.9, false, 0.8), true); // start-match "Jarvis" alone
  assert.equal(accepts(0.6, true, 0.2), true); // mid-sentence with command, clean audio
  assert.equal(accepts(0.6, true, 0.9), false); // likely noise hallucination
  assert.equal(accepts(0.6, false, 0.1), false); // bare anywhere-match without command
  assert.equal(accepts(0.0, false, 0.1), false);
});
