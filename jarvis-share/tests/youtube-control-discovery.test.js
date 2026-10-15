'use strict';
// YouTube control + boredom discovery tests. Pure-parser tests run anywhere;
// live browser tests only assert honest reporting (never fake success) in
// whatever state the machine happens to be in.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');
const tabs = require('../browser-tabs.js');
const discovery = require('../youtube-discovery.js');

test('skip variations route to next-video, never the generic music handler', () => {
  for (const input of ['skip this video', 'skip the video', 'next video', 'play the next video', 'skip this one', 'go to the next YouTube video', 'skip video']) {
    assert.equal(core.parseYouTubeControl(input)?.kind, 'next-video', input);
    assert.equal(core.parseMusicControl(input), null, `${input} must not hit music control`);
  }
});

test('seek commands parse with seconds and clamp', () => {
  assert.deepEqual(core.parseYouTubeControl('skip ahead 10 seconds'), { kind: 'seek-forward', seconds: 10 });
  assert.deepEqual(core.parseYouTubeControl('skip ahead 30 seconds'), { kind: 'seek-forward', seconds: 30 });
  assert.deepEqual(core.parseYouTubeControl('go back 10 seconds'), { kind: 'seek-back', seconds: 10 });
  assert.deepEqual(core.parseYouTubeControl('rewind a little'), { kind: 'seek-back', seconds: 10 });
  assert.equal(core.parseYouTubeControl('skip ahead 999 seconds').seconds, 300);
});

test('skip-ad, pause/resume and previous-video are distinct actions', () => {
  assert.equal(core.parseYouTubeControl('skip the ad')?.kind, 'skip-ad');
  assert.equal(core.parseYouTubeControl('skip ads')?.kind, 'skip-ad');
  assert.equal(core.parseYouTubeControl('pause the video')?.kind, 'pause');
  assert.equal(core.parseYouTubeControl('previous video')?.kind, 'previous-video');
  // Bare music transport keeps its existing meaning.
  assert.equal(core.parseYouTubeControl('skip'), null);
  assert.equal(core.parseYouTubeControl('next'), null);
  assert.equal(core.parseMusicControl('skip')?.command, 'next');
  assert.equal(core.parseMusicControl('pause the music')?.command, 'pause');
});

test('deterministic gate covers the new commands', () => {
  for (const input of ['skip this video', 'skip ahead 10 seconds', "I'm bored", 'Find a video about Roblox', 'open the first one', 'show me more']) {
    assert.equal(core.looksLikeDeterministicCommand(input), true, input);
  }
});

test('boredom and discovery requests classify with topics', () => {
  assert.equal(core.parseDiscoveryIntent("I'm bored")?.kind, 'discovery-bored');
  assert.equal(core.parseDiscoveryIntent('Find me something to watch')?.kind, 'discovery-bored');
  const roblox = core.parseDiscoveryIntent('Find a video about Roblox');
  assert.equal(roblox?.kind, 'discovery-search');
  assert.match(roblox.topic, /roblox/i);
  assert.equal(core.parseDiscoveryIntent('Open the first one')?.kind, 'discovery-open');
  assert.equal(core.parseDiscoveryIntent('Open the first one')?.index, 1);
  assert.equal(core.parseDiscoveryIntent('Play the second video')?.index, 2);
  assert.equal(core.parseDiscoveryIntent('Show me more')?.kind, 'discovery-more');
  assert.equal(core.parseDiscoveryIntent('Another one')?.kind, 'discovery-more');
  assert.equal(core.parseDiscoveryIntent('Go back to the previous recommendations')?.kind, 'discovery-back');
  assert.equal(core.parseDiscoveryIntent('Find another one like that')?.kind, 'discovery-similar');
  assert.equal(core.parseDiscoveryIntent('Not that kind of video')?.kind, 'discovery-refine');
  assert.equal(core.parseDiscoveryIntent('clear my video preferences')?.kind, 'discovery-clear');
});

test('duration helpers parse and format without inventing', () => {
  assert.equal(discovery.parseDurationToSeconds('12:34'), 754);
  assert.equal(discovery.parseDurationToSeconds('1:02:03'), 3723);
  assert.equal(discovery.parseDurationToSeconds('LIVE'), null);
  assert.equal(discovery.formatDuration(754), '12:34');
  assert.equal(discovery.formatDuration(null), '');
});

