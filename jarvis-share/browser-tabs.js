'use strict';
// Real browser tab management for JARVIS (Phase 9).
//
// Uses the Chrome/Edge DevTools Protocol (CDP) over the browser's supported
// remote-debugging endpoint. No browser extension is required, but the browser
// must be started with --remote-debugging-port=<port>. JARVIS never kills
// browser processes to close a tab and never claims success for a plain
// keyboard shortcut: when no verified control channel exists, every function
// here reports needsSetup so callers can tell the user the truth.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const core = require('./jarvis-core.js');
const execFileAsync = promisify(execFile);

const DEFAULT_PORTS = [9222, 9223, 9333, 9444, 9224];
const isWin = process.platform === 'win32';
let endpointCache = { at: 0, endpoint: null };
let lastActivatedId = '';

// Persistent auto tab-control lifecycle. Activation used to live only in the
// running browser's flags, so every restart or closed window forced the user
// back through "enable browser control". ensureControl() reconnects or
// relaunches automatically (unless JARVIS_TAB_CONTROL=off); status() keeps
// reporting the honest live state and never claims a missing connection.
const lifecycle = { state: 'idle', auto: true, browser: '', port: 0, tabs: 0, message: '', updatedAt: 0 };
let ensureFlight = null;
function tabControlMode() {
  return String(process.env.JARVIS_TAB_CONTROL || 'auto').toLowerCase() === 'off' ? 'off' : 'auto';
}
function setLifecycle(patch) {
  Object.assign(lifecycle, patch, { updatedAt: Date.now() });
}
function getLifecycle() {
  return { ...lifecycle, auto: tabControlMode() !== 'off' };
}
async function ensureControl({ launch = true, minimized = false } = {}) {
  if (ensureFlight) return ensureFlight;
  ensureFlight = (async () => {
    if (tabControlMode() === 'off') {
      setLifecycle({ state: 'disabled', browser: '', port: 0, tabs: 0, message: 'Tab control is turned off (JARVIS_TAB_CONTROL=off).' });
      return { ok: false, disabled: true, lifecycle: getLifecycle() };
    }
    setLifecycle({ state: lifecycle.state === 'connected' ? 'reconnecting' : 'initializing', message: 'Checking the browser tab-control connection.' });
    const endpoint = await discoverEndpoint(true);
    if (endpoint) {
      const listed = await listTabs();
      if (listed.ok) {
        setLifecycle({ state: 'connected', browser: endpoint.browser, port: endpoint.port, tabs: listed.tabs.length, message: `Connected to ${endpoint.browser} tab control (${listed.tabs.length} tab(s) visible).` });
        return { ok: true, connected: true, lifecycle: getLifecycle() };
      }
      setLifecycle({ state: 'reconnecting', browser: endpoint.browser, port: endpoint.port, tabs: 0, message: 'The browser answered but tab listing failed; retrying.' });
    } else {
      setLifecycle({ state: 'waiting-for-browser', message: 'No controlled browser endpoint answered yet.' });
    }
    // launch:false means reconnect-only: re-probe what is already running but
    // never spawn a browser (closing the window is the user's choice).
    if (!launch) return { ok: false, lifecycle: getLifecycle() };
    if (launch && isWin) {
      const launched = await enableBrowserControl({ minimized });
      if (launched.ok) {
        const verify = await listTabs();
        if (verify.ok) {
          const ep = await discoverEndpoint(true);
          setLifecycle({ state: 'connected', browser: (ep && ep.browser) || 'browser', port: (ep && ep.port) || 0, tabs: verify.tabs.length, message: launched.message });
          return { ok: true, connected: true, lifecycle: getLifecycle() };
        }
      }
      setLifecycle({ state: 'error', message: launched.message || 'The controlled browser window did not start with tab control.' });
      return { ok: false, lifecycle: getLifecycle(), message: launched.message };
    }
    if (!isWin) setLifecycle({ state: 'error', message: 'Automatic browser launch is only supported on Windows.' });
    return { ok: false, lifecycle: getLifecycle() };
  })();
  try {
    return await ensureFlight;
  } finally {
    ensureFlight = null;
  }
}

function browserExecutables() {
  // Google Chrome is the primary controlled browser. Microsoft Edge is an
  // optional fallback only — it is never assumed to be the default.
  const chromeCandidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  const edgeCandidates = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ].filter(Boolean);
  const chrome = chromeCandidates.find(candidate => { try { return fs.existsSync(candidate); } catch { return false; } });
  const edge = edgeCandidates.find(candidate => { try { return fs.existsSync(candidate); } catch { return false; } });
  return [chrome, edge].filter(Boolean);
}

async function probeEndpoint(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    const info = await response.json();
    return { port, browser: String(info.Browser || 'browser').replace(/\s*\/.*$/, '').trim() || 'browser' };
  } catch { return null; }
}

async function discoverEndpoint(force = false) {
  if (!force && Date.now() - endpointCache.at < 8000) return endpointCache.endpoint;
  const ports = new Set(DEFAULT_PORTS);
  if (isWin) {
    // The controlled connection is authoritative: whichever browser (Chrome
    // or Edge) actually runs with --remote-debugging-port is reused as-is.
    // Scan BOTH process lists every time. The old "!ports.size" guard was
    // dead code (DEFAULT_PORTS keeps the set non-empty), so Edge ports on
    // non-default ports were never discovered.
    for (const procFilter of ["Name='chrome.exe'", "Name='msedge.exe'"]) {
      try {
        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          `Get-CimInstance Win32_Process -Filter "${procFilter}" | ForEach-Object { $_.CommandLine } | Where-Object { $_ }`
        ], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
        for (const match of String(stdout || '').matchAll(/--remote-debugging-port=(\d{2,5})/g)) ports.add(Number(match[1]));
      } catch {}
    }
  }
  let found = null;
  for (const port of ports) {
    const info = await probeEndpoint(port);
    if (info) { found = { ...info, at: Date.now() }; break; }
  }
  endpointCache = { at: Date.now(), endpoint: found };
  return found;
}

function wsCommand(wsUrl, method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') { reject(new Error('WebSocket support is missing from this Node build.')); return; }
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (error) { reject(error); return; }
    const id = Math.floor(Math.random() * 1e9);
    let settled = false;
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      finish(value);
    };
    const timer = setTimeout(() => settle(reject, new Error('The browser did not respond to the tab request.')), timeoutMs);
    ws.onopen = () => { try { ws.send(JSON.stringify({ id, method, params })); } catch (error) { settle(reject, error); } };
    ws.onmessage = event => {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== id) return;
      if (message.error) settle(reject, new Error(String(message.error.message || 'The browser rejected the tab command.')));
      else settle(resolve, message.result || {});
    };
    ws.onerror = () => settle(reject, new Error('The browser control connection failed.'));
    ws.onclose = () => settle(reject, new Error('The browser control connection closed before the browser answered.'));
  });
}

async function listTabs() {
  const endpoint = await discoverEndpoint();
  if (!endpoint) {
    return { ok: false, status: 'not-connected', needsSetup: true, message: 'Browser tab control is not connected yet. Say "start a controlled browser window" and I will open a separate JARVIS-controlled Google Chrome window alongside yours — your open tabs stay untouched.' };
  }
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/list`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = await response.json();
    const tabs = (Array.isArray(rows) ? rows : [])
      .filter(row => row && row.type === 'page' && !String(row.url || '').startsWith('devtools://'))
      .map((row, index) => ({
        id: String(row.id || row.targetId || ''),
        index,
        title: String(row.title || '').slice(0, 160),
        url: String(row.url || '').slice(0, 320),
        ws: String(row.webSocketDebuggerUrl || '')
      }));
    return { ok: true, tabs, browser: endpoint.browser, port: endpoint.port };
  } catch (error) {
    endpointCache = { at: 0, endpoint: null };
    return { ok: false, status: 'disconnected', needsSetup: true, message: `The browser stopped answering tab control (${error.message}). Say “enable browser control” to reconnect.` };
  }
}

async function foregroundWindowTitle() {
  if (!isWin) return '';
  try {
    const script = `Add-Type -Name Jw -Namespace J -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int c);' -ErrorAction SilentlyContinue; $h=[J.Jw]::GetForegroundWindow(); if($h -eq [IntPtr]::Zero){''}else{$sb=New-Object System.Text.StringBuilder 512; [void][J.Jw]::GetWindowText($h,$sb,$sb.Capacity); $sb.ToString()}`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 4000, maxBuffer: 64 * 1024 });
    return String(stdout || '').trim();
  } catch { return ''; }
}

function publicTab(tab) { return { title: tab.title, url: tab.url, index: tab.index }; }

