'use strict';
// Regression tests for the master repair: email recipient loop, draft
// extraction, summarization, VAD adaptivity, site-typo correction, and
// Discord secret handling. Pure-function tests (no browser, no microphone,
// no real network except one bounded Discord-shape probe with fake values).
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');
const discord = require('../discord.js');

test('email recipient answers advance instead of repeating the question', () => {
  const flow = core.parseEmailFlowStart('draft an email');
  assert.equal(flow.step, 'to');
  const answered = core.advancePendingFlow(flow, 'John');
  assert.equal(answered.type, 'answer');
  assert.equal(answered.flow.values.to, 'John');
  assert.equal(answered.flow.step, 'subject');
  assert.equal(answered.flow.question, 'What should the subject be?');
});

test('email fields never bleed into each other', () => {
  const flow = core.parseEmailFlowStart('draft an email');
  const step1 = core.advancePendingFlow(flow, 'John');
  assert.deepEqual(step1.flow.values, { to: 'John' });
  const step2 = core.advancePendingFlow(step1.flow, 'Meeting tomorrow');
  assert.deepEqual(step2.flow.values, { to: 'John', subject: 'Meeting tomorrow' });
  const done = core.advancePendingFlow(step2.flow, 'Ask if he can meet at 3 PM');
  assert.equal(done.type, 'complete');
  assert.deepEqual(done.flow.values, { to: 'John', subject: 'Meeting tomorrow', body: 'Ask if he can meet at 3 PM' });
});

test('full one-shot commands extract every field up front', () => {
  assert.deepEqual(core.extractEmailParts('Draft an email to John with the subject Meeting Tomorrow and say that I will arrive at 3 PM'), {
    to: 'John', subject: 'Meeting Tomorrow', body: 'I will arrive at 3 PM'
  });
  assert.deepEqual(core.extractEmailParts('Write an email to john@example.com about Friday'), {
    to: 'john@example.com', subject: 'Friday'
  });
  const partial = core.extractEmailParts('Write to john@example.com');
  assert.equal(partial.to, 'john@example.com');
  assert.equal(core.emailToStatus('John'), 'name');
  assert.equal(core.emailToStatus('john@example.com'), 'address');
  assert.equal(core.emailToStatus(''), '');
  assert.equal(core.emailToStatus('__SKIP__'), '');
});

test('email summaries quote the source and invent nothing', () => {
  const item = { from: 'boss@company.com', subject: 'Plan review', date: 'Wed, 11 Oct 2026', snippet: 'Please review the attached plan. Can you confirm by Friday? We meet tomorrow at 3 PM.' };
  const short = core.summarizeEmail(item, false);
  assert.match(short, /boss@company\.com/);
  assert.match(short, /Plan review/);
  assert.match(short, /tomorrow/);
  assert.ok(!/http/i.test(short), 'no links invented');
  const detailed = core.summarizeEmail(item, true);
  assert.match(detailed, /Can you confirm by Friday\?/);
  assert.match(detailed, /Possible actions/);
  const empty = core.summarizeEmail({ from: 'x@y.z', subject: 'Hi' }, false);
  assert.match(empty, /No readable preview/);
});

test('noise floor recovers after loud passages instead of forcing shouting', () => {
  const gate = new core.SpeechGate({ calibrationMs: 600, onsetMs: 200 });
  for (let i = 0; i < 7; i++) gate.sample(0.02, 100);
  assert.ok(gate.noiseFloor >= 0.019 && gate.noiseFloor <= 0.021);
  // Loud TV for a while: floor climbs, but capped, and normal speech still counts.
  for (let i = 0; i < 40; i++) gate.sample(0.05, 100);
  assert.ok(gate.noiseFloor < 0.05, `floor must not learn the full TV level (got ${gate.noiseFloor})`);
  // Room goes quiet: floor must drift back down instead of staying high.
  const high = gate.noiseFloor;
  for (let i = 0; i < 60; i++) gate.sample(0.004, 100);
  assert.ok(gate.noiseFloor < high, 'floor must recover downward in a quiet room');
  assert.ok(gate.noiseFloor < 0.012, `floor must approach the quiet level (got ${gate.noiseFloor})`);
  // Quiet conversational speech still opens the gate.
  gate.reset();
  for (let i = 0; i < 7; i++) gate.sample(0.004, 100);
  let triggered = false;
  for (let i = 0; i < 4; i++) triggered = gate.sample(0.012, 100).trigger || triggered;
  assert.equal(triggered, true, 'normal-volume speech above a quiet floor must trigger');
});

