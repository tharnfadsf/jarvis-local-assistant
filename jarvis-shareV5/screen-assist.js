'use strict';
// JARVIS Screen Help — on-demand screen pointing (Clicky integration).
//
// One isolated module. When the chat model decides (through the existing
// Ollama fallback) that the user asked about something visible on screen,
// it calls the screen_help tool and this module:
//   1. captures the screen once (reusing screen-vision.js capture),
//   2. asks the LOCAL vision model to locate the element with Clicky's
//      two-stage numbered-grid technique (jarvis_bridge/locator_harness.py),
//   3. shows Clicky's real blue pointer overlay for a bounded time
//      (jarvis_bridge/overlay_harness.py), then it disappears by itself,
//   4. returns coordinates + a short description to the chat model.
//
// Nothing runs while idle: both processes are short-lived. "Close screen
// help" kills them instantly through close(). Everything is local: capture
// -> temp file (deleted immediately) -> local Ollama on 127.0.0.1.
//
// Clicky itself is a separate, pinned clone; this module only talks to it
// through the bridge scripts and degrades to clear messages when the clone
// or its Python venv is missing. Nothing here touches JARVIS's existing
// voice, camera, chat, or capture pipelines.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const screenHelpPhrases = require('./screen-help-phrases.js');

function clampMs(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(30000, Math.min(300000, Math.round(n)));
}

// ---- OCR fast lane keyword helpers (pure, unit-tested) ----------------
// The fast lane matches the user's question against OCR'd screen text.
// Common sentence glue and generic UI nouns are dropped: "where is the
// search box?" leaves "search" — a word Windows OCR can actually find.
// 'press/select/choose/hover/mark/highlight/move' etc. join the stopword set
// so action-verb phrasings ("press the save button", "hover over the reply
// icon") never make the OCR lane match the verb instead of the target word.
const OCR_STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'to', 'of', 'in', 'on', 'at', 'for', 'from', 'by', 'with', 'and', 'or', 'but', 'not', 'no', 'yes', 'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here', 'i', 'am', 'we', 'us', 'my', 'me', 'you', 'your', 'where', 'what', 'which', 'who', 'whom', 'how', 'why', 'when', 'can', 'cannot', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'please', 'help', 'find', 'show', 'tell', 'see', 'looking', 'look', 'need', 'want', 'locate', 'point', 'click', 'press', 'select', 'choose', 'pick', 'tap', 'hit', 'activate', 'hover', 'mark', 'highlight', 'move', 'take', 'place', 'put', 'double', 'right', 'left', 'drag', 'scroll', 'again', 'something', 'anything', 'nothing', 'screen', 'display', 'monitor', 'window']);
const OCR_GENERIC_NOUNS = new Set(['button', 'box', 'icon', 'tab', 'tabs', 'bar', 'field', 'link', 'label', 'menu', 'item', 'element', 'thing', 'stuff', 'option', 'thingy', 'widget', 'control', 'area', 'place', 'part', 'tool', 'text', 'word', 'name', 'thingie', 'placey', 'spot', 'location']);

function normalizeOcrToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function extractOcrKeywords(question) {
  const tokens = String(question || '').toLowerCase().match(/[a-z][a-z0-9_-]{1,30}/g) || [];
  const out = [];
  for (const raw of tokens) {
    const token = normalizeOcrToken(raw);
    if (token.length < 3) continue;
    if (OCR_STOPWORDS.has(token) || OCR_GENERIC_NOUNS.has(token)) continue;
    if (!out.includes(token)) out.push(token);
    if (out.length >= 6) break;
  }
  return out;
}

// Match keywords against OCR word boxes. Returns candidates sorted by
// score (desc), then reading order (top-to-bottom, left-to-right). Only
// honest signals score: exact text match, keyword contained in the word,
// or a 4+ letter word contained in a keyword (covers compounds).
function pickOcrCandidates(question, words) {
  const keywords = extractOcrKeywords(question);
  if (!keywords.length) return [];
  const seen = new Map();
  for (const word of Array.isArray(words) ? words : []) {
    const text = normalizeOcrToken(word && word.t);
    if (!text) continue;
    let best = 0;
    const raw = String(word && word.t || '').toLowerCase();
    for (const keyword of keywords) {
      if (text === keyword) { best = Math.max(best, 3); continue; }
      // Simple plural/inflection ("Notifications" for "notification") is the
      // same label; anything looser is exactly the guessing this lane avoids.
      if (text === `${keyword}s` || keyword === `${text}s`) { best = Math.max(best, 2.5); continue; }
      const boundary = new RegExp(`(^|[^a-z0-9])${keyword}([^a-z0-9]|$)`).test(raw);
      if (boundary && text.includes(keyword) && text.length - keyword.length <= 12) best = Math.max(best, 2);
      else if (text.length >= 4 && keyword.includes(text)) best = Math.max(best, 1);
    }
    if (best <= 0) continue;
    const index = seen.size;
    seen.set(index, { index, text: String(word.t), x: Number(word.x) || 0, y: Number(word.y) || 0, w: Number(word.w) || 0, h: Number(word.h) || 0, score: best });
  }
  return [...seen.values()].sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
}

