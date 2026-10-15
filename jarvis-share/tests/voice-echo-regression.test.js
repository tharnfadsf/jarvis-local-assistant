'use strict';
// Regression tests for the TTS echo / repeat fix.
//
// These are SIMULATED tests: they drive the pure routing decision
// (Core.decideVoiceAction), the playback-overlap gate, and the voice state
// machine directly. They do not use a microphone or speakers. Real-microphone
// verification was not possible in this environment and is called out in the
// final report.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');

const NOW = 1_700_000_000_000;
const idle = (over = {}) => ({ mode: 'IDLE', now: NOW, ...over });
const decide = (heard, ctx) => core.decideVoiceAction(heard, { mode: 'IDLE', now: NOW, ...ctx });

// 1. Background conversation in standby does not trigger a response.
test('background conversation without the wake word is ignored', () => {
  for (const heard of [
    'what time is the meeting tomorrow',
    'open the pod bay doors',
    'did you see the game last night',
    'thank you for watching'
  ]) {
    const result = decide(heard, {});
    assert.equal(result.action, 'ignore', heard);
    assert.equal(result.reason, 'no-wake', heard);
  }
});

// 2. "Jarvis" triggers exactly one acknowledgement.
test('bare wake word acks once; an immediate repeat is ack-cooldown', () => {
  const first = decide('Jarvis', {});
  assert.equal(first.action, 'ack');
  const second = decide('Hey Jarvis', { lastAckAt: NOW - 500 });
  assert.equal(second.action, 'ignore');
  assert.equal(second.reason, 'ack-cooldown');
  const later = decide('Jarvis', { lastAckAt: NOW - 30_000 });
  assert.equal(later.action, 'ack', 'wake works again after the cooldown');
});

// 3. "Hey Jarvis, open YouTube" executes exactly once.
test('combined wake plus command yields one command action', () => {
  const result = decide('Hey Jarvis, open YouTube', {});
  assert.equal(result.action, 'command');
  assert.equal(result.command, 'open youtube');
  // The duplicate delivery of the same transcript must not run again.
  const dupe = decide('Hey Jarvis, open YouTube', { duplicate: true });
  assert.equal(dupe.action, 'ignore');
  assert.equal(dupe.reason, 'duplicate');
});

// 4. One spoken command produces exactly one assistant response.
test('a second transcript while a command runs is dropped as busy', () => {
  const first = decide('Jarvis, what time is it', {});
  assert.ok(['command', 'interrupt'].includes(first.action) || first.action === 'command');
  const second = decide('Jarvis, what time is it', { busy: true });
  assert.equal(second.action, 'ignore');
  assert.equal(second.reason, 'busy');
});

// 5. JARVIS's own TTS does not retrigger the wake word.
test('own acknowledgement and own response transcripts are echo-ignored', () => {
  const ackEcho = decide('Yes, Sir?', { mode: 'LISTENING', echoRecent: true });
  assert.equal(ackEcho.action, 'ignore');
  assert.equal(ackEcho.reason, 'echo');
  const responseEcho = decide('Your calendar is clear today', { mode: 'SPEAKING', echoCurrent: true });
  assert.equal(responseEcho.action, 'ignore');
  assert.equal(responseEcho.reason, 'echo');
  // TTS tail landing in the follow-up window without a wake word is dropped.
  const tail = decide('open chrome', { mode: 'LISTENING', wakeArmed: true, contaminated: true });
  assert.equal(tail.action, 'ignore');
  assert.equal(tail.reason, 'contaminated-no-wake');
});

// 6. A command is not executed twice because of duplicate recognition callbacks.
test('duplicate and busy guards each independently suppress re-execution', () => {
  const wake = core.parseWakeTranscript('Jarvis, open youtube', 'Jarvis');
  const base = { mode: 'IDLE', wake };
  assert.equal(core.decideVoiceAction('Jarvis, open youtube', base).action, 'command');
  assert.equal(core.decideVoiceAction('Jarvis, open youtube', { ...base, duplicate: true }).reason, 'duplicate');
  assert.equal(core.decideVoiceAction('Jarvis, open youtube', { ...base, busy: true }).reason, 'busy');
});

