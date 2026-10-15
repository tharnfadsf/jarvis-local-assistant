'use strict';
// Voice-controlled reopen-closed-tabs (Ctrl+Shift+T) regression tests.
//
// Pure intent tests run everywhere. Live browser tests run only when a
// controlled session answers on 127.0.0.1:4173 and use a temporary blank tab
// so the user's real tabs are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');

const LIVE_BASE = 'http://127.0.0.1:4173';

test('direct commands all map to reopen-closed-tab', () => {
  const phrases = [
    'reopen the last closed tab', 'reopen my last tab', 'restore my last tab',
    'bring back my last tab', 'reopen the tab I just closed', 'restore the tab I closed',
    'undo closing that tab', 'undo close tab', 'bring that tab back', 'get my old tab back',
    'recover my previous tab', 'restore the previous tab', 'reopen the previous page I closed',
    'bring back the website I was just using', 'recover my last closed webpage'
  ];
  for (const phrase of phrases) {
    const r = core.parseReopenTabIntent(phrase);
    assert.ok(r, phrase);
    assert.equal(r.kind, 'reopen-closed-tab', phrase);
    assert.equal(r.count, 1, phrase);
    assert.equal(r.vague, false, phrase);
  }
});

test('conversational commands map, vague ones need context', () => {
  const explicit = [
    'I accidentally closed a tab', 'I closed the wrong tab', 'can you reopen what I just closed',
    'I need my previous tab back', 'take me back to the tab I had before',
    'I closed something by accident', 'get the last website back',
    'I want to undo that tab closure', 'restore what I was looking at',
    'can you recover my previous browser tab', 'I lost my tab',
    'bring back the page I was on', 'reverse the last tab close'
  ];
  for (const phrase of explicit) {
    const r = core.parseReopenTabIntent(phrase);
    assert.ok(r, phrase);
    assert.equal(r.vague, false, phrase);
  }
  for (const vague of ['undo that', 'can you bring that back', 'reverse that']) {
    const r = core.parseReopenTabIntent(vague);
    assert.ok(r, vague);
    assert.equal(r.vague, true, `${vague} must require recent-close context`);
  }
});

test('shortcut phrasings map, including ASR errors', () => {
  for (const phrase of [
    'press Control Shift T', 'use Ctrl Shift T', 'do the reopen tab shortcut',
    'use the restore tab shortcut', 'trigger the undo close shortcut',
    'perform the browser tab recovery shortcut', 'execute Control Shift T',
    'reopen the closed tab shortcut', 'use the recently closed tab command',
    'press control shift tea', 'use ctrl shift tee'
  ]) {
    const r = core.parseReopenTabIntent(phrase);
    assert.ok(r, phrase);
    assert.equal(r.count, 1, phrase);
  }
});

test('multi-tab and window requests carry the right count', () => {
  assert.equal(core.parseReopenTabIntent('reopen the last two closed tabs').count, 2);
  assert.equal(core.parseReopenTabIntent('restore my last three tabs').count, 3);
  assert.equal(core.parseReopenTabIntent('bring back the last five closed tabs').count, 5);
  assert.equal(core.parseReopenTabIntent('reopen multiple closed tabs').count, 3);
  assert.equal(core.parseReopenTabIntent('restore all the tabs I just closed').count, 5);
  assert.equal(core.parseReopenTabIntent('recover the last few tabs').count, 3);
  const win = core.parseReopenTabIntent('restore the browser window I just closed');
  assert.equal(win.target, 'window');
  assert.equal(core.parseReopenTabIntent('reopen the last closed window').target, 'window');
});

test('capitalization, punctuation, and wake words do not matter', () => {
  for (const phrase of [
    'Jarvis, REOPEN THE LAST CLOSED TAB!', 'jarvis, reopen my last tab please',
    'Reopen the tab I just closed?', 'JARVIS, press CTRL shift t.'
  ]) {
    assert.ok(core.parseReopenTabIntent(phrase), phrase);
  }
});

test('unrelated phrases never become reopen commands', () => {
  for (const phrase of ['open chrome', 'close the tab', 'play music', 'what is the weather', 'switch to Discord']) {
    assert.equal(core.parseReopenTabIntent(phrase), null, phrase);
  }
});

test('reopen counts as a deterministic command (never swallowed as a flow answer)', () => {
  assert.equal(core.looksLikeDeterministicCommand('reopen my last tab'), true);
  assert.equal(core.looksLikeDeterministicCommand('undo close tab'), true);
});