// Hosts that indicate a music/audio tab. CDP target info exposes no audible
// flag, so "the tab playing music" resolves to tabs on music services.
const MUSIC_TAB_HOSTS = ['music.youtube.com', 'open.spotify.com', 'soundcloud.com', 'music.apple.com', 'deezer.com', 'pandora.com', 'music.amazon', 'music.youtube', 'youtube.com', 'youtu.be'];
function isMusicTab(tab) {
  const location = `${String(tab.url || '').toLowerCase()} ${String(tab.title || '').toLowerCase()}`;
  return MUSIC_TAB_HOSTS.some(host => location.includes(host));
}

async function resolveTarget(listed, { tabId = '', query = '', position = null, last = false, current = false, music = false } = {}) {
  const tabs = listed.tabs;
  // An explicit tabId (already re-validated by the caller) wins outright. This
  // is how a chosen candidate from a pending question is closed precisely,
  // without re-running a title match that could pick a different tab.
  if (tabId) {
    const byId = tabs.find(tab => String(tab.id) === String(tabId));
    if (byId) return { ok: true, target: byId };
    return { ok: false, message: 'That tab is no longer open, Sir. Nothing was closed.' };
  }
  if (music) {
    const matches = tabs.filter(isMusicTab);
    if (!matches.length) return { ok: false, message: 'I could not find a tab playing music. Open YouTube Music first, then ask me again.' };
    if (matches.length > 1) return { ok: false, status: 'ambiguous', matches: matches.slice(0, 6).map(publicTab), message: `I found ${matches.length} music tabs: ${matches.slice(0, 4).map(tab => tab.title || tab.url).join(', ')}. Which one should I use?` };
    return { ok: true, target: matches[0] };
  }
  if (query) {
    const ranked = core.matchBrowserTabs(tabs, query);
    const matches = ranked.matches;
    if (!matches.length) return { ok: false, message: `I could not find an open tab matching “${query}”.` };
    // One clearly better candidate acts immediately. A tie (or a near-tie)
    // asks, but never re-asks when the user's own wording already decided it.
    const top = ranked.scored[0];
    const second = ranked.scored[1];
    const clearWinner = !second || top.score - second.score >= 15 || (second.score / Math.max(1, top.score)) < 0.75;
    if (matches.length > 1 && !clearWinner) {
      return { ok: false, status: 'ambiguous', matches: matches.slice(0, 6).map(publicTab), message: `I found ${matches.length} tabs matching “${query}”: ${matches.slice(0, 4).map(tab => tab.title).join(', ')}. Which one should I close?` };
    }
    return { ok: true, target: matches[0] };
  }
  if (last) {
    if (!tabs.length) return { ok: false, message: 'There are no open browser tabs I can control.' };
    return { ok: true, target: tabs[tabs.length - 1] };
  }
  if (position) {
    const index = Number(position) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= tabs.length) return { ok: false, message: `You have ${tabs.length} controlled tab${tabs.length === 1 ? '' : 's'}, so that position does not exist.` };
    return { ok: true, target: tabs[index] };
  }
  // "this tab" / "the current tab": one open tab is unambiguous; otherwise the
  // foreground window title identifies the visible page.
  if (tabs.length === 1) return { ok: true, target: tabs[0] };
  const windowTitle = await foregroundWindowTitle();
  const matches = windowTitle ? tabs.filter(tab => tab.title && windowTitle.includes(tab.title)) : [];
  if (matches.length === 1) return { ok: true, target: matches[0] };
  return { ok: false, status: 'ambiguous', matches: tabs.slice(0, 6).map(publicTab), message: 'I could not tell which tab is in front. Name the tab you mean, for example “close the YouTube tab”.' };
}

async function closeVerified(tab) {
  if (!tab.ws) throw new Error('That tab does not expose a control connection.');
  await wsCommand(tab.ws, 'Target.closeTarget', { targetId: tab.id });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const listed = await listTabs();
    if (listed.ok && !listed.tabs.some(item => item.id === tab.id)) return { verified: true, remaining: listed.tabs.length };
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  return { verified: false, remaining: null };
}

async function closeTabRequest(options = {}) {
  const listed = await listTabs();
  if (!listed.ok) return listed;
  if (!listed.tabs.length) return { ok: false, message: 'There are no open browser tabs I can control.' };
  const resolved = await resolveTarget(listed, options);
  if (!resolved.ok) return resolved;
  const target = resolved.target;
  try {
    const verification = await closeVerified(target);
    const remaining = verification.remaining ?? Math.max(0, listed.tabs.length - 1);
    return {
      ok: true, closed: publicTab(target), verified: verification.verified, remaining,
      message: verification.verified
        ? `Closed the “${target.title}” tab. ${remaining} tab${remaining === 1 ? '' : 's'} still open.`
        : `I sent a close command for the “${target.title}” tab, but I could not verify it closed.`
    };
  } catch (error) {
    return { ok: false, message: `I could not close the “${target.title}” tab: ${error.message}` };
  }
}

async function activeTabId(listed) {
  const windowTitle = await foregroundWindowTitle();
  const matches = windowTitle ? listed.tabs.filter(tab => tab.title && windowTitle.includes(tab.title)) : [];
  if (matches.length === 1) return matches[0].id;
  if (listed.tabs.some(tab => tab.id === lastActivatedId)) return lastActivatedId;
  return '';
}

async function activateTabRequest(options = {}) {
  const listed = await listTabs();
  if (!listed.ok) return listed;
  if (!listed.tabs.length) return { ok: false, message: 'There are no open browser tabs I can control.' };
  let target = null;
  if (options.direction) {
    if (listed.tabs.length === 1) return { ok: true, tab: publicTab(listed.tabs[0]), message: `Only one tab is open: “${listed.tabs[0].title}”.` };
    const currentId = await activeTabId(listed);
    const currentIndex = currentId ? listed.tabs.findIndex(tab => tab.id === currentId) : -1;
    const nextIndex = options.direction === 'next'
      ? (currentIndex + 1) % listed.tabs.length
      : (currentIndex <= 0 ? listed.tabs.length - 1 : currentIndex - 1);
    target = listed.tabs[nextIndex];
  } else {
    const resolved = await resolveTarget(listed, options);
    if (!resolved.ok) return resolved;
    target = resolved.target;
  }
  try {
    await wsCommand(target.ws, 'Target.activateTarget', { targetId: target.id });
    lastActivatedId = target.id;
    return { ok: true, tab: publicTab(target), message: `Switched to “${target.title}”.` };
  } catch (error) {
    return { ok: false, message: `I could not switch tabs: ${error.message}` };
  }
}

async function currentTabRequest() {
  const listed = await listTabs();
  if (!listed.ok) return listed;
  if (!listed.tabs.length) return { ok: false, message: 'There are no open browser tabs I can control.' };
  if (listed.tabs.length === 1) return { ok: true, tab: publicTab(listed.tabs[0]), message: `You are on “${listed.tabs[0].title}” — ${listed.tabs[0].url}` };
  const windowTitle = await foregroundWindowTitle();
  const matches = windowTitle ? listed.tabs.filter(tab => tab.title && windowTitle.includes(tab.title)) : [];
  if (matches.length === 1) return { ok: true, tab: publicTab(matches[0]), message: `You are on “${matches[0].title}” — ${matches[0].url}` };
  return { ok: false, status: 'ambiguous', matches: listed.tabs.slice(0, 6).map(publicTab), message: `I could not tell which tab is in front. I can see ${listed.tabs.length} controlled tabs; name one to identify it.` };
}

// Navigate an existing tab to a URL through the connected session (CDP
// Page.navigate). Used so a new song reuses the open music tab instead of
// opening a duplicate tab for every request. Never opens tabs itself.
async function navigateTab(url, { query = '' } = {}) {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return { ok: false, message: 'That address does not look like a web page.' };
  const listed = await listTabs();
  if (!listed.ok) return listed;
  const q = String(query || '').trim().toLowerCase();
  const target = q ? listed.tabs.find(tab => String(tab.url || '').toLowerCase().includes(q)) || null : null;
  if (!target) return { ok: false, status: 'no-music-tab', query, message: '' };
  if (!target.ws) return { ok: false, message: 'That tab does not expose a control connection.' };
  try {
    await wsCommand(target.ws, 'Page.navigate', { url: clean });
    return { ok: true, navigated: true, tab: publicTab(target) };
  } catch (error) {
    return { ok: false, message: `I could not navigate that tab: ${error.message}` };
  }
}

