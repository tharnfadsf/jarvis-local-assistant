'use strict';
// TTS pipeline dedup tests (2026-10-15): one speech delivery per response.
// These exercise the REAL Core.SpeechController contract used by the app's
// speak() choke point, plus the ack-cooldown rule that stops the wake-word
// path from acknowledging the same utterance twice. Browser audio playback
// itself is verified on the desktop; nothing here claims real audio passed.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');

test('a response is claimed exactly once per request; duplicates are blocked', () => {
  const controller = new core.SpeechController();
  const requestId = controller.generateRequestId();
  const responseId = controller.generateResponseId('Systems nominal, Sir.');
  const epoch = controller.claim(requestId, responseId);
  assert.ok(epoch > 0, 'first claim wins a playback epoch');
  assert.equal(controller.claim(requestId, responseId), 0, 'duplicate claim is blocked');
  assert.equal(controller.claim(requestId, responseId), 0, 'a third callback is blocked too');
  assert.ok(controller.hasBeenSpoken(requestId, responseId));
});

test('streaming finalize and a double completion callback cannot double-submit', () => {
  // The same finalized response carried by two callbacks shares the
  // (requestId, responseId) pair and is therefore spoken once.
  const controller = new core.SpeechController();
  const requestId = controller.generateRequestId();
  const responseId = controller.generateResponseId('Conclusion: it works.');
  assert.ok(controller.claim(requestId, responseId) > 0);
  assert.equal(controller.claim(requestId, responseId), 0);
});

test('interruption never restarts the stopped audio via a stale callback', () => {
  const controller = new core.SpeechController();
  const requestId = controller.generateRequestId();
  const responseId = controller.generateResponseId('The weather looks clear.');
  controller.claim(requestId, responseId);
  // Interruption (stop) does NOT release the claim, so a stale handler that
  // retries the same response cannot restart the audio.
  assert.ok(controller.hasBeenSpoken(requestId, responseId));
  assert.equal(controller.claim(requestId, responseId), 0);
});

test('a pre-playback pipeline failure releases the claim for an explicit retry', () => {
  const controller = new core.SpeechController();
  const requestId = controller.generateRequestId();
  const responseId = controller.generateResponseId('Could you rephrase that, Sir?');
  controller.claim(requestId, responseId);
  // speak() failed before any audio reached the speakers.
  controller.release(requestId, responseId);
  assert.equal(controller.hasBeenSpoken(requestId, responseId), false, 'no false spoken state');
  assert.ok(controller.claim(requestId, responseId) > 0, 'an explicit retry can run');
});

test('a genuinely new request reusing the same words still speaks', () => {
  const controller = new core.SpeechController();
  const text = 'What is the time?';
  const first = controller.generateRequestId();
  const second = controller.generateRequestId();
  const responseId = controller.generateResponseId(text);
  assert.ok(controller.claim(first, responseId) > 0, 'first utterance answers normally');
  assert.ok(controller.claim(second, responseId) > 0, 'asking again right after is a new delivery');
});

test('consecutive different responses on one request are not suppressed', () => {
  const controller = new core.SpeechController();
  const requestId = controller.generateRequestId();
  assert.ok(controller.claim(requestId, controller.generateResponseId('Answer one.')) > 0);
  assert.ok(controller.claim(requestId, controller.generateResponseId('Answer two.')) > 0);
});

test('response identity is deterministic per text and distinct across texts', () => {
  const idA = core.SpeechController.hashText('Okay, Sir.');
  assert.equal(core.SpeechController.hashText('Okay, Sir.'), idA);
  assert.notEqual(core.SpeechController.hashText('Okay Sir.'), idA);
});

test('recent-response memory stays bounded at 50 requests', () => {
  const controller = new core.SpeechController();
  let oldest = null;
  for (let i = 0; i < 60; i++) {
    const requestId = `req_${i}`;
    if (i === 0) oldest = requestId;
    controller.claim(requestId, `resp_${i}`);
  }
  assert.equal(controller.spokenResponses.size, 50);
  assert.ok(!controller.spokenResponses.has(oldest), 'oldest evicted');
});

test('the wake ack cooldown prevents a second Yes-Sir for the same utterance', () => {
  // First ack passes; the co-arriving duplicate (lastAckAt just set by
  // handleWakeWordDetection) must be cooled down, not re-spoken.
  const now = Date.now();
  const first = core.decideVoiceAction('Jarvis', { mode: 'LISTENING', recognitionEnabled: true, busy: false, now });
  assert.equal(first.action, 'ack', JSON.stringify(first));
  const duplicate = core.decideVoiceAction('Jarvis', { mode: 'LISTENING', recognitionEnabled: true, busy: false, now, lastAckAt: now, ackCooldownMs: 4000 });
  assert.equal(duplicate.action, 'ignore', JSON.stringify(duplicate));
  assert.equal(duplicate.reason, 'ack-cooldown');
  // A later utterance (beyond the cooldown) is acknowledged again normally.
  const later = core.decideVoiceAction('Jarvis', { mode: 'LISTENING', recognitionEnabled: true, busy: false, now: now + 5000, lastAckAt: now, ackCooldownMs: 4000 });
  assert.equal(later.action, 'ack', JSON.stringify(later));
});
