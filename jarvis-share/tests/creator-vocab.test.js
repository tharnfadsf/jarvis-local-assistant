'use strict';
// Creator vocabulary + correction tests (2026-10-14). Pure routing/text
// checks — no microphone or browser needed. Live search navigation is
// verified in the desktop app per the task checklist.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../jarvis-core.js');
const vocab = require('../creator-vocab.json');

test('vocabulary loads with all seed creators and the phrase category', () => {
  const stats = Core.setCreatorVocab(vocab);
  assert.equal(stats.creators, 7);
  assert.equal(stats.phrases, 1);
});

test('seed mishearings correct to canonical names in search context', () => {
  const cases = [
    ['Hey Jarvis, search ill it on YouTube.', 'ILLIT'],
    ['Hey Jarvis, find ZbingZ.', 'zbing z.'],
    ['Hey Jarvis, search prim kung.', 'PRIMKUNG'],
    ['Hey Jarvis, find guy ngid on YouTube.', 'GUYNGID'],
    ['Hey Jarvis, search nine arm.', '9arm'],
    ['Hey Jarvis, find uncannyboy.', 'Uncanny Boy'],
    ['search นายอาร์ม', '9arm'],
  ];
  for (const [spoken, canon] of cases) {
    const fix = Core.correctCreatorQuery(spoken);
    assert.ok(fix.hasCreator, spoken);
    assert.ok(fix.text.includes(canon) || fix.query.includes(canon), `${spoken} -> ${canon}`);
  }
});

test('ordinary conversation is never rewritten', () => {
  for (const s of ['my homework is hard', 'what time is it', 'tell me a joke', 'nine arm wrestles tomorrow', 'I love music']) {
    const fix = Core.correctCreatorQuery(s);
    assert.equal(fix.changed, false, s);
    assert.equal(fix.text, s, s);
  }
});

test('thanks-for-watching is a phrase, never a creator', () => {
  assert.ok(Core.matchKnownPhrase('search thanks for watching'));
  const fix = Core.correctCreatorQuery('thanks for watching');
  assert.equal(fix.hasCreator, false);
  assert.equal(Core.extractCreatorSearch('search YouTube for the phrase thanks for watching'), null);
});

test('natural creator variations extract name, topic, and flags', () => {
  assert.deepEqual(Core.extractCreatorSearch('find the official Zbing Z channel'), { name: 'Zbing Z', topic: '', officialOnly: true, similar: false });
  assert.deepEqual(Core.extractCreatorSearch("open primkung's channel"), { name: 'primkung', topic: '', officialOnly: false, similar: false });
  assert.deepEqual(Core.extractCreatorSearch('open primkung channel'), { name: 'primkung', topic: '', officialOnly: false, similar: false });
  assert.deepEqual(Core.extractCreatorSearch('show me videos by zbingz'), { name: 'zbingz', topic: '', officialOnly: false, similar: false });
  assert.deepEqual(Core.extractCreatorSearch('find videos from 9arm about technology'), { name: '9arm', topic: 'technology', officialOnly: false, similar: false });
  assert.deepEqual(Core.extractCreatorSearch('look up illit'), { name: 'illit', topic: '', officialOnly: false, similar: false });
  assert.deepEqual(Core.extractCreatorSearch('search primkung and minecraft'), { name: 'primkung', topic: 'minecraft', officialOnly: false, similar: false });
  const like = Core.extractCreatorSearch('find other channels like illit');
  assert.equal(like.name, 'illit');
  assert.equal(like.similar, true);
  const nameless = Core.extractCreatorSearch('search for more YouTube channels like these');
  assert.equal(nameless.name, '');
  assert.equal(nameless.similar, true);
});

test('non-creator commands extract nothing', () => {
  for (const s of ['what time is it', 'open Chrome', 'play Magnetic', 'my homework is hard']) {
    assert.equal(Core.extractCreatorSearch(s), null, s);
  }
});