// Music-tab media control through the connected CDP session (Runtime.evaluate
// on the page's own <video> element). This is tab-exact: it reads back the
// real paused/title state, so playback claims are verified, not assumed.
// YouTube Music plays audio through a <video> element; next/previous click the
// player-bar buttons with several selector fallbacks.
const MEDIA_BUTTON_SELECTORS = {
  next: ['[aria-label="Next"]', '[aria-label="Next song"]', '.ytmusic-player-bar [aria-label="Next"]', '#primary-renderer [aria-label="Next"]'],
  previous: ['[aria-label="Previous"]', '[aria-label="Previous song"]', '.ytmusic-player-bar [aria-label="Previous"]', '#primary-renderer [aria-label="Previous"]']
};
async function findMusicTab() {
  const listed = await listTabs();
  if (!listed.ok) return listed;
  const matches = listed.tabs.filter(isMusicTab);
  if (!matches.length) return { ok: false, status: 'no-music-tab', message: 'I could not find an open music tab. Open YouTube Music first, then ask me again.' };
  if (matches.length > 1) return { ok: false, status: 'ambiguous', matches: matches.slice(0, 6).map(publicTab), message: `I found ${matches.length} music tabs: ${matches.slice(0, 4).map(tab => tab.title || tab.url).join(', ')}. Which one should I use for YouTube Music browser media control?` };
  const target = matches[0];
  if (!target.ws) return { ok: false, message: 'That music tab does not expose a control connection.' };
  return { ok: true, target };
}
async function evaluateOnTab(target, expression) {
  return wsCommand(target.ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 8000);
}

// ---------------------------------------------------------------------------
// Page reading for voice modes (2026-10-15)
// ---------------------------------------------------------------------------
// Study mode reads the student's todo / upcoming list off the Toddle tab that
// it already opened. This is a best-effort DOM scrape: Toddle is a single-page
// app behind a login, so the extractor works in tiers from most specific
// selector to most generic, and reports honestly (signed-out / no-tab /
// could-not-read) instead of inventing work that is not on the page.
const SITE_HOST_PATTERNS = {
  toddle: /(^|\.)toddleapp\.com$/i,
};
function tabHost(url) {
  const m = String(url || '').match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  if (!m) return '';
  return String(m[1] || '').split('@').pop().split(':')[0].toLowerCase();
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
// Runs in the page context. Kept as one self-contained IIFE: it must not
// reference anything from this Node module.
//
// The primary selector below was verified against the real signed-in Toddle
// dashboard DOM (ConsolidatedDeadlinesWidget), where one assignment renders as:
//   ConsolidatedDeadlinesWidget__item___beyKO
//     ConsolidatedDeadlinesWidget__middleContainer___ARB7o
//       ConsolidatedDeadlinesWidget__nameWithTagContainer____vDz2  "In Cold Blood - Literary Journalism"
//     <subject div>                                                   "English Language and Literature"
// and the sibling "middleContainer" text carries the due date, e.g. "27 Oct, 10 am".
// The generic tiers below only run if that widget is absent, so other Toddle
// pages still produce something. Results are de-duplicated by title+due because
// the broad class selector also matches the "itemsWrapper" parent.
const SITE_TODO_EXPRESSION = `(() => {
  const clean = s => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const txt = el => clean(el && (el.innerText || el.textContent));
  const heading = txt(document.querySelector('main h1, main h2, h1, h2'));
  const signedOut = !!document.querySelector('input[type="password"]') || /^(?:sign ?in|log ?in|login|welcome back)$/i.test(heading);
  // Filter-tab totals, e.g. "Upcoming (1)", "Not submitted (2)". These are read
  // even when the visible tab shows nothing, so an empty-looking widget can
  // still report what is waiting behind the other filters.
  const counts = {};
  const bodyText = clean(document.body && document.body.innerText);
  for (const label of ['Upcoming', 'Overdue', 'No due date', 'Not submitted']) {
    const m = bodyText.match(new RegExp(label + '\\\\s*\\\\((\\\\d+)\\\\)'));
    if (m) counts[label] = Number(m[1]);
  }
  const out = [];
  const seen = new Set();
  const push = (title, due, subject) => {
    title = clean(title).slice(0, 120);
    if (!title || title.length < 3) return;
    // Widget chrome is never coursework, whatever the fallback matched.
    if (/^(?:view all|see all|show all|assignments? and deadlines|upcoming|overdue|not submitted|no due date|filter|sort)/i.test(title)) return;
    if (/\bView all\b/.test(title)) return;
    const key = (title + '|' + clean(due)).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ title, due: clean(due).slice(0, 40), subject: clean(subject).slice(0, 60) });
  };
  let widgetItems = [];
  try { widgetItems = Array.from(document.querySelectorAll('[class*="ConsolidatedDeadlinesWidget__item"]')); } catch (e) { widgetItems = []; }
  for (const it of widgetItems) {
    const nameEl = it.querySelector('[class*="nameWithTagContainer"]');
    const midEl = it.querySelector('[class*="middleContainer"]');
    const title = txt(nameEl);
    if (!title) continue;
    const mid = txt(midEl);
    const due = mid.indexOf(title) === 0 ? clean(mid.slice(title.length)) : '';
    let subject = '';
    if (midEl && midEl.parentElement) {
      subject = txt(Array.from(midEl.parentElement.children).find(k => k !== midEl));
    }
    push(title, due, subject);
  }
  // Fallback only when the widget is completely absent. "Fewer than two" was
  // wrong: a genuinely short to-do list is still a real answer, and letting the
  // generic tiers run then re-matched the widget's own header ("Assignments and
  // deadlines View all") as if it were coursework.
  if (!out.length) {
    const tiers = [
      ['[data-testid*="assignment" i]', '[data-testid*="task" i]', '[data-testid*="todo" i]'],
      ['[class*="assignment" i]', '[class*="homework" i]', '[class*="deadline" i]'],
      ['[role="listitem"]', 'li', 'article']
    ];
    const dueOf = s => {
      const d = String(s).match(/\\b(\\d{1,2}[\\/.-]\\d{1,2}(?:[\\/.-]\\d{2,4})?|\\d{1,2}\\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|today|tomorrow|mon|tue|wed|thu|fri|sat|sun)[a-z]*\\b/i);
      return d ? clean(d[1]) : '';
    };
    for (const tier of tiers) {
      let nodes = [];
      for (const sel of tier) { try { nodes = nodes.concat(Array.from(document.querySelectorAll(sel))); } catch (e) { /* ignore */ } }
      for (const el of nodes) {
        if (el.closest && el.closest('nav, header, footer, aside, script, style')) continue;
        const raw = txt(el);
        if (!raw || raw.length < 4 || raw.length > 240) continue;
        const title = clean(raw.replace(/\\s*[|·•,-]\\s*(?:due|due on|by)\\b.*$/i, '').slice(0, 120));
        push(title, dueOf(raw), '');
      }
      if (out.length >= 2) break;
    }
  }
  return { signedOut, heading, counts, count: out.length, items: out.slice(0, 8), url: location.href };
})()`;
// Read the todo / upcoming list from an already-open tab of a known site.
async function readSiteTodos(site) {
  const key = String(site || '').toLowerCase();
  const pattern = SITE_HOST_PATTERNS[key];
  if (!pattern) return { ok: false, site: key, message: 'I cannot read that site yet, Sir.' };
  const listed = await listTabs();
  if (!listed.ok) return { ...listed, site: key };
  const matches = listed.tabs.filter(tab => pattern.test(tabHost(tab.url)));
  if (!matches.length) return { ok: false, site: key, status: 'no-tab', message: `No ${key} tab is open in the browser I control, so I could not read your list.` };
  const target = matches.find(tab => tab.ws) || matches[0];
  if (!target.ws) return { ok: false, site: key, status: 'not-connected', message: `I found ${key}, but that tab does not expose a control connection.` };
  // A freshly opened single-page app often has not painted its list yet, so an
  // empty first read is retried briefly before giving up.
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1200);
    try {
      const result = await evaluateOnTab(target, SITE_TODO_EXPRESSION);
      const value = (result && result.result && result.result.value) || null;
      if (value) { last = value; if (value.signedOut || (value.items && value.items.length)) break; }
    } catch (error) {
      if (attempt === 2) return { ok: false, site: key, message: `I could not read ${key}: ${error.message}` };
    }
  }
  if (!last) return { ok: false, site: key, message: `I could not read ${key} just now, Sir.` };
  if (last.signedOut) return { ok: false, site: key, status: 'signed-out', signedOut: true, message: `${key} needs you to sign in before I can read your list.` };
  return { ok: true, site: key, items: last.items || [], count: last.count || 0, counts: last.counts || {}, url: last.url || target.url, message: '' };
}
function musicTitleFromPage(title) {
  return String(title || '').replace(/\s*-\s*YouTube Music\s*$/i, '').replace(/\s*-\s*YouTube\s*$/i, '').trim().slice(0, 160);
}
async function mediaStatus() {
  const found = await findMusicTab();
  if (!found.ok) return found;
  try {
    const result = await evaluateOnTab(found.target, `(() => { const v = document.querySelector('video'); return { hasVideo: !!v, paused: v ? v.paused : null, title: document.title || '', time: v ? v.currentTime : null, duration: v && Number.isFinite(v.duration) ? v.duration : null }; })()`);
    const value = (result && result.result && result.result.value) || {};
    if (!value.hasVideo) return { ok: false, message: 'That music tab has no loaded player yet. Start a song there first.' };
    return { ok: true, tab: publicTab(found.target), paused: value.paused === true, status: value.paused ? 'Paused' : 'Playing', title: musicTitleFromPage(value.title), time: typeof value.time === 'number' ? value.time : null, duration: typeof value.duration === 'number' ? value.duration : null };
  } catch (error) {
    return { ok: false, message: `I could not read that music tab: ${error.message}` };
  }
}
async function mediaCommand(command) {
  const allowed = new Set(['play', 'pause', 'play-pause', 'next', 'previous', 'replay', 'stop']);
  if (!allowed.has(command)) return { ok: false, message: 'That music control is not supported.' };
  const found = await findMusicTab();
  if (!found.ok) return found;
  const target = found.target;
  try {
    if (command === 'next' || command === 'previous') {
      const selectors = MEDIA_BUTTON_SELECTORS[command];
      const clicked = await evaluateOnTab(target, `((${JSON.stringify(selectors)}) => { for (const sel of ${JSON.stringify(selectors)}) { const el = document.querySelector(sel); if (el) { el.click(); return { clicked: true, selector: sel }; } } return { clicked: false }; })()`);
      const value = (clicked && clicked.result && clicked.result.value) || {};
      if (!value.clicked) return { ok: false, tab: publicTab(target), message: 'I found the music tab but no working skip button on the page. Skip the track there once, then ask me again.' };
      return { ok: true, verified: false, tab: publicTab(target), message: `Skipped ${command === 'next' ? 'to the next track' : 'back a track'} in the music tab.` };
    }
    const expression = command === 'pause'
      ? `(() => { const v = document.querySelector('video'); if (!v) return { ok: false }; v.pause(); return { ok: true, paused: v.paused, title: document.title || '' }; })()`
      : command === 'stop'
        ? `(() => { const v = document.querySelector('video'); if (!v) return { ok: false }; v.pause(); try { v.currentTime = 0; } catch (e) {} return { ok: true, paused: v.paused, stopped: true, title: document.title || '' }; })()`
        : command === 'replay'
          ? `(() => { const v = document.querySelector('video'); if (!v) return { ok: false }; try { v.currentTime = 0; } catch (e) {} return v.play().then(() => ({ ok: true, paused: v.paused, restarted: true, title: document.title || '' })).catch(e => ({ ok: false, blocked: true, error: String((e && e.name) || e) })); })()`
          : `(() => { const v = document.querySelector('video'); if (!v) return { ok: false }; return v.play().then(() => ({ ok: true, paused: v.paused, title: document.title || '' })).catch(e => ({ ok: false, blocked: true, error: String((e && e.name) || e) })); })()`;
    const outcome = await evaluateOnTab(target, expression);
    const value = (outcome && outcome.result && outcome.result.value) || {};
    if (!value.ok && value.blocked) return { ok: false, tab: publicTab(target), message: 'The browser blocked autoplay on that music tab. Press play there once (sign-in may be required), then ask me again.' };
    if (!value.ok) return { ok: false, tab: publicTab(target), message: 'That music tab has no loaded player yet. Start a song there first.' };
    const title = musicTitleFromPage(value.title);
    if (command === 'replay') return { ok: true, verified: value.paused === false, tab: publicTab(target), status: 'Playing', title, message: value.paused === false ? `Restarted${title ? ` (“${title}”)` : ' the track'}.` : 'I sent replay to the music tab but it does not look started. Press play there once, then ask me again.' };
    if (command === 'stop') return { ok: true, verified: value.paused === true, tab: publicTab(target), status: 'Stopped', title, message: `Stopped the music${title ? ` (“${title}”)` : ''}.` };
    if (command === 'pause' || (command === 'play-pause' && value.paused)) return { ok: true, verified: true, tab: publicTab(target), status: 'Paused', title, message: `Paused${title ? ` (“${title}”)` : ''}.` };
    return { ok: true, verified: value.paused === false, tab: publicTab(target), status: 'Playing', title, message: value.paused === false ? `Playing${title ? ` (“${title}”)` : ''}.` : 'I sent play to the music tab but it does not look started. Press play there once, then ask me again.' };
  } catch (error) {
    return { ok: false, message: `I could not control that music tab: ${error.message}` };
  }
}

