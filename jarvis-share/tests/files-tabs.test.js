'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');

test('file search intent parses query, folder, extension, latest, and age', () => {
  const plain = core.parseFileSearchIntent('find my homework');
  assert.equal(plain.query, 'homework');
  assert.equal(plain.folder, '');

  const latest = core.parseFileSearchIntent('find my latest file');
  assert.ok(latest, '"find my latest file" must still be a search');
  assert.equal(latest.latest, true);

  const folder = core.parseFileSearchIntent('where did I save my project in documents');
  assert.equal(folder.folder, 'Documents');
  assert.equal(folder.query, 'project');

  const bareFolder = core.parseFileSearchIntent('find my downloads folder');
  assert.equal(bareFolder.folder, 'Downloads');
  assert.equal(bareFolder.query, '');

  const pdfWeek = core.parseFileSearchIntent('find pdf files from this week');
  assert.equal(pdfWeek.extension, '.pdf');
  assert.equal(pdfWeek.withinDays, 7);
  assert.equal(pdfWeek.query, '', 'recency words must not leak into name tokens');

  const text = core.parseFileSearchIntent('look for text files about the budget');
  assert.equal(text.extension, '.txt');
  assert.equal(text.query, 'budget');

  assert.equal(core.parseFileSearchIntent('open chrome'), null);
  const research = core.parseFileSearchIntent('find the meaning of photosynthesis');
  assert.ok(research, 'the parser keeps the words');
  assert.equal(research.folder, '');
  assert.equal(research.extension, '');
  assert.equal(research.latest, false, 'no filters means the app routes it to the assistant, not file search');
});

test('file ranking prefers exact matches, then prefix, then recency on request', () => {
  const results = [
    { id: '1', name: 'homework-answers.txt', modified: '2026-10-01T10:00:00.000Z' },
    { id: '2', name: 'homework.txt', modified: '2026-09-01T10:00:00.000Z' },
    { id: '3', name: 'my-homework-notes.txt', modified: '2026-10-05T10:00:00.000Z' },
    { id: '4', name: 'shopping-list.txt', modified: '2026-10-09T10:00:00.000Z' }
  ];
  const ranked = core.rankFileResults(results, { query: 'homework' });
  assert.equal(ranked[0].name, 'homework.txt', 'exact base match wins');
  assert.ok(!ranked.some(item => item.id === '4'), 'files without any query token are dropped');

  const newest = core.rankFileResults(results, { query: 'homework', latest: true });
  assert.equal(newest[0].name, 'my-homework-notes.txt', 'latest-first sorts newest matching file to the top');

  const byExt = core.rankFileResults(results, { query: '', extension: '.txt', latest: true });
  assert.equal(byExt[0].name, 'shopping-list.txt');
});

test('ordinal targeting handles words, numerics, and last', () => {
  assert.deepEqual(core.parseOrdinalTarget('open the second result'), { last: false, position: 2 });
  assert.deepEqual(core.parseOrdinalTarget('open the first one'), { last: false, position: 1 });
  assert.deepEqual(core.parseOrdinalTarget('close the last tab'), { last: true, position: null });
  assert.deepEqual(core.parseOrdinalTarget('open the 3rd file'), { last: false, position: 3 });
  assert.equal(core.parseOrdinalTarget('open it'), null);
});

test('close intent keeps tab, app, and current-window targets separate', () => {
  assert.deepEqual(core.parseCloseIntent('close this tab'), { kind: 'close-current-tab' });
  assert.deepEqual(core.parseCloseIntent('close the third tab'), { kind: 'close-tab-position', position: 3, last: false });
  assert.deepEqual(core.parseCloseIntent('close the last tab'), { kind: 'close-tab-position', position: null, last: true });
  assert.deepEqual(core.parseCloseIntent('close the YouTube tab'), { kind: 'close-named-tab', query: 'YouTube' });
  assert.deepEqual(core.parseCloseIntent('close chrome'), { kind: 'close-app', name: 'chrome' });
  assert.deepEqual(core.parseCloseIntent('close it'), { kind: 'close-current-app' });
  assert.deepEqual(core.parseCloseIntent('close the calculator'), { kind: 'close-app', name: 'calculator' });
  assert.equal(core.parseCloseIntent('what time is it'), null);
});

test('echo guard ignores JARVIS speech inside the window and accepts user speech outside it', () => {
  const spoken = 'Good morning, Sir. Your calendar is clear today.';
  const now = 1_000_000;
  // Exact fragment of our own speech while recent → echo.
  assert.equal(core.isEchoTranscript('your calendar is clear', spoken, { lastSpokenAt: now - 2000, now }), true);
  // Two-word fragment entirely from our words → echo.
  assert.equal(core.isEchoTranscript('good morning', spoken, { lastSpokenAt: now - 2000, now }), true);
  // Mostly our words while playing → echo.
  assert.equal(core.isEchoTranscript('your calendar is clear today and more', spoken, { speaking: true, now }), true);
  // Outside the window → not an echo.
  assert.equal(core.isEchoTranscript('your calendar is clear', spoken, { lastSpokenAt: now - 60000, now }), false);
  // Unrelated speech while recent → not an echo.
  assert.equal(core.isEchoTranscript('open the browser please', spoken, { lastSpokenAt: now - 2000, now }), false);
  // No spoken source at all: while playing everything is guarded; when idle
  // nothing is.
  assert.equal(core.isEchoTranscript('anything at all', '', { speaking: true, lastSpokenAt: now, now }), true);
  assert.equal(core.isEchoTranscript('anything at all', '', { speaking: false, lastSpokenAt: 0, now }), false);
  // The configured window covers model latency after playback ends.
  assert.ok(core.ECHO_WINDOW_MS >= 8000);
});

test('browser tab matching is case-insensitive over title and url', () => {
  const tabs = [
    { title: 'YouTube - Music Video', url: 'https://music.youtube.com/watch' },
    { title: 'Jira Board', url: 'https://acme.atlassian.net/board' },
    { title: 'Docs', url: 'https://docs.google.com/document/d/1' }
  ];
  assert.equal(core.matchBrowserTabs(tabs, 'youtube').matches.length, 1);
  assert.equal(core.matchBrowserTabs(tabs, 'ATLASSIAN').matches.length, 1);
  assert.equal(core.matchBrowserTabs(tabs, 'nothing here').matches.length, 0);
  assert.equal(core.matchBrowserTabs(tabs, '').matches.length, 0);
  assert.equal(core.matchBrowserTabs([], 'x').matches.length, 0);
});
