'use strict';
// Tests for non-destructive tab recovery, the open-tab + music-panel voice
// commands, and the Music Orb visibility state machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');
const orb = require('../music-orb.js');

test('open-tab phrases parse while app launches stay intact', () => {
  assert.deepEqual(core.parseOpenTabIntent('open a new tab'), { kind: 'open-new-tab' });
  assert.deepEqual(core.parseOpenTabIntent('Jarvis, open a new tab please'), { kind: 'open-new-tab' });
  assert.deepEqual(core.parseOpenTabIntent('new tab'), { kind: 'open-new-tab' });
  assert.equal(core.parseOpenTabIntent('open chrome'), null);
  assert.equal(core.parseOpenTabIntent('open the calendar'), null);
  assert.equal(core.parseOpenTabIntent('close this tab'), null);
});

test('music panel show/hide phrases parse without touching app close', () => {
  assert.deepEqual(core.parseMusicPanelCommand('show the music player'), { action: 'show' });
  assert.deepEqual(core.parseMusicPanelCommand('hide the music player'), { action: 'hide' });
  assert.deepEqual(core.parseMusicPanelCommand('Jarvis, open the music orb please'), { action: 'show' });
  assert.equal(core.parseMusicPanelCommand('close the YouTube tab'), null);
  assert.equal(core.parseMusicPanelCommand('play something'), null);
});

test('title-less open-song routes to clarification, titled songs still search', () => {
  assert.deepEqual(core.parseMusicIntent('open this song on YouTube Music'), { kind: 'search', query: '' });
  assert.deepEqual(core.parseMusicIntent('open this song'), { kind: 'search', query: '' });
  assert.deepEqual(core.parseMusicIntent('Play Magnetic by ILLIT'), { kind: 'search', query: 'Magnetic by ILLIT' });
});

test('orb stays hidden with no media and appears on a real session', () => {
  const hidden = { visible: false, mode: 'idle', trackKey: '', lastSeenAt: 0, dismissedKey: '', expanded: false };
  const stillHidden = orb.nextOrbState(hidden, { ok: false, message: 'nope' }, 100000, {});
  assert.equal(stillHidden.visible, false);
  const playing = { ok: true, status: 'Playing', title: 'Magnetic', artist: 'ILLIT', verified: true, tab: { url: 'https://music.youtube.com/watch?v=x' } };
  const shown = orb.nextOrbState(hidden, playing, 101000, {});
  assert.equal(shown.visible, true);
  assert.equal(shown.mode, 'playing');
  assert.ok(shown.trackKey.includes('Magnetic'));
  assert.equal(shown.lastSeenAt, 101000);
});

test('orb pauses, survives grace, then hides after stop', () => {
  const shown = { visible: true, mode: 'playing', trackKey: 'Magnetic https://music.youtube.com/watch?v=x', lastSeenAt: 200000, dismissedKey: '', expanded: false };
  const paused = orb.nextOrbState(shown, { ok: true, status: 'Paused', title: 'Magnetic', tab: { url: 'https://music.youtube.com/watch?v=x' } }, 201000, {});
  assert.equal(paused.visible, true, 'paused keeps the orb up');
  assert.equal(paused.mode, 'paused');
  const during = orb.nextOrbState(paused, { ok: false }, 205000, {});
  assert.equal(during.visible, true, 'grace period avoids flicker');
  const after = orb.nextOrbState(paused, { ok: false }, 215000, {});
  assert.equal(after.visible, false, 'hides once the grace period lapses');
  assert.equal(after.mode, 'idle');
});

test('manual dismiss holds until a new session, track change reopens', () => {
  const dismissed = { visible: false, mode: 'paused', trackKey: 'A http://x', lastSeenAt: 300000, dismissedKey: 'A http://x', expanded: false };
  const same = orb.nextOrbState(dismissed, { ok: true, status: 'Playing', title: 'A', tab: { url: 'http://x' } }, 301000, {});
  assert.equal(same.visible, false, 'same session stays dismissed');
  const next = orb.nextOrbState(dismissed, { ok: true, status: 'Playing', title: 'B', tab: { url: 'http://y' } }, 302000, {});
  assert.equal(next.visible, true, 'a new track clears the dismissal');
  assert.equal(next.dismissedKey, '');
  assert.ok(next.trackChangedAt >= 302000);
});

test('orb session keys ignore empty and unverified payloads', () => {
  assert.equal(orb.orbSessionKey(null), '');
  assert.equal(orb.orbSessionKey({ ok: true }), '');
  assert.equal(orb.orbSessionKey({ ok: true, status: 'Playing', title: '', tab: {} }), '');
});

test('manual hold keeps a shown orb up with no media', () => {
  // Reducer alone hides a trackless visible orb once grace lapses.
  const shown = { visible: true, mode: 'idle', trackKey: '', lastSeenAt: 400000, dismissedKey: '', expanded: false };
  const expired = orb.nextOrbState(shown, { ok: false }, 400000 + orb.GRACE_MS + 1, {});
  assert.equal(expired.visible, false);
  // The manual hold applied by show(true) re-pins it instead.
  const held = orb.applyManualHold(expired, true, 400000 + orb.GRACE_MS + 1);
  assert.equal(held.visible, true);
  assert.equal(held.lastSeenAt, 400000 + orb.GRACE_MS + 1);
  // No hold, no change.
  const expiredAgain = orb.nextOrbState(shown, { ok: false }, 400000 + orb.GRACE_MS + 1, {});
  const unheld = orb.applyManualHold(expiredAgain, false, 500000);
  assert.equal(unheld.visible, false);
});

test('manual hold never overrides a real media session', () => {
  const tracked = { visible: true, mode: 'playing', trackKey: 'B http://y', lastSeenAt: 600000, dismissedKey: '', expanded: false };
  const kept = orb.applyManualHold({ ...tracked }, true, 601000);
  assert.equal(kept.trackKey, 'B http://y');
  assert.equal(kept.visible, true);
  assert.equal(kept.lastSeenAt, 600000, 'a real session keeps its own anchor');
});
