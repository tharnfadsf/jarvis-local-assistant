'use strict';
// Regression tests for phrase-variation expansion (second priority).
//
// Pure-function tests over the shipped conversation-library.json: coverage
// counts, representative 10-variation mapping, meaning discrimination,
// command/small-talk separation, follow-ups, cancellations, AI fallback,
// response variety, and matcher determinism. Voice/browser paths are covered
// by the other suites; nothing here needs a microphone or a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');
const library = require('../conversation-library.json');

const matchable = () => {
  const out = [];
  for (const category of library.categories) {
    for (const intent of category.intents || []) {
      if (intent.id !== 'app_open_success') out.push(intent);
    }
  }
  return out;
};
const classify = (input, history = []) => core.classifyLocalConversation(input, history, library)?.intentId || null;

test('coverage: every intent has 10+ phrases, totals meet the target', () => {
  const intents = matchable();
  assert.ok(intents.length >= 51, `intents=${intents.length}`);
  const thin = intents.filter(i => !i.responsesOnly && (i.patterns || []).length < 10);
  assert.deepEqual(thin.map(i => i.id), [], 'every matchable intent needs 10+ input phrases');
  const unique = new Set();
  for (const intent of intents) for (const p of intent.patterns || []) unique.add(core.normalizeConversationText(p));
  assert.ok(unique.size >= 780, `uniquePhrases=${unique.size}`);
  let responses = 0;
  for (const intent of intents) responses += (intent.responses || []).length;
  assert.ok(responses >= 1100, `responses=${responses}`);
  console.log(`COUNTS intents=${intents.length} uniquePhrases=${unique.size} responses=${responses}`);
});

test('capability intent maps all 15 example phrasings plus extras', () => {
  const variants = [
    'What can you do?', 'What are you capable of?', 'What can you help me with?',
    'What features do you have?', 'What can you help me do?', 'What commands do you understand?',
    'What are your abilities?', 'Show me what you can do.', "Tell me what you're able to do.",
    'What can I ask you to do?', 'What functions do you support?', 'Give me a list of your features.',
    'How can you help me?', 'What are your main functions?', 'What can I use you for?',
    'What else can you do?', 'I need help'
  ];
  assert.ok(variants.length >= 10);
  for (const input of variants) assert.equal(classify(input), 'capability', input);
});

test('representative intents map 10+ natural variations each', () => {
  const questionHistory = [{ who: 'JARVIS', text: 'Do you want me to continue?' }];
  const cases = {
    greeting: ['hello', 'hey there', 'good morning', 'yo', 'sup', 'howdy', 'good evening', 'hi hi', 'hey hey', 'greetings'],
    thanks: ['thank you', 'thanks a ton', 'much appreciated', 'i really appreciate it', 'thank you so much', 'thanks a bunch', 'grateful', 'cheers', 'thanks for that', 'thx'],
    boredom: ["i'm bored", 'so bored right now', 'there is nothing to do', 'entertain me', 'i need something fun', 'this is boring', 'killing time', 'bored out of my mind', 'give me something to do', 'nothing to do'],
    joke_request: ['tell me a joke', 'make me laugh', 'got any jokes', 'hit me with a joke', 'joke please', 'say something funny', 'tell me something funny', 'give me a joke', 'i want a joke', 'know any good jokes'],
    follow_up: ['another one', 'tell me more', 'what else', 'go on', 'keep going', 'one more', 'more please', 'and another', 'what else you got', 'then what'],
    cancel_operation: ['never mind', 'actually never mind', 'forget it', 'forget about it', 'drop it', 'leave it', 'does not matter', 'let it go', 'cancel that', 'do that instead'],
    acknowledgement: ['got it', 'understood', 'makes sense', 'roger that', 'copy that', 'noted', 'gotcha', 'sounds good to me', 'no worries', 'fair enough']
  };
  for (const [intent, variants] of Object.entries(cases)) {
    assert.ok(variants.length >= 10, intent);
    for (const input of variants) assert.equal(classify(input, questionHistory), intent, `${intent} :: ${input}`);
  }
});

