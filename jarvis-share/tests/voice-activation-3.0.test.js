'use strict';
// VOICE ACTIVATION 3.0 tests — normal-volume wake reliability.
// Scope: VAD gate sensitivity, wake survival through correction, and the
// wake->command routing decisions. Acoustic (microphone) behavior is NOT
// asserted here; it is measured with the in-app MIC TEST.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../jarvis-core.js');

test('gate opens for conversational-volume speech, never for steady fan noise', () => {
  const gate = new Core.SpeechGate(); // defaults: onset 150 ms, ratio 1.25
  for (let i = 0; i < 6; i++) gate.sample(0.02, 100); // 600 ms fan calibration
  assert.ok(gate.noiseFloor >= 0.019 && gate.noiseFloor <= 0.021);
  // Quiet speech at ~1.3x the floor must trigger within ~300 ms (was 200+ ms
  // at ratio 1.4, which forced users to speak up or repeat).
  let fired = false;
  for (let i = 0; i < 3; i++) if (gate.sample(0.026, 100).trigger) { fired = true; break; }
  assert.ok(fired, 'quiet conversational speech should open the gate');
  gate.reset();
  for (let i = 0; i < 6; i++) gate.sample(0.02, 100);
  for (let i = 0; i < 15; i++) assert.equal(gate.sample(0.02, 100).trigger, false, 'fan noise alone never triggers');
});

test('correction never damages the wake word', () => {
  for (const raw of ['Jarvis, open YouTube', 'Hey Jarvis, search up fry day', 'Jarvis, open lower boy', 'Harvis, open YouTube']) {
    const det = Core.voiceDeterministicCorrection(raw);
    const probe = Core.parseWakeTranscript(det.correctedTranscript, 'Jarvis');
    assert.ok(probe.activated, `${raw} -> "${det.correctedTranscript}" must keep a detectable wake`);
  }
  assert.match(Core.voiceDeterministicCorrection('Hey Jarvis, search up fry day').correctedTranscript, /frieren/i);
});

test('single utterance carries wake plus command; no-wake commands stay ignored', () => {
  const cmd = Core.decideVoiceAction('Jarvis, open YouTube', { mode: 'LISTENING', wake: Core.parseWakeTranscript('Jarvis, open YouTube', 'Jarvis'), busy: false });
  assert.equal(cmd.action, 'command');
  assert.match(cmd.command, /open youtube/i);
  const noWake = Core.decideVoiceAction('open YouTube', { mode: 'LISTENING', wake: Core.parseWakeTranscript('open YouTube', 'Jarvis'), wakeArmed: false, busy: false });
  assert.equal(noWake.action, 'ignore');
  assert.equal(noWake.reason, 'no-wake');
  const busy = Core.decideVoiceAction('Jarvis, open YouTube', { mode: 'LISTENING', wake: Core.parseWakeTranscript('Jarvis, open YouTube', 'Jarvis'), busy: true });
  assert.equal(busy.action, 'ignore');
  assert.equal(busy.reason, 'busy');
});

test('activation examples route to real intents after correction', () => {
  const cases = [
    ['Jarvis, open Gmail', 'gmail'],
    ['Jarvis, take a screenshot', null], // handled by screenshot tool path, must keep wake+verb
    ['Jarvis, skip this video', null],
    ['Jarvis, find my Roblox folder', 'roblox'],
    ['Hey Jarvis, take a screenshot', null],
  ];
  for (const [raw, want] of cases) {
    const det = Core.voiceDeterministicCorrection(raw);
    const probe = Core.parseWakeTranscript(det.correctedTranscript, 'Jarvis');
    assert.ok(probe.activated, raw);
    assert.ok((probe.command || '').length > 0, `${raw} must preserve a command, got "${probe.command}"`);
    if (want) assert.match(probe.command, new RegExp(want, 'i'));
  }
});
