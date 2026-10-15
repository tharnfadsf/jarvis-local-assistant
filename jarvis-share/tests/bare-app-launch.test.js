'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');

test('bare app names route to launch', () => {
  assert.deepEqual(core.parseBareAppName('Steam'), { kind: 'app', name: 'Steam' });
  assert.deepEqual(core.parseBareAppName('calculator'), { kind: 'app', name: 'calculator' });
  assert.deepEqual(core.parseBareAppName('Roblox'), { kind: 'app', name: 'Roblox' });
  assert.deepEqual(core.parseBareAppName('Task Manager'), { kind: 'app', name: 'Task Manager' });
  assert.deepEqual(core.parseBareAppName('YouTube'), { kind: 'site', name: 'youtube' });
  assert.deepEqual(core.parseBareAppName('Discord'), { kind: 'site', name: 'discord' });
  assert.deepEqual(core.parseBareAppName('Steam please'), { kind: 'app', name: 'Steam' });
  assert.deepEqual(core.parseBareAppName('Jarvis, Steam'), { kind: 'app', name: 'Steam' });
});

test('ordinary speech never routes to launch', () => {
  for (const s of ['I like Steam games', 'what is Steam', 'open Steam', 'Steam is downloading', 'hello', '', 'thanks', 'play Magnetic', 'the calculator app is nice', 'a steamboat']) {
    assert.equal(core.parseBareAppName(s), null, JSON.stringify(s));
  }
});

test('bare app names count as deterministic commands', () => {
  assert.equal(core.looksLikeDeterministicCommand('Steam'), true);
  assert.equal(core.looksLikeDeterministicCommand('I like Steam'), false);
});