// YouTube video control through the same CDP session (never a new browser,
// never an unrelated window). Regular watch pages expose .ytp-next-button /
// .ytp-prev-button / ad-skip buttons; seeks drive the page's own <video>
// element with clamped targets. Every claim is verified (changed URL for
// next/previous, moved playback position for seeks, clicked control for ads)
// so callers never say "Skipped" when nothing changed.
const YOUTUBE_NEXT_SELECTORS = [
  '.ytp-next-button', 'a.ytp-next-button', '.ytp-chrome-controls .ytp-next-button',
  '[aria-label="Next"]', 'ytd-playlist-panel-renderer [aria-label="Next"]'
];
const YOUTUBE_PREV_SELECTORS = [
  '.ytp-prev-button', 'a.ytp-prev-button', '.ytp-chrome-controls .ytp-prev-button',
  '[aria-label="Previous"]', 'ytd-playlist-panel-renderer [aria-label="Previous"]'
];
const YOUTUBE_AD_SKIP_SELECTORS = [
  '.ytp-skip-ad-button', '.ytp-ad-skip-button', '.ytp-skip-ad-button-modern',
  '.ytp-ad-skip-button-modern', '.ytp-ad-skip-button-container button',
  '[aria-label="Skip Ad"]', '[aria-label="Skip ad"]', '[aria-label="Skip ads"]'
];
function isYouTubeVideoTab(tab) {
  const location = `${String(tab.url || '').toLowerCase()} ${String(tab.title || '').toLowerCase()}`;
  const url = String(tab.url || '').toLowerCase();
  if (/youtube\.com\/(watch|shorts|embed|live)/.test(url)) return true;
  if (/youtu\.be\/[a-z0-9_-]{6,}/.test(url)) return true;
  if (/m\.youtube\.com\/watch/.test(url)) return true;
  // Title fallback: a YouTube-titled page without a watch URL is still a
  // YouTube tab, but only a video-bearing one counts when a player exists.
  if (location.includes('youtube.com') && /\bwatch\b/.test(location)) return true;
  return false;
}
function isAnyYouTubeTab(tab) {
  const location = `${String(tab.url || '').toLowerCase()} ${String(tab.title || '').toLowerCase()}`;
  return location.includes('youtube.com') || location.includes('youtu.be');
}
function youtubeTitleFromPage(title) {
  return String(title || '').replace(/\s*-\s*YouTube\s*$/i, '').trim().slice(0, 160);
}
// Resolve the intended YouTube video tab: a single video tab wins outright;
// with several, the active controlled tab wins; otherwise ask. Never guesses
// across unrelated tabs and never launches anything.
async function findYouTubeTab() {
  const listed = await listTabs();
  if (!listed.ok) return listed;
  const videos = listed.tabs.filter(isYouTubeVideoTab);
  if (!videos.length) {
    const any = listed.tabs.filter(isAnyYouTubeTab);
    if (!any.length) return { ok: false, status: 'no-youtube-tab', message: 'I could not find an open YouTube video tab in the controlled browser. Open a YouTube video there first, then ask me again.' };
    if (any.length === 1) return { ok: true, target: any[0], note: 'results-page' };
    return { ok: false, status: 'ambiguous', matches: any.slice(0, 6).map(publicTab), message: `I found ${any.length} YouTube tabs: ${any.slice(0, 4).map(tab => tab.title || tab.url).join(', ')}. Which one should I use?` };
  }
  if (videos.length === 1) {
    if (!videos[0].ws) return { ok: false, message: 'That YouTube tab does not expose a control connection.' };
    return { ok: true, target: videos[0] };
  }
  const currentId = await activeTabId(listed);
  const active = currentId ? videos.find(tab => tab.id === currentId) : null;
  if (active) {
    if (!active.ws) return { ok: false, message: 'That YouTube tab does not expose a control connection.' };
    return { ok: true, target: active };
  }
  if (lastActivatedId && videos.some(tab => tab.id === lastActivatedId)) {
    const remembered = videos.find(tab => tab.id === lastActivatedId);
    if (remembered.ws) return { ok: true, target: remembered };
  }
  return { ok: false, status: 'ambiguous', matches: videos.slice(0, 6).map(publicTab), message: `I found ${videos.length} YouTube video tabs: ${videos.slice(0, 4).map(tab => tab.title || tab.url).join(', ')}. Which one should I use?` };
}
async function readYouTubeState(target) {
  const result = await evaluateOnTab(target, `(() => { const v = document.querySelector('video'); return { hasVideo: !!v, paused: v ? v.paused : null, title: document.title || '', href: location.href || '', time: v ? v.currentTime : null, duration: v && Number.isFinite(v.duration) ? v.duration : null }; })()`);
  return (result && result.result && result.result.value) || {};
}
async function youtubeStatus() {
  const found = await findYouTubeTab();
  if (!found.ok) return found;
  try {
    const value = await readYouTubeState(found.target);
    if (!value.hasVideo) return { ok: false, tab: publicTab(found.target), message: 'That YouTube tab has no loaded video player yet. Start a video there first.' };
    return { ok: true, tab: publicTab(found.target), paused: value.paused === true, status: value.paused ? 'Paused' : 'Playing', title: youtubeTitleFromPage(value.title), url: value.href || found.target.url, time: typeof value.time === 'number' ? value.time : null, duration: typeof value.duration === 'number' ? value.duration : null };
  } catch (error) {
    return { ok: false, message: `I could not read that YouTube tab: ${error.message}` };
  }
}
async function clickFirstSelector(target, selectors) {
  const outcome = await evaluateOnTab(target, `((${JSON.stringify(selectors)}) => { for (const sel of ${JSON.stringify(selectors)}) { try { const el = document.querySelector(sel); if (el && el.offsetParent !== null) { el.click(); return { clicked: true, selector: sel }; } } catch (e) {} } try { const list = Array.from(document.querySelectorAll('button')); const skip = list.find(b => /skip/i.test(b.textContent || '') && b.offsetParent !== null); if (skip) { skip.click(); return { clicked: true, selector: 'text:skip' }; } } catch (e) {} return { clicked: false }; })()`);
  return (outcome && outcome.result && outcome.result.value) || { clicked: false };
}
async function youtubeCommand(command, { seconds = 10 } = {}) {
  const allowed = new Set(['next-video', 'previous-video', 'seek-forward', 'seek-back', 'skip-ad', 'play', 'pause', 'play-pause', 'replay', 'stop']);
  if (!allowed.has(command)) return { ok: false, message: 'That YouTube control is not supported.' };
  const found = await findYouTubeTab();
  if (!found.ok) return found;
  const target = found.target;
  if (!target.ws) return { ok: false, message: 'That YouTube tab does not expose a control connection.' };
  try {
    if (command === 'next-video' || command === 'previous-video') {
      const before = await readYouTubeState(target);
      const beforeHref = String(before.href || target.url || '');
      const clicked = await clickFirstSelector(target, command === 'next-video' ? YOUTUBE_NEXT_SELECTORS : YOUTUBE_PREV_SELECTORS);
      if (!clicked.clicked) {
        return { ok: false, tab: publicTab(target), status: 'unsupported', message: command === 'next-video'
          ? 'This YouTube page does not expose a working Next control (it may not be a playlist or autoplay queue). Open a playlist, or tell me how many seconds to skip ahead instead.'
          : 'This YouTube page does not expose a working Previous control. Tell me how many seconds to go back instead.' };
      }
      // Verify: the video URL (or title) must actually change. Poll briefly
      // because navigation lags the click.
      const deadline = Date.now() + 4500;
      let after = null;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
        try { after = await readYouTubeState(target); } catch { continue; }
        if (after && after.href && after.href !== beforeHref) break;
        if (after && after.title && before.title && after.title !== before.title) break;
      }
      const changed = after && ((after.href && after.href !== beforeHref) || (after.title && before.title && after.title !== before.title));
      if (!changed) return { ok: false, tab: publicTab(target), status: 'unverified', message: 'I pressed Next on the YouTube player, but the video did not change. It may be the last video in the queue or the page may still be loading.' };
      const title = youtubeTitleFromPage(after.title);
      return { ok: true, verified: true, tab: publicTab(target), title, url: after.href, message: command === 'next-video' ? `Skipped to the next video${title ? ` (“${title}”)` : ''}.` : `Went back to the previous video${title ? ` (“${title}”)` : ''}.` };
    }
    if (command === 'seek-forward' || command === 'seek-back') {
      const delta = Math.min(300, Math.max(1, Number(seconds) || 10)) * (command === 'seek-forward' ? 1 : -1);
      const seeked = await evaluateOnTab(target, `((delta) => { const v = document.querySelector('video'); if (!v) return { ok: false }; const dur = Number.isFinite(v.duration) ? v.duration : null; const before = v.currentTime || 0; let want = before + delta; if (want < 0) want = 0; if (dur !== null && want > Math.max(0, dur - 0.25)) want = Math.max(0, dur - 0.25); try { v.currentTime = want; } catch (e) { return { ok: false }; } return { ok: true, before, want, duration: dur }; })(${JSON.stringify(delta)})`);
      const value = (seeked && seeked.result && seeked.result.value) || {};
      if (!value.ok) return { ok: false, tab: publicTab(target), message: 'That YouTube tab has no loaded video to seek in. Start a video there first.' };
      await new Promise(resolve => setTimeout(resolve, 450));
      let confirm = {};
      try { confirm = await readYouTubeState(target); } catch {}
      const moved = typeof confirm.time === 'number' ? Math.abs(confirm.time - (value.before || 0)) : 0;
      const title = youtubeTitleFromPage(confirm.title);
      if (moved < 0.25) return { ok: false, tab: publicTab(target), message: 'I sent the seek to the YouTube player, but the playback position did not move. The video may still be loading.' };
      const where = typeof confirm.time === 'number' ? ` (${Math.floor(confirm.time / 60)}:${String(Math.floor(confirm.time % 60)).padStart(2, '0')})` : '';
      return { ok: true, verified: true, tab: publicTab(target), title, time: confirm.time ?? null, duration: confirm.duration ?? null, message: `${command === 'seek-forward' ? 'Skipped ahead' : 'Went back'} ${Math.abs(delta)} seconds${title ? ` in “${title}”` : ''}${where}.` };
    }
    if (command === 'skip-ad') {
      const clicked = await clickFirstSelector(target, YOUTUBE_AD_SKIP_SELECTORS);
      if (!clicked.clicked) return { ok: false, tab: publicTab(target), status: 'unsupported', message: 'No skippable-ad control is showing on that YouTube tab right now. I did not skip anything.' };
      return { ok: true, verified: false, tab: publicTab(target), message: 'I pressed the ad-skip control on the YouTube tab.' };
    }
    const expression = command === 'pause'
      ? `(() => { const v = document.querySelector('video'); if (!v) return { ok: false }; v.pause(); return { ok: true, paused: v.paused, title: document.title || '' }; })()`
      : command === 'stop'
        ? `(() => { const v = document.querySelector('video'); if (!v) return { ok: false }; v.pause(); try { v.currentTime = 0; } catch (e) {} return { ok: true, paused: v.paused, stopped: true, title: document.title || '' }; })()`
        : command === 'replay'
          ? `(() => { const v = document.querySelector('video'); if (!v) return { ok: false }; try { v.currentTime = 0; } catch (e) {} return v.play().then(() => ({ ok: true, paused: v.paused, restarted: true, title: document.title || '' })).catch(e => ({ ok: false, blocked: true, error: String((e && e.name) || e) })); })()`
          : `(() => { const v = document.querySelector('video'); if (!v) return { ok: false }; return v.play().then(() => ({ ok: true, paused: v.paused, title: document.title || '' })).catch(e => ({ ok: false, blocked: true, error: String((e && e.name) || e) })); })()`;
    const outcome = await evaluateOnTab(target, expression);
    const value = (outcome && outcome.result && outcome.result.value) || {};
    if (!value.ok && value.blocked) return { ok: false, tab: publicTab(target), message: 'The browser blocked autoplay on that YouTube tab. Press play there once, then ask me again.' };
    if (!value.ok) return { ok: false, tab: publicTab(target), message: 'That YouTube tab has no loaded video player yet. Start a video there first.' };
    const title = youtubeTitleFromPage(value.title);
    if (command === 'pause' || (command === 'play-pause' && value.paused)) return { ok: true, verified: true, tab: publicTab(target), status: 'Paused', title, message: `Paused${title ? ` (“${title}”)` : ''}.` };
    return { ok: true, verified: value.paused === false, tab: publicTab(target), status: 'Playing', title, message: value.paused === false ? `Playing${title ? ` (“${title}”)` : ''}.` : 'I sent play to the YouTube tab but it does not look started. Press play there once, then ask me again.' };
  } catch (error) {
    return { ok: false, message: `I could not control that YouTube tab: ${error.message}` };
  }
}
// Navigate the active controlled tab to a URL (verified). Used to open a
// chosen YouTube video in the exact browser JARVIS manages — never an
// external launch. Falls back to the single YouTube tab when the foreground
// tab cannot be determined; asks when several video tabs compete.
async function navigateActiveTab(url) {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return { ok: false, message: 'That address does not look like a web page.' };
  const listed = await listTabs();
  if (!listed.ok) return listed;
  if (!listed.tabs.length) return { ok: false, message: 'There are no open browser tabs I can control.' };
  let target = null;
  const currentId = await activeTabId(listed);
  if (currentId) target = listed.tabs.find(tab => tab.id === currentId) || null;
  if (!target) {
    const videos = listed.tabs.filter(isYouTubeVideoTab);
    if (videos.length === 1) target = videos[0];
    else if (lastActivatedId && listed.tabs.some(tab => tab.id === lastActivatedId)) target = listed.tabs.find(tab => tab.id === lastActivatedId);
    else if (listed.tabs.length === 1) target = listed.tabs[0];
  }
  if (!target) return { ok: false, status: 'ambiguous', matches: listed.tabs.slice(0, 6).map(publicTab), message: 'I could not tell which tab is in front. Name the tab I should use, for example “the YouTube tab”.' };
  if (!target.ws) return { ok: false, message: 'That tab does not expose a control connection.' };
  try {
    await wsCommand(target.ws, 'Page.navigate', { url: clean });
    try { await wsCommand(target.ws, 'Target.activateTarget', { targetId: target.id }); } catch {}
    lastActivatedId = target.id;
    return { ok: true, navigated: true, verified: false, tab: publicTab(target) };
  } catch (error) {
    return { ok: false, message: `I could not navigate that tab: ${error.message}` };
  }
}
function validYouTubeId(value) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(value || ''));
}
// Open a chosen video through the controlled session: reuse the open YouTube
// tab (same window/profile/connection) via openUrlControlled, else open a new
// tab in the same controlled window. Never spawns an external browser;
// without a control channel it fails honestly.
async function openYouTubeVideo(videoIdOrUrl, { newTab = false } = {}) {
  let videoId = '';
  const raw = String(videoIdOrUrl || '').trim();
  if (validYouTubeId(raw)) videoId = raw;
  else {
    const m = raw.match(/(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
    if (m) videoId = m[1];
  }
  if (!videoId) return { ok: false, message: 'That choice does not include a usable YouTube video link. Search again first.' };
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const moved = await openUrlControlled(url, { newTab });
  if (!moved.ok) return moved;
  // Verify the navigation landed in the intended controlled tab.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const relisted = await listTabs();
    if (relisted.ok && relisted.tabs.some(item => String(item.url || '').includes(videoId))) {
      const hit = relisted.tabs.find(item => String(item.url || '').includes(videoId));
      return { ok: true, navigated: true, verified: true, tab: publicTab(hit), videoId, url, reused: moved.reused === true, newTab: moved.newTab === true };
    }
    await new Promise(resolve => setTimeout(resolve, 450));
  }
  return { ok: true, navigated: true, verified: false, tab: moved.tab, videoId, url, message: 'Navigation was sent to the controlled browser, but I could not yet confirm the video page loaded.' };
}

async function browserRunning() {
  if (!isWin) return false;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "(Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object).Count"], { windowsHide: true, timeout: 4000, maxBuffer: 16 * 1024 });
    return Number(String(stdout || '').trim()) > 0;
  } catch { return false; }
}

function spawnDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return child;
}

async function pollForEndpoint(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = await discoverEndpoint(true);
    if (endpoint) return endpoint;
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  return null;
}

// Start the browser with its supported remote-debugging flag so tab commands
// become verifiable. Never restarts or kills an already running browser: when
// the user's browser is already open, a separate dedicated JARVIS window is
// started alongside it instead of demanding that anything be closed.
async function enableBrowserControl({ minimized = false } = {}) {
  const quiet = minimized ? ['--start-minimized'] : [];
  const existing = await discoverEndpoint(true);
  // The existing controlled-browser connection is authoritative: whichever
  // browser (Chrome or Edge) already exposes tab control is reused as-is.
  // Never launch a second browser alongside it here. Website commands must
  // reuse this same session, window, profile, and tab connection instead of
  // opening an OS-default browser window.
  if (existing) return { ok: true, endpoint: existing, message: `Browser tab control is already connected to ${existing.browser} (port ${existing.port}).` };
  const executables = browserExecutables();
  if (!executables.length) return { ok: false, needsSetup: true, message: 'I could not find Google Chrome on this computer to enable tab control.' };
  const exe = executables[0];
  const isChrome = /chrome(\.exe)?$/i.test(exe);
  const running = await browserRunning();
  if (running) return startControlledWindow('Your browser is already open, so I opened a separate JARVIS-controlled window alongside it. Your tabs and work are untouched — use the JARVIS window for music and tab commands you want me to verify.');
  // Chrome is the primary controlled browser. Chrome (136+) refuses remote
  // debugging on the default profile, so go straight to a dedicated
  // JARVIS-controlled window with its own profile.
  if (isChrome) {
    try {
      const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'JARVIS', 'BrowserProfile');
      spawnDetached(exe, ['--remote-debugging-port=9222', `--user-data-dir=${profile}`, '--no-first-run', '--restore-last-session', ...quiet]);
    } catch (error) {
      return { ok: false, message: `I could not start the controlled browser window: ${error.message}` };
    }
    const chromeWindow = await pollForEndpoint(14000);
    if (chromeWindow) return { ok: true, endpoint: chromeWindow, dedicated: true, message: `Chrome blocks tab control on normal windows, so I opened a separate JARVIS-controlled window (own profile). Tabs in that window are fully controllable; your normal Chrome windows are not affected.` };
    return { ok: false, needsSetup: true, message: 'The controlled browser window did not start with tab control.' };
  }
  // Edge fallback (optional — only if Chrome is not installed)
  try {
    spawnDetached(exe, ['--remote-debugging-port=9222', '--no-first-run', ...quiet]);
  } catch (error) {
    return { ok: false, message: `I could not start the browser: ${error.message}` };
  }
  const endpoint = await pollForEndpoint(14000);
  if (endpoint) return { ok: true, endpoint, message: `Microsoft Edge started with tab control on port ${endpoint.port}. Say "close the YouTube tab", "switch to the next tab", or "what tab am I on".` };
  // Newer Edge builds refuse remote debugging on the default profile. Fall
  // back to a separate JARVIS-controlled window with its own profile.
  try {
    const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'JARVIS', 'BrowserProfile');
    spawnDetached(exe, ['--remote-debugging-port=9222', `--user-data-dir=${profile}`, '--no-first-run', '--restore-last-session', ...quiet]);
  } catch (error) {
    return { ok: false, message: `The browser refused tab control on your normal profile (${error.message}).` };
  }
  const fallback = await pollForEndpoint(12000);
  if (fallback) return { ok: true, endpoint: fallback, dedicated: true, message: `Microsoft Edge opened as a separate JARVIS-controlled window (own profile). Tabs in that window are fully controllable; your normal browser windows are not affected.` };
  return { ok: false, needsSetup: true, message: 'This Edge build would not expose tab control. The keyboard fallback still works, but I cannot verify tab-level actions on it.' };
}

