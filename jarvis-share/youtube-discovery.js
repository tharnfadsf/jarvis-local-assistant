'use strict';
// Real YouTube video discovery for JARVIS ("I'm bored" mode).
//
// searchYouTube() fetches a YouTube search-results page and extracts genuine
// video candidates (videoId, title, channel, duration, thumbnail) from the
// page's own ytInitialData payload. It never invents videos: when the page
// cannot be fetched or parsed, it returns ok:false with the search URL so the
// caller opens the results page instead of fabricating recommendations.
const YT_SEARCH_URL = 'https://www.youtube.com/results?search_query=';
const YT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function parseDurationToSeconds(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\s*LIVE\s*$/i.test(raw)) return null;
  const parts = raw.split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function formatDuration(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined) return '';
  const s = Math.round(Number(totalSeconds));
  if (!Number.isFinite(s) || s < 0) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function runsText(node) {
  if (!node) return '';
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map(r => r.text || '').join('');
  return '';
}

function bestThumbnail(thumbnails) {
  const list = Array.isArray(thumbnails) ? thumbnails : [];
  const withUrl = list.filter(t => t && /^https?:\/\//i.test(t.url));
  if (!withUrl.length) return '';
  return withUrl[withUrl.length - 1].url.slice(0, 500);
}

// Walk the ytInitialData JSON tree and collect videoRenderer objects.
function collectVideoRenderers(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40 || out.length >= 40) return;
  if (Array.isArray(node)) {
    for (const item of node) collectVideoRenderers(item, out, depth + 1);
    return;
  }
  if (node.videoRenderer && typeof node.videoRenderer === 'object') {
    out.push(node.videoRenderer);
    if (out.length >= 40) return;
  }
  for (const key of Object.keys(node)) {
    if (key === 'videoRenderer') continue;
    collectVideoRenderers(node[key], out, depth + 1);
  }
}

function rendererToCandidate(renderer) {
  const videoId = String(renderer.videoId || '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  const title = runsText(renderer.title).trim().slice(0, 160);
  if (!title) return null;
  if (/^private video$/i.test(title)) return null;
  const channel = (runsText(renderer.ownerText) || runsText(renderer.longBylineText) || runsText(renderer.shortBylineText)).trim().slice(0, 120);
  const durationText = runsText(renderer.lengthText).trim().slice(0, 20);
  const durationSeconds = parseDurationToSeconds(durationText);
  const thumbnail = bestThumbnail(renderer.thumbnail && renderer.thumbnail.thumbnails);
  const viewText = runsText(renderer.viewCountText).trim().slice(0, 60) || runsText(renderer.shortViewCountText).trim().slice(0, 60);
  const description = runsText(renderer.descriptionSnippet).trim().slice(0, 280);
  const isLive = /live/i.test(runsText(renderer.badges)) || /\bLIVE\b/.test(durationText) || /watching/i.test(viewText);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  return {
    videoId, title, channel, duration: durationText, durationSeconds, thumbnail,
    views: viewText, description, url, live: Boolean(isLive)
  };
}

function extractInitialData(html) {
  const patterns = [
    /var\s+ytInitialData\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/,
    /ytInitialData"\s*:\s*(\{[\s\S]*?\})\s*,\s*"ytInitialPlayerResponse"/,
    /"contents"\s*:\s*\{/
  ];
  let match = html.match(patterns[0]);
  if (match) return match[1];
  // Fallback: balanced-brace scan from the first ytInitialData assignment.
  const anchor = html.indexOf('ytInitialData');
  if (anchor === -1) return '';
  const start = html.indexOf('{', anchor);
  if (start === -1) return '';
  let depth = 0, inStr = false, esc = false;
  const limit = Math.min(html.length, start + 4 * 1024 * 1024);
  for (let i = start; i < limit; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return '';
}

async function searchYouTube(query, { limit = 6, fetchFn = null } = {}) {
  const clean = String(query || '').trim().slice(0, 120);
  const searchUrl = `${YT_SEARCH_URL}${encodeURIComponent(clean)}`;
  if (!clean) return { ok: false, query: clean, candidates: [], searchUrl, message: 'Tell me a topic to search YouTube for.' };
  const count = Math.min(12, Math.max(1, Number(limit) || 6));
  const runFetch = fetchFn || fetch;
  let html = '';
  try {
    const response = await runFetch(searchUrl, {
      headers: { 'User-Agent': YT_UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`YouTube returned HTTP ${response.status}`);
    html = await response.text();
  } catch (error) {
    return { ok: false, query: clean, candidates: [], searchUrl, message: `I could not reach YouTube search for “${clean}” (${error.message}). I can open the results page instead — just say “open YouTube results for ${clean}”.` };
  }
  let data = null;
  try {
    const jsonText = extractInitialData(html);
    if (!jsonText) throw new Error('no parseable results payload');
    data = JSON.parse(jsonText);
  } catch (error) {
    return { ok: false, query: clean, candidates: [], searchUrl, message: `YouTube answered, but I could not read individual videos for “${clean}”. I can open the results page instead — just say “open YouTube results for ${clean}”.` };
  }
  const renderers = [];
  try { collectVideoRenderers(data, renderers); } catch {}
  const seen = new Set();
  const candidates = [];
  for (const renderer of renderers) {
    const candidate = rendererToCandidate(renderer);
    if (!candidate || seen.has(candidate.videoId)) continue;
    seen.add(candidate.videoId);
    candidates.push(candidate);
    if (candidates.length >= count) break;
  }
  if (!candidates.length) {
    return { ok: false, query: clean, candidates: [], searchUrl, message: `YouTube returned no usable videos for “${clean}”. Try a different topic, or say “open YouTube results for ${clean}” to browse them yourself.` };
  }
  return { ok: true, query: clean, candidates, searchUrl };
}

// Filter helpers: never invent, only narrow genuine candidates.
function filterShortEnough(candidates, maxSeconds) {
  const list = Array.isArray(candidates) ? candidates : [];
  const known = list.filter(c => typeof c.durationSeconds === 'number' && c.durationSeconds <= maxSeconds);
  return known.length ? known : list;
}

function filterShorts(candidates, shortsOnly) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!shortsOnly) return list;
  const shorts = list.filter(c => /shorts\/|#shorts/i.test(c.url) || (typeof c.durationSeconds === 'number' && c.durationSeconds <= 65));
  return shorts.length ? shorts : list;
}

function dedupeAgainst(candidates, recentIds) {
  const recent = new Set((Array.isArray(recentIds) ? recentIds : []).map(String));
  const fresh = (Array.isArray(candidates) ? candidates : []).filter(c => !recent.has(String(c.videoId)));
  return fresh.length ? fresh : (Array.isArray(candidates) ? candidates : []);
}

// Varied fallback topics for a bare "I'm bored" (examples, not a fixed list).
function boredTopicQueries() {
  return ['funny videos', 'interesting science explained', 'gaming highlights'];
}
// Validate an Ollama-picked topic against the offered choices: accept it
// only when it matches a choice (case-insensitive); otherwise fall back to
// the first choice. The model guides, never invents, the search query.
function validateChoice(pick, choices) {
  const list = (Array.isArray(choices) ? choices : []).map(s => String(s || '').trim()).filter(Boolean);
  if (!list.length) return '';
  const clean = String(pick || '').trim().toLowerCase();
  const hit = list.find(item => item.toLowerCase() === clean);
  return hit || list[0];
}

module.exports = {
  searchYouTube, parseDurationToSeconds, formatDuration,
  filterShortEnough, filterShorts, dedupeAgainst, boredTopicQueries,
  validateChoice, YT_SEARCH_URL
};
