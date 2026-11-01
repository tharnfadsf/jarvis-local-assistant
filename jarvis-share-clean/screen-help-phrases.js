'use strict';
// JARVIS Screen Help — spoken reply pools (2026-10-18).
//
// Every line here is plain text. It is returned through the same reply path
// as every other JARVIS answer, so it is spoken by the normal voice pipeline
// (the configured Fish Audio voice / the local fallback) — nothing in the
// screen-help feature plays audio itself, and Clicky's own voice is never
// used; Clicky only supplies the on-screen pointer.
//
// Variants are composed from slot arrays (cross product), so each scenario
// has hundreds of simple, natural lines and the same reply almost never
// repeats. {note} and {seconds} are filled in at pick time; lines that need
// a note are skipped when the locator did not provide one.
//
// Pure and dependency-free: no network, no processes, nothing that can fail.

const POOLS = {
  // Pointer shown, exact stage-2 hit.
  found: [
    ['Alright, Sir.', 'Found it.', 'There it is.', 'Here we go.', 'Got it, Sir.',
      'All set.', 'Look here.', 'There we go.', 'Here it is.', 'Nice, I found it.'],
    ['The blue pointer is marking it.', 'The blue cursor is pointing right at it.',
      'I have marked it with the blue pointer.', 'The blue arrow is on it now.',
      'You can see it marked in blue.', 'The pointer is sitting right on it.'],
    ['', 'It appears to be {note}.', 'I believe that is {note}.', 'That should be {note}.'],
    ['It fades in about {seconds} seconds.', 'The pointer hides itself in about {seconds} seconds.',
      'It clears by itself in about {seconds} seconds.', 'Nothing stays on screen after about {seconds} seconds.']
  ],
  // Pointer shown, stage-1 (approximate) hit — honest about the guess.
  approxFound: [
    ['Alright, Sir.', 'Best I can tell.', 'Found an approximate spot.', 'Here is my best guess.',
      'I found it roughly.', 'Okay, Sir.', 'This one is a best guess.', 'Look here.', 'Here is what I have.'],
    ['I could only narrow it down to the area, but the blue pointer marks my best guess.',
      'The exact position is approximate, so look right around the pointer.',
      'I am not fully sure of the exact spot, but it is right around the blue pointer.',
      'This one is approximate, and the pointer shows about where it is.',
      'My guess is approximate, so treat the blue pointer as the general area.',
      'The spot may be a little off, but the blue pointer shows where to look.'],
    ['It fades in about {seconds} seconds.', 'The pointer hides itself in about {seconds} seconds.',
      'It clears by itself in about {seconds} seconds.', 'Nothing stays on screen after about {seconds} seconds.']
  ],
  // No matching element on the current screen.
  notFound: [
    ['Sorry, Sir.', 'I looked, Sir.', 'Hmm, Sir.', 'No luck, Sir.',
      'I checked, Sir.', 'Not this time, Sir.', 'I did not spot it, Sir.', 'So, Sir.'],
    ['I could not find a matching button or option on the current screen.',
      'I did not find anything matching that on your screen.',
      'Nothing on the screen matches that description right now.',
      'I could not find that button or option right now.',
      'Nothing on the screen matches that as far as I can tell.',
      'I did not find it on the screen as it is now.',
      'I could not spot a matching control on the screen.'],
    ['If the app you mean is not open, open it and ask me again.',
      'Open the app you mean and ask me again.',
      'Try opening the right app and ask me once more.',
      'If the right window is not open yet, open it and ask again.']
  ],
  // Generic "I need help" invitation — no capture, just an offer to point.
  invite: [
    ['Of course, Sir.', 'Certainly, Sir.', 'Right away, Sir.', 'Absolutely, Sir.', 'Happy to help, Sir.',
      'At your service, Sir.', 'No problem, Sir.', 'You got it, Sir.'],
    ['Tell me what you need.', 'What can I help you with?', 'What are you looking for?',
      'Just tell me what you need.', 'What would you like help with?', 'Tell me what to look for.',
      'Say what you need and I will help.', 'What should I find for you?'],
    ['', 'If it is on your screen, name it and I will point right at it.',
      'If it is something on your screen, just describe it.',
      'If it is on your screen, tell me what to find and I will point at it.',
      'If it is on your screen, say the word and I will point to it.']
  ],
  // Pointer was up and has been closed.
  closed: [
    ['Sure thing, Sir.', 'Done, Sir.', 'Okay, Sir.', 'Alright, Sir.', 'No problem, Sir.', 'As you wish, Sir.', 'Consider it cleared, Sir.', 'All right, Sir.'],
    ['The screen help overlay is closed.', 'The blue pointer is gone.', 'Screen help is closed.',
      'I cleared the pointer.', 'The screen help marker is removed.', 'The pointer is off your screen.',
      'Screen help is shut down.'],
    ['', 'Nothing is left on screen.', 'The screen is back to normal.', 'Everything is hidden again.']
  ],
  // A search was in flight and has been stopped.
  stopped: [
    ['Understood, Sir.', 'Stopping it, Sir.', 'Okay, Sir.', 'As you wish, Sir.', 'Alright, Sir.', 'Consider it cancelled, Sir.', 'No problem, Sir.', 'Sure, Sir.'],
    ['The screen-help search is stopped.', 'I stopped searching the screen.', 'The screen search was cancelled.',
      'I dropped the screen search.', 'The search over your screen is cancelled.',
      'I stopped the screen-help check.', 'The screen-help search is off.'],
    ['', 'Nothing was left on screen.', 'No pointer was shown.', 'The screen is untouched.']
  ],
  // "Close screen help" when nothing was active.
  nothingToClose: [
    ['Nothing to close, Sir.', 'All clear, Sir.', 'You are all clear, Sir.', 'Nothing is showing, Sir.',
      'No pointer is up, Sir.', 'The screen is already clean, Sir.', 'Nothing to tidy up, Sir.', 'No screen help is active, Sir.'],
    ['There is nothing on the screen to close.', 'Screen help is not active right now.',
      'No screen-help pointer or search is running.', 'I have no pointer or screen search to close.',
      'Nothing of mine is on your screen at the moment.', 'The screen is already clean.',
      'There is no screen-help pointer showing.'],
    ['', 'The screen is yours.', 'Nothing to worry about.', 'All good.']
  ],
  // Element located but the overlay process could not be shown.
  noPointer: [
    ['Alright, Sir.', 'Almost, Sir.', 'Well, Sir.', 'So, Sir.', 'Quick update, Sir.',
      'Good news and bad news.', 'Here is the thing, Sir.', 'Okay, Sir.', 'Hmm, Sir.'],
    ['I found where it should be, but I could not display the blue pointer.',
      'I know where it is, but the pointer did not appear.',
      'I located it, but the blue pointer failed to show.',
      'I found the spot, but the pointer could not be displayed.',
      'I have the location, but no pointer is showing.',
      'I located it, but nothing was drawn on screen.',
      'I know where it should be, yet the blue pointer stayed hidden.',
      'I found it, but the overlay did not show up.'],
    ['', 'It should be visible on your screen somewhere.', 'It is on your screen, but unmarked.',
      'It should be near {note}.', 'It appears to be {note}.']
  ],
  // Click/press/select-style ask on a located element: JARVIS marks it with
  // the real pointer, and is honest that the physical press stays with the
  // user (no click executor exists in this integration).
  markedPress: [
    ['Marking it, Sir.', 'Found it.', 'There it is.', 'Got it, Sir.', 'Here we go.'],
    ['The blue pointer marks it, but I cannot physically press it — the click is yours.',
      'It is marked with the blue pointer now; I can point, but the actual press is yours.',
      'The pointer sits right on it. The press itself stays with you, Sir.',
      "I pointed the blue cursor at it — pressing it is left to you, Sir.",
      'The blue pointer marks the spot; I do not click for you, only point.'],
    ['It fades in about {seconds} seconds.', 'The pointer hides itself in about {seconds} seconds.',
      'The mark clears by itself in about {seconds} seconds.']
  ],
  // Scroll/drag-style asks: no executor exists in this integration, so the
  // honest refusal is the whole answer — nothing is captured, no pointer.
  unsupportedAct: [
    ['I cannot do that one yet, Sir.', 'Not possible at the moment, Sir.', 'I have to be honest, Sir.', 'That one is beyond me right now, Sir.'],
    ['I cannot drive scrolling on your screen myself yet - that input stays with you.',
      'Scrolling is not something I can physically do on your screen yet.',
      'I cannot drag things across your screen myself yet, Sir.',
      'Dragging on your screen is not an action I can perform yet, Sir.'],
    ['Say it again if you want me to point at a control instead.', 'I can still mark a specific control for you, Sir.']
  ],
  // Action-specific refusals: the reply must name the action that was asked
  // for, never a random sibling (asking to scroll must not read a drag line).
  unsupportedScroll: [
    ['I cannot do that one yet, Sir.', 'Not possible at the moment, Sir.', 'I have to be honest, Sir.', 'That one is beyond me right now, Sir.'],
    ['I cannot drive scrolling on your screen myself yet - that input stays with you.',
      'Scrolling is not something I can physically do on your screen yet.',
      'I cannot scroll by driving the wheel myself yet, Sir.'],
    ['Say it again if you want me to point at a control instead.', 'I can still mark a specific control for you, Sir.']
  ],
  unsupportedDrag: [
    ['I cannot do that one yet, Sir.', 'Not possible at the moment, Sir.', 'I have to be honest, Sir.', 'That one is beyond me right now, Sir.'],
    ['I cannot drag things across your screen myself yet, Sir.',
      'Dragging on your screen is not an action I can perform yet, Sir.',
      'I cannot drag things by holding and moving them on the screen myself yet - that input stays with you, Sir.'],
    ['Say it again if you want me to point at a control instead.', 'I can still mark a specific control for you, Sir.']
  ],
  // The pointer returned to the last verified location ("point at it again").
  again: [
    ['Again it is, Sir.', 'There it is once more.', 'Back on the spot, Sir.', 'Re-marking it now, Sir.', 'There we are again, Sir.'],
    ['The blue pointer is back on the same place.', 'The pointer is marking the same location again.',
      'The same spot is highlighted with the blue pointer again.',
      'The blue pointer returned to where I found it last time.'],
    ['It hides again after about {seconds} seconds.', 'Then it clears by itself after about {seconds} seconds.']
  ],
  // "Point at it again" with no locate having happened in this session:
  // nothing is marked, so asking for a name is the only honest reply.
  nothingMarked: [
    ['Nothing is marked yet, Sir.', 'I have not marked anything on the screen yet, Sir.', 'There is no pointer spot to return to, Sir.'],
    ['Name the element and I will find it fresh.', 'Tell me what to look for and I will point at it.',
      'Say the button or option by name and I will mark it for you.']
  ],
  // "Point at it again" after the locate expired: the old pixel could belong
  // to a different element now, so a fresh locate is asked for — no stale
  // coordinates are ever re-used.
  expired: [
    ['That pointing has expired, Sir.', 'The old spot is out of date now, Sir.', 'Too much time has passed for that mark, Sir.'],
    ['The screen may have changed since then, so the old coordinates would not be safe to reuse.',
      'Too much has changed on screen to trust the old place; I would need to look again.',
      'That location can no longer be trusted to mark the same element.'],
    ['Say the element name again and I will find it fresh.', 'Ask me again by name and I will locate it anew.']
  ]
};

