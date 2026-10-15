'use strict';
// VOICE PIPELINE 2.0 benchmark — TEXT-ONLY fixture suite.
// Honest scope: this measures the correction + parsing layers from simulated
// raw ASR strings. It does NOT measure acoustic recognition from a microphone
// (that needs authorized local recordings via the MIC TEST tool). Results are
// reported as baseline (normalize-only, i.e. pipeline 1.x behavior) versus
// upgraded (pipeline 2.0 guarded correction).
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../jarvis-core.js');

function words(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean); }
function wer(ref, hyp) {
  const r = words(ref), h = words(hyp);
  if (!r.length) return h.length ? 1 : 0;
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
}
function cer(ref, hyp) {
  const r = String(ref || '').toLowerCase(), h = String(hyp || '').toLowerCase();
  if (!r.length) return h.length ? 1 : 0;
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
}

// { raw: simulated whisper output, said: what the user actually said }
const FIXTURES = [
  // Proper-noun mishearings (the reported bugs).
  { raw: 'Jarvis, search up fry day', said: 'Jarvis, search up Frieren', fix: 'Frieren' },
  { raw: 'Jarvis, search up friday', said: 'Jarvis, search up Frieren', fix: 'Frieren' },
  { raw: 'Jarvis, open lower boy', said: 'Jarvis, open Loverboy', fix: 'Loverboy' },
  { raw: 'Jarvis, play lower boy on youtube', said: 'Jarvis, play Loverboy on YouTube', fix: 'Loverboy' },
  { raw: 'Jarvis, open row blocks', said: 'Jarvis, open Roblox', fix: 'Roblox' },
  { raw: 'Jarvis, open road blocks', said: 'Jarvis, open Roblox', fix: 'Roblox' },
  { raw: 'Jarvis, play magnetick by illit', said: 'Jarvis, play Magnetic by ILLIT', fix: 'Magnetic' },
  { raw: 'Jarvis, open youtub', said: 'Jarvis, open YouTube', fix: 'YouTube' },
  // Must NOT "fix" these (guard negatives).
  { raw: 'Jarvis, what meetings do I have on Friday', said: 'Jarvis, what meetings do I have on Friday', fix: null },
  { raw: 'Jarvis, lower the volume', said: 'Jarvis, lower the volume', fix: null },
  { raw: 'Jarvis, remind me to call mom on Friday at five PM', said: 'Jarvis, remind me to call mom on Friday at five PM', fix: null },
  // Natural open phrasings -> same website intent.
  { raw: 'Jarvis, open YouTube', said: 'Jarvis, open YouTube', intent: 'open-site:youtube' },
  { raw: 'Jarvis, can you open YouTube', said: 'Jarvis, can you open YouTube', intent: 'open-site:youtube' },
  { raw: 'Jarvis, get YouTube up', said: 'Jarvis, get YouTube up', intent: null },
  { raw: 'Jarvis, take me to YouTube', said: 'Jarvis, take me to YouTube', intent: null },
  { raw: 'Jarvis, could you pull up YouTube for me', said: 'Jarvis, could you pull up YouTube for me', intent: null },
  { raw: 'Jarvis, open YouTube Music', said: 'Jarvis, open YouTube Music', intent: 'open-site:youtube-music' },
  { raw: 'Jarvis, open Google', said: 'Jarvis, open Google', intent: 'open-site:google' },
  { raw: 'Jarvis, open Discord', said: 'Jarvis, open Discord', intent: 'open-site:discord' },
  // Search / media.
  { raw: 'Jarvis, search up Frieren', said: 'Jarvis, search up Frieren', intent: 'web-search' },
  { raw: 'Jarvis, google the weather today', said: 'Jarvis, google the weather today', intent: 'web-search' },
  { raw: 'Jarvis, play Magnetic by ILLIT', said: 'Jarvis, play Magnetic by ILLIT', intent: 'music:search' },
  { raw: 'Jarvis, play the song Magnetic', said: 'Jarvis, play the song Magnetic', intent: 'music:search' },
  { raw: 'Jarvis, open Magnetic on YouTube', said: 'Jarvis, open Magnetic on YouTube', intent: 'site-search:youtube' },
  // Numbers, dates, times.
  { raw: 'Jarvis, set an alarm for seven AM', said: 'Jarvis, set an alarm for seven AM' },
  { raw: 'Jarvis, set an alarm for seven thirty PM', said: 'Jarvis, set an alarm for seven thirty PM' },
  { raw: 'Jarvis, remind me to water the plants in ten minutes', said: 'Jarvis, remind me to water the plants in ten minutes' },
  { raw: 'Jarvis, what do I have tomorrow', said: 'Jarvis, what do I have tomorrow' },
  { raw: 'Jarvis, schedule a meeting called planning tomorrow at three PM', said: 'Jarvis, schedule a meeting called planning tomorrow at three PM' },
  { raw: 'Jarvis, call me at five forty five', said: 'Jarvis, call me at five forty five' },
  { raw: 'Jarvis, set a timer for twenty minutes', said: 'Jarvis, set a timer for twenty minutes' },
  { raw: 'Jarvis, what is fifteen percent of two hundred', said: 'Jarvis, what is fifteen percent of two hundred' },
  // Short commands.
  { raw: 'Jarvis, stop', said: 'Jarvis, stop' },
  { raw: 'Jarvis, pause', said: 'Jarvis, pause' },
  { raw: 'Jarvis, next', said: 'Jarvis, next' },
  { raw: 'Jarvis, volume up', said: 'Jarvis, volume up' },
  { raw: 'Jarvis, go back', said: 'Jarvis, go back' },
  // Fillers / pauses.
  { raw: 'Jarvis, um, open, uh, YouTube', said: 'Jarvis, open YouTube' },
  { raw: 'Jarvis, please, can you, open Google', said: 'Jarvis, open Google' },
  { raw: 'Hey Jarvis, could you just open Discord for me', said: 'Hey Jarvis, open Discord' },
  { raw: 'Jarvis, search, um, for Frieren', said: 'Jarvis, search for Frieren' },
  // Long / multi-part.
  { raw: 'Jarvis, search up Frieren and open the first result on YouTube', said: 'Jarvis, search up Frieren and open the first result on YouTube' },
  { raw: 'Jarvis, remind me to buy milk tomorrow at nine AM and set an alarm for eight AM', said: 'Jarvis, remind me to buy milk tomorrow at nine AM and set an alarm for eight AM' },
  { raw: 'Jarvis, play Magnetic by ILLIT on YouTube Music and turn the volume up', said: 'Jarvis, play Magnetic by ILLIT on YouTube Music and turn the volume up' },
  { raw: 'Jarvis, what meetings do I have tomorrow and remind me to prepare slides at eight PM', said: 'Jarvis, what meetings do I have tomorrow and remind me to prepare slides at eight PM' },
  // Conversation (must stay conversational, never a desktop command).
  { raw: 'Jarvis, how are you', said: 'Jarvis, how are you' },
  { raw: 'Jarvis, thank you', said: 'Jarvis, thank you' },
  { raw: 'Jarvis, tell me a joke', said: 'Jarvis, tell me a joke' },
  { raw: 'Jarvis, what did we discuss yesterday', said: 'Jarvis, what did we discuss yesterday' },
  { raw: 'Jarvis, good morning', said: 'Jarvis, good morning' },
  // Wake variants.
  { raw: 'Hey Jarvis, open YouTube', said: 'Hey Jarvis, open YouTube' },
  { raw: 'Hey Jarvis, search up Frieren', said: 'Hey Jarvis, search up Frieren', fix: 'Frieren' },
  { raw: 'Yo Jarvis, play music', said: 'Yo Jarvis, play music' },
  { raw: 'Okay Jarvis, what time is it', said: 'Okay Jarvis, what time is it' },
  { raw: 'Harvis, open YouTube', said: 'Jarvis, open YouTube', fix: 'Jarvis' },
  // Bulk padding: everyday commands for the 100-utterance bar.
  ...['open Chrome', 'open notepad', 'open calculator', 'take a screenshot', 'search files for report', 'play music', 'pause the music', 'skip this video', 'go to the next video', 'open the next tab', 'close this tab', 'turn off the alarm', 'snooze the alarm', 'show my calendar', 'list my alarms', 'send Alex a message on Discord', 'what is the weather', 'define serendipity', 'open Gmail', 'open Wikipedia', 'open TikTok', 'open Instagram', 'search for quantum computing', 'find cheap flights to Tokyo', 'play some jazz', 'stop the music', 'mute the volume', 'open Spotify', 'open Steam', 'launch Minecraft', 'open the calendar', 'add a meeting tomorrow at noon', 'cancel my three PM meeting', 'remind me to stretch at four PM', 'set an alarm for six thirty AM on weekdays', 'what time is it', 'tell me the date', 'open file explorer', 'open settings', 'lock the computer', 'empty the recycle bin', 'search the web for sourdough recipe', 'look up the Eiffel Tower', 'translate hello to Spanish', 'how do you say thank you in Japanese', 'write a haiku about rain', 'summarize my last meeting notes', 'read my latest email', 'check my inbox', 'reply to the last email saying on my way'].map(c => ({ raw: `Jarvis, ${c}`, said: `Jarvis, ${c}` })),
];

