'use strict';
// Regression tests for the calendar / music / browser-tab repair.
//
// Pure-function tests (no browser, no microphone): intent parsing, music-tab
// resolution against fake tab lists, and validation ordering. Live-server
// coverage (planner CRUD, music status shape, safe tab-close) extends
// tests/server.test.js. Nothing here opens tabs, closes tabs, plays audio,
// or touches the real planner-data.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');
const tabs = require('../browser-tabs.js');

test('"cancel/delete that event" resolves to the recent event instead of failing', () => {
  for (const phrase of ['cancel that event', 'delete that event', 'cancel the event', 'cancel it', 'remove that event', 'delete that meeting']) {
    const intent = core.parsePlannerIntent(phrase);
    assert.ok(intent, phrase);
    assert.equal(intent.kind, 'cancel-event-query', phrase);
    assert.equal(intent.query, '', `${phrase} must fall back to the recent event`);
  }
});

test('named cancellations keep their query and alarms stay on the alarm path', () => {
  assert.deepEqual(core.parsePlannerIntent('cancel dentist meeting'), { kind: 'cancel-event-query', query: 'dentist meeting' });
  assert.deepEqual(core.parsePlannerIntent('delete my dentist appointment'), { kind: 'cancel-event-query', query: 'dentist appointment' });
  const alarm = core.parsePlannerIntent('cancel the 7 AM alarm');
  assert.equal(alarm.kind, 'cancel-alarm');
});

test('schedule-list phrasings retrieve the actual calendar', () => {
  for (const phrase of ['open the calendar', 'show my events', 'show my calendar', 'list my events', 'what is on my schedule', 'what was I supposed to do today']) {
    assert.deepEqual(core.parsePlannerIntent(phrase), { kind: 'list-events', day: 'today' }, phrase);
  }
  assert.deepEqual(core.parsePlannerIntent("show me tomorrow's schedule"), { kind: 'list-events', day: 'tomorrow' });
});

test('edit and reschedule resolve to a move with a new start time', () => {
  const moved = core.parsePlannerIntent('reschedule dentist meeting to tomorrow at 5 PM');
  assert.equal(moved.kind, 'move-event-query');
  assert.equal(moved.query, 'dentist meeting');
  assert.ok(Date.parse(moved.start) > Date.now(), 'new start is in the future');
  const bare = core.parsePlannerIntent('edit dentist meeting');
  assert.equal(bare.kind, 'clarify');
  assert.match(bare.message, /move dentist meeting to tomorrow/);
  const article = core.parsePlannerIntent('move the dentist meeting to Friday at 3 PM');
  assert.equal(article.kind, 'move-event-query');
  assert.equal(article.query, 'dentist meeting', 'leading article must not break title matching');
});

test('cancel-during-flow still abandons bare cancels only', () => {
  assert.equal(core.isFlowCancel('cancel'), true);
  assert.equal(core.isFlowCancel('never mind'), true);
  assert.equal(core.isFlowCancel('delete it'), true);
  // Event-named cancellations are NOT flow cancels: the app routes them to
  // the calendar while keeping an unrelated workflow alive.
  assert.equal(core.isFlowCancel('cancel that event'), false);
  assert.equal(core.isFlowCancel('delete that event'), false);
  assert.ok(core.parsePlannerIntent('cancel the event').kind === 'cancel-event-query');
});

test('"close the tab playing music" targets music tabs, "for youtube" targets the site', () => {
  assert.deepEqual(core.parseCloseIntent('close the tab playing music'), { kind: 'close-music-tab' });
  assert.deepEqual(core.parseCloseIntent('close the tab for youtube'), { kind: 'close-named-tab', query: 'youtube' });
  assert.deepEqual(core.parseCloseIntent('close the YouTube tab'), { kind: 'close-named-tab', query: 'YouTube' });
  assert.deepEqual(core.parseCloseIntent('close this tab'), { kind: 'close-current-tab' });
});

test('music-tab resolution picks music service tabs only', async () => {
  const listed = { tabs: [
    { id: 'a', index: 0, title: 'Inbox', url: 'https://mail.google.com/' },
    { id: 'b', index: 1, title: 'Magnetic - ILLIT', url: 'https://music.youtube.com/watch?v=x' },
    { id: 'c', index: 2, title: 'Docs', url: 'https://docs.google.com/' }
  ] };
  const single = await tabs.resolveTarget(listed, { music: true });
  assert.equal(single.ok, true);
  assert.equal(single.target.id, 'b');
  const two = await tabs.resolveTarget({ tabs: [...listed.tabs, { id: 'd', index: 3, title: 'Spotify', url: 'https://open.spotify.com/track/y' }] }, { music: true });
  assert.equal(two.ok, false);
  assert.equal(two.status, 'ambiguous');
  assert.ok(two.matches.length === 2);
  const none = await tabs.resolveTarget({ tabs: [listed.tabs[0]] }, { music: true });
  assert.equal(none.ok, false);
  assert.match(none.message, /could not find a tab playing music/);
});

test('navigateTab validates the URL before touching the browser', async () => {
  const bad = await tabs.navigateTab('not a url', {});
  assert.equal(bad.ok, false);
  assert.match(bad.message, /web page/);
});