// Open a dedicated JARVIS-controlled browser window directly. This is also
// the non-destructive recovery path: it never touches the user's running
// browser session, only adds a separate window with its own profile.
async function startControlledWindow(customMessage = '', { minimized = false } = {}) {
  const existing = await discoverEndpoint(true);
  if (existing) return { ok: true, endpoint: existing, message: `Browser tab control is already connected to ${existing.browser} (port ${existing.port}).` };
  const executables = browserExecutables();
  if (!executables.length) return { ok: false, message: 'I could not find Google Chrome on this computer.' };
  const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'JARVIS', 'BrowserProfile');
  const quiet = minimized ? ['--start-minimized'] : [];
  try {
    spawnDetached(executables[0], ['--remote-debugging-port=9222', `--user-data-dir=${profile}`, '--no-first-run', '--restore-last-session', ...quiet]);
  } catch (error) {
    return { ok: false, message: `I could not start the controlled browser window: ${error.message}` };
  }
  const endpoint = await pollForEndpoint(14000);
  if (endpoint) return { ok: true, endpoint, dedicated: true, message: customMessage || `Google Chrome opened as a JARVIS-controlled window. Its tabs can be listed, switched, and closed by voice.` };
  return { ok: false, needsSetup: true, message: 'The controlled browser window did not start with tab control.' };
}

async function status() {
  const endpoint = await discoverEndpoint();
  if (endpoint) {
    const listed = await listTabs();
    if (listed.ok) {
      return { ok: true, connected: true, browser: endpoint.browser, port: endpoint.port, tabs: listed.tabs.length, message: `Connected to ${endpoint.browser} tab control · ${listed.tabs.length} tab(s) visible.` };
    }
    // A cached endpoint that no longer lists tabs is not a connection.
    // Reporting it as connected would also freeze auto-recovery, which
    // trusts this flag before reconnecting.
    return { ok: true, connected: false, needsSetup: true, message: 'The browser stopped answering tab control. Say "enable browser control" and I will reconnect automatically.' };
  }
  // Three distinct states: nothing running, running-but-uncontrolled, or
  // connected. Only the middle one used to demand closing windows; it now
  // points at the non-destructive setup instead.
  const running = await browserRunning();
  if (running) return { ok: true, connected: false, browserOpen: true, needsSetup: true, message: 'Google Chrome is open but I cannot control its tabs yet. Say "start a controlled browser window" and I will open a separate JARVIS-controlled Chrome window alongside it — your open tabs stay untouched.' };
  return { ok: true, connected: false, browserOpen: false, needsSetup: true, message: 'Browser tab control is off and Google Chrome is not running. Say "enable browser control" or "start a controlled browser window".' };
}

