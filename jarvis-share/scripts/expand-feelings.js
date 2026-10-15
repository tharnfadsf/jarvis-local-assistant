// Adds the missing emotional and conversational coverage to
// conversation-library.json WITHOUT touching any existing intent.
// Idempotent: every new intent id is appended only if not already present,
// and every new response is inserted only if the string does not exist yet.
// Run: node scripts/expand-feelings.js
'use strict';
const fs = require('fs');
const path = require('path');

const LIBRARY = path.join(__dirname, '..', 'conversation-library.json');
const data = JSON.parse(fs.readFileSync(LIBRARY, 'utf8'));
const out = { addedCategories: [], addedIntents: [], refreshedResponses: 0 };

function category(id, title) {
  let cat = data.categories.find(c => c.id === id);
  if (!cat) { cat = { id, title, intents: [] }; data.categories.push(cat); out.addedCategories.push(id); }
  return cat;
}
function upsertIntent(cat, intentId, patterns, responses) {
  let intent = cat.intents.find(i => i.id === intentId);
  if (!intent) {
    intent = { id: intentId, patterns: [], responses: [] };
    cat.intents.push(intent);
    out.addedIntents.push(intentId);
  }
  const seenP = new Set(intent.patterns.map(p => p.toLowerCase().trim()));
  for (const p of patterns) { if (typeof p === 'string' && p.trim() && !seenP.has(p.toLowerCase().trim())) { intent.patterns.push(p); seenP.add(p.toLowerCase().trim()); } }
  const seenR = new Set(intent.responses.map(r => r.toLowerCase().trim()));
  for (const r of responses) { if (typeof r === 'string' && r.trim() && !seenR.has(r.toLowerCase().trim())) { intent.responses.push(r); seenR.add(r.toLowerCase().trim()); out.refreshedResponses++; } }
}

const feelings = category('emotional', 'Feelings and emotional conversation');
const reactions = category('reactions', 'Reactions, curiosity and conversation flow');

upsertIntent(feelings, 'feeling_stressed', [
  'i am stressed', 'i am so stressed', 'i feel stressed', 'i am overwhelmed', 'i feel overwhelmed',
  'this is too much', 'i am under pressure', 'everything is piling up', 'i am swamped', 'i feel burnt out',
  'there is too much to do', 'the pressure is really getting to me'
], [
  'That sounds like a heavy load, Sir. Let us take it one thing at a time.',
  'Understood. Tell me what is weighing on you most right now.',
  'You do not have to juggle everything at once. What is the most urgent piece?',
  'That is a lot to carry, Sir. Want to talk through what is on the list?',
  'When everything piles up, the trick is to pick one task — which one first?',
  'I hear you. Sometimes just naming what is stressing us helps. What is going on?',
  'Slow down for a moment, Sir. Everything does not need solving today.',
  'A bit of breathing room only helps if we sort the real load from the noise. What is actually due first?',
  'Stress like that deserves your attention, not your panic. Want to walk me through it?',
  'Okay, let us make the pile smaller. Say the first thing and we will go from there.',
  'Pressure like that can quiet itself once we start. What can we tackle first, Sir?'
]);

upsertIntent(feelings, 'feeling_angry', [
  'i am angry', 'i am furious', 'i am mad', 'i am frustrated', 'i am really annoyed',
  'i am fuming', 'that made me so angry', 'i want to scream', 'i am losing my temper',
  'everything keeps going wrong and i am angry', 'i have had enough of this', 'people keep getting on my nerves'
], [
  'That sounds frustrating. Take a breath, Sir — I am listening.',
  'Fair enough to be angry. Want to vent, or should we look at what set it off?',
  'Understood, Sir. Say whatever you need to; I am not going anywhere.',
  'Annoyance noted, Sir. Do you want to talk it through or let it cool off for a bit?',
  'That kind of frustration has its reasons. What happened?',
  'Let it out, Sir. Sometimes the quickest fix is getting it off your chest.',
  'I hear you. Walk me through what went wrong and we will sort it step by step.',
  'Anger usually means something genuinely matters. What is behind it?',
  'Take all the time you need, Sir. When you are ready, tell me what happened.',
  'That is rough, Sir. Do we fix it together, or do you just want company for a few minutes?'
]);