// 7. After speaking, the state machine can return to wake-word standby.
test('SPEAKING may transition back to LISTENING_FOR_WAKE_WORD', () => {
  const fsm = new core.VoiceStateMachine();
  fsm.transition('LISTENING_FOR_WAKE_WORD');
  fsm.transition('LISTENING_FOR_COMMAND');
  fsm.transition('THINKING');
  fsm.transition('SPEAKING');
  assert.equal(fsm.transition('LISTENING_FOR_WAKE_WORD'), 'LISTENING_FOR_WAKE_WORD');
});

// 8. The next wake word works immediately after returning to standby.
test('fresh wake word after standby is accepted, contaminated audio is not', () => {
  assert.equal(decide('Jarvis', { mode: 'LISTENING_FOR_WAKE_WORD' }).action, 'ack');
  assert.equal(decide('Jarvis, open youtube', { mode: 'LISTENING_FOR_WAKE_WORD' }).action, 'command');
  // Bare wake word overlapping our own just-finished speech cannot re-trigger.
  const selfWake = decide('Jarvis', { mode: 'LISTENING', contaminated: true });
  assert.equal(selfWake.action, 'ignore');
  assert.equal(selfWake.reason, 'contaminated-bare-wake');
});

// 9. Recognition errors do not leave the assistant permanently stuck.
test('ERROR always has a valid path back to a listening state', () => {
  for (const next of ['LISTENING_FOR_WAKE_WORD', 'LISTENING_FOR_COMMAND', 'IDLE']) {
    const fsm = new core.VoiceStateMachine();
    fsm.transition('LISTENING_FOR_WAKE_WORD');
    fsm.transition('ERROR');
    assert.equal(fsm.transition(next), next);
  }
  // The machine still rejects nonsense transitions.
  const fsm = new core.VoiceStateMachine();
  assert.throws(() => fsm.transition('SPEAKING'), /Invalid JARVIS voice transition/);
});

// 10a. Stop barge-in works, but our own words can never stop us.
test('short stop cuts speech; own speech containing stop does not', () => {
  const barge = decide('stop', { mode: 'SPEAKING' });
  assert.equal(barge.action, 'stop-barge');
  const selfStop = decide('stop', { mode: 'SPEAKING', echoCurrent: true });
  assert.equal(selfStop.action, 'ignore');
  // "Stop the music" names a different target and must not kill speech.
  const music = decide('stop the music', { mode: 'SPEAKING' });
  assert.notEqual(music.action, 'stop-barge');
});

// 10b. Confident wake interrupts speech; mid-sentence look-alikes do not.
test('only a confident start-of-utterance wake match interrupts', () => {
  const interrupt = decide('Jarvis open youtube', { mode: 'SPEAKING' });
  assert.equal(interrupt.action, 'interrupt');
  assert.equal(interrupt.command, 'open youtube');
  const noise = decide('I told you obviously not to', { mode: 'SPEAKING' });
  assert.equal(noise.action, 'ignore');
});

// Overlap gate: playback-contaminated audio is flagged, clean audio is not.
test('utteranceOverlapsPlayback flags TTS-contaminated audio only', () => {
  const tts = { ttsStartedAt: 10_000, ttsEndedAt: 15_000 };
  assert.equal(core.utteranceOverlapsPlayback({ startedAt: 11_000, endedAt: 13_000 }, tts), true, 'audio during playback');
  assert.equal(core.utteranceOverlapsPlayback({ startedAt: 5_000, endedAt: 6_000 }, tts), false, 'commanding utterance ended before playback');
  assert.equal(core.utteranceOverlapsPlayback({ startedAt: 15_200, endedAt: 16_000 }, tts), true, 'reverb tail inside settle window');
  assert.equal(core.utteranceOverlapsPlayback({ startedAt: 20_000, endedAt: 21_000 }, tts), false, 'later speech is clean');
  assert.equal(core.utteranceOverlapsPlayback({ startedAt: 11_000, endedAt: 12_000 }, {}), false, 'no playback, no contamination');
  // Still playing (no end stamp): overlapping audio is contaminated.
  assert.equal(core.utteranceOverlapsPlayback({ startedAt: Date.now() - 100, endedAt: Date.now() }, { ttsStartedAt: Date.now() - 5000 }), true);
});