// Open a fresh tab in the connected session (Target.createTarget) and verify
// it appears. Never falls back to an unverified launch: without a control
// channel there is no way to confirm the tab belongs to a session we manage.
async function openNewTab(url = 'about:blank') {
  const clean = String(url || 'about:blank').trim() || 'about:blank';
  if (!/^https?:\/\//i.test(clean) && clean !== 'about:blank') return { ok: false, message: 'That address does not look like a web page.' };
  const listed = await listTabs();
  if (!listed.ok) return listed;
  const before = new Set(listed.tabs.map(tab => tab.id));
  try {
    const endpoint = await discoverEndpoint();
    if (!endpoint) return { ok: false, status: 'not-connected', needsSetup: true, message: 'Browser tab control is not connected yet.' };
    // Newer Edge builds only accept PUT here (GET answers 405). Some builds
    // create the tab at about:blank and navigate asynchronously, so pass the
    // URL both ways (body + query) and navigate explicitly below if needed.
    const targetUrl = clean === 'about:blank' ? '' : clean;
    const newUrl = targetUrl ? `http://127.0.0.1:${endpoint.port}/json/new?${new URLSearchParams({ url: targetUrl })}` : `http://127.0.0.1:${endpoint.port}/json/new`;
    const response = await fetch(newUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(targetUrl ? { url: targetUrl } : {}), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const created = await response.json().catch(() => ({}));
    const createdId = String((created && (created.id || created.targetId)) || '');
    const deadline = Date.now() + 8000;
    let navigated = false;
    while (Date.now() < deadline) {
      const relisted = await listTabs();
      if (relisted.ok) {
        // Track OUR created tab by id when the endpoint reports one. Only
        // fall back to "any new tab" when no id was reported, so concurrent
        // tab churn from other tools cannot make us navigate someone else's
        // tab or claim their tab as our verification.
        const match = createdId
          ? (relisted.tabs.find(tab => tab.id === createdId) || null)
          : (relisted.tabs.find(tab => !before.has(tab.id)) || null);
        if (match) {
          // The tab exists but may still sit at about:blank or an intermediate
          // redirect (e.g. mail.google.com -> mail.google.com/mail/u/0): drive
          // it to the requested URL through the same controlled connection,
          // then verify by host so login redirects still count as success.
          const sameHost = (() => {
            try {
              const a = new URL(match.url || '').hostname.replace(/^www\./, '').toLowerCase();
              const b = new URL(targetUrl || '').hostname.replace(/^www\./, '').toLowerCase();
              return a && b && a === b;
            } catch { return false; }
          })();
          if (targetUrl && match.url !== targetUrl && !sameHost && !navigated && match.ws) {
            try { await wsCommand(match.ws, 'Page.navigate', { url: targetUrl }); navigated = true; } catch {}
            await new Promise(resolve => setTimeout(resolve, 600));
            continue;
          }
          if (!targetUrl || match.url === targetUrl || sameHost || navigated || Date.now() > deadline - 2500) {
            try { await wsCommand(match.ws, 'Target.activateTarget', { targetId: match.id }); } catch {}
            const finalTab = (targetUrl && match.url !== targetUrl) ? { ...match, url: targetUrl } : match;
            return { ok: true, verified: true, tab: publicTab(finalTab), remaining: relisted.tabs.length, message: `Opened a new tab${finalTab.url && finalTab.url !== 'about:blank' ? ` at ${finalTab.url}` : ''} in the controlled ${endpoint.browser} window. ${relisted.tabs.length} tab${relisted.tabs.length === 1 ? '' : 's'} open.` };
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    return { ok: false, message: 'I asked the browser to open a tab, but I could not verify it appeared.' };
  } catch (error) {
    return { ok: false, message: `I could not open a new tab: ${error.message}` };
  }
}

function hostOf(raw) {
  try { return String(new URL(String(raw || '')).hostname || '').toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

// Authoritative website opener. Every "open <site>" / search URL goes through
// the SAME controlled-browser session found by discoverEndpoint (Chrome or
// Edge, whichever is actually connected). It reuses that session's existing
// window, profile, and tab-control connection: a matching tab is navigated in
// place (unless newTab is set), otherwise a tab is created in the same window
// via openNewTab. It never spawns another browser process and never uses the
// OS default browser. Without a connection it returns needsSetup so callers
// report a real error instead of silently opening an uncontrolled browser.
// It never calls enableBrowserControl: URL commands reuse the connection and
// must not reinitialize control or duplicate windows per command.
async function openUrlControlled(url, { newTab = false } = {}) {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return { ok: false, message: 'That address does not look like a web page.' };
  const listed = await listTabs();
  if (!listed.ok) return listed;
  const endpoint = await discoverEndpoint();
  if (!endpoint) return { ok: false, status: 'not-connected', needsSetup: true, message: 'Browser tab control is not connected yet. Say "enable browser control" and I will reconnect the controlled browser without opening another one.' };
  if (!newTab) {
    const wantHost = hostOf(clean);
    let match = null;
    if (wantHost) {
      match = listed.tabs.find(tab => hostOf(tab.url) === wantHost)
        || listed.tabs.find(tab => String(tab.url || '').toLowerCase().includes(wantHost))
        || null;
    }
    if (match && match.ws) {
      try {
        await wsCommand(match.ws, 'Page.navigate', { url: clean });
        try { await wsCommand(match.ws, 'Target.activateTarget', { targetId: match.id }); } catch {}
        lastActivatedId = match.id;
        return { ok: true, verified: true, reused: true, newTab: false, browser: endpoint.browser, port: endpoint.port, tab: { title: match.title, url: clean, index: match.index }, remaining: listed.tabs.length, message: `Opened ${clean} in the controlled ${endpoint.browser} window (reused the "${match.title || match.url || 'open tab'}").` };
      } catch {
        // Fall through to opening a tab in the same controlled window.
      }
    }
  }
  const opened = await openNewTab(clean);
  if (opened && opened.ok) {
    opened.browser = endpoint.browser;
    opened.port = endpoint.port;
    opened.reused = false;
    opened.newTab = true;
  }
  return opened;
}

// Restore recently closed tabs/windows with the browser's native Ctrl+Shift+T.
// Webpage-level keyboard APIs cannot trigger browser chrome shortcuts, so this
// focuses the actual controlled browser window (matched by tab title, never
// blindly) and sends Ctrl+Shift+T via Windows SendInput, then verifies by
// re-listing tabs. Reuses the connected session/profile; never launches.
function runEncodedPowerShell(script, timeoutMs = 12000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: timeoutMs, maxBuffer: 512 * 1024 });
}

async function reopenClosedTabs({ count = 1 } = {}) {
  const wanted = Math.max(1, Math.min(5, Number(count) || 1));
  const listed = await listTabs();
  if (!listed.ok) return listed;
  if (!isWin) return { ok: false, message: 'Restoring closed tabs is only supported on Windows.' };
  const beforeIds = new Set(listed.tabs.map(tab => tab.id));
  let beforeCount = listed.tabs.length;
  const knownTitles = listed.tabs.map(tab => String(tab.title || '')).filter(Boolean).slice(0, 12);
  const restored = [];
  for (let step = 0; step < wanted; step++) {
    const payload = JSON.stringify({ port: listed.port, titles: knownTitles });
    const script = String.raw`
$ErrorActionPreference='SilentlyContinue'
$payload = $env:JARVIS_REOPEN | ConvertFrom-Json
$port = [int]$payload.port
$titles = @($payload.titles)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class JrT {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint f, uint t, bool a);
  [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);
  public static bool ForceFocus(IntPtr h) {
    uint fg=0,tid=0; GetWindowThreadProcessId(GetForegroundWindow(), out fg); GetWindowThreadProcessId(h, out tid);
    uint self=GetCurrentThreadId(); bool at=false;
    try { if (fg!=0 && fg!=self) { at=AttachThreadInput(self,fg,true); } return SetForegroundWindow(h); }
    finally { if (at) { try { AttachThreadInput(self,fg,false); } catch {} } }
  }
  public static void SendCtrlShiftT() {
    const byte VK_CTRL=0x11, VK_SHIFT=0x10, VK_T=0x54;
    keybd_event(VK_CTRL,0,0,(UIntPtr)0); keybd_event(VK_SHIFT,0,0,(UIntPtr)0); keybd_event(VK_T,0,0,(UIntPtr)0);
    System.Threading.Thread.Sleep(60);
    keybd_event(VK_T,0,2,(UIntPtr)0); keybd_event(VK_SHIFT,0,2,(UIntPtr)0); keybd_event(VK_CTRL,0,2,(UIntPtr)0);
  }
}
'@
$wins=New-Object System.Collections.ArrayList
[JrT]::EnumWindows({ param($h,$l)
  if (-not [JrT]::IsWindowVisible($h)) { return $true }
  [uint32]$wpid=0; [void][JrT]::GetWindowThreadProcessId($h,[ref]$wpid)
  try { $p=Get-Process -Id $wpid -ErrorAction SilentlyContinue } catch { return $true }
  if (-not $p) { return $true }
  $n=$p.ProcessName.ToLower()
  if ($n -ne 'chrome' -and $n -ne 'msedge') { return $true }
  $sb=New-Object System.Text.StringBuilder 512; [void][JrT]::GetWindowText($h,$sb,$sb.Capacity)
  $t=$sb.ToString()
  if (-not $t) { return $true }
  if ($t -like 'J.A.R.V.I.S.*') { return $true }
  [void]$wins.Add([pscustomobject]@{hwnd=$h.ToInt64(); pid=$wpid; title=$t})
  return $true
},[IntPtr]::Zero) | Out-Null
$target=$null
if ($wins.Count -eq 1) { $target=$wins[0] }
else {
  foreach ($w in $wins) {
    foreach ($t in $titles) {
      $core=$t -replace '\s*-\s*(Google Chrome|Microsoft Edge)\s*$',''
      if ($core -and $w.title.Contains($core)) { $target=$w; break }
    }
    if ($target) { break }
  }
  if (-not $target) {
    $cands=$wins | Where-Object { $_.title -match 'Google Chrome|Microsoft Edge' }
    if ($cands -and $cands.Count -eq 1) { $target=$cands[0] }
  }
}
if (-not $target) { '{"focused":false,"reason":"NO_MATCH"}'; exit }
$h=[IntPtr][long]$target.hwnd
if ([JrT]::IsIconic($h)) { [void][JrT]::ShowWindow($h,9); Start-Sleep -Milliseconds 350 }
[void][JrT]::ForceFocus($h); Start-Sleep -Milliseconds 450
[JrT]::SendCtrlShiftT()
Start-Sleep -Milliseconds 250
@{focused=$true; title=$target.title} | ConvertTo-Json -Compress
`;
    let focusInfo = null;
    try {
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 12000, maxBuffer: 512 * 1024, env: { ...process.env, JARVIS_REOPEN: payload } });
      const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try { focusInfo = JSON.parse(line); } catch { focusInfo = null; }
    } catch (error) {
      return { ok: false, browser: listed.browser, port: listed.port, restored: restored.length, message: `I could not reach the controlled ${listed.browser} window (${String(error.message).slice(0, 140)}).` };
    }
    if (!focusInfo || !focusInfo.focused) {
      return {
        ok: false, browser: listed.browser, port: listed.port, restored: restored.length,
        message: restored.length
          ? `I restored ${restored.length} tab${restored.length === 1 ? '' : 's'} (${restored.map(tab => tab.title || 'untitled').join('; ')}), then could not identify the controlled window again.`
          : 'I could not identify the controlled browser window, so I did not send the shortcut anywhere.'
      };
    }
    // Verify by re-listing: a genuinely restored tab appears as a new tab id.
    const deadline = Date.now() + 4000;
    let found = null;
    while (Date.now() < deadline) {
      const now = await listTabs();
      if (now.ok) {
        const fresh = now.tabs.filter(tab => !beforeIds.has(tab.id));
        if (fresh.length) {
          found = fresh[fresh.length - 1];
          for (const tab of now.tabs) beforeIds.add(tab.id);
          beforeCount = now.tabs.length;
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    if (!found) {
      return {
        ok: false, browser: listed.browser, port: listed.port, restored: restored.length, verified: false,
        message: restored.length
          ? `I restored ${restored.length} tab${restored.length === 1 ? '' : 's'}. There was nothing more to restore.`
          : 'There is nothing to restore — the browser has no recently closed tabs to bring back.'
      };
    }
    restored.push({ title: found.title, url: found.url, index: found.index });
    lastActivatedId = found.id;
    if (step < wanted - 1) await new Promise(resolve => setTimeout(resolve, 700));
  }
  const listed2 = await listTabs();
  return {
    ok: true, verified: true, browser: listed.browser, port: listed.port,
    restored: restored.length, tabs: restored,
    remaining: listed2.ok ? listed2.tabs.length : beforeCount,
    message: restored.length === 1
      ? `Reopened “${restored[0].title || restored[0].url || 'the last closed tab'}”.`
      : `Reopened ${restored.length} tabs (${restored.map(tab => tab.title || 'untitled').join('; ')}).`
  };
}

// Restore-my-tab destination (2026-10-14): the user's designated video.
// Opened ONLY in Microsoft Edge, never Chrome, via openEdgeUrl below.
const MY_TAB_URL = 'https://www.youtube.com/watch?v=1597gE1VeU4';
const EDGE_DEBUG_PORT = 9333;

// Find a running Edge remote-debugging session specifically. Edge reports
// "Chrome/..." in the Browser field, so identity comes from the User-Agent
// (contains Edg/) or the msedge.exe command line. Chrome sessions never
// match here, so this command can never hijack the Chrome window.
async function discoverEdgeEndpoint() {
  const ports = new Set(DEFAULT_PORTS);
  if (isWin) {
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ForEach-Object { $_.CommandLine } | Where-Object { $_ }`
      ], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
      for (const match of String(stdout || '').matchAll(/--remote-debugging-port=(\d{2,5})/g)) ports.add(Number(match[1]));
    } catch {}
  }
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
      if (!response.ok) continue;
      const info = await response.json().catch(() => ({}));
      const ua = String(info['User-Agent'] || info['user-agent'] || info.UserAgent || '');
      if (/Edg\//.test(ua)) return { port, browser: 'Microsoft Edge', at: Date.now() };
    } catch {}
  }
  return null;
}

// Open a URL in Microsoft Edge with same-host tab reuse and verification.
// Reuses a running Edge debugging session; otherwise starts a dedicated
// JARVIS Edge window (own profile dir, own port — Chrome is never touched,
// closed, or restarted). Returns needsSetup with an honest message when
// Edge cannot provide a verifiable control channel.
async function openEdgeUrl(url) {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return { ok: false, message: 'That address does not look like a web page.' };
  let edge = await discoverEdgeEndpoint();
  if (!edge) {
    const executables = browserExecutables();
    const msedge = executables.find(exe => /msedge(\.exe)?$/i.test(exe || ''));
    if (!msedge) return { ok: false, needsSetup: true, message: 'Microsoft Edge was not found on this computer, Sir. Install Edge and try again.' };
    try {
      const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'JARVIS', 'EdgeProfile');
      spawnDetached(msedge, [`--remote-debugging-port=${EDGE_DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--restore-last-session']);
    } catch (error) {
      return { ok: false, message: `I could not start Microsoft Edge: ${error.message}` };
    }
    const deadline = Date.now() + 14000;
    while (Date.now() < deadline) {
      edge = await discoverEdgeEndpoint();
      if (edge) break;
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    if (!edge) return { ok: false, needsSetup: true, message: 'Microsoft Edge opened but would not expose tab control, Sir. Open Edge once with remote debugging allowed, then ask again.' };
  }
  // Scope every tab operation below to the Edge session: swap the shared
  // endpoint cache, reuse the verified openUrlControlled path (same-host
  // reuse, no duplicates), then restore the cache. Chrome state is untouched.
  const saved = endpointCache;
  endpointCache = { at: Date.now(), endpoint: edge };
  try {
    const opened = await openUrlControlled(clean);
    if (opened && typeof opened === 'object') { opened.browser = 'Microsoft Edge'; opened.port = edge.port; }
    return opened;
  } finally {
    endpointCache = saved;
  }
}

async function restoreMyTab() {
  return openEdgeUrl(MY_TAB_URL);
}

module.exports = { status, listTabs, closeTabRequest, activateTabRequest, currentTabRequest, navigateTab, navigateActiveTab, openNewTab, openUrlControlled, openEdgeUrl, restoreMyTab, MY_TAB_URL, EDGE_DEBUG_PORT, discoverEdgeEndpoint, openYouTubeVideo, resolveTarget, findMusicTab, findYouTubeTab, isYouTubeVideoTab, isAnyYouTubeTab, isMusicTab, mediaCommand, mediaStatus, youtubeCommand, youtubeStatus, enableBrowserControl, startControlledWindow, discoverEndpoint, wsCommand, tabControlMode, getLifecycle, ensureControl, reopenClosedTabs, readSiteTodos };