test('pipeline 2.0 benchmark: guarded correction beats normalize-only (text fixtures)', () => {
  assert.ok(FIXTURES.length >= 100, `need >=100 fixtures, have ${FIXTURES.length}`);
  let baseWerSum = 0, upWerSum = 0, baseCerSum = 0, upCerSum = 0;
  let changed = 0, fixed = 0, broken = 0, exactUp = 0;
  const errors = [];
  for (const f of FIXTURES) {
    const base = Core.normalizeConversationText(f.raw);
    const det = Core.voiceDeterministicCorrection(f.raw);
    const up = det.correctedTranscript;
    // Compare case-insensitively at word level against `said`.
    baseWerSum += wer(f.said, base); upWerSum += wer(f.said, up);
    baseCerSum += cer(f.said, base); upCerSum += cer(f.said, up);
    if (det.changed) changed++;
    const want = f.fix;
    if (want) {
      if (up.toLowerCase().includes(want.toLowerCase())) fixed++;
      else errors.push(`MISS: "${f.raw}" -> "${up}" (want ${want})`);
    } else if (f.fix === null) {
      // Guard negative: corrected must equal normalized (no rewrite).
      if (up.toLowerCase() !== base.toLowerCase()) { broken++; errors.push(`OVERFIX: "${f.raw}" -> "${up}"`); }
    }
    if (wer(f.said, up) === 0) exactUp++;
  }
  const n = FIXTURES.length;
  const baseWer = baseWerSum / n, upWer = upWerSum / n;
  const baseCer = baseCerSum / n, upCer = upCerSum / n;
  console.log(`fixtures=${n} baseWER=${baseWer.toFixed(4)} upWER=${upWer.toFixed(4)} baseCER=${baseCer.toFixed(4)} upCER=${upCer.toFixed(4)} changed=${changed} fixed=${fixed} overfix=${broken} exact=${exactUp}`);
  for (const e of errors.slice(0, 20)) console.log(`  ${e}`);
  assert.ok(upWer <= baseWer, `upgraded WER (${upWer}) must not exceed baseline (${baseWer})`);
  assert.equal(broken, 0, `guarded rules must never rewrite protected sentences:\n${errors.join('\n')}`);
  assert.ok(fixed >= 8, `expected >=8 proper-noun fixes, got ${fixed}`);
});