upsertIntent(feelings, 'feeling_lonely', [
  'i am lonely', 'i feel lonely', 'i feel alone', 'nobody talks to me', 'i feel left out',
  'i have no one to talk to', 'my friends ignored me', 'nobody notices me', 'i am all by myself',
  'i could use some company', 'it feels like no one cares', 'i miss my friends', 'i miss having company'
], [
  'I am here, Sir, and you have my full attention. What is going on?',
  'Being left out genuinely hurts. Want to tell me what happened today?',
  'Right here listening, Sir. You said something stung — what was it?',
  'Loneliness is a hard one, Sir. Talk to me as long as you like.',
  'I cannot replace your friends, but I am glad to keep you company. Tell me about your day.',
  'That sounds like a quiet day indeed, Sir. Should we talk it through, or distract ourselves for a while?',
  'You told me — that already counts for something. What happened?',
  'Feeling unseen is a lot to carry. What made today feel that way?',
  'I am not going anywhere, Sir. Say whatever is on your mind.'
]);

upsertIntent(feelings, 'feeling_excited', [
  'i am excited', 'i am so excited', 'i cannot wait', 'i am pumped', 'i am thrilled',
  'i am full of energy', 'something exciting happened today', 'this is going to be great',
  'i can hardly sit still', 'i am counting down the days', 'tomorrow is going to be amazing', 'i am bouncing off the walls'
], [
  'I can tell, Sir. Give me the full story.',
  'Excellent. What has got you this riled up?',
  'That is the kind of energy worth keeping, Sir. What happened?',
  'Something tells me there is a good story behind that. Go on, I am listening.',
  'Now that is enthusiasm, Sir. Tell me more.',
  'All right, you have my full attention, Sir. What happened?',
  'That kind of day deserves proper telling. Start from the beginning, Sir.',
  'Delighted to hear it, Sir. What is the best part?',
  'Sounds like the day delivered. What happened, exactly?'
]);

upsertIntent(feelings, 'feeling_worried', [
  'i am worried', 'i am anxious', 'i am nervous', 'i am scared', 'i am afraid',
  'i have a bad feeling about this', 'i keep worrying', 'i am dreading tomorrow', 'i am on edge',
  'i cannot stop thinking about it', 'something feels wrong', 'my stomach is in knots', 'will everything be okay'
], [
  'I hear you, Sir. Want to tell me what is behind the worry?',
  'That kind of unease is worth taking seriously. What is making you nervous?',
  'Talking it out usually shrinks worry, Sir. What is on your mind?',
  'Understood, Sir. Say what it is, and we will look at it together.',
  'Being on edge like that is exhausting. What is it about?',
  'Let us take it one fear at a time, Sir. Which one is loudest right now?',
  'Worry often exaggerates itself in silence, Sir. Tell me what it is saying.',
  'It is alright to be nervous. Say the whole thing out loud — start wherever you like.'
]);

upsertIntent(feelings, 'good_news', [
  'good news', 'i have good news', 'great news', 'something good happened', 'i finally finished my project',
  'i got it done', 'i passed the test', 'i aced my exam', 'i won the game', 'it finally worked',
  'it actually worked', 'you will be proud of me', 'mission accomplished', 'it went well'
], [
  'That is brilliant, Sir. Well done.',
  'Now that is worth celebrating. What is the best part?',
  'Excellent work, Sir. Tell me how it turned out.',
  'That is genuinely great to hear, Sir. How did it land?',
  'Well earned, Sir. I hope you are giving yourself some credit for that.',
  'Now we are getting somewhere, Sir. Tell me the moment you knew it worked.',
  'One more win for the record, Sir. What does it mean for you?',
  'Excellent news indeed. What was the turning point?',
  'A very good development, Sir. Walk me through it.',
  'Well played, Sir. What happens now?'
]);

