'use strict';
// Tests for the conversation expansion (2026-10-15):
//  - Conversation Mode registration and explicit mode-OFF phrasing,
//  - conversation bridge intent list and library coverage,
//  - classification of the new feelings/reactions intents,
//  - pending-question continuity primitives used by the app bridge,
//  - response variety (no back-to-back repeats, recent avoidance).
// Pure tests over jarvis-core.js + conversation-library.json; the browser
// side (armConversationBridge / resolveConversationFollowUp) is verified on
// the real desktop app since app.js is a browser-only module.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');
const library = require('../conversation-library.json');

const intent = id => library.categories.flatMap(cat => cat.intents || []).find(i => i.id === id);
const classify = (input, history = []) => core.classifyLocalConversation(input, history, library)?.intentId || null;

test('conversation mode exists in the mode registry with explicit aliases only', () => {
  const def = core.MODES.conversation;
  assert.ok(def, 'conversation mode missing from Core.MODES');
  assert.strictEqual(def.expect, 'free');
  assert.deepEqual(def.sites, [], 'conversation mode must not open sites');
  assert.ok(core.parseModeIntent('conversation mode')?.mode === 'conversation');
  assert.ok(core.parseModeIntent('start conversation mode')?.mode === 'conversation');
  assert.ok(core.parseModeIntent('enable conversational mode')?.mode === 'conversation');
  assert.ok(core.parseModeIntent("let's have a conversation")?.mode === 'conversation');
  assert.ok(core.parseModeIntent('stay with me for a chat')?.mode === 'conversation');
  assert.equal(core.modeIdFromName('conversation'), 'conversation');
  // Ordinary chat must NOT trigger the mode.
  assert.equal(core.parseModeIntent('what is on your mind'), null);
  assert.equal(core.parseModeIntent('chat with me about homework'), null);
});

test('explicit mode OFF phrasing deactivates music, gaming and conversation', () => {
  const off = {
    'turn off music mode': 'music',
    'stop music mode': 'music',
    'disable music mode': 'music',
    'exit music mode': 'music',
    'turn off gaming mode': 'gaming',
    'stop gaming mode': 'gaming',
    'leave gaming mode': 'gaming',
    'turn off conversation mode': 'conversation',
    'exit conversation mode': 'conversation',
    'disable conversational mode': 'conversation',
    'quit study mode': 'study'
  };
  for (const [phrase, id] of Object.entries(off)) {
    const hit = core.parseModeIntent(phrase);
    assert.ok(hit?.mode === '__exit', `${phrase} -> ${hit && hit.mode}`);
    assert.strictEqual(hit.extra.forMode, id, phrase);
  }
  assert.ok(core.parseModeIntent('return to normal mode')?.mode === '__exit');
  // Activation must still work: off-phrasing never disables the mode itself.
  assert.ok(core.parseModeIntent('music mode')?.mode === 'music');
  assert.ok(core.parseModeIntent('gaming mode')?.mode === 'gaming');
  // Media transport control is untouched: "stop the music" is not a mode exit.
  assert.strictEqual(core.parseModeIntent('turn off the music'), null);
  assert.deepEqual(core.parseMusicControl('stop the music'), { command: 'stop' });
  // Idempotent rejection-free repeats parse the same way.
  assert.ok(core.parseModeIntent('turn off music mode again') === null || core.parseModeIntent('exit music mode')?.mode === '__exit');
});

test('conversation bridge intent list is exported and covered by the library', () => {
  assert.ok(Array.isArray(core.CONVERSATION_BRIDGE_INTENTS) && core.CONVERSATION_BRIDGE_INTENTS.length >= 15);
  for (const id of core.CONVERSATION_BRIDGE_INTENTS) {
    const def = intent(id);
    assert.ok(def, `bridge intent ${id} missing from library`);
    assert.ok((def.responses || []).length >= 5, `${id} needs several varied responses`);
  }
});

