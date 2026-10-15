'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');
const conversationLibrary = require('../conversation-library.json');

test('wake parser handles the wake name anywhere in a recognized sentence', () => {
  for (const phrase of ['Hey JARVIS, open TikTok', 'Hey Jervis open TikTok', 'Jarvis, what time is it?']) {
    const result = core.parseWakeTranscript(phrase);
    assert.equal(result.activated, true, phrase);
    assert.match(result.command, /(?:open TikTok|what time is it)/i);
  }
  assert.equal(core.parseWakeTranscript('Hey, Jarvis.').activated, true);
  // The parser now also reports a wake confidence (0.6-1.0) used by the
  // diagnostics panel; match keeps the original transcript casing.
  // A bare "Jarvis" at the start is a confident wake match (0.9); the 0.6 tier
  // is reserved for a wake word found mid-sentence.
  assert.deepEqual(core.parseWakeTranscript('Jarvis'), { activated: true, match: 'Jarvis', command: '', transcript: 'Jarvis', confidence: 0.9 });
  assert.equal(core.parseWakeTranscript('Open Steam').activated, false);
  assert.equal(core.parseWakeTranscript('How is your day?').activated, false);
  assert.equal(core.parseWakeTranscript('The word Jarvis appeared in this sentence').activated, true);
  // Mid-sentence wake now returns the normalized command ready for intent
  // parsing; polite lead-ins are stripped later by the intent parsers.
  assert.equal(core.parseWakeTranscript('Could you open Roblox, Jarvis?').command, 'open roblox');
  assert.equal(core.parseWakeTranscript('Open Jarvis settings').activated, true);
});

test('wake parser tolerates common phonetic variants only at the start', () => {
  for (const phrase of ['They obviously open music', 'Aidarius, open Steam', 'A Darius.', 'The Jarvis what time is it']) {
    const result = core.parseWakeTranscript(phrase);
    assert.equal(result.activated, true, phrase);
  }
  assert.equal(core.parseWakeTranscript('I think they obviously need help').activated, false);
});

test('website intent maps TikTok to its official public site, not a similarly named app', () => {
  assert.equal(core.parseWebsiteIntent('Could you please open TikTok for me?')?.url, 'https://www.tiktok.com/');
  assert.equal(core.parseWebsiteIntent('open TikTok Studio'), null);
  assert.equal(core.parseWebsiteIntent('visit Instagram')?.url, 'https://www.instagram.com/');
  assert.equal(core.parseWebsiteIntent('Open YouTube Music')?.url, 'https://music.youtube.com/');
  assert.equal(core.parseWebsiteIntent('open music')?.url, 'https://music.youtube.com/');
});

test('platform search intents keep YouTube, YouTube Music, and plain site opening distinct', () => {
  assert.deepEqual(core.parseSiteSearchIntent('Search up Zbing channel on YouTube'), { site: 'youtube', query: 'Zbing channel', silent: true });
  assert.deepEqual(core.parseSiteSearchIntent('Open this song Magnetic by ILLIT on YouTube Music'), { site: 'youtube-music', query: 'Magnetic by ILLIT', silent: false });
  assert.deepEqual(core.parseSiteSearchIntent('Find Stardew Valley videos on YouTube'), { site: 'youtube', query: 'Stardew Valley videos', silent: true });
  assert.equal(core.parseSiteSearchIntent('Open YouTube'), null);
  assert.equal(core.parseWebsiteIntent('Open YouTube')?.url, 'https://www.youtube.com/');
  assert.equal(core.parseWebsiteIntent('Open YouTube Music')?.url, 'https://music.youtube.com/');
  assert.deepEqual(core.parseSearchCommand('Search up Zbing channel'), { site: 'google', query: 'Zbing channel', silent: true });
  assert.deepEqual(core.parseSearchCommand('Hey Jarvis, search up this or that'), { site: 'google', query: 'this or that', silent: true });
  assert.deepEqual(core.parseSearchCommand('Could you please search up Zbing channel?'), { site: 'google', query: 'Zbing channel', silent: true });
  assert.equal(core.parseSearchCommand('What is the president of Thailand?'), null);
  assert.equal(core.isDirectResearchQuestion('What is the president of Thailand?'), true);
  assert.equal(core.isDirectResearchQuestion('Why does the computer fan sound loud?'), true);
  assert.equal(core.isDirectResearchQuestion('How are you today?'), false);
});

