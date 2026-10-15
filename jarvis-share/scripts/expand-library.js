'use strict';
// One-shot expansion of the quick-response library (phrase task, second priority).
// Appends curated input patterns per intent (STT variants, contractions,
// casual forms), adds the capability + cancel_operation intents, dedupes by
// normalized form, validates coverage, and writes the JSON back.
// Re-running is idempotent: only genuinely new normalized phrases are added.
const fs = require('fs');
const path = require('path');
const core = require('../jarvis-core.js');

const libPath = path.join(__dirname, '..', 'conversation-library.json');
const library = JSON.parse(fs.readFileSync(libPath, 'utf8'));
const norm = value => core.normalizeConversationText(value);

const additions = {
  who_are_you: ['are you alive', 'are you conscious', 'are you a person', 'are you a machine', 'what exactly are you', 'define jarvis'],
  greeting: ['hey hey', 'yo', 'sup', 'good morning', 'good evening', 'morning', 'evening', 'hey there', 'howdy', 'greetings', 'hello there', 'hi hi'],
  introduction: ['nice to meet you', 'nice meeting you', 'pleased to meet you', 'let me introduce myself', 'i am new here', 'i just started using you', 'first time talking to you', 'good to finally meet you', 'allow me to introduce myself', 'we have not met before'],
  how_are_you: ['how are you doing', 'how is it going', 'how goes it', 'how have you been', 'how are things with you', 'are you doing okay', 'are you doing alright', 'how do you feel', 'you good', 'everything good with you', 'how is your day going'],
  mood_positive: ['feeling awesome', 'i am so happy', 'today is amazing', 'could not be better', 'on top of the world', 'life is great'],
  mood_okay: ['could be worse', 'hanging in there', 'getting by', 'not too bad actually', 'been better been worse'],
  mood_negative: ['i am exhausted', 'i am burned out', 'i feel burnt out', 'today sucked', 'everything is falling apart', 'i wanna give up', 'i feel like giving up', 'drained'],
  thanks: ['thank you so much', 'thanks a ton', 'thanks a bunch', 'much appreciated', 'i appreciate it', 'i really appreciate it', 'thanks for that', 'thank you for that', 'grateful', 'cheers'],
  compliment: ['you are brilliant', 'you are the best assistant', 'that was smart', 'clever answer', 'well done', 'impressive work', 'you nailed it', 'perfect answer'],
  apology: ['i am sorry', 'sorry about that', 'my bad', 'my mistake', 'forgive me', 'pardon me', 'i apologize', 'oops sorry', 'sorry jarvis'],
  goodbye: ['see you later', 'see ya', 'catch you later', 'good night', 'goodnight', 'gotta go', 'i gotta run', 'talk to you later', 'bye for now', 'farewell', 'later', 'i am heading out'],
  laughter: ['haha', 'hahaha', 'lol', 'lmao', 'that is hilarious', 'that is so funny', 'you crack me up', 'i am laughing', 'funny one'],
  surprise: ['no way', 'seriously', 'are you serious', 'you are kidding', 'get out of here', 'wow really', 'i did not expect that', 'that is unexpected'],
  confusion: ['i do not get it', 'i do not understand', 'that makes no sense', 'come again', 'say what', 'what do you mean', 'i am lost', 'lost me there', 'explain that'],
  uncertain: ['i am not sure', 'not really sure', 'hard to say', 'i cannot decide', 'maybe maybe not', 'i dunno', 'dunno', 'beats me', 'your guess is as good as mine'],
  opinion: ['what do you think', 'what is your opinion', 'what is your take', 'in your opinion', 'do you think so', 'what would you say', 'give me your honest opinion', 'be honest with me'],
  plans: ['what are you up to', 'what are you doing', 'got any plans', 'what is on the agenda', 'what is happening', 'anything going on', 'what is new', 'what is up'],
  boredom: ['i am so bored', 'so bored right now', 'bored out of my mind', 'there is nothing to do', 'i need entertainment', 'i need something fun', 'this is boring', 'boring day', 'killing time'],
  joke_request: ['tell me a joke', 'give me a joke', 'i want a joke', 'make me laugh', 'say something funny', 'got any jokes', 'know any good jokes', 'joke please', 'hit me with a joke', 'tell me something funny'],
  short_yes: ['yeah sure', 'sure thing', 'absolutely', 'definitely', 'of course', 'sounds good'],
  short_no: ['nope', 'nah', 'no way', 'not really', 'i do not think so', 'negative', 'no thanks'],
  short_maybe: ['possibly', 'might be', 'could be', 'not certain', 'fifty fifty', 'toss up'],
  acknowledgement: ['roger that', 'copy that', 'noted', 'gotcha', 'will do', 'sounds good to me', 'no worries', 'sure sure'],
  topic_change: ['changing the subject', 'new topic', 'let us talk about something else', 'anyway', 'moving on', 'next subject', 'different question'],
  filler: ['well', 'so anyway', 'you know', 'anyhow', 'hmm okay', 'like you know'],
  excitement: ['awesome', 'amazing', 'fantastic', 'brilliant', 'love it', 'that is great news', 'best news ever', 'woohoo', 'yesss'],
  wait: ['hold on', 'wait a sec', 'give me a sec', 'give me a minute', 'one moment', 'hang on a moment', 'just a moment', 'wait up'],
  guess_what: ['guess what happened', 'you will never guess', 'you will not believe this', 'i have news', 'i have something to tell you', 'listen to this', 'check this out'],
  interesting_fact: ['tell me a fact', 'give me a random fact', 'did you know anything interesting', 'share a fun fact', 'teach me something new', 'tell me something interesting', 'blow my mind'],
  agreement: ['i agree', 'totally agree', 'could not agree more', 'you are right', 'you are absolutely right', 'exactly right', 'well said', 'i think so too'],
  disagreement: ['i disagree', 'i do not agree', 'not exactly', 'i do not think so', 'that is not right', 'i see it differently', 'i see it a bit differently', 'nope disagree'],
  curiosity: ['i wonder why', 'i wonder how', 'makes me wonder', 'curious about that', 'i have been wondering', 'been curious about something'],
  lets_talk: ['let us chat', 'wanna chat', 'wanna talk', 'can we talk', 'i feel like talking', 'keep me company', 'talk with me'],
  what_now: ['what next', 'now what', 'what should we do now', 'where were we', 'what is next', 'okay now what', 'so what now', 'where did we leave off', 'pick up where we left off', 'carry on', 'go ahead', 'please continue', 'let us continue'],
  daily_activity: ['how was your day', 'how is your day', 'what did you do today', 'busy day', 'long day', 'rough day at work', 'how was work', 'how was school today'],
  school: ['homework is hard', 'too much homework', 'i hate exams', 'exams are coming', 'studying is boring', 'i have a test tomorrow', 'school is stressful', 'classes are tough'],
  hobby: ['i like gaming', 'i enjoy music', 'i love movies', 'my hobby is reading', 'i play guitar', 'i like drawing', 'weekend hobby', 'new hobby ideas'],
  gaming: ['wanna play a game', 'let us play something', 'i love this game', 'gaming all night', 'what games do you know', 'recommend a game'],
  music_chat: ['i love this song', 'great song', 'what song is this', 'music is life', 'i am into rock', 'favorite band', 'what music do you like'],
  movies: ['recommend a movie', 'good movie tonight', 'what should i watch', 'movie night ideas', 'i love that film', 'best movie ever'],
  slang: ['what is up', 'whats up', 'wassup', 'yo what is good', 'chilling', 'just vibing', 'all good', 'no cap'],
  frustration: ['this is annoying', 'so frustrating', 'i am fed up', 'ugh', 'argh', 'that is so dumb', 'why is this so hard', 'i give up'],
  follow_up: ['another one', 'one more', 'give me another', 'tell me another one', 'do that again', 'more please', 'keep going', 'and another', 'what else you got', 'keep them coming', 'do not stop', 'more more'],
  casual_discussion: ['so what do you think', 'any thoughts', 'just wondering', 'random question', 'can i ask you something', 'got a minute to chat', 'let me ask you', 'real talk'],
  hobby_followup: ['what about you', 'do you have hobbies', 'what do you do for fun', 'do you play games', 'do you like music', 'what are your hobbies'],
  food: ['i am hungry', 'what is for dinner', 'what should i eat', 'recommend some food', 'i want pizza', 'craving something sweet', 'lunch ideas', 'breakfast ideas']
};

