'use strict';
// Study mode: Toddle todo reading + the on-demand "check my todo list"
// command (2026-10-15). Pure parsing/routing checks — no browser, no launch.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../jarvis-core.js');

test('todo command matches the natural ways people ask for homework', () => {
  for (const spoken of [
    'check my todo list', 'check my todos', 'check my to do list', 'check my to-do list',
    'jarvis check my todo list', 'jarvis, check my homework', 'can you check my assignments',
    'check if i have any homework', 'check my homework again', 'look at my homework',
    'show me my homework', 'pull up my todo list', 'read my assignments', 'list my todos',
    'view my assignments', 'refresh my todo list', 'remind me what homework i have',
    'my todo list', 'do i have any homework', 'do i have homework', 'any homework',
    'any assignments left', 'do i have any assignments due', 'is there any homework',
    'are there any assignments', 'do i have anything due today', 'do i have any work due',
    'what is due', "what's due", 'what have i got due', 'what do i have due',
    'what homework do i have', 'what assignments are due', 'what is outstanding',
    'what is pending', 'what homework is assigned', 'what is my homework due',
    "when is my maths homework due", "what's on toddle", 'what is on my todo',
  ]) {
    assert.ok(Core.parseTodoIntent(spoken), `should match: ${spoken}`);
  }
});

test('ordinary talk about homework never triggers a todo lookup', () => {
  // The regression this guards: "my homework is hard" must not make JARVIS
  // scrape Toddle, and neither must these near-miss commands.
  for (const spoken of [
    'my homework is hard', 'homework is annoying', 'my assignment was late',
    'homework help websites', 'my homework is due next week', 'i finished my todo list',
    'how do i do my homework', 'tell me about homework', 'what is a todo',
    'what is the todo app', 'open the todo app', 'open my homework app',
    'what is due process', 'due diligence', 'when is dinner due',
    'i have a lot of work to do at the office', 'open my email', 'list my files',
    'remind me to buy milk', 'check my email', 'read my email', 'read my messages',
    'show me my code', 'show me my files', 'list the apps', 'open my notes',
    'what do i do now', 'what is on tv', 'open youtube', 'play magnetic',
    'what time is it', 'tell me a joke', 'what modes do you have',
  ]) {
    assert.equal(Core.parseTodoIntent(spoken), null, `should NOT match: ${spoken}`);
  }
});

test('the todo command never steals work from another intent', () => {
  // "what homework do I have" must reach the todo read, not study mode and not
  // the website opener.
  assert.equal(Core.parseModeIntent('check my homework'), null);
  assert.equal(Core.parseWebsiteIntent('check my todo list'), null);
  assert.equal(Core.parseModeIntent('open toddle'), null);
  // ...and real mode/website commands still route as before.
  assert.equal(Core.parseModeIntent('study mode').mode, 'study');
  assert.equal(Core.parseModeIntent("let's study").mode, 'study');
  assert.equal(Core.parseWebsiteIntent('open toddle').site, 'toddle');
});

test('study mode asks nothing and reports the Toddle list instead', () => {
  assert.deepEqual(Core.MODES.study.questions, []);
  assert.equal(Core.modeQuestion('study', 0), '');
  // The workspace destinations are unchanged: still Toddle + the five others.
  assert.deepEqual(Core.MODES.study.sites, ['toddle', 'youtube', 'youtube-music', 'gmail', 'docs', 'slides']);
  // Help must describe the new behaviour, not the old question.
  assert.match(Core.modeHelpText('study'), /Toddle/);
  assert.doesNotMatch(Core.modeHelpText('study'), /ask what subject/i);
});

test('site todo reading rejects sites it does not know, without throwing', async () => {
  const browserTabs = require('../browser-tabs.js');
  const r = await browserTabs.readSiteTodos('not-a-real-site');
  assert.equal(r.ok, false);
  assert.match(r.message, /cannot read/i);
});