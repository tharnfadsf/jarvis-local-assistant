'use strict';
// Tests for AI-driven command routing (hybrid fast-path + Ollama planner).
//
// Pure-function tests: complexity gating, task-reference resolution, and the
// watch-verb mapping. Live orchestration against real Ollama plus real tool
// execution is verified separately and reported alongside these results.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');

test('simple commands keep the fast path (no planner)', () => {
  const fast = [
    'What time is it?',
    'Stop speaking.',
    'Set a timer for five minutes.',
    'Open Calculator.',
    'What can you do?',
    'Hey Jarvis, open YouTube',
    'pause the music',
    'close the YouTube tab',
    'message Alex hi there',
    'write an email',
    'list tabs',
    'find the Roblox folder',
    'search my files for Roblox',
    'play Magnetic'
  ];
  for (const input of fast) assert.equal(core.needsAiPlanning(input), false, input);
});

test('compound and referential requests route to the AI planner', () => {
  const planned = [
    'Find the Roblox folder and tell me what is in there.',
    'Find my Roblox files, open the relevant one, and explain what it does.',
    'Can you find the Roblox project and check its contents?',
    'Find that folder, look inside, and tell me which file contains my project.',
    'Check my calendar and tell me when I am free tomorrow.',
    'Play Magnetic and tell me about it'
  ];
  for (const input of planned) assert.equal(core.needsAiPlanning(input), true, input);
});

test('task references resolve against prior results without guessing', () => {
  const results = [
    { id: 'a1', name: 'Roblox', path: 'C:\\t\\Roblox', type: 'folder' },
    { id: 'b2', name: 'notes.txt', path: 'C:\\t\\notes.txt', type: 'file' },
    { id: 'c3', name: 'archive', path: 'C:\\t\\archive', type: 'folder' }
  ];
  assert.equal(core.resolveTaskReference('open that folder', results).id, 'a1');
  assert.equal(core.resolveTaskReference('look inside the folder', results).id, 'a1');
  assert.equal(core.resolveTaskReference('open that file', results).id, 'b2');
  assert.equal(core.resolveTaskReference('read the first file', results).id, 'b2');
  assert.equal(core.resolveTaskReference('open that folder', []), null);
  const filesOnly = [{ id: 'b2', name: 'notes.txt', path: 'C:\\t\\notes.txt', type: 'file' }];
  assert.equal(core.resolveTaskReference('open that folder', filesOnly), null, 'a folder request must not match a file');
  assert.equal(core.resolveTaskReference('show me my open tabs', results), null);
});

test('watch maps to YouTube search results, opened not silent', () => {
  const result = core.parseSiteSearchIntent('watch Magnetic on youtube');
  assert.ok(result, 'watch must parse');
  assert.equal(result.site, 'youtube');
  assert.equal(result.silent, false, 'video results open visibly');
});

test('research commands parse, nearby phrases do not', () => {
  assert.deepEqual(core.parseResearchCommand('research backyard chickens'), { query: 'backyard chickens' });
  assert.deepEqual(core.parseResearchCommand('look into solar panels'), { query: 'solar panels' });
  assert.deepEqual(core.parseResearchCommand('Jarvis, dig into electric cars please'), { query: 'electric cars' });
  assert.equal(core.parseResearchCommand('research'), null);
  assert.equal(core.parseResearchCommand('what is the weather'), null);
  assert.equal(core.parseResearchCommand('search cats'), null);
});

test('music search confirmations vary and never claim playback', () => {
  const library = require('../conversation-library.json');
  const intent = library.categories.flatMap(c => c.intents || []).find(i => i.id === 'music_search');
  assert.ok(intent, 'music_search intent must exist');
  assert.ok(intent.responses.length >= 5, 'several distinct confirmations');
  for (const response of intent.responses) {
    assert.ok(response.includes('{query}'), 'each confirmation names the query');
    assert.ok(!/now playing|playing now|is playing|started playing/i.test(response), 'no playback claims');
  }
  const first = core.chooseConversationResponse(library, 'music_search', [], () => 0, { query: 'Magnetic' });
  const second = core.chooseConversationResponse(library, 'music_search', [first], () => 0, { query: 'Magnetic' });
  assert.ok(first.includes('Magnetic') && second.includes('Magnetic'));
  assert.notEqual(first, second, 'no immediate repeat');
});

test('play-this-song and look-up equivalence hold', () => {
  assert.equal(core.parseMusicControl('play this song')?.command, 'play');
  assert.equal(core.parseMusicControl('pause this song')?.command, 'pause');
  assert.equal(core.looksLikeDeterministicCommand('look up cats'), true);
});