test('new emotions and reactions classify correctly', () => {
  const cases = {
    'i am stressed': 'feeling_stressed',
    'i am overwhelmed': 'feeling_stressed',
    'i am angry at my friend': 'feeling_angry',
    'nobody talks to me': 'feeling_lonely',
    'my friends ignored me': 'feeling_lonely',
    'i am so excited': 'feeling_excited',
    'i am worried about school': 'feeling_worried',
    'i need some encouragement': 'need_encouragement',
    'i need a distraction': 'need_distraction',
    'i finally finished my project': 'good_news',
    'surprise me': 'surprise',
    'tell me something cool': 'interesting_fact',
    'do you ever get bored': 'curiosity',
    'i had a bad day': 'negative_not_great',
    'good news': 'good_news'
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(classify(input), expected, input);
  }
  // Existing owners keep their phrases.
  assert.equal(classify('i am sad'), 'mood_negative');
  assert.equal(classify('tell me a joke'), 'joke_request');
  assert.equal(classify('tell me more'), 'follow_up');
  assert.equal(classify('never mind'), 'cancel_operation');
  assert.equal(classify('who are you'), 'introduction');
  assert.equal(classify('i am not tired'), 'mood_positive');
  // Open factual questions still fall through to the local AI.
  assert.equal(classify('what is the capital of France?'), null);
});

test('opinion questions stay conversational instead of being rejected', () => {
  assert.equal(classify('what do you think?'), 'opinion');
  assert.equal(classify('what is your opinion on this?'), 'opinion');
});

test('every new intent has 10+ patterns and varied responses without emojis', () => {
  const newIds = ['feeling_stressed', 'feeling_angry', 'feeling_lonely', 'feeling_excited', 'feeling_worried',
    'good_news', 'need_encouragement', 'need_distraction', 'surprise', 'interesting_fact', 'curiosity',
    'opinion', 'wait', 'topic_change', 'what_now', 'back_to_work'];
  for (const id of newIds) {
    const def = intent(id);
    assert.ok(def, id);
    assert.ok((def.patterns || []).length >= 10, `${id} patterns=${(def.patterns || []).length}`);
    assert.ok((def.responses || []).length >= 5, `${id} responses=${(def.responses || []).length}`);
    for (const r of def.responses || []) {
      assert.ok(!/[\u2600-\u27BF\u2B00-\u2BFF]/.test(r), `${id} response has an emoji: ${r}`);
      assert.ok(!/[\uD800-\uDBFF]/.test(r), `${id} response has a surrogate emoji: ${r}`);
    }
  }
});

test('pending question primitives give the app bridge its continuity', () => {
  const now = Date.now();
  const pq = core.createPendingQuestion({ kind: 'conversation', intent: 'conversation', question: 'Talk freely, Sir.', now });
  assert.ok(core.pendingQuestionActive(pq, now + 1000));
  assert.ok(!core.pendingQuestionActive(pq, now + 60000), 'bonded TTL expiry still applies');
  const arm = core.shouldArmFollowUp({ pendingKind: '', ackPrompt: false, recognitionEnabled: true, pending: pq });
  assert.ok(arm.armed, 'arm armed while conversation pending question waits');
  const before = pq.expiresAt;
  core.refreshPendingQuestion(pq, { now: now + 3000 });
  assert.ok(pq.expiresAt > before, 'refresh extends the window after each spoken reply');
  core.cancelPendingQuestion(pq, 'chat-ended');
  assert.ok(!core.pendingQuestionActive(pq, Date.now()), 'cancellation ends the bridge immediately');
});

test('cancellation phrases end the chat without trapping the user', () => {
  assert.ok(core.isPendingCancellation("i'm done chatting"));
  assert.ok(core.isPendingCancellation('end our conversation'));
  assert.ok(core.isPendingCancellation('we are done chatting'));
  assert.ok(core.isPendingCancellation('stop'));
  assert.ok(core.isPendingCancellation('nevermind'));
  // Ordinary answers are never cancellations.
  assert.ok(!core.isPendingCancellation('my friends ignored me today'));
  assert.ok(!core.isPendingCancellation('no'));
});

