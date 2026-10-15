'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');

test('calendar flow collects only missing fields and completes once all exist', () => {
  const flow = core.parseCalendarFlowStart('set a calendar event');
  assert.ok(flow, 'incomplete event request must start the flow');
  assert.equal(flow.kind, 'calendar');
  assert.equal(flow.step, 'title');
  assert.equal(flow.question, 'What is the event for?');

  const named = core.advancePendingFlow(flow, 'dentist appointment');
  assert.equal(named.type, 'answer');
  assert.equal(named.flow.values.title, 'dentist appointment');
  assert.equal(named.flow.step, 'date');

  const dated = core.advancePendingFlow(named.flow, 'tomorrow');
  assert.equal(dated.type, 'answer');
  assert.equal(dated.flow.step, 'time');

  const timed = core.advancePendingFlow(dated.flow, '3 PM');
  assert.equal(timed.type, 'answer');
  assert.equal(timed.flow.step, 'duration');
  const dur = core.advancePendingFlow(timed.flow, 'one hour');
  assert.equal(dur.type, 'complete');
  assert.equal(dur.flow.completed, true);
});

test('complete event one-shots stay on the planner fast path', () => {
  assert.equal(core.parsePlannerIntent('schedule a call with mom tomorrow at 3 PM') !== null, true);
  assert.equal(core.parseCalendarFlowStart('schedule a call with mom tomorrow at 3 PM'), null);
  assert.equal(core.parseCalendarFlowStart('set an alarm for 7 AM'), null, 'alarms never start an event flow');
  assert.equal(core.parseCalendarFlowStart('remind me to drink water'), null, 'reminders never start an event flow');
  assert.equal(core.parseCalendarFlowStart('open chrome'), null);
});

test('ambiguous times ask AM or PM only when the time step is pending', () => {
  const flow = core.parseCalendarFlowStart('set a calendar event at 5');
  assert.ok(flow);
  // Title is still missing, so the AM/PM question must NOT hijack the prompt.
  assert.equal(flow.step, 'title');
  assert.equal(flow.question, 'What is the event for?');

  const ready = core.parseCalendarFlowStart('set a calendar event for the project review tomorrow at 5');
  if (ready && ready.values.timeAmbiguous && ready.step === 'time') {
    assert.match(ready.question, /AM or PM\?/);
    const resolved = core.advancePendingFlow(ready, 'pm');
    assert.equal(resolved.type, 'answer');
    assert.equal(resolved.flow.values.time, '17:00');
    assert.equal(resolved.flow.values.timeAmbiguous, undefined);
    const done = core.advancePendingFlow(resolved.flow, 'one hour');
    assert.equal(done.type, 'complete');
  }
});

test('invalid answers re-ask without losing collected fields', () => {
  const flow = core.parseCalendarFlowStart('set a calendar event called project sync tomorrow');
  assert.ok(flow);
  assert.equal(flow.step, 'time');
  const bad = core.advancePendingFlow(flow, 'sometime soon maybe');
  assert.equal(bad.type, 'reask');
  assert.equal(bad.flow.values.title, 'project sync');
  assert.equal(bad.flow.values.date, 'tomorrow');
  assert.ok(bad.flow.question);
});

test('cancel and unrelated commands behave differently for a pending flow', () => {
  const flow = core.parseCalendarFlowStart('set a calendar event');
  const cancelled = core.advancePendingFlow(flow, 'cancel that');
  assert.equal(cancelled.type, 'cancelled');

  const flow2 = core.parseCalendarFlowStart('set a calendar event');
  const command = core.advancePendingFlow(flow2, 'open chrome');
  assert.equal(command.type, 'unrelated');
  assert.equal(command.flow, flow2, 'unrelated input keeps the flow alive');

  const flow3 = core.parseCalendarFlowStart('set a calendar event');
  const switchWorkflow = core.advancePendingFlow(flow3, 'write an email');
  assert.equal(switchWorkflow.type, 'unrelated', 'starting another workflow is a command, not an answer');

  const flow4 = core.parseCalendarFlowStart('set a calendar event');
  const expired = core.advancePendingFlow({ ...flow4, expiresAt: Date.now() - 1 }, 'tomorrow');
  assert.equal(expired.type, 'expired');
});