test('close parser distinguishes a browser tab, current app, and named app', () => {
  assert.deepEqual(core.parseCloseIntent('Close the tab'), { kind: 'close-current-tab' });
  assert.deepEqual(core.parseCloseIntent('Could you close the Chrome tab?'), { kind: 'close-current-tab' });
  assert.deepEqual(core.parseCloseIntent('Close the app'), { kind: 'close-current-app' });
  assert.deepEqual(core.parseCloseIntent('Close it'), { kind: 'close-current-app' });
  assert.deepEqual(core.parseCloseIntent('Please close Steam'), { kind: 'close-app', name: 'Steam' });
});

test('conversation normalizer handles fillers and contractions without deleting literal words', () => {
  assert.equal(core.normalizeConversationText('Well, it was okay!'), 'it was okay');
  assert.equal(core.normalizeConversationText("Well, I don't know."), 'i do not know');
  assert.equal(core.normalizeConversationText('The well is deep.'), 'the well is deep');
});

test('mood classification preserves meaning after leading fillers and negation', () => {
  const askMood = [{ who: 'J.A.R.V.I.S.', text: 'How have you been doing?' }];
  assert.equal(core.classifyLocalConversation('Well, it was okay.', askMood, conversationLibrary)?.intentId, 'mood_okay');
  assert.equal(core.classifyLocalConversation('Well, today was great!', askMood, conversationLibrary)?.intentId, 'mood_positive');
  assert.equal(core.classifyLocalConversation('Well, it was terrible.', askMood, conversationLibrary)?.intentId, 'mood_negative');
  assert.equal(core.classifyLocalConversation('I am not tired.', askMood, conversationLibrary)?.intentId, 'mood_positive');
  assert.equal(core.classifyLocalConversation('I do not feel good.', askMood, conversationLibrary)?.intentId, 'mood_negative');
  assert.equal(core.classifyLocalConversation('The well is deep.', askMood, conversationLibrary), null);
});

test('short answers use the prior question and unfamiliar facts stay on the model route', () => {
  const history = [{ who: 'J.A.R.V.I.S.', text: 'Anything interesting happen today?' }];
  assert.equal(core.classifyLocalConversation('Not really.', history, conversationLibrary)?.intentId, 'short_no');
  assert.equal(core.classifyLocalConversation('Maybe.', history, conversationLibrary)?.intentId, 'short_maybe');
  assert.equal(core.classifyLocalConversation('Yes!', history, conversationLibrary)?.intentId, 'short_yes');
  assert.equal(core.classifyLocalConversation('Who is the current president?', history, conversationLibrary), null);
  assert.equal(core.classifyLocalConversation('I played games with my friends.', history, conversationLibrary)?.intentId, 'gaming');
});

test('local replies vary and avoid recent responses, and app-launch quips use the app name', () => {
  const first = core.chooseConversationResponse(conversationLibrary, 'greeting', [], () => 0);
  const next = core.chooseConversationResponse(conversationLibrary, 'greeting', [first], () => 0);
  assert.notEqual(first, next);
  assert.match(core.chooseConversationResponse(conversationLibrary, 'app_open_success', [], () => 0, { app: 'Roblox' }), /Roblox/);
  assert.equal(core.replyLocally('Who is the current president?', [], conversationLibrary), null);
});

test('music intent requires a clear play request and does not swallow ordinary speech', () => {
  assert.deepEqual(core.parseMusicIntent('Play Magnetic by ILLIT'), { kind: 'search', query: 'Magnetic by ILLIT' });
  assert.deepEqual(core.parseMusicIntent('Play my playlist study mix'), { kind: 'search', query: 'playlist study mix' });
  assert.deepEqual(core.parseMusicIntent('Play something relaxing'), { kind: 'search', query: 'relaxing music' });
  for (const phrase of [
    'open music once whenever i say anything it thinks it a song',
    'Hey JARVIS, what is the weather?',
    'Hello, can you help me write an email?',
    'open music'
  ]) assert.equal(core.parseMusicIntent(phrase), null, phrase);
});