test('responses vary and never repeat back-to-back across bridge intents', () => {
  for (const id of core.CONVERSATION_BRIDGE_INTENTS) {
    const def = intent(id);
    const responses = def.responses;
    let previous = '';
    for (let i = 0; i < Math.min(6, responses.length); i++) {
      const drawn = core.chooseConversationResponse(library, id, previous ? [previous] : [], Math.random);
      assert.ok(drawn, `${id} produced no response`);
      if (responses.length > 1) assert.notEqual(drawn, previous, `${id} repeated immediately`);
      previous = drawn;
    }
  }
});

test('short answers to a pending question keep their concrete meaning', () => {
  const history = [{ who: 'JARVIS', text: 'Want to tell me what happened?' }];
  assert.equal(classify('Not really.', history), 'short_no');
  assert.equal(classify('Maybe.', history), 'short_maybe');
  assert.equal(classify('okay', history), 'acknowledgement');
});

test('sustained chat routing: real commands still parse while the bridge is open', () => {
  // These deterministic routes exist independent of the bridge, so an
  // open conversation never disables normal command handling.
  assert.ok(core.parseWebsiteIntent('open youtube'));
  assert.deepEqual(core.parseMusicControl('pause the music'), { command: 'pause' });
});

test('conversation tasks: quiz/riddle/story/challenge/re-explain parse with topics', () => {
  assert.deepEqual(core.parseConversationTaskIntent('quiz me'), { task: 'quiz_request', topic: '' });
  assert.equal(core.parseConversationTaskIntent('quiz me on history').topic, 'history');
  assert.equal(core.parseConversationTaskIntent('tell me a riddle').task, 'riddle_request');
  assert.equal(core.parseConversationTaskIntent('tell me a story about space').topic, 'space');
  assert.equal(core.parseConversationTaskIntent('give me a challenge').task, 'challenge_request');
  assert.equal(core.parseConversationTaskIntent('can you explain that differently').task, 'explain_differently');
  assert.equal(core.parseConversationTaskIntent('test my knowledge').task, 'quiz_request');
  assert.equal(core.parseConversationTaskIntent('tell me a joke'), null, 'jokes keep their library intent');
  assert.equal(core.parseConversationTaskIntent('open youtube'), null, 'commands are untouched');
  // Every task carries a model instruction so the app can route it.
  for (const [id, def] of Object.entries(core.CONVERSATION_TASK_INTENTS)) {
    assert.ok(def.instruction && def.instruction.length > 30, `${id} instruction`);
  }
});

test('follow-up bridge: a spoken answer flows without a second wake word', () => {
  // While the follow-up window is armed (JARVIS just asked), an utterance
  // without the wake phrase is still routed as a command/answer.
  const armed = core.decideVoiceAction('my day at school was terrible', {
    mode: 'LISTENING', wakeArmed: true, recognitionEnabled: true, busy: false
  });
  assert.equal(armed.action, 'command', JSON.stringify(armed));
  assert.match(armed.command, /terrible/);
  // When the bridge has expired, the same utterance stays ignored until the
  // user says the wake word again (no indefinite hot microphone).
  const standby = core.decideVoiceAction('my day at school was terrible', {
    mode: 'LISTENING', wakeArmed: false, recognitionEnabled: true, busy: false
  });
  assert.equal(standby.action, 'ignore', JSON.stringify(standby));
});

test('own TTS playback is still never treated as the user answer', () => {
  const spoken = 'I am sorry you are feeling that way. Want to tell me what happened?';
  assert.ok(core.isEchoTranscript('want to tell me what happened', spoken, { speaking: true }));
  const decision = core.decideVoiceAction('want to tell me what happened', {
    mode: 'SPEAKING', echoCurrent: true, recognitionEnabled: true, busy: false
  });
  assert.notEqual(decision.action, 'command', JSON.stringify(decision));
});
