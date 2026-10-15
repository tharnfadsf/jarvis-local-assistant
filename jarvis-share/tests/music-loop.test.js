'use strict';
// Music-loop regression tests (2026-10-14). Pin the two runaway behaviors:
// repeated "Magnetic" searches and self-triggered unprompted speech.
// Pure guards only — live audio/browser behavior is verified in the desktop
// app per the task checklist.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../jarvis-core.js');

test('bare single-word music is conversational, not a search', () => {
  assert.equal(Core.parseMusicIntent('magnetic'), null);
  assert.equal(Core.parseMusicIntent('Magnetic by ILLIT'), null);
  assert.equal(Core.parseMusicIntent('illit'), null);
  // Explicit playback verbs still search.
  assert.deepEqual(Core.parseMusicIntent('play magnetic'), { kind: 'search', query: 'magnetic' });
  // The user's own connective is preserved: "Magnetic by ILLIT" stays a
  // whole artist-qualified query for both casing variants.
  assert.deepEqual(Core.parseMusicIntent('play Magnetic by ILLIT'), { kind: 'search', query: 'Magnetic by ILLIT' });
  assert.deepEqual(Core.parseMusicIntent('Play Magnetic by ILLIT'), { kind: 'search', query: 'Magnetic by ILLIT' });
});

test('music mode off / cancel phrasings exit the mode', () => {
  for (const s of ['music mode off', 'turn music mode off', 'exit music mode', 'cancel music', 'stop searching', 'quit music mode', 'exit this mode']) {
    const hit = Core.parseModeIntent(s);
    assert.ok(hit && hit.mode === '__exit', s);
  }
  // Bare "stop"/"cancel that" and "stop the music" do NOT exit music mode:
  // they belong to flows and media transport.
  assert.equal(Core.parseModeIntent('stop'), null);
  assert.equal(Core.parseModeIntent('cancel that'), null);
  assert.equal(Core.parseModeIntent('stop the music'), null);
});

test('duplicate music search is suppressed within the cooldown', () => {
  const now = 1_000_000;
  const first = Core.musicSearchPolicy({ query: 'Magnetic ILLIT', history: [], now });
  assert.equal(first.allow, true);
  const second = Core.musicSearchPolicy({ query: 'Magnetic ILLIT', history: first.history, now: now + 5000 });
  assert.equal(second.allow, false);
  assert.equal(second.reason, 'duplicate');
  // After 60 s the same query is allowed again.
  const later = Core.musicSearchPolicy({ query: 'Magnetic ILLIT', history: second.history, now: now + 70000 });
  assert.equal(later.allow, true);
});

test('an explicit retry word re-enables the same query immediately', () => {
  const now = 2_000_000;
  const first = Core.musicSearchPolicy({ query: 'Magnetic ILLIT', history: [], now });
  const again = Core.musicSearchPolicy({ query: 'Magnetic ILLIT', transcript: 'play it again', history: first.history, now: now + 2000 });
  assert.equal(again.allow, true);
  assert.equal(again.reason, 'explicit-retry');
});

test('three identical searches without a request trip the loop guard', () => {
  let history = [], out;
  const now = 3_000_000;
  for (const step of [0, 30000, 60000]) {
    out = Core.musicSearchPolicy({ query: 'Magnetic ILLIT', history, now: now + step });
    history = out.history;
  }
  assert.equal(out.allow, false);
  assert.equal(out.reason, 'loop-trip');
});

test('an empty query never searches', () => {
  const r = Core.musicSearchPolicy({ query: '   ', history: [], now: 4_000_000 });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'empty');
});

test('own TTS tail cannot pass the echo exemption; a real answer can', () => {
  const base = { pendingActive: true, words: 2, contaminated: false };
  // During the post-playback blackout: blocked.
  assert.equal(Core.echoExemptAllowed({ ...base, startedAt: 10000, ttsEndedAt: 9000 }), false);
  assert.equal(Core.echoExemptAllowed({ ...base, startedAt: 10000, ttsEndedAt: 5000 }), false);
  // Real answer 3 s after playback ended: allowed.
  assert.equal(Core.echoExemptAllowed({ ...base, startedAt: 12000, ttsEndedAt: 9000 }), true);
  // Anything contaminated, long, or with no pending question: blocked.
  assert.equal(Core.echoExemptAllowed({ ...base, startedAt: 12000, ttsEndedAt: 9000, contaminated: true }), false);
  assert.equal(Core.echoExemptAllowed({ ...base, words: 9, startedAt: 12000, ttsEndedAt: 9000 }), false);
  assert.equal(Core.echoExemptAllowed({ ...base, pendingActive: false, startedAt: 12000, ttsEndedAt: 9000 }), false);
});

test('hesitation and unclear answers still classify as filler/unsure', () => {
  for (const s of ['um', 'ugh', 'hmm', 'uh', 'er', "i don't know", 'not sure']) {
    const v = Core.classifyMusicAnswer(s);
    assert.ok(v.kind === 'filler' || v.kind === 'unsure', s);
  }
  assert.equal(Core.classifyMusicAnswer('Magnetic').kind, 'request');
  assert.equal(Core.classifyMusicAnswer('Magnetic by ILLIT').kind, 'request');
  assert.equal(Core.classifyMusicAnswer('play anything').kind, 'anything');
  assert.equal(Core.classifyMusicAnswer('nothing').kind, 'nothing');
});