test('conversation history is bounded and converted to Ollama roles', () => {
  const history = Array.from({ length: 25 }, (_, index) => ({ who: index % 2 ? 'J.A.R.V.I.S.' : 'YOU', text: `message ${index}` }));
  const messages = core.toConversationMessages(history, 8);
  assert.equal(messages.length, 8);
  assert.equal(messages[0].content, 'message 17');
  assert.equal(messages.at(-1).role, 'user');
});

test('voice state machine permits wake, command, thinking, speaking, and interruption turns', () => {
  const machine = new core.VoiceStateMachine();
  for (const state of ['LISTENING_FOR_WAKE_WORD', 'LISTENING_FOR_COMMAND', 'THINKING', 'SPEAKING', 'INTERRUPTED', 'LISTENING_FOR_COMMAND']) machine.transition(state);
  assert.equal(machine.state, 'LISTENING_FOR_COMMAND');
  const handsFree = new core.VoiceStateMachine();
  handsFree.transition('LISTENING_FOR_COMMAND');
  assert.equal(handsFree.state, 'LISTENING_FOR_COMMAND');
  assert.throws(() => new core.VoiceStateMachine().transition('SPEAKING'), /Invalid JARVIS voice transition/);
});

test('speech gate calibrates steady fan noise, ignores clicks, and opens for sustained voice', () => {
  const gate = new core.SpeechGate({ calibrationMs: 600, onsetMs: 240 });
  for (let i = 0; i < 7; i++) gate.sample(0.02, 100);
  assert.ok(gate.noiseFloor >= 0.019 && gate.noiseFloor <= 0.021, 'calibration should learn the steady room/fan level');
  for (let i = 0; i < 15; i++) assert.equal(gate.sample(0.02, 100).trigger, false, 'steady fan should not trigger speech');
  gate.reset();
  for (let i = 0; i < 7; i++) gate.sample(0.02, 100);
  assert.equal(gate.sample(0.06, 100).trigger, false, 'a single keyboard-like click should not trigger speech');
  gate.sample(0.02, 100); gate.sample(0.02, 100);
  assert.equal(gate.sample(0.05, 100).trigger, false, 'separated short noises should not accumulate as continuous speech');
  gate.sample(0.05, 100);
  assert.equal(gate.sample(0.05, 100).trigger, true, 'sustained voice above the learned background should open the gate');
});

test('planner parser resolves local weekday alarms and asks about ambiguous AM/PM', () => {
  const now = new Date(2026, 9, 11, 15, 0, 0);
  const weekday = core.parsePlannerIntent('Set an alarm for 7 AM on weekdays', now);
  assert.equal(weekday.kind, 'create-alarm');
  assert.equal(weekday.repeat, 'weekdays');
  assert.equal(new Date(weekday.when).getDay(), 1);
  assert.equal(new Date(weekday.when).getHours(), 7);
  const unclear = core.parsePlannerIntent('Set an alarm for 7 tomorrow', now);
  assert.equal(unclear.kind, 'clarify-alarm');
});

test('planner parser accepts natural alarm cancellation wording and polite voice lead-ins', () => {
  const cases = [
    ['Cancel the alarm', ''],
    ['Cancel my alarm', ''],
    ['Cancel the 7 AM alarm', '7 am'],
    ['Cancel alarm at 7:30 PM', '7:30 pm'],
    ['Could you please cancel the alarm for 8 AM?', '8 am'],
    ['Jarvis, can you delete my alarm at 6:15 AM?', '6:15 am'],
  ];
  for (const [spoken, query] of cases) {
    const intent = core.parsePlannerIntent(spoken);
    assert.equal(intent?.kind, 'cancel-alarm', spoken);
    assert.equal(intent.query, query, spoken);
  }
  assert.match(core.parsePlannerIntent('Cancel alarm at 7')?.message || '', /AM or PM/, 'ambiguous cancel time should ask before acting');
});

test('planner parser creates a dated local event with duration and reminder', () => {
  const now = new Date(2026, 9, 11, 10, 0, 0);
  const event = core.parsePlannerIntent('Add an event called math revision tomorrow at 5 PM remind me 15 minutes before', now);
  assert.equal(event.kind, 'create-event');
  assert.equal(event.title, 'math revision');
  assert.equal(event.reminderMinutes, 15);
  assert.equal(new Date(event.start).getDate(), 12);
  assert.equal(new Date(event.start).getHours(), 17);
  assert.equal(Date.parse(event.end) - Date.parse(event.start), 3600000);
});