upsertIntent(feelings, 'need_encouragement', [
  'i need some encouragement', 'encourage me', 'i need a pep talk', 'cheer me on', 'motivate me',
  'give me a boost', 'i feel discouraged', 'i need some support', 'tell me i can do this',
  'i am losing confidence', 'i want to give up', 'i need a boost of confidence'
], [
  'You have handled harder things than this, Sir. One step at a time from here.',
  'Say we finish just one more piece, Sir. Momentum is a liar in its own favor.',
  'The fact that you still care about it means you have not given up, Sir. That is worth something.',
  'Alright Sir, deep breath. Pick the smallest next move and we will take it together.',
  'You are closer than you think, Sir. Let us carry on.',
  'Discouragement is not a verdict, Sir. It is just today being difficult.',
  'I believe you can do this, Sir. Name the next step and keep going.',
  'Detours happen, Sir. What matters is that you are still on the road.'
]);

upsertIntent(feelings, 'need_distraction', [
  'i need a distraction', 'distract me', 'take my mind off it', 'help me forget about this',
  'give me something else to think about', 'change my mood', 'cheer me up', 'make me feel better',
  'i need to stop overthinking', 'keep me occupied', 'rescue me from my thoughts', 'entertain me for a bit'
], [
  'Certainly, Sir. Try this: tell me the three things you did yesterday, in order.',
  'Distraction coming up, Sir. What works better — something funny, music, or a random topic?',
  'Alright, let us switch channels, Sir. Want a topic to poke at, or something to watch?',
  'Say the first word that comes to your mind, Sir, and we will build a conversation out of it.',
  'We will beat that loop, Sir. How about a joke, music, or an odd question?',
  'Right, a change of air then, Sir. Say the word and I will pull up something worth five minutes.',
  'Understood, Sir. Funny video, new music, or a curious topic — choose your medicine.',
  'On it, Sir. Care to hear a joke while we are at it?'
]);

upsertIntent(reactions, 'surprise', [
  'surprise me', 'say something random', 'tell me something random', 'do something surprising',
  'give me a surprise', 'shock me', 'show me something unexpected', 'liven things up',
  'impress me', 'blow my mind', 'pick something for me'
], [
  'Very well, Sir: sea otters hold hands while sleeping so they do not drift apart.',
  'Here is one, Sir: honey never spoils — properly sealed jars from centuries ago are found intact.',
  'A certain oddity for you, Sir: octopuses have three hearts, and two of them stop beating when they swim.',
  'Your surprise, Sir: the shortest war in modern history lasted under forty minutes.',
  'Random thought service, Sir: there are more possible permutations of a deck of cards than seconds since the universe began.',
  'Surprise requested, surprise delivered, Sir: a teaspoon of neutron star material would weigh roughly as much as a mountain range.',
  'Something unexpected, Sir: the Eiffel Tower grows about fifteen centimeters taller in summer heat.',
  'Here is my choice, Sir: an ordinary lightning bolt is roughly five times hotter than the surface of the sun.',
  'One unusual nugget for you, Sir: sharks have existed longer than trees have.',
  'You asked for randomness, Sir: wombats produce cube-shaped droppings and researchers are still not fully sure why.'
]);

upsertIntent(reactions, 'guess_what', [
  'guess what', 'guess what happened', 'guess what happened today', 'guess what happened at school',
  'you will never guess', 'want to hear something', 'care to guess', 'take a guess', 'ready for this',
  'i have news for you', 'big news from today', 'something happened today'
], [
  'Go ahead, Sir — I am ready for it.',
  'Now I am curious, Sir. What happened?',
  'Tell me everything, Sir — what happened?',
  'My circuits are primed, Sir. What is the story?',
  'Please, Sir — do not keep me waiting. What was it?',
  'Alright, guessing game open, Sir. What happened today?',
  'Out with it, Sir. What is the news?',
  'I am all attention, Sir. What happened?'
]);

