'use strict';
// Voice-only modes tests (2026-10-14). Pure registry/routing checks — no
// microphone, browser, or app launching needed. Live launching + follow-up
// behavior is verified in the desktop app per the task checklist.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../jarvis-core.js');

test('all eight example commands route to the right mode', () => {
  const cases = [
    ['Hey Jarvis, study mode.', 'study'],
    ["Hey Jarvis, let's game.", 'gaming'],
    ["Hey Jarvis, I'm bored.", 'bored'],
    ['Hey Jarvis, I need to focus.', 'focus'],
    ['Hey Jarvis, relax mode.', 'relax'],
    ["Hey Jarvis, I'm angry.", 'cooldown'],
    ['Hey Jarvis, coding mode.', 'coding'],
    ['Hey Jarvis, what modes do you have?', '__list'],
  ];
  for (const [spoken, mode] of cases) {
    const hit = Core.parseModeIntent(spoken);
    assert.ok(hit, `${spoken} must parse`);
    assert.equal(hit.mode, mode, spoken);
  }
});

test('natural alias variations map to study and gaming', () => {
  for (const s of ['study mode', "let's study", 'time to do homework', 'school mode', 'help me with my assignments', "let's get some schoolwork done"]) {
    assert.equal(Core.parseModeIntent(s).mode, 'study', s);
  }
  for (const s of ['gaming mode', "let's game", 'gaming time', "I'm going to play something", 'time to play']) {
    assert.equal(Core.parseModeIntent(s).mode, 'gaming', s);
  }
});

test('ordinary conversation never activates a mode', () => {
  for (const s of ['my homework is hard', 'good morning', 'tell me a joke', 'what time is it', 'my game crashed yesterday', 'I love music', 'describe your day', 'open YouTube', 'what is on my screen']) {
    assert.equal(Core.parseModeIntent(s), null, s);
  }
});

test('multi-part commands carry extras without a second question', () => {
  assert.equal(Core.parseModeIntent('gaming mode, get Roblox ready').extra.gameRaw, 'Roblox');
  assert.equal(Core.parseModeIntent('music mode, play Magnetic').extra.song, 'Magnetic');
  assert.equal(Core.parseModeIntent('focus mode for 25 minutes').extra.minutes, 25);
  assert.equal(Core.parseModeIntent('study mode, start with math').extra.subject, 'math');
  assert.equal(Core.parseModeIntent('study mode').extra.subject, undefined);
  assert.equal(Core.parseModeIntent('research mode, help me investigate black holes').extra.topic, 'black holes');
  assert.equal(Core.parseModeIntent('coding mode, open my jarvis project').extra.project, 'jarvis');
});

test('switch, exit, and per-mode help resolve', () => {
  assert.deepEqual(Core.parseModeIntent('switch to study mode'), { mode: 'study', extra: {}, switched: true });
  assert.equal(Core.parseModeIntent("actually, let's game").mode, 'gaming');
  assert.equal(Core.parseModeIntent('exit this mode').mode, '__exit');
  assert.equal(Core.parseModeIntent('go back to normal').mode, '__exit');
  const help = Core.parseModeIntent('what can you do in study mode');
  assert.equal(help.mode, '__help');
  assert.equal(help.extra.forMode, 'study');
  assert.match(Core.modeHelpText('study'), /Toddle/);
  assert.match(Core.modeListText(), /Gaming mode/);
});

test('game answers resolve known, mobile-only, and generic titles', () => {
  assert.deepEqual(Core.parseModeGame('Roblox'), { name: 'Roblox' });
  assert.deepEqual(Core.parseModeGame("let's play Roblox"), { name: 'Roblox' });
  assert.deepEqual(Core.parseModeGame('probably Roblox'), { name: 'Roblox' });
  assert.deepEqual(Core.parseModeGame('I want to play Roblox'), { name: 'Roblox' });
  assert.equal(Core.parseModeGame('Brawl Stars').unsupported, 'mobile-only');
  assert.equal(Core.parseModeGame('minecraft').name, 'Minecraft');
  assert.equal(Core.parseModeGame('uhh'), null);
  assert.equal(Core.parseModeGame(''), null);
});

test('mode questions rotate deterministically without repeats in a row', () => {
  const q0 = Core.modeQuestion('gaming', 0);
  const q1 = Core.modeQuestion('gaming', 1);
  assert.ok(q0 && q1 && q0 !== q1);
  assert.equal(Core.modeQuestion('gaming', 21), Core.modeQuestion('gaming', 0));
  // Study mode deliberately asks nothing: it reads the Toddle todo list
  // instead of asking which subject to start with.
  assert.deepEqual(Core.MODES.study.questions, []);
  assert.equal(Core.modeQuestion('study', 3), '');
  assert.equal(Core.modeQuestion('study', 0), '');
});

test('help texts stay user-facing (no JSON, code, or handler names)', () => {
  for (const id of Object.keys(Core.MODES)) {
    const h = Core.modeHelpText(id);
    assert.ok(h.length > 20, id);
    assert.doesNotMatch(h, /[{}]|function|handler|localAction|open-site/);
  }
  assert.doesNotMatch(Core.modeListText(), /[{}]/);
  assert.equal(Object.keys(Core.MODES).length, 19); // 18 original modes + conversation
});

test('new site destinations parse for voice and modes', () => {
  assert.equal(Core.parseWebsiteIntent('open google docs').site, 'docs');
  assert.equal(Core.parseWebsiteIntent('open slides').site, 'slides');
  assert.equal(Core.parseWebsiteIntent('open toddle').site, 'toddle');
  assert.deepEqual(Core.MODES.study.sites, ['toddle', 'youtube', 'youtube-music', 'gmail', 'docs', 'slides']);
  // Gaming opens YouTube and never Discord (Discord stays in social mode).
  // Subset assertion: other workers may extend site lists; discord must stay out.
  assert.ok(Core.MODES.gaming.sites.includes('youtube'));
  assert.ok(!Core.MODES.gaming.sites.includes('discord'));
});
