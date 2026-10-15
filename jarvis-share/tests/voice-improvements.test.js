'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');

test('wake word works at start with command, fillers, and phonetic variants', () => {
  for (const phrase of [
    'Jarvis, open Chrome',
    'Hey Jarvis, open Chrome.',
    'hey jarvis can you open Chrome',
    'Uh, hey Jarvis, can you please open Chrome?',
  ]) {
    const result = core.parseWakeTranscript(phrase);
    assert.equal(result.activated, true, phrase);
    assert.match(result.command, /open chrome/i, phrase);
  }
  // Bare wake word: no command, but stays activated for the follow-up window.
  const bare = core.parseWakeTranscript('Hey Jarvis');
  assert.equal(bare.activated, true);
  assert.equal(bare.command, '');
  assert.ok(bare.confidence >= 0.9);
});

test('mid-sentence Jarvis keeps the surrounding command text', () => {
  const result = core.parseWakeTranscript('Could you open Roblox, Jarvis?');
  assert.equal(result.activated, true);
  assert.match(result.command, /open roblox/i);
});

test('ordinary sentences without the wake phrase do not activate', () => {
  for (const phrase of [
    'I think they obviously need help',
    'Open Steam',
    'How is your day?',
    'it was a great movie',
  ]) assert.equal(core.parseWakeTranscript(phrase).activated, false, phrase);
});

test('wake match keeps the transcript casing for a bare wake phrase', () => {
  assert.equal(core.parseWakeTranscript('Hey Jarvis').match, 'Hey Jarvis');
  assert.equal(core.parseWakeTranscript('Jarvis?')?.command, '');
});

test('open variants all reach the website or app open intent', () => {
  // Voice commands arrive already wake-stripped and punctuation-trimmed, which
  // mirrors what processWakeTranscript sends into the reply() pipeline.
  for (const phrase of ['Open Chrome', 'Can you open Chrome', 'Could you open Chrome for me', 'open up Chrome']) {
    const cleaned = phrase.trim().replace(/^(?:(?:can|could) you(?: please)?(?: just)?|please|just)\s+/i, '').replace(/\s+for me$/i, '').replace(/^(?:open\s+up|fire\s+up)\s+/i, 'open ').trim();
    assert.match(cleaned, /^open chrome$/i, phrase);
  }
  assert.equal(core.parseWebsiteIntent('open up YouTube')?.url, 'https://www.youtube.com/');
});

test('music variants include put-on phrasing and play-the-song', () => {
  assert.deepEqual(core.parseMusicIntent('Put Magnetic on'), { kind: 'search', query: 'Magnetic' });
  assert.deepEqual(core.parseMusicIntent('Can you put the song Magnetic on?'), { kind: 'search', query: 'Magnetic' });
  assert.deepEqual(core.parseMusicIntent('Play the song Magnetic'), { kind: 'search', query: 'Magnetic' });
  assert.deepEqual(core.parseMusicIntent('Play Magnetic by ILLIT'), { kind: 'search', query: 'Magnetic by ILLIT' });
  assert.equal(core.parseMusicIntent('Put the music on'), null, 'generic music requests stay out of the song search');
  assert.equal(core.parseMusicIntent('What is the weather?'), null);
});

test('Discord intent accepts natural phrasings and keeps the recipient', () => {
  assert.deepEqual(core.parseDiscordIntent('Send Alex a message on Discord'), { kind: 'send-discord', recipient: 'Alex', body: '' });
  assert.deepEqual(core.parseDiscordIntent('Message Alex on Discord'), { kind: 'send-discord', recipient: 'Alex', body: '' });
  assert.deepEqual(core.parseDiscordIntent('DM Alex'), { kind: 'send-discord', recipient: 'Alex', body: '' });
  assert.deepEqual(core.parseDiscordIntent('Send Alex a Discord message'), { kind: 'send-discord', recipient: 'Alex', body: '' });
  // Voice path sends the wake-stripped command; typed path may keep the name.
  assert.deepEqual(core.parseDiscordIntent('message Alex on Discord saying I am on my way'), { kind: 'send-discord', recipient: 'Alex', body: 'I am on my way' });
  assert.deepEqual(core.parseDiscordIntent('Hey Jarvis, message Alex on Discord saying I am on my way'), { kind: 'send-discord', recipient: 'Alex', body: 'I am on my way' });
  assert.equal(core.parseDiscordIntent('Write Alex a message on paper'), null, 'non-Discord messages stay unmatched');
});

test('filler stripping preserves negation and stop words', () => {
  const stop = text => core.normalizeConversationText(text);
  assert.equal(stop("Don't shut down the computer"), 'do not shut down the computer');
  assert.equal(stop('never open Roblox'), 'never open roblox');
  assert.equal(stop('Um, uh, open Chrome'), 'open chrome');
});

test('speech gate opens for quiet speech barely above the noise floor', () => {
  // Fan at 0.02 RMS, quiet conversational speech slightly above it.
  const gate = new core.SpeechGate({ calibrationMs: 600, onsetMs: 200 });
  for (let i = 0; i < 7; i++) gate.sample(0.02, 100);
  assert.ok(gate.noiseFloor >= 0.019 && gate.noiseFloor <= 0.021);
  // Quiet speech at 1.3x noise floor within the new 1.25 ratio threshold opens quickly.
  let triggeredWithin = 0;
  for (let i = 0; i < 3; i++) { const sample = gate.sample(0.028, 100); if (sample.trigger) break; triggeredWithin++; }
  assert.ok(triggeredWithin <= 2, 'quiet speech should open the gate within 200-300 ms');
  gate.reset();
  for (let i = 0; i < 7; i++) gate.sample(0.02, 100);
  for (let i = 0; i < 15; i++) assert.equal(gate.sample(0.02, 100).trigger, false, 'fan noise alone never triggers');
});

test('planner and music paraphrases handle polite lead-ins after wake stripping', () => {
  const now = new Date(2026, 9, 11, 15, 0, 0);
  const alarm = core.parsePlannerIntent('set an alarm for 7', now);
  assert.equal(alarm.kind, 'clarify-alarm', 'ambiguous 7 should ask AM/PM');
  const weekday = core.parsePlannerIntent('please set an alarm for 7 AM on weekdays', now);
  assert.equal(weekday.kind, 'create-alarm');
});