test('confidence policy: high proceeds, low clarifies, silence clarifies', () => {
  assert.equal(Core.voiceConfidencePolicy({ asrConfidence: 0.9 }).decision, 'proceed');
  assert.equal(Core.voiceConfidencePolicy({ asrConfidence: 0.6, correctionChanged: true }).decision, 'correct-and-proceed');
  assert.equal(Core.voiceConfidencePolicy({ asrConfidence: 0.2 }).decision, 'clarify');
  assert.equal(Core.voiceConfidencePolicy({ noSpeechProb: 0.95 }).decision, 'clarify');
  assert.equal(Core.voiceConfidencePolicy({ qualityFlags: ['near-silence'] }).decision, 'clarify');
});

test('intent routing survives natural phrasing + guarded fixes', () => {
  assert.equal(Core.parseWebsiteIntent('open YouTube')?.site, 'youtube');
  assert.equal(Core.parseWebsiteIntent('open up YouTube')?.site, 'youtube');
  const det = Core.voiceDeterministicCorrection('Jarvis, search up fry day');
  assert.match(det.correctedTranscript, /frieren/i);
  assert.ok(Core.parseSearchCommand(det.correctedTranscript.replace(/^(?:hey\s+)?jarvis[\s,:-]*/i, '').trim()), 'fixed query must still parse as search');
  const keep = Core.voiceDeterministicCorrection('Jarvis, lower the volume');
  assert.doesNotMatch(keep.correctedTranscript, /loverboy/i);
});

test('phonetic fallback catches unseen mishearings, never common words', () => {
  assert.match(Core.voiceDeterministicCorrection('Jarvis, search up priren').correctedTranscript, /frieren/i);
  assert.match(Core.voiceDeterministicCorrection('Jarvis, play loverboi on youtube').correctedTranscript, /loverboy/i);
  for (const keep of ['Jarvis, print the report', 'Jarvis, search up printer paper', 'Jarvis, lower the volume', 'Jarvis, what meetings do I have on Friday']) {
    const out = Core.voiceDeterministicCorrection(keep).correctedTranscript.toLowerCase();
    assert.ok(!/frieren|loverboy|roblox/.test(out), `${keep} -> ${out}`);
  }
});

test('wake word survives whisper mishearings without false activation', () => {
  assert.equal(Core.parseWakeTranscript('Harvis, open YouTube').activated, true);
  assert.equal(Core.parseWakeTranscript('I think they obviously need help').activated, false);
  assert.equal(Core.parseWakeTranscript('Open Steam').activated, false);
});