// Spoken label for a UI Automation hit: the control's real accessible name
// and type, e.g. 'the "Share" button'. No invented description.
function uiaNote(uia) {
  const name = String((uia && uia.name) || '').replace(/\s+/g, ' ').trim();
  const kind = String((uia && uia.controlType) || '').replace(/Control$/, '').toLowerCase();
  if (!name) return kind ? `the ${kind} there` : 'that control';
  if (!kind) return `the "${name}" control`;
  return `the "${name}" ${kind}`;
}

// Some asks have no accessible name at all — a colour, a picture, an arrow,
// a spot inside a canvas. Those skip the UI Automation lane and keep the
// pixel lanes, so the lane can never claim a control that does not exist.
const UIA_UNSUITABLE = /\b(colou?rs?|picture|photo|image|pic|wallpaper|logo|thumbnail|drawing|graph|chart|arrow|circle|dot|line|triangle|red|orange|yellow|green|blue|purple|pink|brown|black|white|grey|gray|bright|dark|glowing|blinking|cursor|tooltip)\b/i;

function uiaSuitable(question) {
  const q = String(question || '');
  if (!q.trim()) return false;
  if (UIA_UNSUITABLE.test(q)) return false;
  // Needs at least one word that could name a control (letters, 3+).
  return /[a-z]{3}/i.test(q);
}