test('discovery filters narrow real candidates without fabrication', () => {
  const candidates = [
    { videoId: 'aaa111bbb22', title: 'A', durationSeconds: 120 },
    { videoId: 'ccc333ddd44', title: 'B', durationSeconds: 900 },
    { videoId: 'eee555fff66', title: 'C', durationSeconds: null }
  ];
  const fresh = discovery.dedupeAgainst(candidates, ['aaa111bbb22']);
  assert.ok(fresh.every(c => c.videoId !== 'aaa111bbb22'));
  assert.equal(fresh.length, 2);
  const allSeen = discovery.dedupeAgainst(candidates, candidates.map(c => c.videoId));
  assert.equal(allSeen.length, 3, 'exhausted history falls back to the same genuine set, never invented entries');
  const short = discovery.filterShortEnough(candidates, 300);
  assert.ok(short.every(c => c.durationSeconds === null || c.durationSeconds <= 300));
});

test('searchYouTube with a failing fetch reports honestly, never fake videos', async () => {
  const failing = async () => { throw new Error('network down'); };
  const result = await discovery.searchYouTube('space', { fetchFn: failing });
  assert.equal(result.ok, false);
  assert.equal(result.candidates.length, 0);
  assert.match(result.message, /could not reach/i);
  assert.match(result.searchUrl, /youtube\.com\/results/);
});

test('searchYouTube parses a fixture page into real candidates', async () => {
  const payload = { contents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ videoRenderer: { videoId: 'dQw4w9WgXcQ', title: { runs: [{ text: 'Real Title' }] }, ownerText: { runs: [{ text: 'Real Channel' }] }, lengthText: { simpleText: '4:20' }, thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' }] }, viewCountText: { simpleText: '1M views' }, descriptionSnippet: { runs: [{ text: 'A real description' }] } } }] } }] } } };
  const fixture = `<html><body><script>var ytInitialData = ${JSON.stringify(payload)};</script></body></html>`;
  const okFetch = async () => ({ ok: true, text: async () => fixture });
  const result = await discovery.searchYouTube('test', { fetchFn: okFetch });
  assert.equal(result.ok, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].videoId, 'dQw4w9WgXcQ');
  assert.equal(result.candidates[0].title, 'Real Title');
  assert.equal(result.candidates[0].channel, 'Real Channel');
  assert.equal(result.candidates[0].duration, '4:20');
  assert.equal(result.candidates[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('YouTube tab detection separates watch pages from other tabs', () => {
  assert.equal(tabs.isYouTubeVideoTab({ url: 'https://www.youtube.com/watch?v=abc123DEF45', title: 'x' }), true);
  assert.equal(tabs.isYouTubeVideoTab({ url: 'https://www.youtube.com/shorts/abc123DEF45', title: 'x' }), true);
  assert.equal(tabs.isYouTubeVideoTab({ url: 'https://mail.google.com/', title: 'Gmail' }), false);
  assert.equal(tabs.isYouTubeVideoTab({ url: 'https://www.roblox.com/home', title: 'Roblox' }), false);
});

test('YouTube control without a video tab fails honestly', async () => {
  const status = await tabs.status();
  if (status.connected) return; // live browser assertions happen in the running-app check
  for (const command of ['next-video', 'seek-forward', 'skip-ad', 'pause']) {
    const result = await tabs.youtubeCommand(command, { seconds: 10 });
    assert.equal(result.ok, false, command);
    assert.ok(typeof result.message === 'string' && result.message.length > 10);
    assert.doesNotMatch(result.message, /skipped/i);
  }
});

test('opening a video without a control channel never launches anything external', async () => {
  const status = await tabs.status();
  if (status.connected) return;
  const result = await tabs.openYouTubeVideo('dQw4w9WgXcQ');
  assert.equal(result.ok, false);
  assert.ok(typeof result.message === 'string' && result.message.length > 10);
});

test('invalid video IDs are rejected before any navigation', async () => {
  const result = await tabs.openYouTubeVideo('not-a-video!!!');
  assert.equal(result.ok, false);
  assert.match(result.message, /usable YouTube video link/i);
});