const newIntents = [
  {
    category: 'social',
    intent: {
      id: 'capability',
      patterns: ['what can you do', 'what are you capable of', 'what can you help me with', 'what features do you have', 'what can you help me do', 'what commands do you understand', 'what are your abilities', 'show me what you can do', 'tell me what you are able to do', 'what can i ask you to do', 'what functions do you support', 'give me a list of your features', 'how can you help me', 'what are your main functions', 'what can i use you for', 'what else can you do', 'i need help'],
      responses: [
        'I can chat with a local AI model, open apps and websites, search Google and YouTube, find your files, manage alarms, reminders and calendar events, remember notes, draft emails and Discord messages for your approval, control browser tabs once enabled, and run a confirmed shutdown countdown.',
        'Think of me as a desktop helper: ask me to open something, search for something, set an alarm, add a calendar event, remember a note, or check what you asked before.',
        'My main functions are local chat, opening apps and sites, web and music search, file search across your folders, calendar and reminders, saved notes with recall, approval-based email and Discord drafts, tab control, and shutdown.',
        'You can ask me to play or pause music, list browser tabs, find a file, check the schedule, or summarize a search — try one.',
        'I handle everyday PC tasks by voice or text: launching programs, looking things up, keeping your schedule, and remembering things you tell me.',
        'Ask me for the time, your schedule, your saved notes, a web search, or a song on YouTube Music.',
        'I never send anything on my own — email and Discord drafts always wait for your approval first.',
        'Short version: chat, open, search, schedule, remember, and control playback and tabs.',
        'For example: open Steam, search for rain sounds, set an alarm for 7 AM, find my homework, or what did we discuss yesterday.',
        'I can also snooze alarms, move calendar events, search your conversations, and switch browser tabs.',
        'Anything outside my tools, I will say plainly instead of guessing.',
        'Tell me what you want done — if it fits my tools I will do it, otherwise I will explain.'
      ]
    }
  },
  {
    category: 'social',
    intent: {
      id: 'cancel_operation',      patterns: ['never mind', 'actually never mind', 'forget it', 'forget about it', 'drop it', 'leave it', 'skip that', 'does not matter', 'doesnt matter', 'let it go', 'cancel that', 'abort that', 'stop that', 'do that instead'],
      responses: [
        'Dropped it — nothing changed.',
        'No problem, I left everything exactly as it was.',
        'Consider it cancelled.',
        'All right, I stopped there.',
        'Understood — moving on.',
        'That request is gone.',
        'No harm done. What is next?',
        'Cancelled. Ready when you are.'
      ]
    }
  },
  {
    category: 'social',
    intent: {
      id: 'who_are_you',
      patterns: ['what are you', 'are you a robot', 'are you human', 'are you real', 'are you an ai', 'what kind of assistant are you', 'who made you', 'what is this jarvis thing', 'are you alive', 'are you conscious', 'are you a person', 'are you a machine', 'what exactly are you', 'define jarvis'],
      responses: [
        'I am JARVIS, a personal desktop assistant that runs on this computer.',
        'JARVIS here — your local voice assistant for this PC.',
        'I am an on-device assistant: I open apps, search, keep your schedule, and chat with a local AI model.',
        'Think of me as the voice of this computer, here to help you run it.',
        'I am JARVIS, built to manage your desktop by voice or text.',
        'A local assistant living in your PC — no cloud account, no strangers listening.',
        'I am your JARVIS system: part organizer, part remote control, part company.',
        'Just JARVIS — say my name and tell me what you need.'
      ]
    }
  },
  {
    category: 'social',
    intent: {
      id: 'are_you_listening',
      patterns: ['are you listening', 'are you there', 'are you awake', 'are you online', 'are you working', 'can you hear me', 'do you hear me', 'are you ready', 'you there', 'hello are you there', 'is anyone there', 'are you active'],
      responses: [
        'Listening, Sir. Say the word.',
        'I am here and listening.',
        'Online and ready.',
        'Loud and clear on my end.',
        'Present. What do you need?',
        'Always listening for my name.',
        'Ready when you are.',
        'Here, Sir. Go ahead.'
      ]
    }
  },
  {
    category: 'social',
    intent: {
      id: 'repeat_request',
      patterns: ['repeat that', 'say that again', 'say it again', 'come again please', 'one more time please', 'what did you just say', 'what was that again', 'can you repeat', 'please repeat', 'run that by me again', 'sorry what was that', 'pardon what did you say'],
      responses: [
        'My last answer is on screen just above — I keep the conversation visible so nothing gets lost.',
        'Scroll up a little: everything I say stays in the conversation log.',
        'It is on screen above. Want me to continue from there?',
        'The conversation panel holds my last reply word for word.',
        'Check the chat log above — and tell me which part to go over again.',
        'Everything stays on screen, so just glance up.',
        'My replies live in the feed above this message.',
        'Look up one message — that was me.'
      ]
    }
  },
  {
    category: 'social',
    intent: {
      id: 'troubleshooting',
      patterns: ['it is not working', 'this is not working', 'something is broken', 'you are not working', 'jarvis is broken', 'help it is broken', 'fix yourself', 'why are you not working', 'what is wrong with you', 'are you broken', 'that did not work', 'it did not work'],
      responses: [
        'Sorry about that. Tell me which part failed — voice, AI answers, music, calendar, or something else — and I will walk through it.',
        'Let us diagnose it. What were you trying to do when it failed?',
        'Noted. If the AI seems stuck, say “check AI status” and I will report what I find.',
        'Tell me the exact words you used and what happened instead.',
        'We will sort it out. Start with what you expected versus what you got.',
        'If voice is the issue, check the microphone in Voice Settings; if answers fail, check AI Settings.',
        'Describe the failure in one sentence and I will take it from there.',
        'Okay, troubleshooting mode. What broke, and what did you expect?'
      ]
    }
  }
];

