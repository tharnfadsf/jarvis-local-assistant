'use strict';
// Behavioural tests for the CDP tab-control module. These never launch a
// browser (no enableBrowserControl / startControlledWindow) and never close
// anything: they verify that every reply is honest about what was and was
// not verified, in whichever state the machine happens to be.
const test = require('node:test');
const assert = require('node:assert/strict');
const tabs = require('../browser-tabs.js');

test('status always reports a usable state and never claims a connection it lacks', async () => {
  const result = await tabs.status();
  assert.equal(result.ok, true, 'reporting status itself succeeds');
  assert.equal(typeof result.connected, 'boolean');
  assert.ok(typeof result.message === 'string' && result.message.length > 10);
  if (result.connected) {
    assert.ok(typeof result.browser === 'string' && result.browser);
    assert.equal(typeof result.tabs, 'number');
  } else {
    assert.equal(result.needsSetup, true, 'disconnected state must say setup is needed');
    assert.match(result.message, /enable browser control|controlled browser/i);
  }
});

test('listTabs never invents tabs when control is off', async () => {
  const result = await tabs.listTabs();
  if (result.ok) {
    assert.ok(Array.isArray(result.tabs));
    for (const tab of result.tabs) assert.equal(typeof tab.title, 'string');
  } else {
    assert.equal(result.needsSetup, true);
    assert.match(result.message, /controlled browser window|enable browser control/i);
  }
});

test('closing a tab without a verified connection fails instead of pretending', async () => {
  const status = await tabs.status();
  if (status.connected) return; // nothing to prove while a controlled browser is up
  const result = await tabs.closeTabRequest({ query: 'tab-that-does-not-exist' });
  assert.equal(result.ok, false);
  assert.equal(result.needsSetup, true);
  assert.ok(typeof result.message === 'string' && result.message.length > 10);
});

test('asking for the current tab without a connection fails honestly', async () => {
  const status = await tabs.status();
  if (status.connected) return;
  const result = await tabs.currentTabRequest();
  assert.equal(result.ok, false);
  assert.ok(typeof result.message === 'string' && result.message.length > 10);
});

test('activating a tab without a connection fails honestly', async () => {
  const status = await tabs.status();
  if (status.connected) return;
  const result = await tabs.activateTabRequest({ direction: 'next' });
  assert.equal(result.ok, false);
  assert.ok(typeof result.message === 'string' && result.message.length > 10);
});

test('opening a tab without a connection fails without launching anything', async () => {
  const status = await tabs.status();
  if (status.connected) return;
  const result = await tabs.openNewTab();
  assert.equal(result.ok, false);
  assert.equal(result.verified || false, false, 'must never claim an unverified open');
  assert.ok(typeof result.message === 'string' && result.message.length > 10);
});

test('tab-control mode reads the environment with an auto default', () => {
  const saved = process.env.JARVIS_TAB_CONTROL;
  try {
    delete process.env.JARVIS_TAB_CONTROL;
    assert.equal(tabs.tabControlMode(), 'auto');
    process.env.JARVIS_TAB_CONTROL = 'off';
    assert.equal(tabs.tabControlMode(), 'off');
    process.env.JARVIS_TAB_CONTROL = 'AUTO';
    assert.equal(tabs.tabControlMode(), 'auto');
  } finally {
    if (saved === undefined) delete process.env.JARVIS_TAB_CONTROL;
    else process.env.JARVIS_TAB_CONTROL = saved;
  }
});

test('reconnect-only ensure never launches a browser', async () => {
  const result = await tabs.ensureControl({ launch: false });
  assert.equal(typeof result.ok, 'boolean');
  assert.ok(result.lifecycle && typeof result.lifecycle.state === 'string');
  assert.ok(['connected', 'waiting-for-browser', 'reconnecting', 'initializing', 'disabled'].includes(result.lifecycle.state));
});

test('resolving targets against a fake tab list is exact', async () => {
  const listed = { tabs: [
    { id: 'a', index: 0, title: 'Inbox — Gmail', url: 'https://mail.google.com/', ws: '' },
    { id: 'b', index: 1, title: 'lofi girl — YouTube', url: 'https://music.youtube.com/watch?v=1', ws: '' }
  ] };
  const one = await tabs.resolveTarget(listed, { query: 'gmail' });
  assert.equal(one.ok, true);
  assert.equal(one.target.id, 'a');
  const missing = await tabs.resolveTarget(listed, { query: 'nothing-here-xyz' });
  assert.equal(missing.ok, false);
  const music = await tabs.resolveTarget(listed, { music: true });
  assert.equal(music.ok, true);
  assert.equal(music.target.id, 'b');
  const pos = await tabs.resolveTarget(listed, { position: 5 });
  assert.equal(pos.ok, false);
});
