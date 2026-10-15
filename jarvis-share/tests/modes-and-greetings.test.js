'use strict';
// Mode exit bugs + greeting expansion (2026-10-15). Pure logic — no browser,
// no microphone, no library network access.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../jarvis-core.js');
const library = require('../conversation-library.json');

const greetingIntent = library.categories
  .find(c => c.id === 'social').intents.find(i => i.id === 'greeting');

test('"switch to normal" leaves the mode instead of falling through', () => {
  // Regression: the switch/actually branches dropped an __exit result, so these
  // matched no alias and returned null — the user stayed in the mode they had
  // just asked to leave, with no acknowledgement at all.
  for (const spoken of ['switch to normal mode', 'switch to normal', 'change to normal mode', 'normal mode', 'normal']) {
    assert.equal(Core.parseModeIntent(spoken).mode, '__exit', spoken);
  }
  for (const spoken of ['actually normal mode', 'actually, normal mode', 'actually, normal']) {
    assert.equal(Core.parseModeIntent(spoken).mode, '__exit', spoken);
  }
  // ...while named deactivations and real mode switches still behave.
  assert.deepEqual(Core.parseModeIntent('switch off music mode').extra.forMode, 'music');
  assert.equal(Core.parseModeIntent('switch to focus mode').mode, 'focus');
  assert.equal(Core.parseModeIntent('actually lets game').mode, 'gaming');
});

test('"let\'s chat" reaches conversation mode like its sibling modes', () => {
  // Regression: "let's study" / "let's game" / "let's code" all worked, but the
  // conversation aliases had no plain "let's chat" and every phrasing returned
  // null. The added alias also had to tolerate the space in "i want to chat".
  for (const spoken of [
    "let's chat", "let's talk", 'can we chat', 'can we talk',
    'i want to chat', 'i want to talk', "i'd like to chat", "i'd love to talk",
    'let us chat',
  ]) {
    const hit = Core.parseModeIntent(spoken);
    assert.ok(hit, `should match: ${spoken}`);
    assert.equal(hit.mode, 'conversation', spoken);
  }
  assert.equal(Core.parseModeIntent('normal maths is hard'), null);
});

test('greeting composer varies widely and never doubles a question or address', () => {
  const forms = ['hello', 'whatsup', 'nice', 'howareyou', 'howgoesit', 'goodnight', 'time_morning', 'time_evening'];
  const times = ['2026-10-15T08:00:00', '2026-10-15T14:00:00', '2026-10-15T19:00:00', '2026-10-15T23:30:00']
    .map(iso => new Date(iso));
  const seen = new Set();
  for (const form of forms) for (const now of times) for (let variant = 0; variant < 40; variant++) {
    const reply = Core.composeGreetingReply({ form }, { address: 'Sir', style: 'professional', variant, now });
    assert.doesNotMatch(reply.text, /\?\s*\?/, `double question: ${reply.text}`);
    assert.doesNotMatch(reply.text, /\bSir\b.*\bSir\b/i, `double address: ${reply.text}`);
    assert.match(reply.text, /[.!?]$/, `bad punctuation: ${reply.text}`);
    seen.add(reply.text);
  }
  // "a longer one" is part of the ask: the rotation must include real long ones.
  const long = [...seen].filter(t => t.split(' ').length > 22);
  assert.ok(seen.size > 150, `expected wide variety, got ${seen.size}`);
  assert.ok(long.length > 20, `expected long greetings, got ${long.length}`);
});

test('greeting reply never contradicts the time of day', () => {
  const night = new Date('2026-10-15T23:30:00');
  for (let variant = 0; variant < 30; variant++) {
    const reply = Core.composeGreetingReply({ form: 'hello' }, { address: 'Sir', variant, now: night });
    assert.equal(reply.timeOfDay, 'night');
    assert.doesNotMatch(reply.text, /good morning|top of the morning/i, reply.text);
  }
  // Saying "good morning" at night answers with a night greeting, not a lie.
  const late = Core.composeGreetingReply({ form: 'time_morning' }, { address: 'Sir', variant: 0, now: night });
  assert.doesNotMatch(late.text, /good morning/i, late.text);
});

test('the greeting library is large, unique, and free of malformed entries', () => {
  const responses = greetingIntent.responses;
  assert.ok(responses.length > 1500, `expected a large pool, got ${responses.length}`);
  assert.equal(new Set(responses).size, responses.length, 'all greeting responses must be unique');
  for (const r of responses) {
    assert.doesNotMatch(r, /[{}<>\\]/, `placeholder or escape in: ${r}`);
    assert.doesNotMatch(r, /\?\s*\?/, `double question: ${r}`);
    assert.doesNotMatch(r, /\bSir\b.*\bSir\b/i, `double address: ${r}`);
    assert.doesNotMatch(r, /\b(\w+)\s+\1\b/i, `doubled word: ${r}`);
    assert.match(r, /[.!?]$/, `missing sentence punctuation: ${r}`);
  }
  // Neither a pool of trivia nor a wall of monologues.
  const lengths = responses.map(r => r.split(' ').length);
  assert.ok(Math.max(...lengths) > 30, 'expected at least one long greeting');
  assert.ok(responses.some(r => r.split(' ').length < 8), 'expected short greetings too');
});

test('consecutive greetings do not repeat', () => {
  let previous = Core.chooseConversationResponse(library, 'greeting', [], () => 0);
  const next = Core.chooseConversationResponse(library, 'greeting', [previous], () => 0);
  assert.notEqual(next, previous);
});