test('site typos resolve against the allowlist; app words do not', () => {
  assert.equal(core.parseWebsiteIntent('open youtub')?.site, 'youtube');
  assert.equal(core.parseWebsiteIntent('open goggle')?.site, 'google');
  assert.equal(core.parseWebsiteIntent('open youtub')?.corrected, 'youtub');
  assert.equal(core.parseWebsiteIntent('open youtube')?.site, 'youtube');
  assert.equal(core.parseWebsiteIntent('open mail'), null);
  assert.equal(core.parseWebsiteIntent('open word'), null);
  assert.equal(core.parseWebsiteIntent('open qzxwvk'), null);
});

test('discord ping commands parse, nearby phrases do not', () => {
  assert.equal(core.parseDiscordPingCommand('ping me'), 'ping');
  assert.equal(core.parseDiscordPingCommand('Jarvis, ping me on discord'), 'ping');
  assert.equal(core.parseDiscordPingCommand('send me a ping'), 'ping');
  assert.equal(core.parseDiscordPingCommand('ping my phone'), 'ping');
  assert.equal(core.parseDiscordPingCommand('ping me please'), 'ping');
  assert.equal(core.parseDiscordPingCommand('test the webhook'), 'test');
  assert.equal(core.parseDiscordPingCommand('test discord notifications'), 'test');
  assert.equal(core.parseDiscordPingCommand('check discord notifications'), 'test');
  for (const input of ['message Alex on discord', 'ping pong', 'pinging the server', 'test the microphone', 'ping', 'ping everyone']) {
    assert.equal(core.parseDiscordPingCommand(input), null, input);
  }
});
test('Discord webhook secrets never appear in configs, results, or errors', async () => {
  // Isolate from any real user configuration: an empty env file plus explicit
  // fake values, both removed afterwards.
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const emptyEnv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-env-')), 'test.env');
  fs.writeFileSync(emptyEnv, '');
  const previousEnvFile = process.env.JARVIS_ENV_FILE;
  process.env.JARVIS_ENV_FILE = emptyEnv;
  process.env.JARVIS_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123456789012345678/fake-secret-token-abc123';
  process.env.JARVIS_DISCORD_MENTION_ID = '123456789012345678';
  try {
    const config = discord.webhookConfig('.');
    assert.equal(config.configured, true);
    assert.equal(config.hasMention, true);
    const dump = JSON.stringify(config);
    assert.ok(!dump.includes('fake-secret-token'), 'config must not contain the URL');
    assert.ok(!dump.includes('webhooks/123456789012345678'), 'config must not contain the webhook id');
    const sent = await discord.sendWebhookNotification('.', 'probe message', { timeoutMs: 15000 });
    assert.equal(sent.ok, false);
    const dumpSent = JSON.stringify(sent);
    assert.ok(!dumpSent.includes('fake-secret-token'), 'result must not contain the URL');
    assert.ok(!dumpSent.includes('webhooks/123456789012345678'), 'result must not contain the webhook id');
    assert.ok(['auth', 'network', 'rate-limit', 'failed'].includes(sent.status), `honest failure status (got ${sent.status})`);
  } finally {
    delete process.env.JARVIS_DISCORD_WEBHOOK_URL;
    delete process.env.JARVIS_DISCORD_MENTION_ID;
  }
  const off = discord.webhookConfig('.');
  assert.equal(off.configured, false);
  assert.match(off.message, /JARVIS_DISCORD_WEBHOOK_URL/);
  if (previousEnvFile === undefined) delete process.env.JARVIS_ENV_FILE;
  else process.env.JARVIS_ENV_FILE = previousEnvFile;
});
