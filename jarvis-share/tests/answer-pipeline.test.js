'use strict';
// Regression tests for the echoed-response + raw-JSON leak.
//
// The bug: a small local model sometimes returned the structured response
// CONTRACT itself instead of an answer. Because the server streamed the raw
// model output as tokens and the client's normalizeResponseText() could only
// unwrap *complete, valid* JSON, a truncated envelope ("Jarvis, what should
// I do this afternoon?") reached the conversation UI as raw JSON — and when
// the model parsed cleanly, it happily echoed the user's request back.
//
// These tests pin the shared recovery + quality gate in jarvis-core.js, the
// server no longer emitting envelopes as display text, and the client never
// passing an envelope through to the conversation or to TTS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../jarvis-core.js');
const root = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

// The exact envelope reported by the user.
const REPORTED_ECHO = JSON.stringify({
  response_text: 'Jarvis, what should I do this afternoon?',
  speech_text: 'Jarvis, what should I do this afternoon?',
  emotion: 'calm',
  emotion_intensity: 0.7,
  speaking_style: 'conversational',
  speaking_rate: 1.0,
  pause_hints: ["after 'Jarvis, what should I do this afternoon?'"],
  pronunciation_hints: { word: 'should' },
});

test('the reported echo envelope is recognized as an envelope, not prose', () => {
  assert.equal(core.looksLikeResponseEnvelope(REPORTED_ECHO), true);
});

test('a truncated envelope is recognized and its answer recovered', () => {
  // Real output captured from the live server: the model ran out of tokens
  // part-way through the object, so JSON.parse could never succeed.
  const truncated = '{\n  "response_text": "It\'s great to hear you\'re planning something! First, could you clarify what you\'re interested in? Are you looking for recommendations, a task to complete,';
  assert.equal(core.looksLikeResponseEnvelope(truncated), true);
  const recovered = core.recoverEnvelopeText(truncated);
  assert.ok(recovered.length > 0, 'truncated envelope must yield recoverable text');
  assert.equal(core.looksLikeResponseEnvelope(recovered), false);
  assert.ok(!recovered.includes('response_text'), 'recovery must not leak field names');
});

test('a complete envelope recovers its response_text', () => {
  assert.equal(core.recoverEnvelopeText(REPORTED_ECHO), 'Jarvis, what should I do this afternoon?');
});

test('recovery handles escaped quotes and newlines', () => {
  assert.equal(core.recoverEnvelopeText('{ "response_text": "He said \\"hi\\"", "speech_text": "x" }'), 'He said "hi"');
  assert.equal(core.recoverEnvelopeText('{ "response_text": "One\\nTwo", "speech_text": "x" }'), 'One\nTwo');
});

test('recovery refuses ordinary prose, including prose naming a contract field', () => {
  assert.equal(core.recoverEnvelopeText('Photosynthesis is how plants make food.'), '');
  assert.equal(core.recoverEnvelopeText('The response_text field is internal, sir.'), '');
  assert.equal(core.recoverEnvelopeText('Use {braces} carefully in JSON, sir.'), '');
  assert.equal(core.recoverEnvelopeText(''), '');
});

test('the echo is rejected, with and without the wake word', () => {
  const q = 'what should I do this afternoon?';
  for (const answer of [
    'Jarvis, what should I do this afternoon?',
    'what should I do this afternoon?',
    'Hey Jarvis, what should I do this afternoon?',
    'Jarvis, what should I do this afternoon',
  ]) {
    const v = core.answerQuality(answer, { question: q });
    assert.equal(v.ok, false, `expected rejection for: ${answer}`);
    assert.equal(v.reason, 'exact-echo');
  }
});

test('raw envelopes are rejected by the quality gate', () => {
  assert.equal(core.answerQuality(REPORTED_ECHO, { question: 'what should I do this afternoon?' }).reason, 'envelope');
});

test('empty and metadata-only answers are rejected', () => {
  assert.equal(core.answerQuality('', { question: 'anything' }).reason, 'empty');
  assert.equal(core.answerQuality('   ', { question: 'anything' }).reason, 'empty');
  assert.equal(core.answerQuality('emotion: calm, speaking_rate: 1.0', { question: 'anything' }).reason, 'metadata-only');
});

test('legitimate answers are NOT rejected (regression guard)', () => {
  const good = [
    ['144 divided by 12 is 12.', 'what is 144 divided by 12?'],
    ['Photosynthesis is the process by which plants convert light energy into chemical energy inside chloroplasts.', 'explain how photosynthesis works.'],
    ['Why do not scientists trust atoms? Because they make up everything!', 'tell me a joke.'],
    ['You are holding a pale, translucent cylindrical object with a screw cap.', 'what am I holding?'],
    ['The capital of France is Paris.', 'what is the capital of France?'],
    ['Yes, sir.', 'yes'],
    ['I have opened Notepad for you, sir.', 'open notepad'],
    ['You asked me to summarize the screen. It shows a code editor with three files open.', 'summarize what is on my screen.'],
  ];
  for (const [answer, question] of good) {
    const v = core.answerQuality(answer, { question });
    assert.equal(v.ok, true, `should accept: ${answer} (got ${v.reason})`);
  }
});

test('bare stubs ending in "ready" are rejected, real confirmations pass', () => {
  for (const stub of ['Roblox house ready.', 'Roblox house ready', 'System ready', 'Music ready.']) {
    const v = core.answerQuality(stub, { question: 'open roblox' });
    assert.equal(v.ok, false, `expected rejection for: ${stub}`);
    assert.equal(v.reason, 'stub');
  }
  for (const good of ['Roblox is ready.', 'Roblox is open, Sir.', 'Yes, sir.', 'Done, Sir.']) {
    const v = core.answerQuality(good, { question: 'open roblox' });
    assert.equal(v.ok, true, `should accept: ${good} (got ${v.reason})`);
  }
});

test('the server holds back envelope tokens so raw JSON never reaches the UI', () => {
  assert.ok(serverSrc.includes('holdEnvelope'), 'streaming must gate envelope tokens');
  assert.ok(serverSrc.includes('if (!holdEnvelope &&'), 'envelope detection must gate token emission');
  assert.ok(serverSrc.includes("{ holdEnvelope = true; emit({ type: 'reset' }); }"), 'partial envelope must be cleared from the live bubble');
});

test('the server recovers, retries once, then reports honestly', () => {
  assert.ok(serverSrc.includes('core.recoverEnvelopeText'), 'server must recover truncated envelopes');
  assert.ok(serverSrc.includes('core.answerQuality'), 'server must gate answer quality');
  assert.ok(serverSrc.includes('qualityRetries < 1'), 'retry must be bounded to one attempt');
  assert.ok(!/return \{ ok: true, response: parsed\.response_text/.test(serverSrc), 'must not return an unvalidated structured response');
});

test('the client normalizer delegates to the shared schema-aware recovery', () => {
  const fn = appSrc.match(/function normalizeResponseText\(text\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, 'normalizeResponseText must exist');
  assert.ok(fn[0].includes('Core.looksLikeResponseEnvelope'), 'must use the shared envelope detector');
  assert.ok(fn[0].includes('Core.recoverEnvelopeText'), 'must use the shared recovery');
  assert.ok(/My local model returned an incomplete answer/.test(fn[0]), 'must have an honest fallback instead of passing the raw envelope through');
});

test('the client delivery gate exists for model answers only', () => {
  assert.ok(appSrc.includes('Core.answerQuality(displayText'), 'ask() must gate model answers before display');
  assert.ok(appSrc.includes('answer rejected before display'), 'rejected answers must be logged');
});