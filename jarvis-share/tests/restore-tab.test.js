'use strict';
// Restore-my-tab tests (2026-10-14). Intent routing is pure and fully
// covered here. Live Edge navigation is verified in the desktop app per the
// task checklist (Tests: bring/restore/open-again, duplicates, Chrome+Edge
// regression, TTS-before-listening).
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../jarvis-core.js');
const tabs = require('../browser-tabs.js');

const URL = 'https://www.youtube.com/watch?v=1597gE1VeU4';

test('all six example phrasings route to restore-my-tab', () => {
  for (const spoken of [
    'Hey Jarvis, bring my tab back.',
    'Hey Jarvis, get my tab back.',
    'Hey Jarvis, restore my tab.',
    'Hey Jarvis, take me back to my tab.',
    'Hey Jarvis, open my YouTube tab again.',
    'Hey Jarvis, return to my video.',
  ]) {
    const hit = Core.parseRestoreTabIntent(spoken);
    assert.ok(hit, spoken);
    assert.equal(hit.kind, 'restore-my-tab', spoken);
    assert.equal(hit.url, URL, spoken);
  }
});

test('destination URL is exact and shared by core and browser layers', () => {
  assert.equal(Core.MY_TAB_URL, URL);
  assert.equal(tabs.MY_TAB_URL, URL);
  assert.equal(tabs.EDGE_DEBUG_PORT, 9333);
});

test('close, switch, other-tab, and native-reopen phrasings never match', () => {
  for (const spoken of [
    'Hey Jarvis, close my YouTube tab.',
    'Hey Jarvis, switch to my other tab.',
    'Hey Jarvis, close that tab.',
    'Hey Jarvis, undo that.',
    'Hey Jarvis, reopen my closed tab.',
    'Hey Jarvis, what time is it?',
    'Hey Jarvis, open YouTube.',
  ]) {
    assert.equal(Core.parseRestoreTabIntent(spoken), null, spoken);
  }
});

test('browser layer exposes the Edge-only restore path', () => {
  assert.equal(typeof tabs.restoreMyTab, 'function');
  assert.equal(typeof tabs.openEdgeUrl, 'function');
  assert.equal(typeof tabs.discoverEdgeEndpoint, 'function');
});