async function liveAction(body) {
  const r = await fetch(`${LIVE_BASE}/api/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
  });
  return r.json();
}

test('LIVE: controlled session answers without launching anything new', async () => {
  let status;
  try {
    status = await liveAction({ action: 'browser-control-status' });
  } catch {
    console.log('SKIP live: no JARVIS server on 4173');
    return;
  }
  assert.equal(status.connected, true, 'must reuse the existing controlled session');
  assert.ok(/chrome/i.test(status.browser || ''), `expected Chrome, got ${status.browser}`);
  const before = await liveAction({ action: 'tabs-list' });
  assert.equal(before.ok, true);
  const countBefore = before.tabs.length;
  assert.ok(countBefore >= 1, 'existing tabs must be intact');
  // A pure status+list round must not change the tab count or endpoint.
  const after = await liveAction({ action: 'tabs-list' });
  assert.equal(after.tabs.length, countBefore, 'listing must not open or close tabs');
});

test('LIVE: open a temp tab, close it, reopen it via tabs-reopen', async () => {
  let status;
  try {
    status = await liveAction({ action: 'browser-control-status' });
    if (!status.connected) { console.log('SKIP live: browser control not connected'); return; }
  } catch {
    console.log('SKIP live: no JARVIS server on 4173');
    return;
  }
  const listed0 = await liveAction({ action: 'tabs-list' });
  assert.equal(listed0.ok, true);
  const userTabCount = listed0.tabs.length;
  const userIds = new Set(listed0.tabs.map(t => t.id));
  const portBefore = listed0.port;

  // Clean up any leftover example.com tabs from previous runs.
  for (let i = 0; i < 5; i++) {
    const li = await liveAction({ action: 'tabs-list' });
    if (!li.tabs.some(t => /example/i.test(`${t.title} ${t.url}`))) break;
    const c = await liveAction({ action: 'tabs-close', query: 'example.com' });
    console.log('cleanup close', c.ok, c.message);
  }
  const lb = await liveAction({ action: 'tabs-list' });
  console.log('clean baseline', lb.tabs.length);
  const baseIds = new Set(lb.tabs.map(t => t.id));

  // 1. Open a temporary tab with a unique title in the SAME controlled window.
  const opened = await liveAction({ action: 'tabs-open', url: 'https://example.com/' });
  assert.equal(opened.ok, true, `tabs-open failed: ${opened.message}`);
  assert.equal(opened.verified, true, 'opened tab must be verified in the list');
  const listed1 = await liveAction({ action: 'tabs-list' });
  assert.equal(listed1.tabs.length, userTabCount + 1, 'exactly one temp tab added');
  assert.equal(listed1.port, portBefore, 'same controlled session, no new browser');
  const tempTab = listed1.tabs.find(t => !userIds.has(t.id));
  assert.ok(tempTab, 'temp tab must be the new one');

  // 2. Close ONLY the temp tab via its unique title.
  const closed = await liveAction({ action: 'tabs-close', query: 'Example Domain' });
  if (!closed.ok) {
    // Fallback: match by URL host.
    const closed2 = await liveAction({ action: 'tabs-close', query: 'example.com' });
    assert.equal(closed2.ok, true, `tabs-close failed: ${closed2.message}`);
  }
  const listed2 = await liveAction({ action: 'tabs-list' });
  assert.equal(listed2.tabs.length, userTabCount, 'temp tab closed, user tabs intact');
  assert.ok(listed2.tabs.every(t => userIds.has(t.id)), 'no user tab was touched');

  // 3. Reopen it with the real Ctrl+Shift+T path.
  const reopened = await liveAction({ action: 'tabs-reopen', count: 1 });
  assert.equal(reopened.ok, true, `tabs-reopen failed: ${reopened.message}`);
  assert.equal(reopened.verified, true, 'restore must be verified, not merely claimed');
  assert.equal(reopened.restored, 1);
  const listed3 = await liveAction({ action: 'tabs-list' });
  assert.equal(listed3.tabs.length, userTabCount + 1, 'restored tab is back in the list');
  assert.equal(listed3.port, portBefore, 'still the same controlled session');
  for (const t of listed2.tabs) assert.ok(listed3.tabs.some(x => x.id === t.id), `user tab "${t.title}" preserved`);
  const backTemp = listed3.tabs.find(t => !userIds.has(t.id));
  assert.ok(backTemp && /example/i.test(`${backTemp.title} ${backTemp.url}`), 'restored the example tab, not a blank');

  // 4. Clean up: close the restored temp tab so the session is left as found.
  const cleanup = await liveAction({ action: 'tabs-close', query: 'Example Domain' });
  const cleanup2 = cleanup.ok ? cleanup : await liveAction({ action: 'tabs-close', query: 'example.com' });
  assert.equal(cleanup2.ok, true, `cleanup close failed: ${cleanup2.message}`);
  const listed4 = await liveAction({ action: 'tabs-list' });
  assert.equal(listed4.tabs.length, userTabCount, 'session left exactly as found');
});
