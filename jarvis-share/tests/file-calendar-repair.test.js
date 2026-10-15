'use strict';
// Regression tests for the file-search + calendar repair.
//
// Pure-function tests (no browser, no microphone): all eight required file
// phrasings, garbled-transcript behavior, non-file protection, multi-match
// ranking, calendar multi-turn preservation, and HUD singularity. Live
// evidence (real folder search, Whisper round-trip, bridge CRUD + restart)
// is reported alongside, not instead of, these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../jarvis-core.js');

const root = path.resolve(__dirname, '..');
const intent = input => core.parseFileSearchIntent(input);

test('all eight required Roblox phrasings yield a clean query', () => {
  const cases = [
    'find a folder called Roblox',
    'find files called Roblox',
    'search for Roblox',
    'find the Roblox folder',
    'look for Roblox on my computer',
    'find anything named Roblox',
    'search my files for Roblox',
    'locate the Roblox directory'
  ];
  for (const input of cases) {
    const parsed = intent(input);
    assert.ok(parsed, input);
    assert.equal(parsed.query, 'Roblox', `${input} must reduce to exactly "Roblox"`);
  }
});

test('a garbled transcript still parses but never invents a clean query', () => {
  const parsed = intent('find a foul, hard role blocks');
  assert.ok(parsed, 'the file verb still routes to file search');
  assert.ok(!/roblox/i.test(parsed.query), 'routing must not hallucinate the intended word');
  assert.ok(parsed.query.length > 0, 'the raw words are preserved for the clarification reply');
});

test('non-file sentences keep going to the assistant, not file search', () => {
  const research = intent('find the meaning of photosynthesis');
  assert.ok(research, 'parser keeps the words');
  assert.equal(research.explicit, false, 'no file markers means the app gate must not fire');
  assert.equal(intent('open chrome'), null);
  assert.equal(intent('find all'), null, 'a content-free query is not a search');
});

test('duplicate names in different locations all survive ranking', () => {
  const results = [
    { id: '1', name: 'Roblox', path: 'C:\\Users\\t\\Desktop\\Roblox', modified: '', type: 'folder' },
    { id: '2', name: 'RobloxPlayer.exe', path: 'C:\\Games\\RobloxPlayer.exe', modified: '', type: 'file' },
    { id: '3', name: 'roblox-notes.txt', path: 'C:\\Users\\t\\Documents\\roblox-notes.txt', modified: '', type: 'file' }
  ];
  const ranked = core.rankFileResults(results, { query: 'Roblox' });
  assert.equal(ranked.length, 3, 'no match may be dropped silently');
  assert.ok(ranked.every(item => item.type === 'folder' || item.type === 'file'), 'type survives ranking for display');
  assert.deepEqual(core.rankFileResults([], { query: 'Roblox' }), [], 'empty in, empty out');
});

test('calendar multi-turn preserves the original request while asking', () => {
  const flow = core.parseCalendarFlowStart('schedule a meeting tomorrow');
  assert.ok(flow && !flow.completed, 'incomplete request opens the flow');
  assert.equal(flow.step, 'title', 'no title was spoken, so only the title is asked for');
  const titled = core.advancePendingFlow(flow, 'dentist appointment');
  assert.equal(titled.type, 'answer');
  assert.equal(titled.flow.step, 'time', 'the known date is skipped, not re-asked');
  const answered = core.advancePendingFlow(titled.flow, '4 PM');
  assert.equal(answered.type, 'answer');
  assert.equal(answered.flow.step, 'duration');
  const finished = core.advancePendingFlow(answered.flow, 'one hour');
  assert.equal(finished.type, 'complete');
  // Everything collected along the way is intact in the finished record.
  assert.equal(finished.flow.values.title, 'dentist appointment');
  assert.equal(finished.flow.values.date, 'tomorrow');
  assert.ok(String(finished.flow.values.time).length > 0);
});

test('calendar cancellation and expiry clear the pending state', () => {
  const flow = core.parseCalendarFlowStart('set a calendar event');
  assert.equal(core.advancePendingFlow(flow, 'cancel').type, 'cancelled');
  const flow2 = core.parseCalendarFlowStart('set a calendar event');
  assert.equal(core.advancePendingFlow(flow2, 'never mind').type, 'cancelled');
  const stale = { ...core.parseCalendarFlowStart('set a calendar event'), expiresAt: Date.now() - 1 };
  assert.equal(core.advancePendingFlow(stale, 'dentist').type, 'expired');
});

test('HUD keeps a single schedule component', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const plannerCount = (html.match(/id="plannerNow"/g) || []).length;
  assert.equal(plannerCount, 1, 'exactly one planner card may exist');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(app.includes("querySelector('.music-card')") || app.includes('querySelector(".music-card")'), 'app.js must wire the single static media card');
  assert.equal((app.match(/id="musicNow"/g) || []).length, 0, 'app.js must not create a second music card');
  assert.equal((html.match(/id="musicNow"/g) || []).length, 1, 'the music card should be part of the static HUD layout');
  assert.ok(!/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(html), 'no emojis in the HUD');
});
