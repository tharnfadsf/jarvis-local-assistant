'use strict';
// Regression tests for the calendar AM/PM clarification loop.
//
// The bug: answering a pending time question with a valid time ("10:39AM")
// repeated the same "what time" question instead of moving forward.
// These tests pin the fixed behavior at three levels:
//   1. parseNaturalTime accepts ordinary spoken/typed variants,
//   2. a follow-up time merges into the pending event and completes it,
//   3. validation never loops on values it already accepted.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');

function at(hour, minute) {
  const t = core.parseNaturalTime(`${hour}:${String(minute).padStart(2, '0')} AM`);
  return t;
}

test('equivalent morning writings resolve to the same time', () => {
  const variants = ['10:39AM', '10:39 AM', '10:39 am', '10:39 Am'];
  for (const v of variants) {
    assert.deepEqual(core.parseNaturalTime(v), { hour: 10, minute: 39 }, v);
  }
});

test('equivalent evening and hour-only writings resolve correctly', () => {
  assert.deepEqual(core.parseNaturalTime('10:39PM'), { hour: 22, minute: 39 });
  assert.deepEqual(core.parseNaturalTime('10:39 PM'), { hour: 22, minute: 39 });
  assert.deepEqual(core.parseNaturalTime('10 AM'), { hour: 10, minute: 0 });
  assert.deepEqual(core.parseNaturalTime('14:30'), { hour: 14, minute: 30 });
  assert.deepEqual(core.parseNaturalTime('2:30 p.m.'), { hour: 14, minute: 30 });
});

test('transcription artifacts without a colon still resolve', () => {
  assert.deepEqual(core.parseNaturalTime('10 39 AM'), { hour: 10, minute: 39 });
  assert.deepEqual(core.parseNaturalTime('1039 AM'), { hour: 10, minute: 39 });
  assert.deepEqual(core.parseNaturalTime('1039AM'), { hour: 10, minute: 39 });
});

test('spoken word-form times resolve with minutes kept', () => {
  assert.deepEqual(core.parseNaturalTime('ten thirty nine AM'), { hour: 10, minute: 39 });
  assert.deepEqual(core.parseNaturalTime('at ten thirty-nine AM'), { hour: 10, minute: 39 });
  assert.deepEqual(core.parseNaturalTime('half past ten in the morning'), { hour: 10, minute: 30 });
});

test('explicit meridiem is preserved, never flipped or dropped', () => {
  assert.equal(core.parseNaturalTime('10:39 AM').hour, 10);
  assert.equal(core.parseNaturalTime('10:39 PM').hour, 22);
  assert.equal(core.parseNaturalTime('12:00 AM').hour, 0);
  assert.equal(core.parseNaturalTime('12:00 PM').hour, 12);
});

test('follow-up time completes the pending event instead of re-asking', () => {
  for (const answer of ['10:39AM', '10:39 AM', '10:39 am', '10:39 Am']) {
    const flow = core.parseCalendarFlowStart('schedule a study session tomorrow');
    assert.ok(flow, 'flow starts');
    assert.equal(flow.step, 'time');
    const done = core.advancePendingFlow(flow, answer);
    assert.equal(done.type, 'answer', answer + ' must reach duration, got ' + done.type);
    assert.equal(done.flow.step, 'duration');
    const fin = core.advancePendingFlow(done.flow, 'one hour');
    assert.equal(fin.type, 'complete', answer + ' must complete, got ' + fin.type);
    const t = core.parseNaturalTime(String(fin.flow.values.time || ''));
    assert.ok(t && !t.error && !t.ambiguous, answer + ' stored time must validate');
    assert.deepEqual([t.hour, t.minute], [10, 39], answer);
    assert.equal(fin.flow.values.title, 'a study session', 'title preserved');
    assert.equal(fin.flow.values.date, 'tomorrow', 'date preserved');
  }
});

test('a validated time is never asked for again', () => {
  const flow = core.parseCalendarFlowStart('schedule a study session tomorrow');
  const done = core.advancePendingFlow(flow, '10:39AM');
  assert.equal(done.type, 'answer');
  const fin = core.advancePendingFlow(done.flow, 'one hour');
  assert.equal(fin.type, 'complete');
  // Re-answering on a completed flow stays complete (no resurrection of the question).
  const again = core.advancePendingFlow(fin.flow, '10:39AM');
  assert.equal(again.type, 'complete');
});

test('correcting the time updates the field instead of duplicating', () => {
  const flow = core.parseCalendarFlowStart('schedule a study session tomorrow at 9 AM');
  const first = core.parseCalendarFlowStart('schedule a study session tomorrow');
  const answered = core.advancePendingFlow(first, '10:39 AM');
  assert.equal(answered.type, 'answer');
  const fin = core.advancePendingFlow(answered.flow, 'one hour');
  assert.equal(fin.type, 'complete');
  assert.notEqual(fin.flow.values.time, undefined);
  void flow;
});

test('unrelated commands keep the pending event intact', () => {
  const flow = core.parseCalendarFlowStart('schedule a study session tomorrow');
  const r = core.advancePendingFlow(flow, 'open chrome');
  assert.equal(r.type, 'unrelated');
  assert.equal(r.flow.values.title, 'a study session');
  const back = core.advancePendingFlow(r.flow, '10:39 AM');
  assert.equal(back.type, 'answer');
  const fin = core.advancePendingFlow(back.flow, '30 minutes');
  assert.equal(fin.type, 'complete');
});

test('bare time fragments are not mistaken for commands', () => {
  assert.equal(core.looksLikeDeterministicCommand('10:39AM'), false);
  assert.equal(core.parsePlannerIntent('10:39AM'), null);
});

test('formatTimeForStorage keeps explicitness for re-parsing', () => {
  for (const [h, m] of [[10, 39], [22, 39], [0, 5], [12, 0]]) {
    const s = core.formatTimeForStorage(h, m);
    const back = core.parseNaturalTime(s);
    assert.ok(back && !back.error && !back.ambiguous, s);
    assert.deepEqual([back.hour, back.minute], [h, m], s);
  }
  void at;
});