// A real wake word with a command still works even if it overlapped playback.
test('contaminated audio with a real wake word and command is kept', () => {
  const heard = 'Jarvis, open youtube';
  const result = decide(heard, { mode: 'SPEAKING', contaminated: true, wake: core.parseWakeTranscript(heard, 'Jarvis') });
  assert.equal(result.action, 'command');
  assert.equal(result.command, 'open youtube');
});

// Strict wake-word rule: the no-wake-word window opens only for the
// acknowledgement or while a workflow waits for its answer. Finished answers
// and idle states return to wake-word standby.
test('follow-up window arms only for ack prompts and pending workflows', () => {
  assert.deepEqual(core.shouldArmFollowUp({ ackPrompt: true, recognitionEnabled: true }), { armed: true, ms: 5000, reason: 'ack' });
  for (const kind of ['calendar', 'email', 'discord']) {
    const result = core.shouldArmFollowUp({ pendingKind: kind, recognitionEnabled: true });
    assert.equal(result.armed, true, kind);
    assert.equal(result.reason, `pending-${kind}`);
  }
  assert.deepEqual(core.shouldArmFollowUp({ recognitionEnabled: true }), { armed: false, ms: 0, reason: 'standby' });
  assert.deepEqual(core.shouldArmFollowUp({ pendingKind: 'calendar', recognitionEnabled: false }), { armed: false, ms: 0, reason: 'mic-off' });
  assert.deepEqual(core.shouldArmFollowUp({}), { armed: false, ms: 0, reason: 'mic-off' });
  assert.equal(core.FOLLOW_UP_WINDOW_MS, 5000);
  // A pending question must not outlive the window: shouldArmFollowUp takes
  // Math.max(window, remaining-TTL), so a longer TTL silently keeps the mic hot
  // after the window was shortened. This is the guard for that trap.
  const pending = core.createPendingQuestion({ kind: 'mode', intent: 'study', question: 'x', ttlMs: core.MODE_FOLLOWUP_MS, now: Date.now() });
  const armed = core.shouldArmFollowUp({ recognitionEnabled: true, pending });
  assert.equal(armed.armed, true);
  assert.equal(armed.ms, 5000, 'pending question must not extend the window past 5s');
  assert.equal(pending.ttlMs, core.MODE_FOLLOWUP_MS);
});

// A completed interaction needs a fresh wake word: background speech with no
// window armed is ignored even right after a response finished.
test('post-response background speech without an armed window is ignored', () => {
  const result = decide('open youtube', { mode: 'LISTENING', wakeArmed: false });
  assert.equal(result.action, 'ignore');
  assert.equal(result.reason, 'no-wake');
});

// Pending questions accept plain answers; expiry and cancellation clear state.
test('pending workflows resolve answers, expiry, and cancellation distinctly', () => {
  const flow = core.parseCalendarFlowStart('schedule a meeting tomorrow');
  assert.ok(flow && !flow.completed);
  const answered = core.advancePendingFlow(flow, '4 PM');
  assert.equal(answered.type, 'answer');
  assert.equal(answered.flow.step, 'duration');
  const finished = core.advancePendingFlow(answered.flow, 'one hour');
  assert.equal(finished.type, 'complete');
  assert.equal(core.parseNaturalTime(finished.flow.values.time).hour, 16);
  const flow2 = core.parseCalendarFlowStart('schedule a meeting tomorrow');
  assert.equal(core.advancePendingFlow(flow2, 'never mind').type, 'cancelled');
  const stale = { ...core.parseCalendarFlowStart('schedule a meeting tomorrow'), expiresAt: Date.now() - 1 };
  assert.equal(core.advancePendingFlow(stale, '4 PM').type, 'expired');
});

// AI diagnostic command parsing stays out of the way of normal questions.
test('ai-diagnose command phrases parse, nearby questions do not', () => {
  for (const phrase of ['check AI status', 'is Ollama running', 'diagnose ai', 'ai health', 'check the AI', 'ollama up', 'check AI status please']) {
    assert.equal(core.parseAiDiagnoseCommand(phrase), true, phrase);
  }
  for (const phrase of ['what can you do', 'is Ollama a company', 'check my calendar', 'how is the AI today']) {
    assert.equal(core.parseAiDiagnoseCommand(phrase), false, phrase);
  }
});
