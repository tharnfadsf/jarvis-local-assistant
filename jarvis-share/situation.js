'use strict';
/* JARVIS Situation Engine — context-aware desktop companion brain.
 *
 * Single source of truth for the current operating context. It collects signals
 * that the app already has access to, infers a likely mode with debounce and
 * hysteresis, respects manual overrides, and notifies listeners through a small
 * event bus so other components can adapt without tight coupling.
 *
 * Signals used:
 *  - foreground application name/title
 *  - media state from the Media Orb (playing/paused/idle, capture ready/stalled)
 *  - JARVIS voice/processing state (idle/listening/thinking/speaking/executing)
 *  - window visibility (main interface visible vs minimized/hidden)
 *  - upcoming alarms/reminders
 *  - AI service availability
 *  - speech listening enabled
 *
 * Modes:
 *  general | gaming | study | music | coding | relax
 *
 * Privacy note: this engine only uses high-level signals the assistant already
 * gathers for its own operation. It does not capture screens, read window
 * contents, or record conversations to infer context.
 */

const MODES = ['general', 'gaming', 'study', 'music', 'coding', 'relax'];

const MODE_LABELS = {
  general: 'General Desktop',
  gaming: 'Gaming',
  study: 'Study',
  music: 'Music',
  coding: 'Coding',
  relax: 'Relax'
};

const DEFAULT_SETTINGS = {
  autoDetection: true,
  manualMode: false,
  manualModeValue: 'general',
  gameApps: 'steam, epic games launcher, battle.net, xbox, epic, lol, league of legends, discord overlay',
  studyApps: 'vs code, vscode, notepad++, obsidian, notion, microsoft edge, chrome, pdfxchange, zotero',
  codingApps: 'vs code, vscode, rider, intellij, visual studio, terminal, hyper, gitkraken',
  musicModeAutoOrb: true,
  gamingCompactOrb: true,
  studyQuiet: true,
  codingQuiet: true,
  relaxQuiet: false,
  autoFloatingWhenHidden: true,
  lowDistractionMode: false,
  enableNotifications: true,
  retainContextMemory: true,
  contextRetentionHours: 6
};

const APP_SIGNALS = {
  gaming: new RegExp('steam|epic games|xbox|battle.net|league of legends|lol|discord', 'i'),
  study: new RegExp('vs code|vscode|notepad\\+\\+|obsidian|notion|pdfxchange|zotero|chrome|edge|outlook', 'i'),
  coding: new RegExp('vs code|vscode|visual studio|rider|intellij|terminal|hyper|gitkraken|webstorm|pycharm|idea', 'i')
};

function clampMode(mode) {
  return MODES.includes(mode) ? mode : 'general';
}

function nowMs() {
  return Date.now();
}