test('similar phrases with different meanings stay apart', () => {
  // Factual/command-like inputs must NOT match chit-chat (they fall to AI/features).
  assert.equal(classify('Who is the current president?'), null);
  assert.equal(classify('find the meaning of photosynthesis'), null);
  assert.equal(classify('quantum entanglement explain'), null);
  // Feature-owned phrasings must not be stolen by chit-chat either.
  assert.equal(classify('Could you tell me the time?'), null);
  assert.equal(classify('Can you find my downloads?'), null);
  assert.equal(classify('What was I supposed to do today?'), null);
  // ...while their feature parsers claim them (priority order: commands first).
  assert.equal(core.parseFileSearchIntent('Can you find my downloads?')?.folder, 'Downloads');
  assert.deepEqual(core.parsePlannerIntent('What was I supposed to do today'), { kind: 'list-events', day: 'today' });
  // "what else can you do" is capability, not a follow-up.
  assert.equal(classify('What else can you do?'), 'capability');
});

test('mixed small talk plus a music command extracts the command', () => {
  assert.equal(core.extractEmbeddedMusicCommand("I'm bored, put some music on"), 'open-music');
  assert.equal(core.extractEmbeddedMusicCommand('put some music on'), 'open-music');
  assert.equal(core.extractEmbeddedMusicCommand("don't put some music on"), null);
  assert.equal(core.extractEmbeddedMusicCommand('i love this song'), null);
  assert.equal(core.parseMusicIntent('play this song')?.query, 'this song');
});

test('follow-ups resolve with and without history; cancellations map', () => {
  const questionHistory = [{ who: 'JARVIS', text: 'Do you want me to continue?' }];
  assert.equal(classify('another one', questionHistory), 'follow_up');
  assert.equal(classify('tell me more'), 'follow_up');
  assert.equal(classify('Not really.', questionHistory), 'short_no');
  assert.equal(classify('Maybe.', questionHistory), 'short_maybe');
  assert.equal(classify('never mind'), 'cancel_operation');
  assert.equal(classify('do that instead'), 'cancel_operation');
});

test('new identity and recovery intents map cleanly', () => {
  const cases = {
    who_are_you: ['are you a robot', 'are you human', 'are you real', 'are you an ai', 'what are you', 'who made you'],
    are_you_listening: ['are you listening', 'are you there', 'can you hear me', 'are you ready'],
    repeat_request: ['repeat that', 'say that again', 'what did you just say', 'one more time please'],
    troubleshooting: ['it is not working', 'why are you not working', 'that did not work', 'are you broken']
  };
  for (const [intent, variants] of Object.entries(cases)) {
    for (const input of variants) assert.equal(classify(input), intent, `${intent} :: ${input}`);
  }
  // Pre-existing owners keep their phrases: "who are you" stays introduction.
  assert.equal(classify('who are you'), 'introduction');
});
test('unknown phrases fall back to AI (null), matcher is deterministic', () => {
  for (const input of ['blorptastic zebras at midnight', 'The well is deep.', 'synchronize the carburetor tolerances']) {
    assert.equal(classify(input), null, input);
  }
  const twice = [classify('tell me a joke'), classify('tell me a joke')];
  assert.equal(twice[0], 'joke_request');
  assert.equal(twice[0], twice[1]);
});

test('responses stay varied and never repeat back-to-back', () => {
  const seen = new Set();
  let previous = '';
  for (let i = 0; i < 6; i++) {
    const response = core.chooseConversationResponse(library, 'greeting', previous ? [previous] : [], () => 0);
    assert.ok(response && !seen.has(response) || i > 0, 'fresh alternative while any remain');
    if (previous) assert.notEqual(response, previous, 'no immediate repeat');
    seen.add(response);
    previous = response;
  }
  for (const id of ['capability', 'cancel_operation']) {
    const intent = matchable().find(i => i.id === id);
    assert.ok(intent && (intent.responses || []).length >= 8, `${id} needs varied responses`);
    assert.ok(!(intent.responses || []).some(r => /[\u2600-\u27BF\u2B00-\u2BFF]/.test(r) || /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(r)), id + ' responses must have no emojis');
  }
});

test('normalizer understands casual contractions', () => {
  assert.equal(core.normalizeConversationText("i'm gonna go"), 'i am going to go');
  assert.equal(core.normalizeConversationText('wanna chat'), 'want to chat');
  assert.equal(core.normalizeConversationText('i dunno'), 'i do not know');
  assert.equal(classify('wanna talk'), 'lets_talk');
  assert.equal(classify('i gotta run'), 'goodbye');
});