test('email flow pre-fills subject from the topic and supports skipping the recipient', () => {
  const flow = core.parseEmailFlowStart('write an email about my absence');
  assert.ok(flow);
  assert.equal(flow.kind, 'email');
  assert.equal(flow.values.subject, 'my absence');
  assert.equal(flow.step, 'to');
  assert.equal(flow.question, 'Who should the email go to?');

  const skipped = core.advancePendingFlow(flow, 'skip');
  assert.equal(skipped.type, 'answer');
  assert.equal(skipped.flow.values.to, '__SKIP__');
  assert.equal(skipped.flow.step, 'body');

  const done = core.advancePendingFlow(skipped.flow, 'I will be absent tomorrow');
  assert.equal(done.type, 'complete');

  const full = core.parseEmailFlowStart('write an email to teacher@example.com subject homework body please check my work');
  assert.equal(full, null, 'complete drafts use the one-shot path');
});

test('discord flow collects the body and keeps the recipient', () => {
  const flow = core.startPendingFlow('discord', { values: { recipient: 'Alex' } });
  assert.equal(flow.step, 'body');
  assert.equal(flow.question, 'What should I say?');
  const done = core.advancePendingFlow(flow, 'the homework is done');
  assert.equal(done.type, 'complete');
  assert.equal(done.flow.values.recipient, 'Alex');
  assert.equal(done.flow.values.body, 'the homework is done');
  assert.equal(core.advancePendingFlow(flow, 'cancel').type, 'cancelled');
});

test('deterministic command detection separates commands from answers', () => {
  assert.equal(core.looksLikeDeterministicCommand('open chrome'), true);
  assert.equal(core.looksLikeDeterministicCommand('switch to Discord'), true);
  assert.equal(core.looksLikeDeterministicCommand('set a calendar event'), true);
  assert.equal(core.looksLikeDeterministicCommand('write an email'), true);
  assert.equal(core.looksLikeDeterministicCommand('message Alex hi there'), true);
  assert.equal(core.looksLikeDeterministicCommand('pause the music'), true);
  assert.equal(core.looksLikeDeterministicCommand('stop whats playing'), true);
  assert.equal(core.looksLikeDeterministicCommand('skip song'), true);
  assert.equal(core.looksLikeDeterministicCommand('4 PM'), false);
  assert.equal(core.looksLikeDeterministicCommand('project sync tomorrow'), false);
  assert.equal(core.looksLikeDeterministicCommand('sure, go ahead'), false);
});

test('music transport commands parse with targets, guards stay out', () => {
  const pairs = [
    ['pause', 'pause'], ['stop', 'stop'], ['play', 'play'],
    ['stop whats playing', 'stop'], ["stop what's playing", 'stop'],
    ['stop the song', 'stop'], ['pause it', 'pause'], ['resume playback', 'play'],
    ['skip', 'next'], ['skip song', 'next'], ['next track', 'next'],
    ['previous', 'previous'], ['replay', 'replay'], ['volume down', 'volume-down']
  ];
  for (const [input, command] of pairs) assert.equal(core.parseMusicControl(input)?.command, command, input);
  for (const input of ['stop talking', 'stop the alarm', 'mute', 'play on', 'what is the weather', 'stopwatch']) {
    assert.equal(core.parseMusicControl(input), null, input);
  }
});

test('email skip still answers the recipient step, not a music command', () => {
  const flow = core.parseEmailFlowStart('write an email');
  assert.equal(flow.step, 'to');
  const skipped = core.advancePendingFlow(flow, 'skip');
  assert.equal(skipped.type, 'answer');
  assert.equal(skipped.flow.values.to, '__SKIP__');
  assert.equal(skipped.flow.step, 'subject');
});