function createEngine(api) {
  const listeners = [];
  const settingsKey = 'jarvis-situation-settings';
  const modeStatusKey = 'jarvis-situation-mode-status';
  const lastInferredKey = 'jarvis-situation-last-inferred';
  const pendingSwitchKey = 'jarvis-situation-pending-switch';

  let settings = loadSettings();
  let current = createEmptySituation();
  let previousMode = 'general';
  let manualOverride = false;
  let manualModeValue = 'general';
  let pendingChange = null;
  let applyTimer = 0;
  let lastInferenceAt = 0;
  let lastForegroundUpdate = 0;
  let lastComputedMode = 'general';
  let stareTimer = 0;
  let reminderTimer = 0;

  const store = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(key);
        return value == null ? fallback : value;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch { /* ignore storage failures */ }
    },
    del(key) {
      try {
        localStorage.removeItem(key);
      } catch { /* ignore storage failures */ }
    }
  };

  function loadSettings() {
    try {
      const raw = store.get(settingsKey, null);
      if (!raw) return Object.assign({}, DEFAULT_SETTINGS);
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || Array.isArray(parsed)) return Object.assign({}, DEFAULT_SETTINGS);
      const merged = Object.assign({}, DEFAULT_SETTINGS, parsed);
      merged.gameApps = String(merged.gameApps || '').trim() || DEFAULT_SETTINGS.gameApps;
      merged.studyApps = String(merged.studyApps || '').trim() || DEFAULT_SETTINGS.studyApps;
      merged.codingApps = String(merged.codingApps || '').trim() || DEFAULT_SETTINGS.codingApps;
      merged.manualModeValue = clampMode(merged.manualModeValue || 'general');
      merged.contextRetentionHours = Math.max(0.5, Math.min(72, Number(merged.contextRetentionHours) || DEFAULT_SETTINGS.contextRetentionHours));
      return merged;
    } catch {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function saveSettings() {
    try {
      store.set(settingsKey, JSON.stringify(settings));
    } catch { /* ignore */ }
  }

  function createEmptySituation() {
    return {
      mode: 'general',
      activeMode: 'automatic',
      foregroundApp: { name: '', title: '', source: 'unknown', at: 0 },
      mediaState: { visible: false, mode: 'idle', mediaActive: false, captureReady: false, stalled: false, title: '', source: '' },
      jarvisState: 'IDLE',
      windowVisible: true,
      upcoming: { alarms: [], reminders: [], activeAlarmId: '' },
      aiAvailable: false,
      speechListening: false,
      confidence: 0,
      lastUpdated: 0,
      reason: '',
      autoMode: 'general',
      effectiveMode: 'general',
      changed: false
    };
  }

  function cloneSituation(s) {
    return {
      mode: s.mode,
      activeMode: s.activeMode,
      foregroundApp: Object.assign({}, s.foregroundApp || {}),
      mediaState: Object.assign({}, s.mediaState || {}),
      jarvisState: s.jarvisState,
      windowVisible: Boolean(s.windowVisible),
      upcoming: { alarms: Array.isArray(s.upcoming?.alarms) ? s.upcoming.alarms.slice() : [], reminders: Array.isArray(s.upcoming?.reminders) ? s.upcoming.reminders.slice() : [], activeAlarmId: s.upcoming?.activeAlarmId || '' },
      aiAvailable: Boolean(s.aiAvailable),
      speechListening: Boolean(s.speechListening),
      confidence: Number(s.confidence) || 0,
      lastUpdated: s.lastUpdated,
      reason: s.reason,
      autoMode: s.autoMode || 'general',
      effectiveMode: s.effectiveMode || s.mode,
      changed: Boolean(s.changed)
    };
  }

  function refreshSettings() {
    const next = loadSettings();
    const changed = JSON.stringify(settings) !== JSON.stringify(next);
    settings = next;
    return changed;
  }

  function loadModeStatus() {
    try {
      const raw = store.get(modeStatusKey, '{}');
      const parsed = JSON.parse(raw || '{}');
      if (typeof parsed !== 'object' || Array.isArray(parsed)) return { manualOverride: false, manualModeValue: 'general' };
      return {
        manualOverride: Boolean(parsed.manualOverride),
        manualModeValue: clampMode(parsed.manualModeValue || 'general')
      };
    } catch {
      return { manualOverride: false, manualModeValue: 'general' };
    }
  }

  function saveModeStatus() {
    try {
      store.set(modeStatusKey, JSON.stringify({ manualOverride, manualModeValue }));
    } catch { /* ignore */ }
  }

  function loadLastInferred() {
    try {
      const raw = store.get(lastInferredKey, 'null');
      const parsed = JSON.parse(raw || 'null');
      if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function saveLastInferred(info) {
    try {
      store.set(lastInferredKey, JSON.stringify(Object.assign({}, info, { at: nowMs() })));
    } catch { /* ignore */ }
  }

  function inferMode(signals) {
    const fg = signals.foregroundApp;
    const appName = String(fg.name || '').trim().toLowerCase();
    const appTitle = String(fg.title || '').trim().toLowerCase();
    const combined = `${appName} ${appTitle}`;

    let scores = {
      gaming: 0,
      study: 0,
      music: 0,
      coding: 0,
      relax: 0,
      general: 1
    };

    // Foreground app heuristic.
    if (fg.source === 'windows' || fg.source === 'unknown') {
      for (const mode of Object.keys(APP_SIGNALS)) {
        if (APP_SIGNALS[mode].test(combined)) scores[mode] += 3;
      }
    }

    // Media signal.
    const media = signals.mediaState || {};
    if (media.mediaActive && !media.stalled && (media.mode === 'playing' || media.mode === 'paused')) {
      scores.music += 4;
      if (media.captureReady) scores.music += 2;
    } else if (media.mediaActive && media.stalled) {
      scores.music += 1;
    } else if (media.visible && (media.mode === 'playing' || media.mode === 'paused')) {
      scores.music += 2;
    }

    // JARVIS voice/processing signal.
    const jarvis = signals.jarvisState || 'IDLE';
    if (jarvis === 'SPEAKING') {
      // Speaking alone is ambiguous: could be music briefing, study answer, etc.
      scores.music += 1;
      scores.study += 1;
      scores.general += 1;
    } else if (jarvis === 'LISTENING') {
      scores.general += 1;
    }

    // App title hints.
    if (/music|youtube|spotify|soundcloud|deezer|audible/i.test(combined)) scores.music += 3;
    if (/homework|class|study|learn|course|lecture|reading|document|pdf|notion|obsidian|editor|code|terminal|git/i.test(combined)) scores.study += 2;
    if (/game|launcher|steam|epic|battle.net|xbox|borderlands|starfield|valorant|cs:|counter-strike|fortnite|minecraft|roblox/i.test(combined)) scores.gaming += 3;

    // Upcoming reminders/events can bias toward study/general.
    const upcoming = signals.upcoming || {};
    const reminders = Array.isArray(upcoming.reminders) ? upcoming.reminders : [];
    const alarms = Array.isArray(upcoming.alarms) ? upcoming.alarms : [];
    if (reminders.length || alarms.length) {
      scores.study += 1;
      scores.general += 1;
    }

    // Quiet modes: coding/study/relax prefer low distraction when JARVIS is
    // not currently executing something urgent.
    const executing = jarvis === 'EXECUTING' || jarvis === 'SEARCHING' || jarvis === 'THINKING';
    if (!executing) {
      scores.coding += 1;
      scores.study += 1;
      scores.relax += 1;
    }

    // Resolve.
    let top = 'general';
    let topScore = scores.general;
    for (const mode of MODES) {
      if (scores[mode] > topScore) {
        top = mode;
        topScore = scores[mode];
      }
    }

    // Confidence heuristic.
    let confidence = 0;
    if (topScore <= 1) confidence = 0.3;
    else if (topScore <= 3) confidence = 0.5;
    else if (topScore <= 5) confidence = 0.7;
    else confidence = 0.85;

    // If music is clearly active and capture is ready, prefer music unless a
    // stronger app signal exists.
    if (top !== 'music' && media.mediaActive && media.captureReady && (media.mode === 'playing' || media.mode === 'paused')) {
      if (scores.music >= 4) {
        top = 'music';
        confidence = Math.max(confidence, 0.75);
      }
    }

    return { mode: top, confidence, scores };
  }

  function shouldSwitchTo(newMode, inferred) {
    if (manualOverride) return false;
    if (!settings.autoDetection) return false;
    if (newMode === current.mode && current.activeMode === 'automatic') return false;

    const now = nowMs();
    const hysteresisMs = settings.lowDistractionMode ? 6000 : 4000;
    const lastInferred = loadLastInferred();

    // Require a minimal confidence for automatic switches.
    if (inferred.confidence < 0.6) {
      // Keep current unless this is a very strong music signal while we were
      // already in music mode.
      if (newMode === 'music' && inferred.confidence >= 0.65) {
        return true;
      }
      return false;
    }

    // Hysteresis: don't flap back to inferred mode immediately if previous
    // inference recently disagreed.
    if (lastInferred && lastInferred.at && (now - lastInferred.at) < hysteresisMs) {
      if (lastInferred.mode && lastInferred.mode !== newMode && lastInferred.confidence >= inferred.confidence) {
        return false;
      }
    }

    // Don't switch on every foreground app blip.
    if (newMode !== 'general') {
      if (!signals.foregroundApp.source || signals.foregroundApp.source === 'unknown') {
        // Unknown Windows foreground can be noisy; be conservative unless music.
        if (newMode !== 'music') return false;
      }
    }

    return true;
  }

  function computeEffectiveMode() {
    if (manualOverride) {
      current.activeMode = 'manual';
      current.mode = manualModeValue;
      current.effectiveMode = manualModeValue;
      current.reason = 'manual selection';
      return;
    }

    const signals = gatherSignals();
    const inferred = inferMode(signals);
    current.autoMode = inferred.mode;
    current.confidence = inferred.confidence;

    if (!settings.autoDetection) {
      current.mode = 'general';
      current.activeMode = 'automatic';
      current.effectiveMode = 'general';
      current.reason = 'automatic detection disabled';
      return;
    }

    if (shouldSwitchTo(inferred.mode, inferred)) {
      current.mode = inferred.mode;
      current.activeMode = 'automatic';
      current.effectiveMode = inferred.mode;
      current.reason = `detected ${MODE_LABELS[inferred.mode]?.toLowerCase() || inferred.mode} (confidence ${(inferred.confidence * 100).toFixed(0)}%)`;
      saveLastInferred({ mode: inferred.mode, confidence: inferred.confidence, scores: inferred.scores });
    } else {
      // Keep current mode but record the inferred tendency for explanations.
      current.autoMode = inferred.mode;
      current.effectiveMode = current.mode;
      current.reason = `keeping ${MODE_LABELS[current.mode]?.toLowerCase() || current.mode}; latest inference ${MODE_LABELS[inferred.mode]?.toLowerCase() || inferred.mode} (confidence ${(inferred.confidence * 100).toFixed(0)}%)`;
    }

    previousMode = current.mode;
    lastComputedMode = current.mode;
  }

  function gatherSignals() {
    return {
      foregroundApp: cloneSituation(api.getForegroundApp ? api.getForegroundApp() : {}).foregroundApp || { name: '', title: '', source: 'unknown', at: 0 },
      mediaState: api.getMediaState ? api.getMediaState() : {},
      jarvisState: api.getJarvisState ? api.getJarvisState() : 'IDLE',
      windowVisible: api.getWindowVisible ? api.getWindowVisible() : true,
      upcoming: api.getPlannerSnapshot ? (async () => await api.getPlannerSnapshot()) : Promise.resolve({ alarms: [], reminders: [], activeAlarmId: '' }),
      aiAvailable: api.getAiAvailable ? (async () => await api.getAiAvailable()) : Promise.resolve(false),
      speechListening: api.getSpeechListening ? api.getSpeechListening() : false
    };
  }

  async function recompute() {
    const signals = await gatherSignalsAsync(gatherSignals());
    current.foregroundApp = signals.foregroundApp;
    current.mediaState = signals.mediaState;
    current.jarvisState = signals.jarvisState;
    current.windowVisible = signals.windowVisible;
    current.upcoming = signals.upcoming;
    current.aiAvailable = signals.aiAvailable;
    current.speechListening = signals.speechListening;
    current.lastUpdated = nowMs();

    computeEffectiveMode();
    current.changed = (current.mode !== previousMode) || (current.activeMode !== (current.activeMode && 'manual' ? 'manual' : (settings.autoDetection ? 'automatic' : 'manual')));

    notify();
  }

  async function gatherSignalsAsync(promiseOrValue) {
    if (promiseOrValue && typeof promiseOrValue.then === 'function') {
      return await promiseOrValue;
    }
    return promiseOrValue;
  }

  async function scheduleRecompute() {
    if (applyTimer) return;
    applyTimer = setTimeout(async () => {
      applyTimer = 0;
      await recompute();
    }, 350);
  }

  async function refreshUpcoming() {
    if (!api.getPlannerSnapshot) return;
    try {
      const snapshot = await api.getPlannerSnapshot();
      current.upcoming = {
        alarms: Array.isArray(snapshot.alarms) ? snapshot.alarms.slice() : [],
        reminders: Array.isArray(snapshot.reminders) ? snapshot.reminders.slice() : [],
        activeAlarmId: snapshot.activeAlarmId || ''
      };
      current.lastUpdated = nowMs();
      notify();
    } catch { /* ignore */ }
  }

  async function refreshForeground() {
    if (!api.getForegroundApp) return;
    const next = api.getForegroundApp();
    if (next && typeof next === 'object') {
      current.foregroundApp = Object.assign({}, next);
      current.lastUpdated = nowMs();
      await scheduleRecompute();
    }
  }

  function setManualMode(mode) {
    if (!MODES.includes(mode)) mode = 'general';
    manualOverride = true;
    manualModeValue = mode;
    settings.manualMode = true;
    settings.manualModeValue = mode;
    saveSettings();
    saveModeStatus();
    current.mode = mode;
    current.activeMode = 'manual';
    current.effectiveMode = mode;
    current.reason = `manual ${MODE_LABELS[mode]?.toLowerCase() || mode}`;
    current.lastUpdated = nowMs();
    notify();
  }

  function enableAutoMode() {
    manualOverride = false;
    settings.manualMode = false;
    saveSettings();
    saveModeStatus();
    current.activeMode = 'automatic';
    current.reason = 'automatic detection enabled';
    scheduleRecompute();
    notify();
  }

  function setAutoDetectionEnabled(enabled) {
    settings.autoDetection = Boolean(enabled);
    saveSettings();
    if (!enabled && !manualOverride) {
      manualOverride = true;
      manualModeValue = current.mode;
      saveModeStatus();
      current.activeMode = 'manual';
      current.reason = 'automatic detection disabled';
      notify();
    } else {
      scheduleRecompute();
    }
    notify();
  }

  function setSettings(next) {
    if (!next || typeof next !== 'object') return;
    const merged = Object.assign({}, settings, next);
    merged.manualModeValue = clampMode(merged.manualModeValue || 'general');
    merged.gameApps = String(merged.gameApps || '').trim() || DEFAULT_SETTINGS.gameApps;
    merged.studyApps = String(merged.studyApps || '').trim() || DEFAULT_SETTINGS.studyApps;
    merged.codingApps = String(merged.codingApps || '').trim() || DEFAULT_SETTINGS.codingApps;
    merged.contextRetentionHours = Math.max(0.5, Math.min(72, Number(merged.contextRetentionHours) || DEFAULT_SETTINGS.contextRetentionHours));
    settings = merged;
    saveSettings();
    scheduleRecompute();
    notify();
  }

  function resetContext() {
    manualOverride = false;
    settings.manualMode = false;
    saveSettings();
    saveModeStatus();
    store.del(pendingSwitchKey);
    scheduleRecompute();
  }

  function onVisibilityChange() {
    const visible = api.getWindowVisible ? api.getWindowVisible() : true;
    const changed = current.windowVisible !== visible;
    current.windowVisible = visible;
    current.lastUpdated = nowMs();
    if (changed) {
      notify();
      if (!visible && settings.autoFloatingWhenHidden && settings.musicModeAutoOrb) {
        runAutomation('onHideToFloating', { reason: settings.gamingCompactOrb || settings.studyQuiet ? 'context-quiet' : 'visibility' });
      }
      if (!visible && settings.lowDistractionMode) {
        runAutomation('onEnterLowDistraction', { reason: 'visibility' });
      }
      if (visible && settings.lowDistractionMode) {
        runAutomation('onExitLowDistraction', { reason: 'visibility' });
      }
    }
  }

  function setJarvisState(state, caption) {
    const changed = current.jarvisState !== state;
    current.jarvisState = state;
    current.lastUpdated = nowMs();
    if (changed) {
      notify();
      scheduleRecompute();
    }
  }

  // Simple automation runner. Actions are deliberately limited and idempotent.
  const automationState = {
    last: { action: '', at: 0, mode: 'general' }
  };

  function runAutomation(action, context) {
    const now = nowMs();
    if ((now - automationState.last.at) < 800 && automationState.last.action === action && automationState.last.mode === current.effectiveMode) {
      return { ran: false, reason: 'debounced' };
    }

    if (action === 'onEnterMusicMode') {
      if (settings.musicModeAutoOrb) {
        try {
          const orb = (window.MusicOrb && MusicOrb);
          if (orb && typeof orb.show === 'function') orb.show(true);
          if (orb && typeof orb.updateDiagnostics === 'function' && settings.retainContextMemory) orb.debug = store.get('jarvis-orb-debug', '') === '1';
        } catch { /* ignore */ }
      }
    } else if (action === 'onEnterGamingMode') {
      if (settings.gamingCompactOrb) {
        try {
          const orb = (window.MusicOrb && MusicOrb);
          if (orb && typeof orb.show === 'function') orb.show(true);
          if (orb && typeof orb.setFloatingMode === 'function') orb.setFloatingMode(true);
          if (orb && typeof orb.setQuiet === 'function') orb.setQuiet(true);
        } catch { /* ignore */ }
      }
    } else if (action === 'onEnterStudyMode') {
      try {
        const orb = (window.MusicOrb && MusicOrb);
        if (orb && typeof orb.setQuiet === 'function') orb.setQuiet(settings.studyQuiet !== false);
      } catch { /* ignore */ }
    } else if (action === 'onEnterCodingMode') {
      try {
        const orb = (window.MusicOrb && MusicOrb);
        if (orb && typeof orb.setQuiet === 'function') orb.setQuiet(settings.codingQuiet !== false);
      } catch { /* ignore */ }
    } else if (action === 'onEnterRelaxMode') {
      try {
        const orb = (window.MusicOrb && MusicOrb);
        if (orb && typeof orb.setQuiet === 'function') orb.setQuiet(settings.relaxQuiet !== false);
      } catch { /* ignore */ }
    } else if (action === 'onEnterGeneralMode') {
      try {
        const orb = (window.MusicOrb && MusicOrb);
        if (orb && typeof orb.setQuiet === 'function') orb.setQuiet(false);
      } catch { /* ignore */ }
    } else if (action === 'onHideToFloating') {
      try {
        const orb = (window.MusicOrb && MusicOrb);
        if (orb && typeof orb.setFloatingMode === 'function') orb.setFloatingMode(true);
      } catch { /* ignore */ }
    } else if (action === 'onEnterLowDistraction') {
      // For now, keep current orb state but mark low-distraction active.
    } else if (action === 'onExitLowDistraction') {
      // Restore normal distraction level.
    }

    automationState.last = { action, at: now, mode: current.effectiveMode };
    return { ran: true };
  }

  // Reminder/approaching-event notification helper used by the main loop.
  async function checkApproachingReminders() {
    if (!settings.enableNotifications) return;
    try {
      const snapshot = await api.getPlannerSnapshot();
      const reminders = Array.isArray(snapshot.reminders) ? snapshot.reminders : [];
      const alarms = Array.isArray(snapshot.alarms) ? snapshot.alarms : [];
      const upcoming = reminders.concat(alarms).filter(item => {
        const when = Date.parse(item.when);
        return Number.isFinite(when) && when > nowMs() && when - nowMs() < 600000;
      }).sort((a, b) => Date.parse(a.when) - Date.parse(b.when));
      if (upcoming.length) {
        const next = upcoming[0];
        const kind = alarms.some(item => item.id === next.id) ? 'alarm' : 'reminder';
        const remaining = Math.round((Date.parse(next.when) - nowMs()) / 60000);
        notifyRecommendation(`${kind === 'alarm' ? 'Alarm' : 'Reminder'} due in about ${remaining} minute${remaining === 1 ? '' : 's'}: ${String(next.title || '').trim() || 'Untitled'}.`);
      }
    } catch { /* ignore */ }
  }

  function notifyRecommendation(text) {
    if (typeof window !== 'undefined' && window.notify && typeof window.notify === 'function') {
      try { window.notify.call(window, text); } catch { /* ignore */ }
    }
  }

  function notify() {
    for (let i = 0; i < listeners.length; i++) {
      try {
        listeners[i](cloneSituation(current));
      } catch { /* ignore listener errors */ }
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.push(listener);
    try { listener(cloneSituation(current)); } catch { /* ignore */ }
    return () => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  }

  async function init() {
    const status = loadModeStatus();
    manualOverride = status.manualOverride;
    manualModeValue = status.manualModeValue;
    if (manualOverride) {
      settings.manualMode = true;
      settings.manualModeValue = manualModeValue;
      saveSettings();
    }
    current.foregroundApp = api.getForegroundApp ? Object.assign({}, api.getForegroundApp()) : { name: '', title: '', source: 'unknown', at: 0 };
    await refreshUpcoming();
    await refreshForeground();
    await recompute();
  }

  async function destroy() {
    if (applyTimer) { clearTimeout(applyTimer); applyTimer = 0; }
    if (stareTimer) { clearTimeout(stareTimer); stareTimer = 0; }
    if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = 0; }
    listeners.length = 0;
  }

  // Public API.
  return {
    MODES,
    MODE_LABELS,
    DEFAULT_SETTINGS,
    init,
    destroy,
    subscribe,
    get current() { return cloneSituation(current); },
    get settings() { return Object.assign({}, settings); },
    setSettings,
    setManualMode,
    enableAutoMode,
    setAutoDetectionEnabled,
    resetContext,
    refreshUpcoming,
    refreshForeground,
    onVisibilityChange,
    setJarvisState,
    notifyRecommendation,
    checkApproachingReminders,
    recompute,
    runAutomation
  };
}

module.exports = { createEngine, DEFAULT_SETTINGS, MODES, MODE_LABELS };