let added = 0;
for (const category of library.categories) {
  for (const intent of category.intents || []) {
    const extra = additions[intent.id] || [];
    intent.patterns = intent.patterns || [];
    const seen = new Set(intent.patterns.map(norm));
    for (const phrase of extra) {
      const key = norm(phrase);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      intent.patterns.push(phrase);
      added++;
    }
  }
}
for (const { category, intent } of newIntents) {
  const cat = library.categories.find(c => c.id === category);
  if (!cat) throw new Error(`missing category ${category}`);
  if (!(cat.intents || []).some(i => i.id === intent.id)) {
    cat.intents.push(intent);
    added += intent.patterns.length;
  }
}
// Priority order (§3): cancellation beats topic-change on identical phrasings
// ("never mind", "forget it"), and an explicit repeat request beats general
// confusion ("say that again"). Ties break by intent order, so the first id
// in each pair sorts before the second.
for (const category of library.categories) {
  const intents = category.intents || [];
  for (const [first, second] of [['cancel_operation', 'topic_change'], ['repeat_request', 'confusion']]) {
    const a = intents.findIndex(i => i.id === first);
    const b = intents.findIndex(i => i.id === second);
    if (a > b && b >= 0) {
      const [moved] = intents.splice(a, 1);
      intents.splice(b, 0, moved);
    }
  }
}
// Removals: phrases that belong to an earlier-listed intent stay there;
// duplicates added here by mistake are pruned by normalized form.
const removals = {
  who_are_you: ['who are you', 'introduce yourself', 'tell me about yourself', 'what is jarvis']
};
for (const category of library.categories) {
  for (const intent of category.intents || []) {
    const drop = new Set((removals[intent.id] || []).map(norm));
    if (!drop.size) continue;
    intent.patterns = (intent.patterns || []).filter(p => !drop.has(norm(p)));
  }
}

// Validation and exact counts.
const matchable = [];
for (const category of library.categories) {
  for (const intent of category.intents || []) {
    if (intent.id === 'app_open_success') continue;
    matchable.push(intent);
  }
}
const thin = matchable.filter(i => (i.patterns || []).length < 10);
const unique = new Set();
for (const intent of matchable) for (const p of intent.patterns || []) unique.add(norm(p));
let responses = 0;
for (const intent of matchable) responses += (intent.responses || []).length;
console.log(`intents=${matchable.length} uniquePhrases=${unique.size} responses=${responses} addedThisRun=${added}`);
console.log(`intentsUnder10=${thin.length}${thin.length ? ' :: ' + thin.map(i => `${i.id}=${(i.patterns || []).length}`).join(', ') : ''}`);
fs.writeFileSync(libPath, JSON.stringify(library, null, 2) + '\n');
if (thin.length) { console.error('COVERAGE_GAP'); process.exit(1); }