function createScreenAssist(options = {}) {
  const root = options.root || __dirname;
  const screenVision = options.screenVision || null;
  const spawnImpl = options.spawn || spawn;
  const log = options.log || console;
  const clickyDir = String(options.clickyDir || process.env.JARVIS_CLICKY_DIR || path.join(root, '..', 'clicky-windows'));
  const ollamaUrl = String(options.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  // Total budget: must stay under the streaming chat endpoint's 3-minute
  // abort even in the slowest (cold CPU) case, so the answer can still be
  // spoken. The harness skips the fine stage when time runs short.
  const budgetMs = clampMs(options.budgetMs || process.env.JARVIS_SCREEN_HELP_BUDGET_MS, 120000);
  // Visible time for the blue pointer. 25s (20s dwell at the target + 5s
  // companion follow) because the locate runs ~1 minute: a user who looks
  // when the answer is spoken must still find the pointer marking the spot.
  const overlaySeconds = Math.max(4, Math.min(60, Number(options.overlaySeconds || process.env.JARVIS_SCREEN_HELP_SECONDS) || 25));
  // How long to wait for the overlay's "window is up" line before assuming it
  // is alive (older harnesses print nothing). Tests shrink this.
  const overlayReadyMs = Math.max(100, Math.min(8000, Number(options.overlayReadyMs || process.env.JARVIS_SCREEN_HELP_READY_MS) || 2500));
  // Windows UI Automation lane: asks the OS for the exact named control and
  // its rectangle instead of looking at pixels. Whole-desktop walks on a
  // busy screen measured 0.3-2.0 s, so this budget is generous; when it runs
  // out the lane is abandoned and the pixel paths take over unchanged.
  const uiaMs = Math.max(900, Math.min(12000, Number(options.uiaMs || process.env.JARVIS_SCREEN_HELP_UIA_MS) || 5000));

  let overlayChild = null;   // blue pointer process
  let locatorChild = null;   // locate process
  let busy = false;
  let sessionCounter = 0;    // one session per assist() call
  let closedSession = -1;    // "close screen help" marks the current session
  let lastResult = null;     // { at, question, found, x, y, note, stage, approximate, verified }

  const pythonPath = () => path.join(clickyDir, '.venv', 'Scripts', 'python.exe');
  const bridgeScript = name => path.join(clickyDir, 'jarvis_bridge', name);
  const locatorScript = () => bridgeScript('locator_harness.py');
  const overlayScript = () => bridgeScript('overlay_harness.py');
  const ocrScript = () => bridgeScript('winocr_locator.py');
  const uiaScript = () => bridgeScript('uia_locator.py');

  // Kill a child process; taskkill fallback in case kill() alone is ignored.
  function terminate(child) {
    if (!child || child.exitCode !== null) return;
    try { child.kill(); } catch {}
    setTimeout(() => {
      try {
        if (child.exitCode === null && child.pid) {
          spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        }
      } catch {}
    }, 600);
  }

  function status() {
    return {
      ok: true,
      busy,
      clickyDir,
      pythonPresent: fs.existsSync(pythonPath()),
      locatorPresent: fs.existsSync(locatorScript()),
      overlayPresent: fs.existsSync(overlayScript()),
      ocrPresent: fs.existsSync(ocrScript()),
      uiaPresent: fs.existsSync(uiaScript()),
      uiaMs,
      pointerVisible: Boolean(overlayChild),
      overlaySeconds,
      budgetMs,
      lastResult
    };
  }

  // "Close screen help": kill the pointer and/or an in-flight locate.
  // Deterministic and instant; safe to call when nothing is active.
  function close() {
    closedSession = sessionCounter;
    const pointer = overlayChild;
    const locator = locatorChild;
    terminate(pointer);
    terminate(locator);
    overlayChild = null;
    locatorChild = null;
    if (pointer || locator) log.log(`[JARVIS screen-help] close requested (pointer=${Boolean(pointer)} locator=${Boolean(locator)})`);
    return {
      ok: true,
      wasActive: Boolean(pointer || locator),
      message: pointer ? screenHelpPhrases.pick('closed') : locator ? screenHelpPhrases.pick('stopped') : screenHelpPhrases.pick('nothingToClose')
    };
  }

  // Re-show the blue pointer at the last verified location of this session.
  // Coordinates come only from a real locate that actually succeeded here —
  // never guessed. Staleness is bounded: once the locate is older than the
  // TTL the re-mark is refused and the old target is closed out, because the
  // screen may have changed (tab switch, new window, scroll) and the old
  // pixel would silently point at the wrong thing. Updating the coordinates
  // after that always requires a fresh locate.
  const REPOINT_TTL_MS = 5 * 60 * 1000;

  async function repoint() {
    const last = lastResult;
    if (!last || !last.found || typeof last.x !== 'number') {
      // Never located anything this session: there is no coordinate to reuse,
      // and no stale one to clean up — ask for a name instead.
      return { ok: true, repointed: false, stale: false, message: screenHelpPhrases.pick('nothingMarked') };
    }
    if (Date.now() - last.at > REPOINT_TTL_MS) {
      lastResult = null; // stale target cleanup
      return { ok: true, repointed: false, stale: true, message: screenHelpPhrases.pick('expired') };
    }
    if (!fs.existsSync(pythonPath()) || !fs.existsSync(overlayScript())) {
      return { ok: false, repointed: false, stale: false, message: 'The screen-pointer component is not installed (missing bridge scripts).' };
    }
    const bubble = last.note ? String(last.note).slice(0, 57) : 'still here!';
    const pointer = await spawnOverlay(last.x, last.y, bubble);
    log.log(`[JARVIS screen-help] REPOINT at=(${last.x},${last.y}) pointer=${pointer.shown}`);
    if (!pointer.shown) {
      return { ok: true, repointed: true, pointerShown: false, stale: false, x: last.x, y: last.y, note: last.note, message: screenHelpPhrases.pick('noPointer', { note: last.note || '' }) };
    }
    return { ok: true, repointed: true, pointerShown: true, stale: false, x: last.x, y: last.y, note: last.note, message: screenHelpPhrases.pick('again', { seconds: overlaySeconds }) };
  }

  // Start the locator harness and resolve with its JSON result.
  function runLocator({ imagePath, question, capture, model, remainingMs }) {
    return new Promise(resolve => {
      const args = [
        locatorScript(),
        '--image', imagePath,
        '--question', question,
        '--origin-x', String(Math.round(Number(capture.x) || 0)),
        '--origin-y', String(Math.round(Number(capture.y) || 0)),
        '--screen-w', String(Math.round(Number(capture.bw) || Number(capture.w) || 0)),
        '--screen-h', String(Math.round(Number(capture.bh) || Number(capture.h) || 0)),
        '--model', model,
        '--budget-ms', String(Math.max(30000, Math.round(remainingMs - 5000)))
      ];
      let child;
      try {
        child = spawnImpl(pythonPath(), args, { windowsHide: true, cwd: clickyDir, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ ok: false, message: `Could not start the screen locator: ${String(error.message || error).slice(0, 160)}` });
        return;
      }
      locatorChild = child;
      let stdout = '';
      let stderr = '';
      let settled = false;
      const hardTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        terminate(child);
        if (locatorChild === child) locatorChild = null;
        resolve({ ok: false, message: 'The screen locator took too long and was stopped.' });
      }, Math.max(20000, remainingMs + 20000));

      const finish = payload => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        if (locatorChild === child) locatorChild = null;
        resolve(payload);
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { if (stdout.length < 200000) stdout += chunk; });
      child.stderr.on('data', chunk => { if (stderr.length < 20000) stderr += chunk; });
      child.on('error', error => finish({ ok: false, message: `The screen locator could not start: ${String(error.message || error).slice(0, 160)}` }));
      child.on('close', () => {
        const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
        if (!line) {
          finish({ ok: false, message: `The screen locator returned nothing${stderr.trim() ? `: ${stderr.trim().slice(0, 160)}` : '.'}` });
          return;
        }
        let parsed = null;
        try { parsed = JSON.parse(line); } catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object') {
          finish({ ok: false, message: `The screen locator returned unreadable data: ${line.slice(0, 120)}` });
          return;
        }
        if (parsed.ok !== true) {
          finish({ ok: false, message: `The screen locator failed: ${String(parsed.error || 'unknown error').slice(0, 200)}` });
          return;
        }
        finish(parsed);
      });
    });
  }

  // Show the blue pointer. The overlay harness prints one JSON line once its
  // window is actually up ({"ok": true, ...}); waiting for that line keeps
  // "pointer shown" honest — a pointer that failed to start is reported (and
  // its stderr logged) instead of being claimed. A fallback timer covers
  // older harnesses that never print, and tests shrink it via overlayReadyMs.
  function spawnOverlay(x, y, label) {
    return new Promise(resolve => {
      const args = [
        overlayScript(),
        '--x', String(Math.round(x)),
        '--y', String(Math.round(y)),
        '--label', label,
        '--seconds', String(overlaySeconds)
      ];
      let child;
      try {
        child = spawnImpl(pythonPath(), args, { windowsHide: true, cwd: clickyDir, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        log.error(`[JARVIS screen-help] pointer failed to start: ${String(error.message || error).slice(0, 160)}`);
        resolve({ shown: false });
        return;
      }
      overlayChild = child;
      let settled = false;
      let stderrTail = '';
      const settle = shown => {
        if (settled) return;
        settled = true;
        resolve({ shown });
      };
      const fallback = setTimeout(() => settle(true), overlayReadyMs); // no ready line -> alive-after-timer counts, as before
      child.on('error', error => {
        if (overlayChild === child) overlayChild = null;
        log.error(`[JARVIS screen-help] pointer error: ${String(error.message || error).slice(0, 160)}`);
        clearTimeout(fallback);
        settle(false);
      });
      child.on('exit', code => {
        if (overlayChild === child) overlayChild = null;
        if (!settled) {
          const tail = stderrTail.replace(/\s+/g, ' ').trim().slice(0, 160);
          log.error(`[JARVIS screen-help] pointer exited before showing (code ${code})${tail ? ': ' + tail : ''}`);
          clearTimeout(fallback);
          settle(false);
        }
      });
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += String(chunk);
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let parsed = null;
          try { parsed = JSON.parse(line); } catch { parsed = null; }
          if (!parsed || typeof parsed !== 'object') continue;
          if (parsed.ok === true) {
            clearTimeout(fallback);
            settle(true);
          } else if (parsed.ok === false) {
            log.error(`[JARVIS screen-help] pointer failed: ${String(parsed.error || 'unknown error').slice(0, 200)}`);
            clearTimeout(fallback);
            settle(false);
          }
        }
      });
      child.stderr.on('data', chunk => { stderrTail = (stderrTail + String(chunk)).slice(-400); });
    });
  }

  // ---- UI Automation lane (exact, ~0.3-2 s) ---------------------------
  // Windows publishes the accessible name and the exact bounding rectangle
  // of every control in the foreground window (the tree a screen reader
  // reads). Matching the question against those names answers "where is the
  // share button" precisely instead of estimating a grid cell, and it does
  // not need a screenshot, an OCR pass or a vision model at all.
  //
  // Some asks cannot be answered this way — a colour, a picture, an arrow, a
  // spot inside a canvas has no accessible name — so those skip the lane and
  // keep the pixel paths.
  function runUia({ question, target = 'screen' }) {
    return new Promise(resolve => {
      const args = [
        uiaScript(),
        '--question', String(question).slice(0, 400),
        '--target', target === 'window' ? 'window' : 'screen',
        '--max-ms', String(Math.max(800, uiaMs - 700))
      ];
      let child;
      try {
        child = spawnImpl(pythonPath(), args, {
          windowsHide: true,
          cwd: clickyDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
        });
      } catch (error) {
        resolve({ ok: false, reason: 'spawn', message: `The UI Automation helper could not start: ${String(error.message || error).slice(0, 160)}` });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = payload => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(payload);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        terminate(child);
        finish({ ok: false, reason: 'timeout', message: 'The UI Automation helper took too long.' });
      }, uiaMs);
      child.stdout.on('data', chunk => { if (stdout.length < 200000) stdout += chunk; });
      child.stderr.on('data', chunk => { if (stderr.length < 20000) stderr += chunk; });
      child.on('error', error => finish({ ok: false, reason: 'error', message: String(error.message || error).slice(0, 160) }));
      child.on('close', () => {
        const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
        if (!line) {
          finish({ ok: false, reason: 'empty', message: `The UI Automation helper returned nothing${stderr.trim() ? `: ${stderr.trim().slice(0, 160)}` : '.'}` });
          return;
        }
        let parsed = null;
        try { parsed = JSON.parse(line); } catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object') {
          finish({ ok: false, reason: 'unreadable', message: line.slice(0, 120) });
          return;
        }
        finish(parsed);
      });
    });
  }

  // ---- OCR fast lane ------------------------------------------------
  // Runs the bridge's winocr_locator.py on the already-captured screenshot
  // (same venv pywinrt that was measured at ~0.2 s for 1080p), matches the
  // question's keywords against the visible words, and — on a confident
  // hit or a tiny-model pick among duplicates — points immediately instead
  // of running the two-stage vision locator. Anything unclear falls through
  // to the locator path unchanged.
  function runOcrWords(imagePath) {
    return new Promise(resolve => {
      if (!fs.existsSync(ocrScript())) { resolve({ ok: false, message: 'The OCR helper script is missing.' }); return; }
      let child;
      try {
        child = spawnImpl(pythonPath(), [ocrScript(), '--image', imagePath], { windowsHide: true, cwd: clickyDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
      } catch (error) {
        resolve({ ok: false, message: `The OCR helper could not start: ${String(error.message || error).slice(0, 160)}` });
        return;
      }
      let stdout = ''; let stderr = ''; let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        terminate(child);
        resolve({ ok: false, message: 'The OCR helper took too long and was stopped.' });
      }, 12000);
      const finish = payload => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(payload);
      };
      child.stdout.on('data', chunk => { if (stdout.length < 400000) stdout += chunk; });
      child.stderr.on('data', chunk => { if (stderr.length < 20000) stderr += chunk; });
      child.on('error', error => finish({ ok: false, message: `The OCR helper could not start: ${String(error.message || error).slice(0, 160)}` }));
      child.on('close', () => {
        const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
        if (!line) { finish({ ok: false, message: `The OCR helper returned nothing${stderr.trim() ? `: ${stderr.trim().slice(0, 120)}` : '.'}` }); return; }
        let parsed = null;
        try { parsed = JSON.parse(line); } catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object') { finish({ ok: false, message: `The OCR helper returned unreadable data: ${line.slice(0, 120)}` }); return; }
        if (parsed.ok !== true) { finish({ ok: false, message: `The OCR helper failed: ${String(parsed.error || 'unknown error').slice(0, 200)}` }); return; }
        finish({ ok: true, text: String(parsed.text || ''), lines: Array.isArray(parsed.lines) ? parsed.lines : [], words: Array.isArray(parsed.words) ? parsed.words : [], ms: Number(parsed.ms) || 0 });
      });
    });
  }

  // Tiny local model decides among duplicate OCR hits. Any failure
  // (service down, odd reply, timeout) returns "" so the caller falls back
  // to the existing locator path — never a guessed point.
  async function ocrTinyPick(question, candidates, { msBudgetMs = 4000 } = {}) {
    const list = candidates.slice(0, 8).map((c, i) => `Candidate ${i}: "${c.text}" (near x=${c.x}, y=${c.y})`).join('\n');
    const userText = `Question: ${question}\nVisible text items:\n${list}\nWhich candidate number matches the question? Reply with one JSON object {"pick": <number>} and nothing else.`;
    const started = Date.now();
    try {
      const response = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3:1.7b',
          messages: [{ role: 'user', content: userText }],
          stream: false, think: false, format: 'json', keep_alive: '2m',
          options: { num_ctx: 2048, num_predict: 32, temperature: 0 }
        }),
        signal: AbortSignal.timeout(Math.max(2000, msBudgetMs))
      });
      if (!response.ok) return { picked: -1, ms: Date.now() - started, reason: 'pick-http-error' };
      const data = await response.json();
      const parsed = typeof data.message?.content === 'string' ? JSON.parse(data.message.content.replace(/^`+[\s\S]*?```|```/g, '').trim() || '{}') : null;
      const pick = parsed && Number.isInteger(Number(parsed.pick)) ? Number(parsed.pick) : -1;
      return { picked: pick, ms: Date.now() - started, reason: pick >= 0 ? 'ok' : 'bad-reply' };
    } catch (error) {
      return { picked: -1, ms: Date.now() - started, reason: `pick-error` };
    }
  }

  async function ocrFastLane({ imagePath, question, capture, timings }) {
    const tOcr = Date.now();
    const ocr = await runOcrWords(imagePath);
    timings.ocrMs = Date.now() - tOcr;
    if (!ocr.ok) {
      log.log(`[JARVIS screen-help] OCR fast lane skipped: ${ocr.message}`);
      return null;
    }
    const candidates = pickOcrCandidates(question, ocr.words);
    log.log(`[JARVIS screen-help] OCR fast lane ${timings.ocrMs}ms, ${ocr.words.length} words, ${candidates.length} keyword hit(s)`);
    if (!candidates.length || ocr.words.length < 1) return null;
    let picked = candidates[0];
    if (candidates.length > 1) {
      const p = await ocrTinyPick(question, candidates);
      timings.pickMs = p.ms;
      if (p.picked < 0 || p.picked >= Math.min(candidates.length, 8) || candidates[p.picked].score < 1) {
        log.log(`[JARVIS screen-help] OCR fast lane: ambiguous (${candidates.length} hits), pick failed (${p.reason}) -> locator`);
        return null;
      }
      picked = candidates[p.picked];
    }
    if (picked.score < 1 || !picked.text) return null;
    return {
      found: true,
      x: Math.round((Number(capture.x) || 0) + picked.x + picked.w / 2),
      y: Math.round((Number(capture.y) || 0) + picked.y + picked.h / 2),
      note: `That is the "${picked.text}" text on your screen`,
      stage: 'ocr',
      approximate: false,
      verified: true
    };
  }

  // Exact lane, standalone: answer a named-control question from Windows UI
  // Automation alone, then show the pointer. No screenshot, no OCR, no
  // model — it is the same tree a screen reader uses, so a hit is exact.
  // The server calls this BEFORE its local classifier: an exact accessible
  // name plus a real rectangle cannot be a guess, so there is nothing to
  // classify. `force` lets assist() reuse it while it already owns the busy
  // slot.
  async function exact({ question = '', target = 'screen', force = false } = {}) {
    const asked = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const requestId = `uia-${process.pid}-${Date.now()}`;
    if (!asked) return { ok: false, found: false, reason: 'empty' };
    if (!uiaSuitable(asked)) return { ok: true, found: false, reason: 'not-uia' };
    if (process.platform !== 'win32') return { ok: true, found: false, reason: 'platform' };
    if (!fs.existsSync(uiaScript())) return { ok: true, found: false, reason: 'missing' };
    if (!fs.existsSync(pythonPath())) return { ok: true, found: false, reason: 'missing-python' };
    if (!fs.existsSync(overlayScript())) return { ok: true, found: false, reason: 'missing-overlay' };
    if (busy && !force) return { ok: true, found: false, reason: 'busy' };
    const started = Date.now();
    const timings = { requestId };
    const uia = await runUia({ question: asked, target });
    timings.uiaMs = Date.now() - started;
    if (!uia || !uia.ok || !uia.found) {
      const reason = (uia && (uia.reason || (uia.ok ? 'no-match' : 'error'))) || 'no-match';
      return { ok: true, found: false, reason, message: uia && uia.message, timings };
    }
    const x = Math.round(Number(uia.x));
    const y = Math.round(Number(uia.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: true, found: false, reason: 'bad-coordinates', timings };
    const note = uiaNote(uia);
    const pointer = await spawnOverlay(x, y, note.length > 60 ? `${note.slice(0, 57)}...` : note);
    lastResult = { at: Date.now(), question: asked, found: true, x, y, note, stage: 'uia', approximate: false, verified: true };
    timings.totalMs = Date.now() - started;
    log.log(`[JARVIS screen-help] ${requestId} UIA lane stage=uia uia=${timings.uiaMs}ms total=${timings.totalMs}ms name="${String(uia.name || '').slice(0, 40)}" type=${uia.controlType || '?'} at=(${x},${y}) pointer=${pointer.shown}`);
    return {
      ok: true,
      found: true,
      x,
      y,
      note,
      names: uia.name ? [uia.name] : [],
      stage: 'uia',
      approximate: false,
      verified: true,
      pointerShown: pointer.shown,
      seconds: overlaySeconds,
      timings
    };
  }

  // Ask: question about something visible; answer: point at it.
  async function assist({ question = '', target = 'screen', skipUia = false } = {}) {
    const requestId = `help-${process.pid}-${Date.now()}`;
    const asked = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!asked) return { ok: false, message: 'I need to know which element to point at.' };
    if (!screenVision || typeof screenVision.captureFrame !== 'function' || typeof screenVision.chooseVisionModel !== 'function') {
      return { ok: false, message: 'Screen help is not available in this build.' };
    }
    const visionStatus = screenVision.status();
    if (!visionStatus.enabled) return { ok: false, message: 'Screen analysis is turned off. Enable it in the Screen Vision settings card or say "Jarvis, enable screen vision".' };
    if (busy) return { ok: false, message: 'I am already looking at the screen. One moment, Sir.' };
    if (process.platform !== 'win32') return { ok: false, message: 'Screen help is only available on Windows.' };
    if (!fs.existsSync(pythonPath())) {
      return { ok: false, message: `The screen-pointer component is not installed (missing ${pythonPath()}). Answer from the screen description instead.` };
    }
    if (!fs.existsSync(overlayScript())) {
      return { ok: false, message: 'The screen-pointer bridge scripts are missing from the Clicky folder. Answer from the screen description instead.' };
    }
    const locatorReady = fs.existsSync(locatorScript());

    const session = ++sessionCounter;
    busy = true;
    const startedAt = Date.now();
    const timings = { requestId };
    const elapsed = () => Date.now() - startedAt;
    let tempFile = '';
    try {
      // UI AUTOMATION FIRST (2026-10-24) — no screenshot, no OCR, no model.
      // Windows knows the name and exact rectangle of every control, so a
      // named ask ("where is the share button") is answered in a few hundred
      // milliseconds and with the true control box instead of an estimate.
      // A miss costs one bounded tree walk and falls through untouched.
      if (!skipUia) {
        const hit = await exact({ question: asked, target, force: true });
        timings.uiaMs = hit.timings ? hit.timings.uiaMs : 0;
        if (session <= closedSession) {
          timings.totalMs = elapsed();
          return { ok: true, found: false, closed: true, message: 'Screen help was closed before it finished.' };
        }
        if (hit.found) {
          timings.totalMs = elapsed();
          return { ...hit, timings };
        }
        if (hit.message) {
          log.log(`[JARVIS screen-help] ${requestId} UIA lane skipped (${hit.reason || 'error'}): ${String(hit.message).slice(0, 160)}`);
        } else if (hit.reason && !['not-uia', 'missing', 'busy', 'platform'].includes(hit.reason)) {
          log.log(`[JARVIS screen-help] ${requestId} UIA lane: no exact control (${timings.uiaMs}ms) -> pixel lanes`);
        }
      }

      // CAPTURE NEXT — instant local operation, locks in the screen content
      // before any model selection or slow processing. This prevents tab-switch
      // race conditions: the screenshot reflects exactly what was on screen
      // when the user asked.
      const tCapture = Date.now();
      const capture = await screenVision.captureFrame(target);
      timings.captureMs = Date.now() - tCapture;
      if (!capture.ok) { timings.totalMs = elapsed(); return { ok: false, message: capture.message || 'The screen capture failed.' }; }

      // One temp screenshot for the locator/OCR; deleted in finally, never saved.
      tempFile = path.join(os.tmpdir(), `jarvis-screenhelp-${process.pid}-${Date.now()}.png`);
      await fs.promises.writeFile(tempFile, capture.buffer);

      // OCR FAST LANE — runs immediately on the captured image.
      // Local WinRT OCR via bridge venv (~0.2 s for 1080p).
      // If it finds a clear match, we return instantly without ever
      // touching the vision model. This is the "instant" path.
      let fastLane = null;
      if (fs.existsSync(ocrScript())) {
        try {
          fastLane = await ocrFastLane({ imagePath: tempFile, question: asked, capture, timings });
        } catch (error) {
          log.error(`[JARVIS screen-help] ${requestId} OCR fast lane failed: ${String(error.message || error).slice(0, 160)}`);
        }
      }
      if (session <= closedSession) {
        timings.totalMs = elapsed();
        return { ok: true, found: false, closed: true, message: 'Screen help was closed before it finished.' };
      }
      if (fastLane && fastLane.found) {
        const pointer = await spawnOverlay(fastLane.x, fastLane.y, fastLane.note.slice(0, 60));
        lastResult = { at: Date.now(), question: asked, found: true, x: fastLane.x, y: fastLane.y, note: fastLane.note, stage: 'ocr', approximate: false, verified: true };
        timings.totalMs = elapsed();
        log.log(`[JARVIS screen-help] ${requestId} FAST lane stage=ocr capture=${timings.captureMs}ms ocr=${timings.ocrMs}ms${timings.pickMs ? ` pick=${timings.pickMs}ms` : ''} total=${timings.totalMs}ms at=(${fastLane.x},${fastLane.y}) pointer=${pointer.shown}`);
        return {
          ok: true,
          found: true,
          x: fastLane.x,
          y: fastLane.y,
          note: fastLane.note,
          approximate: false,
          verified: true,
          stage: 'ocr',
          pointerShown: pointer.shown,
          seconds: overlaySeconds,
          timings
        };
      }

      // OCR couldn't resolve — fall through to vision model locator.
      if (!locatorReady) {
        timings.totalMs = elapsed();
        log.error(`[JARVIS screen-help] ${requestId} locator harness missing; UIA and OCR found nothing for this ask`);
        return { ok: true, found: false, message: 'The screen locator component is missing from the Clicky folder, and the visible text did not name that element.', timings };
      }
      // Select the model ONLY now, after capture is locked in.
      const tModel = Date.now();
      const modelChoice = await screenVision.chooseVisionModel();
      timings.modelSelectMs = Date.now() - tModel;
      if (!modelChoice.ok) return modelChoice;

      const tLocate = Date.now();
      const remainingMs = Math.max(20000, budgetMs - elapsed());
      const located = await runLocator({ imagePath: tempFile, question: asked, capture, model: modelChoice.model, remainingMs });
      timings.locateMs = Date.now() - tLocate;

      if (session <= closedSession) {
        timings.totalMs = elapsed();
        return { ok: true, found: false, closed: true, message: 'Screen help was closed before it finished.' };
      }
      if (!located.ok) {
        timings.totalMs = elapsed();
        log.error(`[JARVIS screen-help] ${requestId} locate failed: ${located.message}`);
        return { ok: false, message: located.message, timings };
      }
      if (!located.found) {
        timings.totalMs = elapsed();
        lastResult = { at: Date.now(), question: asked, found: false };
        log.log(`[JARVIS screen-help] ${requestId} no element found (${timings.locateMs}ms locate)`);
        return { ok: true, found: false, message: 'The locator did not find a specific element matching that question on the screen.', timings };
      }

      const note = String(located.note || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const bubble = note ? (note.length > 60 ? `${note.slice(0, 57)}...` : note) : 'found it!';
      const pointer = await spawnOverlay(located.x, located.y, bubble);
      // The harness runs a red-dot verify pass and reports "approximate"
      // itself now (rejected/unconfirmed points); fall back to the old
      // stage-based rule when an older harness is in place.
      const approximate = typeof located.approximate === 'boolean' ? located.approximate : located.stage === 1;
      const verified = typeof located.verified === 'boolean' ? located.verified : null;
      lastResult = { at: Date.now(), question: asked, found: true, x: located.x, y: located.y, note, stage: located.stage, approximate, verified };
      timings.totalMs = elapsed();
      log.log(`[JARVIS screen-help] ${requestId} model=${modelChoice.model} capture=${timings.captureMs}ms locate=${timings.locateMs}ms total=${timings.totalMs}ms stage=${located.stage} verified=${located.verified} altUsed=${located.altUsed === true} at=(${located.x},${located.y}) pointer=${pointer.shown}`);
      return {
        ok: true,
        found: true,
        x: located.x,
        y: located.y,
        note,
        stage: 'vision',
        visionStage: located.stage,
        approximate,
        verified,
        pointerShown: pointer.shown,
        seconds: overlaySeconds,
        timings
      };
    } catch (error) {
      timings.totalMs = elapsed();
      log.error(`[JARVIS screen-help] ${requestId} FAILED after ${timings.totalMs}ms: ${String(error.message || error).slice(0, 200)}`);
      return { ok: false, message: `Screen help failed: ${String(error.message || error).slice(0, 200)}`, timings };
    } finally {
      busy = false;
      // Await the deletion so "one punctual capture, deleted immediately" is
      // true when assist() resolves. Fire-and-forget left the temp screenshot
      // on disk for an indeterminate moment after the caller already reported
      // completion.
      if (tempFile) await fs.promises.unlink(tempFile).catch(() => {});
    }
  }

  // One-word local-model check: is this question about locating something
  // visible on the user's own screen right now? Conservative by design —
  // anything unclear or failed means "no" so capture never happens by
  // accident. Runs on the same local Ollama the chat fallback uses.
  const CLASSIFIER_SYSTEM = [
    'You decide if a user message asks JARVIS to interact with something visible on their own computer screen right now — a button, icon, menu, tab, box, field to locate, point at, click, press, select, or move the pointer to.',
    'Answer YES for: "where is the settings button?", "where is this button?", "where do I click to send?", "i can\'t find the save button", "show me where the download button is", "highlight the save button", "point me at the reply button", "i need help with the settings button", and direct action asks like "click the settings icon", "press the send button", "select that option", "tap the search box", "click on settings", "can you click the settings button?", "move the mouse to settings", "move the cursor over that icon", "hover over the menu", "put the pointer on that button", "double-click that folder", "right-click the file", "point at the search bar", "show me where the cursor is".',
    'Answer NO for: questions about the world ("where is Paris", "where is the nearest market"), general facts or how-to questions, app or website launches ("open YouTube Music", "open settings as an app question", "open my Roblox folder"), media ("play Magnetic by ILLIT"), search requests ("look up the latest MacBook news"), questions about buttons in conversation ("what\'s that button used for?", "can you explain how clicking works?", "is the M3 MacBook still good?"), reports of past actions ("i clicked the wrong button earlier"), thanks and small talk, camera or view questions ("what am I looking at", "what is this"), requests to describe or read the screen ("describe my screen", "read this error"), file or folder location questions ("where is the file I downloaded"), general requests for help ("i need help with my homework"), and anything that is not about locating or interacting with something visible on their screen right now.',
    'Reply with exactly one word: YES or NO.'
  ].join(' ');

  async function classify(question, { model } = {}) {
    const asked = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!asked) return { yes: false, reason: 'empty', ms: 0 };
    const started = Date.now();
    try {
      const response = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: CLASSIFIER_SYSTEM }, { role: 'user', content: asked }],
          stream: false, think: false, keep_alive: '2m',
          options: { num_ctx: 2048, num_predict: 4, temperature: 0 }
        }),
        signal: AbortSignal.timeout(20000)
      });
      const ms = Date.now() - started;
      if (!response.ok) return { yes: false, reason: `classifier-http-${response.status}`, ms };
      const data = await response.json();
      const text = String(data.message?.content || '').replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
      if (/^yes\b/i.test(text)) return { yes: true, ms };
      if (/^no\b/i.test(text)) return { yes: false, reason: 'not-screen', ms };
      return { yes: false, reason: 'unclear', ms };
    } catch (error) {
      return { yes: false, reason: 'classifier-error', ms: Date.now() - started, error: String((error && error.message) || error).slice(0, 160) };
    }
  }

  return { assist, exact, close, status, classify, repoint };
}

module.exports = { createScreenAssist, extractOcrKeywords, pickOcrCandidates, uiaSuitable };