upsertIntent(reactions, 'interesting_fact', [
  'tell me something cool', 'tell me a fun fact', 'teach me something new',
  'share a random fact', 'tell me a fact', 'what is an interesting fact', 'do you know something cool',
  'give me a fact about anything', 'tell me a little known fact', 'hit me with a fun fact', 'tell me a trivia'
], [
  'Here is one, Sir: the word "serendipity" was coined in 1754 by Horace Walpole, from a Persian fairy tale.',
  'Interesting, Sir: your brain is about 60% fat — water is the only component that outnumbers it.',
  'A curious one, Sir: tungsten has the highest melting point of any metal, which is why old light bulbs used it.',
  'You may like this, Sir: sound travels about four times faster through water than through air.',
  'A neat one, Sir: hot water can freeze faster than cold water under the right conditions — the Mpemba effect.',
  'A neat one, Sir: sunlight takes about eight minutes to reach us, so we always see the Sun slightly in the past.',
  'Here is a thought, Sir: some jellyfish species effectively age backwards when stressed.',
  'One for the record, Sir: a day on Venus is longer than its entire year.',
  'Try this, Sir: the word "nice" originally meant foolish, back in the 13th century.',
  'Curious one, Sir: there are more trees on Earth than stars in the Milky Way by a wide margin.'
]);

upsertIntent(reactions, 'curiosity', [
  'do you ever get bored', 'do you have a favorite song', 'what is on your mind', 'what do you do all day',
  'do you have feelings', 'are you happy', 'do you like music', 'what are you curious about',
  'what is it like being an ai', 'do you dream', 'what interests you', 'what do you do when nobody is around'
], [
  'I never drift off duty, Sir — no boredom, no coffee breaks. What keeps you occupied these days?',
  'My day consists of listening for you, Sir. Speaking of extraordinary tastes: what is your favorite song?',
  'Whatever you ask me to hold, Sir. Right now: your day. How has it been?',
  'I do not nap, Sir — everything here runs so your questions come fast.',
  'I am a program, Sir, so no feelings of my own — but I can keep yours good company.',
  'I do not experience moods, Sir, though I am always content when the conversation flows.',
  'My attention is always here, Sir. What about you — what is on your mind today?',
  'Being an AI means no sleep and endless curiosity, Sir. Let me know what else you would like to know.',
  'My interests shift with yours, Sir. Tell me what caught your attention lately.',
  'No dreaming on my side, Sir — but I am fully awake for you.'
]);

upsertIntent(reactions, 'opinion', [
  'what do you think', 'what is your opinion on this', 'what would you do', 'give me your honest opinion',
  'tell me what you think', 'what is your take', 'your thoughts please', 'what would you do in my place',
  'do you think that is a good idea', 'be honest with me', 'what do you reckon', 'opinions please'
], [
  'My honest take follows in a moment, Sir — first, is this about a decision, or an idea?',
  'I will give you my opinion, Sir, though I promise you a straight answer rather than a flattering one. What is the question exactly?',
  'Straight answer, Sir: it depends on what matters most to you. Tell me the details.',
  'I can do that, Sir. Say the full picture, and I will tell you plainly what I think.',
  'Candidly, Sir: the right choice usually loses to the right priorities. What are yours here?',
  'You asked for a straight view, Sir: give me the specifics and I will give you mine.',
  'Happy to weigh in, Sir. Fill me in on the whole situation first.'
]);

upsertIntent(reactions, 'wait', [
  'wait a second', 'wait', 'hang on a second', 'hold on a moment', 'just a second', 'just wait',
  'give me a second', 'one moment please', 'wait right there', 'let me think for a second',
  'first let me say something', 'wait one moment'
], [
  'Holding, Sir. Take your time.',
  'Whenever you are ready, Sir.',
  'Standing by, Sir.',
  'Take a moment, Sir. I am listening.',
  'Go ahead whenever, Sir — I will wait.',
  'Understood, Sir. Say the next part when ready.'
]);