const cache = new Map();
const lastPick = new Map();

// Cross product over slot arrays, single-spaced, empty fragments skipped.
function combine(slots) {
  let acc = [''];
  for (const slot of slots) {
    const next = [];
    for (const prefix of acc) {
      for (const piece of slot) {
        if (!piece) { next.push(prefix); continue; }
        next.push(prefix ? `${prefix} ${piece}` : piece);
      }
    }
    acc = next;
  }
  return acc;
}

function variants(pool) {
  if (!POOLS[pool]) return [];
  if (!cache.has(pool)) cache.set(pool, [...new Set(combine(POOLS[pool]))]);
  return cache.get(pool);
}

// "settings button" -> "the settings button"; keeps an existing article.
function withArticle(note) {
  let s = String(note || '').replace(/\s+/g, ' ').replace(/[.]+$/, '').trim();
  if (!s) return '';
  if (/^(?:the|a|an|your|my)\s+/i.test(s)) return s;
  if (/^[A-Z][a-z]/.test(s)) s = s.charAt(0).toLowerCase() + s.slice(1);
  return `the ${s}`;
}

// Pick a random simple line for a scenario. Note-bearing lines are skipped
// when no note is available; {seconds} defaults to 25.
function pick(pool, options = {}) {
  const all = variants(pool);
  if (!all.length) return '';
  const note = withArticle(options.note);
  const base = all.filter(line => note || !line.includes('{note}'));
  const candidates = base.length ? base : all;
  let text = candidates[Math.floor(Math.random() * candidates.length)];
  if (candidates.length > 1 && text === lastPick.get(pool)) {
    text = candidates[Math.floor(Math.random() * candidates.length)];
    if (text === lastPick.get(pool)) {
      text = candidates[(candidates.indexOf(text) + 1) % candidates.length];
    }
  }
  lastPick.set(pool, text);
  const seconds = Math.max(4, Math.round(Number(options.seconds) || 25));
  return text.replace(/\{note\}/g, note).replace(/\{seconds\}/g, String(seconds)).trim();
}

function counts() {
  const out = {};
  for (const pool of Object.keys(POOLS)) out[pool] = variants(pool).length;
  return out;
}

module.exports = { pick, variants, counts, withArticle, POOLS };