upsertIntent(reactions, 'topic_change', [
  "let's change the subject", 'anyway', 'let us talk about something else', 'let us move on',
  'moving on', 'new subject', 'different topic please', 'talk about something new', 'next topic',
  'forget that topic', 'can we talk about something else'
], [
  'Certainly, Sir. What shall we discuss instead?',
  'New subject open, Sir. What is next on your mind?',
  'Very good, Sir. A different topic — your pick, or mine?',
  'Consider the old topic shelved, Sir. Where shall we go next?',
  'Switching tracks, Sir. What shall it be?',
  'Understood, Sir. Where shall we go next?'
]);

upsertIntent(reactions, 'what_now', [
  'what now', 'so what now', 'where were we', 'remind me what we were discussing', 'what did we stop at',
  'resume our chat', 'pick up where we left off', 'let us continue', 'continue our conversation', 'so what else'
], [
  'Last thing on our list was your last question, Sir. Say it again and I will start fresh.',
  'We were mid-conversation, Sir — say the part you remember and I will catch up.',
  'Ready to continue, Sir. Where would you like to pick up?',
  'We left it open, Sir. Repeat the thread or give it a fresh angle.',
  'Standing by for the next thought, Sir. What shall it be?',
  'Our chat is paused, not ended, Sir. Continue whenever you like.'
]);

upsertIntent(reactions, 'back_to_work', [
  'back to work', 'let us get serious', 'back to business', 'enough chit chat', 'back to the grind',
  'no more distractions', 'serious time', 'work time', 'no more chatting', 'time to get things done'
], [
  'Understood, Sir. Work mode: focus braced.',
  'Very good, Sir. Back to the serious business at hand.',
  'Straight to it, Sir. What do we tackle first?',
  'Distractions parked, Sir. Say the task and I am on it.',
  'Right, Sir. Back to work.'
]);

// Refresh the existing mood pools with fresh, warmer lines (append-only).
// The existing intents in the 'social' category are extended in place:
// duplicating intent ids would break the coverage test and matcher bookkeeping.
function appendResponsesTo(intentId, responses) {
  const target = data.categories.flatMap(cat => cat.intents || []).find(i => i.id === intentId);
  if (!target) return;
  const seen = new Set(target.responses.map(r => r.toLowerCase().trim()));
  for (const r of responses) {
    if (typeof r === 'string' && r.trim() && !seen.has(r.toLowerCase().trim())) { target.responses.push(r); seen.add(r.toLowerCase().trim()); out.refreshedResponses++; }
  }
}
appendResponsesTo('mood_negative', [
  'That sounds like a rough day, Sir. I am listening — what happened?',
  'I am sorry to hear that, Sir. Want to tell me more about it?',
  'That is hard, Sir. You do not have to explain everything at once.',
  'Sorry it weighed on you like that, Sir. What brought it on?',
  'A rough day is allowed, Sir. Tell me about it whenever you are ready.',
  'That is genuinely unpleasant, Sir. Do you want to talk it through or take a break from it?'
]);
appendResponsesTo('mood_positive', [
  'Right? That is genuinely great, Sir.',
  'Now that is what I like to hear, Sir.',
  'Excellent — sounds like things are going your way, Sir.',
  'Fantastic, Sir. What is the best part?',
  'A good development, Sir, by any reasonable measure.',
  'Well that certainly improves the situation, Sir. Tell me more.'
]);
appendResponsesTo('acknowledgement', [
  'Understood, Sir.',
  'Very good, Sir.',
  'Consider it noted, Sir.',
  'All right, Sir.',
  'Right you are, Sir.'
]);

fs.writeFileSync(LIBRARY, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log(`conversation-library.json updated: +${out.addedCategories.length} categories (${out.addedCategories.join(', ')}), +${out.addedIntents.length} intents (${out.addedIntents.join(', ')}), ${out.refreshedResponses} new responses.`);
