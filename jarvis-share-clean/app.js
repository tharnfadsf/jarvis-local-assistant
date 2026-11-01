(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const hero = $('#hero');
  const feed = $('#feed');
  const input = $('#textInput');
  const Core = window.JarvisCore;
  const hudThemeController = window.JarvisHudThemeCore?.createController({ select: $('#hudThemeSelect'), colorInput: $('#hudCustomColor') });
  window.JarvisHudTheme = hudThemeController || null;
  // AUTO MOOD is about the user's feeling first. Keep their detected mood on
  // the HUD for a short window so a neutral assistant reply cannot immediately
  // paint over a clear "I feel love and compassion" reading.
  let lastUserMoodAt = 0;
  function applyUserMood(value) {
    lastUserMoodAt = Date.now();
    try { window.JarvisHudTheme?.setMood(value); } catch {}
  }
  // ASSISTANT IDENTITY (2026-10-31): Spider-Man is Karen's mode and Venom is
  // the symbiote mode. The name, wake word, conversation labels and listening
  // state all follow the active theme, so switching back to any other palette
  // restores JARVIS.
  function karenMode() { return document.documentElement.dataset.theme === 'spiderman'; }
  function venomMode() { return document.documentElement.dataset.theme === 'venom'; }
  // Both named comic identities use a short, single-word wake name, so they
  // share the more sensitive wake tuning without sharing each other's names.
  function namedWakeMode() { return karenMode() || venomMode(); }
  function assistantName() { return venomMode() ? 'VENOM' : karenMode() ? 'KAREN' : 'J.A.R.V.I.S.'; }
  function wakeName() { return venomMode() ? 'Venom' : karenMode() ? 'Karen' : 'Jarvis'; }
  function wakeHint() { return `Say "${wakeName()}" before your request`; }
  // Rewrite the assistant's own name in replies/captions only; user text and
  // stored history are never touched.
  function karenify(text) {
    const value = String(text == null ? '' : text);
    if (!namedWakeMode()) return value;
    const upper = venomMode() ? 'VENOM' : 'KAREN';
    const title = venomMode() ? 'Venom' : 'Karen';
    return value.replace(/\bjarvis\b/gi, match => match === match.toUpperCase() ? upper : match[0] === match[0].toUpperCase() ? title : title.toLowerCase());
  }
  // Wake parsing with a mode gate: Karen only wakes the assistant in
  // Spider-Man mode and Venom only in Venom mode. "Jarvis" still works in
  // every mode so the user can never get stuck.
  function parseWake(transcript, options) {
    const result = Core.parseWakeTranscript(transcript, '', options);
    if (!result || !result.activated) return result;
    const matched = String(result.match || '').toLowerCase();
    const karenMatch = /karen|caren|carin|karrin|karin|karren|karon|carrin|kerrin|karens|karyn/.test(matched);
    const venomMatch = /venom|venum|vennom|venim|venem/.test(matched);
    if ((karenMatch && !karenMode()) || (venomMatch && !venomMode())) {
      return Object.assign({}, result, { activated: false, match: '', command: '', confidence: 0 });
    }
    return result;
  }
  let conversationLibrary = null;
  // Emotional conversation model (2026-10-18). IN-MEMORY ONLY: it lives for
  // this session and is cleared with the conversation, so a sensitive chat is
  // never written to disk, memory notes, or any server.
  let emotionalState = null;
  const conversationLibraryPromise = fetch('/conversation-library.json', { cache: 'no-cache' }).then(async response => {if (!response.ok) throw new Error(`Conversation library returned HTTP ${response.status}`);
    const library = await response.json();
    conversationLibrary = library;
    return library;
  }).catch(error => { console.warn('[JARVIS local conversation]', error.message); return null; });
  // Creator vocabulary (2026-10-14): editable creator-vocab.json. Loaded once;
  // searches run on raw words if it is unavailable (honest fallback, never
  // blocking). Learned overlay lives in localStorage, never in the file.
  let creatorVocabReady = false;
  const creatorVocabPromise = (Core.setCreatorVocab ? fetch('/creator-vocab.json', { cache: 'no-cache' }).then(async response => {
    if (!response.ok) throw new Error(`Creator vocabulary returned HTTP ${response.status}`);
    const data = await response.json();
    const stats = Core.setCreatorVocab(data);
    creatorVocabReady = true;
    return stats;
  }).catch(error => { console.warn('[JARVIS creator vocab]', error.message); return null; }) : Promise.resolve(null));
  function learnedCreators() {
    try {
      const raw = JSON.parse(localStorage.getItem('jarvis-creator-learned') || '[]');
      return Array.isArray(raw) ? raw.filter(e => e && e.canonical && Array.isArray(e.aliases)) : [];
    } catch { return []; }
  }
  // Growth without surprises: count unfamiliar repeated searches. At 3+
  // identical queries log a suggestion for manual review; at 5+ store a
  // low-confidence overlay entry locally (the shipped file is never
  // rewritten). Nothing is downloaded or executed.
  function trackCreatorSearch(query) {
    try {
      const key = String(query || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key || key.length < 3 || key.length > 60) return;
      const counts = JSON.parse(localStorage.getItem('jarvis-creator-candidates') || '{}');
      counts[key] = (Number(counts[key]) || 0) + 1;
      localStorage.setItem('jarvis-creator-candidates', JSON.stringify(counts));
      if (counts[key] === 3) voiceLog('creator candidate for vocabulary', `"${key}" searched 3x - consider adding it to creator-vocab.json`);
      if (counts[key] === 5) {
        const learned = learnedCreators();
        if (!learned.some(e => e.canonical.toLowerCase() === key)) {
          learned.push({ canonical: key.replace(/\b\w/g, c => c.toUpperCase()), aliases: [key], auto: true, confidence: 'low' });
          localStorage.setItem('jarvis-creator-learned', JSON.stringify(learned));
          voiceLog('creator vocabulary learned', `"${key}" added locally (low confidence) after 5 searches`);
        }
      }
    } catch {}
  }
  const recognition = { lang: 'en-US' };
  let assistantTurn = 0;
  let recognitionEnabled = false;
  let recognitionActive = false;
  let recognitionStarting = false;
  let recognitionRetryTimer = null;
  let recognitionRetryDelay = 250;
  let aiAbort = null;
  // Hard client-side deadline for one AI turn (2026-10-20). The server fails
  // over between providers on its own, but if every layer stalls the client
  // must still give up: a typed or spoken prompt could otherwise wait forever
  // with no reply and no error.
  // 2026-10-22: 120s read as "JARVIS keeps thinking forever" over voice. The
  // server already caps a stalled remote provider at 45s, and the local model
  // answers in ~18s measured, so 75s still covers a stalled remote plus a cold
  // local answer while never leaving a voice command silent for two minutes.
  const AI_TURN_DEADLINE_MS = 75000;
  let micStream = null;
  let micAnalyser = null;
  let micSamples = null;
  let micHighPassNode = null;
  let micLowPassNode = null;
  let micFrame = 0;
  let micNoise = 0.004;
  let coreVoiceEnvelope = 0;
  let coreVoiceLastUpdate = 0;
  function updateCoreVoiceVisual(level) {
    const target = Math.max(0, Math.min(1, Number(level) || 0));
    const now = performance.now();
    const delta = coreVoiceLastUpdate ? Math.min(80, now - coreVoiceLastUpdate) : 16;
    coreVoiceLastUpdate = now;
    const timeConstant = target > coreVoiceEnvelope ? 92 : 340;
    coreVoiceEnvelope += (target - coreVoiceEnvelope) * (1 - Math.exp(-delta / timeConstant));
    hero.style.setProperty('--core-ring-opacity', (0.4 + coreVoiceEnvelope * 0.38).toFixed(3));
    hero.style.setProperty('--core-ring-scale', (1 + coreVoiceEnvelope * 0.075).toFixed(3));
    hero.style.setProperty('--core-ring-glow', (4 + coreVoiceEnvelope * 20).toFixed(1) + 'px');
    hero.classList.toggle('voice-active', coreVoiceEnvelope > 0.2);
  }
  // ACTIVATION 3.0: default gate ratio 1.25 (was 1.4) so conversational-volume
// speech just above the learned room floor opens the gate; brief clicks still
// fail the sustained-onset requirement. Users with loud rooms can raise it.
const speechGate = new Core.SpeechGate({ thresholdRatio: Number(localStorage.getItem('jarvis-noise-gate') || 1.25) });
  // ================================================================
  // WAKE-WORD DETECTOR INTEGRATION (2026-10-14)
  // ================================================================
  // Path A: Core.WakeSyllableDetector runs on UNGATED audio every frame.
  // It has its own independent noise floor and template scoring for
  // "hey jarvis" envelope (duration, peaks, onset, transient gate).
  // Path B: Text fallback — after Whisper, uses parseWakeTranscript with
  // lowered threshold and openWakeWord score boost when sidecar present.
  // Both paths converge on handleWakeWordDetection() which:
  //   - Interrupts TTS if speaking
  //   - Releases busy state
  //   - Arms command-capture window
  //   - Extracts command from transcript and calls ask()
  // ================================================================
  let wakeSyllableDetector = null;
  function getWakeSyllableDetector() {
    if (!wakeSyllableDetector && Core.WakeSyllableDetector) {
      // Karen and Venom are short, quiet single-word names (no "hey" lead-in),
      // so their modes lower the envelope threshold slightly. The text layer
      // still decides whether anything executes; this only makes the bare name
      // open capture.
      const karenRelief = namedWakeMode() ? 0.07 : 0;
      const threshold = Math.max(0.3, Number(localStorage.getItem('jarvis-wake-threshold') || 0.45) - karenRelief);
      const speakThreshold = Math.max(0.36, Number(localStorage.getItem('jarvis-wake-speak-threshold') || 0.55) - karenRelief);
      // Karen and Venom are ONE short word (two quiet syllables, no "hey"
      // lead-in), so a ring that would be one burst for "hey Jarvis" is the
      // whole wake word. Requiring two consecutive scoring frames made a bare
      // name need to be repeated or said louder to register at all, which is
      // the reported bug.
      const karenTuning = namedWakeMode();
      wakeSyllableDetector = new Core.WakeSyllableDetector({
        threshold,
        speakThreshold,
        needFrames: karenTuning ? 1 : 2,
        speakNeedFrames: karenTuning ? 2 : 3,
        windowFrames: 4,
        cooldownMs: karenTuning ? 1800 : 2500,
        floorInit: 0.0025,
        ringFrames: 16,
      });
      voiceLog('wake detector', `WakeSyllableDetector initialized (threshold=${threshold}, speakThreshold=${speakThreshold}, frames=${karenTuning ? 1 : 2})`);
    }
    return wakeSyllableDetector;
  }
  // Called when either Path A (syllable detector) or Path B (text fallback)
  // confirms a wake word with sufficient confidence.
  function handleWakeWordDetection(transcript, confidence, source = 'text') {
    const mode = hero.dataset.mode;
    const speakingNow = mode === 'SPEAKING' || mode === 'INTERRUPTED';
    // 1) If JARVIS is speaking, immediately interrupt
    if (speakingNow) {
      voiceLog('wake-word interrupting speech', `mode=${mode} source=${source}`);
      assistantTurn++; aiAbort?.abort(); aiAbort = null; stopSpeech();
      addMessage('YOU', transcript);
      voiceLog('speech interrupted by wake word', transcript);
    }
    // 2) Release busy state so a new command can run
    voiceBusy = false; voiceBusyOwner = 0; voiceEpoch++;
    // 3) Clear stale voice session
    clearVoiceSession('wake-word confirmed');
    // 4) Arm the follow-up window immediately — user already said command
    const turn = ++assistantTurn;
    // Record this acknowledgement in the shared ack cooldown BEFORE speaking:
    // the same transcript continues down the correction pipeline into
    // processWakeTranscript, whose 'ack' decision would otherwise speak a
    // SECOND "Yes, Sir?" for the same wake word (the reported duplicate
    // speech). The cooldown guard in Core.decideVoiceAction needs this
    // timestamp to see the first acknowledgement.
    lastAckAt = Date.now();
    setMode('LISTENING', 'Yes, Sir? I am listening.');
    const tone = companionTone('ack');
    speak('Yes, Sir?', turn, true, tone.emotion, tone.intensity); // brief ack, then command window
    setVoiceSession({ status: 'awaiting-command', wakeDetectedAt: Date.now(), conversationActive: true, waitingFor: 'command', pendingKind: '', lastQuestion: '', expiresAt: 0 }, 'wake-acknowledged');
    // 5) Process the command part of the transcript immediately
    const wake = parseWake(transcript);
    if (wake.command && wake.command.trim()) {
      // Small delay so the ack finishes playing first
      setTimeout(() => ask(wake.command, wake.command, 'voice'), 150);
    } else if (!speakingNow) {
      // BARE-WAKE LOG FIX (2026-10-20): a wake word with NO command used to
      // vanish from the conversation feed. The interrupting branch above logs
      // only while JARVIS is speaking, a wake WITH a command is logged by
      // ask(), and processWakeTranscript's 'ack' path — which logs "YOU" for an
      // acknowledgement — is deliberately suppressed for this same transcript
      // by the lastAckAt cooldown stamped earlier in this handler (that
      // cooldown exists to stop a second "Yes, Sir?"). The handler that speaks
      // the ack therefore also owns the log entry, so "Hey JARVIS" / "wake up"
      // shows in the feed.
      addMessage('YOU', transcript);
      voiceLog('bare wake logged', transcript);
    }
  }
  let micStarting = false;
  let micStartCount = 0;
  let lastCaptureAt = 0;
  let captureGapCount = 0;
  let lastOwwScore = null;
  let lastOwwAt = 0;
  let lastMicRecoveryAt = 0;
  // PATH A ring state (revived 2026-10-14: these declarations were missing,
  // so the first tap frame threw ReferenceError and the detector never ran).
  // Short rolling pre-roll only; discarded after use, never stored or sent.
  let wakeRing = [];
  let wakeScore = null;
  let wakeFireCount = 0;
  // PLAYBACK GATE 2026-10-14: TTS-echo synchronization state. While audio
  // plays (ttsActive) or during the short post-playback tail hold, mic
  // frames never seed normal capture. Only a barge-energy latch (deliberate
  // loud speech, 2 consecutive frames) seeds an interruption-only candidate.
  let speakLevel = 0.004;
  let bargeFrames = 0;
  let listenHoldUntil = 0;
  let playbackEpoch = 0;
  let lastGateHeldLog = 0;
  function tailCooldownMs() {
    const v = Number(localStorage.getItem('jarvis-tail-cooldown') || 600);
    return Number.isFinite(v) ? Math.max(0, Math.min(3000, v)) : 600;
  }
  // ASR-FIX 2026-10-14: consecutive recognition failures distinguish a
  // one-off glitch (streak resets on success) from a wedged recognizer.
  let asrFailStreak = 0;
  let voiceFrames = 0;
  let audioProcessor = null;
  let micBoostNode = null;
  let mutedCaptureGain = null;
  let preRollFrames = [];
  let utteranceFrames = [];
  let speechSilenceMs = 0;
  let speechCandidateMs = 0;
  let speechActive = false;
  let wakeArmedUntil = 0;
  let followUpTimer = null;
  let activatedAt = 0;
  let lastHandledTranscript = { text: '', at: 0 };
  let lastAckAt = 0;
  let lastVadTrigger = null;
  // VOICE PIPELINE 2.0 state: per-utterance evidence carried from capture
  // through correction to routing, so diagnostics shows measured values and
  // no stage has to guess what an earlier stage saw.
  let lastVoiceEvidence = { micLabel: '', micDeviceId: '', captureRate: 0, channels: 0, vadState: 'idle', utteranceMs: 0, peak: 0, rms: 0, clipRatio: 0, qualityFlags: [], rawTranscript: '', normalizedTranscript: '', correctedTranscript: '', asrConfidence: null, noSpeechProb: 0, candidates: [], appliedRules: [], policy: '', policyReason: '', intent: '', entities: '', stageMs: {}, ollama: 'idle', routing: '' };
  // Cumulative pipeline counters (2026-10-14): frames seen, VAD triggers,
  // captured utterances, ASR attempts/successes/failures. Surfaced in the
  // diagnostic snapshot so "detects nothing" is attributable to a stage.
  const pipelineCounters = { frames: 0, vadTriggers: 0, utterances: 0, asrAttempts: 0, asrOk: 0, asrFail: 0, startedAt: 0 };
  let lastVoiceTimings = {};
  let lastSubmit = { text: '', at: 0 };
  // CAPTION GUARD state (2026-10-25): records the transcript most recently
  // ACCEPTED into ask() by the voice pipeline. The transcribe routine used to
  // reset the caption to 'Listening for "Jarvis"...' right after ask()'s
  // synchronous prefix set the honest 'Heard: ... - working on it...' status,
  // so a running command showed an idle HUD - the user read that as a hang and
  // killed the process. The trailing reset now yields to a routed command.
  let voiceSessionAccepted = { routing: '', at: 0 };
  // Duplicate voice-command suppression (2026-10-15): the wake-word flow can
  // submit one utterance through TWO arms — the immediate command ask
  // scheduled by handleWakeWordDetection and the ask fired by
  // processWakeTranscript after transcript correction. Both produce a fresh
  // requestId, so request-level dedup cannot see them. One bounded,
  // normalized, per-utterance record closes that hole without a global
  // cooldown: a genuinely repeated identical voice command within 3 s is
  // dropped with a log; anything else (new text, typed input, later retries)
  // is unaffected.
  let lastVoiceCommand = { text: '', at: 0 };
  // Explicit interaction state (diagnostics mirror; pendingFlow stays the
  // source of truth for workflow data). Statuses: standby, awaiting-command
  // (wake acknowledged), thinking, awaiting-answer (a question was asked),
  // speaking is read from the hero mode.
  let voiceSession = { status: 'standby', wakeDetectedAt: 0, conversationActive: false, waitingFor: '', pendingKind: '', lastQuestion: '', expiresAt: 0 };
  function setVoiceSession(patch, event) {
    Object.assign(voiceSession, patch);
    voiceLog(`voice session - ${event}`, `${voiceSession.status}${voiceSession.pendingKind ? ` - ${voiceSession.pendingKind}` : ''}${voiceSession.waitingFor ? ` - waiting: ${voiceSession.waitingFor}` : ''}`);
  }
  function clearVoiceSession(event) {
    voiceSession = { status: 'standby', wakeDetectedAt: 0, conversationActive: false, waitingFor: '', pendingKind: '', lastQuestion: '', expiresAt: 0 };
    voiceLog(`voice session - ${event}`, 'standby');
  }
  // Single-flight guards: exactly one voice command runs at a time, and every
  // captured utterance carries the epoch it was recorded in. Bumping voiceEpoch
  // (new command, barge-in, mic restart, mute) orphans queued transcriptions
  // from earlier sessions so stale callbacks can never submit commands.
  let voiceEpoch = 0;
  // The microphone session counter. It moves only when the mic itself is
  // restarted (device switch, mute/unmute), never when a wake word fires or
  // JARVIS starts speaking - those bump voiceEpoch for echo control only.
  let micSessionEpoch = 0;
  let voiceBusy = false;
  let voiceBusyOwner = 0;
  let utteranceSeq = 0;
  let pendingUtterance = null;
  // Microphone mute state: when true, no new audio is captured and all in-flight
  // transcriptions are cancelled. This is distinct from speaker mute (JARVIS not
  // speaking). The mute button toggles this state.
  let micMuted = false;
  let lastClarificationAt = 0;
  // TTS playback lifecycle, tracked from actual audio events (not timeouts).
  // Utterances overlapping playback may contain our own speech and are routed
  // by Core.decideVoiceAction with standby-only semantics.
  let ttsActive = false;
  let ttsStartedAt = 0;
  let ttsEndedAt = 0;
  let voiceErrorTimer = null;
  // ASR scheduler state (2026-10-21): one decode at a time, newest wins, and a
  // user-initiated capture never queues behind ambient room noise.
  let asrBusy = false; let asrPending = null;
  let speechAbort = null;
  let speechAudio = null;
  let currentSpeechText = '';
  let lastSpokenText = '';
  let lastSpokenAt = 0;
  let speechUrl = null;
  let audioContext = null;
  let selectedMicDeviceId = localStorage.getItem('jarvis-audio-input') || '';
  let selectedOutputDeviceId = localStorage.getItem('jarvis-audio-output') || '';
  let speechFrame = 0;
  let speakerAnalyser = null;
  let speakerSource = null;
  let speakerGain = null;
  let messageCount = 0;
  let bridgeState = false;
  let lastWebResults = [];
  let pendingEmailDraft = null;
  let pendingDiscordSend = null;
  let pendingShutdown = false;
  let pendingAlarmClarification = null; // superseded by the shared pending question (kept for diagnostics)
  let lastPlannerItemId = '';
  let memoryEntries = Core.migrateMemory(loadJson('jarvis-memory', []));
  let conversationHistory = loadJson('jarvis-conversation', []);
  // Durable archive: Clear Chat only clears the visible session. The recall
  // archive (jarvis-history), saved notes, and roll-up summaries survive so
  // memory commands keep working across sessions and screen clears.
  let durableHistory = loadJson('jarvis-history', []);
  let pendingFlow = null;
  // Voice-only mode follow-up state (2026-10-14): a pending mode question
  // accepts the next answer WITHOUT the wake word (via the existing
  // follow-up window + the resolver below). Bounded TTL so unrelated later
  // conversation is never mistaken for an answer. No GUI involved.
  let pendingQuestion = null;
  let activeMode = '';
  let modeRunToken = 0;
  let lastFileResults = [];
  // Most recent media search ("open Magnetic on YouTube"): lets "open this"
  // or "open that song" resolve to the track just discussed.
  let lastMediaQuery = null;
  // Music mode: true after a controlled YouTube Music window is successfully
  // opened. Reset when the controlled browser session closes or disconnects
  // so the status never claims music mode is active with no live window.
  let musicOpened = false;
  // YouTube Discovery ("I'm bored") context: the latest recommendation set,
  // a bounded stack of earlier sets ("go back"), recently shown video IDs so
  // "another one" never repeats, and small topic preferences (clearable).
  let lastDiscovery = null;
  let discoveryStack = [];
  let lastOpenedVideo = null;
  let recentVideoIds = loadJson('jarvis-recent-videos', []);
  if (!Array.isArray(recentVideoIds)) recentVideoIds = [];
  let discoveryPrefs = loadJson('jarvis-discovery-prefs', { topics: [] });
  if (!discoveryPrefs || typeof discoveryPrefs !== 'object' || !Array.isArray(discoveryPrefs.topics)) discoveryPrefs = { topics: [] };
  if (!Array.isArray(discoveryPrefs.recentTopics)) discoveryPrefs.recentTopics = [];
  if (!Number.isFinite(Number(discoveryPrefs.coolIndex))) discoveryPrefs.coolIndex = 0;
  let lastEventCreate = null;
  const deletingPlannerIds = new Set();
  // Recently-closed-tab context: a successful tabs-close records when it
  // happened so vague "undo that" only restores when a tab was just closed.
  // Tabs closed through CDP never enter Chrome's native closed-tab stack, so
  // the closed title+URL are also kept (bounded) as an honest fallback source.
  // Single-flight guard prevents one utterance from firing Ctrl+Shift+T twice.
  let lastTabCloseAt = 0;
  let lastClosedTabs = [];
  let reopenInFlight = false;
  // PENDING TAB ACTION (2026-10-14). When a tab request matches more than one
  // controlled tab, JARVIS asks which one. That question and its candidate
  // list must survive the next wake-word activation, the spoken clarification
  // itself, and any unrelated greeting, otherwise "close the Tick-Tack dance"
  // after "which one should I close?" is interpreted as a new, unrelated
  // request (it used to fall through to the process finder).
  // Kept alongside the existing conversation state; no second manager.
  let pendingTabAction = null;
  const PENDING_TAB_TTL_MS = 120000;
  function pendingTabActive() {
    if (!pendingTabAction) return false;
    if (Date.now() > pendingTabAction.expiresAt) { voiceLog('pending tab action expired', pendingTabAction.originalQuery || ''); pendingTabAction = null; return false; }
    return pendingTabAction.status === 'awaiting-selection';
  }
  function armPendingTabAction({ originalQuery, candidates, question }) {
    pendingTabAction = {
      intent: 'close-tab', status: 'awaiting-selection',
      candidates: (candidates || []).slice(0, 8), originalQuery: String(originalQuery || ''),
      question: String(question || ''), createdAt: Date.now(), expiresAt: Date.now() + PENDING_TAB_TTL_MS
    };
    voiceLog('pending tab action armed', `${originalQuery} - ${pendingTabAction.candidates.length} candidates`);
    return pendingTabAction;
  }
  function clearPendingTabAction(why) {
    if (!pendingTabAction) return;
    voiceLog('pending tab action cleared', `${pendingTabAction.status} - ${why}`);
    pendingTabAction = null;
  }
  let voicePreviewRow = null;
  let voicePreviewBody = null;
  // Speech playback controller: the single authority for spoken
  // responses. The dedup contract (claim/duplicate-block/release) lives in
  // Core.SpeechController (2026-10-15) so it is unit-testable outside the
  // browser; the app instantiates the single shared authority here. A new
  // response still interrupts an older one through stopSpeech(), and the
  // assistant-turn guard discards replies that arrive after a newer
  // request took over.
  const speechController = new Core.SpeechController();
  // Track screenshot preview element
  let screenshotPreviewElement = null;
  const voiceStateMachine = new Core.VoiceStateMachine((state, detail) => {
    // Map internal states onto the requested pipeline names for diagnostics.
    // The mapping stays display-only so the FSM transitions remain unchanged.
    const displayMap = {
      IDLE: 'STANDBY',
      LISTENING_FOR_WAKE_WORD: `STANDBY - LISTENING FOR ${wakeName().toUpperCase()}`,
      LISTENING_FOR_COMMAND: wakeArmedUntil && Date.now() < wakeArmedUntil
        ? (Date.now() - activatedAt < 2500 ? `ACTIVATED - LISTENING FOR ${wakeName().toUpperCase()}` : 'LISTENING FOR COMMAND')
        : `STANDBY - LISTENING FOR ${wakeName().toUpperCase()}`,
      THINKING: 'PROCESSING', SEARCHING: 'SEARCHING', EXECUTING: 'EXECUTING',
      SPEAKING: 'SPEAKING', INTERRUPTED: 'INTERRUPTED', ERROR: 'ERROR'
    };
    const stateEl = $('#voiceStateDiagnostic'); if (stateEl) stateEl.textContent = (displayMap[state] || state).replaceAll('_', ' ');
    const reasonEl = $('#wakeDiagnostic'); if (reasonEl && detail) reasonEl.textContent = detail;
  });

  function loadJson(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return Array.isArray(fallback) && !Array.isArray(value) ? fallback : (value ?? fallback); }
    catch { return fallback; }
  }

  const readout = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  function voiceLog(event, detail = '') {
    const line = `${new Date().toLocaleTimeString()} - ${event}${detail ? ` - ${detail}` : ''}`;
    console.info('[JARVIS voice]', event, detail);
    const log = $('#voiceLog');if (log) { const lines = (log.textContent ? `${log.textContent}\n` : '') + line; log.textContent = lines.split('\n').slice(-14).join('\n'); log.scrollTop = log.scrollHeight; }
  }
  // SILENT-FAILURE TRIPWIRE 2026-10-23: the follow-up bug that swallowed whole
  // spoken requests was a rejected promise inside ask() - it rejected into
  // nothing, so no log line existed anywhere and the HUD just stayed in
  // THINKING. Every unhandled rejection and uncaught error now reaches the
  // bridge log, so the next invisible failure is datable.
  window.addEventListener('unhandledrejection', event => {
    try {
      const reason = event && event.reason;
      const detail = String((reason && (reason.stack || reason.message)) || reason || 'unknown rejection');
      voiceLog('unhandled promise rejection', detail.slice(0, 300));
      routeTelemetry('page-error', { reason: `rejection: ${detail.slice(0, 110)}` });
    } catch { }
  });
  window.addEventListener('error', event => {
    try {
      const detail = `${event.message || 'error'} @ ${String(event.filename || '?').split('/').pop()}:${event.lineno || 0}`;
      voiceLog('uncaught page error', detail);
      routeTelemetry('page-error', { reason: detail.slice(0, 110) });
    } catch { }
  });
  // PUSH-TO-TALK (2026-10-20): hold-to-talk input next to the wake-word mode.
  // A press authorizes exactly ONE no-wake-word recording: capture starts from
  // the frame after press (the rolling pre-roll keeps the first syllable), the
  // release enters a short settle tail so the last syllable is never cut, and
  // the buffer is finalized exactly once per press. Wake-word standby, the
  // existing recognizer, and the single-flight command rules stay untouched.
  // State lives here (before setMode, which refreshes the PTT button) so no
  // early setMode call can hit the temporal dead zone.
  const pttCtl = { active: false, holding: false, spent: false, source: '', startedAt: 0, tailUntil: 0, framesMs: 0 };
  // Bounded hold: audio kept in memory while the user keeps holding.
  const PTT_HOLD_HARD_CAP_MS = 25000;
  // Tail after release: records trailing speech; finalizes once speech settles
  // or the tail expires, whichever comes first.
  // 450 ms: the tested compromise - long enough to keep the final syllable
  // out of the clip boundary, short enough that a release is transcribed
  // quickly (owner complaint: release-to-answer latency). 1500 ms was
  // briefly introduced without user evidence and reverts.
  const PTT_TAIL_MS = 450;
  function pttKeyFromSettings() {
    const value = String(localStorage.getItem('jarvis-ptt-key') || 'F9').trim();
    return /^[A-Za-z0-9]+$/.test(value) ? value.toUpperCase() : 'F9';
  }
  // Display form of the configured key - "KeyB" reads better as "B".
  function pttKeyLabel() {
    const code = pttKeyFromSettings();
    if (/^KEY[A-Z]$/.test(code)) return code.slice(3);
    if (/^DIGIT[0-9]$/.test(code)) return code.slice(5);
    return code;
  }
  function transitionVoice(next, detail = '') {
    try { voiceStateMachine.transition(next, detail); }
    catch (error) { voiceLog('state transition rejected', error.message); }
  }
  function listeningState() { return wakeArmedUntil && Date.now() < wakeArmedUntil ? 'LISTENING_FOR_COMMAND' : 'LISTENING_FOR_WAKE_WORD'; }
  const setTtsStatus = (text) => { readout('#ttsState', text); readout('#ttsState2', text); };
  function notify(text) {
    const el = $('#notice'); el.textContent = text; el.classList.add('show');
    clearTimeout(notify.timer); notify.timer = setTimeout(() => el.classList.remove('show'), 3200);
  }
  function setMode(mode, caption) {
    hero.dataset.mode = mode;
    window.JarvisHudTheme?.setMode(mode);
    $('#status').textContent = `* ${mode}`;if (caption) $('#caption').textContent = karenify(caption);
    const state = ({ IDLE: 'IDLE', LISTENING: listeningState(), THINKING: 'THINKING', SEARCHING: 'SEARCHING', EXECUTING: 'EXECUTING', SPEAKING: 'SPEAKING', INTERRUPTED: 'INTERRUPTED', ERROR: 'ERROR' })[mode] || 'IDLE';
    transitionVoice(state, caption || mode);if (window.Situation && typeof Situation.setJarvisState === 'function') Situation.setJarvisState(state, caption);
    // Keep the push-to-talk button in step with voice/mic availability.
    updatePttButtonState();
  }
  function addMessage(who, text, persist = true) {
    $('#empty')?.remove();
    const row = document.createElement('div'); row.className = `msg ${who === 'YOU' ? 'user' : ''}`;
    const label = document.createElement('span'); label.className = 'who';
    // Assistant rows display the active identity (KAREN in Spider-Man mode,
    // VENOM in symbiote mode). Stored history keeps the original author so a
    // theme switch re-renders it.
    label.textContent = /^(?:J\.A\.R\.V\.I\.S\.|JARVIS|KAREN|VENOM)$/i.test(String(who || '').trim()) ? assistantName() : who;
    const body = document.createElement('span'); body.textContent = text;
    row.append(label, body); feed.append(row); feed.scrollTop = feed.scrollHeight;
    messageCount++; $('#msgCount').textContent = String(messageCount).padStart(2, '0');if (persist) {
      const at = Date.now();
      conversationHistory.push({ who, text, at });
      conversationHistory = conversationHistory.slice(-40);
      localStorage.setItem('jarvis-conversation', JSON.stringify(conversationHistory));
      durableHistory.push({ who, text, at });
      if (durableHistory.length > 1200) durableHistory = durableHistory.slice(-1200);
      localStorage.setItem('jarvis-history', JSON.stringify(durableHistory));
      rollupHistoryIfNeeded();
      // Mirror the turn into the Markdown vault (Obsidian-compatible log).
      // Fire-and-forget: a vault problem can never affect the conversation.
      try { fetch('/api/vault/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who, text, at }), keepalive: true }).catch(() => {}); } catch {}
    }
  }
  // Older conversation chunks are condensed into short summaries so recall
  // keeps long-term context without unbounded storage growth.
  function rollupHistoryIfNeeded() {if (durableHistory.length < 900) return;
    const chunk = durableHistory.slice(0, 400);
    const day = new Date(chunk[0]?.at || Date.now()).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const summary = Core.summarizeMessages(chunk, day);if (summary) {
      const summaries = loadJson('jarvis-summaries', []);
      summaries.push({ at: chunk[0]?.at || Date.now(), text: summary });
      localStorage.setItem('jarvis-summaries', JSON.stringify(summaries.slice(-20)));
    }
    durableHistory = durableHistory.slice(400);
    localStorage.setItem('jarvis-history', JSON.stringify(durableHistory));
  }
  function showVoicePreview(text) {if (!voicePreviewRow) {
      $('#empty')?.remove();
      voicePreviewRow = document.createElement('div'); voicePreviewRow.className = 'msg user voice-preview';
      const label = document.createElement('span'); label.className = 'who'; label.textContent = 'YOU - LISTENING';
      voicePreviewBody = document.createElement('span'); voicePreviewBody.className = 'voice-preview-text';
      voicePreviewRow.append(label, voicePreviewBody); feed.append(voicePreviewRow);
    }
    voicePreviewBody.textContent = text; feed.scrollTop = feed.scrollHeight;
  }
  function clearVoicePreview() { voicePreviewRow?.remove(); voicePreviewRow = null; voicePreviewBody = null; }
  function clearChatLog() {if (!window.confirm('Clear this conversation from the screen? Saved personal notes and the stored history used for recall will stay.')) return;
    assistantTurn++; aiAbort?.abort(); aiAbort = null; stopSpeech(); lastWebResults = [];
    conversationHistory = []; messageCount = 0;
    localStorage.removeItem('jarvis-conversation');
    const emailDraftCard = $('#emailDraftCard');
    feed.replaceChildren();
    const empty = document.createElement('div'); empty.className = 'empty'; empty.id = 'empty';
    empty.innerHTML = 'Conversation cleared.<br>Ready when you are.';
    feed.append(empty); if (emailDraftCard) feed.append(emailDraftCard); $('#msgCount').textContent = '00';
    setMode(recognitionEnabled ? 'LISTENING' : 'IDLE', recognitionEnabled ? 'Conversation cleared. Speak naturally; I am listening.' : 'Conversation cleared. Voice standby is off.');
  }
  function addStreamingMessage() {
    $('#empty')?.remove();
    const row = document.createElement('div'); row.className = 'msg assistant streaming';
    const label = document.createElement('span'); label.className = 'who'; label.textContent = assistantName();
    const body = document.createElement('span'); body.className = 'stream-body'; body.textContent = '...';
    row.append(label, body); feed.append(row); feed.scrollTop = feed.scrollHeight;
    return { row, body };
  }
  function restoreConversation() {if (!conversationHistory.length) return;
    $('#empty')?.remove();
    for (const message of conversationHistory.slice(-40)) addMessage(message.who, message.text, false);
  }
  restoreConversation();
  function preferredName() { return localStorage.getItem('jarvis-user-name') || 'Sir'; }
  function givenName() { return localStorage.getItem('jarvis-given-name') || 'Tharn'; }
  function fullName() { return localStorage.getItem('jarvis-full-name') || 'Tharnphisit Leotphornphisit'; }
  if (!localStorage.getItem('jarvis-user-name')) localStorage.setItem('jarvis-user-name', 'Sir');
  if (!localStorage.getItem('jarvis-given-name')) localStorage.setItem('jarvis-given-name', 'Tharn');
  if (!localStorage.getItem('jarvis-full-name')) localStorage.setItem('jarvis-full-name', 'Tharnphisit Leotphornphisit');
  function saveMemories() {
    localStorage.setItem('jarvis-memory', JSON.stringify(memoryEntries.slice(-50)));
    const list = $('#memoryList');if (list) {
      list.replaceChildren();
      if (!memoryEntries.length) { const empty = document.createElement('div'); empty.className = 'memory-empty'; empty.textContent = 'No personal notes saved. Say "remember that..." to add one.'; list.append(empty); }
      for (const entry of memoryEntries.slice(-8).reverse()) { const row = document.createElement('div'); row.className = 'memory-entry'; const when = Number(entry.at) ? ` - ${new Date(entry.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''; row.textContent = entry.text + when; list.append(row); }
    }
  }
  function rememberFact(fact) {
    const result = Core.addMemoryEntry(memoryEntries, fact, Date.now());if (result.reason === 'sensitive') return { ok: false, reason: 'sensitive' };if (result.reason === 'duplicate') return { ok: true, reason: 'duplicate' };if (result.reason === 'empty') return { ok: false, reason: 'empty' };
    memoryEntries = result.list; saveMemories();
    // Mirror the saved note into the Markdown vault so it survives a wiped
    // browser profile. Fire-and-forget, and only after the sensitive-data
    // gate has already accepted the note.
    vaultMemoryRequest({ action: 'add', text: result.entry.text });
    return { ok: true, reason: null, entry: result.entry };
  }
  function forgetMemories() {
    memoryEntries = []; saveMemories();
    localStorage.removeItem('jarvis-conversation'); conversationHistory = [];
    localStorage.removeItem('jarvis-history'); durableHistory = [];
    localStorage.removeItem('jarvis-summaries');
    vaultMemoryRequest({ action: 'clear' });
  }
  // Fire-and-forget vault memory write; failures are silent by design.
  function vaultMemoryRequest(body) {
    try { fetch('/api/vault/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => {}); } catch {}
  }
  // Startup hydration (persistent memory + context restore): saved notes and
  // recent turns from the Markdown vault are merged in when localStorage is
  // empty or older. Runs after restoreConversation() and never blocks boot.
  async function hydrateFromVault() {
    try {
      const state = await fetch('/api/vault/state', { cache: 'no-store', signal: AbortSignal.timeout(4000) }).then(response => response.json()).catch(() => null);
      if (!state || !state.ok) return;
      let changed = false;
      for (const item of (Array.isArray(state.memories) ? state.memories : [])) {
        // addMemoryEntry returns { list, entry, reason } — there is NO ok
        // field; success is signalled by a non-null entry (reason stays null).
        const result = Core.addMemoryEntry(memoryEntries, item.text, Number(item.at) || Date.now());
        if (result.entry && !result.reason) { memoryEntries = result.list; changed = true; }
      }
      if (changed) saveMemories();
      if (!conversationHistory.length && Array.isArray(state.recent) && state.recent.length) {
        for (const item of state.recent.slice(-40)) {
          if (!item || !String(item.text || '').trim()) continue;
          conversationHistory.push({ who: item.who === 'YOU' ? 'YOU' : 'J.A.R.V.I.S.', text: String(item.text).slice(0, 400), at: Number(item.at) || Date.now() });
          addMessage(item.who === 'YOU' ? 'YOU' : 'J.A.R.V.I.S.', String(item.text).slice(0, 400), false);
        }
        conversationHistory = conversationHistory.slice(-40);
        localStorage.setItem('jarvis-conversation', JSON.stringify(conversationHistory));
      }
    } catch {}
  }
  hydrateFromVault();
  function addWebSources(results) {
    const usable = (results || []).filter(item => item && /^https:\/\//i.test(item.url)).slice(0, 4);if (!usable.length) return;
    const row = document.createElement('div'); row.className = 'msg web-sources';
    const heading = document.createElement('span'); heading.className = 'who'; heading.textContent = 'WEB SOURCES'; row.append(heading);
    for (const item of usable) {
      const link = document.createElement('a'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = item.title || new URL(item.url).hostname;
      const snippet = document.createElement('small'); snippet.textContent = item.snippet || '';
      const source = document.createElement('div'); source.className = 'web-source'; source.append(link, snippet); row.append(source);
    }
    feed.append(row); feed.scrollTop = feed.scrollHeight;
  }
  function showEmailDraft(draft) {
    pendingEmailDraft = { to: draft.to || '', subject: draft.subject, body: draft.body };
    localStorage.setItem('jarvis-pending-email', JSON.stringify(pendingEmailDraft));
    const card = document.createElement('section'); card.className = 'email-draft'; card.id = 'emailDraftCard';
    const title = document.createElement('strong'); title.textContent = 'EMAIL DRAFT - REVIEW REQUIRED'; card.append(title);
    const to = document.createElement('input'); to.className = 'draft-to'; to.placeholder = 'Teacher email (optional)'; to.value = pendingEmailDraft.to; to.setAttribute('aria-label', 'Recipient email'); card.append(to);
    const subject = document.createElement('input'); subject.className = 'draft-subject'; subject.value = pendingEmailDraft.subject; subject.setAttribute('aria-label', 'Email subject'); card.append(subject);
    const body = document.createElement('textarea'); body.className = 'draft-body'; body.value = pendingEmailDraft.body; body.setAttribute('aria-label', 'Email body'); card.append(body);
    const actions = document.createElement('div'); actions.className = 'draft-actions';
    const approve = document.createElement('button'); approve.className = 'chip'; approve.textContent = 'APPROVE & OPEN EMAIL';
    approve.onclick = async () => {
      approve.disabled = true;
      const result = await localAction({ action: 'email-draft', to: to.value.trim(), subject: subject.value.trim(), body: body.value.trim() });
      if (result.ok) { pendingEmailDraft = null; localStorage.removeItem('jarvis-pending-email'); card.remove(); addMessage('J.A.R.V.I.S.', 'Opened your email draft. It has not been sent; review and send it in your mail app.'); }
      else { approve.disabled = false; notify(result.message || 'I could not open the email draft.'); }
    };
    const discard = document.createElement('button'); discard.className = 'chip'; discard.textContent = 'DISCARD';
    discard.onclick = () => { pendingEmailDraft = null; localStorage.removeItem('jarvis-pending-email'); card.remove(); };
    actions.append(approve, discard); card.append(actions); feed.append(card); feed.scrollTop = feed.scrollHeight;
  }
  function restorePendingEmail() {
    const draft = loadJson('jarvis-pending-email', null);if (draft && typeof draft === 'object' && typeof draft.subject === 'string' && typeof draft.body === 'string') showEmailDraft(draft);
  }
  // Show a screenshot preview card with the captured image.
  function showScreenshotPreview(filePath, message) {
    if (screenshotPreviewElement) screenshotPreviewElement.remove();
    screenshotPreviewElement = document.createElement('section');
    screenshotPreviewElement.className = 'screenshot-preview';
    screenshotPreviewElement.style.cssText = 'margin:8px 0;padding:12px;border:1px solid #39cbe7;border-radius:8px;background:#051017;max-width:100%;box-shadow:0 4px 24px rgba(57,203,231,0.15);';
    const title = document.createElement('strong');
    title.textContent = 'SCREENSHOT CAPTURED';
    title.style.cssText = 'display:block;margin-bottom:8px;color:#39cbe7;font-size:11px;letter-spacing:.08em;';
    const img = document.createElement('img');
    img.src = 'file://' + filePath;
    img.alt = 'Screenshot preview';
    img.style.cssText = 'max-width:100%;height:auto;border:1px solid #23485b;border-radius:4px;box-shadow:0 2px 12px rgba(0,0,0,0.4);';
    img.onload = () => { img.style.opacity = '1'; };
    img.style.opacity = '0';
    img.style.transition = 'opacity 0.3s ease';
    const caption = document.createElement('div');
    caption.style.cssText = 'margin-top:8px;font:8px/1.4 Consolas,monospace;color:#9bb9c8;';
    caption.textContent = message || `Saved: ${filePath}`;
    const actions = document.createElement('div');
    actions.style.cssText = 'margin-top:8px;display:flex;gap:6px;';
    const openBtn = document.createElement('button');
    openBtn.className = 'chip';
    openBtn.textContent = 'OPEN IN EXPLORER';
    openBtn.onclick = async () => {
      const result = await localAction({ action: 'screenshot-open', name: filePath.split('\\').pop().split('/').pop() });
      notify(result.message || (result.ok ? 'Opened screenshot.' : 'Could not open screenshot.'));
    };
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'chip';
    dismissBtn.textContent = 'DISMISS';
    dismissBtn.onclick = () => { if (screenshotPreviewElement) { screenshotPreviewElement.remove(); screenshotPreviewElement = null; } };
    actions.append(openBtn, dismissBtn);
    screenshotPreviewElement.append(title, img, caption, actions);
    feed.append(screenshotPreviewElement);
    feed.scrollTop = feed.scrollHeight;
  }
  function showShutdownApproval() {
    pendingShutdown = true;
    const card = document.createElement('section'); card.className = 'shutdown-card'; card.id = 'shutdownCard';
    const message = document.createElement('strong'); message.textContent = 'SHUT DOWN THIS COMPUTER?';
    const detail = document.createElement('p'); detail.textContent = 'After confirmation, Windows will begin a 60-second shutdown countdown. Save your work first.';
    const actions = document.createElement('div'); actions.className = 'draft-actions';
    const confirmButton = document.createElement('button'); confirmButton.className = 'chip danger'; confirmButton.textContent = 'CONFIRM SHUTDOWN';
    confirmButton.onclick = async () => { confirmButton.disabled = true; const result = await localAction({ action: 'shutdown', confirmed: true }); pendingShutdown = false; card.remove(); addMessage('J.A.R.V.I.S.', result.message); };
    const cancelButton = document.createElement('button'); cancelButton.className = 'chip'; cancelButton.textContent = 'CANCEL'; cancelButton.onclick = () => { pendingShutdown = false; card.remove(); addMessage('J.A.R.V.I.S.', 'Shutdown cancelled.'); };
    actions.append(confirmButton, cancelButton); card.append(message, detail, actions); feed.append(card); feed.scrollTop = feed.scrollHeight;
  }
  async function checkBridge(timeoutMs = 2500) {
    try {
      const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
      const health = await response.json(); bridgeState = Boolean(response.ok && health.ok && health.online);
    } catch { bridgeState = false; }
    readout('#bridgeState', bridgeState ? 'HEALTHY' : 'RECONNECTING');
    readout('#bridgeState2', bridgeState ? 'HEALTHY' : 'RECONNECTING');
    readout('#bridgeDot', bridgeState ? '*' : 'o');
    return bridgeState;
  }
  // ---- Screen Vision / Computer Access helpers ----
  // Map a spoken phrase to a capture target. Unknown targets fall back to the
  // primary screen; the Range "second monitor" is display2, etc.
  function screenTargetFromText(textValue) {
    const s = String(textValue || '').toLowerCase();
    if (/\b(?:second|2nd)\s+(?:monitor|display)/.test(s)) return 'display2';
    if (/\b(?:third|3rd)\s+(?:monitor|display)/.test(s)) return 'display3';
    if (/\ball\s+(?:monitors|displays|screens)\b|\bboth\s+(?:monitors|displays|screens)\b|\bwhole desktop\b|\bentire desktop\b/.test(s)) return 'desktop';
    if (/\b(?:this|current|active|foreground)\s+window\b/.test(s)) return 'window';
    return 'screen';
  }
  // Register a pending operation that the user must approve (screen card plus
  // voice confirm). Keeps the last one only — one confirmation at a time.
  function registerPendingOp(op, summary) {
    window.__jarvisPendingOp = { ...op, summary, at: Date.now() };
    if (window.__jarvisPendingOpTimer) clearTimeout(window.__jarvisPendingOpTimer);
    window.__jarvisPendingOpTimer = setTimeout(() => { if (window.__jarvisPendingOp === op) window.__jarvisPendingOp = null; $('#computerConfirmCard')?.remove(); }, 120000);
    $('#computerConfirmCard')?.remove();
    const card = document.createElement('section'); card.className = 'card shutdown-card'; card.id = 'computerConfirmCard'; card.style.gridColumn = 'span 2';
    card.innerHTML = `<strong>PENDING OPERATION</strong><p style="margin:0;color:#b0c7d0;line-height:1.5;font-size:10px">${String(summary || 'A computer operation is waiting for your approval.')}</p><div class="draft-actions"><button class="chip" id="opConfirm">CONFIRM</button><button class="chip danger" id="opCancel">CANCEL</button></div>`;
    document.querySelector('.side').appendChild(card);
    $('#opConfirm').onclick = () => { const input = $('#textInput'); if (input) { input.value = 'confirm'; input.dispatchEvent(new Event('submit', { bubbles: true })); } window.__jarvisPendingOp = null; card.remove(); };
    $('#opCancel').onclick = () => { window.__jarvisPendingOp = null; card.remove(); };
  }
  // Compose a reply for computer-tool results, wiring pending confirmations.
  function computerActionReply(result) {
    if (!result) return 'That computer operation returned no result.';
    if (result.needsConfirmation) { registerPendingOp({ kind: 'computer', opId: result.opId }, result.summary); return result.message; }
    if (result.ok && result.message) return result.message;
    if (Array.isArray(result.items) && result.items.length) {
      addMessage('FOUND', result.items.slice(0, 10).map((item, index) => `${index + 1}. ${item.name}${item.type === 'folder' ? '/' : ''}`).join('\n'));
      return `${result.message || 'Listed.'} The items are on screen, Sir.`;
    }
    if (result.text) return `${result.name || 'The file'} says: “${String(result.text).slice(0, 400)}${result.text.length > 400 ? '…' : ''}”`;
    return result.message || (result.ok ? 'Done, Sir.' : 'That operation did not succeed.');
  }
  function describeComputerStatus(status) {
    if (!status || status.ok === false) return status?.message || 'I could not read the computer-access status.';
    if (!status.enabled) return 'Computer access is disabled. Say "Jarvis, enable computer access" or use its settings card, Sir.';
    const folders = (status.searchRoots || []).length ? (status.searchRoots || []).join(', ') : 'none available';
    return `Computer access is on. Files: ${status.allowAiFileOperations ? 'editable with confirmation' : 'read-only'}. Deletions: ${status.allowAiDeletions ? 'allowed (to the JARVIS recycle bin)' : 'blocked'}. ` +
      `Searching: ${folders}.${(status.pendingOps || []).length ? ` ${(status.pendingOps).length} operation(s) awaiting your confirmation.` : ''}`;
  }
  // ---- Webcam vision command helpers ----
  // Reveal the camera panel (created at startup, later in this file). The
  // camera itself only ever starts through an explicit CONNECT.
  window.__jarvisCameraPanel = () => {
    const panel = window.JarvisCamera?.panel;
    if (!panel) return false;
    panel.style.display = '';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return true;
  };
  // "Jarvis, connect to my webcam": the one explicit opt-in voice path.
  async function cameraConnectForCommand() {
    if (!window.JarvisCamera) return 'The camera panel is not available in this window, Sir.';
    window.__jarvisCameraPanel?.();
    const r = await window.JarvisCamera.connect();
    return r?.message || 'The camera could not be started, Sir.';
  }
  // Camera questions from the voice pipeline. Follow-ups reuse the last
  // captured frame inside its bounded window; new looks capture a fresh frame.
  async function cameraAskForCommand(question, mode, preferFollow = false) {
    if (!window.JarvisCamera) return { ok: false, message: 'The camera panel is not available in this window, Sir.' };
    window.__jarvisCameraPanel?.();
    const r = await window.JarvisCamera.ask(question, mode, preferFollow);
    return r || { ok: false, message: 'The camera did not return a result, Sir.' };
  }
  // Companion tone (2026-10-21). Wake acknowledgements and greeting replies
  // bypass the AI, so they used to be spoken with the TTS default (flat).
  // This picks a light Fish emotion by time of day with a rotating element of
  // variety: warm and awake in the morning, steady during the day, softer at
  // night (intensity 0.4 stays below the Fish cue gate by design — no laugh
  // cues on a quiet 2 a.m. "Yes, Sir?", just slightly softer prosody).
  let companionToneSeq = 0;
  function companionTone(kind = 'ack') {
    let seq = 0;
    try { seq = Number(localStorage.getItem('jarvis-companion-tone') || companionToneSeq) || 0; localStorage.setItem('jarvis-companion-tone', String(seq + 1)); companionToneSeq = seq + 1; } catch { seq = companionToneSeq++; }
    const hour = new Date().getHours();
    const night = hour >= 23 || hour < 5;
    const morning = hour >= 5 && hour < 12;
    const evening = hour >= 18 && hour < 23;
    const intensity = night ? 0.4 : 0.55;
    if (night) return { emotion: 'calm', intensity };
    const pool = kind === 'greeting'
      ? (morning ? ['happy', 'excited', 'friendly'] : evening ? ['calm', 'friendly', 'calm'] : ['friendly', 'happy', 'excited'])
      : (morning ? ['happy', 'encouraging', 'friendly'] : evening ? ['calm', 'friendly', 'confident'] : ['friendly', 'confident', 'happy']);
    return { emotion: pool[seq % pool.length], intensity };
  }
  // Wellbeing ack tone: mirrors what the user just told us, only for our own
  // canned greeting follow-up (never used to choose reply WORDING).
  function wellbeingAckTone(text = '') {
    const t = String(text || '').toLowerCase();
    if (/\b(bad|terrible|rough|awful|tiring|exhausted|stressed|sad|angry)\b/.test(t)) return { emotion: 'sympathetic', intensity: 0.55 };
    if (/\b(good|great|amazing|awesome|wonderful|happy|fantastic|pretty good)\b/.test(t)) return { emotion: 'happy', intensity: 0.55 };
    return { emotion: 'friendly', intensity: 0.55 };
  }
  // Tab commands must work without a setup sentence. When the controlled
  // browser is not connected, every tabs-* action (close, list, switch)
  // reconnects once and retries the same request instead of answering
  // "not connected yet" — that reply is what made the YouTube tab close look
  // like it had failed. One revive is shared by concurrent callers so a burst
  // of tab actions cannot spawn several browsers.
  const TAB_ACTIONS = new Set(['open-site', 'youtube-control', 'tabs-list', 'tabs-close', 'tabs-activate', 'tabs-current', 'tabs-open', 'tabs-reopen', 'restore-my-tab', 'site-todos']);
  let browserRevive = null;
  function reviveBrowserControl() {
    if (!browserRevive) {
      browserRevive = (async () => {
        try {
          const enabled = await localAction({ action: 'browser-control-enable', _retried: true });
          if (enabled && enabled.ok) return true;
          const started = await localAction({ action: 'browser-control-start-window', _retried: true });
          return Boolean(started && started.ok);
        } catch { return false; }
        finally { setTimeout(() => { browserRevive = null; }, 8000); }
      })();
    }
    return browserRevive;
  }
  async function localAction(payload) {if (payload?.action === 'discord-resolve') {
      try {
        const response = await fetch('/api/discord/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: payload.name }) });
        const result = await response.json();
        return result.ok ? { ok: true, recipient: result.recipient } : { ok: false, ...result };
      } catch (error) { return { ok: false, message: `Discord lookup failed: ${error.message}` }; }
    }if (payload?.action === 'discord-send') {
      try {
        const response = await fetch('/api/discord/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: payload.id, body: payload.body }) });
        const result = await response.json();
        return { ...result, ok: Boolean(result.ok) };
      } catch (error) { return { ok: false, message: `Discord send failed: ${error.message}` }; }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!await checkBridge()) {
if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, 450)); continue; }
        return { ok: false, message: 'The JARVIS desktop bridge is offline. Check its tray icon or restart JARVIS.' };
      }
      try {
        const response = await fetch('/api/action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(['screen-describe', 'screen-follow', 'screenshot-analyze', 'camera-follow', 'camera-analyze', 'screen-help-try'].includes(payload?.action) ? 440000 : 120000)
        });
        const result = await response.json();
if (!response.ok) result.ok = false;
        // Auto-recovery for tab control (no manual "start a controlled
        // browser" needed): reconnect once, then replay the exact request.
        if (result && result.needsSetup && !payload._retried && TAB_ACTIONS.has(String(payload.action || ''))) {
          if (await reviveBrowserControl()) {
            try {
              const retry = await fetch('/api/action', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, _retried: true }), signal: AbortSignal.timeout(120000)
              });
              const retriedResult = await retry.json();
              if (!retry.ok) retriedResult.ok = false;
              return retriedResult;
            } catch { /* fall through to the honest needsSetup reply */ }
          }
        }
        return result;
      } catch (error) {
if (attempt === 1) return { ok: false, message: error.name === 'TimeoutError' ? 'That desktop action took too long. Please try again.' : 'The JARVIS bridge connection dropped. It will reconnect automatically.' };
      }
    }
    return { ok: false, message: 'The JARVIS desktop bridge is unavailable.' };
  }
  async function plannerRequest(body) {
    try {
      const response = await fetch('/api/planner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const result = await response.json(); if (!response.ok) result.ok = false; return result;
    } catch (error) { return { ok: false, message: `The local calendar service failed: ${error.message}` }; }
  }
  async function plannerSnapshot() {
    try { return await fetch('/api/planner', { cache: 'no-store', signal: AbortSignal.timeout(5000) }).then(response => response.json()); }
    catch { return { ok: false, alarms: [], reminders: [], events: [] }; }
  }
  function formatPlannerDate(value, options = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) {
    return new Date(value).toLocaleString([], options);
  }
  async function updatePlannerCard() {
    const panel = $('#plannerNow'); if (!panel) return;
    const data = await plannerSnapshot();if (!data.ok) { panel.textContent = 'Local schedule unavailable'; return; }
    const now = Date.now();
    // Only show alarms where the scheduled time is in the future.
    // Weekdays repeating alarms have their `when` updated by the scheduler;
    // if it's in the past, it means the scheduler hasn't updated it yet
    // and we shouldn't display it as "next alarm".
    const alarm = data.alarms.filter(item => Date.parse(item.when) > now).sort((a,b)=>Date.parse(a.when)-Date.parse(b.when))[0];
    const today = new Date(); const endToday = new Date(today.getFullYear(),today.getMonth(),today.getDate()+1);
    const reminders = data.reminders.filter(item => Date.parse(item.when) > now).sort((a,b)=>Date.parse(a.when)-Date.parse(b.when)).slice(0,2);
    const events = data.events.filter(item => Date.parse(item.end) > now && Date.parse(item.start) < endToday.getTime()).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)).slice(0,3);
    panel.replaceChildren();
    const rows = [['NEXT ALARM',alarm ? `${formatPlannerDate(alarm.when)}${alarm.repeat==='weekdays'?' - weekdays':''}` : 'None'],['REMINDERS',reminders.length?reminders.map(item=>`${item.title} - ${formatPlannerDate(item.when)}`).join(' | '):'None']];
    for (const [label,value] of rows) { const row=document.createElement('div'); row.className='planner-row'; const key=document.createElement('span'); key.textContent=label; const val=document.createElement('strong'); val.textContent=value; row.append(key,val); panel.append(row); }
    // The next alarm gets its own CANCEL control (with confirm) so a stale or
    // unwanted alarm can always be removed from the card itself. Cancellation
    // targets only the displayed alarm id — never anything else.
    if (alarm) {
      const cancel = document.createElement('button'); cancel.className = 'chip'; cancel.textContent = 'CANCEL ALARM';
      cancel.style.cssText = 'margin:2px 10px 6px;align-self:start;font:7px/1 Consolas,monospace;padding:4px 6px;letter-spacing:.06em';
      cancel.onclick = async () => {
if (!window.confirm(`Cancel the alarm at ${formatPlannerDate(alarm.when)}?`)) return;
        cancel.disabled = true;
        const result = await plannerRequest({ action: 'cancel-alarm', id: alarm.id });
        notify(result.message || (result.ok ? 'Alarm cancelled.' : 'I could not cancel that alarm.'));
        updatePlannerCard();
      };
      panel.append(cancel);
    }
    // One row per event with its own DELETE control: removing a single event
    // must never fall back to deleting all events.
    const eventHead = document.createElement('div'); eventHead.className = 'planner-row';
    const eventKey = document.createElement('span'); eventKey.textContent = "TODAY'S EVENTS";
    const eventVal = document.createElement('strong'); eventVal.textContent = events.length ? `${events.length} scheduled` : 'None';
    eventHead.append(eventKey, eventVal); panel.append(eventHead);
    for (const event of events) {
      const row = document.createElement('div'); row.className = 'planner-row';
      const key = document.createElement('span'); key.textContent = String(event.title || 'Untitled event').slice(0, 42);
      const val = document.createElement('strong'); val.textContent = formatPlannerDate(event.start);
      const del = document.createElement('button'); del.className = 'chip'; del.textContent = 'DELETE';
      del.style.cssText = 'margin-left:6px;font:7px/1 Consolas,monospace;padding:3px 5px;letter-spacing:.06em';
      del.disabled = deletingPlannerIds.has(event.id);
      del.onclick = async () => {
if (deletingPlannerIds.has(event.id)) return;
if (!window.confirm(`Delete "${event.title}" at ${formatPlannerDate(event.start)}?`)) return;
        deletingPlannerIds.add(event.id); del.disabled = true;
        const result = await plannerRequest({ action: 'cancel-event', id: event.id });
        deletingPlannerIds.delete(event.id);
        notify(result.message || (result.ok ? 'Event deleted.' : 'I could not delete that event.'));
        updatePlannerCard();
      };
      const cell = document.createElement('span'); cell.append(val, del);
      row.append(key, cell); panel.append(row);
    }if (data.activeAlarmId) {
      const controls=document.createElement('div'); controls.className='music-controls';
      for (const [text,action] of [['SNOOZE 10 MIN','snooze-active'],['DISMISS','dismiss-active']]) { const button=document.createElement('button'); button.className='chip'; button.textContent=text; button.onclick=async()=>{const result=await plannerRequest({action});notify(result.message||'Alarm control sent.');updatePlannerCard();};controls.append(button); }
      panel.append(controls);
    }
  }
  // Alarm / reminder questions now arm the SHARED pending-question state
  // (Core.createPendingQuestion) instead of a single-purpose variable, so the
  // no-wake-word follow-up window opens for them exactly like it does for the
  // calendar/email/Discord flows and the voice modes. A bare "AM"/"PM", "in
  // the morning", or a fresh time phrase all resolve against the saved state.
  async function handlePlannerIntent(query) {
    const intent = Core.parsePlannerIntent(query); if (!intent) return null;
    if (intent.kind === 'clarify-alarm') {
      setPendingQuestion('alarm', 'time', intent.message, {
        intent: 'alarm', requiredField: 'time',
        conversationId: `alarm-${Date.now()}`,
        collected: { ambiguousHour: intent.hour, minute: intent.minute, date: intent.date, repeat: intent.repeat || 'none', title: intent.title || 'JARVIS alarm' },
        context: { askedFor: 'alarm time' },
        ttlMs: 5000
      });
      return intent.message;
    }
    if (intent.kind === 'clarify') {
      // "set an alarm" with no time at all: ask for the time first.
      const text = String(query || '').trim().toLowerCase();
      const isAlarm = /\balarm\b|wake me up/i.test(text);
      const isReminder = /^remind\b/i.test(text) || /\bremind me\b/i.test(text);
      if (!isAlarm && !isReminder) return intent.message;
      setPendingQuestion(isReminder ? 'reminder' : 'alarm', 'time', intent.message, {
        intent: isReminder ? 'reminder' : 'alarm', requiredField: 'time',
        conversationId: `${isReminder ? 'reminder' : 'alarm'}-${Date.now()}`,
        collected: {},
        context: { askedFor: isReminder ? 'reminder time' : 'alarm time' },
        ttlMs: 5000
      });
      return intent.message;
    }if (intent.kind === 'list-alarms') {
      const data=await plannerSnapshot(); const alarms=(data.alarms||[]).sort((a,b)=>Date.parse(a.when)-Date.parse(b.when));
      return alarms.length ? `Your alarms: ${alarms.map(item=>`${formatPlannerDate(item.when)}${item.repeat==='weekdays'?' on weekdays':''}`).join('; ')}.` : 'You have no saved alarms.';
    }if (intent.kind === 'create-alarm' || intent.kind === 'create-reminder') {
      const result=await plannerRequest({action:intent.kind,when:intent.when,repeat:intent.repeat,title:intent.title}); updatePlannerCard();
      if (!result.ok) return result.message;
      lastPlannerItemId = (result.alarm||result.reminder).id;
      const notifyHint = result.notify && result.notify.creation === 'off' ? ' Discord notifications are off   add JARVIS_DISCORD_WEBHOOK_URL to the local .env file to get creation and due alerts.' : '';
      return `${intent.kind==='create-alarm'?'Alarm':'Reminder'} saved for ${formatPlannerDate(result.alarm?.when||result.reminder?.when)}${intent.repeat==='weekdays'?' on weekdays':''}.${notifyHint}`;
    }if (intent.kind === 'snooze-alarm' || intent.kind === 'dismiss-alarm') {
      const result=await plannerRequest({action:intent.kind==='snooze-alarm'?'snooze-active':'dismiss-active'}); updatePlannerCard(); return result.message;
    }if (intent.kind === 'cancel-alarm') {
      const data=await plannerSnapshot(), queryText=intent.query.toLowerCase();
      const time=queryText.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      const matches=(data.alarms||[]).filter(item=>{
if(!time) return item.title.toLowerCase().includes(queryText);
        const d=new Date(item.when);let h=Number(time[1]);if(time[3])h=(h%12)+(time[3].toLowerCase()==='pm'?12:0);
        return d.getHours()===h&&(time[2]===undefined||d.getMinutes()===Number(time[2]));
      });
      if(matches.length!==1)return matches.length?`I found ${matches.length} alarms at that time. Please be more specific.`:'I could not find that alarm.';
      const result=await plannerRequest({action:'cancel-alarm',id:matches[0].id});updatePlannerCard();return result.message;
    }if (intent.kind === 'list-events') {
      const data=await plannerSnapshot(), today=new Date(); if(intent.day==='tomorrow')today.setDate(today.getDate()+1);
      const start=new Date(today.getFullYear(),today.getMonth(),today.getDate()).getTime(),end=start+86400000;
      const events=(data.events||[]).filter(item=>Date.parse(item.start)>=start&&Date.parse(item.start)<end).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
      return events.length?`${intent.day==='tomorrow'?'Tomorrow':'Today'}: ${events.map(item=>`${item.title} at ${formatPlannerDate(item.start,{hour:'numeric',minute:'2-digit'})}`).join('; ')}.`:`You have no ${intent.day==='tomorrow'?'events tomorrow':'events today'}.`;
    }if (intent.kind === 'events-at-time') {
      const data=await plannerSnapshot(), now=new Date();let hour=intent.hour;if(intent.meridiem)hour=(hour%12)+(intent.meridiem==='pm'?12:0);
      const matches=(data.events||[]).filter(item=>{const date=new Date(item.start);return date.getFullYear()===now.getFullYear()&&date.getMonth()===now.getMonth()&&date.getDate()===now.getDate()&&date.getHours()===hour&&date.getMinutes()===intent.minute;});
      return matches.length?`You have ${matches.map(item=>item.title).join(' and ')} at that time.`:'Nothing is scheduled at that time today.';
    }if (intent.kind === 'create-event') {
      let result=await plannerRequest({action:'create-event',title:intent.title,start:intent.start,end:intent.end,reminderMinutes:intent.reminderMinutes});
      if(result.conflict&&window.confirm(`${result.message} Create the event anyway?`))result=await plannerRequest({action:'create-event',title:intent.title,start:intent.start,end:intent.end,reminderMinutes:intent.reminderMinutes,allowConflict:true});
      updatePlannerCard(); if(result.ok)lastPlannerItemId=result.event.id;
      const notifyHint = result.notify && result.notify.creation === 'off' ? ' Discord notifications are off   add JARVIS_DISCORD_WEBHOOK_URL to the local .env file to get creation and due alerts.' : '';
      return result.ok?`${result.message} ${intent.title} is on ${formatPlannerDate(result.event.start)}.${notifyHint}`:result.message;
    }if (intent.kind === 'cancel-event-query' || intent.kind === 'move-event-query') {
      const data=await plannerSnapshot(); let matches=(data.events||[]).filter(item=>!intent.query||item.title.toLowerCase().includes(intent.query.toLowerCase()));
      if(!intent.query&&lastPlannerItemId)matches=matches.filter(item=>item.id===lastPlannerItemId);
      if(matches.length!==1)return matches.length?`I found ${matches.length} matching events. Please name the event.`:'I could not find a matching calendar event.';
      if(intent.kind==='cancel-event-query'){
if(!window.confirm(`Cancel "${matches[0].title}" on ${formatPlannerDate(matches[0].start)}?`))return 'I left the event on your calendar.';
        const result=await plannerRequest({action:'cancel-event',id:matches[0].id});updatePlannerCard();return result.message;
      }
      let newStart=intent.start;
      if(!intent.explicitDate){const target=new Date(newStart), existing=new Date(matches[0].start);existing.setHours(target.getHours(),target.getMinutes(),0,0);newStart=existing.toISOString();}
      let result=await plannerRequest({action:'move-event',id:matches[0].id,start:newStart});
      if(result.conflict&&window.confirm(`${result.message} Move the event anyway?`))result=await plannerRequest({action:'move-event',id:matches[0].id,start:newStart,allowConflict:true});
      updatePlannerCard();return result.ok?`${result.message} It now starts at ${formatPlannerDate(result.event.start)}.`:result.message;
    }
    return null;
  }
  // Structured calendar understanding via local Ollama (Asia/Bangkok).
  // AI interprets; trusted code validates and executes via plannerRequest.
  // Returns null on any AI failure so deterministic parsing stays usable.
  async function parseCalendarWithOllama(text) {
    try {
      const model = ($('#aiModel')?.value || localStorage.getItem('jarvis-ai-model') || 'qwen3:1.7b').trim() || 'qwen3:1.7b';
      const pending = (pendingFlow && pendingFlow.kind === 'calendar')
        ? { values: { title: pendingFlow.values.title || '', date: pendingFlow.values.date || '', time: pendingFlow.values.time || '' }, step: pendingFlow.step || '' }
        : null;
      let recentEvents = [];
      try {
        const snap = await plannerSnapshot();
        recentEvents = (snap.events || []).slice(-8).map(e => ({ id: e.id, title: e.title, start: e.start }));
        if (lastPlannerItemId) {
          const last = (snap.events || []).find(e => e.id === lastPlannerItemId);
          if (last && !recentEvents.some(e => e.id === last.id)) recentEvents.push({ id: last.id, title: last.title, start: last.start });
        }
      } catch {}
      const response = await fetch('/api/calendar/parse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, text: String(text || '').slice(0, 500), pending, recentEvents, timezone: 'Asia/Bangkok', nowISO: new Date().toISOString() }),
        signal: AbortSignal.timeout(32000)
      });
      const data = await response.json().catch(() => ({}));
      if (!data.ok || !data.extraction) return null;
      const validated = Core.validateCalendarExtraction(data.extraction);
      return validated.ok ? validated.data : null;
    } catch {
      return null;
    }
  }
  function resolveCalendarTarget(queryOrEmpty, events) {
    const list = Array.isArray(events) ? events : [];
    const rawQ = String(queryOrEmpty || '').trim();
    const q = rawQ.toLowerCase().replace(/^(?:the|my|that|this)\s+/i, '').trim();
    // Exact ID match first (Ollama returns IDs from recentEvents for "that event").
    if (rawQ) {
      const byId = list.find(e => String(e.id || '') === rawQ.trim());
      if (byId) return { single: byId, matches: [byId] };
    }
    if (!q || q === 'it' || q === 'that event' || q === 'this event' || q === 'the event') {
      const recent = list.find(e => e.id === lastPlannerItemId);
      if (recent) return { single: recent, matches: [recent] };
      return { single: null, matches: [] };
    }
    const matches = list.filter(e => String(e.title || '').toLowerCase().includes(q));
    if (matches.length === 1) return { single: matches[0], matches };
    return { single: null, matches };
  }
  async function handleCalendarAI(query) {
    const extraction = await parseCalendarWithOllama(query);
    if (!extraction) return null;
    // Relative adjustments always reschedule the pending/last event, even if
    // the small model mislabels them as create.
    if (/hour(s)? later|minutes? later|\bhours? earlier|\bminutes? earlier|same time next week|at that same time|an hour later/i.test(query)) {
      if (extraction.intent === 'create') extraction.intent = 'reschedule';
    }
    const intent = extraction.intent;
    if (intent === 'clarify') {
      if (extraction.missing_fields && extraction.missing_fields.length) {
        // Start or continue a pending flow with what AI already understood.
        const values = {};
        if (extraction.title) values.title = String(extraction.title).slice(0, 120);
        if (extraction.date) values.date = String(extraction.date).slice(0, 60);
        if (extraction.start_time) {
          const t = Core.parseNaturalTime(extraction.start_time);
          if (t && !t.error && !t.ambiguous) values.time = Core.formatTimeForStorage(t.hour, t.minute);
        }
        // Merge with existing pending calendar values (preserve validated fields).
        if (pendingFlow && pendingFlow.kind === 'calendar') {
          for (const k of ['title', 'date', 'time']) if (!String(values[k] || '').trim() && String(pendingFlow.values[k] || '').trim()) values[k] = pendingFlow.values[k];
        }
        const flow = Core.startPendingFlow('calendar', { values });
        if (flow && !flow.completed) {
          pendingFlow = flow;
          setVoiceSession({ status: 'awaiting-answer', conversationActive: true, waitingFor: pendingFlow.step, pendingKind: 'calendar', lastQuestion: extraction.clarification_question || pendingFlow.question, expiresAt: pendingFlow.expiresAt }, 'flow-started');
          return extraction.clarification_question || pendingFlow.question;
        }
      }
      return extraction.clarification_question || 'Could you tell me a bit more about that calendar request?';
    }
    if (intent === 'list') {
      const data = await plannerSnapshot();
      const events = (data.events || []).slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      let filtered = events;
      if (extraction.date) {
        const day = Core.parseNaturalDate(extraction.date);
        if (day) {
          const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime(), end = start + 86400000;
          filtered = events.filter(e => { const t = Date.parse(e.start); return t >= start && t < end; });
          if (!filtered.length) return `You have no events on ${day.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}.`;
          return `${day.toLocaleDateString([], { weekday: 'long' })}: ${filtered.map(e => `${e.title} at ${formatPlannerDate(e.start, { hour: 'numeric', minute: '2-digit' })}`).join('; ')}.`;
        }
      }
      const upcoming = events.filter(e => Date.parse(e.start) >= Date.now() - 60000).slice(0, 5);
      if (!upcoming.length) return 'You have no upcoming events.';
      return `Upcoming: ${upcoming.map(e => `${e.title} on ${formatPlannerDate(e.start)}`).join('; ')}.`;
    }
    if (intent === 'get_next') {
      const data = await plannerSnapshot();
      const now = Date.now();
      const events = (data.events || []).filter(e => Date.parse(e.start) >= now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      const reminders = (data.reminders || []).filter(r => Date.parse(r.when) >= now).sort((a, b) => Date.parse(a.when) - Date.parse(b.when));
      const nextEvent = events[0], nextReminder = reminders[0];
      if (/remind/i.test(query) && nextReminder) return `Your next reminder is "${nextReminder.title}" at ${formatPlannerDate(nextReminder.when)}.`;
      if (!nextEvent && !nextReminder) return 'You have nothing scheduled next.';
      if (nextEvent && (!nextReminder || Date.parse(nextEvent.start) <= Date.parse(nextReminder.when))) {
        return `Your next event is "${nextEvent.title}" on ${formatPlannerDate(nextEvent.start)}.`;
      }
      return `Your next reminder is "${nextReminder.title}" at ${formatPlannerDate(nextReminder.when)}.`;
    }
    if (intent === 'create') {
      const isReminder = /^\s*remind me\b/i.test(query) || (/\bremind(?:er)?\b/i.test(query) && !/\bevent|meeting|appointment|calendar\b/i.test(query));
      const isAlarm = /\bwake me\b|\bset (?:an? )?alarm\b/i.test(query);
      const dateStr = extraction.date || (pendingFlow?.values?.date) || 'today';
      let timeStr = extraction.start_time || (pendingFlow?.values?.time) || '';
      // Vague dayparts ("this evening", "tomorrow morning") default to a
      // sensible local time so "remind me this evening" just works instead of
      // asking again. Explicit times always win over defaults.
      if (!timeStr) {
        const hay = `${dateStr} ${query}`.toLowerCase();
        if (/\bnoon\b/.test(hay)) timeStr = '12:00 PM';
        else if (/\bevening\b|\btonight\b|\bnight\b/.test(hay)) timeStr = '7:00 PM';
        else if (/\bmorning\b/.test(hay)) timeStr = '9:00 AM';
        else if (/\bafternoon\b/.test(hay)) timeStr = '2:00 PM';
      }
      const resolved = Core.resolveCalendarDateTime(dateStr, timeStr);
      if (!resolved) {
        const values = {};
        if (extraction.title) values.title = String(extraction.title).slice(0, 120);
        if (extraction.date) values.date = String(extraction.date).slice(0, 60);
        const flow = Core.startPendingFlow('calendar', { values });
        if (flow && !flow.completed) {
          pendingFlow = flow;
          setVoiceSession({ status: 'awaiting-answer', conversationActive: true, waitingFor: pendingFlow.step, pendingKind: 'calendar', lastQuestion: pendingFlow.question, expiresAt: pendingFlow.expiresAt }, 'flow-started');
          return extraction.clarification_question || pendingFlow.question;
        }
        return extraction.clarification_question || 'What time should I schedule it, including AM or PM?';
      }
      if (resolved <= new Date()) resolved.setDate(resolved.getDate() + 1);
      const title = String(extraction.title || query.replace(/^(?:hey jarvis[, ]*)?(?:please\s+)?(?:schedule|create|add|make|set)\b/i, '').trim().slice(0, 120) || 'Meeting').trim() || 'Meeting';
      if (isAlarm) {
        const result = await plannerRequest({ action: 'create-alarm', when: resolved.toISOString(), title: 'JARVIS alarm' });
        updatePlannerCard();
        if (!result.ok) return result.message;
        lastPlannerItemId = result.alarm.id;
        return `Alarm saved for ${formatPlannerDate(result.alarm.when)}.`;
      }
      if (isReminder) {
        const result = await plannerRequest({ action: 'create-reminder', when: resolved.toISOString(), title });
        updatePlannerCard();
        if (!result.ok) return result.message;
        lastPlannerItemId = result.reminder.id;
        return `Reminder saved for ${formatPlannerDate(result.reminder.when)}.`;
      }
      const end = new Date(resolved.getTime() + (extraction.durationMinutes ? extraction.durationMinutes * 60000 : 60 * 60000));
      const signature = `${title.toLowerCase()}|${resolved.toISOString()}`;
      if (lastEventCreate && lastEventCreate.signature === signature && Date.now() - lastEventCreate.at < 15000) return lastEventCreate.message;
      setMode('EXECUTING', `Saving ${title} to your calendar`);
      let result = await plannerRequest({ action: 'create-event', title, start: resolved.toISOString(), end: end.toISOString(), reminderMinutes: extraction.reminderMinutes || 0, location: extraction.location || '' });
      if (result.conflict && window.confirm(`${result.message} Create the event anyway?`)) {
        result = await plannerRequest({ action: 'create-event', title, start: resolved.toISOString(), end: end.toISOString(), reminderMinutes: extraction.reminderMinutes || 0, location: extraction.location || '', allowConflict: true });
      }
      updatePlannerCard();
      if (!result.ok) return result.message;
      lastPlannerItemId = result.event.id;
      lastEventCreate = { signature, at: Date.now(), message: `${result.message} ${title} is on ${formatPlannerDate(result.event.start)}.` };
      return lastEventCreate.message;
    }
    if (intent === 'update' || intent === 'reschedule') {
      const data = await plannerSnapshot();
      const events = (data.events || []).slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      const targetQ = extraction.target_event || extraction.title || '';
      const resolved_target = resolveCalendarTarget(targetQ, events);
      if (!resolved_target.single) {
        return resolved_target.matches.length ? `I found ${resolved_target.matches.length} matching events. Please name the event.` : 'I could not find a matching calendar event.';
      }
      const target = resolved_target.single;
      // New time present -> move (reschedule). Preserve duration via backend.
      if (extraction.start_time || extraction.date) {
        const baseDateStr = extraction.date || new Date(target.start).toISOString().slice(0, 10);
        // If only a time was given without an explicit date ("move it to 11 AM",
        // "make it one hour later"), keep the event's current day unless the
        // text names another day. Relative phrases ("one hour later") are
        // resolved against the event's current start.
        let newStart = null;
        if (/hour(s)? later|minutes? later|earlier/i.test(query)) {
          const cur = new Date(target.start);
          const deltaMatch = query.match(/(\d+)\s*(hour|minute)/i);
          const n = deltaMatch ? Number(deltaMatch[1]) : 1;
          const isHour = /hour/i.test(query);
          const deltaMs = (isHour ? n * 3600000 : n * 60000) * (/earlier|before/i.test(query) ? -1 : 1);
          newStart = new Date(cur.getTime() + deltaMs);
          if (newStart <= new Date()) newStart = new Date(Date.now() + 3600000);
        } else {
          const hasExplicitDate = /\btoday\b|\btomorrow\b|\bday after tomorrow\b|\bnext\b|\bon\b|\bthis\b|\bmonday\b|\btuesday\b|\bwednesday\b|\bthursday\b|\bfriday\b|\bsaturday\b|\bsunday\b|\d{4}-\d{2}-\d{2}/i.test(extraction.date || query);
          if (extraction.start_time && !hasExplicitDate) {
            const t = Core.parseNaturalTime(extraction.start_time);
            if (t && !t.error && !t.ambiguous) {
              newStart = new Date(target.start);
              newStart.setHours(t.hour, t.minute, 0, 0);
              if (newStart <= new Date()) newStart.setDate(newStart.getDate() + 1);
            }
          } else {
            newStart = Core.resolveCalendarDateTime(baseDateStr, extraction.start_time || new Date(target.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
          }
        }
        if (!newStart) return extraction.clarification_question || 'What new time should I use, including AM or PM?';
        let result = await plannerRequest({ action: 'move-event', id: target.id, start: newStart.toISOString() });
        if (result.conflict && window.confirm(`${result.message} Move the event anyway?`)) {
          result = await plannerRequest({ action: 'move-event', id: target.id, start: newStart.toISOString(), allowConflict: true });
        }
        updatePlannerCard();
        return result.ok ? `${result.message} It now starts at ${formatPlannerDate(result.event.start)}.` : result.message;
      }
      // Title/location change only.
      if (extraction.title && extraction.title.toLowerCase() !== String(target.title || '').toLowerCase()) {
        const result = await plannerRequest({ action: 'update-event', id: target.id, title: extraction.title });
        updatePlannerCard();
        return result.ok ? `Updated to "${result.event.title}" on ${formatPlannerDate(result.event.start)}.` : result.message;
      }
      return extraction.clarification_question || 'What change should I make to that event?';
    }
    if (intent === 'cancel') {
      const data = await plannerSnapshot();
      const events = (data.events || []).slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      const targetQ = extraction.target_event || '';
      const resolved_target = resolveCalendarTarget(targetQ, events);
      if (!resolved_target.single) {
        return resolved_target.matches.length ? `I found ${resolved_target.matches.length} matching events. Please name the event.` : 'I could not find a matching calendar event.';
      }
      const target = resolved_target.single;
      if (!window.confirm(`Cancel "${target.title}" on ${formatPlannerDate(target.start)}?`)) return 'I left the event on your calendar.';
      const result = await plannerRequest({ action: 'cancel-event', id: target.id });
      updatePlannerCard();
      return result.message;
    }
    return null;
  }
  async function searchOnline(query) {
    setMode('SEARCHING', `Searching Google for ${query}`);
    const result = await localAction({ action: 'search-web', query });if (!result.ok) return result.message || 'I could not search the web right now.';
    lastWebResults = result.results || [];
    return result.summary || `I opened Google results for "${query}".`;
  }
  function createAbsenceDraft(request) {
    const topic = request.match(/\b(?:about|regarding|for)\s+(.+)$/i)?.[1]?.trim() || 'my absence';
    const isAbsence = /absen|sick|miss(?:ed|ing)? class|not (?:be able to )?attend/i.test(topic);
    showEmailDraft({
      to: '', subject: isAbsence ? 'Apology for My Absence' : `Regarding ${topic}`,
      body: isAbsence
        ? `Dear Teacher,\n\nI apologize for being absent from class. I was unable to attend and will make sure to catch up on any lessons or assignments I missed. Please let me know if there is anything I should complete.\n\nThank you for your understanding.\n\nSincerely,\n${fullName()}`
        : `Dear Teacher,\n\nI am writing regarding ${topic}.\n\nThank you for your time and understanding.\n\nSincerely,\n${fullName()}`
    });
  }
  // Map intent categories to default emotions for local responses
  const LOCAL_REPLY_EMOTIONS = {
    greeting: 'friendly',
    farewell: 'friendly',
    thanks: 'friendly',
    mood_positive: 'friendly',
    mood_negative: 'sympathetic',
    mood_okay: 'neutral',
    joke: 'amused',
    compliment: 'friendly',
    insult: 'dryly_humorous',
    who_are_you: 'confident',
    what_can_you_do: 'helpful',
    app_open_success: 'confident',
    music_search: 'curious',
    app_location: 'helpful',
    shutdown: 'serious',
    cancel_shutdown: 'reassuring',
    time_query: 'neutral',
    date_query: 'neutral',
    email_draft: 'helpful',
    file_search: 'helpful',
    screen_describe: 'thoughtful',
    system_status: 'confident'
  };
  function chooseLocalReply(intentId, variables = {}) {
    const recent = loadJson('jarvis-recent-local-replies', []);
    const response = Core.chooseConversationResponse(conversationLibrary, intentId, recent, Math.random, variables);
    if (response) { recent.push(response); localStorage.setItem('jarvis-recent-local-replies', JSON.stringify(recent.slice(-12))); }
    // Wrap in structured format with emotion metadata
    const emotion = LOCAL_REPLY_EMOTIONS[intentId] || 'neutral';
    return {
      response: stripEmojis(response),
      speech_text: response,
      emotion,
      // 0.4 sat below Fish Audio's 0.45 cue threshold, so every local reply was
      // spoken with NO emotion cue at all - the flat, bored-butler sound. 0.55
      // lets the mapped cue fire while staying well below the theatrical range.
      emotion_intensity: 0.55,
      speaking_style: 'conversational',
      speaking_rate: 1.0,
      pause_hints: [],
      pronunciation_hints: {}
    };
  }
  // ==================================================================
  // Multi-turn workflow completion (Phases 6/7/8). Every flow finishes
  // into a real, verifiable action; nothing is reported as done until the
  // backend confirms it.
  // ==================================================================
  async function finishPendingFlow(finished) {if (finished.kind === 'calendar') return completeCalendarFlow(finished);if (finished.kind === 'email') return completeEmailFlow(finished);if (finished.kind === 'discord') return completeDiscordFlow(finished);
    return 'I lost track of that request. Please say it again, Sir.';
  }
  async function completeCalendarFlow(flow) {
    const values = flow.values;
    const date = Core.parseNaturalDate(String(values.date || 'today'));
    const time = Core.parseNaturalTime(String(values.time || ''));if (!date || !time || time.error || time.ambiguous) {
      // Infinite-loop fix: never store a completed flow as pending. Reopen as
      // incomplete at the time step so the next answer merges via
      // advancePendingFlow instead of being ignored.
      const reopened = { ...flow, values: { ...flow.values, time: '' }, completed: false, touchedAt: Date.now() };
      if (time && time.ambiguous) {
        reopened.values.timeAmbiguous = { hour: time.hour, minute: time.minute };
        Core.recomputeFlowStep(reopened, `Did you mean ${time.hour}:${String(time.minute).padStart(2, '0')} AM or PM?`);
      } else if (flow.values.timeAmbiguous) {
        // Keep an earlier ambiguous hour (e.g. "at 5") for bare "am"/"pm".
        Core.recomputeFlowStep(reopened, `Did you mean ${flow.values.timeAmbiguous.hour}:${String(flow.values.timeAmbiguous.minute).padStart(2, '0')} AM or PM?`);
      } else {
        delete reopened.values.timeAmbiguous;
        Core.recomputeFlowStep(reopened);
      }
      pendingFlow = reopened; // keep the collected title/date and ask again
      setVoiceSession({ status: 'awaiting-answer', conversationActive: true, waitingFor: reopened.step || 'time', pendingKind: 'calendar', lastQuestion: reopened.question || 'What time is it?', expiresAt: flow.expiresAt }, 'flow-question');
      if (time && time.ambiguous) return `Did you mean ${time.hour}:${String(time.minute).padStart(2, '0')} AM or PM?`;
      if (flow.values.timeAmbiguous) return `Did you mean ${flow.values.timeAmbiguous.hour}:${String(flow.values.timeAmbiguous.minute).padStart(2, '0')} AM or PM?`;
      return 'I still need a clear time with AM or PM for this event. What time is it?';
    }
    date.setHours(time.hour, time.minute, 0, 0);if (date <= new Date()) date.setDate(date.getDate() + 1);
    const durationMinutes = Core.parseNaturalDuration ? (Core.parseNaturalDuration(String(values.duration || '')) || 60) : 60;
    const end = new Date(date.getTime() + durationMinutes * 60000);
    const title = String(values.title || 'Meeting').trim() || 'Meeting';
    const signature = `${title.toLowerCase()}|${date.toISOString()}`;
    // Duplicate-creation guard: the same completion must not fire twice.
    if (lastEventCreate && lastEventCreate.signature === signature && Date.now() - lastEventCreate.at < 15000) return lastEventCreate.message;
    setMode('EXECUTING', `Saving ${title} to your calendar`);
    let result = await plannerRequest({ action: 'create-event', title, start: date.toISOString(), end: end.toISOString(), reminderMinutes: 0 });if (result.conflict && window.confirm(`${result.message} Create the event anyway?`)) {
      result = await plannerRequest({ action: 'create-event', title, start: date.toISOString(), end: end.toISOString(), reminderMinutes: 0, allowConflict: true });
    }
    updatePlannerCard();if (result.ok) {
      lastPlannerItemId = result.event.id;
      lastEventCreate = { signature, at: Date.now(), message: `${result.message} ${title} is on ${formatPlannerDate(result.event.start)}.${result.notify && result.notify.creation === 'off' ? ' Discord notifications are off   add JARVIS_DISCORD_WEBHOOK_URL to the local .env file to get creation and due alerts.' : ''}` };
      return lastEventCreate.message;
    }
    return result.message || 'I could not save that event. Say "set a calendar event" to try again.';
  }
  async function completeEmailFlow(flow) {
    const to = flow.values.to === '__SKIP__' ? '' : String(flow.values.to || '').trim();
    const draft = { to, subject: String(flow.values.subject || 'Untitled').trim(), body: String(flow.values.body || '').trim() };
    setMode('EXECUTING', 'Preparing the email draft');
    showEmailDraft(draft);
    // A real pending email action: the draft is also stored on this computer
    // so it survives reloads. Storage failure never blocks the on-screen card.
    try {
      const saved = await localAction({ action: 'mail-save-draft', to: draft.to, subject: draft.subject, body: draft.body });
      voiceLog('email draft saved', saved.ok ? saved.id : (saved.message || 'save failed'));
    } catch (error) { voiceLog('email draft save failed', error.message); }
    let reply = 'Your email draft is ready on screen for review. Approve and open it when you are happy with it, or tell me any change first.';if (to && Core.emailToStatus(to) === 'name') reply += ` I kept "${to}" as the name   add the address in the To field, or tell me the address.`;
    return reply;
  }
  function completeDiscordFlow(flow) {
    const recipient = flow.recipient || null;
    const body = String(flow.values.body || '').trim();if (!recipient) return 'I lost the Discord contact. Say "message <name> ..." again, Sir.';if (!body) return 'The message was empty, so I did not send anything.';
    showDiscordPreview(recipient, body);
    const label = recipient.name || recipient.username || recipient.id;
    return `Your Discord message to ${label} is ready. Review it on screen   I send it only after you confirm.`;
  }
  function showDiscordPreview(recipient, body) {
    pendingDiscordSend = { id: recipient.id, name: recipient.name || recipient.username || recipient.id };
    $('#discordPreviewCard')?.remove();
    const card = document.createElement('section'); card.className = 'email-draft'; card.id = 'discordPreviewCard';
    const title = document.createElement('strong'); title.textContent = 'DISCORD MESSAGE - CONFIRMATION REQUIRED'; card.append(title);
    const to = document.createElement('div'); to.className = 'draft-subject'; to.textContent = `To: ${pendingDiscordSend.name}`; card.append(to);
    const messageBox = document.createElement('textarea'); messageBox.className = 'draft-body'; messageBox.value = body; messageBox.setAttribute('aria-label', 'Discord message'); card.append(messageBox);
    const actions = document.createElement('div'); actions.className = 'draft-actions';
    const send = document.createElement('button'); send.className = 'chip'; send.textContent = 'SEND NOW';
    send.onclick = async () => {
      const target = pendingDiscordSend; if (!target) { card.remove(); return; }
      send.disabled = true;
      const sent = await localAction({ action: 'discord-send', id: target.id, body: messageBox.value });
      pendingDiscordSend = null; card.remove();
      addMessage('J.A.R.V.I.S.', sent.message || (sent.ok ? 'Sent the Discord message.' : 'The Discord message was not sent.'));
    };
    const cancel = document.createElement('button'); cancel.className = 'chip'; cancel.textContent = 'CANCEL';
    cancel.onclick = () => { pendingDiscordSend = null; card.remove(); addMessage('J.A.R.V.I.S.', 'Discord message discarded. Nothing was sent.'); };
    actions.append(send, cancel); card.append(actions); feed.append(card); feed.scrollTop = feed.scrollHeight;
  }
  function showDiscordChoices(matches, body = '') {
    $('#discordChoiceCard')?.remove();
    const card = document.createElement('section'); card.className = 'email-draft'; card.id = 'discordChoiceCard';
    const title = document.createElement('strong'); title.textContent = 'DISCORD CONTACT - CHOOSE ONE'; card.append(title);
    const list = document.createElement('div'); list.className = 'draft-actions';
    for (const match of matches.slice(0, 6)) {
      const chip = document.createElement('button'); chip.className = 'chip';
      chip.textContent = match.name || match.username || match.id;
      chip.onclick = () => {
        card.remove();
if (body) showDiscordPreview(match, body);
        else {
          pendingFlow = Core.startPendingFlow('discord', { values: { recipient: String(match.name || match.username || match.id) } });
          pendingFlow.recipient = match;
          setVoiceSession({ status: 'awaiting-answer', conversationActive: true, waitingFor: pendingFlow.step, pendingKind: 'discord', lastQuestion: pendingFlow.question, expiresAt: pendingFlow.expiresAt }, 'flow-started');
          addMessage('J.A.R.V.I.S.', pendingFlow.question);
          const turn = ++assistantTurn;
          speak(pendingFlow.question, turn);
        }
      };
      list.append(chip);
    }
    const cancel = document.createElement('button'); cancel.className = 'chip'; cancel.textContent = 'CANCEL';
    cancel.onclick = () => card.remove();
    list.append(cancel); card.append(list); feed.append(card); feed.scrollTop = feed.scrollHeight;
    return 'I found several Discord contacts. Choose one on screen, Sir.';
  }
  async function sendPendingDiscord() {
    const target = pendingDiscordSend;
    const card = $('#discordPreviewCard');if (!target || !card) return null;
    const messageBox = card.querySelector('.draft-body');
    card.querySelector('.draft-actions .chip').disabled = true;
    const sent = await localAction({ action: 'discord-send', id: target.id, body: messageBox ? messageBox.value : '' });
    pendingDiscordSend = null; card.remove();
    addMessage('J.A.R.V.I.S.', sent.message || (sent.ok ? 'Sent the Discord message.' : 'The Discord message was not sent.'));
    return sent;
  }
  // Opening a searched file goes through the server's confirmation gate for
  // programs and scripts: the first call may answer needsConfirmation, which
  // becomes one explicit dialog here before anything is run.
  async function openFoundFile(target) {
    setMode('EXECUTING', `Opening ${target.name}`);
    let result = await localAction({ action: 'open-file', id: target.id });if (result.needsConfirmation) {
      if (!window.confirm(result.message)) return 'I did not run that file.';
      result = await localAction({ action: 'open-file', id: target.id, confirmed: true });
    }
    return result.message || (result.ok ? `Opening ${target.name}.` : 'I could not open that file.');
  }
  // YouTube video transport: verified control of the actual YouTube tab.
  // Every reply reports what really happened — "Skipped" only when the
  // server verified a changed video or a moved playback position.
  async function handleYouTubeControl(parsed) {
    const command = parsed.kind;
    setMode('EXECUTING', command === 'next-video' ? 'Skipping to the next video' : command === 'seek-forward' || command === 'seek-back' ? `Seeking ${parsed.seconds || 10} seconds` : 'Controlling YouTube playback');
    const payload = { action: 'youtube-control', command };
    if (command === 'seek-forward' || command === 'seek-back') payload.seconds = Math.min(300, Math.max(1, Number(parsed.seconds) || 10));
    const result = await localAction(payload);
    if (!result.ok) return result.message || 'I could not control the YouTube video right now, Sir.';
    if (result.verified === false) return `${result.message || 'Sent.'} I could not verify the player state, Sir.`;
    return result.message || 'Done, Sir.';
  }
  // YouTube Discovery ("I'm bored") helpers. Recommendation context lives in
  // lastDiscovery/discoveryStack/recentVideoIds so follow-ups ("open the
  // first one", "show me more", "another one like that") resolve correctly.
  function rememberVideoId(videoId) {
    const id = String(videoId || '');
    if (!id) return;
    recentVideoIds = [id, ...recentVideoIds.filter(item => item !== id)].slice(0, 40);
    try { localStorage.setItem('jarvis-recent-videos', JSON.stringify(recentVideoIds)); } catch {}
  }
  function rememberTopic(topic) {
    const clean = String(topic || '').trim().slice(0, 80);
    if (!clean || /^(funny videos|interesting science explained|gaming highlights|shorts?|short)$/i.test(clean)) return;
    discoveryPrefs.topics = [clean, ...(discoveryPrefs.topics || []).filter(item => item.toLowerCase() !== clean.toLowerCase())].slice(0, 10);
    try { localStorage.setItem('jarvis-discovery-prefs', JSON.stringify(discoveryPrefs)); } catch {}
  }
  function saveDiscoveryPrefs() {
    try { localStorage.setItem('jarvis-discovery-prefs', JSON.stringify(discoveryPrefs)); } catch {}
  }
  function rememberRecentTopic(topic) {
    const clean = String(topic || '').trim().slice(0, 80);
    if (!clean) return [];
    discoveryPrefs.recentTopics = [clean, ...(discoveryPrefs.recentTopics || []).filter(item => String(item).toLowerCase() !== clean.toLowerCase())].slice(0, 8);
    saveDiscoveryPrefs();
    return discoveryPrefs.recentTopics;
  }
  // Families the user returns to (2+ mentions across conversations). Used to
  // boost — never lock — rotation picks.
  function preferredFamilies() {
    const counts = {};
    for (const topic of discoveryPrefs.topics || []) counts[String(topic).toLowerCase()] = (counts[String(topic).toLowerCase()] || 0) + 1;
    const fams = new Set();
    for (const [topic, n] of Object.entries(counts)) {
      if (n < 2) continue;
      const lower = topic.toLowerCase();
      const fam = /roblox|minecraft|gaming|fortnite/.test(lower) ? 'gaming'
        : /anime|animation/.test(lower) ? 'anime'
        : /space|astronomy|nasa/.test(lower) ? 'space'
        : /^(science|physics|chemistry|biology)/.test(lower) ? 'science'
        : /music|song|concert|piano|guitar/.test(lower) ? 'music'
        : /ai\b|artificial intelligence|robot/.test(lower) ? 'ai'
        : /cod|program|python|javascript/.test(lower) ? 'coding' : '';
      if (fam) fams.add(fam);
    }
    return [...fams].slice(0, 2);
  }
  // Honest "why this video": the reason is always the rotation choice
  // (variety, a new family, or a repeated interest) — never a fake claim.
  function whyForTopic(query) {
    const q = String(query || '').toLowerCase();
    const fam = /space|astronomy|nasa|ocean/.test(q) ? 'science and nature'
      : /mystery|facts|documentar/.test(q) ? 'something fascinating'
      : /funny|comedy/.test(q) ? 'something funny'
      : /roblox|gaming|minecraft/.test(q) ? 'gaming'
      : /ai\b|tech|invent|engineer|robot|cod|future|computer/.test(q) ? 'technology'
      : /anime|animation/.test(q) ? 'animation'
      : /music|concert|performance/.test(q) ? 'music'
      : /how things work|tutorial/.test(q) ? 'something useful' : 'something new';
    return fam;
  }
  function discoveryHistoryTexts() {
    return conversationHistory.slice(-8).map(item => `${item.who === 'YOU' ? 'User' : 'JARVIS'}: ${String(item.text || '').slice(0, 200)}`);
  }
  function pushDiscovery(next) {
    if (lastDiscovery && Array.isArray(lastDiscovery.candidates) && lastDiscovery.candidates.length) {
      discoveryStack.push(lastDiscovery);
      discoveryStack = discoveryStack.slice(-5);
    }
    lastDiscovery = next;
  }
  function discoveryLabel(candidate, index) {
    return `${index + 1}. ${candidate.title}${candidate.channel ? ` — ${candidate.channel}` : ''}${candidate.duration ? ` (${candidate.duration})` : ''}`;
  }
  function ensureDiscoveryCard() {
    if ($('#discoveryCard')) return;
    const musicCard = document.querySelector('.music-card');
    if (!musicCard || !musicCard.parentElement) return;
    const card = document.createElement('section');
    card.className = 'card discovery-card';
    card.id = 'discoveryCard';
    const head = document.createElement('div'); head.className = 'cardhead';
    const title = document.createElement('span'); title.textContent = 'YOUTUBE DISCOVERY';
    const live = document.createElement('span'); live.className = 'live'; live.id = 'discoveryLive'; live.textContent = 'READY';
    head.append(title, live); card.append(head);
    const now = document.createElement('div'); now.className = 'music-now'; now.id = 'discoveryNow';
    now.textContent = 'Say "Jarvis, I\'m bored" to get real YouTube picks.';
    card.append(now);
    const controls = document.createElement('div'); controls.className = 'music-controls';
    for (const [label, cmd] of [['SURPRISE ME', 'Surprise me with a video'], ['MORE', 'Show me more'], ['I’M BORED', 'I\'m bored']]) {
      const btn = document.createElement('button'); btn.className = 'chip'; btn.textContent = label;
      btn.addEventListener('click', () => { const input = $('#textInput'); if (input) { input.value = cmd; } ask(cmd, '', 'text'); });
      controls.append(btn);
    }
    card.append(controls);
    const form = document.createElement('form'); form.className = 'inputrow'; form.style.marginTop = '6px';
    const topicInput = document.createElement('input'); topicInput.id = 'discoveryTopic'; topicInput.placeholder = 'Try: Roblox, space, AI…'; topicInput.setAttribute('aria-label', 'Discovery topic');
    const go = document.createElement('button'); go.className = 'send'; go.setAttribute('aria-label', 'Search topic'); go.textContent = '➤';
    form.append(topicInput, go);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const topic = topicInput.value.trim();
      if (!topic) return;
      topicInput.value = '';
      ask(`Find a video about ${topic}`, '', 'text');
    });
    card.append(form);
    const hint = document.createElement('small'); hint.className = 'music-hint';
    hint.textContent = 'Real YouTube results open in your controlled browser. Nothing here is invented.';
    card.append(hint);
    musicCard.parentElement.insertBefore(card, musicCard.nextSibling);
  }
  function updateDiscoveryCard(text) {
    ensureDiscoveryCard();
    const now = $('#discoveryNow');
    if (now && text) now.textContent = text;
    const live = $('#discoveryLive');
    if (live) live.textContent = lastDiscovery && lastDiscovery.candidates.length ? '● LIVE' : 'READY';
  }
  function renderDiscovery(candidates, intro) {
    const list = (candidates || []).slice(0, 6);
    const lines = list.map((candidate, index) => discoveryLabel(candidate, index));
    addMessage('J.A.R.V.I.S.', `${intro}\n${lines.join('\n')}\nSay "open the first one", "show me more", or "find something else".`);
    // Working open buttons: each opens its video through Browser Control.
    const row = document.createElement('div'); row.className = 'msg web-sources';
    const heading = document.createElement('span'); heading.className = 'who'; heading.textContent = 'DISCOVERY'; row.append(heading);
    list.forEach((candidate, index) => {
      const source = document.createElement('div'); source.className = 'web-source';
      const link = document.createElement('a');
      link.href = candidate.url; link.textContent = `${index + 1}. ${candidate.title || candidate.url}`;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      const snippet = document.createElement('small');
      snippet.textContent = `${candidate.channel || 'YouTube'}${candidate.duration ? ` · ${candidate.duration}` : ''}${candidate.description ? ` — ${candidate.description.slice(0, 120)}` : ''}`;
      const open = document.createElement('button'); open.className = 'chip'; open.textContent = `OPEN ${index + 1}`;
      open.addEventListener('click', () => ask(`Open the ${['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][index]} one`, '', 'text'));
      source.append(link, snippet, open); row.append(source);
    });
    feed.append(row); feed.scrollTop = feed.scrollHeight;
    const cardLines = list.slice(0, 3).map((candidate, index) => `${index + 1}. ${String(candidate.title || '').slice(0, 60)}`).join(' · ');
    updateDiscoveryCard(cardLines || 'No recommendations yet.');
  }
  async function discoverySearchAndStore({ query = '', topic = '', choices = null, requestText = '', limit = 5, shortsOnly = false, excludeIds = null } = {}) {
    setMode('SEARCHING', query || topic ? `Finding YouTube videos about ${query || topic}` : 'Finding something to watch');
    const result = await localAction({
      action: 'discovery-search', query, topic, choices, requestText,
      history: discoveryHistoryTexts(), limit,
      shortsOnly, excludeIds: excludeIds || recentVideoIds
    });
    if (!result.ok) {
      const fallback = result.searchUrl ? ` You can browse them yourself: ${result.searchUrl}` : '';
      return { ok: false, reply: `${result.message || 'I could not search YouTube right now, Sir.'}${fallback}` };
    }
    return { ok: true, result };
  }
  function storeDiscovery(result, { topic = '', varied = false } = {}) {
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    for (const candidate of candidates) rememberVideoId(candidate.videoId);
    if (topic) rememberTopic(topic);
    pushDiscovery({ query: result.query || topic, topic, candidates, searchUrl: result.searchUrl, varied, at: Date.now() });
  }
  function variedBoredQueries() {
    const base = ['funny videos', 'interesting science explained', 'gaming highlights'];
    const counts = {};
    for (const topic of discoveryPrefs.topics || []) counts[String(topic).toLowerCase()] = (counts[String(topic).toLowerCase()] || 0) + 1;
    const repeated = Object.entries(counts).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0];
    // A repeated interest (heard across conversations, never a single mention)
    // takes the third slot; the first two stay varied.
    if (repeated) base[2] = `${repeated[0]} videos`;
    return base;
  }
  // "Find a Cool Video": one varied pick, presented with its title and an
  // honest reason, then opened through Browser Control. Repeated activations
  // rotate families via a persisted counter plus recent-topic avoidance, so
  // gaming stays one option among many instead of the default.
  async function handleCoolVideo(intent, rawText) {
    ensureDiscoveryCard();
    const avoid = String((intent && intent.avoid) || '');
    const preferred = preferredFamilies();
    const first = Core.pickCoolTopic({ recentTopics: discoveryPrefs.recentTopics || [], avoid, counter: Number(discoveryPrefs.coolIndex) || 0, preferredFamilies: preferred });
    const second = Core.pickCoolTopic({ recentTopics: [...(discoveryPrefs.recentTopics || []), first.topic], avoid, counter: (Number(discoveryPrefs.coolIndex) || 0) + 5, preferredFamilies: preferred });
    discoveryPrefs.coolIndex = (Number(discoveryPrefs.coolIndex) || 0) + 1;
    const choices = [first.topic, ...second.choices.filter(q => q.toLowerCase() !== first.topic.toLowerCase())].slice(0, 3);
    setMode('SEARCHING', 'Finding a cool video');
    const searched = await discoverySearchAndStore({ choices, requestText: rawText, limit: 4 });
    if (!searched.ok) return searched.reply;
    const exclude = new Set(recentVideoIds.map(String));
    const fresh = searched.result.candidates.filter(c => !exclude.has(String(c.videoId)));
    const pick = fresh[0] || searched.result.candidates[0];
    if (!pick) return searched.reply || 'YouTube returned no usable videos for that topic, Sir. Try again for a different pick.';
    rememberRecentTopic(searched.result.query);
    storeDiscovery(searched.result, { topic: searched.result.query });
    renderDiscovery(lastDiscovery.candidates.slice(0, 4), `Here is a cool pick, Sir — ${whyForTopic(searched.result.query)} this time:`);
    // Convenience: open the top pick right away through the controlled
    // browser; the other picks stay one tap or one phrase away.
    const opened = await openDiscoveredByIndex(1);
    const reason = `I picked ${whyForTopic(searched.result.query)} for variety — "${pick.title}"${pick.channel ? ` by ${pick.channel}` : ''}${pick.duration ? ` (${pick.duration})` : ''}.`;
    if (typeof opened === 'string' && /could not open|no recommendations/i.test(opened)) {
      return `${reason} ${opened} The other picks are on screen, Sir.`;
    }
    return { silent: true, statusText: `${reason} ${typeof opened === 'string' ? opened : 'Opened in your controlled browser.'} Say "another one" for a different pick.` };
  }
  async function handleDiscoveryBored(rawText) {
    const queries = variedBoredQueries();
    const combined = [];
    const seen = new Set(recentVideoIds.map(String));
    let failures = 0;
    for (const query of queries) {
      const searched = await discoverySearchAndStore({ query, requestText: rawText, limit: 2 });
      if (!searched.ok) { failures++; continue; }
      for (const candidate of searched.result.candidates) {
        if (seen.has(String(candidate.videoId))) continue;
        seen.add(String(candidate.videoId));
        combined.push(candidate);
      }
    }
    if (!combined.length) return 'I could not pull fresh YouTube picks just now, Sir. Check your connection and say "I\'m bored" again, or name a topic like "find a video about space".';
    if (failures) voiceLog('discovery partial', `${failures} topic search(es) failed`);
    storeDiscovery({ query: queries.join(' + '), candidates: combined.slice(0, 6), searchUrl: 'https://www.youtube.com/' }, { varied: true });
    renderDiscovery(lastDiscovery.candidates, 'Here are three kinds of picks, Sir — a funny one, something interesting, and a gaming one:');
    return { silent: true, statusText: `Found ${lastDiscovery.candidates.length} videos to choose from.` };
  }
  async function openDiscoveredByIndex(index) {
    if (!lastDiscovery || !Array.isArray(lastDiscovery.candidates) || !lastDiscovery.candidates.length) {
      return 'I have no recommendations open right now, Sir. Say "I\'m bored" first.';
    }
    const candidate = lastDiscovery.candidates[index - 1];
    if (!candidate) return `I only listed ${lastDiscovery.candidates.length} video${lastDiscovery.candidates.length === 1 ? '' : 's'}, Sir. Say "open the first one" or "show me more".`;
    setMode('EXECUTING', `Opening ${candidate.title || 'the video'}`);
    const result = await localAction({ action: 'discovery-open', videoId: candidate.videoId, url: candidate.url });
    if (!result.ok) return result.message || 'I could not open that video in the controlled browser, Sir.';
    lastOpenedVideo = candidate;
    rememberVideoId(candidate.videoId);
    updateDiscoveryCard(`Opened: ${String(candidate.title || '').slice(0, 80)}`);
    // Opening the page, starting playback, and confirming playback are
    // reported separately: navigation verified here, playback needs the page.
    return result.verified
      ? `Opened "${candidate.title}"${candidate.channel ? ` by ${candidate.channel}` : ''} in your controlled browser, Sir. Press play on the page if it does not start by itself.`
      : `I sent "${candidate.title}" to your controlled browser, Sir, but I could not confirm the page loaded yet. ${result.message || ''}`.trim();
  }
  async function handleDiscovery(intent, rawText) {
    ensureDiscoveryCard();
    switch (intent.kind) {
      case 'discovery-clear': {
        discoveryPrefs = { topics: [], recentTopics: [], coolIndex: 0 };
        recentVideoIds = [];
        discoveryStack = [];
        try { localStorage.removeItem('jarvis-discovery-prefs'); localStorage.removeItem('jarvis-recent-videos'); } catch {}
        updateDiscoveryCard('Preferences cleared.');
        return 'Cleared your video preferences and recent picks, Sir. Say "I\'m bored" any time for fresh suggestions.';
      }
      case 'discovery-back': {
        const previous = discoveryStack.pop();
        if (!previous) return 'There are no earlier recommendations to go back to, Sir. Say "I\'m bored" for fresh picks.';
        lastDiscovery = previous;
        renderDiscovery(lastDiscovery.candidates, 'Here are the previous recommendations again, Sir:');
        return { silent: true, statusText: 'Restored the previous recommendations.' };
      }
      case 'discovery-open': {
        return openDiscoveredByIndex(intent.index || 1);
      }
      case 'discovery-more': {
        if (!lastDiscovery || !lastDiscovery.query) return 'I have nothing to show more of yet, Sir. Say "I\'m bored" first.';
        const exclude = [...recentVideoIds, ...lastDiscovery.candidates.map(c => c.videoId)];
        const searched = await discoverySearchAndStore({ query: lastDiscovery.query, requestText: rawText, limit: 5, excludeIds: exclude });
        if (!searched.ok) return searched.reply;
        const fresh = searched.result.candidates.filter(c => !exclude.includes(c.videoId));
        if (!fresh.length) return `Those were the freshest picks for "${lastDiscovery.query}", Sir. Try "find something else" or name a new topic.`;
        for (const candidate of fresh) rememberVideoId(candidate.videoId);
        lastDiscovery.candidates = [...lastDiscovery.candidates, ...fresh].slice(0, 12);
        renderDiscovery(fresh, 'Here are more picks, Sir:');
        return { silent: true, statusText: `Found ${fresh.length} more video${fresh.length === 1 ? '' : 's'}.` };
      }
      case 'discovery-again': {
        const exclude = [...recentVideoIds];
        const queries = variedBoredQueries();
        const query = queries[Math.floor(Math.random() * queries.length)];
        const searched = await discoverySearchAndStore({ query, requestText: rawText, limit: 4, excludeIds: exclude });
        if (!searched.ok) return searched.reply;
        storeDiscovery(searched.result, { varied: true });
        renderDiscovery(lastDiscovery.candidates.slice(0, 4), 'Here is a surprise pick, Sir:');
        return { silent: true, statusText: 'Surprise pick ready.' };
      }
      case 'discovery-similar': {
        const anchor = lastOpenedVideo || (lastDiscovery && lastDiscovery.candidates[0]);
        if (!anchor) return 'I have nothing to match yet, Sir. Say "I\'m bored" first, then "find another one like that".';
        const query = anchor.channel ? `${anchor.channel} ${lastDiscovery && lastDiscovery.topic ? lastDiscovery.topic : ''}`.trim() : String(anchor.title || '').split(/\s+/).slice(0, 6).join(' ');
        const searched = await discoverySearchAndStore({ query, requestText: rawText, limit: 5, excludeIds: [...recentVideoIds, anchor.videoId] });
        if (!searched.ok) return searched.reply;
        storeDiscovery(searched.result, { topic: query });
        renderDiscovery(lastDiscovery.candidates.slice(0, 4), `Here are videos like "${String(anchor.title || '').slice(0, 60)}", Sir:`);
        return { silent: true, statusText: 'Related picks ready.' };
      }
      case 'discovery-refine': {
        if (intent.topic) {
          const searched = await discoverySearchAndStore({ query: intent.topic, topic: intent.topic, requestText: rawText, limit: 5 });
          if (!searched.ok) return searched.reply;
          storeDiscovery(searched.result, { topic: intent.topic });
          renderDiscovery(lastDiscovery.candidates.slice(0, 5), `Here are picks about ${intent.topic}, Sir:`);
          return { silent: true, statusText: `Picks about ${intent.topic} ready.` };
        }
        const refinement = String(intent.refinement || '').toLowerCase();
        if (refinement === 'different') {
          const queries = variedBoredQueries();
          const searched = await discoverySearchAndStore({ query: queries[0], requestText: rawText, limit: 5 });
          if (!searched.ok) return searched.reply;
          storeDiscovery(searched.result, { varied: true });
          renderDiscovery(lastDiscovery.candidates.slice(0, 5), 'No problem, Sir — here is something different:');
          return { silent: true, statusText: 'Different picks ready.' };
        }
        if (refinement === 'funny' || refinement === 'funnier') {
          const searched = await discoverySearchAndStore({ query: 'funny videos', requestText: rawText, limit: 5 });
          if (!searched.ok) return searched.reply;
          storeDiscovery(searched.result, { topic: 'funny videos' });
          renderDiscovery(lastDiscovery.candidates.slice(0, 5), 'Here is something funnier, Sir:');
          return { silent: true, statusText: 'Funnier picks ready.' };
        }
        if (refinement === 'shorter' || refinement === 'short') {
          const base = (lastDiscovery && lastDiscovery.query) || 'interesting videos';
          const searched = await discoverySearchAndStore({ query: base, requestText: rawText, limit: 8, shortsOnly: true });
          if (!searched.ok) return searched.reply;
          storeDiscovery(searched.result, { topic: base });
          renderDiscovery(lastDiscovery.candidates.slice(0, 5), 'Here are shorter picks, Sir:');
          return { silent: true, statusText: 'Shorter picks ready.' };
        }
        const base = (lastDiscovery && lastDiscovery.query) || '';
        const searched = await discoverySearchAndStore({ query: `${refinement} videos ${base}`.trim(), requestText: rawText, limit: 5 });
        if (!searched.ok) return searched.reply;
        storeDiscovery(searched.result, { topic: refinement });
        renderDiscovery(lastDiscovery.candidates.slice(0, 5), 'Here are refined picks, Sir:');
        return { silent: true, statusText: 'Refined picks ready.' };
      }
      case 'discovery-search': {
        const topic = String(intent.topic || intent.query || '').trim();
        if (!topic) return handleDiscoveryBored(rawText);
        if (/^short$/i.test(topic)) {
          const searched = await discoverySearchAndStore({ query: 'funny shorts', requestText: rawText, limit: 6, shortsOnly: true });
          if (!searched.ok) return searched.reply;
          storeDiscovery(searched.result, { topic: 'short videos' });
          renderDiscovery(lastDiscovery.candidates.slice(0, 5), 'Here are short videos, Sir:');
          return { silent: true, statusText: 'Short video picks ready.' };
        }
        const searched = await discoverySearchAndStore({ query: topic, topic, requestText: rawText, limit: 5 });
        if (!searched.ok) return searched.reply;
        storeDiscovery(searched.result, { topic });
        renderDiscovery(lastDiscovery.candidates.slice(0, 5), topic.toLowerCase() === 'roblox' || /roblox/i.test(topic) ? 'Here are Roblox picks, Sir:' : `Here are picks about ${topic}, Sir:`);
        return { silent: true, statusText: `Picks about ${topic} ready.` };
      }
      case 'discovery-cool': {
        return handleCoolVideo(intent, rawText);
      }
      case 'discovery-bored':
      default: {
        return handleDiscoveryBored(rawText);
      }
    }
  }
  // Re-opens the most recent media search ("open this song" after a YouTube
  // or YouTube Music search) instead of asking the app launcher for "this".
  async function openLastMedia() {    const target = lastMediaQuery;    if (!target || !target.query) return 'Which song or video should I open, Sir? Tell me the title.';
    setMode('EXECUTING', `Opening ${target.query}`);
    if (target.site === 'youtube-music') {
      const searched = await localAction({ action: 'music-search', query: target.query });
      if (!searched.ok) return searched.message || 'I could not search YouTube Music right now.';
      return (chooseLocalReply('music_search', { query: target.query })?.response || searched.message);
    }
    const result = await localAction({ action: 'search-site', site: target.site || 'youtube', query: target.query });
    return result.message || (result.ok ? `Searching ${target.site || 'YouTube'} for ${target.query}.` : 'I could not open that search.');
  }
  // =====================================================================
  // Voice-only modes engine (2026-10-14). Uses existing launching
  // (open-site reuses tabs, focus-app focuses-or-launches), the conversation
  // UI, and the speech controller. No GUI, no new panels.
  // =====================================================================
  function nextModeQuestion(modeId) {
    const def = Core.MODES[modeId];
    if (!def || !def.questions.length) return '';
    let n = 0;
    try { n = Number(localStorage.getItem('jarvis-mode-q-' + modeId) || 0) || 0; } catch {}
    const q = Core.modeQuestion(modeId, n);
    try { localStorage.setItem('jarvis-mode-q-' + modeId, String(n + 1)); } catch {}
    return q;
  }
  function setPendingQuestion(kind, expected, question, options = {}) {
    const now = Date.now();
    const ttlMs = Number(options.ttlMs) || (Core.MODE_FOLLOWUP_MS || 20000);
    // One shared pending-question record for every workflow (see
    // Core.createPendingQuestion): voice modes, greetings, alarms, reminders
    // and planner clarifications all publish the same shape, so the voice
    // gate, the resolver and the diagnostics all ask the same question.
    pendingQuestion = Core.createPendingQuestion({
      kind, question,
      requiredField: options.requiredField || expected || '',
      conversationId: options.conversationId || `conversation-${now}`,
      intent: options.intent || kind,
      collected: options.collected || {},
      context: options.context || {},
      ttlMs, now,
      extra: { mode: options.mode || '', expected: expected || '' }
    });
    setVoiceSession({ status: 'awaiting-answer', conversationActive: true, waitingFor: options.waitingFor || expected || kind, pendingKind: options.pendingKind || ('question:' + (options.intent || kind)), lastQuestion: question, expiresAt: pendingQuestion.expiresAt }, 'question-armed');
    voiceLog('pending question armed', `${pendingQuestion.intent}/${pendingQuestion.requiredField} - "${String(question).slice(0, 70)}"`);
    return pendingQuestion;
  }
  function clearPendingQuestion(why) {
    if (!pendingQuestion) return;
    const wasConversationMode = pendingQuestion.mode === 'conversation';
    voiceLog('pending question cleared', `${pendingQuestion.intent} - ${why}`);
    Core.markPendingQuestionHandled?.(pendingQuestion);
    pendingQuestion = null;
    if (!pendingFlow) clearVoiceSession('question-answered');
  }
  // True when JARVIS is currently waiting for a direct answer. Used by the
  // voice gate and by the speech controller to decide whether the next
  // utterance needs the wake word.
  function awaitingAnswer(now = Date.now()) {
    if (pendingFlow && !pendingFlow.completed) return true;
    return Core.pendingQuestionWaiting(pendingQuestion, now);
  }
  // Arm the conversation follow-up bridge (2026-10-15). When a reply is an
  // invitation to keep talking, publish the SHARED pending question so the
  // user's spoken reply arrives without another wake word. Deliberately
  // narrow: only library intents in Core.CONVERSATION_BRIDGE_INTENTS or an
  // AI answer that ends in a question arm it, and neither an active
  // workflow (pendingFlow) nor an existing pending question is displaced.
  function armConversationBridge(intentId, replyText) {
    const eligible = intentId === 'ai-question' || (Core.CONVERSATION_BRIDGE_INTENTS || []).includes(intentId);
    if (!eligible) return;
    if (pendingFlow) return;
    if (pendingQuestion && Core.pendingQuestionActive(pendingQuestion)) return;
    const text = String(replyText || '').slice(0, 400);
    // Only a reply that asks the user something earns the no-wake window. A
    // finished statement returns to wake-word standby after playback; holding
    // the mic open for it was the "listening when not activated" failure.
    if (!Core.replyAsksForAnswer(text)) return;
    // A question about which game to play expects a game answer. Recording the
    // expected kind lets the follow-up resolver use the real launcher instead
    // of handing a clear answer to the model as pure chat.
    const expected = Core.inferFollowUpExpected ? Core.inferFollowUpExpected(text) : '';
    setPendingQuestion('conversation', expected || 'free', text, {
      intent: 'conversation',
      waitingFor: expected || 'free',
      conversationId: `chat-${Date.now()}`,
      // Sustained chat: hold the no-wake-word window long enough to answer.
      ttlMs: Core.CONVERSATION_FOLLOW_UP_MS || Core.MODE_FOLLOWUP_MS || 20000,
      collected: { lastIntent: intentId || '', expected: expected || 'free' }
    });
  }
  // Wrap a spoken reply so the no-wake-word follow-up window opens exactly
  // when JARVIS asked a question and is now waiting for the answer.
  function withFollowUp(text, extras = {}) {
    if (!awaitingAnswer()) return typeof text === 'string' ? text : text;
    const base = typeof text === 'string'
      ? { response: text, speech_text: text }
      : { ...text };
    return {
      ...base,
      followUp: true,
      followUpMs: Number(extras.followUpMs) || (Core.MODE_FOLLOWUP_MS || 20000)
    };
  }
  // After a deterministic conversational reply, keep the no-wake window open
  // only when the exchange is an explicitly enabled conversation mode or the
  // reply itself asks the user something. A finished line ("On the same page,
  // Sir.") closes the window and returns to wake-word standby after playback.
  function keepConversationWindow(replyText, pq, reason = 'answer-complete') {
    const sustained = Boolean(pq && pq.mode === 'conversation');
    const asks = Core.replyAsksForAnswer ? Core.replyAsksForAnswer(replyText) : /\?\s*$/.test(String(replyText || '').trim());
    if (sustained || asks) {
      if (pq) Core.refreshPendingQuestion(pq, { now: Date.now() });
      return true;
    }
    clearPendingQuestion(reason);
    setVoiceSession({ status: 'standby', conversationActive: false, waitingFor: '', pendingKind: '', lastQuestion: '', expiresAt: 0 }, reason);
    return false;
  }
  function modeAnswer(text) {
    // Structured mode reply: spoken through the normal pipeline with the
    // follow-up window armed (answer needs no wake word). preserveTurn keeps
    // slow multi-launch modes from being dropped by a newer turn.
    return { response: text, speech_text: text, emotion: 'neutral', emotion_intensity: 0.5, speaking_rate: 1, followUp: true, followUpMs: Core.MODE_FOLLOWUP_MS || 20000, preserveTurn: true };
  }
  function modeDone(text) {
    return { response: text, speech_text: text, emotion: 'neutral', emotion_intensity: 0.5, speaking_rate: 1, preserveTurn: true };
  }
  // Open one web destination with tab reuse; returns a short status phrase.
  async function openModeSite(site, runId, opened) {
    if (runId !== modeRunToken) return null;
    const pretty = { toddle: 'Toddle', docs: 'Google Docs', slides: 'Google Slides', 'youtube-music': 'YouTube Music', youtube: 'YouTube', gmail: 'Gmail', google: 'Google', discord: 'Discord', roblox: 'Roblox' }[site] || site;
    if (opened.has(site)) return `${pretty} (already prepared)`;
    try {
      let r;
      if (site === 'discord') {
        // Prefer the running desktop app; fall back to the reused site tab.
        r = await localAction({ action: 'focus-app', name: 'Discord' });
        if (r && r.ok) { opened.add(site); return 'Discord app'; }
        r = await localAction({ action: 'open-site', name: 'discord' });
      } else {
        r = await localAction({ action: 'open-site', name: site });
      }
      if (r && r.ok) { opened.add(site); return r.reused ? `${pretty} (already open)` : pretty; }
      // Track the real backend outcome in the voice log so a failed
      // destination is diagnosable instead of silently becoming "could not".
      try { voiceLog('mode site failed', `${site} - ${String((r && r.message) || 'no response').slice(0, 160)}`); } catch {}
      return `__FAIL__${pretty}`;
    } catch { return `__FAIL__${pretty}`; }
  }
  // Shared spoken rendering of a site-todos read, used by both study mode and
  // the on-demand "check my todo list" command. Every failure path reports the
  // real reason instead of inventing coursework.
  // Toddle's dashboard widget also shows filter totals ("Not submitted (2)",
  // "No due date (53)"). Those stay useful even when the visible filter is
  // empty, so they are spoken alongside the items.
  function todoCountsSentence(counts) {
    const parts = [];
    if (counts['Not submitted']) parts.push(`${counts['Not submitted']} not submitted`);
    if (counts['No due date']) parts.push(`${counts['No due date']} with no due date`);
    if (counts.Overdue) parts.push(`${counts.Overdue} overdue`);
    return parts.length ? ` Also on Toddle: ${parts.join(', ')}.` : '';
  }
  function describeTodos(todos, { max = 4 } = {}) {
    const tail = todos && todos.counts ? todoCountsSentence(todos.counts) : '';
    if (todos && todos.ok && todos.items && todos.items.length) {
      const list = todos.items.slice(0, max).map(it => {
        const bits = [it.title];
        if (it.subject) bits.push(`- ${it.subject}`);
        if (it.due) bits.push(`due ${it.due}`);
        return bits.join(' ');
      });
      const more = todos.items.length > max ? ` And ${todos.items.length - max} more on your list.` : '';
      return { ok: true, items: todos.items, text: `On your Toddle list: ${list.join('; ')}.${more}${tail}` };
    }
    if (todos && todos.signedOut) return { ok: false, text: 'Toddle needs you to sign in before I can read your list.' };
    if (todos && (todos.status === 'not-connected' || todos.needsSetup)) return { ok: false, text: 'I could not read Toddle because browser control is not connected.' };
    if (todos && todos.status === 'no-tab') return { ok: false, text: 'I could not find a Toddle tab to read.' };
    // Widget present and readable, but the visible filter has nothing in it.
    if (todos && todos.ok && tail) return { ok: false, text: `Nothing due in view on Toddle right now, Sir.${tail}` };
    return { ok: false, text: 'I could not read any upcoming work from Toddle just now.' };
  }
  async function launchGameByName(name) {
    // focus-app focuses a running instance or launches it; messages stay
    // honest when Windows cannot find or start the game.
    const r = await localAction({ action: 'focus-app', name });
    return r || { ok: false, message: `I could not start ${name}, Sir.` };
  }
  // =====================================================================
  // UNVERIFIED-OPEN CLAIM REPAIR (2026-10-31)
  //
  // The model is text-only unless it actually called a server tool. A line
  // like "Opening Roblox for you" is therefore not evidence that anything ran.
  // When an AI answer contains such a performative claim, either make it true
  // through the same deterministic launcher the command path uses, or replace
  // it with an honest correction. Advice, offers and failures never trigger.
  // =====================================================================
  function userAskedAboutOpenState(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/^(?:did|do|does|have|has|had|is|are|was|were|why|when|where|how)\b/i.test(t)) return true;
    if (/\b(?:did|have|has)\s+you\s+(?:open|launch|start)\b/i.test(t)) return true;
    return /\b(?:is|are)\s+(?:it|that)\s+(?:open|running|up|ready)\b/i.test(t);
  }
  function userDeferredOrDeclinedOpen(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/^(?:no|nope|not|never)\b/i.test(t)) return true;
    if (/^(?:i\s+)?(?:hate|dislike)\b/i.test(t)) return true;
    if (/\b(?:later|not now|not yet|tomorrow|another time|some other time|maybe later|when i get home|after work|after school)\b/i.test(t)) return true;
    return /\b(?:don'?t|do not|not|never|no longer|stop|hate|dislike)\b[^.!?]{0,40}\b(?:like|enjoy|love|play(?:ing)?|game|want|feel like|open|launch)\b/i.test(t);
  }
  function userInvitesOpen(text, target) {
    const t = String(text || '').trim();
    if (!t) return false;
    // Informational questions and advice requests are never consent to launch.
    if (/^(?:what|who|why|how|when|where|which|tell|explain|describe)\b/i.test(t)) return false;
    if (/^(?:should|would)\s+(?:i|we)\b/i.test(t) || /^(?:could|can)\s+i\b/i.test(t) || /^do you\b/i.test(t)) return false;
    // Stative statements ("I like Roblox") are not requests. Keep a real
    // desire phrase ("I'd like to play Roblox") as an invitation.
    if (/\b(?:like|love|hate|enjoy|prefer|know|remember|heard)\b/i.test(t)
      && !/\b(?:want|wanna|would like|i'?d like|i'?d love|feel like|thinking (?:about|of)|open|launch|start|play\s+(?:some|a|another)|let'?s play|going to|gonna)\b/i.test(t)) return false;
    if (/\b(?:open|launch|start|want|wanna|would like|i'?d like|i'?d love|feel like|thinking (?:about|of)|going to|gonna|plan(?:ning)? (?:on|to)|let'?s play|might play|could play|maybe|perhaps|please|go ahead|play\s+(?:some|a|another|more))\b/i.test(t)) return true;
    const compact = t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const key = String(target || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    return Boolean(key) && compact.includes(key) && compact.split(' ').filter(Boolean).length <= 4;
  }
  function aiActionToolRan(tools) {
    return Array.isArray(tools) && tools.some(tool => {
      if (!tool || tool.ok === false) return false;
      const name = String(tool.name || '').toLowerCase();
      return name.startsWith('open_') || /^(?:music_search|youtube_search|launch|focus)/.test(name);
    });
  }
  async function openResolvedClaimTarget(rawTarget) {
    const resolved = Core.resolveOpenTarget ? Core.resolveOpenTarget(rawTarget) : null;
    if (!resolved) return { resolved: null, result: null };
    if (resolved.kind === 'site') {
      return { resolved, result: await localAction({ action: 'open-site', name: resolved.name }) };
    }
    if (resolved.kind === 'app') {
      let result = await localAction({ action: 'open-app', name: resolved.name });
      if ((!result || !result.ok) && resolved.fallbackSite) {
        result = await localAction({ action: 'open-site', name: resolved.fallbackSite });
      }
      return { resolved, result };
    }
    if (resolved.kind === 'game') {
      return { resolved, result: await launchGameByName(resolved.name) };
    }
    return { resolved: null, result: null };
  }
  async function repairUnverifiedOpenClaim(claim, userText) {
    const target = humanLabel(claim && claim.target ? claim.target : '');
    const correction = text => ({ executed: false, text });
    if (!target) {
      return correction('I should not have said I was opening that, Sir - I have not opened anything yet. What should I open?');
    }
    if (userAskedAboutOpenState(userText)) {
      return correction(`I do not have a verified record of opening ${target} in this turn, Sir. I should not have implied I had. Say "open ${target}" if you want me to open it now.`);
    }
    if (userDeferredOrDeclinedOpen(userText)) {
      return correction(`I have not opened ${target}, Sir. I should not have said I had. Say the word when you are ready.`);
    }
    if (!claim.grounded || !userInvitesOpen(userText, claim.target)) {
      return correction(`I have not opened ${target}, Sir. I should not have said I had. Say "open ${target}" if you want it open.`);
    }
    let resolved = null;
    let result = null;
    try {
      const attempt = await openResolvedClaimTarget(claim.target);
      resolved = attempt.resolved;
      result = attempt.result;
    } catch {
      result = { ok: false, message: `I could not open ${target}, Sir.` };
    }
    if (!resolved || !result) {
      return correction(`I have not opened ${target}, Sir. I could not match it to an app or site I know. Say "open ${target}" if you want me to try.`);
    }
    if (result.ok) {
      try { rememberOpenedTarget(resolved.name); } catch {}
      const message = String(result.message || '').trim();
      return { executed: true, text: message || `${target} is open, Sir.` };
    }
    return correction(String(result.message || `I could not open ${target}, Sir.`).trim());
  }
  async function runMode(modeId, extra = {}, rawText = '', switched = false) {
    const def = Core.MODES[modeId];
    if (!def) return null;
    const runId = ++modeRunToken;
    clearPendingQuestion(switched ? 'mode-switch' : 'new-mode');
    activeMode = modeId;
    setMode('EXECUTING', `${def.label} mode`);
    // Conversation Mode (2026-10-15): sustained chat with no wake word. No
    // sites open, no question is asked beyond the opener; every exchange
    // refreshes the shared pending question, so the listening window stays
    // alive as long as the chat continues and expires after inactivity.
    if (modeId === 'conversation') {
      const openers = [
        'Very good, Sir. I am listening — what is on your mind?',
        'Conversation mode on, Sir. Talk freely, no "Jarvis" needed while this is open.',
        'Alright, Sir. I am right here — tell me what you want to talk about.',
        'Chatting it is, Sir. What is on your mind today?',
        'Of course, Sir. Say whatever is on your mind — I am all ears.'
      ];
      let n = 0;
      try { n = Number(localStorage.getItem('jarvis-mode-opener-conversation') || 0) || 0; localStorage.setItem('jarvis-mode-opener-conversation', String(n + 1)); } catch {}
      let opener = openers[n % openers.length];
      // Never greet with the line JARVIS just said. Re-entering conversation
      // mode right after an opener used to repeat that opener word for word,
      // which is the most robotic thing a voice assistant can do.
      const previousJarvisLine = String(conversationHistory.filter(item => item.who !== 'YOU' && item.who !== 'Me').slice(-1)[0]?.text || '').toLowerCase();
      if (previousJarvisLine && previousJarvisLine.startsWith(opener.slice(0, 28).toLowerCase())) opener = openers[(n + 1) % openers.length];
      setPendingQuestion('conversation', 'free', opener, { mode: 'conversation', intent: 'conversation', waitingFor: 'free', ttlMs: Core.CONVERSATION_FOLLOW_UP_MS || Core.MODE_FOLLOWUP_MS || 20000, conversationId: `conversation-${Date.now()}` });
      setMode(recognitionEnabled ? 'LISTENING' : 'IDLE', 'Conversation mode - keep talking, no wake word needed. Say "exit conversation mode" to stop.');
      return modeAnswer(`${opener} (While this is open you can just keep talking. Say "exit conversation mode" to stop.)`);
    }
    const followMs = Core.MODE_FOLLOWUP_MS || 20000;
    // Fast paths from a combined command ("gaming mode, get Roblox ready"):
    // act directly and skip the now-redundant question.
    if (extra.gameRaw) {
      const g = Core.parseModeGame(extra.gameRaw);
      if (g && !g.generic && !g.unsupported) {
        const r = await launchGameByName(g.name);
        if (runId !== modeRunToken) return 'Switching modes, Sir.';
        return modeDone(r.ok ? `${g.name} is getting ready, Sir. ${r.message}` : r.message || `I could not start ${g.name}, Sir.`);
      }
      if (g && g.unsupported) return modeDone(`${g.name} is mobile-only, Sir, so I cannot launch it on this Windows PC. Name a PC game instead.`);
    }
    if (extra.song && (modeId === 'music' || modeId === 'relax' || modeId === 'workout' || modeId === 'movie')) {
      // Deterministic guard: a filler or generic song slot ("play some
      // music", "play it") must never become a literal search query. Genuine
      // titles proceed (cleaned); "anything" opens the music surface; the
      // rest fall through to the normal question flow below.
      const songVerdict = Core.classifyMusicAnswer ? Core.classifyMusicAnswer(extra.song) : null;
      if (songVerdict && songVerdict.kind === 'anything') {
        const home = await localAction({ action: 'open-site', name: 'youtube-music' });
        if (runId !== modeRunToken) return 'Switching modes, Sir.';
        if (home && home.ok) return modeDone('YouTube Music is open, Sir. Name an artist any time and I will find it.');
        delete extra.song;
      } else if (songVerdict && songVerdict.kind !== 'request') {
        delete extra.song;
      } else {
        if (songVerdict && songVerdict.title) extra.song = songVerdict.title;
        const r = await localAction({ action: 'music-search', query: extra.song });
        if (runId !== modeRunToken) return 'Switching modes, Sir.';
        return modeDone(r && r.ok ? `Searching for "${extra.song}" now, Sir.` : (r && r.message) || `I could not search for "${extra.song}" right now, Sir.`);
      }
    }
    if (extra.subject && (modeId === 'study' || modeId === 'focus' || modeId === 'research' || modeId === 'writing' || modeId === 'presentation')) {
      if (runId !== modeRunToken) return 'Switching modes, Sir.';
      return modeDone(`${extra.subject} it is, Sir. ${def.label} mode is active — tell me where to begin.`);
    }
    const opened = new Set();
    const ready = [];
    const failed = [];
    for (const site of (def.sites || [])) {
      const s = await openModeSite(site, runId, opened);
      if (s === null) return 'Switching modes, Sir.';
      if (s.startsWith('__FAIL__')) failed.push(s.slice(8));
      else ready.push(s);
    }
    if (runId !== modeRunToken) return 'Switching modes, Sir.';
    // Mode-specific data gathering (all existing integrations only).
    let brief = '';
    if (modeId === 'morning' || modeId === 'winddown') {
      try {
        const snap = await plannerSnapshot();
        if (snap && snap.ok) {
          const day = modeId === 'morning' ? new Date() : new Date(Date.now() + 86400000);
          const sameDay = (iso) => { const d = new Date(iso); return d.getFullYear() === day.getFullYear() && d.getMonth() === day.getMonth() && d.getDate() === day.getDate(); };
          const items = [...(snap.alarms || []).filter(a => a.when && sameDay(a.when)).map(a => `alarm ${a.title || ''} at ${a.when}`),
            ...(snap.reminders || []).filter(r => r.when && sameDay(r.when)).map(r => `reminder ${r.title || ''}`),
            ...(snap.events || []).filter(e => e.start && sameDay(e.start)).map(e => `${e.title || 'event'} at ${e.start}`)].slice(0, 4);
          brief = items.length ? ` Confirmed on the schedule: ${items.join('; ')}.` : ' Nothing confirmed on the schedule for that day.';
        } else brief = ' I could not read the schedule just now.';
      } catch { brief = ' I could not read the schedule just now.'; }
    }
    if (modeId === 'study') {
      // Study mode replaces its old "which subject?" question with a real
      // read: the todo / upcoming work on the Toddle tab it just opened.
      try {
        const todos = await localAction({ action: 'site-todos', site: 'toddle' });
        if (runId !== modeRunToken) return 'Switching modes, Sir.';
        brief = ` ${describeTodos(todos).text}`;
      } catch { brief = ' I could not read Toddle just now.'; }
    }
    if (modeId === 'bored') {
      const res = await handleDiscoveryBored(rawText || "I'm bored");
      if (typeof res === 'string') brief = ` ${res}`;
      // Success renders picks silently on the discovery card; speak the question.
    }
    let opener;
    let openerBase = '';
    // Gaming mode: natural response naming only destinations that really
    // opened (or were already there), with a rotating follow-up question.
    // Grammar follows the count so one ready destination never gets "are".
    if (modeId === 'gaming' && ready.length) {
      const names = ready.map(s => s.replace(/\s+\((?:already open|already prepared)\)$/, ''));
      const phrase = names.length > 1
        ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are open`
        : `${names[0]} is open`;
      const variants = [
        `Gaming workspace is ready. ${phrase}. Is there any other game you'd like me to open?`,
        `All set. ${phrase}. Would you like me to open another game?`,
        `Your gaming workspace is ready. ${phrase}. Anything else you'd like to play?`,
        `Good to go. ${phrase}. What else should I launch?`
      ];
      let n = 0;
      try { n = Number(localStorage.getItem('jarvis-mode-opener-gaming') || 0) || 0; localStorage.setItem('jarvis-mode-opener-gaming', String(n + 1)); } catch {}
      opener = openerBase = variants[n % variants.length];
      if (failed.length) opener += ` Note: I could not open ${failed.join(', ')} — check the connection and ask again.`;
      if (brief) opener += brief;
    } else if (modeId === 'study' && ready.length) {
      // Study mode: same natural treatment as gaming. Raw site statuses
      // carry "(already open)" / "(already prepared)" tags for the log —
      // reading them aloud ("YouTube open paren already open...") is what
      // made the opener sound weird. Strip tags and fix grammar.
      // These variants are statements, never questions (2026-10-15): study
      // mode asks nothing, so openerBase stays unset and the Toddle todo
      // brief below is the whole reply.
      const names = ready.map(s => s.replace(/\s+\((?:already open|already prepared)\)$/, ''));
      const phrase = names.length > 1
        ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are open`
        : `${names[0]} is open`;
      const variants = [
        `Study workspace is ready. ${phrase}.`,
        `All set for studying. ${phrase}.`,
        `Your study tools are ready. ${phrase}.`
      ];
      let n = 0;
      try { n = Number(localStorage.getItem('jarvis-mode-opener-study') || 0) || 0; localStorage.setItem('jarvis-mode-opener-study', String(n + 1)); } catch {}
      opener = variants[n % variants.length];
      if (failed.length) opener += ` Note: I could not open ${failed.join(', ')} — check the connection and ask again.`;
      if (brief) opener += brief;
    } else if (modeId === 'cooldown') opener = 'Take your time, Sir. I am here.';
    else if (ready.length) opener = `${def.label} workspace ready: ${ready.join(', ')}.${failed.length ? ` I could not open ${failed.join(', ')} — check the connection and ask again.` : ''}${brief}`;
    else if (failed.length) opener = `I could not open ${failed.join(', ')} just now, Sir.${brief}`;
    else opener = `${def.label} mode on, Sir.${brief}`;
    if (extra.minutes && modeId === 'focus') opener += ` Noted a ${extra.minutes}-minute session — say "remind me in ${extra.minutes} minutes" if you want a real timer.`;
    if (switched) opener = `Switched to ${def.label.toLowerCase()} mode, Sir. ` + opener.replace(/^.*?mode (?:ready|on)/i, '').replace(/^[:. ]+/, '');
    const question = nextModeQuestion(modeId);
    // The gaming opener already ends in a follow-up question; appending
    // another one ("...open? Any games you're interested in?") reads as a
    // stutter, so the base opener itself becomes the pending question.
    // (Failure notes appended above end with a period, so the base text —
    // not the decorated opener — decides.)
    const alreadyAsks = Boolean(openerBase) || /\?\s*$/.test(opener);
    const full = (alreadyAsks || !question) ? opener : `${opener} ${question}`;
    // A mode with no question variants (study mode since 2026-10-15) asks
    // nothing at all: no pending question is armed, the HUD does not claim it
    // is "listening for your reply", and the reply carries no follow-up
    // window, so the next thing said needs a fresh wake word as usual.
    if (!question && !alreadyAsks) {
      setMode('IDLE', `${def.label} mode active`);
      return modeDone(full);
    }
    setPendingQuestion(modeId, def.expect || 'free', alreadyAsks ? (openerBase || opener) : (question || opener), { mode: modeId });
    setMode(recognitionEnabled ? 'LISTENING' : 'IDLE', `${def.label} mode - listening for your reply...`);
    return modeAnswer(full);
  }
  // ---- Local AI reply-time estimate (display only) ----------------------
  // Shown like "(12s)" ONLY while a request is in flight to the local Ollama
  // model. The number lives purely in on-screen status text: it is never part
  // of the reply string, so neither the API response nor the TTS ever reads it
  // out. The estimate is the rounded average of the last few real reply times
  // and defaults to 12 s until history exists. Server/bridge code untouched.
  const AI_ETA_SAMPLES_KEY = 'jarvis-ai-eta-samples';
  const AI_ETA_SAMPLES_REMOTE_KEY = 'jarvis-ai-eta-samples-remote';
  const AI_ETA_DEFAULT_SEC = 12;
  const AI_ETA_REMOTE_DEFAULT_SEC = 8;
  function recordLocalAIReplyMs(ms, { remote = false } = {}) {
    // Instant failures (Ollama offline, refused connection) are not replies
    // and must not poison the average with sub-second "answers".
    if (!(Number(ms) >= 800)) return;
    const seconds = Math.max(1, Math.round(Number(ms) / 1000));
    // Local and remote reply times go into SEPARATE buckets: remote providers
    // answer in a very different range, and mixing them made the local estimate
    // drift (and the remote wait time invisible).
    const key = remote ? AI_ETA_SAMPLES_REMOTE_KEY : AI_ETA_SAMPLES_KEY;
    try {
      const samples = loadJson(key, []);
      samples.push(Math.min(seconds, 300));
      localStorage.setItem(key, JSON.stringify(samples.slice(-8)));
    } catch {}
  }
  function estimateLocalAIReplySeconds(remote = false) {
    const key = remote ? AI_ETA_SAMPLES_REMOTE_KEY : AI_ETA_SAMPLES_KEY;
    const fallback = remote ? AI_ETA_REMOTE_DEFAULT_SEC : AI_ETA_DEFAULT_SEC;
    try {
      const samples = loadJson(key, []);
      if (!samples.length) return fallback;
      const avg = samples.reduce((sum, n) => sum + n, 0) / samples.length;
      return Math.max(1, Math.min(300, Math.round(avg)));
    } catch { return fallback; }
  }

  // Resolve a no-wake-word answer against the pending mode question. Returns
  // a reply (string or structured) when handled, or null to continue normal
  // routing (clearing stale state first).
  async function resolveModeAnswer(text) {
    const pq = pendingQuestion;
    if (!pq || pq.handled) return null;
    if (Date.now() > pq.expiresAt) { clearPendingQuestion('expired'); return null; }
    const lead = Core.stripPoliteLead(text).replace(/[.!?]+$/, '').trim();
    const lower = lead.toLowerCase();
    // Cancellation / stop / brand-new mode commands win over the question.
    if (/^(?:cancel(?: that| this)?|never ?mind|stop(?: asking( me)? questions?| that)?|quit|exit(?: this)? mode|go back to normal)\b/i.test(lead)) {
      clearPendingQuestion('cancelled');
      activeMode = '';
      return 'Cancelled, Sir. Back to normal listening.';
    }
    const modeHit = Core.parseModeIntent ? Core.parseModeIntent(text) : null;
    // Explicit named-mode OFF ("turn off music mode", "stop gaming mode",
    // "exit conversation mode") is a deactivation, never an answer to the
    // mode's question and never a plain cancel of the workflow.
    if (modeHit && modeHit.mode === '__exit' && modeHit.extra && modeHit.extra.forMode) {
      const forMode = modeHit.extra.forMode;
      clearPendingQuestion('mode-exit');
      activeMode = '';
      if (forMode === 'music') { musicOpened = false; return 'Music mode off, Sir.'; }
      if (forMode === 'conversation') return 'Conversation mode off, Sir. Say "Jarvis" when you need me.';
      return 'Leaving that mode, Sir. Back to normal listening.';
    }
    if (modeHit && (modeHit.mode === '__exit' || (modeHit.mode && !modeHit.mode.startsWith('__') && modeHit.mode !== pq.mode))) {
      return runMode(modeHit.mode, modeHit.extra || {}, text, true);
    }
    if (modeHit && modeHit.mode === '__list') { clearPendingQuestion('superseded'); return Core.modeListText(); }
    if (modeHit && modeHit.mode === '__help') { clearPendingQuestion('superseded'); return Core.modeHelpText(modeHit.extra.forMode); }
    const words = lower.split(/\s+/).filter(Boolean);
    const markHandled = () => { pq.handled = true; clearPendingQuestion('answered'); };
    // --- expected-kind interpreters ---
    if (pq.expected === 'game') {
      // "No, that's all." ends the follow-up: brief acknowledgement, no new
      // question, state cleared so later chat is never trapped.
      if (/^(?:no|nope|nah|no thanks|no thank you|that's all|that is all|that's it|that is it|all done|all good|i'?m good|i'?m done|nothing else|no more|done|finished)\b/i.test(lead)) {
        markHandled();
        const closers = ['Understood, Sir. Enjoy your games.', 'Of course, Sir. Have fun.', 'Got it, Sir. The workspace stays ready.'];
        let cn = 0;
        try { cn = Number(localStorage.getItem('jarvis-mode-close') || 0) || 0; localStorage.setItem('jarvis-mode-close', String(cn + 1)); } catch {}
        return modeDone(closers[cn % closers.length]);
      }
      // "Open Roblox again." (and "roblox again", "reopen Roblox") reuses the
      // prepared Roblox destination through the existing tab-reuse path
      // (same-host tabs navigate in place, so no duplicates open). Other
      // named games keep the real app-launch path. A bare "Roblox" with no
      // verb still answers "which game?" via the launcher below.
      if (/\broblox\b/i.test(lead) && /(?:\bopen\b|\blaunch\b|\bstart\b|\bload\b|\bgo\b|\breopen\b|\bagain\b)/i.test(lead)) {
        markHandled();
        const r = await localAction({ action: 'open-site', name: 'roblox' });
        if (r && r.ok) return modeDone(r.reused ? 'Roblox is already open, Sir.' : 'Roblox is open, Sir.');
        return modeDone((r && r.message) || 'I could not open Roblox just now, Sir.');
      }
      const g = Core.parseModeGame ? Core.parseModeGame(lead) : null;
      if (g && !g.generic && !g.unsupported) {
        markHandled();
        const r = await launchGameByName(g.name);
        return modeDone(r.ok ? `${g.name} launching, Sir. ${r.message}` : r.message || `I could not start ${g.name}, Sir.`);
      }
      if (g && g.unsupported) { markHandled(); return modeDone(`${g.name} is mobile-only, Sir, so it cannot run on this PC. Pick a PC game and I will launch it.`); }
      if (g && g.generic) {
        markHandled();
        const r = await launchGameByName(g.name.replace(/\b\w/g, c => c.toUpperCase()));
        return modeDone(r.ok ? `${r.message}` : `I could not find "${g.name}" installed here, Sir. ${r.message || ''}`.trim());
      }
      if (/^(?:nothing|not (?:right )?now|later|skip|not really|just looking|browse|surprise me|you pick|anything)\b/i.test(lead)) {
        markHandled();
        return modeDone('No problem, Sir. Say a game any time and I will get it ready.');
      }
      if (words.length > 12 || Core.looksLikeDeterministicCommand(text)) { clearPendingQuestion('superseded-by-command'); return null; }
      // Ambiguous: keep the question alive once with a short clarification.
      Core.refreshPendingQuestion(pq, { now: Date.now() });
      setVoiceSession({ status: 'awaiting-answer', conversationActive: true, waitingFor: 'mode-answer', pendingKind: 'mode:' + pq.mode, lastQuestion: pq.question, expiresAt: pq.expiresAt }, 'mode-clarify');
      voiceLog('pending question clarified', `${pq.mode} - "${text.slice(0, 60)}"`);
      return modeAnswer('Which game should I launch, Sir — Roblox, Minecraft, or another title?');
    }
    if (pq.expected === 'song') {
      // Long text or a real command releases the question and routes normally
      // (unchanged behavior); everything short goes through the deterministic
      // music-answer classifier so hesitation ("Ugh", "um") can never become
      // a search query.
      if (words.length > 14 || Core.looksLikeDeterministicCommand(text)) { clearPendingQuestion('superseded-by-command'); return null; }
      const verdict = Core.classifyMusicAnswer ? Core.classifyMusicAnswer(text) : null;
      const unclear = Number(pq.clarifyCount || 0);
      if (!verdict || verdict.kind === 'filler' || verdict.kind === 'unsure') {
        Core.refreshPendingQuestion(pq, { now: Date.now() });
        pq.clarifyCount = unclear + 1;
        // Escalation: after several unclear replies in a row, stop repeating
        // open questions and offer the binary choice; after still more, close
        // politely instead of looping forever. Frustration is never consent.
        if (pq.clarifyCount >= 5) {
          markHandled();
          return modeDone("I'll leave music paused, Sir. Say 'music mode' any time you want a song.");
        }
        if (pq.clarifyCount >= 3) {
          return modeAnswer('Would you like me to pick a song, or should I leave music paused?');
        }
        const clarifications = verdict && verdict.kind === 'unsure'
          ? [
            'No worries, Sir. Want me to pick something, or name a mood?',
            'Take your time, Sir. Should I choose one, or do you have an artist in mind?',
            'No problem, Sir. Say a song, or tell me to pick for you.'
          ]
          : [
            "Sorry, Sir, I didn't catch that. Which song or artist would you like?",
            'No problem, Sir. Do you have a song in mind, or should I pick something?',
            'Take your time, Sir. What would you like to listen to?'
          ];
        let cn = 0;
        try { cn = Number(localStorage.getItem('jarvis-mode-clarify-song') || 0) || 0; localStorage.setItem('jarvis-mode-clarify-song', String(cn + 1)); } catch {}
        return modeAnswer(clarifications[cn % clarifications.length]);
      }
      pq.clarifyCount = 0;
      if (verdict.kind === 'cancel' || verdict.kind === 'nothing') {
        markHandled();
        return modeDone(verdict.kind === 'cancel'
          ? 'Cancelled, Sir. Back to normal listening.'
          : 'No problem, Sir. I will leave music paused. Say the word any time you want a song.');
      }
      if (verdict.kind === 'anything') {
        // Explicit permission to choose: open the music surface through the
        // existing integration (never search the literal word "anything").
        const r = await localAction({ action: 'open-site', name: 'youtube-music' });
        if (r && r.ok) {
          markHandled();
          return modeDone('YouTube Music is open, Sir. Name an artist any time and I will find it.');
        }
        Core.refreshPendingQuestion(pq, { now: Date.now() });
        return modeAnswer('I could not open YouTube Music just now, Sir. Name a song or artist instead?');
      }
      // Genuine request: the classifier already validated the title
      // ("Magnetic", "Magnetic by ILLIT", even "Play Ugh by BTS").
      const title = (verdict.title || lead).trim().slice(0, 120) || lead.trim().slice(0, 120);
      markHandled();
      const r = await localAction({ action: 'music-search', query: title });
      return modeDone(r && r.ok ? `Searching for "${title}" now, Sir.` : (r && r.message) || 'I could not search for that just now, Sir.');
    }
    if (pq.expected === 'activity') {
      const g = Core.parseModeGame ? Core.parseModeGame(lead) : null;
      if (g && !g.unsupported) { markHandled(); activeMode = 'gaming'; const r = await launchGameByName(g.generic ? g.name.replace(/\b\w/g, c => c.toUpperCase()) : g.name); return modeDone(r.ok ? `${r.message}` : r.message || 'I could not launch that, Sir.'); }
      if (/(?:watch|video|discover|youtube|movie|show)/i.test(lead)) {
        markHandled();
        const res = await handleDiscoveryBored(text);
        return modeDone(typeof res === 'string' ? `${res} The picks are on screen, Sir.` : 'Fresh picks are on screen, Sir. Say "open the first one" to watch.');
      }
      if (/(?:creat|writ|draw|design|build|brainstorm|idea)/i.test(lead)) { markHandled(); activeMode = 'creative'; return modeDone('Creative it is, Sir. What are we making — writing, designing, or building something?'); }
      if (/(?:game|play)/i.test(lead)) {
        activeMode = 'gaming';
        const q = nextModeQuestion('gaming');
        setPendingQuestion('gaming', 'game', q, { mode: 'gaming', intent: 'mode', conversationId: `mode-gaming-${Date.now()}` });
        return modeAnswer(`Gaming it is. ${q}`);
      }
      if (words.length > 12 || Core.looksLikeDeterministicCommand(text)) { clearPendingQuestion('superseded-by-command'); return null; }
      Core.refreshPendingQuestion(pq, { now: Date.now() });
      return modeAnswer('Game, video, or a creative project, Sir?');
    }
    // Free-text answers: subject, task, project, topic, writing,
    // presentation, priority, idea, content, social, workout, break,
    // winddown, feeling. Accept concise non-command replies.
    if (words.length >= 1 && words.length <= 30 && !Core.looksLikeDeterministicCommand(text)) {
      const ack = modeAckFor(pq.expected, lead);
      // A few answers deserve a real action, not just words.
      if (pq.expected === 'break' && /(?:music|song)/i.test(lead)) {
        markHandled();
        await localAction({ action: 'open-site', name: 'youtube-music' });
        return modeDone(`${ack} YouTube Music is open, Sir.`);
      }
      if (pq.expected === 'workout' && /(?:music|song)/i.test(lead)) {
        markHandled();
        await localAction({ action: 'open-site', name: 'youtube-music' });
        return modeDone(`${ack} Music is on, Sir.`);
      }
      if (pq.expected === 'winddown' && /(?:tomorrow|schedule)/i.test(lead)) {
        markHandled();
        try {
          const snap = await plannerSnapshot();
          const items = snap && snap.ok ? [...(snap.events || []).slice(0, 3).map(e => e.title || 'event')] : [];
          return modeDone(items.length ? `Tomorrow holds: ${items.join('; ')}, Sir. Rest well.` : 'Nothing confirmed for tomorrow, Sir. Rest well.');
        } catch { return modeDone('I could not read the schedule, Sir. Rest well.'); }
      }
      markHandled();
      return modeDone(ack);
    }
    // Anything else (long text, real commands): release the question and
    // route normally so unrelated chat is never trapped.
    clearPendingQuestion('superseded');
    return null;
  }
  // =====================================================================
  // Conversation follow-up bridge (2026-10-15). Both for one-shot posts
  // ("I'm sad." -> "Want to tell me what happened?" -> "My day was terrible...")
  // and for explicit Conversation Mode. The pending question arms the no-wake
  // word window; this resolver decides what the answer is worth:
  //   a real command   -> release and route normally,
  //   a chat closing   -> end the bridge politely,
  //   local tokens     -> library reply, bridge stays open,
  //   everything else  -> the local AI with the full conversation context.
  // =====================================================================
  async function resolveConversationFollowUp(text) {
    const pq = pendingQuestion;
    if (!pq || pq.handled) return null;
    if (Date.now() > pq.expiresAt) { clearPendingQuestion('expired'); return null; }
    const lead = Core.stripPoliteLead(text).replace(/[.!?]+$/, '').trim();
    // A genuine command is never swallowed by the chat:
    if (Core.looksLikeDeterministicCommand(text)) {
      clearPendingQuestion('superseded-by-command');
      if (pq.mode === 'conversation') activeMode = '';
      return null;
    }
    // Chat closings end the conversation cleanly (distinct from a cancel of
    // an actual command workflow returning a misleading 'nothing was created').
    if (Core.isPendingCancellation(text)
      || (pq.mode === 'conversation' && /^(?:exit(?: this| the)? mode|turn off|stop|disable)\b/i.test(lead))) {
      clearPendingQuestion('chat-ended');
      if (pq.mode === 'conversation') activeMode = '';
      setVoiceSession({ status: 'standby', conversationActive: false, waitingFor: '', pendingKind: '', lastQuestion: '', expiresAt: 0 }, 'chat-ended');
      return 'Right, Sir. Back to normal listening — say "Jarvis" when you need me.';
    }
    // A clear answer to a game question must use the real launcher. This is
    // the exact live failure: after "Which game were you thinking of playing?",
    // "I was thinking about roblox" went to the model and produced "Opening
    // Roblox for you" with no launch. Delegate to the existing expected-kind
    // interpreter so the action, its success and its failure are all real.
    if (pq.expected === 'game') {
      const game = Core.parseModeGame ? Core.parseModeGame(lead) : null;
      const noGame = /^(?:no|nope|nah|no thanks|no thank you|not really|nothing|that'?s all|that is all|that'?s it|all done|all good|i'?m good|i'?m done|nothing else|no more|done|finished)\b/i.test(lead);
      const deferred = /\b(?:later|not now|not yet|tomorrow|another time|some other time|maybe later|when i get home|after work|after school)\b/i.test(lead);
      const declined = /^(?:not|never)\b/i.test(lead)
        || /^(?:i\s+)?(?:hate|dislike)\b/i.test(lead)
        || /\b(?:don'?t|do not|not|never|no longer|stop)\b[^.!?]{0,40}\b(?:like|enjoy|love|play(?:ing)?|game|want|feel like|open|launch)\b/i.test(lead);
      if (noGame) {
        clearPendingQuestion('no-game');
        return 'Understood, Sir. Say a game any time and I will get it ready.';
      }
      if (deferred) {
        clearPendingQuestion('deferred-game');
        return 'No rush, Sir. Say the word when you want me to get a game ready.';
      }
      // Roblox Studio is an app, not the Roblox game; do not turn that answer
      // into a game launch. The general action-claim guard handles it instead.
      const robloxStudio = /\broblox\s+studio\b/i.test(lead);
      if (game && !game.generic && !declined && !robloxStudio) {
        voiceLog('conversation game answer launched', `${game.name} (${pq.intent})`);
        return handlePendingAnswer(text);
      }
    }
    // Local short tokens (yes/no/maybe/thanks/ok) stay on the deterministic
    // library path so they answer fast and stay consistent while the chat is
    // open. Longer emotional answers belong to the model.
    // In an active conversation, though, a bare "sure"/"yes"/"ok" is usually
    // the user answering the assistant's open question — routing it through the
    // local canned-reply table ("Understood, Sir.") discards the context and
    // makes JARVIS sound like it forgot what it asked. Route those through the
    // AI instead, so the reply references what was actually discussed.
    const inConversation = pq.mode === 'conversation' || pq.intent === 'conversation';
    const local = conversationLibrary ? Core.replyLocally(text, conversationHistory, conversationLibrary, loadJson('jarvis-recent-local-replies', [])) : null;
    const LOCAL_TOKEN_INTENTS = new Set(['short_yes', 'short_no', 'short_maybe', 'acknowledgement', 'thanks', 'politeness_youre_welcome', 'politeness_thank_user', 'politeness_good_job', 'goodbye']);
    if (local && LOCAL_TOKEN_INTENTS.has(local.intentId) && !inConversation) {
      const recent = loadJson('jarvis-recent-local-replies', []); recent.push(local.response);
      localStorage.setItem('jarvis-recent-local-replies', JSON.stringify(recent.slice(-12)));
      keepConversationWindow(local.response, pq, 'token-answered');
      return local.response;
    }
    // An active emotional thread continues through the shared engine first, so
    // the follow-up answers what the user was saying instead of restarting it.
    if (emotionalState && Core.emotionalStateActive(emotionalState)) {
      const emotional = Core.considerEmotionalTurn(emotionalState, text);
      if (emotional) {
        emotionalState = emotional.state;
        if (Number(emotional.analysis?.confidence || emotional.state?.confidence || 0) >= 0.42) { applyUserMood(emotional.analysis?.primaryId || emotional.state?.primaryId || emotional.state?.family || ''); }
        voiceLog('emotional follow-up', `${emotional.mode}`);
        if (emotional.reply) {
          const recent = loadJson('jarvis-recent-local-replies', []); recent.push(emotional.reply);
          localStorage.setItem('jarvis-recent-local-replies', JSON.stringify(recent.slice(-12)));
          keepConversationWindow(emotional.reply, pq, 'emotional-answered');
          return emotional.reply;
        }
        if (emotional.aiQuery) {
          Core.refreshPendingQuestion(pq, { now: Date.now() });
          return { aiQuery: emotional.aiQuery, conversationBridge: true, emotionalContext: Core.emotionalPromptContext(emotionalState) };
        }
      }
    }
    // Everything else continues the conversation through the configured local
    // AI with the full chat context already attached by the request pipeline.
    // `conversationBridge` asks ask() to renew the window AFTER that (possibly
    // slow) generation finishes, so a long model answer can never strand the
    // user without the no-wake-word follow-up they were promised.
    Core.refreshPendingQuestion(pq, { now: Date.now() });
    return { aiQuery: text, conversationBridge: true };
  }
  function modeAckFor(expected, answer) {
    const short = String(answer || '').slice(0, 80);
    const table = {
      subject: [`${short} it is, Sir. Let us start — what is the first thing to tackle?`, `${short} noted, Sir. We will work through it together.`],
      task: [`${short} — understood, Sir. Let us keep this session tight and distraction-free.`, `Locked in on ${short}, Sir.`],
      project: [`${short} — got it, Sir. Describe the current blocker or what is next.`, `Working on ${short}, Sir. What needs attention first?`],
      topic: [`${short} — good topic, Sir. I will dig in with the browser and local AI.`, `Researching ${short}, Sir. Give me a moment to gather context.`],
      writing: [`${short} — understood, Sir. Tell me the key points to include.`, `Writing: ${short}, Sir. What should it cover first?`],
      presentation: [`${short} — noted, Sir. Who is the audience and how many slides?`, `Presenting ${short}, Sir. Let us outline it together.`],
      priority: [`${short} — top priority set, Sir.`, `Understood, Sir: ${short} comes first today.`],
      idea: [`${short} — I like it, Sir. Let us develop that further.`, `Noted, Sir — ${short}. What is the next piece?`],
      content: [`${short} — understood, Sir. Outline, script, or editing help next?`, `Planning ${short}, Sir. What stage are we at?`],
      social: [`Understood, Sir. Tell me who to message and what to say, and I will draft it.`, `Got it, Sir. Discord is ready when you are.`],
      workout: [`${short} — good choice, Sir. Warm up well and keep it steady.`, `Session set: ${short}, Sir. Enjoy it.`],
      break: [`Enjoy the break, Sir.`, `Understood, Sir — take your time.`],
      winddown: [`Understood, Sir. Winding down now.`, `Of course, Sir. Quiet evening it is.`],
      feeling: ['I hear you, Sir. I am here as long as you need.', 'Understood, Sir. Take all the time you need — say the word and we will redirect.'],
    };
    const list = table[expected] || [`Noted, Sir: ${short}.`, `Understood, Sir.`];
    let n = 0;
    try { n = Number(localStorage.getItem('jarvis-mode-ack') || 0) || 0; localStorage.setItem('jarvis-mode-ack', String(n + 1)); } catch {}
    return list[n % list.length];
  }
  // =====================================================================
  // Social greetings (2026-10-14). Centralized recognition lives in
  // Core.parseGreetingIntent; here we only pick the address, personality and
  // variation, then publish the shared pending question whenever the reply
  // asks the user something back (so "Pretty good." is accepted without a
  // second wake word).
  // =====================================================================
  let greetingVariant = 0;
  function personalityStyle() {
    try { return localStorage.getItem('jarvis-personality') || 'professional'; } catch { return 'professional'; }
  }
  function answerGreeting(greeting, source) {
    const at = Date.now();
    const variant = greetingVariant++;
    const composed = Core.composeGreetingReply(greeting, { address: preferredName(), style: personalityStyle(), variant, now: new Date(at) });
    const tone = companionTone('greeting');
    if (composed.asks && !pendingFlow) {
      setPendingQuestion('greeting', 'wellbeing', composed.text, {
        intent: 'greeting',
        requiredField: 'wellbeing',
        conversationId: `greeting-${at}`,
        waitingFor: 'wellbeing',
        collected: { form: greeting.form, timeOfDay: composed.timeOfDay, source: source || 'voice' },
        context: { userSaid: greeting.transcript, askedAt: at },
        ttlMs: 5000
      });
    } else if (!pendingFlow) {
      clearPendingQuestion('greeting-no-question');
    }
    // When a calendar/email/Discord flow is already waiting, its state is
    // left untouched: the flow keeps its collected fields and its own
    // follow-up window, and the next answer still resolves against it.
    return {
      response: composed.text,
      speech_text: composed.text,
      emotion: tone.emotion,
      emotion_intensity: tone.intensity,
      speaking_style: 'conversational',
      speaking_rate: 1,
      pause_hints: [],
      pronunciation_hints: {},
      followUp: composed.asks,
      followUpMs: 5000
    };
  }
  // The user answered JARVIS's own greeting question. Returns null to release
  // the state and route the utterance normally (new request, real question).
  function resolveGreetingAnswer(text, pq) {
    const raw = String(text || '').trim().replace(/^[,\s]+/, '').replace(/[.!?]+$/, '').trim();
    if (!raw) { Core.refreshPendingQuestion(pq, { now: Date.now() }); return 'Could you say that again, Sir?'; }
    const composed = Core.composeGreetingFollowUp(raw, { address: preferredName(), style: personalityStyle(), variant: greetingVariant++ });
    // Only a clear weather/statement-style reply counts as an answer. Anything
    // that is really a new request was already handled by the caller.
    Core.markPendingQuestionHandled(pq);
    clearPendingQuestion('greeting-answered');
    const tone = wellbeingAckTone(raw);
    return { response: composed.text, speech_text: composed.text, emotion: tone.emotion, emotion_intensity: tone.intensity, speaking_rate: 1, pause_hints: [], pronunciation_hints: {} };
  }
  // Late answers to JARVIS's own wellbeing question: the pending record lives
  // five seconds from the end of playback, but the exchange is still the last
  // thing in the history. Recognising it lets the app answer with the same
  // sentiment composer instead of handing "I am doing good." to the model,
  // which used to see its own question and ask it again.
  function lastAssistantAskedWellbeingRecently() {
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const item = conversationHistory[i];
      if (!item) continue;
      if (item.who === 'YOU' || item.role === 'user') continue;
      const at = Number(item.at) || 0;
      if (!at || Date.now() - at > (Core.PENDING_QUESTION_MAX_WINDOW_MS || 60000)) return false;
      return Core.looksLikeWellbeingQuestion ? Core.looksLikeWellbeingQuestion(item.text) : false;
    }
    return false;
  }
  // =====================================================================
  // Shared pending-question resolver. One entry point for every workflow
  // that is waiting for a field: greetings, voice modes, alarms, reminders
  // and planner clarifications. Returns null to release the state and route
  // the utterance normally.
  // =====================================================================
  async function resolvePendingQuestion(rawText) {
    const pq = pendingQuestion;
    if (!pq) return null;
    const now = Date.now();
    if (!Core.pendingQuestionActive(pq, now)) { clearPendingQuestion('expired'); return null; }
    const text = String(rawText || '').trim();
    if (!text) return null;
    if (Core.isPendingCancellation(text)) {
      const isChat = pq.intent === 'conversation' || pq.kind === 'conversation';
      clearPendingQuestion('cancelled');
      setVoiceSession({ status: 'standby', conversationActive: false, waitingFor: '', pendingKind: '', lastQuestion: '', expiresAt: 0 }, 'question-cancelled');
      if (isChat) return 'Right, Sir. Back to normal listening — say "Jarvis" when you need me.';
      return 'Cancelled, Sir. Nothing was created.';
    }
    // A brand-new request wins over an old question; never apply an unrelated
    // answer to a stale workflow.
    if (Core.pendingAnswerIsNewRequest(text)) {
      voiceLog('pending question released for new request', `${pq.intent} - ${text.slice(0, 60)}`);
      clearPendingQuestion('new-request');
      return null;
    }
    // A fresh greeting while a different question is pending is a new request
    // too: "Good morning, Jarvis." must be answered as a greeting, not stored
    // as the answer to "what game should I launch?". While JARVIS's own
    // wellbeing question is pending, however, a greeting-shaped reply ("How
    // are you?", "I am fine, and you?") is the answer: releasing it would
    // restart the greeting and ask the same question again.
    const greetingPending = pq.kind === 'greeting' || pq.intent === 'greeting';
    if (!greetingPending && Core.parseGreetingIntent) {
      const incomingGreeting = Core.parseGreetingIntent(text, new Date(now));
      if (incomingGreeting) {
        voiceLog('pending question released for new greeting', `${pq.intent} - ${text.slice(0, 60)}`);
        clearPendingQuestion('new-greeting');
        return null;
      }
    }
    if (greetingPending) return resolveGreetingAnswer(text, pq);
    // Follow-up conversation bridge answers ("My day at school was terrible.")
    // continue the chat instead of falling through to unrelated command routing.
    if (pq.intent === 'conversation' || pq.kind === 'conversation') return resolveConversationFollowUp(text);
    if (pq.intent === 'alarm' || pq.intent === 'reminder') return resolveAlarmAnswer(text, pq);
    // Voice-mode questions keep their existing resolver (it understands game,
    // song and free-text answers); they now simply share one record.
    if (pq.mode) return resolveModeAnswer(text);
    // Unknown kind: release rather than trapping the user.
    clearPendingQuestion('unsupported');
    return null;
  }
  // Alarm / reminder clarification. The pending question carries the intent
  // payload so a bare "PM" or a fresh "half past seven" both resolve against
  // the same saved state.
  async function resolveAlarmAnswer(text, pq) {
    const collected = pq.collected || {};
    const isReminder = pq.intent === 'reminder' || pq.kind === 'reminder';
    const label = isReminder ? 'reminder' : 'alarm';
    const raw = String(text || '').trim().replace(/^[,\s]+/, '').replace(/[.!?]+$/, '').trim();
    if (!raw) { Core.refreshPendingQuestion(pq, { now: Date.now() }); return withFollowUp(pq.question); }
    let hour = null, minute = 0;
    const meridiem = Core.parseMeridiemAnswer(raw);
    if (meridiem) {
      hour = collected.hour != null ? Number(collected.hour) : (collected.ambiguousHour != null ? Number(collected.ambiguousHour) : null);
      minute = collected.minute != null ? Number(collected.minute) : 0;
      if (hour == null || !Number.isFinite(hour)) {
        Core.refreshPendingQuestion(pq, { now: Date.now() });
        return withFollowUp(`Which hour should the ${label} use, Sir?`);
      }
      hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
    } else {
      const parsed = Core.parseNaturalTime(Core.normalizeTimeWords ? Core.normalizeTimeWords(raw) : raw);
      if (!parsed) { Core.refreshPendingQuestion(pq, { now: Date.now() }); return withFollowUp(pq.question); }
      if (parsed.error) { Core.refreshPendingQuestion(pq, { now: Date.now() }); return withFollowUp('That time does not look valid, Sir. What time should I use?'); }
      if (parsed.ambiguous) {
        // Never silently guess AM/PM: ask once, keep everything collected.
        Core.refreshPendingQuestion(pq, {
          question: `Did you mean ${parsed.hour}:${String(parsed.minute).padStart(2, '0')} AM or PM?`,
          requiredField: 'meridiem',
          collected: { ambiguousHour: parsed.hour, minute: parsed.minute },
          now: Date.now()
        });
        setVoiceSession({ status: 'awaiting-answer', conversationActive: true, waitingFor: 'meridiem', pendingKind: 'question:' + pq.intent, lastQuestion: pendingQuestion.question, expiresAt: pendingQuestion.expiresAt }, 'question-clarified');
        return withFollowUp(pendingQuestion.question);
      }
      hour = parsed.hour; minute = parsed.minute;
    }
    const base = collected.date ? new Date(collected.date) : Core.parseNaturalDate(raw, new Date());
    base.setHours(hour, minute, 0, 0);
    const now = new Date();
    if (base <= now && !/tomorrow|next\s+/i.test(String(collected.date || ''))) base.setDate(base.getDate() + 1);
    Core.markPendingQuestionHandled(pq);
    clearPendingQuestion(isReminder ? 'reminder-resolved' : 'alarm-resolved');
    setVoiceSession({ status: 'standby', conversationActive: false, waitingFor: '', pendingKind: '', lastQuestion: '', expiresAt: 0 }, 'question-completed');
    const payload = isReminder
      ? { action: 'create-reminder', when: base.toISOString(), title: collected.title || 'Reminder' }
      : { action: 'create-alarm', when: base.toISOString(), repeat: collected.repeat || 'none', title: collected.title || 'JARVIS alarm' };
    const result = await plannerRequest(payload);
    updatePlannerCard();
    if (!result.ok) return result.message || `I could not save that ${label}, Sir.`;
    const saved = result.alarm || result.reminder;
    lastPlannerItemId = saved && saved.id ? saved.id : '';
    return `${isReminder ? 'Reminder' : 'Alarm'} saved for ${formatPlannerDate(saved && saved.when ? saved.when : base.toISOString())}${!isReminder && collected.repeat === 'weekdays' ? ' on weekdays' : ''}.`;
  }
  // =====================================================================
  // QUESTION-BASED REMINDER SETUP.
  // The old "remind me ... " parser answered a stateless clarification, so
  // the AM/PM answer was lost. Incomplete reminder requests now arm the
  // shared pending question and collect the missing part.
  // =====================================================================
  // =====================================================================
  // REMINDER SETUP.
  // "Remind me tomorrow at seven PM to study math" and "remind me to study
  // math at 7" are the same request said two ways. Complete requests are
  // saved immediately; a missing or ambiguous time arms the shared pending
  // question instead of answering a clarification nobody can follow up on.
  // =====================================================================
  function reminderTimeMatch(rest) {
    // Word-numbers first ("seven" -> "7") so spoken times match; matching and
    // title-stripping both run on the normalized text.
    const normalized = Core.normalizeTimeWords ? Core.normalizeTimeWords(rest) : rest;
    const pattern = /\b(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|half\s+past\s+\d{1,2}|quarter\s+past\s+\d{1,2}|noon|midnight)(?:\s+(?:in\s+the\s+(?:morning|afternoon|evening|night)))?\b/i;
    const match = normalized.match(pattern);
    if (!match) return null;
    return { match: match[0], timeText: match[0].replace(/^\s*at\s+/i, ''), normalized };
  }
  function startReminderFlow(rawText) {
    const source = Core.stripPoliteLead(String(rawText || '')).replace(/[?!.]+$/, '').trim();
    const head = source.match(/^remind\s+me\s+(?:to\s+)?(.*)$/i);
    if (!head) return null;
    // Normalize spoken numbers once so "seven", "at seven" and "at 7" behave
    // identically below.
    let rest = Core.normalizeTimeWords ? Core.normalizeTimeWords((head[1] || '').trim()) : (head[1] || '').trim();
    if (!rest) return null;
    const relative = rest.match(/\bin\s+(\d+)\s+minutes?\b/i);
    if (relative && Number.isFinite(Number(relative[1]))) {
      const title = rest.replace(relative[0], ' ').replace(/\s+/g, ' ').replace(/^(?:to|that|about)\s+/i, '').trim();
      if (!title) return null;
      return { ready: { when: new Date(Date.now() + Number(relative[1]) * 60000).toISOString(), title } };
    }
    const timeHit = reminderTimeMatch(rest);
    const dateText = rest.match(/\b(?:day after tomorrow|today|tomorrow|tonight|(?:next|on|this)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i);
    let title = rest;
    if (timeHit) title = title.replace(timeHit.match, ' ');
    if (dateText) title = title.replace(dateText[0], ' ');
    title = title.replace(/\s+/g, ' ').trim().replace(/^(?:to|that|about|for)\s+/i, '').replace(/\s+(?:to|that|about|for)$/i, '').trim();
    const cleanTitle = title.replace(/^[,;:.\-\s]+|[,;:.\-\s]+$/g, '').trim() || 'Reminder';
    const dateIso = dateText ? Core.parseNaturalDate(dateText[0], new Date()).toISOString() : '';
    if (timeHit) {
      const parsed = Core.parseNaturalTime(timeHit.timeText);
      if (parsed && !parsed.error && !parsed.ambiguous) {
        const base = dateText ? Core.parseNaturalDate(dateText[0], new Date()) : new Date();
        base.setHours(parsed.hour, parsed.minute, 0, 0);
        if (base <= new Date()) base.setDate(base.getDate() + 1);
        return { ready: { when: base.toISOString(), title: cleanTitle } };
      }
      const question = parsed && parsed.ambiguous
        ? `Did you mean ${parsed.hour}:${String(parsed.minute).padStart(2, '0')} AM or PM?`
        : 'What time should I remind you, Sir? Include AM or PM.';
      setPendingQuestion('reminder', parsed && parsed.ambiguous ? 'meridiem' : 'time', question, {
        intent: 'reminder', requiredField: parsed && parsed.ambiguous ? 'meridiem' : 'time',
        conversationId: `reminder-${Date.now()}`,
        collected: parsed && parsed.ambiguous
          ? { title: cleanTitle, date: dateIso, ambiguousHour: parsed.hour, minute: parsed.minute }
          : { title: cleanTitle, date: dateIso },
        context: { askedFor: 'reminder time', dateText: dateText ? dateText[0] : '' },
        ttlMs: 5000
      });
      return { question };
    }
    // No time at all: ask for it and keep everything else.
    setPendingQuestion('reminder', 'time', 'What time should I remind you, Sir? Include AM or PM.', {
      intent: 'reminder', requiredField: 'time',
      conversationId: `reminder-${Date.now()}`,
      collected: { title: cleanTitle, date: dateIso },
      context: { askedFor: 'reminder time', dateText: dateText ? dateText[0] : '' },
      ttlMs: 5000
    });
    return { question: 'What time should I remind you, Sir? Include AM or PM.' };
  }
  // Resolve "close <name>" against the CONTROLLED BROWSER tabs before the
  // generic process finder sees it. Two paths, in order:
  //  1. A pending tab action exists → treat this as its answer (ordinal
  //     selections, corrections, and full re-phrasings all resolve here).
  //  2. No pending action → match the live tab inventory directly, so
  //     "close the Tick-Tack dance" works even as a first, standalone request.
  // Returns a reply string when a tab was targeted/closed, or null to let the
  // caller continue with application/process resolution.
  async function resolveTabAnswerForClose(name) {
    const answer = String(name || '').trim();
    if (!answer) return null;
    const cancelled = /^(?:cancel|never mind|nevermind|nothing|forget it|stop)$/i.test(answer);
    if (cancelled && pendingTabActive()) {
      clearPendingTabAction('user cancelled');
      return 'Cancelled, Sir. I left every tab open.';
    }
    let listed = null;
    try { listed = await localAction({ action: 'tabs-list' }); } catch { listed = null; }
    if (!listed || !listed.ok || !Array.isArray(listed.tabs)) return null;

    // Path 1: answer to a question we already asked.
    if (pendingTabActive()) {
      const candidates = pendingTabAction.candidates;
      // "both" / "all of them" / "every one" closes EVERY tab we offered:
      // the user has already told us which list they meant, so asking again
      // is exactly the loop that used to end in a fabricated "Closed both".
      if (candidates && candidates.length > 1 &&
        /^(?:both|all|all\s+of\s+(?:it|them)|every\s*one(?:\s+of\s+(?:it|them))?|them|they|each|everything|those)$/i.test(String(answer || '').trim())) {
        // The offered list may name a website that also has a desktop app
        // (Roblox). Close the tabs first, then the matching app, and report
        // both verifiable outcomes.
        const originalQuery = pendingTabAction.originalQuery;
        const closedTabs = await closeChosenTabs(candidates);
        const appNotes = await closeNamedApps(originalQuery);
        return [closedTabs, ...appNotes].filter(Boolean).join(' ');
      }
      // "the second one" / "the last one" pick from the list we just read out.
      const ordinal = Core.parseOrdinalTarget(answer);
      if (ordinal) {
        const idx = ordinal.last ? candidates.length - 1 : Number(ordinal.position) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < candidates.length) {
          return closeChosenTab(candidates[idx], pendingTabAction);
        }
        return `You had ${candidates.length} choices, Sir, so “${answer}” does not match one. Say cancel to stop, or name the tab.`;
      }
      // Re-score the user's own words against the candidates we offered.
      const ranked = Core.matchBrowserTabs(candidates, answer);
      if (ranked.best) {
        const top = ranked.scored[0], second = ranked.scored[1];
        const clear = !second || top.score - second.score >= 15 || (second.score / Math.max(1, top.score)) < 0.75;
        if (clear) return closeChosenTab(top.tab, pendingTabAction);
      }
      // Not decisive: fall through to the live inventory, which may now
      // contain a clearer match than the snapshot we asked about.
    }

    // Path 2: match the live inventory.
    const ranked = Core.matchBrowserTabs(listed.tabs, answer);
    if (!ranked.best) return null;
    const top = ranked.scored[0], second = ranked.scored[1];
    const clear = !second || top.score - second.score >= 15 || (second.score / Math.max(1, top.score)) < 0.75;
    if (!clear) {
      // Genuinely ambiguous: ask once, remembering the candidates.
      armPendingTabAction({ originalQuery: answer, candidates: ranked.matches, question: '' });
      return `I found ${ranked.matches.length} tabs matching “${answer}”: ${ranked.matches.slice(0, 4).map(t => t.title).join(', ')}. Which one should I close?`;
    }
    return closeChosenTab(top.tab, null);
  }
  // Close one specific tab, re-validating its identity immediately beforehand
  // because tabs may have changed since the question was asked. With
  // `detailed`, the caller gets { ok, message, title } instead of only prose so
  // a multi-close summary can count real successes rather than parse strings.
  async function closeChosenTab(tab, action, detailed = false) {
    const title = String(tab?.title || '').trim();
    const url = String(tab?.url || '').trim();
    const fail = message => detailed ? { ok: false, message, title } : message;
    voiceLog('closing chosen tab', title.slice(0, 80));
    // Re-validate: the tab must still be open and still be this page.
    let live = null;
    try { live = await localAction({ action: 'tabs-list' }); } catch { live = null; }
    if (!live || !live.ok || !Array.isArray(live.tabs)) {
      return fail('I could not reach the controlled browser to verify that tab, Sir. Nothing was closed.');
    }
    const stillOpen = live.tabs.find(t => (tab.id && t.id === tab.id) || (url && String(t.url || '') === url));
    if (!stillOpen) {
      clearPendingTabAction('tab no longer open');
      return fail(`“${title || 'That tab'}” is no longer open, Sir. Nothing was closed.`);
    }
    const result = await localAction({ action: 'tabs-close', tabId: stillOpen.id });
    // ok:true used to be returned even when the close could not be verified,
    // which let the page say "Closed" while the tab was still on screen. Only
    // a verified close is a success now.
    if (!result.ok || result.verified === false) {
      clearPendingTabAction('close failed');
      return fail(result.message || `I could not close “${title || 'that tab'}”, Sir.`);
    }
    clearPendingTabAction('closed');
    lastTabCloseAt = Date.now();
    if (stillOpen.url && /^https?:\/\//i.test(String(stillOpen.url))) {
      lastClosedTabs.unshift({ title: String(stillOpen.title || ''), url: String(stillOpen.url || ''), at: Date.now() });
      lastClosedTabs = lastClosedTabs.slice(0, 10);
    }
    voiceLog('tab closed', String(stillOpen.title || '').slice(0, 80));
    const message = `Closed “${String(stillOpen.title || 'that tab')}”, Sir.`;
    return detailed ? { ok: true, message, title: String(stillOpen.title || title) } : message;
  }
  // MULTI-TAB CLOSE (2026-10-22). "Close roblox and canva tabs" used to be
  // scored as ONE fuzzy query, land on "which one should I close?", and then
  // the follow-up answer "both" fell through to the AI - which happily
  // REPLIED "Closed both" without a single tab being touched. Every close
  // below is verified on its own, and the summary only ever claims the tabs
  // that actually closed.
  // "roblox and canva", "roblox, canva" -> [roblox, canva]. Names that do
  // not survive on their own ("simon and garfunkel") never split, so a
  // single genuine query is left alone.
  function splitTabQueries(query) {
    const text = String(query || '').trim();
    if (!text || !/\s(?:and|with)\s|\s*,\s*|&/i.test(text)) return [];
    const parts = text
      .split(/\s+(?:and|with)\s+|\s*,\s*|&/i)
      .map(part => part.replace(/^(?:the|those|these|my)\s+/i, '').replace(/\s+(?:tabs?|ones?)$/i, '').trim())
      .filter(part => part.length > 1 && !/^(?:both|all|any|them|each|every|other|tabs?|ones?)$/i.test(part));
    return parts.length > 1 ? parts : [];
  }
  // Closes several tabs by identity. Each one is re-validated and verified by
  // the browser itself, so the reply is a report, never a promise.
  async function closeChosenTabs(list) {
    const targets = (Array.isArray(list) ? list : []).filter(tab => tab && (tab.id || tab.url));
    if (!targets.length) return 'I have no tabs to close, Sir.';
    const done = [], failed = [];
    for (const tab of targets) {
      const title = String(tab.title || tab.url || 'that tab');
      const outcome = await closeChosenTab(tab, null, true);
      if (outcome && outcome.ok) done.push(outcome.title || title);
      else failed.push(`${title}: ${String((outcome && outcome.message) || 'the close failed').replace(/\s+Sir\.?$/i, '')}`);
      if (done.length + failed.length < targets.length) await new Promise(resolve => setTimeout(resolve, 350));
    }
    if (!done.length) return `I could not close those tabs, Sir. ${failed.join('; ')}`;
    const summary = done.length === 1 ? `Closed the “${done[0]}” tab, Sir.`
      : `Closed ${done.length} tabs, Sir: ${done.map(name => `“${name}”`).join(', ')}.`;
    return failed.length ? `${summary} I could not close: ${failed.join('; ')}.` : summary;
  }
  // A request that names more than one tab. Returns the reply when every name
  // resolved to a different open tab (and they were all closed), or null so
  // the caller falls back to the normal single-query flow.
  // Apps mentioned in the most recent multi-open, so "close both" / "close
  // 1 and 2" has something real to act on.
  let lastOpenedApps = [];
  let notFoundCount = 0;
  // Display names for confirmations. Passing the raw target into a reply gave
  // "youtube music is open, Sir." — lower-case and machine-like.
  const PRETTY_NAMES = {
    youtube: 'YouTube', 'youtube music': 'YouTube Music', 'youtube-music': 'YouTube Music', 'yt music': 'YouTube Music',
    google: 'Google', gmail: 'Gmail', docs: 'Google Docs', 'google docs': 'Google Docs', drive: 'Google Drive',
    roblox: 'Roblox', discord: 'Discord', tiktok: 'TikTok', steam: 'Steam', valorant: 'VALORANT',
    spotify: 'Spotify', canva: 'Canva', minecraft: 'Minecraft', chrome: 'Chrome', 'google chrome': 'Google Chrome',
    edge: 'Edge', 'microsoft edge': 'Microsoft Edge', notepad: 'Notepad', calculator: 'Calculator',
    'file explorer': 'File Explorer', 'task manager': 'Task Manager', 'snipping tool': 'Snipping Tool',
    netflix: 'Netflix', twitch: 'Twitch', reddit: 'Reddit', notion: 'Notion', figma: 'Figma', github: 'GitHub',
    chatgpt: 'ChatGPT', 'google slides': 'Google Slides', 'google sheets': 'Google Sheets', 'google drive': 'Google Drive',
    'google forms': 'Google Forms', 'google classroom': 'Google Classroom', 'google maps': 'Google Maps',
    'google keep': 'Google Keep', 'google meet': 'Google Meet', 'google calendar': 'Google Calendar'
  };
  function humanLabel(name) {
    const key = String(name || '').trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
    if (!key) return '';
    if (PRETTY_NAMES[key]) return PRETTY_NAMES[key];
    return key.replace(/\b[a-z]/g, letter => letter.toUpperCase());
  }
  // Remember what was actually opened, apps AND websites, so "close it",
  // "close both" and "close everything" have a real list to act on. Before
  // this only desktop apps were remembered: four freshly opened sites plus
  // "close everything" answered "I do not have a recent list to close".
  function rememberOpenedTarget(name) {
    const label = String(name || '').trim();
    if (!label) return;
    const key = label.toLowerCase();
    lastOpenedApps = [...lastOpenedApps.filter(item => String(item).toLowerCase() !== key), label].slice(-6);
  }
  // One spelling of a close command for every branch below: "hush google",
  // "you close Discord", "kill notepad" all become "close ...".
  function normalizeCloseText(value) {
    return Core.stripPoliteLead(value)
      .replace(/^(?:hush|kill|terminate|dismiss|get\s+rid\s+of|shut\s+down)\b/i, 'close')
      .replace(/[.!?]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function rememberedCloseTargets(name) {
    // "close both", "close both of them", "close them all", "close the apps I
    // just opened", "close 1 and 2", "close the first two" all refer to the
    // apps from the last multi-open — never to a program literally named
    // "both". Unrecognised wording returns null so ordinary names still go to
    // the real resolver untouched.
    const text = String(name || '').toLowerCase()
      .replace(/[.!?]+$/, '')
      .replace(/\b(?:apps?|windows?|programs?)\b/g, ' ')
      .replace(/\b(?:of them|of those|of these|i just opened|i opened|that i opened|just opened|again)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (!text || !lastOpenedApps.length) return null;
    // "close it" / "close that" right after "open my steam" means that app.
    if (/^(?:it|that|that one|that app|this|this one|the app|the same one)$/.test(text)) return [lastOpenedApps[lastOpenedApps.length - 1]];
    if (/^(?:both|all|them|those|these|everything|every ?one|the ones|the list|each one|both of them|all of them)$/.test(text)) return lastOpenedApps.slice();
    const words = text
      .replace(/^(?:the|my|both|all|those|these)\s+/, '')
      .replace(/\band\b/gi, ' ').replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    const ordinals = { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8 };
    const numbers = words.filter(word => ordinals[word]);
    // Every word must be an ordinal/number ("1 and 2", "the first two"), and
    // "first" alone means the first one only. Anything else is a real name.
    if (numbers.length && numbers.length === words.length) {
      const picks = numbers.map(word => lastOpenedApps[ordinals[word] - 1]).filter(Boolean);
      return picks.length ? Array.from(new Set(picks)) : null;
    }
    return null;
  }
  // Closing every tab must never close JARVIS's own HUD tab. The bridge serves
  // the interface on 52213; a browser tab pointed there (or titled JARVIS) is
  // the assistant itself, not user content.
  function isJarvisOwnTab(tab) {
    const url = String((tab && tab.url) || '');
    const title = String((tab && tab.title) || '');
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost):5221[0-9]\b/i.test(url)) return true;
    if (/^file:\/\/.*jarvis/i.test(url)) return true;
    return /\bj\.?a\.?r\.?v\.?i\.?s\b/i.test(title);
  }
  async function closeMultipleNamedTabs(query) {
    const parts = splitTabQueries(query);
    if (parts.length < 2) return null;
    let listed = null;
    try { listed = await localAction({ action: 'tabs-list' }); } catch { listed = null; }
    if (!listed || !listed.ok || !Array.isArray(listed.tabs) || !listed.tabs.length) return null;
    // Every name must resolve to a DIFFERENT open tab, otherwise this is one
    // query ("simon and garfunkel") and the single-query path owns it.
    const picks = [];
    const used = new Set();
    for (const part of parts) {
      const cluster = Core.resolveSiteCluster ? Core.resolveSiteCluster(listed.tabs, part) : { tabs: [] };
      const top = cluster.tabs.length
        ? { tab: cluster.tabs[0], score: 1 }
        : (Core.matchBrowserTabs(listed.tabs, part).scored[0] || null);
      if (!top || !top.tab || !(top.score > 0)) return null;
      const identity = String(top.tab.id || top.tab.url || '');
      if (!identity || used.has(identity)) return null;
      used.add(identity);
      picks.push(top.tab);
    }
    if (picks.length < 2) return null;
    // Each name goes through the server's close resolver, so "close youtube
    // and youtube music" closes every tab of BOTH sites instead of picking
    // one tab per name and leaving the rest open.
    const notes = [];
    for (const part of parts) {
      const closed = await localAction({ action: 'tabs-close', query: part });
      if (closed && closed.message) notes.push(closed.message);
    }
    voiceLog('closing several sites at once', parts.join(' | '));
    return notes.length ? notes.join(' ') : null;
  }
  // Bulk close helpers shared by the normal close route and compound chains.
  // They use only the existing bridge actions, verify each close, and report
  // the real outcome instead of assuming the whole batch succeeded.
  async function closeAllTabsNow() {
    const listed = await localAction({ action: 'tabs-list' });
    if (!listed || !listed.ok) return { ok: false, message: (listed && listed.message) || 'I could not list the open tabs, Sir.' };
    const allTabs = Array.isArray(listed.tabs) ? listed.tabs : [];
    const ownTabs = allTabs.filter(isJarvisOwnTab);
    const tabs = allTabs.filter(tab => tab && tab.id && !isJarvisOwnTab(tab));
    if (!tabs.length) return { ok: false, message: 'There are no browser tabs I can close, Sir.' };
    const closed = [], failed = [];
    for (const tab of tabs) {
      const result = await localAction({ action: 'tabs-close', tabId: tab.id });
      const label = String(tab.title || tab.url || 'tab').trim();
      if (result && result.ok) {
        closed.push(label);
        if (/^https?:\/\//i.test(String(tab.url || ''))) {
          lastClosedTabs.unshift({ title: String(tab.title || ''), url: String(tab.url || ''), at: Date.now() });
          lastClosedTabs = lastClosedTabs.slice(0, 10);
        }
      } else {
        failed.push(`${label}: ${(result && result.message) || 'it stayed open'}`);
      }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    if (closed.length) { lastTabCloseAt = Date.now(); clearPendingTabAction('closed'); }
    const ownNote = ownTabs.length ? ' I left my own JARVIS window open.' : '';
    if (!closed.length) return { ok: false, message: `I could not close any tabs, Sir.${ownNote} ${failed.join('; ')}`.trim() };
    const summary = `Closed ${closed.length} ${closed.length === 1 ? 'tab' : 'tabs'}, Sir.`;
    return { ok: true, message: failed.length ? `${summary}${ownNote} These stayed open: ${failed.join('; ')}.` : `${summary}${ownNote}` };
  }
  async function closeAllAppsNow() {
    const listed = await localAction({ action: 'computer-tool', tool: 'process_list', args: {} });
    if (!listed || !listed.ok) return { ok: false, message: (listed && listed.message) || 'I could not list the running apps, Sir.' };
    const plan = Core.planCloseAllApps ? Core.planCloseAllApps(listed.processes || []) : { targets: [], skipped: [] };
    if (!plan.targets.length) return { ok: false, message: 'I could not find any open apps to close, Sir.' };
    const closed = [], failed = [];
    for (const app of plan.targets) {
      const result = await localAction({ action: 'close-app', name: app.name });
      const label = String(app.title || app.name).trim();
      if (result && result.ok) closed.push(label);
      else failed.push(`${label}: ${(result && result.message) || 'it stayed open'}`);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    lastOpenedApps = [];
    const guardNote = plan.skipped.length ? ' I left JARVIS and protected system windows running.' : '';
    if (!closed.length) return { ok: false, message: `I could not close any apps, Sir.${guardNote} ${failed.join('; ')}`.trim() };
    const summary = `Closed ${closed.length} ${closed.length === 1 ? 'app' : 'apps'}, Sir: ${closed.join(', ')}.`;
    return { ok: true, message: failed.length ? `${summary}${guardNote} These stayed open: ${failed.join('; ')}.` : `${summary}${guardNote}` };
  }
  // "close roblox and canva tabs" names websites, but Roblox also has a desktop
  // app. After the tabs are closed, close the matching running app too (if one
  // exists) so the request is not half-done. close-app is exact-name-safe: it
  // never guesses at an arbitrary process, and a name with no matching app
  // simply reports a failure we do not repeat.
  async function closeMatchingApp(name) {
    try {
      const result = await localAction({ action: 'close-app', name });
      return result && result.ok ? String(result.message || '').trim() : '';
    } catch { return ''; }
  }
  async function closeNamedApps(query) {
    const parts = splitTabQueries(query);
    if (parts.length < 2) return [];
    const notes = [];
    for (const part of parts) {
      const note = await closeMatchingApp(part);
      if (note) notes.push(note);
    }
    return notes.filter(Boolean);
  }
  // "open my roblox my minecraft and my valerant" is one request for three
  // apps. Each target is split out here and opened through the normal
  // launcher, so a mangled name still resolves and the reply names exactly
  // what opened and what did not. Only short, plain app names qualify — a
  // sentence with a real verb in it is left to the normal pipeline.
  const APP_LIST_VERBS = /\b(?:search|play|pause|tell|show|find|open|launch|close|start|stop|what|who|how|why|when|where|then|also|too)\b/i;
  function splitAppTargets(raw) {
    let text = String(raw || '')
      .replace(/\b(?:right now|now|please|asap|for me)\b/gi, ' ')
      // Hedges and sequencing words are speech, not app names. Without this
      // "open YouTube and roblox and then maybe gmail" left "then maybe gmail"
      // as one target, tripped the verb guard below, and the whole compound
      // command was refused with "say the actions one at a time".
      .replace(/\b(?:maybe|perhaps|possibly|probably)\b/gi, ' ')
      .replace(/\b(?:and\s+then|then|after\s+that|followed\s+by|as\s+well\s+as|along\s+with)\b/gi, ',')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return null;
    const parts = text
      .split(/\s*(?:,|&|\band\b|\bplus\b)\s*/i)
      .flatMap(part => String(part || '').split(/\s+(?=my\s+)/i));
    const cleaned = parts
      .map(part => String(part || '')
        .replace(/^(?:my|our|your|his|her|the|a|an)\s+/i, '')
        .replace(/[.!?]+$/, '')
        .trim())
      .filter(Boolean);
    // "steam roblox" is two targets spoken without an "and". Split a part
    // into its words when every word is a known app/site; a real multi-word
    // name ("google doc") is not touched. Without this, "open steam roblox and
    // valerin" asked the launcher for an app literally called "steam roblox"
    // and reported it missing while the other two never opened.
    const expanded = [];
    for (const item of cleaned) {
      const words = Core.splitKnownLaunchWords ? Core.splitKnownLaunchWords(item) : null;
      if (words) expanded.push(...words); else expanded.push(item);
    }
    if (expanded.length < 2) return null;
    if (new Set(expanded.map(item => item.toLowerCase())).size < 2) return null;
    if (expanded.some(item => item.split(/\s+/).length > 3)) return null;
    if (expanded.some(item => APP_LIST_VERBS.test(item))) return null;
    return expanded;
  }
  function looksLikeLaunchableApp(name) {
    const text = String(name || '').trim();
    if (!text) return false;
    try {
      if (Core.parseBareAppName && Core.parseBareAppName(text)) return true;
      if (Core.parseWebsiteIntent && Core.parseWebsiteIntent('open ' + text)) return true;
    } catch { }
    return false;
  }
  // One close step of a chain. Resolves the name against the controlled
  // browser's tab list FIRST — a "spotify" or "google doc" target usually
  // lives in a tab, not a process — then asks the window/process finder.
  // Deliberately independent of resolveTabAnswerForClose so a chain can never
  // consume or dangle a pending tab question mid-run.
  async function closeChainNamed(name) {
    // The chain parser can carry a leading "both"/"all" into the first name
    // ("close both roblox and canva tabs"). It is a quantifier, not part of
    // the app name, and leaving it in makes the lookup fail before the second
    // target is ever reached.
    const rawName = String(name || '').trim();
    const answer = rawName.replace(/^(?:both|all)\s+/i, '').trim();
    if (!answer) return { ok: false, message: 'I need a name to close, Sir.' };
    // "close both" / "close 1 and 2" in a chain refers to the apps from the
    // last multi-open. Without this the chain asked for a running program
    // literally called "both" and closed nothing.
    const recalled = rememberedCloseTargets(rawName);
    if (recalled && recalled.length) {
      const notes = [];
      for (const target of recalled) {
        const closed = await localAction({ action: 'close-app', name: target });
        notes.push(String((closed && closed.message) || `Closed ${target}.`).trim());
      }
      lastOpenedApps = lastOpenedApps.filter(name => !recalled.some(target => String(name).toLowerCase() === String(target).toLowerCase()));
      return { ok: true, message: notes.join(' '), phrase: `closed ${recalled.join(', ')}` };
    }
    let listed = null;
    try { listed = await localAction({ action: 'tabs-list' }); } catch { listed = null; }
    if (listed && listed.ok && Array.isArray(listed.tabs) && listed.tabs.length && Core.matchBrowserTabs) {
      const ranked = Core.matchBrowserTabs(listed.tabs, answer);
      const top = ranked && ranked.scored && ranked.scored[0];
      if (top && top.tab && top.score > 0) {
        const second = ranked.scored[1];
        const clear = !second || top.score - second.score >= 15 || (second.score / Math.max(1, top.score)) < 0.75;
        if (clear) {
          // Use the detailed result: a close that the browser could not
          // verify must fail the chain step, not be guessed from its prose.
          const outcome = await closeChosenTab(top.tab, null, true);
          if (!outcome || !outcome.ok) {
            return { ok: false, message: String((outcome && outcome.message) || `I could not close ${answer}, Sir.`) };
          }
          const appNote = await closeMatchingApp(answer);
          return {
            ok: true,
            message: appNote ? `${outcome.message} ${appNote}` : outcome.message,
            phrase: appNote ? `closed ${answer} and its app`
              : (answer !== rawName ? `closed ${answer}` : undefined),
          };
        }
        return { ok: false, message: `I found ${ranked.matches.length} tabs matching “${answer}”, Sir. Say “close ${answer}” on its own and I will ask which one.` };
      }
    }
    const result = await localAction({ action: 'close-app', name: answer });
    return { ok: Boolean(result && result.ok), message: String((result && result.message) || (result && result.ok ? 'Closed it, Sir.' : `I could not close ${answer}, Sir.`)) };
  }
  // Compound command chain (2026-10-21): "open YouTube then my Roblox" is two
  // actions that run in order. Each step reports what really happened, and a
  // failed step stops the chain instead of pretending the rest succeeded.
  async function runCommandChain(steps) {
    const opened = [];
    const failed = [];
    // A chain that opens apps ("open notepad and calculator") must feed the
    // same memory the multi-open path does, so a follow-up "close both" knows
    // which two apps it means instead of looking for a program named "both".
    const openedApps = [];
    const normalizeResult = (one, okText, failText) => ({
      ok: Boolean(one && one.ok),
      message: String((one && one.message) || (one && one.ok ? okText : failText)),
    });
    for (const step of steps) {
      let result = null;
      if (step.kind === 'site') {
        setMode('EXECUTING', `Opening ${step.label}`);
        result = await localAction({ action: 'open-site', name: step.site });
      } else if (step.kind === 'app') {
        setMode('EXECUTING', `Opening ${step.label}`);
        result = await localAction({ action: 'open-app', name: step.name });
      } else if (step.kind === 'url') {
        setMode('EXECUTING', `Opening ${step.label}`);
        result = await localAction({ action: 'tabs-open', url: step.url });
      } else if (step.kind === 'search') {
        setMode('SEARCHING', `Searching ${step.site} for ${step.query}`);
        result = await localAction({ action: 'search-site', site: step.site, query: step.query });
      } else if (step.kind === 'folder') {
        setMode('EXECUTING', `Opening your ${step.label} folder`);
        result = await localAction({ action: 'open-folder', key: step.key });
      } else if (step.kind === 'close-app') {
        setMode('EXECUTING', step.name === 'current' ? 'Closing the current app' : `Closing ${step.label}`);
        if (step.name === 'current') {
          result = normalizeResult(await localAction({ action: 'close-current-app' }), 'Closed the current app, Sir.', 'I could not close that window, Sir.');
        } else {
          result = await closeChainNamed(step.name);
        }
      } else if (step.kind === 'close-tab') {
        setMode('EXECUTING', step.name === 'music' ? 'Closing the music tab' : step.name === 'current' ? 'Closing the current tab' : `Closing the ${step.label}`);
        if (step.name === 'current') {
          result = normalizeResult(await localAction({ action: 'tabs-close', current: true }), 'Closed the tab, Sir.', 'I could not close that tab, Sir.');
        } else if (step.name === 'music') {
          result = normalizeResult(await localAction({ action: 'tabs-close', music: true }), 'Closed the music tab, Sir.', 'I could not close that tab, Sir.');
        } else if (/^position:/.test(step.name)) {
          const parts = step.name.slice('position:'.length).split(':');
          result = normalizeResult(await localAction({ action: 'tabs-close', position: Number(parts[0]), last: parts[1] === 'last' }), 'Closed the tab, Sir.', 'I could not close that tab, Sir.');
        } else {
          const many = await closeMultipleNamedTabs(step.name);
          result = many ? { ok: true, message: String(many) }
            : normalizeResult(await localAction({ action: 'tabs-close', query: step.name }), 'Closed the tab, Sir.', 'I could not close that tab, Sir.');
        }
      } else if (step.kind === 'close-all-tabs') {
        setMode('EXECUTING', 'Closing every browser tab');
        result = await closeAllTabsNow();
      } else if (step.kind === 'close-all-apps') {
        setMode('EXECUTING', 'Closing your open apps');
        result = await closeAllAppsNow();
      }
      if (!result) {
        failed.push(`I could not run “${step.label}”, Sir.`);
        break;
      }
      if (result.ok) {
        // A close step may add a verified app close ("and its app"), so prefer
        // its own phrase over the generic one from the parser.
        opened.push(result.phrase || step.phrase || step.label);
        if ((step.kind === 'app' && step.name) || (step.kind === 'site' && step.site)) openedApps.push(step.kind === 'site' ? step.site : step.name);
        // Give the next destination a moment so two windows do not fight over
        // the foreground.
        if (opened.length < steps.length) await new Promise(resolve => setTimeout(resolve, 400));
      } else {
        failed.push(result.message || `I could not run “${step.label}”, Sir.`);
        break;
      }
    }
    for (const openedTarget of openedApps.slice(-6)) rememberOpenedTarget(openedTarget);
    if (!opened.length) {
      const detail = failed.filter(Boolean).join(' ');
      return detail || 'I could not run any of those, Sir.';
    }
    // Livelier than the old "Done, Sir: ..." status report, while keeping the
    // exact list of verified actions unchanged.
    const summary = `There we go, Sir - ${opened.join(', then ')}.`;
    const detail = failed.filter(Boolean).join(' ');
    return detail ? `${summary} ${detail}` : summary;
  }
  async function reply(query, source = 'text') {
    const text = query.trim(), lower = text.toLowerCase();
    // One shared lead-stripper: it understands "can you", "could you please",
    // "i would like you to", "kindly", "go ahead and" and combinations, so a
    // polite close/open reaches the same deterministic handler as a bare one.
    const requestText = Core.stripPoliteLead(text).replace(/[.!?]+$/, '').trim();
    lastWebResults = [];
    // Pending multi-turn workflows resolve replies BEFORE any other routing so
    // a plain answer ("4 PM") can never be swallowed by a greedy matcher, and
    // so AI failures elsewhere never clear collected state.
    if (pendingFlow) {
      const resolution = Core.advancePendingFlow(pendingFlow, text);
      if (resolution.type === 'cancelled') {
        // "Cancel/delete that event" names stored data, not the draft in
        // progress: route it to the calendar and keep the unrelated workflow
        // alive instead of abandoning it. A bare "cancel" (or one aimed at the
        // calendar draft itself) still abandons the pending operation.
        const plannerCancel = Core.parsePlannerIntent(text);
if (plannerCancel && plannerCancel.kind === 'cancel-event-query' && resolution.flow.kind !== 'calendar') {
          pendingFlow = resolution.flow; voiceLog('pending flow kept - event cancellation requested', text);
        } else {
          pendingFlow = null; voiceLog('pending flow cancelled', resolution.flow.kind);
          clearVoiceSession('flow-cancelled');
          return 'Cancelled   nothing was created or sent, Sir.';
        }
      }
      if (resolution.type === 'expired') { pendingFlow = null; voiceLog('pending flow expired', resolution.flow.kind); clearVoiceSession('flow-expired'); }
      else if (resolution.type === 'unrelated') { voiceLog('pending flow kept for later', text); }
      else if (resolution.type === 'reask') {
        // Natural-language follow-ups ("half past ten", "an hour later", "at
        // that same time") may fail the strict deterministic validator but
        // succeed via local Ollama in pending-event context. Try AI once;
        // fall back to the stored question so state is never lost.
        if (pendingFlow && pendingFlow.kind === 'calendar') {
          try {
            const aiTime = await parseCalendarWithOllama(text);
            if (aiTime && (aiTime.start_time || aiTime.date) && (aiTime.intent === 'create' || aiTime.intent === 'clarify')) {
              const merged = { ...pendingFlow.values };
              if (aiTime.start_time) {
                const t = Core.parseNaturalTime(aiTime.start_time);
                if (t && !t.error && !t.ambiguous) {
                  merged.time = Core.formatTimeForStorage(t.hour, t.minute);
                  delete merged.timeAmbiguous;
                }
              }
              if (aiTime.date && !String(merged.date || '').trim()) merged.date = String(aiTime.date).slice(0, 60);
              if (aiTime.title && !String(merged.title || '').trim()) merged.title = String(aiTime.title).slice(0, 120);
              const trial = { ...pendingFlow, values: merged, touchedAt: Date.now() };
              Core.recomputeFlowStep(trial);
              if (trial.completed || String(trial.values.time || '').trim()) {
                const check = Core.parseNaturalTime(String(trial.values.time || ''));
                if (check && !check.error && !check.ambiguous) {
                  pendingFlow = trial;
                  if (trial.completed) {
                    const finished = trial; pendingFlow = null; clearVoiceSession('flow-completed');
                    return finishPendingFlow(finished);
                  }
                  setVoiceSession({ status: 'awaiting-answer', conversationActive: true, waitingFor: trial.step, pendingKind: trial.kind, lastQuestion: trial.question, expiresAt: trial.expiresAt }, 'flow-question');
                  return trial.question;
                }
              }
            }
            // Relative adjustments ("make it one hour later") resolve against
            // the pending event's current time without new absolute parsing.
            if (/hour(s)? later|minutes? later|hour(s)? earlier|minutes? earlier|same time next week|that same time/i.test(text)) {
              const aiRel = await handleCalendarAI(text);
              if (aiRel) return aiRel;
            }
          } catch {}
        }
        return pendingFlow.question || 'Could you repeat that, Sir?';
      }
      else if (resolution.type === 'answer' || resolution.type === 'correction') {
        pendingFlow = resolution.flow;
if (pendingFlow.completed) { const finished = pendingFlow; pendingFlow = null; clearVoiceSession('flow-completed'); return finishPendingFlow(finished); }
        setVoiceSession({ status: 'awaiting-answer', conversationActive: true, waitingFor: pendingFlow.step, pendingKind: pendingFlow.kind, lastQuestion: pendingFlow.question, expiresAt: pendingFlow.expiresAt }, 'flow-question');
        return pendingFlow.question;
      } else if (resolution.type === 'complete') {
        const finished = resolution.flow; pendingFlow = null;
        clearVoiceSession('flow-completed');
        return finishPendingFlow(finished);
      }
    }
    // Shared pending-question resolution (greetings, voice modes, alarms,
    // reminders, planner clarifications). It runs right after the
    // calendar/email/Discord flows and before everything else, so a plain
    // answer ("PM", "Roblox", "Pretty good") can never be swallowed by a
    // greedy matcher and never needs a second wake word.
    if (pendingQuestion && !pendingFlow) {
      const pendingReply = await resolvePendingQuestion(text);
      if (pendingReply !== null && pendingReply !== undefined) return pendingReply;
    }
    // Late answer to JARVIS's own wellbeing question (2026-10-19). The pending
    // record is short-lived by design; if it expired before the user answered,
    // the last assistant line is still the wellbeing question in the history.
    // Answer it here from the same sentiment composer, so the model can never
    // restart the greeting and ask "How are you?" a second time.
    if (!pendingQuestion && Core.looksLikeWellbeingAnswer && Core.looksLikeWellbeingAnswer(text) && lastAssistantAskedWellbeingRecently()) {
      const composed = Core.composeGreetingFollowUp(text, { address: preferredName(), style: personalityStyle(), variant: greetingVariant++ });
      voiceLog('late greeting answer resolved from history', text.slice(0, 60));
      const tone = wellbeingAckTone(text);
      return { response: composed.text, speech_text: composed.text, emotion: tone.emotion, emotion_intensity: tone.intensity, speaking_rate: 1, pause_hints: [], pronunciation_hints: {} };
    }
    // ---- Social greetings (time-of-day aware, centralized in Core) ----
    // Checked before the library classifier: the library greeting pool mixes
    // morning/afternoon/evening lines at random, which is what produced
    // "Good evening, Sir." for "Good morning, Jarvis".
    const greeting = Core.parseGreetingIntent ? Core.parseGreetingIntent(text, new Date()) : null;
    if (greeting) return answerGreeting(greeting, source);
    // Emotional first-person statements are conversation, never calendar data
    // (2026-10-18). "I feel so lonely today" contains the word "today" and used
    // to fall through to the Ollama calendar fallback, which answered "Which
    // event would you like to schedule?" — a scheduling question in reply to a
    // personal admission. Care intents are answered here, before every
    // reminder/planner/calendar matcher, and they arm the shared follow-up
    // bridge so the user can keep talking without a second wake word. Anything
    // carrying calendar vocabulary is excluded by the gate itself, so real
    // scheduling requests are untouched.
    // The emotional engine runs here, before every command/router matcher, so a
    // feeling statement is never mistaken for a calendar entry, a search, or a
    // workflow answer. A clear reading answers instantly from the shared
    // planner (and remembers what it already asked); genuinely ambiguous
    // wording is handed to the local model with the emotional guidance block.
    {
      if (!emotionalState) emotionalState = Core.createEmotionalState();
      const emotional = Core.considerEmotionalTurn ? Core.considerEmotionalTurn(emotionalState, text) : null;
      if (emotional) {
        emotionalState = emotional.state;
        if (Number(emotional.analysis?.confidence || emotional.state?.confidence || 0) >= 0.42) { applyUserMood(emotional.analysis?.primaryId || emotional.state?.primaryId || emotional.state?.family || ''); }
        voiceLog('emotional turn', `${emotional.mode}${emotional.safety && emotional.safety !== 'none' ? ` safety=${emotional.safety}` : ''}`);
        if (emotional.reply) {
          const recent = loadJson('jarvis-recent-local-replies', []); recent.push(emotional.reply);
          localStorage.setItem('jarvis-recent-local-replies', JSON.stringify(recent.slice(-12)));
          // Every conversational emotional reply arms the shared bridge except a
          // closing acknowledgement ("alright, I am here if that changes").
          if (emotional.mode !== 'respect') armConversationBridge('emotional', emotional.reply);
          return emotional.reply;
        }
        if (emotional.aiQuery) {
          return { aiQuery: emotional.aiQuery, conversationBridge: true, emotionalContext: Core.emotionalPromptContext(emotionalState) };
        }
      }
      // Fall back to the local model when the shared engine has no reading at
      // all (first-person feeling wording it does not classify). The model
      // interprets it with the conversation context; the follow-up bridge
      // keeps the chat open for the next sentence.
      if (Core.looksLikeEmotionalStatement(text)) {
        voiceLog('care turn to model', text.slice(0, 60));
        return { aiQuery: text, conversationBridge: true, emotionalContext: Core.emotionalPromptContext(emotionalState) };
      }
    }
    // Reminder setup runs BEFORE the stateless planner parser: complete
    // requests ("remind me tomorrow at 8 PM to call mom") are saved at once
    // with the right title, and incomplete ones arm the SHARED pending
    // question so the follow-up answer is never lost. The old parser answered
    // a clarification nobody could follow up on, dropping the collected time.
    const reminderFlow = startReminderFlow(text);
    if (reminderFlow) {
      if (reminderFlow.ready) {
        const result = await plannerRequest({ action: 'create-reminder', when: reminderFlow.ready.when, title: reminderFlow.ready.title });
        updatePlannerCard();
        if (!result.ok) return result.message || 'I could not save that reminder, Sir.';
        lastPlannerItemId = (result.reminder || {}).id || '';
        return `Reminder saved for ${formatPlannerDate(result.reminder ? result.reminder.when : reminderFlow.ready.when)}: ${reminderFlow.ready.title}.`;
      }
      return withFollowUp(reminderFlow.question);
    }
    const plannerReply = await handlePlannerIntent(text); if (plannerReply !== null) return withFollowUp(plannerReply);
    // An incomplete event request starts the multi-turn calendar flow and asks
    // only for the missing fields (complete one-shots stay on the fast path).
    // This runs BEFORE the Ollama calendar path on purpose: it is synchronous
    // and free, while the model call costs seconds. Only natural phrasings
    // the deterministic parsers miss fall through to the model below.
    // Deliberately not guarded by pendingFlow: if execution reached here the
    // pending flow already classified this text as unrelated, so starting the
    // requested calendar flow wins over the older one.
    const calendarFlow = Core.parseCalendarFlowStart(text);if (calendarFlow) { pendingFlow = calendarFlow; setVoiceSession({ status: 'awaiting-answer', conversationActive: true, waitingFor: pendingFlow.step, pendingKind: 'calendar', lastQuestion: pendingFlow.question, expiresAt: pendingFlow.expiresAt }, 'flow-started'); return withFollowUp(pendingFlow.question); }
    // Local Ollama calendar understanding for natural phrasings the
    // deterministic fast path misses ("remind me this evening", "what events
    // tomorrow?", "move that event to 11 AM", "make it one hour later").
    // Deterministic stays first so complete one-shots never pay AI latency;
    // AI failures return null and fall through to the multi-turn flow.
    // Only consult AI for plausibly calendar-related text to avoid slow
    // unrelated queries from hitting Ollama on every turn.
    // AM/PM only counts as calendar evidence when it follows a number
    // ("7:30am", "5 am"), never the bare word "am" — otherwise every
    // "I am feeling..." conversation sentence was hijacked into the
    // calendar flow and never reached the conversation engine.
    // A bare day word is no longer evidence either: "today" used to drag every
    // "I feel ... today" sentence into the calendar parser. The shared gate in
    // Core requires a calendar noun/verb, a clock time, or a free/busy question.
    if (Core.looksCalendarRelated(text) && !Core.looksLikeEmotionalStatement(text)) {
      try {
        const aiReply = await handleCalendarAI(text);
        if (aiReply !== null) return aiReply;
      } catch (error) { voiceLog('calendar AI fallback', error.message); }
    }if (/\b(?:what is|what's|tell me) my full name\b/.test(lower)) return `Your full name is ${fullName()}, Sir.`;if (/\b(?:what is|what's|tell me) my name\b/.test(lower)) return `Your name is ${givenName()}, Sir. I address you as ${preferredName()}.`;if (/\bwhat do you remember about me\b|\bwhat have you remembered\b/.test(lower)) {
      const facts = memoryEntries.length ? memoryEntries.map((fact, index) => `${index + 1}. ${fact.text}`).join(' ') : 'No extra personal notes are saved yet.';
      return `I call you ${preferredName()}, Sir. Your name is ${givenName()}. ${facts}`;
    }
    // Recall commands: deterministic retrieval from the durable archive before
    // any model is consulted. Secrets are never stored as notes.
    const memoryCommand = Core.parseMemoryCommand(text);if (memoryCommand) {
      if (memoryCommand.kind === 'remember') {
        const result = rememberFact(memoryCommand.text);
if (result.reason === 'sensitive') return 'I will not store passwords, keys, or tokens as a memory, Sir.';
if (result.reason === 'duplicate') return 'That is already among your saved notes, Sir.';
if (!result.ok) return 'I could not save that note, Sir.';
        return `I will remember that, Sir: ${result.entry.text}`;
      }
      if (memoryCommand.kind === 'forget') {
        const outcome = Core.forgetMemoryMatching(memoryEntries, memoryCommand.query);
if (!outcome.removed.length) return `I could not find a stored note matching "${memoryCommand.query}".`;
        memoryEntries = outcome.list; saveMemories();
        // Corrections must survive too: mirror the removal into the vault,
        // otherwise hydration would restore the forgotten note after a restart.
        vaultMemoryRequest({ action: 'remove', query: memoryCommand.query });
        return `I removed ${outcome.removed.length === 1 ? 'that note' : `those ${outcome.removed.length} notes`}, Sir.`;
      }
      if (memoryCommand.kind === 'forget-all') {
if (!window.confirm('Permanently clear all JARVIS memory, saved notes, and the stored conversation history from this app profile?')) return 'I kept everything, Sir.';
        forgetMemories(); return 'I cleared the saved notes and the full stored conversation history from this app profile.';
      }
      if (memoryCommand.kind === 'show-memory') {
        const facts = memoryEntries.length ? memoryEntries.map((fact, index) => `${index + 1}. ${fact.text}`).join(' ') : 'No extra personal notes are saved yet.';
        return `I call you ${preferredName()}, Sir. Your name is ${givenName()}. ${facts}`;
      }
      if (memoryCommand.kind === 'search-history') {
        const hits = Core.searchHistory(durableHistory, memoryCommand.query, 5);
if (!hits.length) return `I searched our stored conversations for "${memoryCommand.query}" and found nothing, Sir.`;
        return `I found ${hits.length} stored message${hits.length === 1 ? '' : 's'} mentioning "${memoryCommand.query}": ${hits.slice(0, 3).map(hit => `"${String(hit.text).slice(0, 90)}"`).join('; ')}.`;
      }
      if (memoryCommand.kind === 'recall-yesterday') {
        const today = new Date();
        const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
        const rows = Core.historyForDay(durableHistory, start, start + 86400000);
if (!rows.length) return 'I do not have any stored conversation from yesterday, Sir.';
        return Core.summarizeMessages(rows, 'Yesterday');
      }
      if (memoryCommand.kind === 'recall-last-tasks') {
        const asks = durableHistory.filter(item => item.who === 'YOU').slice(-3);
if (!asks.length) return 'I do not have any stored record of earlier requests yet, Sir.';
        return `Last time you asked me: ${asks.map(item => `"${String(item.text).slice(0, 80)}"`).join('; ')}.`;
      }
      if (memoryCommand.kind === 'did-mention') {
        return Core.answerDidMention(memoryCommand.query, memoryEntries, durableHistory).reply;
      }
      if (memoryCommand.kind === 'continue-context') return { aiQuery: text, recall: true };
    }if (/\b(?:cancel|abort) (?:the )?shutdown\b/.test(lower)) {
      pendingShutdown = false; $('#shutdownCard')?.remove();
      return (await localAction({ action: 'cancel-shutdown' })).message;
    }if (/\b(?:confirm|approve) (?:the )?shutdown\b/.test(lower) && pendingShutdown) {
      $('#shutdownCard .danger')?.click(); return 'I am starting the confirmed 60-second shutdown countdown.';
    }
    // Voice confirmation for the on-screen preview cards: nothing is sent or
    // opened until the user explicitly confirms (on screen or by voice).
    const confirmLead = Core.stripPoliteLead(text).replace(/[.!?]+$/, '').trim();
    // Pending computer/screenshot operations: risky actions (overwrite,
    // delete, run a program) register here and only run after an explicit
    // user confirmation. Email/Discord confirmations keep priority.
    if (!pendingEmailDraft && !pendingDiscordSend && /^(?:confirm|yes(?: please)?|do it|go ahead)(?: it| that| both| the (?:operation|action))?\.?$/i.test(confirmLead)) {
      const op = window.__jarvisPendingOp;
      if (op && op.kind === 'computer') {
        window.__jarvisPendingOp = null; $('#computerConfirmCard')?.remove();
        const done = await localAction({ action: 'computer-confirm', opId: op.opId });
        if (!done.needsConfirmation) return done.message || (done.ok ? 'Done, Sir.' : 'The confirmed operation failed.');
      }
      if (op && op.kind === 'screenshot-delete') {
        window.__jarvisPendingOp = null; $('#computerConfirmCard')?.remove();
        const done = await localAction({ action: 'screenshot-delete', name: op.name, confirmed: true });
        return done.message || (done.ok ? 'Done, Sir.' : 'I could not delete that screenshot.');
      }
    }if (pendingDiscordSend && /^(?:send|confirm|go ahead|do it)(?: it| that| the message| now)?$/i.test(confirmLead)) {
      const sent = await sendPendingDiscord();
      if (sent) return sent.ok ? 'Your Discord message has been sent, Sir.' : (sent.message || 'The Discord message was not sent.');
    }if (pendingEmailDraft && /^(?:approve(?: & open)?|confirm|open|send)(?: the)?(?: email| email draft| draft| it)?$/i.test(confirmLead)) {
      $('#emailDraftCard .draft-actions .chip')?.click();
      return 'Opening your approved email in your mail app   it is not sent until you send it there.';
    }if (/\b(?:shut ?down|power off|turn off) (?:my )?(?:computer|pc|laptop|this computer)\b/.test(lower)) {
      showShutdownApproval(); return 'I prepared a shutdown confirmation. Confirm on screen before I start the 60-second countdown.';
    }
    // Browser tab control (Phase 9). These phrases are checked before the
    // generic open/switch matchers so "start a controlled browser window"
    // never becomes an app launch.
    if (/^(?:enable|turn on|start) browser control$/i.test(confirmLead)) {
      setMode('EXECUTING', 'Enabling browser tab control');
      return (await localAction({ action: 'browser-control-enable' })).message;
    }
    // Auto browser control: "open Chrome", "open browser", "open my browser"
    // etc. must establish JARVIS-controlled browser access on their own, with
    // no separate setup command. Reuses the existing session when present and
    // launches a controlled window only when one is not connected.
    const browserNeed = Core.parseBrowserNeedIntent(confirmLead);
    if (browserNeed && browserNeed.kind === 'open-browser') {
      setMode('EXECUTING', 'Starting the controlled browser');
      const enabled = await localAction({ action: 'browser-control-enable' });
      if (!enabled.ok) return enabled.message || 'I could not start the controlled browser, Sir.';
      const started = await localAction({ action: 'browser-control-start-window' });
      if (!started.ok) return started.message || enabled.message || 'Browser control did not connect, Sir.';
      return started.message || 'Browser control is connected, Sir.';
    }if (/^(?:start|open) (?:a )?controlled browser(?: window)?$/i.test(confirmLead)) {
      setMode('EXECUTING', 'Starting a controlled browser window');
      return (await localAction({ action: 'browser-control-start-window' })).message;
    }if (/^(?:browser|tab) control(?: status| check)?$/i.test(confirmLead)) {
      return (await localAction({ action: 'browser-control-status' })).message;
    }if (/^(?:list|show|show me|what are|what(?:'s| is)) (?:the )?(?:all(?: of)? )?(?:my )?(?:open |current |active )?tabs$/i.test(confirmLead)
      || /^what tabs do i have open\??$/i.test(confirmLead)
      || /^show my open tabs\??$/i.test(confirmLead)
      || /^which websites are open\??$/i.test(confirmLead)
      || /^read out my browser tabs\??$/i.test(confirmLead)
      || /^give me a list of my (?:edge|browser) tabs\??$/i.test(confirmLead)) {
      const result = await localAction({ action: 'tabs-list' });
      if (!result.ok) return result.message;
      if (!result.tabs?.length) return 'There are no browser tabs I can control right now.';
      const titles = result.tabs.slice(0, 5).map(tab => tab.title || '(untitled)').join('; ');
      return `You have ${result.tabs.length} controlled tab${result.tabs.length === 1 ? '' : 's'}: ${titles}${result.tabs.length > 5 ? '; and more' : ''}.`;
    }if (/^(?:what|which) tab (?:am i on|is this|is active)$|^(?:what(?:'s| is) (?:the )?(?:current|active) tab)$/i.test(confirmLead)) {
      return (await localAction({ action: 'tabs-current' })).message;
    }if (/^(?:(?:switch to|go to) (?:the )?(?:previous|next|last|back) tab|(?:previous|next) tab)$/i.test(confirmLead)) {
      const direction = /\bnext\b/i.test(confirmLead) ? 'next' : 'previous';
      return (await localAction({ action: 'tabs-activate', direction })).message;
    }if (/^(?:switch to|go to) (?:the )?(?:tab\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th)?)\b/i.test(confirmLead)) {
      const match = confirmLead.match(/^(?:switch to|go to) (?:the )?(?:tab\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th)?)/i);
      if (match) {
        const ordinal = match[1].toLowerCase();
        const ordinalMap = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
        const position = ordinalMap[ordinal] || parseInt(ordinal, 10);
        if (position > 0) {
          return (await localAction({ action: 'tabs-activate', position })).message;
        }
      }
    }
    // ---- Screen Vision & Screenshot command handlers ----
    // Explicit enable/disable first so settings changes are never mistaken
    // for a screen question.
    if (/^(?:enable|turn on|activate)\s+(?:the\s+)?(?:screen\s+)?(?:vision|screen vision|screen analysis)$/i.test(confirmLead)) {
      setMode('EXECUTING', 'Enabling screen vision');
      const result = await localAction({ action: 'screen-settings', settings: { enabled: true } });
      refreshVisionCards?.();
      return result.ok ? 'Screen vision enabled. Ask me what is on your screen, Sir.' : (result.message || 'I could not change that setting.');
    }
    if (/^(?:disable|turn off)\s+(?:the\s+)?(?:screen\s+)?(?:vision|screen vision|screen analysis)$/i.test(confirmLead)) {
      setMode('EXECUTING', 'Disabling screen vision');
      const result = await localAction({ action: 'screen-settings', settings: { enabled: false } });
      refreshVisionCards?.();
      return result.ok ? 'Screen vision disabled, Sir.' : (result.message || 'I could not change that setting.');
    }
    if (/^(?:enable|turn on|activate)\s+(?:broad\s+)?(?:computer|file)\s+access$/i.test(confirmLead)) {
      setMode('EXECUTING', 'Enabling computer access');
      const result = await localAction({ action: 'computer-settings', settings: { enabled: true } });
      refreshVisionCards?.();
      return result.ok ? 'Computer access enabled. File changes and deletions still ask for your confirmation, Sir.' : (result.message || 'I could not change that setting.');
    }
    if (/^(?:disable|turn off)\s+(?:broad\s+)?(?:computer|file)\s+access$/i.test(confirmLead)) {
      setMode('EXECUTING', 'Disabling computer access');
      const result = await localAction({ action: 'computer-settings', settings: { enabled: false, allowAiDeletions: false } });
      refreshVisionCards?.();
      return result.ok ? 'Computer access disabled, Sir.' : (result.message || 'I could not change that setting.');
    }
    if (/^computer\s+(?:access\s+)?(?:status|state|check)$/i.test(confirmLead)) return describeComputerStatus(await localAction({ action: 'computer-status' }));
    // ---- SYSTEM MONITOR 2.0 voice queries (same live snapshot as the GUI) ----
    if (/\brefresh (?:the )?system monitor\b|\brefresh system stats\b/i.test(lower)) { const r = await localAction({ action: 'system-refresh' }); refreshSystemMonitor(true); return r.ok ? `System monitor refreshed, Sir. ${r.message}` : (r.message || 'The system monitor did not refresh.'); }
    if (/\bhow much ram\b|\bmemory (?:am i )?using\b|\bram (?:usage|use|utili[sz]ation)\b/i.test(lower)) { const r = await localAction({ action: 'system-status' }); if (!r.ok || !r.snapshot?.mem) return r.message || 'I could not read memory usage.'; const m = r.snapshot.mem; return m.pct === null || m.pct === undefined ? 'Memory readings are unavailable right now, Sir.' : `You are using ${m.pct}% of RAM, Sir — ${m.usedGB} of ${m.totalGB} GB, with ${m.freeGB} GB free.`; }
    if (/\bwhat is using the most cpu\b|\bmost cpu\b|\bcpu (?:usage|use|utili[sz]ation|load)\b|\bhow.*cpu\b/i.test(lower)) { const r = await localAction({ action: 'system-status' }); if (!r.ok) return r.message || 'I could not read CPU usage.'; const c = r.snapshot.cpu, t = r.snapshot.procs?.top; const base = (c?.pct === null || c?.pct === undefined) ? 'CPU readings are unavailable' : `CPU is at ${c.pct}%`; if (t) return `${base}, Sir. The top app by memory is ${t.name} at ${t.ramMB} MB.`; return `${base}, Sir.`; }
    if (/\bstorage (?:space|left|free)\b|\bdisk (?:space|usage|free)\b|\bhow much (?:storage|disk|space)\b/i.test(lower)) { const r = await localAction({ action: 'system-status' }); if (!r.ok) return r.message || 'I could not read storage.'; const d = r.snapshot.drives?.primary; if (!d) { const list = (r.snapshot.drives?.list || []).map(x => `${x.name} ${x.freeGB} GB free`).join('; '); return list ? `Your drives: ${list}, Sir.` : 'Storage readings are unavailable, Sir.'; } return `On ${d.name} you have ${d.freeGB} GB free of ${d.totalGB} GB, Sir (${d.pct}% used).`; }
    if (/\bgpu (?:being used|usage|use|utili[sz]ation|load)\b|\bis my gpu\b/i.test(lower)) { const r = await localAction({ action: 'system-status' }); if (!r.ok) return r.message || 'I could not read the GPU.'; const g = r.snapshot.gpu; if (!g || (!g.name && g.pct === null)) return 'GPU readings are unavailable on this PC, Sir.'; if (g.pct === null || g.pct === undefined) return `Your GPU is ${g.name || 'detected'}, Sir, but utilization is not exposed by its driver, so I cannot report a live percentage.`; return `Your GPU (${g.name}) is at ${g.pct}%, Sir.`; }
    if (/\bwhy.*(?:running slow|slowly|lagging)\b|\bcomputer.*slow\b/i.test(lower)) { const r = await localAction({ action: 'system-status' }); if (!r.ok) return r.message || 'I could not check performance.'; const s = r.snapshot; const facts = []; if (s.cpu?.pct !== null && s.cpu?.pct !== undefined) facts.push(`CPU ${s.cpu.pct}%`); if (s.mem?.pct !== null && s.mem?.pct !== undefined) facts.push(`RAM ${s.mem.pct}%`); if (s.drives?.primary) facts.push(`${s.drives.primary.name} ${s.drives.primary.freeGB} GB free`); const top = s.procs?.top ? ` Top app: ${s.procs.top.name} (${s.procs.top.ramMB} MB).` : ''; if (!facts.length) return 'I have no live readings to diagnose with yet, Sir.'; let cause = 'Those readings look normal, so no single bottleneck is proven by the data.'; if ((s.cpu?.pct || 0) >= 85 || (s.mem?.pct || 0) >= 90) cause = 'High load is measured right now, which is consistent with slowness, but I cannot name the exact cause beyond the top app above.'; return `Measured now: ${facts.join('; ')}.${top} ${cause}`; }
    if (/^(?:open|show)(?: (?:the|my))? screenshot folder$/i.test(confirmLead)) return (await localAction({ action: 'screenshot-folder' })).message;
    if (/^(?:delete|remove)(?: the)? screenshot (?:named|called)\s+(.+)$/i.test(confirmLead)) {
      const name = confirmLead.match(/^(?:delete|remove)(?: the)? screenshot (?:named|called)\s+(.+)$/i)[1];
      const result = await localAction({ action: 'screenshot-delete', name: name.trim() });
      if (result.needsConfirmation) { registerPendingOp({ kind: 'screenshot-delete', name: name.trim() }, result.message); return result.message; }
      return result.message || (result.ok ? 'Done, Sir.' : 'I could not delete that screenshot.');
    }
    if (/^(?:open|show)(?: my| the)? (?:latest|newest|last|most recent) screenshot$/i.test(confirmLead)) {
      setMode('EXECUTING', 'Opening the latest screenshot');
      return (await localAction({ action: 'screenshot-open', latest: true })).message;
    }
    if (/^(?:show|list)(?: me)?(?: the)?(?: my)?(?: recent)? screenshots$|^(?:what are my recent screenshots)$|^list my screenshots$/i.test(confirmLead)) {
      setMode('SEARCHING', 'Listing saved screenshots');
      const result = await localAction({ action: 'screenshots-list', withinDays: 30, limit: 12 });
      if (!result.ok) return result.message;
      if (!result.screenshots?.length) return `No screenshots in ${result.dir || 'the screenshot folder'} yet, Sir.`;
      addMessage('FOUND', result.screenshots.slice(0, 8).map((item, index) => `${index + 1}. ${item.name} (${item.sizeMB} MB, ${new Date(item.modified).toLocaleString()})`).join('\n'));
      return `You have ${result.screenshots.length} recent screenshot${result.screenshots.length === 1 ? '' : 's'} in ${result.dir}. They are on screen, Sir.`;
    }
    // "Take a screenshot and tell me what you see" analyzes without saving;
    // plain "take a screenshot" / "save a screenshot" saves the file.
    if (/take a screenshot and (?:tell me what you see|describe it|explain)/i.test(text)) {
      setMode('SEARCHING', 'Capturing and analyzing the screen');
      const result = await localAction({ action: 'screen-describe', question: 'Tell me what you see on this screen.', target: screenTargetFromText(text) });
      if (!result.ok) return result.message;
      window.__jarvisLastScreenAt = Date.now();
      return result;
    }
    if (/^(?:take|do|get)(?: a)? screenshot$|^take a screenshot and save it$|^save a screenshot$|^screenshot (?:my |the )?screen$|^capture (?:the )?current screen$|^screenshot$/i.test(confirmLead)) {
      setMode('EXECUTING', 'Capturing a screenshot');
      const result = await localAction({ action: 'screenshot-save', target: 'screen' });
      if (result.ok && result.path) {
        showScreenshotPreview(result.path, result.message);
      }
      return result.ok ? `${result.message}` : (result.message || 'I could not save that screenshot, Sir.');
    }
    // Screen help (2026-10-18): "close screen help" / "hide the pointer" must
    // work instantly, without the model. Matches only explicit closes; the
    // server kills the pointer and any in-flight search immediately.
    const screenHelpClose = Core.parseScreenHelpCloseIntent ? Core.parseScreenHelpCloseIntent(confirmLead) : null;
    if (screenHelpClose) {
      setMode('EXECUTING', 'Closing screen help');
      const result = await localAction({ action: 'screen-help-close' });
      return result.message || 'Screen help is closed, Sir.';
    }
    // Screen help ask: "where is X?" candidates go to the local model for one
    // quick yes/no check ("is this about locating something on my screen?").
    // Only a YES starts the single capture + locator + blue pointer; a
    // decline falls through here and the question continues down its normal
    // path completely untouched.
    const screenHelpAsk = Core.parseScreenHelpIntent ? Core.parseScreenHelpIntent(confirmLead) : null;
    if (screenHelpAsk) {
      setMode('EXECUTING', 'Checking the screen');
      const result = await localAction({ action: 'screen-help-try', question: screenHelpAsk.question, model: $('#aiModel')?.value || localStorage.getItem('jarvis-ai-model') || '' });
      if (result.ok && result.handled) return result.message;
    }
    // Screen help invite (2026-10-18): a generic "help me" / "i need help" /
    // "i'm stuck" gets a short spoken invitation to name what to find. This
    // captures nothing itself — the pointer only appears after a specific
    // request goes through the classifier-gated path above.
    const screenHelpInviteIntent = Core.parseScreenHelpInvite ? Core.parseScreenHelpInvite(confirmLead) : null;
    if (screenHelpInviteIntent) {
      setMode('EXECUTING', 'Offering screen help');
      const result = await localAction({ action: 'screen-help-invite' });
      if (result.ok && result.handled) return result.message;
    }
    // Screen ACTION intents (2026-10-19): direct requests to click, press,
    // select, point at, hover, double/right-click a visible control. Parsing
    // is deterministic (Core.parseScreenActionIntent — verbs + a concrete
    // element/position/demonstrative target); the server re-validates and
    // the local model still gates every capture. Press-like asks are served
    // honestly: the blue pointer marks the control, the user clicks it.
    // Scroll/drag have no executor and are refused without any capture.
    // A demonstrative-only target ("click that") asks for a name instead of
    // guessing. App launches, media, searches and conversation never reach
    // this block (the parser rejects them; their handlers live further down).
    if (Core.parseScreenActionIntent) {
      const screenAction = Core.parseScreenActionIntent(confirmLead);
      if (screenAction && screenAction.ambiguous) {
        return 'Which one shall I point at, Sir? Name the element and I will mark it with the blue pointer.';
      }
      if (screenAction) {
        const acting = screenAction.action === 'scroll' || screenAction.action === 'drag';
        setMode('EXECUTING', acting ? 'Screen interaction' : 'Finding it on screen');
        const result = await localAction({ action: 'screen-help-try', question: screenAction.question, screenAction: screenAction.action, model: $('#aiModel')?.value || localStorage.getItem('jarvis-ai-model') || '' });
        if (result.ok && result.handled) return result.message;
        // Locates declined by the model keep the downstairs behavior of the
        // "where is" path above; a press-like decline likewise falls through
        // untouched instead of risking a wrong mark.
      }
    }
    // Follow-up questions about a recent analysis reuse the bounded cached
    // capture; anything older forces a fresh capture through the ask handler.
    const lastScreenAt = Number(window.__jarvisLastScreenAt || 0);
    const screenFollow = lastScreenAt && (Date.now() - lastScreenAt < 10 * 60 * 1000) && /\b(?:that|it|this|the error|that error|that message|the graph|that chart|the second option|smaller text)\b/.test(lower) && /^(?:what|why|explain|read|tell me|can you|how|which)/.test(confirmLead);
    if (screenFollow) {
      setMode('SEARCHING', 'Reviewing the last capture');
      const result = await localAction({ action: 'screen-follow', question: text });
      if (result.ok) { window.__jarvisLastScreenAt = Date.now(); return result; }
      window.__jarvisLastScreenAt = 0;
      if (!result.stale) return result.message;
      // fell through: stale context → new capture below
    }
    // CAMERA-FIX 2026-10-14: screen intent is centralized in
    // Core.parseScreenIntent and REQUIRES explicit screen/monitor/display
    // words (or error/page/app-open phrasing). A bare "what am I looking at?"
    // is a WEBCAM question and must not be stolen by the screen handler.
    const screenHit = Core.parseScreenIntent ? Core.parseScreenIntent(confirmLead, text) : null;
    const screenAsk = Boolean(screenHit);
    if (screenAsk) {
      setMode('SEARCHING', 'Capturing and analyzing the screen');
      const result = await localAction({ action: 'screen-describe', question: text, target: screenTargetFromText(text) });
      if (!result.ok) { notify?.(result.message); return result.message; }
      window.__jarvisLastScreenAt = Date.now();
      return result;
    }
    // Open apps/windows/tabs query: uses process_list (visible Windows apps) +
    // browser tabs for a compact answer without screen capture.
    const openAppsHit = Core.parseOpenAppsIntent ? Core.parseOpenAppsIntent(confirmLead) : null;
    if (openAppsHit) {
      setMode('SEARCHING', 'Checking open apps and tabs');
      const result = await localAction({ action: 'computer-tool', tool: 'process_list', args: {} });
      if (!result.ok) { notify?.(result.message); return result.message; }
      const procs = result.processes || [];
      // Also get browser tabs if tab control is connected
      let browserTabsInfo = [];
      try {
        const tabsResult = await localAction({ action: 'tabs-list' });
        if (tabsResult.ok && tabsResult.tabs) {
          browserTabsInfo = tabsResult.tabs.filter(t => t.title && t.url).slice(0, 8).map(t => `${t.title} (${t.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]})`);
        }
      } catch {}
      // Build compact response
      const appLines = procs.slice(0, 6).map(p => `${p.name}${p.title ? ` — ${p.title}` : ''}${p.ramMB ? ` [${p.ramMB}MB]` : ''}`);
      const tabLines = browserTabsInfo.length ? ['Browser tabs:', ...browserTabsInfo] : [];
      const allLines = [...appLines, ...tabLines];
      return allLines.length
        ? `Open apps: ${appLines.join('; ')}${tabLines.length ? ` | Browser: ${browserTabsInfo.join('; ')}` : ''}`
        : 'No visible apps or tabs detected, Sir.';
    }
    const pathOpen = confirmLead.match(/^(?:open|launch|start)\s+([A-Za-z]:[\\\/].{1,300})$/);
    if (pathOpen) {
      setMode('EXECUTING', 'Opening a path');
      const result = await localAction({ action: 'computer-tool', tool: 'open_path', args: { path: pathOpen[1].trim() } });
      return computerActionReply(result);
    }
    // ---- Webcam vision command handlers ----
    // Explicit camera on/off first; these never start silently — CONNECT is
    // the only path to an active camera.
    if (/^(?:connect(?:\s+to)?(?:\s+my|\s+the)?\s+(?:webcam|camera)|turn on(?:\s+my|\s+the)?\s+(?:webcam|camera))$/i.test(confirmLead)) {
      setMode('EXECUTING', 'Connecting the camera');
      window.__jarvisCameraPanel?.();
      const r = await cameraConnectForCommand();
      return r;
    }
    if (/^(?:stop|disconnect|turn off)(?:\s+the|\s+my)?\s+(?:camera|webcam)$/i.test(confirmLead)) {
      setMode('EXECUTING', 'Disconnecting the camera');
      return window.JarvisCamera?.disconnect?.()?.message || 'The camera is not connected, Sir.';
    }
    if (/^(?:open|show)(?:\s+the|\s+my)?\s+(?:camera|webcam)(?:\s+panel|\s+vision)?$/i.test(confirmLead)) {
      window.__jarvisCameraPanel?.();
      return 'The camera vision panel is on the right, Sir.';
    }
    if (/^(?:save|keep)(?:\s+this)?(?:\s+webcam|\s+camera)?(?:\s+frame)?$/i.test(confirmLead)) {
      const r = await window.JarvisCamera?.save?.();
      return r?.message || 'There is no camera frame to save yet, Sir.';
    }
    // Camera questions: centralized in Core.parseCameraIntent (CAMERA-FIX
    // 2026-10-14). Covers holding/scene/this-that/identify/explain/read/
    // analyze-camera/compare/instructions; screen-worded text never matches
    // (screen questions stay with the screen-vision handlers above).
    const camHit = Core.parseCameraIntent ? Core.parseCameraIntent(confirmLead, text) : null;
    // Anaphoric follow-ups ("describe it in more detail", "how does it
    // work") reuse the bounded last frame; anything older forces a fresh
    // capture. Follow-ups only apply shortly after a real analysis so
    // ordinary conversation is never hijacked into camera commands.
    const camFollowUp = camHit && camHit.kind === 'camera-follow'
      && window.JarvisCamera?.isConnected?.() !== false
      && lastCamAt && (Date.now() - lastCamAt < 10 * 60 * 1000) && lastCamFrame;
    const camAskQ = Boolean(camHit && (camHit.kind === 'camera' || camFollowUp));
    if (camAskQ) {
      const camReqAt = Date.now();
      voiceLog('camera intent', `${camHit.kind}${camFollowUp ? ' (same-frame follow-up)' : ''} - mode=${camHit.mode || 'identify'} - "${String(text).slice(0, 80)}"`);
      setMode('THINKING', 'Looking through the camera');
      window.__jarvisCameraPanel?.();
      // Follow-ups reuse the last frame; fresh captures for new looks.
      const followPhrasing = /^(?:what\s+can\s+i|can\s+i\s+use\s+it|how\s+do\s+i|how\s+does\s+it|what\s+is\s+(?:this|it|that)\s+made|read\s+(?:the\s+)?label|compare|what(?:'s| is)\s+the\s+difference|what\s+is\s+that\s+small|how\s+do\s+i\s+clean|give\s+me\s+instructions|describe it|in more detail|tell me more about it|what about (?:it|that|this)|read it|zoom in|focus on)/i;
      const preferFollow = (camFollowUp || (followPhrasing.test(confirmLead) && window.JarvisCamera?.isConnected?.() !== false)) && Boolean(lastCamAt && lastCamFrame);
      const mode = camHit.mode || (/read\s+(?:the\s+)?(?:label|labels|text)/i.test(confirmLead) ? 'readtext' : /compare|difference/i.test(confirmLead) ? 'compare' : /how\s+(?:does|do|can)|instructions|use\s+(?:this|it)\s+for/i.test(confirmLead) ? 'explain' : /describe\s+everything/i.test(confirmLead) ? 'scene' : 'identify');
      window.JarvisCamera?.setMode?.(mode);
      const r = await cameraAskForCommand(text, mode, preferFollow);
      voiceLog('camera handler', `${r.ok ? 'ok' : (r.needsCamera ? 'needs-camera' : 'failed')} - mode=${mode} - ${Date.now() - camReqAt} ms`);
      if (r.needsCamera) return `${r.message}`;
      if (r.ok) {
        // Return structured response so the ask() -> speak() pipeline
        // picks up speech_text, emotion, etc. and the centralized
        // speech controller handles playback once.
        // Include preserveTurn: true so long-running camera analysis
        // isn't silently dropped if another command increments the turn.
        return {
          response: r.response,
          speech_text: r.speech_text || r.response,
          emotion: r.emotion || 'neutral',
          emotion_intensity: r.emotion_intensity ?? 0.5,
          speaking_rate: r.speaking_rate || 1,
          preserveTurn: true
        };
      }
      return r.message || 'I could not analyze that frame, Sir.';
    }
    // ---- Voice-only modes (2026-10-14): central registry in Core.MODES.
    // No GUI: sites reuse tabs (open-site), apps focus-or-launch
    // (focus-app), questions arm the no-wake-word follow-up state.
    const modeHit = Core.parseModeIntent ? Core.parseModeIntent(text) : null;
    if (modeHit && modeHit.mode === '__list') return Core.modeListText();
    if (modeHit && modeHit.mode === '__help') return Core.modeHelpText(modeHit.extra.forMode);
    if (modeHit && modeHit.mode === '__exit') {
      const forMode = (modeHit.extra && modeHit.extra.forMode) || '';
      if (!activeMode && !pendingQuestion && !(forMode === 'music' && musicOpened)) return 'No mode is active right now, Sir.';
      clearPendingQuestion('mode-exit');
      activeMode = '';
      if (forMode === 'music') { musicOpened = false; setMode(recognitionEnabled ? 'LISTENING' : 'IDLE', 'Music mode off.'); return 'Music mode off, Sir.'; }
      if (forMode === 'conversation') { setMode(recognitionEnabled ? 'LISTENING' : 'IDLE', 'Back to wake-word listening.'); return 'Conversation mode off, Sir. Say "Jarvis" when you need me.'; }
      return 'Leaving that mode, Sir. Back to normal listening.';
    }
    if (modeHit && !modeHit.mode.startsWith('__')) {
      return runMode(modeHit.mode, modeHit.extra || {}, text, Boolean(modeHit.switched));
    }
    // ---- "check my todo list" / "do i have any homework" (2026-10-15) ----
    // Reads the same Toddle list as study mode, on demand, without entering the
    // mode. Placed BEFORE the AI catch-all below: "what homework do I have"
    // would otherwise be answered out of the local model's memory instead of
    // from Toddle, which is the opposite of what was asked.
    const todoIntent = Core.parseTodoIntent ? Core.parseTodoIntent(String(confirmLead||'').replace(/\bhome\s+way\b/gi,'homework').replace(/\bhomeway\b/gi,'homework')) : null;
    if (todoIntent) {
      setMode('EXECUTING', 'Checking your todo list');
      // Auto-enable browser control so this works without a separate
      // "enable browser control" command first.
      await localAction({ action: 'browser-control-enable' }).catch(() => {});
      // Make sure a Toddle tab exists (reused if already open) and has had
      // time to paint before readSiteTodos scrapes it.
      await localAction({ action: 'open-site', name: 'toddle' }).catch(() => {});
      const todos = await localAction({ action: 'site-todos', site: 'toddle' });
      const said = describeTodos(todos, { max: 5 });
      setMode(recognitionEnabled ? 'LISTENING' : 'IDLE', 'Todo list read');
      return said.text;
    }
    // ---- Direct voice-to-AI: "Jarvis, ask the AI ..." ----
    // The lead-in is stripped and the real question is routed into the normal
    // local-AI pipeline: streamed answer in the conversation, full chat
    // context, and the usual Fish Audio speech. Explicit tool commands never
    // route here — they are matched earlier in this handler.
    const askAiQ = confirmLead.match(/^(?:ask|tell|question|consult)\s+(?:the\s+)?(?:ai|a\.i\.|assistant|model|ollama)(?:\s+to)?\s+(?:me\s+)?(.+)$/i)
      || confirmLead.match(/^use\s+(?:your\s+)?(?:ai|assistant|model)\s+to\s+(.+)$/i)
      || confirmLead.match(/^(?:what|how|why|when|where|who|explain|describe|tell me)\s+.+/i) && /^(?:jarvis[,.!?\s]*)?/i.test(confirmLead) && !/^(?:open|close|start|stop|play|pause|search|find|take|show|list|set|add|remove|delete|create|move|copy|rename|connect|disconnect|enable|disable|turn on|turn off|minimize|maximize|focus|switch|save|send|write|read|draft|compose|schedule|remind|alarm|shutdown|restart|reboot|volume|mute|unmute)\b/i.test(confirmLead);
    if (askAiQ && String(askAiQ[1] || askAiQ[0] || '').trim()) {
      const query = String(askAiQ[1] || askAiQ[0] || '').trim().replace(/^(?:jarvis[,.!?\s]*)?/i, '').trim();
      const routeNow = latestAIStatus && latestAIStatus.router ? latestAIStatus.router : null;
      const goingRemote = Boolean(routeNow && routeNow.mode !== 'local' && Array.isArray(routeNow.remoteEligible) && routeNow.remoteEligible.length);
      setMode('THINKING', goingRemote ? 'Asking remote AI' : 'Asking the local AI');
      return { aiQuery: query, recall: true };
    }
    if (/^think\s+about\s+(?:this|that|it)\b/i.test(confirmLead)) {
      setMode('THINKING', 'Thinking it over');
      return { aiQuery: 'Think carefully about our recent conversation and what I just asked, then give me your best detailed answer.', recall: true };
    }
    // EVERY close starts here (2026-10-24). Utterances beginning with a close
    // verb were still being answered with opens ("Getting it open, Sir.") when
    // they used a pronoun or a collective — "close it", "close all", "close
    // both". This runs before every open/website/AI branch, so a close can
    // never be reinterpreted as a launch, and it never asks the model.
    {
      const closeLead = normalizeCloseText(text);
      const pronounClose = closeLead.match(/^(?:close|shut|exit|quit)\s+(?:the\s+)?(it|that|this|that one|this one)(?:\s+(?:down|now|please))?$/i);
      const collectiveClose = closeLead.match(/^(?:close|shut|exit|quit)\s+(?:all|both|them|those|these|everything|every\s*one)(?:\s+of\s+(?:it|them|those|these))?(?:\s+(?:down|now|please))?(?:\s+(?:apps?|applications?|programs?|windows?|tabs?))?$/i);
      if ((pronounClose || collectiveClose) && lastOpenedApps.length) {
        const targets = collectiveClose ? Array.from(new Set(lastOpenedApps)) : [lastOpenedApps[lastOpenedApps.length - 1]];
        setMode('EXECUTING', targets.length > 1 ? `Closing ${targets.map(humanLabel).join(', ')}` : `Closing ${humanLabel(targets[0])}`);
        const notes = [];
        for (const target of targets) {
          const closed = await localAction({ action: 'close-app', name: target });
          notes.push((closed && closed.message) || `${humanLabel(target)} is closed, Sir.`);
        }
        lastOpenedApps = collectiveClose ? [] : lastOpenedApps.slice(0, -1);
        // "Closed Discord. Closed Steam." reads like a machine. When every
        // close succeeded, say it the way a person would.
        if (notes.length && notes.every(note => /^Closed\b/.test(note))) {
          const names = targets.map(humanLabel);
          const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
          return `Done, Sir — ${list} ${names.length === 1 ? 'is' : 'are'} closed.`;
        }
        return notes.join(' ').replace(/\s+/g, ' ').trim();
      }
      // Nothing remembered: fall through instead of answering "Close what?".
      // "close it" then closes the foreground window and "close everything"
      // runs the real bulk close, so the command is never a dead end.
    }
    const openTab = Core.parseOpenTabIntent(text);if (openTab) {
      setMode('EXECUTING', 'Opening a new browser tab');
      const result = await localAction({ action: 'tabs-open' });
      return result.message || (result.ok ? 'Opened a new tab.' : 'I could not open a new tab.');
    }
    // Website navigation always uses the SAME controlled-browser session
    // (server open-site -> browser-tabs.openUrlControlled). "in a new tab" is
    // explicit tab creation inside that same window; plain "open X" reuses a
    // matching tab when one exists. "navigate to X" is treated as "open X".
    // Also strip polite lead-ins like "can you", "could you", "would you", "please"
    // so "can you open youtube" -> "open youtube" matches the site allowlist.
    const wantsNewTab = /\s+in\s+(?:a\s+)?new\s+tab[.!?]*$/i.test(text);
    const baseWebsiteText = wantsNewTab ? text.replace(/\s+in\s+(?:a\s+)?new\s+tab[.!?]*$/i, '') : text;
    const normalizedWebsiteText = baseWebsiteText
      .replace(/^(?:navigate\s+to|navigate)\s+/i, 'open ')
      .replace(/^(?:(?:can|could|would) you(?: please)?|please|just)\s+/i, 'open ')
      .replace(/^(?:(?:can|could|would) you(?: please)?|please|just)\s+/i, 'open ');
    const websiteIntent = Core.parseWebsiteIntent(normalizedWebsiteText);if (websiteIntent) {
      // Discord (and the other app-backed sites) must open the DESKTOP APP
      // when one is installed. "open discord" used to reach the website branch
      // first and always opened discord.com in a browser.
      // ROBLOX 2026-10-25: deliberately NOT app-backed any more - the user
      // asked for the official roblox.com website every time; the desktop
      // game client stays available only through "focus roblox app".
      const APP_BACKED_SITES = new Set(['discord', 'spotify', 'steam', 'canva', 'tiktok']);
      if (APP_BACKED_SITES.has(websiteIntent.site)) {
        const appAttempt = await localAction({ action: 'open-app', name: websiteIntent.site });
        if (appAttempt && appAttempt.ok) {
          rememberOpenedTarget(websiteIntent.site);
          return (chooseLocalReply('app_open_success', { app: humanLabel(websiteIntent.site) })?.response || appAttempt.message);
        }
      }
      // OPEN FIX 2026-10-21: this used to auto-enable browser control first,
      // which spawned a separate JARVIS-profile browser window beside the
      // user's own open browser on EVERY website command - the reported
      // complaint ("when I say open youtube it spawns another new browser").
      // Plain opens now use the OS default browser directly (the server's
      // open-site action), which delivers the URL into the browser window the
      // user already has open as a tab. "enable browser control" remains a
      // deliberately spoken command for tab-level features that need it.
      const payload = { action: 'open-site', name: websiteIntent.site };
      if (wantsNewTab) payload.newTab = true;
      const result = await localAction(payload);
      if (result.ok) rememberOpenedTarget(websiteIntent.site);
      return result.ok ? (chooseLocalReply('app_open_success', { app: humanLabel(websiteIntent.site) })?.response || result.message) : result.message;
    }
    // ---- YouTube + search compound commands (2026-10-21): "Open YouTube and search up [query]"
    // or "Search YouTube for [query]" — handle YouTube/YouTube Music opens with
    // a follow-up search so the two-part intent executes in order instead of
    // falling through to the AI planner with "I cannot safely identify a running process".
    const youtubeSearchLead = text.toLowerCase().match(/^\s*(?:open\s+)?(?:youtube(?:\s+music)?|youtu\.be)\s+and\s+search\s+up\s+(.+)$/i);
    if (youtubeSearchLead) {
      const query = youtubeSearchLead[1].trim();
      const site = youtubeSearchLead[0].toLowerCase().includes('music') ? 'youtube-music' : 'youtube';
      setMode('EXECUTING', `Opening ${site} and searching for "${query}"`);
      // Step 1: open the site
      const openResult = await localAction({ action: 'open-site', name: site });
      if (!openResult.ok) return openResult.message || `I could not open ${site}, Sir.`;
      // Step 2: search the site
      const searchResult = await localAction({ action: 'search-site', site, query });
      if (searchResult.ok) return searchResult.message || `Searching YouTube for "${query}", Sir.`;
      return searchResult.message || `I could not search YouTube for "${query}", Sir.`;
    }
    // Also handle "Search YouTube for [query]" / "search up [query]" without "open YouTube"
    const bareSearchLead = text.toLowerCase().match(/^\s*search(?: up)?\s+(?:youtube(?:\s+music)?|youtu\.be)\s+for\s+(.+)$/i);
    if (bareSearchLead) {
      const query = bareSearchLead[1].trim();
      const site = bareSearchLead[0].toLowerCase().includes('music') ? 'youtube-music' : 'youtube';
      setMode('EXECUTING', `Searching YouTube for "${query}"`);
      const result = await localAction({ action: 'search-site', site, query });
      return result.ok ? (result.message || `Searching YouTube for "${query}", Sir.`) : result.message;
    }
    // Plain "navigate to <site>" that the allowlist parser missed (kept for
    // robustness): retry as "open <site>" with the same new-tab rule.
    const navigateLead = text.match(/^(?:navigate\s+to|navigate|go\s+to)\s+(.+?)(?:\s+in\s+(?:a\s+)?new\s+tab)?[.!?]*$/i);
    if (navigateLead) {
      const target = navigateLead[1].trim();
      const retry = Core.parseWebsiteIntent(`open ${target}`);
      if (retry) {
        const payload = { action: 'open-site', name: retry.site };
        if (wantsNewTab || /\s+in\s+(?:a\s+)?new\s+tab[.!?]*$/i.test(text)) payload.newTab = true;
        const result = await localAction(payload);
        if (result.ok) rememberOpenedTarget(retry.site);
        return result.ok ? (chooseLocalReply('app_open_success', { app: humanLabel(retry.site) })?.response || result.message) : result.message;
      }
      // Arbitrary "go to example.com / open https://..." URLs open in the same
      // controlled window via tabs-open (PUT /json/new), never the OS default.
      const urlTarget = target.replace(/^https?:\/\//i, '').trim();
      if (/^(?:https?:\/\/\S+|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)$/i.test(target) || /^https?:\/\/\S+$/i.test(target)) {
        let url = /^https?:\/\//i.test(target) ? target : `https://${urlTarget}`;
        setMode('EXECUTING', `Opening ${urlTarget}`);
        const result = await localAction({ action: 'tabs-open', url });
        return result.ok ? result.message : result.message;
      }
    }
    // YouTube video transport (watch pages): next-video vs seek vs skip-ad are
    // distinguished by Core.parseYouTubeControl and routed to the controlled
    // browser's actual YouTube tab — never the generic music handler. Placed
    // before AI planning so plain "skip this video" never falls to chat, and
    // discovery follow-ups ("open the first one") resolve against real results.
    const youtubeControl = Core.parseYouTubeControl(requestText);if (youtubeControl) {
      return handleYouTubeControl(youtubeControl);
    }
    const discoveryIntent = Core.parseDiscoveryIntent(text);if (discoveryIntent) {
      return handleDiscovery(discoveryIntent, text);
    }
    // Compound command chains ("open YouTube then my Roblox") run their steps
    // in order. This MUST run before the AI planning route and before the
    // YouTube search fallback: without it the whole utterance became one
    // search query instead of two actions.
    const commandChain = Core.parseCommandChain ? Core.parseCommandChain(requestText) : null;
    if (commandChain && commandChain.steps.length > 1) {
      voiceLog('command chain', commandChain.steps.map(step => `${step.kind}:${step.label}`).join(' -> '));
      return runCommandChain(commandChain.steps);
    }
    // Hybrid routing: compound or referential requests skip the one-shot
    // handlers and go to Ollama with the planning protocol plus real tools.
    // Simple commands return false above and keep the fast path untouched.
    if (Core.needsAiPlanning(text)) {
      voiceLog('ai planning route', text.slice(0, 80));
      return { aiQuery: text, plan: true };
    }
    // Transport controls share one parser with the voice pipeline so spoken
    // and typed phrasings ("stop what's playing", "skip", bare "stop")
    // reach the real media control instead of falling through to chat.
    const musicControl = Core.parseMusicControl(requestText);if (musicControl) {
      const result = await localAction({ action: 'music-control', command: musicControl.command });
      if (!result.ok) return result.message;
      const unverified = result.verified === false ? ' I could not verify the player state.' : '';
      if (result.message) return `${result.message}${unverified}`;
      return `Music control sent.${result.title ? ` Now ${String(result.status || '').toLowerCase()}: ${result.title}${result.artist ? ` by ${result.artist}` : ''}.` : ''}${unverified}`;
    }
    const embeddedMusic = Core.extractEmbeddedMusicCommand(text);if (embeddedMusic === 'open-music') {
      // Mixed small talk plus a music action ("I'm bored, put some music
      // on"): the music action wins over chit-chat. Opens the service without
      // ever claiming playback.
      const result = await localAction({ action: 'open-site', name: 'youtube-music' });
      return result.ok ? 'YouTube Music is open, Sir   pick a track to start playing.' : (result.message || 'I could not open YouTube Music.');
    }
    const musicIntent = Core.parseMusicIntent(text);if (musicIntent) {
      if (!musicIntent.query) return 'Which song should I open on YouTube Music, Sir?';
      if (/^(?:some )?music$/i.test(musicIntent.query)) {
        const result = await localAction({ action: 'open-site', name: 'youtube-music' });
        return result.ok ? 'YouTube Music is open, Sir   pick a track to start playing.' : (result.message || 'I could not open YouTube Music.');
      }
      // Deterministic guard: a filler or generic query ("it", "something")
      // never reaches the search backend.
      const musicVerdict = Core.classifyMusicAnswer ? Core.classifyMusicAnswer(musicIntent.query) : null;
      if (musicVerdict && musicVerdict.kind !== 'request') {
        if (musicVerdict.kind === 'anything') {
          const home = await localAction({ action: 'open-site', name: 'youtube-music' });
          return home && home.ok ? 'YouTube Music is open, Sir. Name an artist any time and I will find it.' : (home && home.message) || 'I could not open YouTube Music just now, Sir.';
        }
        if (musicVerdict.kind === 'nothing' || musicVerdict.kind === 'cancel') return 'No problem, Sir. I will leave music alone.';
        return 'Which song should I play, Sir?';
      }
      const result = await localAction({ action: 'music-search', query: musicIntent.query });
      if (!result.ok) return result.message || 'I could not search YouTube Music right now.';
      lastMediaQuery = { site: 'youtube-music', query: musicIntent.query };
      return (chooseLocalReply('music_search', { query: musicIntent.query })?.response || result.message);
    }
    const discordPing = Core.parseDiscordPingCommand(text);if (discordPing) {
      setMode('EXECUTING', discordPing === 'ping' ? 'Sending your ping' : 'Testing Discord notifications');
      const result = await localAction({ action: 'discord-ping', what: discordPing });
      voiceLog('discord ping', `${discordPing} - ${result.ok ? 'sent' : (result.status || 'failed')}`);
      return result.ok
        ? (discordPing === 'ping' ? 'Ping sent   check your Discord, Sir.' : 'Test notification sent   check your Discord, Sir.')
        : (result.message || 'I could not send that Discord notification, Sir.');
    }
    const discordIntent = Core.parseDiscordIntent(text);if (discordIntent) {
      setMode('EXECUTING', `Resolving ${discordIntent.recipient} on Discord`);
      const resolve = await localAction({ action: 'discord-resolve', name: discordIntent.recipient });
      if (!resolve.ok) {
if (resolve.status === 'ambiguous' && Array.isArray(resolve.matches) && resolve.matches.length) return showDiscordChoices(resolve.matches, discordIntent.body || '');
        return resolve.message || `I could not find a Discord contact named ${discordIntent.recipient}.`;
      }
      if (discordIntent.body) {
        showDiscordPreview(resolve.recipient, discordIntent.body);
        const label = resolve.recipient.name || resolve.recipient.username || resolve.recipient.id;
        return `Your message to ${label} is ready. Review it on screen   I send it only after your confirmation.`;
      }
      // Body missing: collect it through the pending Discord flow instead of
      // prompting in a blocking dialog.
      pendingFlow = Core.startPendingFlow('discord', { values: { recipient: String(resolve.recipient.name || resolve.recipient.username || resolve.recipient.id) } });
      pendingFlow.recipient = resolve.recipient;
      setVoiceSession({ status: 'awaiting-answer', conversationActive: true, waitingFor: pendingFlow.step, pendingKind: 'discord', lastQuestion: pendingFlow.question, expiresAt: pendingFlow.expiresAt }, 'flow-started');
      return pendingFlow.question;
    }if (/\b(switch to|focus)\b/.test(lower)) {
      const name = text.replace(/^.*?\b(?:switch to|focus)\b/i, '').trim();
      setMode('EXECUTING', `Switching to ${name}`);
      // Tab-first: "switch to my Gmail tab" activates the existing matching
      // tab inside the SAME controlled window instead of focusing an app.
      if (/\btab\b/i.test(text) || /^(?:my\s+)?(youtube(?:\s+music)?|google|gmail|wikipedia|tiktok|instagram|discord)(?:\s+tab)?$/i.test(name.replace(/\s+tab$/i, ''))) {
        const query = name.replace(/^(?:my\s+|the\s+|this\s+)/i, '').replace(/\s+tab$/i, '').trim() || name;
        const tabResult = await localAction({ action: 'tabs-activate', query });
        if (tabResult && (tabResult.ok || tabResult.needsSetup || tabResult.status === 'ambiguous')) return tabResult.message;
        // If no matching tab, fall through to app focus below.
        if (tabResult && !tabResult.ok && /could not find/i.test(tabResult.message || '')) {
          const openResult = await localAction({ action: 'open-site', name: query.toLowerCase().replace(/\s+/g, '-') });
          if (openResult && openResult.ok) return openResult.message;
          return tabResult.message;
        }
        if (tabResult && tabResult.ok) return tabResult.message;
      }
      return (await localAction({ action: 'focus-app', name })).message;
    }if (pendingEmailDraft && !pendingFlow) {
      const edit = text.match(/^(?:change|update|set)(?: the)? (subject|recipient|to|body|message)(?: to)? (.+)$/i);
      if (edit) {
        const field = /subject/i.test(edit[1]) ? 'subject' : /body|message/i.test(edit[1]) ? 'body' : 'to';
        const card = $('#emailDraftCard');
        const input = card?.querySelector(field === 'subject' ? '.draft-subject' : field === 'body' ? '.draft-body' : '.draft-to');
if (input) {
          input.value = edit[2].trim(); pendingEmailDraft[field] = edit[2].trim();
          localStorage.setItem('jarvis-pending-email', JSON.stringify(pendingEmailDraft));
          return `Updated the ${field === 'to' ? 'recipient' : field}, Sir.`;
        }
        return 'Open the draft on screen first, Sir.';
      }
    }
    const email = requestText.match(/^(?:write|draft|compose) (?:an? )?email to ([^\s@]+@[^\s@]+) subject (.+?) body (.+)$/i);if (email) {
      setMode('EXECUTING', 'Preparing an email draft');
      showEmailDraft({ to: email[1], subject: email[2], body: email[3] });
      return 'I drafted the email for your review. Approve and open it when ready; I will not send it.';
    }
    // A command carrying recipient, subject, and body answers every question
    // up front: build the draft directly instead of asking or guessing.
    const full = Core.extractEmailParts(requestText);if (/^(?:write|draft|compose|send|start)\s+(?:an?\s+)?(?:email|e-?mail)\b/i.test(requestText) && full.to && full.subject && full.body) {
      setMode('EXECUTING', 'Preparing the email draft');
      showEmailDraft({ to: full.to, subject: full.subject, body: full.body });
      try { await localAction({ action: 'mail-save-draft', to: full.to, subject: full.subject, body: full.body }); } catch (error) { voiceLog('email draft save failed', error.message); }
      let done = 'Your email draft is ready on screen for review. Approve and open it when you are happy with it, or tell me any change first.';
      if (Core.emailToStatus(full.to) === 'name') done += ` I kept "${full.to}" as the name   add the address in the To field, or tell me the address.`;
      return done;
    }if (/^(?:show|list|what are|view)(?: me)? my (?:email )?drafts$/i.test(requestText)) {
      const result = await localAction({ action: 'mail-list-drafts' });
      const drafts = result.drafts || [];
      if (!drafts.length) return 'You have no saved email drafts, Sir.';
      return `Saved email drafts: ${drafts.map((item, index) => `${index + 1}. "${item.subject || 'Untitled'}"${item.to ? ` to ${item.to}` : ''}`).join('; ')}.`;
    }
    // Summaries use genuinely retrieved inbox messages only. Without a
    // connected account the inbox reports exactly that   nothing is invented.
    if ((/\bsummar(?:y|ise|ize)\b/.test(lower) || /\baction items\b/.test(lower) || /\bimportant emails\b/.test(lower)) && /\b(?:email|e-?mail|inbox)\b/.test(lower)) {
      const detail = /\b(?:detail(?:ed)?|fully|full)\b/.test(lower);
      const limit = /\b(?:latest|last|newest)\b/.test(lower) ? 1 : 5;
      let list;
      try {
        const response = await fetch(`/api/mail/list?limit=${limit}`, { signal: AbortSignal.timeout(60000) });
        list = await response.json();
      } catch (error) { return 'I could not reach the inbox right now, Sir.'; }
      if (!list.ok) return `${list.message || 'I could not read the inbox.'} Sir.`;
      if (!list.emails?.length) return 'Your inbox is empty, Sir.';
      const parts = list.emails.slice(0, limit).map(item => Core.summarizeEmail(item, detail));
      return detail && parts.length === 1 ? parts[0] : `Here is what is in your inbox, Sir: ${parts.join(' ')}`;
    }if (/^(?:write|draft|compose|send|start) (?:an? )?email\b/i.test(requestText)) {
      // Multi-turn email workflow: ask only for what is missing (recipient,
      // subject, body). Complete one-shots are handled above.
      const emailFlow = Core.parseEmailFlowStart(requestText);
      if (emailFlow) { pendingFlow = emailFlow; setVoiceSession({ status: 'awaiting-answer', conversationActive: true, waitingFor: pendingFlow.step, pendingKind: 'email', lastQuestion: pendingFlow.question, expiresAt: pendingFlow.expiresAt }, 'flow-started'); return pendingFlow.question; }
      setMode('EXECUTING', 'Preparing an email draft for review'); createAbsenceDraft(requestText);
      return 'I prepared an email draft for your review. Edit it, then approve and open it. It will not be sent automatically.';
    }
    // ---- YouTube creator search (2026-10-14): vocabulary correction +
    // natural creator variations ("find the official channel for X",
    // "open X's channel", "videos by X"). Runs BEFORE generic site/Google
    // search so a creator name is never treated as an installed app or a
    // plain web query. Music verbs and youtube-music mentions stay with
    // their handlers. Raw text is preserved in diagnostics; the normalized
    // query travels separately.
    if (Core.extractCreatorSearch && Core.correctCreatorQuery && !/youtube\s*music/i.test(text)) {
      const learned = learnedCreators();
      const fix = Core.correctCreatorQuery(text, { learned });
      if (fix && fix.applied.length) voiceLog('creator correction', `${fix.applied.map(a => `"${a.from}"->"${a.to}"`).join('; ')} (raw kept in transcript)`);
      const phraseHit = Core.matchKnownPhrase ? Core.matchKnownPhrase(text) : null;
      if (phraseHit && /for the phrase|exact phrase|the words?\b|saying\b/i.test(text)) {
        setMode('SEARCHING', `Searching YouTube for "${phraseHit.phrase}"`);
        const result = await localAction({ action: 'search-site', site: 'youtube', query: phraseHit.phrase });
        if (result.ok) lastMediaQuery = { site: 'youtube', query: phraseHit.phrase };
        return result.ok ? `Searching YouTube for "${phraseHit.phrase}", Sir.` : (result.message || 'I could not search YouTube right now, Sir.');
      }
      const runCreatorSearch = async (rawName, topic, officialOnly, similar) => {
        const norm = Core.correctCreatorQuery(rawName, { learned });
        const canonical = norm && norm.applied.length ? norm.applied[0].to
          : (norm && norm.hasCreator ? rawName.trim() : rawName.trim());
        if (!canonical) return null;
        const known = Boolean(norm && norm.hasCreator);
        const q = [canonical, topic].filter(Boolean).join(' ').slice(0, 120);
        if (!known) trackCreatorSearch(q);
        else if (norm && norm.applied.length) voiceLog('creator correction', `"${rawName}"->"${canonical}"`);
        setMode('SEARCHING', `Searching YouTube for ${canonical}`);
        const result = await localAction({ action: 'search-site', site: 'youtube', query: q });
        if (result.ok) lastMediaQuery = { site: 'youtube', query: q };
        if (!result.ok) return result.message || 'I could not search YouTube right now, Sir.';
        if (officialOnly) return `Showing YouTube results for ${canonical}, Sir. Pick the official channel — look for the verified badge — since fan uploads share the name.`;
        if (similar) return `Showing results for ${canonical}, Sir. Related channels appear alongside — tell me which one to open.`;
        return `Searching YouTube for ${canonical}${topic ? ` about ${topic}` : ''}, Sir.`;
      };
      const shape = Core.extractCreatorSearch(text);
      if (shape && shape.name) {
        const done = await runCreatorSearch(shape.name, shape.topic, shape.officialOnly, shape.similar);
        if (done) return done;
      } else if (shape && !shape.name && shape.similar) {
        return 'Which creator should I find channels like, Sir?';
      }
      // Bare "search X" / "find X" / "look up X" where X hits the vocabulary:
      // YouTube, not Google and not the installed-app lookup.
      const bareLead = Core.stripPoliteLead(text).replace(/[.!?]+$/, '').trim();
      if (!shape && fix && (fix.changed || fix.hasCreator) && /^(?:search(?: for| up)?|find|look\s*up|lookup)\b/i.test(bareLead)) {
        const q = fix.query.replace(/^(?:search(?: for| up)?|find|look\s*up|lookup)\s+/i, '').replace(/\s+on\s+youtube$/i, '').trim().slice(0, 120) || fix.query.slice(0, 120);
        if (q && !/^(?:some|the|it|this|that|music|video)$/i.test(q)) {
          trackCreatorSearch(fix.hasCreator ? '' : q);
          setMode('SEARCHING', `Searching YouTube for ${q}`);
          const result = await localAction({ action: 'search-site', site: 'youtube', query: q });
          if (result.ok) lastMediaQuery = { site: 'youtube', query: q };
          if (result.ok) return `Searching YouTube for ${q}, Sir.`;
        }
      }
    }
    const siteSearch = Core.parseSiteSearchIntent(text);if (siteSearch) {
      let result;
      const searchNewTab = /\s+in\s+(?:a\s+)?new\s+tab[.!?]*$/i.test(text);
      if (siteSearch.site === 'youtube-music') {
        result = await localAction({ action: 'music-search', query: siteSearch.query });
if (result.ok && !siteSearch.silent) {
          return (chooseLocalReply('music_search', { query: siteSearch.query })?.response || result.message);
        }
      } else {
        const payload = { action: 'search-site', site: siteSearch.site, query: siteSearch.query };
        if (searchNewTab) payload.newTab = true;
        result = await localAction(payload);
      }
      if (result.ok) lastMediaQuery = { site: siteSearch.site, query: siteSearch.query };
      return result.ok && siteSearch.silent ? { silent: true, statusText: result.message } : result.message;
    }
    // File-result opening: "open it" / "open the second result" act on the
    // most recent file search. This must run before the generic app opener,
    // which used to read "open it" as an application name.
    const wantsFileOpen = /^(?:open|launch|show)\s+(?:it|that|them|the\s+(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|\d{1,2}(?:st|nd|rd|th)?)\s+(?:one|result|results|file|files|match|item)?|last\s+one)$/i.test(confirmLead);if (wantsFileOpen) {
      if (!lastFileResults.length) {
        if (lastMediaQuery && lastMediaQuery.query) return openLastMedia();
        return 'I do not have a file search result yet, Sir. Say "find ..." first.';
      }
      const ordinal = Core.parseOrdinalTarget(text);
      const index = ordinal ? (ordinal.last ? lastFileResults.length - 1 : (ordinal.position || 1) - 1) : 0;
      const target = lastFileResults[index];
      if (!target) return `Your last search returned ${lastFileResults.length} result${lastFileResults.length === 1 ? '' : 's'}, so that one does not exist, Sir.`;
      return openFoundFile(target);
    }
    // Media pronouns ("open this song", "play that video", "open that"): when
    // they name a track or video, they resolve to the most recent media
    // search instead of the app launcher. Bare pronouns defer to file results
    // above when any exist.
    const mediaPronoun = confirmLead.match(/^(?:open|launch|start|play)\s+(?:this|that|it|them)(?:\s+(?:song|track|video|music|tune|clip))?(?:\s+please)?$/i);if (mediaPronoun && lastMediaQuery && lastMediaQuery.query) {
      return openLastMedia();
    }if (mediaPronoun && !lastMediaQuery) {
      return 'Which song or video should I open, Sir? Tell me the title.';
    }
    // Follow-up references ("open that folder", "look inside it") resolve
    // against the most recent file search instead of starting over.
    const taskRef = Core.resolveTaskReference(text, lastFileResults);if (taskRef && /^(?:open|launch|show)\b/i.test(Core.stripPoliteLead(text))) return openFoundFile(taskRef);if (taskRef && /\b(list|contents|inside|look inside|what(?:'s| is) in)\b/i.test(text)) {
      setMode('SEARCHING', `Listing ${taskRef.name}`);
      const listed = await localAction({ action: 'list-directory', id: taskRef.id });
      if (!listed.ok) return listed.message;
      const names = (listed.items || []).map(item => `${item.name}${item.type === 'folder' ? '/' : ''}`).join(', ');
      return `${listed.message} ${names || 'Nothing listed.'}`;
    }
    const fileIntent = Core.parseFileSearchIntent(text);
    const looksFileish = Boolean(fileIntent) && (fileIntent.folder || fileIntent.extension || fileIntent.latest || fileIntent.explicit
      || /\b(?:file|files|folder|folders|document|documents|download|downloads|picture|pictures|photo|photos|video|videos|music|pdf|docx?|xlsx?|txt|text|csv|json|image|images|screenshot|notes?|homework|assignment|project|report|resume|invoice)\b/i.test(`${fileIntent.query} ${text}`));if (looksFileish) {
      setMode('SEARCHING', `Searching files for ${fileIntent.query || fileIntent.folder || fileIntent.extension || 'files'}`);
      const result = await localAction({ action: 'search-files', query: fileIntent.query, folder: fileIntent.folder, extension: fileIntent.extension, latest: fileIntent.latest, withinDays: fileIntent.withinDays });
      if (result.results?.length) {
        lastFileResults = result.results;
        window.lastFoundFile = result.results[0].id;
        result.results.slice(0, 3).forEach((item, index) => addMessage('FOUND', `${index + 1}. ${item.name}${item.type === 'folder' ? ' (folder)' : ''}\n${item.path}`));
        return `${result.message} Top result: ${result.results[0].name}${result.results[0].type === 'folder' ? ' (folder)' : ''}. Say "open it" or "open the second result", Sir.`;
      }
      lastFileResults = [];
      return result.message;
    }
    const searchCommand = Core.parseSearchCommand(text);if (searchCommand) {
      const result = await localAction({ action: 'search-site', site: 'google', query: searchCommand.query });
      return result.ok ? { silent: true, statusText: result.message } : result.message;
    }
    const googleTab = Core.parseOpenGoogleTabIntent(text);if (googleTab) {
      const result = await localAction({ action: 'tabs-open', url: googleTab.url });
      return result.ok ? result.message : result.message;
    }
    // Music intent: "open some music", "play some music", "let's listen to
    // music", etc. must open YouTube Music — never fall through to the app
    // launcher looking for an app called "some music".
    const musicOpenIntent = Core.parseMusicOpenIntent(requestText);
    if (musicOpenIntent) {
      if (musicOpenIntent.kind === 'open-music') {
        // OPEN FIX 2026-10-21: no auto-enable here - "open some music" is an
        // open verb, so it must land in the browser the user already has
        // open (the server's open-site action now uses preferDefault),
        // never spawn the separate controlled window.
        const result = await localAction({ action: 'open-site', name: 'youtube-music' });
        if (result.ok) {
          musicOpened = true;
          setMode('EXECUTING', 'Music mode on');
          return 'Music mode on.';
        }
        return result.message || 'I could not open YouTube Music, Sir.';
      }
      // Specific song/artist: search YouTube Music. The deterministic guard
      // runs first so hesitation or generic phrasing ("play some music",
      // "play it") never becomes a literal search query.
      if (musicOpenIntent.kind === 'search-music' && musicOpenIntent.query) {
        await localAction({ action: 'browser-control-enable' }).catch(() => {});
        const verdict = Core.classifyMusicAnswer ? Core.classifyMusicAnswer(text) : null;
        if (verdict && verdict.kind !== 'request') {
          if (verdict.kind === 'anything') {
            const home = await localAction({ action: 'open-site', name: 'youtube-music' });
            return home && home.ok ? 'YouTube Music is open, Sir. Name an artist any time and I will find it.' : (home && home.message) || 'I could not open YouTube Music just now, Sir.';
          }
          if (verdict.kind === 'nothing' || verdict.kind === 'cancel') return 'No problem, Sir. I will leave music alone.';
          return 'Which song should I play, Sir?';
        }
        const query = (verdict && verdict.title ? verdict.title : musicOpenIntent.query).slice(0, 120);
        const result = await localAction({ action: 'music-search', query });
        if (!result.ok) return result.message || 'I could not search YouTube Music right now.';
        lastMediaQuery = { site: 'youtube-music', query };
        musicOpened = true;
        setMode('EXECUTING', 'Music mode on');
        return (chooseLocalReply('music_search', { query })?.response || result.message);
      }
    }
    // Anchored: only a phrase that STARTS with open/launch/start (after the
    // polite lead) becomes an app launch, so mid-sentence mentions such as
    // "later I want to open chrome" go to the assistant instead of firing.
    // Pronoun close ("can you close it" right after "open my steam"): answered
    // here, before any AI conversation routing can invent a "Closed Steam"
    // reply, and closed through the verified desktop action.
    {
      const pronounClose = Core.stripPoliteLead(text).replace(/[.!?]+$/, '').trim();
      if (/^(?:close|shut|exit|quit)\s+(?:it|that|that one|this|the app)(?:\s+(?:down|now|please))?$/i.test(pronounClose) && lastOpenedApps.length) {
        const target = lastOpenedApps[lastOpenedApps.length - 1];
        setMode('EXECUTING', `Closing ${target}`);
        const closed = await localAction({ action: 'close-app', name: target });
        if (closed && closed.ok) {
          lastOpenedApps = lastOpenedApps.slice(0, -1);
          return closed.message || `Closed ${target}.`;
        }
        return (closed && closed.message) || `I could not close ${target}, Sir.`;
      }
    }
    const openLead = Core.stripPoliteLead(text).replace(/[.!?]+$/, '').trim();if (/^(?:open|launch|start)(?: it| up)?$/i.test(openLead) && !wantsFileOpen) return 'Which application should I open, Sir?';
    const openMatch = openLead.match(/^(?:open|launch|start)\s+(?:up\s+)?(.+)$/i);if (openMatch) {
      const rawName = openMatch[1].replace(/\b(please|for me)\b/ig, '').trim();
      if (!rawName) return 'Which application should I open?';
      // Explicit "open X in a new tab" creates the tab inside the SAME
      // controlled window instead of a separate browser.
      const openNewTabSuffix = /\s+in\s+(?:a\s+)?new\s+tab$/i.test(rawName);
      const name = openNewTabSuffix ? rawName.replace(/\s+in\s+(?:a\s+)?new\s+tab$/i, '').trim() : rawName;
      if (!name) return 'Which application should I open?';
      // "open my discord" names the same app as "open discord": the
      // possessive is speech, not part of the program name.
      const appName = name.replace(/^(?:my|our|your|his|her)\s+/i, '').trim() || name;
      // Windows known folders open by their resolved path, never by asking
      // the app launcher to guess a program called "downloads folder".
      const folderMatch = name.match(/^(?:the\s+)?(downloads?|documents?|desktop|pictures?|photos?|videos?|music)(?:\s+folder)?$/i);
      if (folderMatch) {
        const folderKeys = { download: 'Downloads', downloads: 'Downloads', document: 'Documents', documents: 'Documents', desktop: 'Desktop', picture: 'Pictures', pictures: 'Pictures', photo: 'Pictures', photos: 'Pictures', video: 'Videos', videos: 'Videos', music: 'Music' };
        const key = folderKeys[folderMatch[1].toLowerCase()];
        setMode('EXECUTING', `Opening your ${key} folder`);
        return (await localAction({ action: 'open-folder', key })).message;
      }
      const site = name.toLowerCase().replace(/\s+(?:website|web|site)$/, '').trim();
      // Registry-driven: the site allowlist lives in Core (websiteUrls), so a
      // site added there is openable here without a second hand-kept list.
      // Apps that exist BOTH as a desktop program and a website are opened as
      // the program first ("open my discord" used to launch discord.com in the
      // browser). The site is only the fallback when the app is not installed,
      // so nothing that merely shares a name with a site is hijacked.
      // ROBLOX 2026-10-25: deliberately NOT desktop-first any more - "open
      // Roblox" must open the official website, never the game client
      // (user request; the site registry carries roblox.com).
      const DESKTOP_FIRST_APPS = /^(?:discord|spotify|steam|telegram|whatsapp|signal|slack|zoom|teams|skype|notion|figma|obsidian|visual studio code|vscode|epic games|battle\.net|minecraft|valorant)$/i;
      if (DESKTOP_FIRST_APPS.test(appName.trim()) && !openNewTabSuffix) {
        setMode('EXECUTING', `Opening ${appName}`);
        const asApp = await localAction({ action: 'open-app', name: appName });
        if (asApp && asApp.ok) return asApp.message || `Opening ${appName}.`;
      }
      const siteIntent = Core.parseWebsiteIntent ? Core.parseWebsiteIntent(`open ${name}`) : null;
      if (siteIntent) {
        setMode('EXECUTING', `Opening ${name}`);
        const payload = { action: 'open-site', name: siteIntent.site };
        if (openNewTabSuffix) payload.newTab = true;
        const result = await localAction(payload);
        return result.ok ? (chooseLocalReply('app_open_success', { app: name })?.response || result.message) : result.message;
      }
      void site;
      // Several apps in one sentence ("open my roblox my minecraft and my
      // valerant"): open every target, then report exactly what opened.
      const appList = splitAppTargets(appName);
      if (appList) {
        setMode('EXECUTING', `Opening ${appList.join(', ')}`);
        const outcomes = await Promise.all(appList.map(async target => {
          try {
            // A website named in the list opens as a website, exactly like the
            // single "open roblox" command (roblox.com, not the game client);
            // desktop-first apps (Discord, Steam) still prefer the program.
            const asSite = Core.parseWebsiteIntent ? Core.parseWebsiteIntent(`open ${target}`) : null;
            const targetSite = asSite && !DESKTOP_FIRST_APPS.test(String(target).trim()) ? asSite.site : '';
            const opened = await localAction(targetSite ? { action: 'open-site', name: targetSite } : { action: 'open-app', name: target });
            return { target, ok: Boolean(opened && opened.ok), message: String((opened && opened.message) || '') };
          } catch (error) {
            return { target, ok: false, message: String((error && error.message) || error || '') };
          }
        }));
        const openedOk = outcomes.filter(item => item.ok);
        const missing = outcomes.filter(item => !item.ok);
        if (openedOk.length) {
          const labels = openedOk.map(item => {
            const matched = item.message.match(/^Opening (.+?)\.$/);
            return matched ? matched[1] : item.target;
          });
          let reply = `Opening ${labels.join(', ')}.`;
          if (missing.length) reply += ` I could not find ${missing.map(item => item.target).join(', ')}.`;
          for (const openedTarget of appList) rememberOpenedTarget(openedTarget);
          return reply;
        }
        if (missing.length === 1 && missing[0].message) return missing[0].message;
        return `I could not open ${missing.map(item => item.target).join(', ')}.`;
      }
      setMode('EXECUTING', `Opening ${name}`);
      const result = await localAction({ action: 'open-app', name: appName });
      // Remember the single open too, so "close it" has a real target.
      if (result.ok) rememberOpenedTarget(appName);
      if (result.ok) return (chooseLocalReply('app_open_success', { app: humanLabel(name) })?.response || result.message);
      // A compound request must never be searched for literally. "Open YouTube
      // then open Google Sheets" is two actions; when the chain parser could
      // not resolve it, asking YouTube for the sentence "YouTube then open
      // Google Sheets" is the nonsense the user reported. Retry as a chain on
      // the remainder, and otherwise say what could not be opened.
      if (/\b(?:then|after\s+that|and\s+then|\band\b|followed\s+by)\b/i.test(name) || /\s(?:open|launch|start|go\s+to|visit|run|close|shut|exit|quit)\s+/i.test(name)) {
        const retryChain = Core.parseCommandChain ? Core.parseCommandChain(text) : null;
        if (retryChain && retryChain.steps.length > 1) return runCommandChain(retryChain.steps);
        voiceLog('compound open refused as a search', name.slice(0, 90));
        return `I could not open that, Sir. Say the actions one at a time and I will run each one.`;
      }
      // Never turn a failed app open into a YouTube search of the sentence:
      // "open my tiny task" used to land on a results page for the phrase.
      // Only genuinely media-shaped targets still search.
      const looksLikeMediaQuery = /\bby\b|\bsong\b|\bmusic\b|\bmovie\b|\btrailer\b|\banime\b|\bepisode\b/i.test(name) || /["']/.test(rawName);
      if (!looksLikeMediaQuery) {
        // Rotate the wording: saying the same sentence four times in a row
        // ("Open this heart" ... live log 2026-10-30) is what makes a voice
        // assistant sound like a recording, not a person.
        const missingLines = [
          `I couldn't find an installed app called ${name}, Sir. Nothing was opened.`,
          `Nothing installed goes by “${name}”, Sir — I left everything as it was.`,
          `I don't have an app called ${name}, Sir. If it is something online, say “search ${name}”.`
        ];
        notFoundCount += 1;
        return missingLines[notFoundCount % missingLines.length];
      }
      setMode('SEARCHING', `Searching YouTube for ${name}`);
      const fallback = await localAction({ action: 'search-site', site: 'youtube', query: name });
      return fallback.ok ? (fallback.message || `Searching YouTube for ${name}, Sir.`) : result.message;
    }
    // Bare app names (2026-10-15): "Steam" means "open Steam". The whole
    // utterance must be just an allowlisted name (Core.parseBareAppName),
    // so ordinary talk never fires the launcher. Checked AFTER the
    // open/launch/start branch, which keeps priority for verb phrases.
    const bareLaunch = (!wantsFileOpen && Core.parseBareAppName) ? Core.parseBareAppName(openLead) : null;if (bareLaunch) {
      const bareName = bareLaunch.name;
      const bareSite = bareName.toLowerCase().replace(/\s+(?:website|web|site)$/, '').trim();
      const bareSiteIntent = Core.parseWebsiteIntent ? Core.parseWebsiteIntent(`open ${bareName}`) : null;
      if (bareLaunch.kind === 'site' && bareSiteIntent) {
        setMode('EXECUTING', `Opening ${bareName}`);
        const siteResult = await localAction({ action: 'open-site', name: bareSiteIntent.site });
        if (siteResult.ok) rememberOpenedTarget(bareSiteIntent.site);
        return siteResult.ok ? (chooseLocalReply('app_open_success', { app: humanLabel(bareName) })?.response || siteResult.message) : siteResult.message;
      }
      setMode('EXECUTING', `Opening ${bareName}`);
      const appResult = await localAction({ action: 'open-app', name: bareName });
      if (appResult.ok) rememberOpenedTarget(bareName);
      // No YouTube fallback here (unlike "open X"): the allowlist already
      // restricted this to known apps, so a miss is reported honestly.
      return appResult.ok ? (chooseLocalReply('app_open_success', { app: humanLabel(bareName) })?.response || appResult.message) : appResult.message;
    }
    // Loose site mention (2026-10-21): "And YouTube", "YouTube please", "Then Google"
    // etc. Strips filler words and opens the site if the last word is a known site.
    // This runs AFTER the strict bare launch so "YouTube" still works, and
    // AFTER website intent so "open YouTube" keeps priority.
    const looseSite = (!wantsFileOpen && Core.parseLooseSiteMention) ? Core.parseLooseSiteMention(text) : null;
    if (looseSite) {
      setMode('EXECUTING', `Opening ${looseSite.name}`);
      const siteResult = await localAction({ action: 'open-site', name: looseSite.name });
      if (siteResult.ok) rememberOpenedTarget(looseSite.name);
      return siteResult.ok ? (chooseLocalReply('app_open_success', { app: humanLabel(looseSite.name) })?.response || siteResult.message) : siteResult.message;
    }
    // Music panel overlay: show/hide must win over the generic app-close
    // branch ("close the music player" is not an application).
    const musicPanelCmd = Core.parseMusicPanelCommand(text);if (musicPanelCmd) {
      if (typeof window !== 'undefined' && window.MusicOrb) {
if (musicPanelCmd.action === 'show') { window.MusicOrb.show(true); return 'Music player shown, Sir.'; }
        window.MusicOrb.hide(true); return 'Music player hidden, Sir.';
      }
      return 'The music player overlay is not available right now.';
    }
    // Restore-my-tab (2026-10-14): dedicated Edge destination. Checked
    // BEFORE the generic closed-tab reopen path ("restore my tab" matches
    // both; the designated video wins by order). Speech flows through the
    // normal pipeline, so TTS gating and echo guards apply unchanged.
    const restoreTab = Core.parseRestoreTabIntent ? Core.parseRestoreTabIntent(text) : null;
    // Disabled per user request: designated Edge/random-video restore is no
    // longer invoked; requests fall through to the normal closed-tab reopen.
    if (false && restoreTab) {
      setMode('EXECUTING', 'Restoring your tab in Microsoft Edge');
      const result = await localAction({ action: 'restore-my-tab' });
      if (result && result.ok && result.verified) return 'Your tab is back in Microsoft Edge, Sir.';
      voiceLog('restore-my-tab failed', (result && result.message) || 'no result');
      return (result && result.message) || 'I could not restore that tab in Microsoft Edge, Sir.';
    }
    const reopenIntent = Core.parseReopenTabIntent ? Core.parseReopenTabIntent(text) : null;if (reopenIntent) {
      if (reopenIntent.vague) {
        const recentClose = Date.now() - lastTabCloseAt < 120000;
        const recentCloseTalk = /clos(?:e|ed|ing)|tab/i.test(String(conversationHistory.slice(-4).map(m => m.text || '').join(' ')));
        if (!recentClose && !recentCloseTalk) return 'Which tab should I bring back, Sir? Tell me the page, or close a tab first and say "undo that" again.';
      }
      if (reopenInFlight) { voiceLog('reopen dropped - already running', text); return 'I am already restoring your tab, Sir — one moment.'; }
      reopenInFlight = true;
      try {
        setMode('EXECUTING', reopenIntent.count > 1 ? `Restoring ${reopenIntent.count} closed tabs` : 'Restoring the last closed tab');
        const result = await localAction({ action: 'tabs-reopen', count: reopenIntent.count });
        if (result.ok) return result.message || 'Reopened the last closed tab.';
        // Honest fallback: tabs closed through CDP never enter Chrome's native
        // closed-tab stack, so Ctrl+Shift+T finds nothing. Re-open the URL from
        // JARVIS's own recent-close note instead — same page, new tab, and the
        // reply says so instead of claiming a native restore.
        if (!result.needsSetup) {
          try {
            const listed = await localAction({ action: 'tabs-list' });
            const openUrls = new Set((listed.tabs || []).map(t => String(t.url || '').toLowerCase()));
            const candidates = lastClosedTabs.filter(e => !openUrls.has(String(e.url || '').toLowerCase())).slice(0, reopenIntent.count);
            if (candidates.length) {
              const done = [];
              for (const entry of candidates) {
                const opened = await localAction({ action: 'tabs-open', url: entry.url });
                if (opened.ok && opened.verified) done.push(entry.title || entry.url);
                else break;
                if (done.length < candidates.length) await new Promise(r => setTimeout(r, 600));
              }
              if (done.length) {
                const doneUrls = new Set(candidates.slice(0, done.length).map(e => String(e.url || '').toLowerCase()));
                lastClosedTabs = lastClosedTabs.filter(e => !doneUrls.has(String(e.url || '').toLowerCase()));
                return done.length === 1
                  ? `Reopened “${done[0]}” from my note of recently closed tabs, Sir. Page history was not preserved, so use the back button from the fresh page.`
                  : `Reopened ${done.length} pages from my note of recently closed tabs (${done.join('; ')}). Page history was not preserved.`;
              }
            }
          } catch {}
        }
        return result.message || 'I could not restore that tab.';
      } finally {
        reopenInFlight = false;
      }
    }
    const closeIntent = Core.parseCloseIntent(requestText);if (closeIntent) {
      // Bulk tab close. The server has no "close all" action, so the shared
      // helper lists the real inventory and closes each verified tab by id.
      if (closeIntent.kind === 'close-all-tabs') {
        setMode('EXECUTING', 'Closing every browser tab');
        return (await closeAllTabsNow()).message;
      }
      // Bulk app close: the shared helper lists the visible apps, filters out
      // JARVIS and protected Windows processes, and verifies each close.
      if (closeIntent.kind === 'close-all-apps') {
        setMode('EXECUTING', 'Closing your open apps');
        return (await closeAllAppsNow()).message;
      }
      if (closeIntent.kind === 'close-current-tab' || closeIntent.kind === 'close-named-tab' || closeIntent.kind === 'close-tab-position' || closeIntent.kind === 'close-music-tab') {
        setMode('EXECUTING', closeIntent.kind === 'close-music-tab' ? 'Closing the music tab' : closeIntent.query ? `Closing the ${closeIntent.query} tab` : 'Managing browser tabs');
        const payload = { action: 'tabs-close' };
if (closeIntent.kind === 'close-named-tab') payload.query = closeIntent.query;
        else if (closeIntent.kind === 'close-tab-position') { payload.position = closeIntent.position; payload.last = Boolean(closeIntent.last); }
        else if (closeIntent.kind === 'close-music-tab') payload.music = true;
        else payload.current = true;
        // A request that names MORE THAN ONE tab ("close roblox and canva
        // tabs") resolves each name against the open tabs and closes them
        // all. Falls through to the single-query flow when any name is not a
        // tab of its own.
        if (closeIntent.kind === 'close-named-tab' && closeIntent.query) {
          const many = await closeMultipleNamedTabs(closeIntent.query);
          if (many) {
            const appNotes = await closeNamedApps(closeIntent.query);
            return [many, ...appNotes].filter(Boolean).join(' ');
          }
        }
        const result = await localAction(payload);
        if (result.ok) {
          lastTabCloseAt = Date.now();
          clearPendingTabAction('closed');
          if (result.closed && /^https?:\/\//i.test(String(result.closed.url || ''))) {
            lastClosedTabs.unshift({ title: String(result.closed.title || ''), url: String(result.closed.url || ''), at: Date.now() });
            lastClosedTabs = lastClosedTabs.slice(0, 10);
          }
        }
if (result.ok || result.needsSetup) return result.message;
        // No legacy Ctrl+W fallback — the verified CDP close above is authoritative.
        // If it reported ambiguous, ask; otherwise report honestly.
        if (result.status === 'ambiguous') {
          // Remember the candidates so the NEXT message ("close the Tick-Tack
          // dance") resolves against the same list instead of restarting.
          armPendingTabAction({ originalQuery: closeIntent.query || text, candidates: result.matches, question: result.message });
          return result.message;
        }
        return result.message || 'I could not close that tab.';
      }
      // "can you close it" right after "open my steam" refers to the app that
      // was just opened. Core maps the pronoun to close-current-app (meaning
      // the foreground window), which let Steam minimise to its tray and still
      // report success. Resolve the pronoun against the remembered app first
      // so the close is a real, verified process close.
      const askedClose = normalizeCloseText(text);
      if (closeIntent.kind === 'close-current-app' && lastOpenedApps.length && /^(?:close|shut|exit|quit)\s+(?:the\s+)?(?:it|that|that one|this|this one|the app)$/i.test(askedClose)) {
        const target = lastOpenedApps[lastOpenedApps.length - 1];
        setMode('EXECUTING', `Closing ${target}`);
        const closed = await localAction({ action: 'close-app', name: target });
        if (closed && closed.ok) {
          lastOpenedApps = lastOpenedApps.slice(0, -1);
          return closed.message || `Closed ${target}.`;
        }
        return (closed && closed.message) || `I could not close ${target}, Sir.`;
      }
      // "close the Tick-Tack dance" parses as close-app because it has no
      // literal "tab" word. Before touching the process finder, check whether
      // the user is answering (or naming) a controlled browser tab.
      if (closeIntent.kind === 'close-app' && closeIntent.name) {
        // "close both" / "close 1 and 2" after a multi-open refers to those
        // apps, not to a program literally named "both".
        const remembered = rememberedCloseTargets(closeIntent.name);
        if (remembered && remembered.length) {
          setMode('EXECUTING', `Closing ${remembered.join(', ')}`);
          const notes = [];
          for (const target of remembered) {
            const closed = await localAction({ action: 'close-app', name: target });
            notes.push((closed && closed.message) || `Closed ${target}.`);
          }
          lastOpenedApps = [];
          return notes.join(' ');
        }
        if (/^(?:both|all|them|those|everything)$/i.test(closeIntent.name) && !lastOpenedApps.length) {
          return 'I do not have a recent list of apps to close, Sir. Tell me the app name and I will close it.';
        }
        // Without the word "tabs", "close canva and roblox" still names two
        // websites. Close both tabs first and then any matching desktop app.
        const many = await closeMultipleNamedTabs(closeIntent.name);
        if (many) {
          const appNotes = await closeNamedApps(closeIntent.name);
          return [many, ...appNotes].filter(Boolean).join(' ');
        }
        // Always ask the window/process resolver. The old allowlist gate
        // refused names it did not recognise ("close my discord"), the turn
        // fell through, and a website intent answered "Getting discord open"
        // — the opposite of the request. The server now answers honestly
        // when nothing by that name is running.
        setMode('EXECUTING', `Closing ${closeIntent.name}`);
        // close-app now resolves BOTH kinds of target (a running app, or open
        // tabs of that site) and never launches anything, so one call is the
        // whole decision. Only ask the tab resolver when that call found
        // nothing, otherwise an already-satisfied close was followed by a
        // stray "which tab should I close?" question.
        const appAttempt = await localAction({ action: 'close-app', name: closeIntent.name });
        if (appAttempt && appAttempt.ok) return appAttempt.message || 'Closed.';
        // Any definite answer already covers "nothing by that name is open"
        // and "which one of these did you mean". Re-running the tab matcher
        // after it could close a neighbouring site ("close youtube" landing
        // on the YouTube Music tab), so only a plain "not running" continues.
        if (appAttempt && appAttempt.status && appAttempt.status !== 'not-running') return appAttempt.message || 'I could not close that.';
        if (Core.siteKeyForQuery && Core.siteKeyForQuery(closeIntent.name)) return (appAttempt && appAttempt.message) || `Nothing named ${closeIntent.name} is open, Sir.`;
        const tabAnswer = await resolveTabAnswerForClose(closeIntent.name);
        if (tabAnswer) return tabAnswer;
        if (appAttempt) return appAttempt.message || 'I could not close that.';
        return `I could not find ${closeIntent.name} running, Sir. Nothing was closed.`;
      }
      const action = closeIntent.kind === 'close-current-app' ? 'close-current-app' : 'close-app';
      setMode('EXECUTING', closeIntent.name ? `Closing ${closeIntent.name}` : 'Closing the current app');
      const result = await localAction({ action, name: closeIntent.name });
      return result.message || (result.ok ? 'Closed.' : 'I could not close that window.');
    }if (/\b(open downloads|downloads folder)\b/.test(lower)) {
      setMode('EXECUTING', 'Opening Downloads');
      const result = await localAction({ action: 'search-files', query: '__DOWNLOADS__' });
      if (result.results?.[0]) return openFoundFile(result.results[0]);
      return result.message;
    }
    // Wellbeing/small-talk phrases must be checked before the date handler:
    // "how's your day?" contains the word "day" and used to read back the date.
    // MODEL-FIRST (2026-10-18): these are ordinary conversation — the local
    // model answers them from its JARVIS personality, not a stock line.
    if (/\b(?:how(?:[' ]?s| is) (?:your|the) day|how has your day been|how was your day|how are (?:you|things)|how(?:[' ]?s| is) (?:your|it) going|are you having a good day)\b/.test(lower)) {
      voiceLog('wellbeing turn to model', text.slice(0, 60));
      return { aiQuery: text, conversationBridge: true };
    }if (Core.isClockQuestion(text)) return `It is ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    // Only a genuine date question answers with the date. Questions about "how
    // ... your day" were falling into this handler through the bare word "day".
    if (/\b(?:what(?:'s| is) the date|what(?:'s| is) today(?:'s date)?|what(?:'s| is) the day|current date|today(?:'s)? date|what day is it)\b/.test(lower)) return `Today is ${new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;if (Core.isClearConversationCommand(text)) { feed.innerHTML = '<div class="empty" id="empty">Conversation cleared. Ready when you are.</div>'; messageCount = 0; $('#msgCount').textContent = '00'; conversationHistory = []; localStorage.removeItem('jarvis-conversation'); if (Core.clearEmotionalState) Core.clearEmotionalState(emotionalState); return 'Conversation cleared.'; }if (/^(?:show|what is|what's|which is)(?: me)? my (?:default )?google account$/i.test(confirmLead)) {
      try {
        const response = await fetch('/api/google/status', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        const info = await response.json();
        if (info && info.configured && info.account) return `Your default Google account is ${info.account}, Sir. Gmail and Drive open in that account context when it is signed in; otherwise Google shows its account chooser so the wrong account is never used silently.`;
        return 'No default Google account is configured yet, Sir. Set JARVIS_GOOGLE_ACCOUNT in the local .env file.';
      } catch { return 'I could not reach the local service to check the Google account, Sir.'; }
    }if (Core.isHelpRequest(text)) return `I can help with these categories, Sir. Voice modes - study, gaming, focus, coding, relax, music, movie, creative, research, writing, presentation, workout, morning, wind-down, social, content, bored, and cool-down - plus Apps & Files, Browser & Web, Music & Media, Calendar & Reminders, camera and screen analysis, screen pointing (say "where is this button?", "click the settings icon", "press the send button", "hover over the menu", or "point at it again", and I mark it with the blue pointer - the physical click stays with you; "close screen help" clears it), AI & Voice, System Monitor, Email & Discord. Say a mode name or a category for details. Push-to-talk - hold ${pttKeyLabel()} or hold the Push-to-Talk button and speak; release, and your words are sent without a wake word. All features work locally - no cloud speech or data upload.`;
    // Local AI diagnostic command (no UI change): endpoint reachability, model
    // availability, and a minimal timed generation probe. Recovery is guarded
    // server-side and only ever starts the service on explicit request.
    if (Core.parseAiDiagnoseCommand(text)) {
      setMode('EXECUTING', 'Checking the local AI service');
      const model = $('#aiModel')?.value || localStorage.getItem('jarvis-ai-model') || '';
      const result = await localAction({ action: 'ai-diagnose', model });
      voiceLog('ai diagnose', `${result.endpoint || '?'} - running=${result.running} - models=${(result.models || []).length} - probe=${result.probeMs != null ? `${result.probeMs}ms` : 'skipped'}${result.recoveryAttempted ? ' - recovery attempted' : ''}`);
      let spoken = result.message || 'The AI check finished without a clear result.';
      if (result.recoveryAttempted && result.running) spoken += ' I started the Ollama service for you.';
      if (result.ok && result.probeMs != null && result.probeMs > 60000) spoken += ' It is slow right now   shorter questions answer faster.';
      return spoken;
    }
    // Deep-research mode: web search first, then a longer structured answer
    // with thinking enabled. Distinct from a quick lookup question.
    const researchCmd = Core.parseResearchCommand(text);if (researchCmd) {
      setMode('SEARCHING', `Researching ${researchCmd.query}`);
      const found = await localAction({ action: 'search-web', query: researchCmd.query });
      const sources = found.ok ? (found.results || []) : [];
      lastWebResults = sources;
      voiceLog('research sources', `${sources.length} source(s) for "${researchCmd.query.slice(0, 60)}"`);
      return { aiQuery: `Research this thoroughly and answer efficiently: give the key points first as a short structured summary, then at most two source links taken only from the provided results. Topic: ${researchCmd.query}`, searchContext: sources, research: true };
    }if (Core.isDirectResearchQuestion(text)) {
      setMode('SEARCHING', 'Finding sources for a concise answer...');
      const result = await localAction({ action: 'search-web', query: text });
      if (result.ok) { lastWebResults = result.results || []; return { aiQuery: text, searchContext: lastWebResults }; }
      voiceLog('web search unavailable', result.message || text);
    }
    // Explicit question detection: natural questions (what/why/how/should I/etc.)
    // go to Ollama for a conversational answer. MODEL-FIRST (2026-10-18): the
    // old localQuestionIntents diversion answered ~30 conversational intents
    // (boredom, jokes, opinions, confusion...) from the keyword library before
    // the model ever saw the question. Only deterministic identity/liveness
    // checks ("who are you", "are you listening") stay instant; everything
    // else is interpretation and belongs to the model.
    const isNaturalQuestion = /\?/.test(text) || /^(?:who|what|when|where|why|how|should i|can you|could you|would you|do you think|what do you think|is there|are there)\b/i.test(text);
    if (isNaturalQuestion && !Core.isDirectResearchQuestion(text)) {
      if (conversationLibrary) {
        const local = Core.replyLocally(text, conversationHistory, conversationLibrary, loadJson('jarvis-recent-local-replies', []));
        const INSTANT_QUESTION_INTENTS = new Set(['who_are_you', 'are_you_ai', 'are_you_listening']);
        if (local && INSTANT_QUESTION_INTENTS.has(local.intentId)) {
          const recent = loadJson('jarvis-recent-local-replies', []); recent.push(local.response);
          localStorage.setItem('jarvis-recent-local-replies', JSON.stringify(recent.slice(-12)));
          armConversationBridge(local.intentId, local.response);
          return local.response;
        }
      }
      return { aiQuery: text, conversationBridge: true };
    }
    // Conversational tasks (2026-10-15): quiz, riddle, story, challenge and
    // re-explain requests go to the local model with a task instruction, so
    // it generates ORIGINAL content every turn instead of a canned line; the
    // follow-up bridge keeps the mic open for the user's answer (a quiz
    // question ends in "?" so the window re-arms automatically). Offline, the
    // existing honest no-model reply plays — nothing is invented.
    const taskIntent = Core.parseConversationTaskIntent ? Core.parseConversationTaskIntent(text) : null;
    if (taskIntent) {
      const instruction = (Core.CONVERSATION_TASK_INTENTS[taskIntent.task] || {}).instruction || 'Answer this conversationally.';
      voiceLog('conversation task', `${taskIntent.task}${taskIntent.topic ? ` - ${taskIntent.topic}` : ''}`);
      setMode('THINKING', 'Preparing that for you');
      return { aiQuery: instruction + (taskIntent.topic ? ` Topic: ${taskIntent.topic}.` : '') };
    }
    // MODEL-FIRST FINAL FALLBACK (2026-10-18, spec section 1): the old
    // keyword-library catch-all answered ANYTHING that still matched the
    // 443 KB pattern library with a canned line, and only text the library
    // completely missed ever reached the local model. Ordinary conversation
    // now always reaches the model with the full context; the library stays
    // on the deterministic side (commands, social tokens, safety).
    // Explicit stop/done phrases with no pending workflow: never feed a bare
    // closing ("i'm done chatting", "cancel that") into the local model as a
    // new request — the model re-answers old threads when prompted with them.
    if (Core.isPendingCancellation(text)) {
      return 'Right, Sir. Nothing is running right now — say "Jarvis" when you need me.';
    }
    return { aiQuery: text, conversationBridge: true };
  }
  function releaseSpeechAudio() {if (speechAudio) { speechAudio.pause(); speechAudio.removeAttribute('src'); speechAudio.load(); speechAudio = null; }if (speechUrl) { URL.revokeObjectURL(speechUrl); speechUrl = null; }
    try { speakerSource?.disconnect(); } catch {} try { speakerAnalyser?.disconnect(); } catch {} try { speakerGain?.disconnect(); } catch {}
    speakerSource = null; speakerGain = null;
    speakerAnalyser = null; cancelAnimationFrame(speechFrame); hero.classList.remove('speaking-pulse');
    hero.style.setProperty('--voice-pulse', '1');
  }
  // =====================================================================
// COMMAND SFX (2026-10-14) — original procedural JARVIS instrumentation.
//
// Three states, all synthesized with Web Audio oscillators (no assets, no
// network, no external service):
//   ack      - two-tone robotic chirp, played the moment a command is accepted
//   thinking - quiet pulsing resonance for genuinely long operations
//   error    - short low descending cue for a real failure
//
// Playback reuses the SAME AudioContext (and therefore the same selected
// output device) as speech, so a cue follows jarvis-audio-output instead of
// always hitting the default speaker. Every cue participates in the existing
// microphone gate via `sfxActive`, so JARVIS can never transcribe its own
// acknowledgment as a wake word.
// =====================================================================
const SFX = (() => {
  const enabled = () => localStorage.getItem('jarvis-sfx') !== 'off';
  const thinkingEnabled = () => localStorage.getItem('jarvis-sfx-thinking') !== 'off';
  // Safe numeric setting read. localStorage.getItem() returns null when a key
  // was never stored, and Number(null) === 0, so the previous form
  // (`Number.isFinite(Number(getItem(k))) ? ... : 0.5`) passed its isFinite
  // guard on every fresh install and returned 0 — every cue was synthesised at
  // zero gain, i.e. TOTAL SILENCE. Only a genuinely stored value may win.
  function settingNumber(key, fallback, min, max) {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === '') return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, v));
  }
  const volume = () => settingNumber('jarvis-sfx-volume', 0.5, 0, 1);
  // Cue/task identifiers + one diagnostic sink, so overlapping commands can be
  // traced. Only the cue name, volume, context state and timing are logged -
  // never screen contents, camera audio or conversation text.
  let cueSeq = 0;
  let activeCue = 0;
  function sfxLog(event, detail = '') {
    try { voiceLog(`sfx ${event}`, detail); } catch {}
  }
  // sfxActive participates in the mic gate; the tail hold keeps the mic closed
  // for a moment after the last cue so the speaker's decay is not captured.
  let active = false;
  let holdUntil = 0;
  let nodes = [];
  let thinkTimer = 0;
  let thinkStartTimer = 0;
  let turnToken = 0;
  const THINK_DELAY_MS = 500;
  function clearNodes() {
    for (const node of nodes) { try { node.stop ? node.stop() : node.disconnect(); } catch {} }
    nodes = [];
  }
  function bumpHold(ms = 220) { holdUntil = Date.now() + ms; }
  function isGated() { return active || Date.now() < holdUntil; }
  // Lazily create the shared context. Reuses the speech context so the sink
  // device and the user's volume routing apply to cues as well.
  function ctx() {
    if (!enabled()) return null;
    try {
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
      return audioContext;
    } catch { return null; }
  }
  // One decaying partial. `type` shapes the timbre; the short exponential
  // release is what makes the cue read as electronic rather than musical.
  function blip(ac, { type = 'sine', from = 880, to = 880, at = 0, dur = 0.16, gain = 0.2 }) {
    const osc = ac.createOscillator();
    const amp = ac.createGain();
    osc.type = type;
    const t0 = ac.currentTime + at;
    osc.frequency.setValueAtTime(from, t0);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp); amp.connect(ac.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
    nodes.push(osc, amp);
    return { osc, amp };
  }
  // Command acknowledged: crisp ascending two-tone chirp with a quiet
  // metallic partial. ~220 ms total. Deliberately NOT a success chime - it
  // reads as "I heard you", never as "the task is done".
  function ack() {
    const ac = ctx(); if (!ac) { sfxLog('ack skipped', 'no audio context'); return; }
    try {
      clearNodes();
      const v = volume();
      active = true; bumpHold(260);
      blip(ac, { type: 'square', from: 880, to: 1320, at: 0, dur: 0.09, gain: 0.16 * v });
      blip(ac, { type: 'triangle', from: 1760, to: 1980, at: 0.05, dur: 0.13, gain: 0.07 * v });
      // Quiet metallic partial for the "robotic" character.
      blip(ac, { type: 'sine', from: 2640, to: 2640, at: 0.02, dur: 0.1, gain: 0.03 * v });
      setTimeout(() => { active = false; nodes = []; }, 280);
      sfxLog('ack played', `cue=${cueSeq} volume=${v.toFixed(2)} ctx=${ac.state}`);
    } catch (error) { active = false; sfxLog('ack failed', String(error.message || error).slice(0, 80)); }
  }
  // Failure: short, restrained descending tone. Low enough to be calm, never an
  // alarm. Played only on a real failure, never as decoration.
  function error() {
    const ac = ctx(); if (!ac) return;
    try {
      clearNodes();
      const v = volume() * 0.8;
      active = true; bumpHold(240);
      blip(ac, { type: 'triangle', from: 420, to: 210, at: 0, dur: 0.18, gain: 0.14 * v });
      setTimeout(() => { active = false; nodes = []; }, 240);
      sfxLog('error cue played', `cue=${activeCue} volume=${(volume() * 0.8).toFixed(3)}`);
    } catch (playError) { active = false; sfxLog('error cue failed', String(playError.message || playError).slice(0, 80)); }
  }
  // Thinking: sparse, quiet pulses with a slow upward drift plus an occasional
  // high tick. Restrained on purpose - it must sit UNDER speech and never read
  // as a repeating alert.
  function thinkingStart() {
    if (!enabled() || !thinkingEnabled()) return;
    if (thinkTimer || thinkStartTimer) return;      // never stack two loops
    const token = ++turnToken;
    thinkStartTimer = setTimeout(() => {
      thinkStartTimer = 0;
      if (token !== turnToken) return;
      const ac = ctx(); if (!ac) return;
      const v = volume() * 0.22;
      let n = 0;
      const pulse = () => {
        if (token !== turnToken) return;
        const now = ac.currentTime;
        // Slow tonal movement keeps it organic without any melody.
        const base = 196 * (1 + 0.06 * Math.sin(n * 0.7));
        blip(ac, { type: 'sine', from: base, to: base * 1.5, at: 0, dur: 0.22, gain: v });
        if (n % 3 === 0) blip(ac, { type: 'square', from: 1560, to: 1560, at: 0.04, dur: 0.03, gain: v * 0.3 });
        n++;
      };
      active = true;
      pulse();
      thinkTimer = setInterval(pulse, 620);
      sfxLog('thinking started', `cue=${activeCue} after ${THINK_DELAY_MS}ms volume=${v.toFixed(3)} ctx=${ac.state}`);
    }, THINK_DELAY_MS);
  }
  function thinkingStop() {
    const wasRunning = Boolean(thinkTimer || thinkStartTimer);
    if (thinkStartTimer) { clearTimeout(thinkStartTimer); thinkStartTimer = 0; }
    if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = 0; }
    if (wasRunning) sfxLog('thinking stopped', `cue=${activeCue}`);
    // Short fade instead of a hard cut so stopping never clicks.
    try {
      const now = performance.now();
      for (const node of nodes) {
        if (node.gain && node.gain.cancelAndHoldAtTime) {
          try { node.gain.cancelAndHoldAtTime(now); node.gain.linearRampToValueAtTime(0.0001, now + 0.09); } catch {}
        }
      }
    } catch {}
    setTimeout(() => { nodes = []; }, 140);
    turnToken++;
    if (active) { active = false; bumpHold(200); }
  }
  // One command, one cue set. The token cancels a previous command's loop so
  // consecutive commands cannot overlap or multiply sounds.
  function beginCommand() {
    thinkingStop();
    turnToken = Math.max(0, turnToken);
    activeCue = ++cueSeq;
    sfxLog('request accepted', `cue=${activeCue} enabled=${enabled()} thinking=${thinkingEnabled()} volume=${volume().toFixed(2)}`);
    ack();
    thinkingStart();
  }
  function endCommand() { thinkingStop(); sfxLog('processing finished', `cue=${activeCue}`); }
  function cancel() { thinkingStop(); clearNodes(); active = false; sfxLog('cancelled', `cue=${activeCue}`); }
  return {
    ack, error, thinkingStart, thinkingStop, beginCommand, endCommand, cancel,
    isGated,
    get active() { return active; },
    settings() {
      return { enabled: enabled(), thinking: thinkingEnabled(), volume: volume() };
    },
    set(key, value) {
      if (key === 'enabled') localStorage.setItem('jarvis-sfx', value ? 'on' : 'off');
      if (key === 'thinking') localStorage.setItem('jarvis-sfx-thinking', value ? 'on' : 'off');
      if (key === 'volume') localStorage.setItem('jarvis-sfx-volume', String(Math.max(0, Math.min(1, Number(value) || 0))));
      if (!enabled()) cancel();
    }
  };
})();
  function stopSpeech() {
    // Any in-flight cue loop dies with the speech it was accompanying.
    try { SFX.cancel(); } catch {}
    if (speechAbort) { speechAbort.abort(); speechAbort = null; }
    const wasSpeaking = ttsActive || speechAudio;
    releaseSpeechAudio();
    // Playback actually stopped: close the TTS window and throw away any mic
    // frames captured while our own voice was playing so they can never be
    // transcribed as a new command.
    // Cancellation also arms the supplementary tail hold so stop-echoes and
    // room reverb cannot seed capture; barge energy still bypasses.
    if (wasSpeaking) { ttsActive = false; ttsEndedAt = Date.now(); flushCaptureBuffers(); listenHoldUntil = Date.now() + tailCooldownMs(); voiceLog('playback cancelled', `tail hold ${tailCooldownMs()} ms`); }
    // Extra guard: ensure mic capture is fully cleared after our voice stops.
    // This prevents the tail of our own TTS from being picked up as a new command.
    // Token guard: a wake-seeded (or naturally started) newer utterance must
    // never be wiped by this delayed flush (PATH A interruption path).
    const flushSeq = utteranceSeq;
    setTimeout(() => { if (utteranceSeq === flushSeq && !speechActive) flushCaptureBuffers(); }, 350);
  }
  // Throw away buffered mic audio without touching the stream. Called whenever
  // TTS starts or stops and whenever a voice command is accepted, so stale
  // frames (TTS tails, pre-command room noise) never reach the recognizer.
  function flushCaptureBuffers() {
    preRollFrames = []; utteranceFrames = []; speechActive = false; speechSilenceMs = 0; speechCandidateMs = 0;
    // Also reset the speech gate to clear any residual energy from our own TTS.
    try { speechGate.reset(); } catch {}
  }
  // Errors must return the assistant to a safe standby state instead of
  // sticking in ERROR until the next random sound arrives.
  function scheduleVoiceRecovery() {
    clearTimeout(voiceErrorTimer);
    voiceErrorTimer = setTimeout(() => {
      if (hero.dataset.mode === 'ERROR' && recognitionEnabled && !voiceBusy) {
        setMode('LISTENING', 'Listening for "Jarvis"...');
        readout('#wakeDiagnostic', wakeHint());
        voiceLog('voice error recovered', 'returned to wake-word standby');
      }
    }, 4000);
  }
  // After a reply finishes, accept one follow-up without the wake word for a
  // short window, then visibly RETURN TO STANDBY when it expires instead of
  // silently staying in command-listening state forever.
  function armFollowUpWindow(ms = 15000) {
    clearTimeout(followUpTimer);
    wakeArmedUntil = Date.now() + ms;
    followUpTimer = setTimeout(() => {
      if (Date.now() < wakeArmedUntil) return;
      wakeArmedUntil = 0;
      if (recognitionEnabled && hero.dataset.mode === 'LISTENING') {
        setMode('LISTENING', 'Follow-up window closed. Say "Jarvis" for a new request.');
        const reasonEl = $('#wakeDiagnostic'); if (reasonEl) reasonEl.textContent = `RETURN TO STANDBY - say "${wakeName()}" for a new request`;
        voiceLog('follow-up window expired', 'returned to wake-word standby');
      }
    }, ms + 200);
  }
  // Spoken replies must never read citations, Markdown syntax, internal
  // processing notes, or raw timestamps aloud. Display text keeps its detail;
  // the speech text is the natural-language form of the SAME answer.
  function forSpeech(text) {
    const cleaned = String(text || '')
      .replace(/^[ \t]*sources?:.*$/gim, ' ')
      .replace(/^[ \t]*-[ \t]+/gm, '');
    // Shared layer: strips internal annotations, removes Markdown markers and
    // turns written measures (timestamps, percentages, byte units, URLs) into
    // natural spoken English.
    if (Core.prepareResponse) {
      return Core.prepareResponse(cleaned, { speech: true });
    }
    if (Core.toNaturalSpeech) {
      return Core.toNaturalSpeech(cleaned);
    }
    return cleaned.replace(/\s+/g, ' ').trim();
  }
  // Strip emojis from text — JARVIS must never use emojis in responses
  function stripEmojis(text) {
    return String(text || '')
      .replace(/[\u{1F600}-\u{1F64F}]/gu, '') // emoticons
      .replace(/[\u{1F300}-\u{1F5FF}]/gu, '') // symbols & pictographs
      .replace(/[\u{1F680}-\u{1F6FF}]/gu, '') // transport & map
      .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '') // flags
      .replace(/[\u{2600}-\u{26FF}]/gu, '') // misc symbols
      .replace(/[\u{2700}-\u{27BF}]/gu, '') // dingbats
      .replace(/[\u{FE00}-\u{FE0F}]/gu, '') // variation selectors
      .replace(/[\u{1F900}-\u{1F9FF}]/gu, '') // supplemental symbols
      .replace(/\s+/g, ' ')
      .trim();
  }
  // Strip laughter bursts from display text only (they belong in TTS speech only).
  // Patterns: HAHAHA, HEHEHE, hahaha, hehehe, variants with periods, multiple lines.
  function stripLaughterFromDisplay(text) {
    return String(text || '')
      .replace(/\b(?:haha|hehe)([.!]?)\s*\1{0,2}/gi, '')   // "haha.", "haha!!", "hehe."
      .replace(/\b(haha+|hehe+)\b/gi, '')                  // "hahaha", "hehehe"
      .replace(/\s+/g, ' ')
      .trim();
  }
  // Safety net: if a raw structured response ever reaches the client, show the
  // user-facing answer instead of the internal envelope. Recovery is
  // schema-aware (shared with the server), never brace-stripping, and a raw
  // envelope is never passed through to the conversation or to TTS.
  function normalizeResponseText(text) {
    const s = String(text || '').trim();
    if (!s) return '';
    // Ordinary prose — including a legitimate answer that happens to start
    // with a brace — is returned untouched.
    if (!Core.looksLikeResponseEnvelope(s)) return Core.prepareResponse(s);
    const recovered = Core.recoverEnvelopeText(s);
    if (recovered) return Core.prepareResponse(recovered);
    // An envelope with no recoverable user-facing text must never be shown.
    return 'My local model returned an incomplete answer that time, Sir. Please ask me again.';
  }
  async function speak(text, turn = assistantTurn, followUp = false, emotion = 'neutral', intensity = 0.5, speechText = null, speakingRate = 1, requestId = null, responseId = null) {
    // Single choke point: ANY speech path (voice answer, camera button, Discord
    // flow, media orb) stops the processing loop before audio starts, so the
    // cue can never overlap the spoken answer.
    try { SFX.thinkingStop(); } catch {}
    // Centralized playback controller: one response produces at most
    // one playback. A duplicate callback for the same request/response
    // pair is dropped here — before stopSpeech, before any fetch — so
    // it can never start a simultaneous copy or restart the audio.
    // Internal prompts ("Yes, Sir?", clarifications) carry no IDs and
    // always play.
    if (requestId && responseId) {
      const epoch = speechController.claim(requestId, responseId);
      if (!epoch) {
        voiceLog('speech duplicate blocked', `req=${requestId} resp=${responseId}`);
        return;
      }
      voiceLog('speech playback claimed', `req=${requestId} resp=${responseId} epoch=${epoch}`);
    }
    stopSpeech();
    const cleanText = karenify(stripEmojis(text));
    // Defense in depth: the model is instructed to keep speech_text
    // emoji-free, but if an emoji ever slips into any spoken variant it must
    // still never reach TTS.
    const spoken = forSpeech(karenify(stripEmojis(speechText || text)));
    if (!spoken) return;
    currentSpeechText = spoken;
    const controller = new AbortController(); speechAbort = controller;
    setMode('THINKING', 'Preparing your voice response...');
    try {
      const response = await fetch('/api/speak', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: spoken, provider: providerSelect.value, voice: localStorage.getItem('jarvis-voice') || 'female', rate: localStorage.getItem('jarvis-rate') || '0.93', emotion, intensity, speaking_rate: speakingRate }),
        signal: controller.signal
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({ message: 'Voice request failed.' }));
        $('#fishStatus').textContent = problem.message; setTtsStatus('VOICE ERROR');
        throw new Error(problem.message);
      }
      const provider = response.headers.get('X-Jarvis-TTS-Provider') || 'unknown';
      if (provider === 'local-fallback') {
        $('#fishStatus').textContent = `LOCAL FALLBACK ACTIVE - ${decodeURIComponent(response.headers.get('X-Jarvis-TTS-Message') || 'Fish Audio unavailable')}`;
        setTtsStatus('LOCAL FALLBACK');
      } else if (provider === 'fish') {
        $('#fishStatus').textContent = 'Fish Audio active - selected voice'; setTtsStatus('FISH AUDIO');
      } else { $('#fishStatus').textContent = 'LOCAL VOICE ACTIVE - Microsoft Zira Desktop'; setTtsStatus('LOCAL VOICE'); }
      const audioBlob = await response.blob();
      if (controller.signal.aborted || turn !== assistantTurn) return;
      audioContext ||= new AudioContext();
      if (audioContext.state === 'suspended') await audioContext.resume();
      await applyAudioOutput();
      speechUrl = URL.createObjectURL(audioBlob); speechAudio = new Audio(speechUrl); speechAudio.volume = 1;
      // Playback identity: stale completion callbacks from a replaced response
      // must never resume listening while newer audio still plays.
      const thisPlayback = ++playbackEpoch;
      const thisAudio = speechAudio;
      speakerSource = audioContext.createMediaElementSource(speechAudio);
      speakerAnalyser = audioContext.createAnalyser(); speakerAnalyser.fftSize = 256;
      speakerGain = audioContext.createGain(); speakerGain.gain.value = Number(localStorage.getItem('jarvis-volume') || 1);
      speakerSource.connect(speakerAnalyser); speakerAnalyser.connect(speakerGain); speakerGain.connect(audioContext.destination);
      const samples = new Uint8Array(speakerAnalyser.fftSize);
      speechAudio.onplay = () => { if (speechAudio !== thisAudio || thisPlayback !== playbackEpoch) { voiceLog('stale playback start ignored', `turn=${turn} epoch=${thisPlayback}`); return; } if (turn === assistantTurn) { setMode('SPEAKING'); hero.classList.add('speaking-pulse'); } voiceLog('speech playback started', `turn=${turn} - ${(speechText || cleanText || '').slice(0, 60)}`); };
      speechAudio.onended = () => {
        // Only the CURRENT audio element may close the playback window.
        // A replaced/older element ending here must not flush fresh buffers
        // or reopen listening early.
        if (speechAudio !== thisAudio || thisPlayback !== playbackEpoch) { voiceLog('stale playback callback ignored', `turn=${turn} epoch=${thisPlayback}`); return; }
        ttsActive = false; ttsEndedAt = Date.now(); flushCaptureBuffers(); releaseSpeechAudio();
        // Supplementary tail hold AFTER the real completion event: residual
        // room reverb of our own voice must not seed capture. Barge energy
        // still bypasses, so fast interruptions keep working.
        listenHoldUntil = Date.now() + tailCooldownMs();
        voiceLog('speech playback finished', `turn=${turn} - tail hold ${tailCooldownMs()} ms`); if (turn === assistantTurn) {
        lastSpokenText = currentSpeechText; lastSpokenAt = Date.now(); currentSpeechText = '';
        // The pending question's TTL restarts when its spoken delivery
        // completes: the user can only answer AFTER hearing the question
        // (fetch + decode + playback cost seconds), so measuring from
        // composition robbed slow responders of most of their window.
        if (pendingQuestion && Core.pendingQuestionActive && Core.pendingQuestionActive(pendingQuestion)) {
          Core.refreshPendingQuestion(pendingQuestion, { now: Date.now() });
        }
        // Strict wake-word rule: the no-wake-word window opens ONLY for the
        // "Yes, Sir?" acknowledgement or while a multi-turn workflow is
        // waiting for its answer. A finished answer returns to wake-word
        // standby instead of listening to the room for 15 seconds.
        const arm = Core.shouldArmFollowUp({ pendingKind: pendingFlow ? pendingFlow.kind : '', ackPrompt: followUp, recognitionEnabled, pending: pendingQuestion });
        if (arm.armed) {
          armFollowUpWindow(arm.ms);
          setMode('LISTENING', 'Listening for your reply   say "Jarvis" any time.');
          voiceLog('follow-up window armed', `${arm.reason} - ${Math.round(arm.ms / 1000)}s`);
        } else {
          clearTimeout(followUpTimer); wakeArmedUntil = 0;
          setMode(recognitionEnabled ? 'LISTENING' : 'IDLE', recognitionEnabled ? 'Say "Jarvis" for a new request.' : 'Voice standby is off.');
          readout('#wakeDiagnostic', wakeHint());
          clearVoiceSession('returned to standby');
        }
      } };
      const animate = () => {
        if (!speechAudio || speechAudio.paused || !speakerAnalyser) return;
        speakerAnalyser.getByteTimeDomainData(samples); let energy = 0;
        for (const value of samples) { const sample = (value - 128) / 128; energy += sample * sample; }
        const level = Math.min(1, Math.sqrt(energy / samples.length) * 6);
        hero.style.setProperty('--voice-pulse', (1 + level * 0.34).toFixed(2));
        document.documentElement.style.setProperty('--wave-level', level.toFixed(3));
        speechFrame = requestAnimationFrame(animate);
      };
      // Playback lifecycle is tracked from real audio events: anything the mic
      // captured while this was playing is our own voice, not a command.
      ttsActive = true; ttsStartedAt = Date.now(); flushCaptureBuffers();
      try { await speechAudio.play(); } catch (playError) { ttsActive = false; ttsEndedAt = Date.now(); listenHoldUntil = Date.now() + tailCooldownMs(); voiceLog('playback failed', `${String(playError && playError.message || playError).slice(0, 100)} - listening held`); throw playError; }
      animate();
    } catch (error) {
      if (error.name === 'AbortError') return;
      // Fetch/decode failed BEFORE any audio reached the speakers: release
      // the playback claim so an explicit user retry ("say that again") can
      // re-enter the pipeline. Interruption keeps the claim held — stopped
      // audio is never restarted by a stale callback.
      if (requestId && responseId) speechController.release(requestId, responseId);
      console.warn('[JARVIS speech]', error.message); setMode('ERROR', error.message || 'Voice playback failed.');
    }
  }
  async function ask(query, recognizedText = query, source = 'text') {
    const spokenText = String(query || '').trim(); if (!spokenText) return;
    // LEADING-STRAY-WORD TOLERANCE (2026-10-23): recognition puts one unrelated
    // word in front of a clear command ("Frieren open some music"). Every parser
    // keys on the first word, so the line fell through to the AI, which SAID
    // "Opening youtube music." and did nothing. Routing uses the recovered
    // command; the conversation log keeps the words actually said.
    const recovered = (Core.stripStrayLead ? Core.stripStrayLead(spokenText) : '') || '';
    const text = recovered || spokenText;
    if (recovered) voiceLog('stray leading word ignored', `"${spokenText.slice(0, 60)}" -> "${recovered}"`);
    // CONVERSATION-END DETECTION (2026-10-19): Check if the user is signaling
    // the end of a conversation. If so, clear pending state and return to
    // wake-word standby immediately.
    if (Core.isConversationEnding && Core.isConversationEnding(text)) {
      voiceLog('conversation end detected', text);
      // Clear pending question and flow
      if (pendingQuestion) { pendingQuestion = null; }
      if (pendingFlow) { pendingFlow = null; }
      // Cancel follow-up timer
      if (followUpTimer) { clearTimeout(followUpTimer); followUpTimer = null; }
      wakeArmedUntil = 0;
      // Mark conversation as ended
      window.__jarvisConversationEnded = true;
      // Respond briefly
      const byeReply = 'Goodbye, Sir. I will be here when you need me.';
      addMessage('JARVIS', byeReply);
      speak(byeReply, assistantTurn, false);
      setMode(recognitionEnabled ? 'LISTENING' : 'IDLE', recognitionEnabled ? 'Listening for "Jarvis"...' : 'Idle');
      return;
    }
    // PENDING QUESTION RESOLUTION 2026-10-23: the legacy block that used to sit
    // here is GONE. It read Core.answerMatchesPendingQuestion and then called
    // resolvePendingQuestionAnswer(), which is not exported on JarvisCore - so
    // every short line that matched the open-ended branch threw a
    // ReferenceError inside ask(). The promise rejected into nothing: the
    // transcript never reached the conversation log, no answer was spoken, and
    // the HUD stayed in THINKING forever. "Start new valley" (16 chars) and
    // "I would like you to open stardew valley" (39 chars) both died there, in
    // every "JARVIS asked a question, user replies" turn.
    // The one shared resolver now owns this: reply() calls resolvePendingQuestion
    // at its own stage, which checks expiry, releases stale questions for a new
    // request, and resolves greetings/modes/alarms/reminders/conversation.
    // Clear the conversation-ended flag for new messages
    window.__jarvisConversationEnded = false;
    // Generate a unique request ID for this interaction
    const requestId = speechController.generateRequestId();
    speechController.setRequestContext(requestId);
    // No pre-action model classification here (2026-10-19): it added a second
    // full local-model round-trip before the user's line even reached the
    // conversation log, and its only output was the unused
    // window.__jarvisLastAiIntent. Routing is deterministic in reply() and the
    // model gets the real question through the normal answer path.
    // Typed submissions (chat box, command chips) have no voice busy-guard:
    // a genuine double-fire (two submit events in the same tick, or an
    // accidental double-click on the send button) is debounced, but a
    // deliberate retype a moment later is NOT swallowed. The window is short
    // on purpose: a long text-based window forced the user to press Enter
    // repeatedly when the same line was re-sent too soon.
    if (source === 'text') {
      const nowTs = Date.now();
      if (lastSubmit.text === text && nowTs - lastSubmit.at < 400) { voiceLog('duplicate submission dropped', text); return ''; }
      lastSubmit = { text, at: nowTs };
    }
    // PUSH-TO-TALK 2026-10-23: a release is routed under its own source name.
    // It used to arrive as plain 'voice' and rely on pttCtl.active, which the
    // release handler has already reset by the time the transcript is ready -
    // so the busy guard below could still drop a deliberate hold. The explicit
    // source cannot be lost.
    const pttRelease = source === 'ptt';
    const voiceInitiated = source === 'voice' || source === 'barge' || pttRelease;
    // PUSH-TO-TALK is an explicit, deliberate user action: it must never be
    // dropped just because a previous command is still running. Preempt the
    // in-flight request (abort its AI fetch) and clear the busy flag before
    // the single-flight guard below, so the held utterance always executes.
    const pttActive = pttRelease || (source === 'voice' && Boolean(pttCtl && pttCtl.active));
    if (pttActive) {
      try { aiAbort?.abort(); aiAbort = null; } catch {}
      voiceBusy = false; voiceBusyOwner = 0;
      voiceLog('push-to-talk preempted in-flight command', text.slice(0, 60));
    }
    // Voice-busy state is managed by the command-start flow (line 4663),
    // the 120 s watchdog (line 4668), and PTT preemption (line 4633).
    // The single-flight guard below relies on voiceBusy being set true
    // when a command actually runs — do not unconditionally reset it here.
    // Single-flight: exactly one voice command runs at a time. A barge-in
    // preempts; any other voice transcript arriving mid-command is dropped
    // (and logged) instead of executing twice.
    if (source === 'voice' && voiceBusy && !pttActive) {
      // LOST-TRANSCRIPT 2026-10-21: a dropped release used to vanish before
      // the YOU bubble below was ever reached - the conversation log never
      // saw the words. Record them and say why nothing ran.
      voiceLog('voice command dropped - previous still running', text);
      addMessage('YOU', recognizedText);
      notify('I was still answering the previous request, so that line did not run. Say it again in a moment.');
      readout('#policyDiagnostic', 'COMMAND PAUSED - PREVIOUS REQUEST STILL RUNNING');
      routeTelemetry('dropped-busy', { transcript: text });
      return;
    }
    // Cross-arm duplicate suppression: the same spoken utterance reaching
    // tell ask twice (see lastVoiceCommand note above) would otherwise start
    // two independent requests that both end up speaking. Normalized so
    // a corrected transcript and its raw form still match.
    if (voiceInitiated) {
      const nowTs = Date.now();
      const normalized = Core.normalizeConversationText ? Core.normalizeConversationText(text) : text.toLowerCase();
      if (lastVoiceCommand.text === normalized && nowTs - lastVoiceCommand.at < 3000) {
        // LOST-TRANSCRIPT 2026-10-21: the suppressed repeat still happened -
        // show the words and say why nothing new runs.
        voiceLog('duplicate voice command suppressed', `${source} - ${text.slice(0, 60)}`);
        addMessage('YOU', recognizedText);
        notify('That line just ran a moment ago, so I am not running it twice.');
        return;
      }
      lastVoiceCommand = { text: normalized, at: nowTs };
    }
    // Reset voice-busy state so a fresh PTT press can always run, regardless
    // of whether a previous voice command left voiceBusy set. The 120 s
    // watchdog in requestLocalAI's finally block will re-arm it if a real
    // AI turn is in flight.
    voiceBusy = false; voiceBusyOwner = 0;
    clearVoicePreview();
    const turn = ++assistantTurn; stopSpeech(); aiAbort?.abort(); aiAbort = null; input.value = ''; addMessage('YOU', recognizedText);
    // TURN TIMELINE 2026-10-21: the ask() answer pipeline is a chain of async
    // stages with several early exits, none of which left a trace outside the
    // in-page panel - "Open YouTube" accepted at 18:24:01 produced no router
    // call and no answer, and nothing in any log could say why. Every stage
    // from here now reports honestly to the bridge log.
    const askStartedAt = Date.now();
    routeTelemetry('ask-start', { transcript: String(text || '').slice(0, 80), ptt: source === 'voice' || source === 'barge' || pttRelease });
    // A new voice command orphans every transcription still queued from an
    // earlier session: their epoch no longer matches, so stale callbacks can
    // never submit commands.
    // The voice single-flight slot must never wedge: any await between here
    // and the finally (audio-context resume, playback start, a slow provider)
    // that never resolves would block every future voice command forever
    // ("voice command dropped - previous still running"). A 60 s watchdog
    // force-releases the slot and says so in the route telemetry.
    // 2026-10-22: it used to only clear the flag, which left the UI in
    // THINKING with the thinking loop still armed - "Jarvis keeps on thinking
    // forever". It now ENDS the turn: aborts the stalled request, retires the
    // turn so a late reply cannot resurrect it, and puts the voice back in
    // LISTENING with an honest line instead of dead silence.
    let voiceBusyGuard = null;
    if (voiceInitiated) {
      voiceBusy = true; voiceBusyOwner = turn; voiceEpoch++; clearTimeout(voiceErrorTimer);
      voiceBusyGuard = setTimeout(() => {
        if (!voiceBusy || voiceBusyOwner !== turn) return;
        voiceLog('voice single-flight watchdog', 'a command left the slot locked for 60 s - ending the turn');
        routeTelemetry('single-flight-release', { transcript: String(text || '').slice(0, 80) });
        // Retire the turn FIRST: the answer handler checks
        // turn !== assistantTurn and returns, so a reply that lands a moment
        // later can never put the UI back into THINKING.
        try { assistantTurn++; } catch {}
        try { aiAbort?.abort(); aiAbort = null; } catch {}
        try { SFX.endCommand(); } catch {}
        voiceBusy = false;
        setMode(recognitionEnabled ? 'LISTENING' : 'IDLE', recognitionEnabled ? 'That request stalled, Sir - I am listening again.' : 'That request stalled, Sir. Press push-to-talk to try again.');
      }, 60000);
    }
    setMode('LISTENING', source === 'text' ? 'Processing your request...' : `Heard: ${String(recognizedText || '').slice(0, 100)} - working on it...`);
    // Command accepted: play the acknowledgment chirp and arm the thinking
    // loop. `beginCommand` also cancels any previous command's loop, so one
    // command produces exactly one ack and never two overlapping sounds.
    try { SFX.beginCommand(); } catch {}
    try {
      const route = await reply(text, source);
      if (route && typeof route === 'object' && route.aiQuery) routeTelemetry('ask-routed', { kind: 'ai', ms: Date.now() - askStartedAt, transcript: String(text || '').slice(0, 60) });
      else if (route && typeof route === 'object' && route.silent) routeTelemetry('ask-routed', { kind: 'silent-action', ms: Date.now() - askStartedAt, transcript: String(text || '').slice(0, 60) });
      else routeTelemetry('ask-routed', { kind: 'direct', ms: Date.now() - askStartedAt, transcript: String(text || '').slice(0, 60) });
      if (route && typeof route === 'object' && route.silent) {
        $('#caption').textContent = route.statusText || 'Search opened in your browser.';
        voiceLog('silent browser search', route.statusText || text);
        try { SFX.endCommand(); } catch {}
        setMode(recognitionEnabled ? 'LISTENING' : 'IDLE', recognitionEnabled ? 'Search opened - listening for "Jarvis"...' : 'Search opened in your browser.');
        return;
      }
      const fromAi = Boolean(route && typeof route === 'object' && route.aiQuery);
      const answer = route && typeof route === 'object' && route.aiQuery
        ? await requestLocalAI(route.aiQuery, turn, route.searchContext || [], route.recall ? '' : route.aiQuery, Boolean(route.plan), Boolean(route.research), route.emotionalContext || null)
        : route;
      // Long-running operations (camera analysis) can opt out of the turn
      // timeout so they aren't silently dropped when another command
      // increments the turn during their extended processing time.
      const preserveTurn = answer && typeof answer === 'object' && answer.preserveTurn === true;
      if (!preserveTurn && turn !== assistantTurn) return;
      // Handle structured response with emotion metadata
      let displayText = '', speechText = '', emotion = 'neutral', intensity = 0.5, speakingRate = 1;
      if (answer && typeof answer === 'object' && answer.response) {
        const rawDisplay = answer.response;
        const rawSpeech = answer.speech_text || rawDisplay;
        // Display text: strip emojis and laughter bursts (keep for speech only)
        displayText = stripEmojis(Core.prepareResponse ? Core.prepareResponse(rawDisplay, { speech: false }) : normalizeResponseText(rawDisplay));
        displayText = stripLaughterFromDisplay(displayText);
        // Speech text: strip emojis but keep laughter bursts for TTS
        speechText = stripEmojis(Core.prepareResponse ? Core.prepareResponse(rawSpeech, { speech: true }) : forSpeech(rawSpeech));
        // Safety net: an expressive rewrite must never drop a number, time,
        // version, or code identifier. When it does, speak the display text.
        if (Core.speechPreservesFacts && !Core.speechPreservesFacts(displayText, speechText)) {
          speechText = stripEmojis(forSpeech(displayText));
          voiceLog('speech fidelity fallback', 'display text kept for speech');
        }
        const answeredEmotion = String(answer.emotion || '').toLowerCase();
        emotion = (Core.isSpeechEmotion ? Core.isSpeechEmotion(answeredEmotion) : ['neutral'].includes(answeredEmotion)) ? answeredEmotion : 'neutral';
        intensity = Math.max(0, Math.min(1, Number(answer.emotion_intensity) || 0.5));
        // Do not let a neutral reply wipe out a feeling the user just stated.
        if (Date.now() - lastUserMoodAt > 12000) window.JarvisHudTheme?.setMood(emotion);
        speakingRate = Math.max(0.5, Math.min(2, Number(answer.speaking_rate) || 1));
      } else if (answer && typeof answer === 'object' && answer.message) {
        displayText = stripEmojis(Core.prepareResponse ? Core.prepareResponse(answer.message, { speech: false }) : normalizeResponseText(answer.message));
        speechText = stripEmojis(Core.prepareResponse ? Core.prepareResponse(answer.message, { speech: true }) : forSpeech(answer.message));
      } else {
        displayText = stripEmojis(Core.prepareResponse ? Core.prepareResponse(String(answer || ''), { speech: false }) : normalizeResponseText(String(answer || '')));
        speechText = stripEmojis(Core.prepareResponse ? Core.prepareResponse(String(answer || ''), { speech: true }) : forSpeech(String(answer || '')));
      }
      // Final delivery gate for generated answers. The server already retries once,
      // so reaching this with a bad answer means recovery failed: never display
      // an echo or a raw envelope — say so honestly instead. Command, camera and
      // system replies bypass this (they are not model answers).
      if (fromAi) {
        const verdict = Core.answerQuality(displayText, { question: route.aiQuery || text });
        if (!verdict.ok) {
          voiceLog('answer rejected before display', `${verdict.reason} - ${displayText.slice(0, 80)}`);
          displayText = 'My local model echoed your question instead of answering it that time, Sir. Please rephrase it, or ask me again in a moment.';
          speechText = displayText;
        } else if (Core.hasUnrequestedScreenClaim && Core.hasUnrequestedScreenClaim(displayText, route.aiQuery || text)) {
          // But: skip this rejection for explicit screen-location queries
          // ("where is...", "where are...", "point to...") that reference
          // UI elements, because those are genuine user questions about
          // screen content, not unrequested claims.
          const userQ = String(route.aiQuery || text || '').toLowerCase();
          const isScreenLocQuery = /\b(?:where|point|locate)\b/i.test(userQ)
            && /\b(?:screen|button|icon|menu|ui|click|tap|pointer|save|setting)\b/i.test(userQ);
          if (!isScreenLocQuery) {
            voiceLog('unrequested screen claim rejected', `${route.aiQuery || text} -> ${displayText.slice(0, 80)}`);
            displayText = 'That answer pulled in screen context that does not belong to your question, Sir. Ask me again and I will keep to the point.';
            speechText = displayText;
          }
        }
      }
      // ACTION-CLAIM VERIFICATION (2026-10-31): the model's text is never proof
      // that an action ran. If a pure-text answer claims an app/site is opening
      // or open, either make the claim true through the real launcher or replace
      // it with an honest correction. A server tool that already opened
      // something suppresses this guard, so verified actions are never undone
      // or repeated.
      if (fromAi) {
        const aiTools = answer && typeof answer === 'object' && Array.isArray(answer.tools) ? answer.tools : [];
        if (!aiActionToolRan(aiTools) && Core.detectOpenActionClaim) {
          const userTurn = route && route.aiQuery ? route.aiQuery : text;
          const claim = Core.detectOpenActionClaim(displayText, userTurn);
          if (claim) {
            const repaired = await repairUnverifiedOpenClaim(claim, userTurn);
            if (repaired && repaired.text) {
              displayText = repaired.text;
              speechText = repaired.text;
              voiceLog('unverified open claim repaired', `${claim.phrase.slice(0, 80)} -> ${displayText.slice(0, 100)}`);
              routeTelemetry('action-claim', { reason: repaired.executed ? 'executed' : 'corrected', command: claim.target, transcript: String(userTurn || '').slice(0, 80) });
            }
          }
        }
      }
      // Follow-up conversation bridge (2026-10-15): an AI answer that itself
      // ends in a question opens the shared pending question, so the next
      // spoken utterance flows in as the answer WITHOUT another wake word.
      // Workflows (flows/pendingFlow) and existing pending questions are left
      // untouched, and the arming still expires on inactivity like before.
      if (fromAi && !pendingFlow && !awaitingAnswer() && Core.replyAsksForAnswer(String(speechText || '').trim())) {
        armConversationBridge('ai-question', speechText);
        voiceLog('conversation bridge armed by ai question', String(speechText).slice(0, 60));
      }
      // Emotional thread question tracking (2026-10-18): the model asks the
      // follow-up questions in an emotional thread now, so its question is
      // recorded into the engine state — the guidance block then tells the
      // model never to repeat it (the engine-asked path did this itself).
      if (fromAi && route && route.emotionalContext && emotionalState && /[?]\s*$/.test(String(speechText || '').trim())) {
        try { Core.rememberAskedQuestion(emotionalState, speechText); } catch {}
      }
      // Conversation continuation (from the bridge resolver): the answer will
      // have taken Ollama many seconds on CPU. Whatever happened to the old
      // pending record while the model was thinking, the promised listening
      // window is renewed fresh here once the answer actually exists.
      if (fromAi && route.conversationBridge && !pendingFlow) {
        const conversationTtl = Core.CONVERSATION_FOLLOW_UP_MS || Core.MODE_FOLLOWUP_MS || 20000;
        const sustained = Boolean(pendingQuestion && Core.pendingQuestionActive(pendingQuestion) && pendingQuestion.mode === 'conversation');
        const asks = Core.replyAsksForAnswer ? Core.replyAsksForAnswer(speechText) : /[?]\s*$/.test(String(speechText || '').trim());
        if (sustained || asks) {
          // Only an explicitly enabled Conversation Mode or an answer that
          // actually asks the user something keeps the no-wake window alive.
          if (pendingQuestion) {
            Core.refreshPendingQuestion(pendingQuestion, { now: Date.now(), ttlMs: conversationTtl });
            voiceLog('conversation bridge renewed after answer', String(speechText).slice(0, 50));
          } else {
            const expectedKind = Core.inferFollowUpExpected ? Core.inferFollowUpExpected(speechText) : '';
            setPendingQuestion('conversation', expectedKind || 'free', String(speechText || '').slice(0, 300), { intent: 'conversation', waitingFor: expectedKind || 'free', ttlMs: conversationTtl, collected: { lastIntent: 'ai-answer', expected: expectedKind || 'free' } });
            voiceLog('conversation bridge re-armed after answer', String(speechText).slice(0, 50));
          }
        } else if (pendingQuestion) {
          // Finished statement: close the promised window now so playback end
          // returns the mic to wake-word standby instead of listening to the
          // room for the rest of the previous question's TTL.
          clearPendingQuestion('answer-complete');
          setVoiceSession({ status: 'standby', conversationActive: false, waitingFor: '', pendingKind: '', lastQuestion: '', expiresAt: 0 }, 'answer-complete');
          voiceLog('conversation bridge closed after finished answer', String(speechText).slice(0, 50));
        }
      }
      // Anti-repeat: a short model answer that is word-for-word the last one
      // is the clearest robot tell there is — the live log caught "how is your
      // day" answered twice with the same sentence. Command replies are never
      // touched (closing the same app twice SHOULD say the same thing).
      if (fromAi && displayText && displayText.length <= 180) {
        const previousJarvis = [...conversationHistory].reverse().find(item => item.who !== 'YOU' && item.who !== 'Me');
        if (previousJarvis && String(previousJarvis.text || '').trim().toLowerCase() === displayText.trim().toLowerCase()) {
          const fresh = [
            'I am still here, Sir. What is on your mind?',
            'Still right with you, Sir — go ahead.',
            'Right here, Sir. Tell me what you need.'
          ];
          displayText = fresh[notFoundCount++ % fresh.length];
          speechText = displayText;
          voiceLog('repeated model answer varied', displayText);
        }
      }
      addMessage('J.A.R.V.I.S.', displayText); addWebSources(lastWebResults); lastWebResults = []; $('#caption').textContent = displayText;
      // Generate responseId for deduplication
      const responseId = speechController.generateResponseId(displayText);
      // Voice-only mode questions, greeting questions, alarm/reminder
      // clarifications and the multi-turn workflows all arm the no-wake-word
      // follow-up window through the SHARED pending-question state, so the
      // next utterance can be a plain answer instead of needing the wake
      // word again. Ordinary finished answers keep standby rules.
      const pendingNow = awaitingAnswer();
      // Also arm follow-up for ANY response (local or AI) that ends with a
      // question mark — this covers local library replies like "What's on your mind?"
      // and AI responses that ask questions.
      const endsWithQuestion = /[?]\s*$/.test(String(speechText || displayText || '').trim());
      const wantsFollowUp = (answer && answer.followUp === true) || pendingNow || endsWithQuestion;
      // Playback-before-listening: speak() resolves when playback STARTS, not
      // when it finishes. Arming the no-wake-word window here therefore opened
      // ordinary command recognition mid-utterance and let JARVIS's own voice
      // trigger a reply. The window is now opened ONLY by the real
      // playback-completion handler inside speak()'s `onended`.
      // The thinking loop must stop BEFORE speech starts, otherwise it plays under
      // the answer and mixes with the voice output.
      try { SFX.thinkingStop(); } catch {}
      await speak(displayText, turn, wantsFollowUp, emotion, intensity, speechText, speakingRate, requestId, responseId);
    } catch (error) {
      // Diagnostics keep the technical detail; the user hears a natural reply.
      // A real failure gets a restrained low cue - never a success sound.
      try { SFX.error(); } catch {}
      if (turn === assistantTurn) { voiceLog('request failed', error.message); routeTelemetry('ask-failed', { reason: String((error && error.name) || 'error'), transcript: String((error && error.message) || '').slice(0, 90), ms: Date.now() - askStartedAt }); setMode('ERROR', 'That request failed. Please try again.'); notify('That request failed. Please try again.'); scheduleVoiceRecovery(); }
    } finally {
      // No timer, interval or oscillator survives the command.
      try { SFX.endCommand(); } catch {}
      if (voiceBusyGuard) clearTimeout(voiceBusyGuard);
      if (voiceInitiated && voiceBusyOwner === turn) voiceBusy = false;
    }
  }
  async function requestLocalAI(query, turn, searchContext = [], recallQuery = '', plan = false, research = false, emotionalContext = null) {
    const model = $('#aiModel')?.value || localStorage.getItem('jarvis-ai-model') || '';if (!model) {
      if (searchContext.length) {
        lastWebResults = searchContext;
        return `I found ${searchContext.length} source${searchContext.length === 1 ? '' : 's'} for that, Sir, but no local AI model is installed yet, so I cannot summarize them. The sources are on screen   start Ollama, press Refresh in AI Settings, then ask me again.`;
      }
      return 'Your JARVIS local AI is not set up yet. Install Ollama from ollama.com/download/windows, then run "ollama pull qwen3:1.7b" in PowerShell and press Refresh in AI Settings. No cloud chat provider is configured.';
    }
    // Durable recall: relevant older conversation travels with the request so
    // "what did we discuss yesterday" style questions can be answered.
    const recall = Core.buildRecall(durableHistory, loadJson('jarvis-summaries', []), recallQuery);
    // Prepend a system prompt that encourages expressive, slightly longer replies
    const systemPrompt = {role: 'system', content: 'Follow the response style and expressive delivery rules in the system prompt. Match the tone to the moment — lively and warm when it fits, calm and clear for serious, technical, or bad-news replies. Keep replies to 1-2 sentences, vary openings and laughter, and never use stage directions, emotion tags, or emojis. response_text and speech_text must state the same facts. Only mention the user\'s screen, a screenshot, or an on-screen pointer when the current message explicitly asks about it; never carry over screen details from earlier turns.'};
    let baseMessages = Core.toConversationMessages(conversationHistory, Number($('#memoryWindow')?.value || 18));
    // A previous pointer/screenshot report must never become the answer to an
    // unrelated question. Keep that history only when the current question is
    // actually about the screen.
    if (Core.stripStaleScreenMessages) baseMessages = Core.stripStaleScreenMessages(baseMessages, query);
    const messages = [systemPrompt, ...baseMessages];
    const controller = new AbortController(); aiAbort = controller;
    // Reply-time estimate (2026-10-18): shown ONLY while a request is in
    // flight to the local model. It is written to on-screen status text and
    // NEVER into the reply string, so the API response and the TTS never read
    // it out. The number is the rolling average of past real reply times.
    const aiStartedAt = Date.now();
    // Predicted layer first (router tells us before the request), replaced by
    // what actually served once the reply arrives.
    const routerData = latestAIStatus && latestAIStatus.router ? latestAIStatus.router : null;
    const remoteFirst = Boolean(routerData && routerData.mode !== 'local' && Array.isArray(routerData.remoteEligible) && routerData.remoteEligible.length);
    const remotePretty = { opencode: 'OpenCode', openrouter: 'OpenRouter', freebuff: 'remote AI' };
    const aiRouteName = remoteFirst ? (remotePretty[routerData.remoteEligible[0]] || 'remote AI') : '';
    let servedRemote = remoteFirst;
    const est = estimateLocalAIReplySeconds(remoteFirst);
    // The wait-time estimate is now shown for BOTH layers: it is a display-only
    // rolling average, so it can never reach the reply text or the TTS.
    const etaText = aiRouteName ? `Asking remote AI (${aiRouteName})... (${est}s)` : `Asking the local AI... (${est}s)`;
    transitionVoice('THINKING', aiRouteName ? `Asking remote AI (${aiRouteName}) - about ${est}s` : `Asking local model ${model} - about ${est}s`);
    const caption = $('#caption'); if (caption) caption.textContent = etaText;
    const status = $('#aiStatusText'); if (status) status.textContent = aiRouteName ? `Thinking with remote AI (${aiRouteName})... (${est}s)` : `Thinking locally with ${model}... (${est}s)`;
    const live = addStreamingMessage(); let streamed = ''; let answeredAt = 0;
    // The deadline aborts ONLY this turn's controller. Every user-cancel path
    // (stop button, barge-in, a newer command) bumps assistantTurn BEFORE it
    // aborts, so the catch can tell "the user cancelled" (stays silent) apart
    // from "the providers stalled" (answered honestly, never an empty bubble).
    const aiDeadlineTimer = setTimeout(() => controller.abort(), AI_TURN_DEADLINE_MS);
    try {
      lastWebResults = Array.isArray(searchContext) ? searchContext : [];
      // Show what the AI will receive so the user can verify the transcript arrived
      const userMsg = conversationHistory.length ? conversationHistory[conversationHistory.length - 1]?.text || '' : '';
      console.log(`[JARVIS AI] Sending to local AI — transcript: "${userMsg.slice(0, 80)}`, `messages count: ${messages.length}`, `last user msg: ${userMsg.length > 0 ? userMsg.slice(0, 60) : 'none'}`);
      const response = await fetch('/api/ai/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, profile: { callName: preferredName(), givenName: givenName() }, memory: memoryEntries, searchContext: lastWebResults, recall, plan, research, budget: research ? 1024 : 0, emotionalContext: emotionalContext || null }), signal: controller.signal });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        throw new Error(problem.message || `Local AI returned HTTP ${response.status}.`);
      }
      if (!response.body) throw new Error('The local AI stream is unavailable in this desktop webview.');
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', result = { model, tools: [] }, streamError = '';
      const consume = line => {
if (!line.trim()) return;
        let packet; try { packet = JSON.parse(line); } catch { return; }
if (packet.type === 'token') { streamed += packet.text || ''; live.body.textContent = normalizeResponseText(streamed); feed.scrollTop = feed.scrollHeight; }
        else if (packet.type === 'reset') { streamed = ''; live.body.textContent = '...'; }
        else if (packet.type === 'done') { result = packet; routeTelemetry('ai-served', { provider: /^(openrouter|opencode|freebuff):/.test(String(packet.model || '')) ? 'remote' : 'local', ms: Date.now() - aiStartedAt, command: String(packet.model || '').slice(0, 40) }); }
        else if (packet.type === 'error') streamError = packet.message || 'The local model stream failed.';
      };
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) consume(line);
        // Turn-only check: a user cancel always bumps assistantTurn before it
        // aborts, while the deadline aborts WITHOUT bumping — so a deadline
        // hit must keep flowing and land in the catch, which answers it.
        if (turn !== assistantTurn) { routeTelemetry('ai-orphaned', { reason: 'replaced by a newer command while streaming', ms: Date.now() - aiStartedAt }); await reader.cancel().catch(() => {}); return ''; }
      }
      buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
      if (turn !== assistantTurn) { routeTelemetry('ai-orphaned', { reason: 'replaced by a newer command after the stream ended', ms: Date.now() - aiStartedAt }); return ''; }
      if (!streamed.trim()) {
if (status) status.textContent = aiRouteName ? 'EMPTY STREAM - RETRYING REMOTE AI' : 'EMPTY STREAM - RETRYING LOCAL MODEL';
        voiceLog('empty model stream', 'Retrying once through local Ollama chat');
        const retry = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, profile: { callName: preferredName(), givenName: givenName() }, memory: memoryEntries, searchContext: lastWebResults, recall, plan, research, budget: research ? 1024 : 0, emotionalContext: emotionalContext || null }), signal: controller.signal });
        const retryResult = await retry.json().catch(() => ({}));
if (retry.ok && retryResult.ok && String(retryResult.response || '').trim()) {
          live.row.remove(); if (Array.isArray(retryResult.sources) && retryResult.sources.length) lastWebResults = retryResult.sources;
if (status) { const retryServed = String(retryResult.model || model || ''); const retryPrefix = /^(openrouter|opencode|freebuff):(.+)$/.exec(retryServed); if (retryPrefix) servedRemote = true; status.textContent = retryPrefix ? `REMOTE AI ONLINE - ${remotePretty[retryPrefix[1]] || 'Remote'} - ${retryPrefix[2]} - RETRIED` : `LOCAL MODEL ONLINE - ${retryServed} - RETRIED`; status.classList.remove('ai-error'); status.classList.add('ai-ready'); }
          answeredAt = Date.now();
          voiceLog('local model retry succeeded', retryResult.model || model);
          // Handle structured response from retry
          if (retryResult.response_text && retryResult.speech_text && retryResult.emotion) {
            return {
              response: stripEmojis(retryResult.response_text),
              speech_text: retryResult.speech_text,
              emotion: retryResult.emotion,
              emotion_intensity: retryResult.emotion_intensity,
              speaking_style: retryResult.speaking_style,
              speaking_rate: retryResult.speaking_rate,
              pause_hints: retryResult.pause_hints,
              pronunciation_hints: retryResult.pronunciation_hints,
              tools: Array.isArray(retryResult.tools) ? retryResult.tools : []
            };
          }
          return { response: normalizeResponseText(Core.stripEnvelopeTailLabels(String(retryResult.response).trim())), tools: Array.isArray(retryResult.tools) ? retryResult.tools : [] };
        }
if (searchContext.length) {
          live.row.remove();
          voiceLog('local answer fallback', 'Model returned nothing; showing fetched sources without inventing a summary');
          return `My local model returned an empty answer, Sir, but I found ${searchContext.length} source${searchContext.length === 1 ? '' : 's'}   they are on screen. I cannot summarize them until the model responds; try again in a moment.`;
        }
        throw new Error(retryResult.message || streamError || 'The local model returned an empty answer after a retry. Try a shorter question or another installed model.');
      }
      if (streamError) throw new Error(streamError);
      live.row.remove();
      answeredAt = Date.now();
      if (Array.isArray(result.sources) && result.sources.length) lastWebResults = result.sources;
      // The done packet's model field names the layer that ACTUALLY answered
      // ("openrouter:nvidia/..." when remote served, the plain model if local).
      if (status) {
        const served = String(result.model || model || '');
        const servedPrefix = /^(openrouter|opencode|freebuff):(.+)$/.exec(served);
        if (servedPrefix) servedRemote = true;
        status.textContent = servedPrefix ? `REMOTE AI ONLINE - ${remotePretty[servedPrefix[1]] || 'Remote'} - ${servedPrefix[2]}` : `LOCAL MODEL ONLINE - ${served}`;
        status.classList.remove('ai-error'); status.classList.add('ai-ready');
      }
      if (result.tools?.length) voiceLog('AI tool calls', result.tools.map(tool => `${tool.name}:${tool.ok ? 'ok' : 'failed'}`).join(', '));
      voiceLog('AI response complete', result.model || model);
      // Return structured response if available, otherwise fall back to plain text
      if (result.response_text && result.speech_text && result.emotion) {
        return {
          response: stripEmojis(result.response_text),
          speech_text: result.speech_text,
          emotion: result.emotion,
          emotion_intensity: result.emotion_intensity,
          speaking_style: result.speaking_style,
          speaking_rate: result.speaking_rate,
          pause_hints: result.pause_hints,
          pronunciation_hints: result.pronunciation_hints,
          tools: Array.isArray(result.tools) ? result.tools : []
        };
      }
      return { response: Core.stripEnvelopeTailLabels(streamed.trim()), tools: Array.isArray(result.tools) ? result.tools : [] };
    } catch (error) {
      live.row.remove();
      if (error.name === 'AbortError') {
        // A user cancel (stop button, barge-in, newer command) always bumps
        // assistantTurn BEFORE aborting, so a same-turn AbortError can only
        // be our own deadline: the providers stalled past the cap. Answer
        // honestly — never an empty bubble or dead silence. Superseded turns
        // stay silent exactly as before.
        if (turn !== assistantTurn) { routeTelemetry('ai-orphaned', { reason: 'replaced by a newer command while waiting for the answer', ms: Date.now() - aiStartedAt }); return ''; }
        routeTelemetry('ai-failed', { reason: 'deadline', ms: Date.now() - aiStartedAt, transcript: String(query || '').slice(0, 60) });
        voiceLog('ai deadline reached', `${Date.now() - aiStartedAt}ms`);
        if (status) { status.textContent = 'AI REQUEST TIMED OUT'; status.classList.add('ai-error'); }
        return 'That answer took too long, Sir. The AI provider stalled — please ask me again.';
      }
      // Diagnostics keep the exact detail; spoken replies stay natural. Server
      // guidance (e.g. "install this model") is safe to repeat, raw HTTP or
      // exception text is not.
      if (status) { status.textContent = error.message; status.classList.add('ai-error'); }
      routeTelemetry('ai-failed', { reason: String((error && error.name) || 'error'), transcript: String(query || '').slice(0, 60), ms: Date.now() - aiStartedAt });
      voiceLog('local AI error', error.message);
      const technical = /\b(?:HTTP \d{3}|fetch failed|ECONNREFUSED|ECONNRESET|TypeError|ENOENT|stack)\b/i.test(String(error.message || ''));
      if (technical || !String(error.message || '').trim()) {
        return searchContext.length
          ? 'My local model did not answer that time, Sir. The sources I found are on screen   try again in a moment.'
          : 'My local model did not answer that time. Try again in a moment, or check Ollama in AI Settings.';
      }
      return String(error.message);
    } finally {
      // Only real replies feed the rolling average: aborts and failures leave
      // answeredAt at 0 so they can never skew the estimate. The deadline
      // timer must never outlive its turn either.
      clearTimeout(aiDeadlineTimer);
      if (aiAbort === controller) aiAbort = null;
      if (answeredAt) recordLocalAIReplyMs(answeredAt - aiStartedAt, { remote: servedRemote });
    }
  }
  async function startMicrophoneMonitor() {if (micStream?.active) return;if (micStarting) { voiceLog('mic start already in progress', 'duplicate listener prevented'); return; }micStarting = true;if (micStream) stopMicrophoneMonitor();if (!navigator.mediaDevices?.getUserMedia) { micStarting = false; throw new Error('This Edge build cannot access the microphone.'); }
    const audio = { echoCancellation: true, noiseSuppression: localStorage.getItem('jarvis-noise-suppression') !== 'false', autoGainControl: true };if (selectedMicDeviceId) audio.deviceId = { exact: selectedMicDeviceId };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (error) {
      if (!selectedMicDeviceId) { micStarting = false; throw error; }
      selectedMicDeviceId = ''; localStorage.removeItem('jarvis-audio-input');
      if ($('#audioInputDevice')) $('#audioInputDevice').value = '';
      readout('#audioDeviceStatus', 'Saved microphone is unavailable; using the Windows default for local recognition.');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: localStorage.getItem('jarvis-noise-suppression') !== 'false', autoGainControl: true } });
      } catch (fallbackError) { micStarting = false; throw fallbackError; }
    }if (!recognitionEnabled) { stream.getTracks().forEach(track => track.stop()); micStarting = false; return; }
    micStream = stream;
    micStartCount++;
    const track = micStream.getAudioTracks?.()[0];
    const trackSettings = track?.getSettings?.() || {};
    // WAKE-WORD 2026-10-14: diagnostic mic identity (device, format, buffers).
    // No continuous audio is recorded or saved; only levels/scores are logged.
    try {
      voiceLog('mic selected', `${track?.label || 'selected input'} - device=${selectedMicDeviceId || 'system-default'} - ${trackSettings.sampleRate || audioContext?.sampleRate || '?'} Hz - ch=${trackSettings.channelCount || 1} - ec=${trackSettings.echoCancellation ?? '?'} ns=${trackSettings.noiseSuppression ?? '?'} agc=${trackSettings.autoGainControl ?? '?'} - start#${micStartCount}`);
      readout('#micFormatDiagnostic', `${String(track?.label || 'selected input').slice(0, 40)} - ${(trackSettings.sampleRate || audioContext?.sampleRate || 0) ? `${Math.round((trackSettings.sampleRate || audioContext.sampleRate) / 100) / 10} kHz` : 'unknown rate'} ${trackSettings.channelCount || 1}ch -> 16 kHz mono PCM`);
    } catch {}
    // Detect physical disconnects: the track fires `ended` when Windows
    // unplugs/disables the device. Recovery is debounced and single-flight.
    try {
      if (track) track.onended = () => {
        voiceLog('mic disconnected', track.label || 'selected input');
        readout('#micDiagnostic', 'DISCONNECTED - reconnect the mic or pick another device');
        if (recognitionEnabled && Date.now() - lastMicRecoveryAt > 3000) {
          lastMicRecoveryAt = Date.now();
          stopMicrophoneMonitor();
          setTimeout(() => { if (recognitionEnabled) startMicrophoneMonitor().catch(e => voiceLog('mic recovery failed', e.message)); }, 1500);
        }
      };
    } catch {}
    await refreshAudioDevices();
    readout('#audioDeviceStatus', trackSettings.noiseSuppression === true
      ? 'Browser noise suppression is active. JARVIS is learning the steady room/fan noise before listening for speech.'
      : trackSettings.noiseSuppression === false
        ? 'Browser noise suppression is unavailable; JARVIS is using its local noise gate and speech filters.'
        : 'Noise suppression was requested; JARVIS is learning the steady room/fan noise before listening.');
    audioContext ||= new AudioContext(); if (audioContext.state === 'suspended') await audioContext.resume();
    const source = audioContext.createMediaStreamSource(micStream);
    micHighPassNode = audioContext.createBiquadFilter(); micHighPassNode.type = 'highpass'; micHighPassNode.frequency.value = 150; micHighPassNode.Q.value = .72;
    micLowPassNode = audioContext.createBiquadFilter(); micLowPassNode.type = 'lowpass'; micLowPassNode.frequency.value = 7600; micLowPassNode.Q.value = .72;
    micAnalyser = audioContext.createAnalyser(); micAnalyser.fftSize = 512;
    micBoostNode = audioContext.createGain(); micBoostNode.gain.value = Number(localStorage.getItem('jarvis-mic-gain') || 1.8);
    source.connect(micHighPassNode); micHighPassNode.connect(micLowPassNode); micLowPassNode.connect(micBoostNode);
    micBoostNode.connect(micAnalyser); micSamples = new Uint8Array(micAnalyser.fftSize);
    audioProcessor = audioContext.createScriptProcessor(4096, 1, 1); mutedCaptureGain = audioContext.createGain(); mutedCaptureGain.gain.value = 0;
    audioProcessor.onaudioprocess = event => captureSpeechFrame(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
    micBoostNode.connect(audioProcessor); audioProcessor.connect(mutedCaptureGain); mutedCaptureGain.connect(audioContext.destination);
    preRollFrames = []; utteranceFrames = []; speechActive = false; speechSilenceMs = 0; speechCandidateMs = 0; micNoise = 0.003; speechGate.reset();
    lastCaptureAt = 0; captureGapCount = 0;
    readout('#confidenceDiagnostic', 'CALIBRATING ROOM NOISE - 0.6 SEC');
    monitorMicrophone(); micFrame = setInterval(monitorMicrophone, 40);
    micStarting = false;
    // Optional openWakeWord sidecar probe (non-blocking, offline, reversible):
    // loads /wakeword-oww.js only to report local-model presence. Absence is
    // normal and leaves the Whisper pipeline unchanged.
    try {
      if (!window.JarvisWakeWord && !startMicrophoneMonitor._owwProbed) {
        startMicrophoneMonitor._owwProbed = true;
        const el = document.createElement('script');
        el.src = '/wakeword-oww.js'; el.async = true;
        el.onload = () => {
          try {
            window.JarvisWakeWord.init().then(r => voiceLog('wake sidecar', r.reason)).catch(() => {});
          } catch {}
        };
        el.onerror = () => voiceLog('wake sidecar', 'optional sidecar absent - Whisper pipeline unchanged');
        document.head.appendChild(el);
      } else if (window.JarvisWakeWord) {
        window.JarvisWakeWord.init().then(r => voiceLog('wake sidecar', r.reason)).catch(() => {});
      }
    } catch {}
  }
  // Push-to-talk session helpers (state and constants are declared near the
  // top of the voice section, before setMode, so it can refresh the button).
  function pttUnavailableReason() {
    if (!recognitionEnabled) return 'voice standby is off';
    if (micMuted) return 'microphone is muted';
    if (!micStream?.active) return 'microphone is not active';
    return '';
  }
  function updatePttButtonState() {
    const button = $('#pttBtn'); if (!button) return;
    // Ready (mic up and idle) - Listening (held) - Processing (finalizing a
    // recording) - Unavailable (voice off, muted, or no active mic stream).
    const state = pttCtl.holding ? 'on' : pttCtl.active ? 'busy' : (pttUnavailableReason() ? 'off' : 'ready');
    const label = state === 'on' ? 'LISTENING - PTT' : state === 'busy' ? 'PROCESSING - PTT' : state === 'off' ? 'PTT - NO MIC' : 'PUSH-TO-TALK';
    if (button.dataset.ptt === state && button.textContent === label) return;
    button.dataset.ptt = state; button.textContent = label;
  }
  function startPushToTalk(source) {
    // Duplicate presses and keyboard auto-repeat can never start a second
    // recording: a single session exists at a time.
    if (pttCtl.holding) return false;
    const blocked = pttUnavailableReason();
    if (blocked) {
      voiceLog('push-to-talk unavailable', `${blocked} - press ignored`);
      readout('#wakeDiagnostic', `PUSH-TO-TALK UNAVAILABLE - ${blocked.toUpperCase()}`);
      notify(`Push-to-talk is unavailable: ${blocked}. Enable voice and allow microphone access first.`);
      updatePttButtonState();
      return false;
    }
    pttCtl.holding = true; pttCtl.active = true; pttCtl.spent = false;
    pttCtl.source = source; pttCtl.startedAt = Date.now(); pttCtl.tailUntil = 0; pttCtl.framesMs = 0;
    // ARM THE HOLD WATCHDOG FOR EVERY SOURCE (2026-10-24). It used to be armed
    // only on the global-hotkey path, so an in-page key/button hold that lost its
    // release (focus change, missed keyup) had no safety net at all.
    armPttHoldWatchdog();
    pipelineCounters.pttPressed = (pipelineCounters.pttPressed || 0) + 1;
    // While JARVIS is speaking, a PTT press is a deliberate interruption via
    // the existing speech controller. Bump the epoch so TTS-echo transcriptions
    // queued while playback ran can never submit, exactly like a wake barge-in.
    const modeNow = hero.dataset.mode;
    if (modeNow === 'SPEAKING' || modeNow === 'INTERRUPTED') {
      try { aiAbort?.abort(); aiAbort = null; } catch {}
      stopSpeech();
      voiceEpoch++;
      voiceLog('push-to-talk interrupt', 'TTS stopped by push-to-talk press - capturing command');
    }
    if (speechActive && pendingUtterance) {
      // A wake-word capture was already running; the press upgrades it so the
      // release finalizes as an authorized command instead of wake audio.
      pendingUtterance.ptt = true;
      voiceLog('push-to-talk upgrade', 'ongoing capture continues as push-to-talk command');
    }
    setMode('LISTENING', 'Push-to-talk - listening...');
    readout('#wakeDiagnostic', `PTT ${String(source).toUpperCase()} - speak now, release to send`);
    voiceLog('push-to-talk started', `source ${source} - capturing until release`);
    updatePttButtonState();
    return true;
  }
  function endPushToTalk() {
    if (!pttCtl.holding) { voiceLog('push-to-talk release ignored', 'no active push-to-talk press'); return; }
    const heldMs = Date.now() - pttCtl.startedAt;
    pttCtl.holding = false;
    if (!speechActive || !pendingUtterance?.ptt) {
      // Nothing recorded (released before a frame arrived, or the hold cap had
      // already finalized while still held). Clean reset, never stuck.
      if (pttCtl.spent) voiceLog('push-to-talk released after hold cap', 'no second recording started');
      else voiceLog('push-to-talk released - no speech captured', `${heldMs} ms hold`);
      pttCtl.active = false; pttCtl.spent = false; pttCtl.tailUntil = 0; pttCtl.framesMs = 0;
      updatePttButtonState();
      setMode(recognitionEnabled ? 'LISTENING' : 'IDLE', recognitionEnabled ? 'Listening for "Jarvis"...' : 'Idle');
      return;
    }
    // Keep the tail rolling: the capture loop finalizes the utterance the
    // moment speech settles (or the tail expires), so the ending is preserved.
    pttCtl.tailUntil = Date.now() + PTT_TAIL_MS;
    pttCtl.active = false;
    pttCtl.spent = false;

    pipelineCounters.pttCaptured = (pipelineCounters.pttCaptured || 0) + 1;
    setMode('THINKING', 'Push-to-talk released - transcribing your request...');
    voiceLog('push-to-talk released', `${heldMs} ms hold - finalizing captured audio`);
    updatePttButtonState();
  }
  function abortPushToTalk(reason) {
    if (!pttCtl.holding && !pttCtl.active) return;
    voiceLog('push-to-talk aborted', reason);
    if (pttCtl.holding) endPushToTalk();
    else { pttCtl.active = false; pttCtl.spent = false; updatePttButtonState(); }
  }
  function resetPttSession() {
    // The hold is over, so the session is over too: the hold cap finalizes the
    // recording while the key is still down, and the button must not keep
    // showing "LISTENING - PTT" until the key is released.
    pttCtl.holding = false; pttCtl.active = false; pttCtl.spent = false; pttCtl.tailUntil = 0; pttCtl.framesMs = 0;
    updatePttButtonState();
  }
  function captureSpeechFrame(input, sampleRate) {if (!recognitionEnabled || !micStream?.active || micMuted) return;
    pipelineCounters.frames++;
    // Dropped-frame detector: ScriptProcessor should fire roughly every
    // 4096/sampleRate seconds (~85 ms @ 48 kHz). Gaps >250 ms mean the event
    // loop stalled or the device glitched; count them for diagnostics.
    const nowMs = Date.now();
    if (lastCaptureAt && nowMs - lastCaptureAt > 250 && !speechActive) {
      captureGapCount++;
      if (captureGapCount <= 3 || captureGapCount % 20 === 0) voiceLog('audio frame gap', `${Math.round(nowMs - lastCaptureAt)} ms gap (#${captureGapCount}) - possible stall`);
    }
    lastCaptureAt = nowMs;
    const copy = new Float32Array(input), durationMs = copy.length * 1000 / sampleRate;
    let sum = 0; for (const value of copy) sum += value * value;
    const rms = Math.sqrt(sum / copy.length);
    // PATH A tap: ungated wake-word detection on RAW mic audio, every frame.
    // PLAYBACK GATE: while TTS plays (or during the tail hold) the template
    // score is still computed for diagnostics, but NOTHING seeds capture
    // unless the barge-energy latch fires (deliberate loud speech). This is
    // what stops JARVIS's own voice from interrupting itself or entering
    // the transcription pipeline. In-memory only; nothing recorded or sent.
    try {
      const wd = getWakeSyllableDetector();
      if (wd) {
        wakeRing.push(copy); if (wakeRing.length > 14) wakeRing.shift();
        const speakingNow = hero.dataset.mode === 'SPEAKING' || hero.dataset.mode === 'INTERRUPTED';
        if (speakingNow) speakLevel += (rms - speakLevel) * 0.05;
        const bargeNow = Core.bargeFrame ? Core.bargeFrame({ rms, commandFloor: micNoise, speakLevel }) : false;
        bargeFrames = bargeNow ? bargeFrames + 1 : 0;
        const bargeLatch = bargeFrames >= ((Core.PLAYBACK_DEFAULTS && Core.PLAYBACK_DEFAULTS.bargeFrames) || 2);
        const wr = wd.sample(rms, durationMs, { speaking: speakingNow, now: nowMs });
        wakeScore = wr.score;
        // Path A fired: seed command capture + interrupt TTS directly (no
        // invented transcript). The real audio flows to Whisper, whose text
        // verdict + echo/contamination guards decide everything downstream.
        if (wr.fired) {
          const gate = Core.playbackGateDecision ? Core.playbackGateDecision({ ttsActive, holdActive: nowMs < listenHoldUntil, bargeLatch, sfxActive: SFX.isGated() }) : { seed: true, reason: 'idle' };
          if (gate.seed) handleWakeEvent(wr, speakingNow, { barge: speakingNow });
          else if (nowMs - lastGateHeldLog > 5000) { lastGateHeldLog = nowMs; voiceLog('wake detector held', `score ${wr.score.toFixed(2)} suppressed during ${gate.reason} (own-voice guard)`); }
        }
      }
    } catch (error) { if (!captureSpeechFrame._wakeWarned) { captureSpeechFrame._wakeWarned = true; voiceLog('wake detector error', String(error.message || error).slice(0, 120)); } }
    const gate = speechGate.sample(rms, durationMs, speechActive);
    micNoise = gate.noiseFloor;
    const visualLevel = Math.sqrt(Math.max(0, Math.min(1, (rms - micNoise) * 24)));
    hero.style.setProperty('--mic-level', visualLevel.toFixed(3));
    updateCoreVoiceVisual(visualLevel);
    hero.style.setProperty('--core-ring-opacity', (0.42 + visualLevel * 0.5).toFixed(3));
    hero.style.setProperty('--core-ring-scale', (1 + visualLevel * 0.075).toFixed(3));
    hero.style.setProperty('--core-ring-glow', `${3 + visualLevel * 15}px`);
    const meter = $('#micMeter'); if (meter) meter.style.transform = `scaleX(${Math.max(.04, visualLevel)})`;
    const inputDb = 20 * Math.log10(Math.max(rms, 0.00001));
    const ambientDb = 20 * Math.log10(Math.max(micNoise, 0.00001));
    readout('#confidenceDiagnostic', gate.calibrating
      ? `CALIBRATING ROOM NOISE - ${Math.min(100, Math.round(speechGate.calibratingMs / speechGate.calibrationMs * 100))}%`
      : `INPUT ${inputDb.toFixed(0)} dB - AMBIENT ${ambientDb.toFixed(0)} dB${wakeScore != null ? ` - WAKE ${wakeScore.toFixed(2)}` : ''}${ttsActive ? ' - PLAYBACK-GATED' : (nowMs < listenHoldUntil ? ' - TAIL-HOLD' : '')}${captureGapCount ? ` - gaps ${captureGapCount}` : ''}`);
    // PUSH-TO-TALK capture path: while a PTT session holds the microphone,
    // every frame from press to release belongs to the command. The wake
    // detector above still runs (its events are inert once speechActive), the
    // VAD gate keeps modeling room noise, and the normal VAD seeding and
    // silence-based finalize below are skipped for these frames so a long
    // held sentence is never cut while the user keeps speaking.
    if (pttCtl.active) {
      if (!speechActive && !pttCtl.spent) {
        speechActive = true;
        utteranceFrames = [...preRollFrames];
        speechSilenceMs = 0; speechCandidateMs = 0;
        pendingUtterance = { id: ++utteranceSeq, epoch: voiceEpoch, micEpoch: micSessionEpoch, startedAt: pttCtl.startedAt, endedAt: 0, ptt: true };
        voiceLog('push-to-talk capture started', `first frame ${Date.now() - pttCtl.startedAt} ms after press`);
      }
      if (speechActive) {
        utteranceFrames.push(copy);
        speechCandidateMs = 0;
        if (gate.voice) speechSilenceMs = 0; else speechSilenceMs += durationMs;
        pttCtl.framesMs += durationMs;
        if (pttCtl.holding) {
          // While held: no silence-based finalize (that would cut the
          // sentence); only the hard memory cap ends the capture early.
          if (pttCtl.framesMs >= PTT_HOLD_HARD_CAP_MS) {
            voiceLog('push-to-talk hold cap', `${Math.round(pttCtl.framesMs)} ms - finalizing while still held`);
            pttCtl.spent = true;
            finishSpeechUtterance(sampleRate);
            resetPttSession();
          }
        } else if (speechSilenceMs >= 350 || Date.now() >= pttCtl.tailUntil) {
          // Released: finalize exactly once, as soon as the tail settles.
          finishSpeechUtterance(sampleRate);
          resetPttSession();
        }
      } else {
        // Hold-cap session already finalized while still held: keep the
        // pre-roll rolling, capture nothing further until release.
        preRollFrames.push(copy); if (preRollFrames.length > 4) preRollFrames.shift();
      }
      return;
    }
    if (!speechActive) {
      preRollFrames.push(copy); if (preRollFrames.length > 4) preRollFrames.shift();
      speechCandidateMs = gate.candidateMs;
      // PLAYBACK GATE: own TTS energy must never seed normal capture. The
      // pre-roll above keeps rolling so nothing is lost; when playback ends
      // the persisting gate trigger seeds immediately (fast resume), and a
      // barge latch bypasses for deliberate interruptions.
      if (gate.trigger) {
        const bargeLatch = bargeFrames >= ((Core.PLAYBACK_DEFAULTS && Core.PLAYBACK_DEFAULTS.bargeFrames) || 2);
        const decision = Core.playbackGateDecision ? Core.playbackGateDecision({ ttsActive, holdActive: nowMs < listenHoldUntil, bargeLatch, sfxActive: SFX.isGated() }) : { seed: true, reason: 'idle' };
        if (!decision.seed) {
          if (nowMs - lastGateHeldLog > 5000) { lastGateHeldLog = nowMs; voiceLog('vad trigger suppressed', `${inputDb.toFixed(0)} dB during ${decision.reason} (own-voice guard)`); }
        } else { speechActive = true; utteranceFrames = [...preRollFrames]; speechSilenceMs = 0; speechCandidateMs = 0; pendingUtterance = { id: ++utteranceSeq, epoch: voiceEpoch, startedAt: Date.now(), endedAt: 0, bargeSeeded: decision.reason === 'barge' }; pipelineCounters.vadTriggers++; lastVadTrigger = { db: inputDb, noiseDb: ambientDb }; voiceLog(decision.reason === 'barge' ? 'barge trigger' : 'vad trigger', `${inputDb.toFixed(0)} dB over ${ambientDb.toFixed(0)} dB ambient - gate ${(speechGate.thresholdRatio || Number(localStorage.getItem('jarvis-noise-gate') || 1.25)).toFixed(2)}x`); setMode('LISTENING', decision.reason === 'barge' ? 'Interruption heard - listening...' : 'Voice detected - local Whisper is listening...'); }
      }
    } else {
      utteranceFrames.push(copy);
      if (gate.voice) speechSilenceMs = 0; else speechSilenceMs += durationMs;
      // Barge-in path: while JARVIS is speaking, segment faster (350 ms) so a
      // "stop" reaches the recognizer sooner instead of talking over the user.
      // Normal listening keeps 650 ms so unhurried speech is never cut short.
      const bargeMode = hero.dataset.mode === 'SPEAKING' || hero.dataset.mode === 'INTERRUPTED';
      const silenceNeeded = bargeMode ? 350 : 650;
      if (utteranceFrames.reduce((count, frame) => count + frame.length, 0) >= sampleRate * 12) speechSilenceMs = Math.max(speechSilenceMs, silenceNeeded);
      if (speechSilenceMs >= silenceNeeded) finishSpeechUtterance(sampleRate);
    }
  }
  // PATH A wake event: a confirmed low-volume "Hey Jarvis" forces command
  // capture + TTS interruption DIRECTLY — never waits for the command gate.
  // Whisper text verification downstream still decides everything (a proposal
  // without a transcribed wake word executes nothing; echo/contamination
  // guards still apply). No fixed mute: the detector stays live throughout.
  function handleWakeEvent(wr, speakingNow, { barge = false } = {}) {
    wakeFireCount++;
    voiceLog('wake detector fired', `score ${wr.score.toFixed(2)} >= ${wr.threshold.toFixed(2)}${speakingNow ? ' (while speaking)' : ''}${barge ? ' [barge]' : ''} (#${wakeFireCount})`);
    if (speechActive) {
      voiceLog('wake detector', 'already capturing - wake words are inside the open utterance');
      // The VAD can open a few frames before Path A confirms the envelope (a
      // bare "Jarvis" is itself speech). Record the audio confirmation on the
      // OPEN utterance so a text reading of "Try" still has independent wake
      // evidence. Never record it while JARVIS is speaking without a barge:
      // that energy may be our own voice, not the user.
      if (pendingUtterance && !speakingNow) pendingUtterance.wakeHeardDuringCapture = true;
      return;
    }
    // Defense in depth: a speaking-time wake without the barge latch is our
    // own voice until proven otherwise — never interrupt or seed on it.
    if (speakingNow && !barge) { voiceLog('wake detector held', 'speaking without barge energy (own-voice guard)'); return; }
    // In-memory pre-roll so speech right after the wake phrase is not lost
    // while the command recognizer starts. Bounded, never stored or sent.
    const seed = [...wakeRing.slice(-10), ...preRollFrames].slice(-14);
    if (speakingNow) {
      // Interrupt via the EXISTING speech controller, then reseed (stopSpeech
      // flushes buffers synchronously, so seed saved above is restored after).
      // Bump the epoch so TTS-echo transcriptions already queued can never
      // execute as commands; the seeded utterance carries the new epoch.
      try { aiAbort?.abort(); aiAbort = null; } catch {}
      stopSpeech();
      voiceEpoch++;
      voiceLog('wake interrupt', 'TTS stopped by wake word - capturing command (echo transcriptions orphaned)');
    }
    speechActive = true; utteranceFrames = [...seed];
    speechSilenceMs = 0; speechCandidateMs = 0;
    pendingUtterance = { id: ++utteranceSeq, epoch: voiceEpoch, startedAt: Date.now(), endedAt: 0, wakeSeeded: true, bargeSeeded: Boolean(barge) };
    let seedSum = 0, seedN = 0;
    for (const f of utteranceFrames) { for (let i = 0; i < f.length; i++) seedSum += f[i] * f[i]; seedN += f.length; }
    const seedDb = 20 * Math.log10(Math.max(0.00001, Math.sqrt(seedSum / Math.max(1, seedN))));
    lastVadTrigger = { db: seedDb, noiseDb: 20 * Math.log10(Math.max(micNoise, 0.00001)) };
    setMode('LISTENING', speakingNow ? 'Yes — I am listening...' : 'Wake word heard - listening...');
  }
  function finishSpeechUtterance(sampleRate) {
    const frames = utteranceFrames; utteranceFrames = []; speechActive = false; speechSilenceMs = 0; speechCandidateMs = 0; preRollFrames = [];
    const meta = pendingUtterance || { id: ++utteranceSeq, epoch: voiceEpoch, startedAt: Date.now(), endedAt: 0 };
    pendingUtterance = null; meta.endedAt = Date.now();
    const length = frames.reduce((count, frame) => count + frame.length, 0);
    if (length < sampleRate * .24) { if (meta.ptt) voiceLog('push-to-talk recording discarded', `${Math.round(length * 1000 / sampleRate)} ms - too short to recognize`); return; }
    pipelineCounters.utterances++;
    // PIPELINE 2.0 audio-quality check: measured from the actual captured
    // samples (not estimated). Clipping, near-silence, and too-quiet audio
    // are reported instead of being sent blindly to the recognizer.
    let peak = 0, sum = 0, clipped = 0;
    for (const frame of frames) for (let i = 0; i < frame.length; i++) { const v = Math.abs(frame[i]); if (v > peak) peak = v; sum += frame[i] * frame[i]; if (v >= 0.99) clipped++; }
    const rms = Math.sqrt(sum / Math.max(1, length));
    const quality = Core.voiceAudioQuality ? Core.voiceAudioQuality({ peak, rms, clipRatio: clipped / Math.max(1, length), durationMs: length * 1000 / sampleRate }) : { flags: [], summary: 'signal-ok' };
    const track = micStream?.getAudioTracks?.()[0];
    meta.quality = quality; meta.peak = peak; meta.rms = rms; meta.captureRate = sampleRate;
    meta.micLabel = track?.label || 'selected input'; meta.micDeviceId = selectedMicDeviceId || 'system-default';
    lastVoiceEvidence = { ...lastVoiceEvidence, micLabel: meta.micLabel, micDeviceId: meta.micDeviceId, captureRate: sampleRate, channels: 1, vadState: 'utterance-captured', utteranceMs: Math.round(length * 1000 / sampleRate), peak, rms, clipRatio: clipped / Math.max(1, length), qualityFlags: quality.flags || [] };
    readout('#micFormatDiagnostic', `${meta.micLabel.slice(0, 40)} - 16 kHz mono PCM (from ${Math.round(sampleRate / 100) / 10} kHz capture)`);
    if ((quality.flags || []).length) voiceLog('audio quality warning', `${quality.summary} - peak ${peak.toFixed(2)}, rms ${rms.toFixed(4)}`);
    // ASR-DIAG 2026-10-14: verified against the live endpoint - whisper.cpp
    // transcribes digital silence into a confident, confident-sounding word
    // (pure silence returned "You" at 0.997 confidence), which the wake-word and
    // command path then treated as real speech. An open or muted input device
    // therefore produced phantom commands. Never send digital silence.
    if (peak < 0.006) { voiceLog('utterance discarded - digital silence', `peak ${peak.toFixed(5)}, rms ${rms.toFixed(6)}`); readout('#recognitionDiagnostic', 'LOCAL ASR - SILENCE, NOTHING TO TRANSCRIBE'); return; }
    let samples = new Float32Array(length); let offset = 0;
    for (const frame of frames) { samples.set(frame, offset); offset += frame.length; }
    // ASR-SPEED 2026-10-21: trim dead air at both ends before encoding. PTT
    // always prepends the rolling pre-roll and usually leaves a silent tail;
    // silence-heavy clips pushed whisper into 45 s+ decodes. The 0.008 floor
    // sits below the quality gate, and 150 ms of padding keeps every word.
    let speechStart = 0, speechEnd = samples.length - 1;
    while (speechStart < samples.length && Math.abs(samples[speechStart]) < 0.008) speechStart++;
    while (speechEnd > speechStart && Math.abs(samples[speechEnd]) < 0.008) speechEnd--;
    if (speechEnd > speechStart) {
      const pad = Math.round(sampleRate * .15);
      const from = Math.max(0, speechStart - pad), to = Math.min(samples.length, speechEnd + pad + 1);
      if (to - from < samples.length) {
        const trimmed = samples.slice(from, to);
        voiceLog('utterance trimmed', `${Math.round((samples.length - trimmed.length) * 1000 / sampleRate)} ms of edge silence removed`);
        samples = trimmed;
      }
    }
    // PTT floor: a recording under 0.8 s can never carry a full command, and
    // whisper-cli fast-fails (<50 ms) on some short real-speech clips: the
    // user then sees a hard engine error for what is really a too-brief hold.
    // Reject locally with an honest "hold longer" prompt - no request, no
    // error state. Wake-barge clips stay at the original 0.24 s floor so a
    // shouted "stop" still lands.
    if (meta.ptt && samples.length < sampleRate * 0.8) {
      voiceLog('push-to-talk recording discarded', `${Math.round(samples.length * 1000 / sampleRate)} ms - too short to carry a command`);
      readout('#recognitionDiagnostic', 'PTT - CLIP TOO SHORT - HOLD AND SPEAK');
      readout('#policyDiagnostic', 'CLARIFY - say it again, holding the key while you speak');
      if (recognitionEnabled) { setMode('LISTENING', 'Listening for "Jarvis"...'); updatePttButtonState(); }
      notify('I did not catch that. Hold the key (or the button) while you say the whole command, then release.');
      return;
    }
    scheduleAsr(samples, sampleRate, meta);
  }
  // ASR-PRIORITY 2026-10-21: one decode at a time, the newest capture wins,
  // and a push-to-talk or wake-word capture never waits behind ambient room
  // noise. The old promise chain kept every noise clip, so a command sat
  // behind a backlog of 12-second noise decodes (2-5 s each) and the HUD
  // stayed on "Push-to-talk released - transcribing your request..." for a
  // long time. Now: ambient work is dropped when a command is waiting or
  // when a newer capture replaced it, and only one job is ever in flight.
  function scheduleAsr(samples, sampleRate, meta) {
    const userInitiated = Boolean(meta && (meta.ptt || meta.wakeSeeded));
    if (asrPending) {
      const pendingUser = Boolean(asrPending.meta && (asrPending.meta.ptt || asrPending.meta.wakeSeeded));
      if (!userInitiated && pendingUser) { voiceLog('ambient capture dropped - a command is already waiting', `utterance #${meta && meta.id != null ? meta.id : '?'}`); return; }
      voiceLog('superseded capture dropped', `utterance #${asrPending.meta && asrPending.meta.id != null ? asrPending.meta.id : '?'} replaced by #${meta && meta.id != null ? meta.id : '?'}`);
    }
    asrPending = { samples, sampleRate, meta };
    drainAsrQueue();
  }
  function drainAsrQueue() {
    if (asrBusy || !asrPending) return;
    const job = asrPending; asrPending = null; asrBusy = true;
    transcribeLocalSpeech(job.samples, job.sampleRate, job.meta)
      .catch(error => handleAsrFailure(error, job.meta))
      .finally(() => { asrBusy = false; drainAsrQueue(); });
  }
  // A push-to-talk capture is never dropped because an unrelated wake event or
  // a spoken answer bumped the voice epoch while the decode was running: the
  // user pressed the key, so the command must still run. A real microphone
  // restart still invalidates it.
  function isStaleCapture(meta) {
    if (!meta || meta.epoch == null) return false;
    if (meta.epoch === voiceEpoch) return false;
    if (meta.ptt && meta.micEpoch != null && meta.micEpoch === micSessionEpoch) return false;
    return true;
  }
  function handleAsrFailure(error, meta) {
      // ASR-FIX 2026-10-14: staged reporting instead of one vague message.
      // The classifier names the failing stage (bridge unreachable, busy,
      // audio gate, model files, decode timeout, engine) and a consecutive
      // failure streak tells a one-off glitch from a wedged recognizer.
      // Recovery still returns to listening; the ERROR state stays truthful.
      // AMBIENT-CAPTURE 2026-10-21: standby hears room noise all the time.
      // Only a capture the user actually started may report a recognizer
      // problem: push-to-talk, a wake-word capture, or the follow-up window.
      // A failed noise decode used to put the HUD in ERROR and tell the user
      // to "hold the key" while they were simply not talking at all.
      const userInitiated = Boolean(meta && (meta.ptt || meta.wakeSeeded)) || Boolean(wakeArmedUntil && Date.now() < wakeArmedUntil);
      if (userInitiated) asrFailStreak++;
      pipelineCounters.asrFail++;
      const info = Core.asrFailureInfo ? Core.asrFailureInfo({ status: error && error.asrStatus, message: error && error.message }) : { stage: 'unknown', label: 'ERROR', hint: String((error && error.message) || '') };
      voiceLog('local speech recognition failed', `${info.stage} (#${asrFailStreak})${userInitiated ? '' : ' - ambient capture, not user-initiated'} - ${info.hint} - ${String((error && error.message) || '').slice(0, 120)}`);
      readout('#recognitionDiagnostic', `LOCAL ASR ${info.label} (#${asrFailStreak}) - ${String((error && error.message) || 'failed').slice(0, 90)}`);
      routeTelemetry('asr-fail', { reason: info.stage, stage: info.stage, hint: info.hint, transcript: String((error && error.message) || '').slice(0, 80), ptt: Boolean(error && error.pttRelease), stack: String((error && error.stack) || '').split(/[\r\n]+/).filter(Boolean).slice(0, 3).join(' | ').slice(0, 300) });
      // TEMP DIAGNOSTIC (2026-10-21): relay the exact caught error to the
      // bridge so desktop.log shows the true client-side throw behind
      // "faltered" notices. Fire-and-forget; never allowed to break recovery.
      try { fetch('/api/asr/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ when: new Date().toISOString(), stage: info.stage, streak: asrFailStreak, ptt: Boolean(meta && meta.ptt), page: location.href, error: String((error && (error.stack || error.message)) || error).slice(0, 2400) }) }).catch(() => {}); } catch { }
      lastVoiceEvidence = { ...lastVoiceEvidence, routing: `asr-failed (${info.stage})` };
      // ASR-DIAG 2026-10-14: a busy decoder (429) is a normal moment - the
      // queue drains itself and the next utterance decodes fine. Escalating it
      // to ERROR made the HUD claim "local speech recognition needs attention"
      // while the engine was in fact healthy, and the state stuck there.
      if (info.stage === 'busy') {
        asrFailStreak = 0;
        // When the release the user is waiting on gets crowded out by ambient
        // decodes (game/voice-chat audio keeps the engine hot) tell them the
        // command did not go through instead of leaving the HUD in THINKING.
        if (error && error.pttRelease && recognitionEnabled) {
          voiceLog('push-to-talk release lost to a busy engine', 'returning to listening');
          setMode('LISTENING', 'Listening for "Jarvis"...');
          notify('The recognizer was busy. Hold the key and say it again.');
        }
        return;
      }
      // GATE REJECT (the clip was refused on arrival) is an input problem, not
      // a broken engine: ask for a clean repeat instead of the scary ERROR.
      if (info.stage === 'audio' || /too short/i.test(String((error && error.message) || ''))) {
        asrFailStreak = 0;
        voiceLog('clip refused, asking for a repeat', info.hint);
        readout('#policyDiagnostic', 'CLARIFY - say it again, holding the key while you speak');
        if (recognitionEnabled && userInitiated) { setMode('LISTENING', 'Listening for "Jarvis"...'); notify(meta && meta.ptt ? 'The recording did not carry a clear command. Hold the key while you say it, then release.' : 'I did not catch that clearly. Please say it again.'); }
        return;
      }
      // ONE decode hiccup is not an outage: land softly, let the user simply
      // try again. Only a SECOND consecutive failure justifies the full
      // ERROR state and its recovery alarm.
      if (asrFailStreak < 2) {
        voiceLog('transcribe failed once - soft landing', info.hint);
        if (recognitionEnabled && userInitiated) { notify(meta && meta.ptt ? 'The recognizer faltered on that one - hold the key and say it again.' : 'The recognizer faltered on that one - please say it again.'); setMode('LISTENING', 'Listening for "Jarvis"...'); scheduleVoiceRecovery(); }
        return;
      }
      if (recognitionEnabled && userInitiated) { setMode('ERROR', 'Local speech recognition needs attention.'); scheduleVoiceRecovery(); }
      else if (recognitionEnabled) { voiceLog('ambient capture failed - recognizer state left alone', info.hint); setMode('LISTENING', 'Listening for "Jarvis"...'); }
  }
  function pcmWav(samples, sourceRate) {
    const targetRate = 16000, outputLength = Math.max(1, Math.floor(samples.length * targetRate / sourceRate));
    const buffer = new ArrayBuffer(44 + outputLength * 2), view = new DataView(buffer);
    const writeText = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
    writeText(0, 'RIFF'); view.setUint32(4, 36 + outputLength * 2, true); writeText(8, 'WAVE'); writeText(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); writeText(36, 'data'); view.setUint32(40, outputLength * 2, true);
    for (let i = 0; i < outputLength; i++) {
      const position = i * sourceRate / targetRate, left = Math.floor(position), mix = position - left;
      const sample = Math.max(-1, Math.min(1, samples[left] * (1 - mix) + (samples[Math.min(left + 1, samples.length - 1)] || 0) * mix));
      view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
    return buffer;
  }
  // Cheap bridge liveness probe for the dead-window self-heal: the desktop
  // host revives the local bridge after it dies, and /api/health answers as
  // soon as the fresh process is listening. Bounded to ~20 s so a release
  // never stalls for minutes waiting for a slow recovery cycle.
  async function waitForLocalBridgeHealth(maxMs = 20000) {
    const deadline = performance.now() + maxMs;
    while (performance.now() < deadline) {
      try { const r = await fetch('/api/health', { signal: AbortSignal.timeout(3000) }); if (r.ok) return true; } catch { /* still down */ }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return false;
  }
  // VOICE-REQUEST 2026-10-21: a low-confidence transcript is only worth
  // answering out loud when it looks like an attempt at a request. A standby
  // microphone records room noise all day and Whisper decodes that noise into
  // short social phrases ("Bye.", "Thank you.", "You") or repeated-word loops;
  // those used to make JARVIS apologise out loud at someone who never asked
  // anything. A pending question keeps short answers ("yes", "no") meaningful.
  const VOICE_REQUEST_WORDS = new Set(['open', 'close', 'play', 'pause', 'resume', 'stop', 'start', 'search', 'find', 'show', 'tell', 'set', 'turn', 'cancel', 'remind', 'reminder', 'alarm', 'volume', 'mute', 'unmute', 'what', 'who', 'when', 'where', 'why', 'how', 'which', 'weather', 'news', 'email', 'discord', 'youtube', 'google', 'roblox', 'frieren', 'magnetic', 'loverboy', 'spotify', 'timer', 'note', 'notes', 'add', 'make', 'give', 'read', 'send', 'call', 'help', 'skip', 'next', 'previous', 'brightness', 'screenshot', 'camera', 'screen', 'browser', 'tab', 'please', 'could', 'would', 'can', 'do', 'does', 'is', 'are', 'i', 'im', 'need', 'want', 'like', 'know', 'think', 'hungry', 'tired', 'bored', 'go', 'download', 'install', 'run', 'create', 'delete', 'move']);
  // "Open, open, open, open" is a decoder loop on noise, not a request.
  function isRepeatedLoop(text) {
    const words = String(text || '').toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length < 3) return false;
    const counts = new Map();
    for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
    let top = 0;
    for (const times of counts.values()) if (times > top) top = times;
    return top >= 3 && top / words.length >= 0.5;
  }
  function looksLikeVoiceRequest(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    // Mojibake and replacement characters are never a request.
    if (/[\uFFFD]/.test(raw) || /[^\x20-\x7E]/.test(raw)) return false;
    if (isRepeatedLoop(raw)) return false;
    const words = raw.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    if (words.some(word => VOICE_REQUEST_WORDS.has(word))) return true;
    return words.length >= 3;
  }
  async function transcribeLocalSpeech(samples, sampleRate, meta = {}) {if (!recognitionEnabled || micMuted) return;
    // Drop work queued before a newer command, barge-in, mute, or mic restart:
    // its audio belongs to a previous session and must never submit commands.
    if (isStaleCapture(meta)) { voiceLog('stale recognition result dropped', `utterance #${meta.id ?? '?'} from an earlier session`); if (meta && meta.ptt && recognitionEnabled) setMode('LISTENING', 'Listening for "Jarvis"...'); return; }
    // PUSH-TO-TALK: this utterance was recorded under an explicit hold-to-talk
    // press. The press replaces the wake word for routing (Core.decideVoiceAction
    // checks ctx.ptt); every echo, quality and clarification guard still runs.
    const pttSession = Boolean(meta.ptt);
    // PIPELINE 2.0: MIC -> QUALITY -> VAD -> CAPTURE -> RAW ASR -> NORMALIZE
    // -> CANDIDATES -> CONTEXTUAL CORRECTION -> INTENT/ENTITIES -> CONFIDENCE
    // -> ROUTER. Every stage is timed and the raw transcript is preserved.
    const t0 = performance.now();
    lastVoiceTimings = { qualityMs: 0, encodeMs: 0, asrMs: 0, correctMs: 0 };
    pipelineCounters.asrAttempts++;
    readout('#recognitionDiagnostic', 'LOCAL WHISPER - processing phrase');
    readout('#rawTranscriptDiagnostic', '-'); readout('#policyDiagnostic', 'transcribing...');
    const encodeStart = performance.now();
    const wavBody = pcmWav(samples, sampleRate);
    lastVoiceTimings.encodeMs = Math.round(performance.now() - encodeStart);
    // A click, cough or half-word can produce a clip shorter than the shared
    // WAV gate minimum. Posting it returned HTTP 400, which the failure path
    // then reported as a broken recognizer. Drop it here with an honest log
    // instead: no request, no error state, nothing to recover from.
    if (wavBody.byteLength < 1200) { voiceLog('utterance too short to transcribe', `${wavBody.byteLength} bytes`); readout('#recognitionDiagnostic', 'LOCAL ASR - UTTERANCE TOO SHORT'); return; }
    const asrStart = performance.now();
    let response, result = null;
    // TRANSIENT-FAILURE retry: the local bridge can be restarting (its desktop
    // host recreates it) or the decoder can hiccup once. A momentary failure
    // is retried fast instead of scaring the user with an error. Client-side
    // timeouts are NOT retried: the server may still be decoding, and
    // re-sending would pile onto its single decoding slot.
    let attempt = 0, lastError = null, networkDead = false, busyWait = false, lastStatus = 0;
    while (attempt < 3 || busyWait) {
      attempt++;
      if (attempt > 1) {
        // RELEASE-LATENCY 2026-10-21: while a release waits out an engine that
        // is mid-decode (ambient clips take ~1-3.5 s), poll fast. The old
        // 1.5 s / 5 s ladder turned a short wait into dead seconds the user
        // felt directly ("it takes so long"). A busy 429 polls every 0.8 s;
        // bridge-restart 503s keep their slower patience.
        const busyNow = lastStatus === 429 && pttSession;
        const delay = busyNow ? 800 : attempt === 2 ? 1500 : attempt <= 3 ? 5000 : 2000;
        voiceLog('transcribe retry', `${busyNow ? 'engine busy - polling 0.8 s' : `attempt ${attempt}/3`} - ${lastError ? `request failed (${lastError.name || 'network error'})` : 'decoder returned an error'}`);
        readout('#recognitionDiagnostic', busyNow ? `LOCAL ASR - ENGINE BUSY - YOUR CLIP IS NEXT IN LINE (poll ${Math.min(attempt, 6)}/6)` : attempt <= 3 ? `LOCAL ASR - RETRYING (${attempt}/3)` : `LOCAL ASR - BUSY - RETRYING (${Math.min(attempt, 6)}/6)`);
        if (busyNow) setMode('THINKING', 'The recognizer is busy - your release is next in line...');
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      lastError = null;
      try {
        response = await fetch('/api/asr/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wavBody, signal: AbortSignal.timeout(60000) });
        lastStatus = response.status;
      } catch (error) {
        lastError = error;
        if (error && error.name === 'TimeoutError') { response = null; break; }
        response = null;
        networkDead = true;
        continue;
      }
      result = await response.json().catch(() => ({}));
      if (response.ok && result.ok) break;
      // Retry the decode/restarting class of 503 (engine hiccup, bridge
      // mid-recycle); model-file 503s will fail identically, so keep the
      // remaining attempts for real transient trouble only.
      const transient = response.status === 503 && !/model|missing|restore/i.test(String(result.message || ''));
      if (transient && attempt < 3) continue;
      // A user's push-to-talk release must not evaporate because the engine
      // happened to be mid-decode of some other clip when it arrived. Wait it
      // out: ambient decodes finish in ~2 s, so a couple of bounded retries
      // recover the release. Ambient clips themselves keep the old behavior.
      if (response.status === 429 && pttSession && attempt < 6) { busyWait = true; voiceLog('engine busy - release waits', `attempt ${attempt}/6`); continue; }
      break;
    }
    if (!response) {
      const failed = lastError || new Error('No response.');
      // DEAD-WINDOW SELF-HEAL: the desktop host recreates a dead local bridge
      // on its own (slow) health-check cycle, so a release can land in a
      // window where nobody is listening - the request never reaches the
      // engine, the log stays empty, and the user just sees it fail. When the
      // loop exhausted specifically on network-class failures, wait briefly
      // for /api/health to answer, then re-send the same clip once instead of
      // failing the release. Epoch and mute are still re-checked below.
      if (networkDead) {
        readout('#recognitionDiagnostic', 'LOCAL ASR - BRIDGE RESTARTING - WAITING FOR THE HOST');
        voiceLog('transcribe failed on a dead bridge', 'waiting for the desktop host to bring it back');
        if (await waitForLocalBridgeHealth()) {
          voiceLog('bridge is back - resending the clip', 'dead-window self-heal');
          readout('#recognitionDiagnostic', 'LOCAL ASR - BRIDGE BACK - RESENDING');
          try {
            response = await fetch('/api/asr/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wavBody, signal: AbortSignal.timeout(60000) });
            result = await response.json().catch(() => ({}));
          } catch (error) {
            lastError = error;
            response = null;
            result = null;
          }
        }
      }
      if (!response) { readout('#recognitionDiagnostic', 'LOCAL WHISPER - REQUEST FAILED'); throw new Error(`Local recognition request failed: ${failed.message}`); }
    }
    lastVoiceTimings.asrMs = Math.round(performance.now() - asrStart);
    if (!recognitionEnabled || micMuted) return;if (isStaleCapture(meta)) { voiceLog('stale recognition result dropped', `utterance #${meta.id ?? '?'} superseded while transcribing`); routeTelemetry('stale-drop', { id: meta.id == null ? null : String(meta.id), epoch: `${meta.epoch}/${voiceEpoch}` }); if (meta && meta.ptt && recognitionEnabled) setMode('LISTENING', 'Listening for "Jarvis"...'); return; }if (!response.ok || !result.ok) { const failed = new Error(result.message || `Local recognition returned HTTP ${response.status}.`); failed.asrStatus = response.status; failed.pttRelease = pttSession; throw failed; }
    asrFailStreak = 0;
    pipelineCounters.asrOk++;
    const heard = String(result.transcript || '').trim();
    // Progress: the caption changes the moment the words are known, so a slow
    // answer never leaves the HUD frozen on "transcribing your request...".
    if (pttSession && heard) { setMode('THINKING', `Heard: "${heard.slice(0, 40)}" - working on it`); routeTelemetry('ptt-transcribed', { transcript: heard.slice(0, 80) }); }
    const asrConfidence = Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : null;
    const noSpeechProb = Number.isFinite(Number(result.noSpeechProb)) ? Number(result.noSpeechProb) : null;
    lastVoiceEvidence = { ...lastVoiceEvidence, rawTranscript: heard, asrConfidence, noSpeechProb: noSpeechProb ?? 0, vadState: 'transcribed', stageMs: { ...lastVoiceTimings } };
    readout('#rawTranscriptDiagnostic', heard ? heard.slice(0, 160) : '(empty)');
    readout('#recognitionDiagnostic', `LOCAL WHISPER base.en - ${lastVoiceTimings.asrMs} ms${asrConfidence != null ? ` - conf ${(asrConfidence * 100).toFixed(0)}%` : ''}${noSpeechProb != null && noSpeechProb > 0.5 ? ` - no-speech ${(noSpeechProb * 100).toFixed(0)}%` : ''}`);
    if (!heard) { readout('#recognitionDiagnostic', 'LOCAL WHISPER - no words matched'); voiceLog('speech not recognized', `Local English model - no-speech ${noSpeechProb != null ? (noSpeechProb * 100).toFixed(0) + '%' : 'n/a'}`); lastVoiceEvidence = { ...lastVoiceEvidence, policy: 'clarify', policyReason: 'empty transcript' }; readout('#policyDiagnostic', 'CLARIFY - empty transcript, please repeat'); return; }
    // Aggressive silence/noise filter: reject audio the recognizer is confident
    // contains no speech. Set higher than the historical 0.7 to filter out
    // more random noise and background capture while still passing real voice.
    if (noSpeechProb != null && noSpeechProb > 0.85) { voiceLog('no-speech audio ignored', `no-speech ${(noSpeechProb * 100).toFixed(0)}% - "${heard.slice(0, 80)}"`); readout('#policyDiagnostic', 'IGNORED - no speech detected in audio'); return; }
    // Also reject if quality flags indicate near-silence or too-quiet (measured
    // from actual captured samples before ASR).
    // WAKE-WORD 2026-10-14 FIX (root cause #2): the old order dropped
    // normal-volume "Jarvis" BEFORE checking the wake word: a distant but real
    // wake word often measures peak 0.01-0.03 (flagged too-quiet) and was
    // discarded without ever reaching the wake parser, forcing users to shout.
    // New order: probe the wake word FIRST; a real wake+command with low
    // no-speech probability is accepted despite quiet flags (logged as a
    // quiet-wake accept). Non-wake audio keeps the strict reject so TV and
    // room noise still cannot trigger commands.
    const qFlags = (meta.quality && meta.quality.flags) || [];
    // AUDIO WAKE EVIDENCE 2026-10-21: Path A (the ungated syllable detector)
    // either seeds this capture or confirms the envelope after the VAD already
    // opened it. When the transcriber then returns a bare "Try" (a known
    // mishearing of "Jarvis"), that independent audio evidence is what lets
    // the text layer trust it. Without this flag, a bare "try" stays ordinary
    // speech; command-shaped "try open ..." has its own guard in jarvis-core.
    const audioWakeEvidence = Boolean(meta && (meta.wakeSeeded || meta.wakeHeardDuringCapture));
    // The phantom guard is bypassed only for the guarded "try" mishearing, not
    // for every wake-seeded clip. A normal "Jarvis ..." transcript keeps the
    // existing clip-confidence floor, so Path A evidence cannot turn a weak,
    // possibly hallucinated command into an execution.
    const tryWakeEvidence = audioWakeEvidence && Core.parseTryWakeMishear
      ? Boolean(Core.parseTryWakeMishear(heard, { audioWake: true }))
      : false;
    // WAKE MISHEAR 2026-10-21: the wake probe runs on the DETERMINISTICALLY
    // CORRECTED text, so a wake word the recognizer misheard ("Travis",
    // "Drivis", "joy, vies") is recognized before the ignore gate drops the
    // utterance. The correction is pure and cheap; the full pass further
    // below recomputes the same result.
    const wakeCorrected = Core.voiceDeterministicCorrection ? (Core.voiceDeterministicCorrection(heard, { audioWake: audioWakeEvidence }).correctedTranscript || heard) : heard;
    const wakeProbeEarly = parseWake(wakeCorrected);
    // Optional openWakeWord early-hint: when the sidecar is present it can
    // boost a 0.6 anywhere-match to 0.9 for the early gate only. Null/absent
    // leaves the text decision unchanged (pipeline unchanged, reversible).
    const wakeEarly = (Core.wakeWordWithOwwScore && lastOwwScore != null)
      ? Core.wakeWordWithOwwScore(wakeProbeEarly, lastOwwScore, { now: Date.now(), lastAt: lastOwwAt })
      : { ...wakeProbeEarly, owwScore: lastOwwScore, owwBoosted: false };
    if (wakeEarly.owwBoosted) lastOwwAt = Date.now();
    const inFollowUpWindow = wakeArmedUntil && Date.now() < wakeArmedUntil;
    // Accept 0.9 start-matches as before; accept 0.6 anywhere-matches ONLY
    // with a real command AND low no-speech probability (guards against
    // Whisper hallucinating "jarvis" from noise). Bare mid-sentence
    // hallucinations without a command still need the follow-up window.
    const earlyConf = wakeEarly.confidence || 0;
    const earlyHasCommand = Boolean((wakeEarly.command || '').trim());
    const lowNoSpeech = noSpeechProb == null || noSpeechProb < 0.6;
    // PHANTOM GUARD 2026-10-21: the wake rules only judge the text, so a clip
    // whose ACTUAL transcription confidence is 0.40 ("Travis Hasidhi"), or 0.55
    // ("hey what is up joy vies"), still scored 0.9/0.6 internally and made
    // JARVIS say "Yes, Sir?" or answer with an AI reply nobody asked for. If
    // the text LOOKS like a wake word but the clip-level audio evidence is
    // weak, drop it with a trace - silence when nobody really spoke. PTT
    // releases, captures inside an open follow-up window (both user-initiated
    // or in-conversation) and oww audio-boosted matches keep the old rule.
    // FLOOR SPLIT 2026-10-21 evening: a REAL quiet "Hey Jarvis." measured 0.56
    // clip confidence and was dropped outright, leaving the user unacknowledged
    // while awake and waiting - the worst failure. So bare wake-acks (which
    // only ever say "Yes, Sir?" - the harm of a wrong ack is one prompt) use a
    // 0.50 floor, while commands that would EXECUTE keep the 0.74 floor
    // (phantoms there cost real side effects).
    // MODE WAKE RELIABILITY 2026-10-31: a bare name ("Karen") is much shorter
    // than "hey Jarvis", so Whisper's clip confidence for it is routinely below
    // the 0.50 bare-wake floor and the ack was dropped. An utterance that is
    // EXACTLY the active wake word (plus an optional hey/hi) is unambiguous
    // text, so it gets a lower floor. Audio-seeded bare wakes (the syllable
    // detector already confirmed the envelope) skip the floor entirely; a
    // command still needs the strict 0.74 floor.
    const wakeOnlyText = (() => {
      const clean = String(wakeCorrected || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
      const active = wakeName().toLowerCase();
      return clean === active || clean === `hey ${active}` || clean === `hi ${active}` || clean === `ok ${active}` || clean === `okay ${active}` || clean === `${active} wake up`;
    })();
    const wakeSeededBare = audioWakeEvidence && !earlyHasCommand;
    const phantomFloor = wakeOnlyText ? 0.32 : (earlyHasCommand && earlyConf >= 0.55) ? 0.74 : 0.50;
    const phantomWake = wakeEarly.activated && !pttSession && !inFollowUpWindow && !wakeEarly.owwBoosted && !tryWakeEvidence && !wakeSeededBare
      && asrConfidence != null && asrConfidence < phantomFloor;
    if (phantomWake) {
      voiceLog('phantom wake dropped', `clip ${Math.round(asrConfidence * 100)}% below the ${Math.round(phantomFloor * 100)}% floor - "${heard.slice(0, 80)}"`);
      routeTelemetry('phantom-drop', { transcript: heard.slice(0, 80), command: String(wakeEarly.command || '').slice(0, 60), reason: `wake-shaped text but only ${Math.round(asrConfidence * 100)}% clip confidence` });
      readout('#policyDiagnostic', 'IGNORED - sounded like "Jarvis" but was not a person');
      return;
    }
    const hasWakeWord = wakeEarly.activated && (earlyConf >= 0.65 || (earlyConf >= 0.55 && earlyHasCommand && lowNoSpeech));
    const quietFlags = qFlags.includes('near-silence') || qFlags.includes('too-quiet') || qFlags.includes('no-audio');
    if (quietFlags && !pttSession && !(hasWakeWord && lowNoSpeech)) {
      voiceLog('low-quality audio ignored', `flags: ${qFlags.join(', ')}`);
      readout('#policyDiagnostic', 'IGNORED - audio too quiet or silent');
      return;
    }
    if (quietFlags && hasWakeWord) voiceLog('quiet wake accepted', `flags: ${qFlags.join(', ')} - "${heard.slice(0, 80)}" - wake ${Math.round(earlyConf * 100)}%${wakeEarly.owwBoosted ? ' (oww-boosted)' : ''}`);

    // PATH B: text-based wake-word fallback (runs after Whisper transcription).
    // If a wake word is detected with sufficient confidence, immediately
    // interrupt TTS and arm the command-capture window. This path runs
    // AFTER Whisper transcription so it has the actual transcript.
    // It complements Path A (syllable detector) which runs on raw audio.
    if (hasWakeWord && !inFollowUpWindow && !pttSession) {
      // Only trigger if not already processing a command (voiceBusy guard
      // in handleWakeWordDetection prevents double-processing). NOTE: only
      // the RAW transcript exists here — the corrected finalHeard is computed
      // further below, so passing it here threw a TDZ ReferenceError that
      // killed every wake-word utterance after transcription (2026-10-14).
      const confidence = wakeEarly.confidence || 0;
      handleWakeWordDetection(wakeCorrected, confidence, 'text');
    }

    // VOICE REGRESSION FIX: Check wake word / follow-up window BEFORE running
    // confidence policy. Normal conversation without "Jarvis" and outside the
    // follow-up window must be silently ignored — never trigger an apology.
    // Minimum wake-word confidence uses the measured rule above (0.7, or 0.6
    // with command + low no-speech) to reject noise hallucinations without
    // forcing users to shout a leading "JARVIS!".
    // wakeProbeEarly/inFollowUpWindow/hasWakeWord computed above (order fix).
    if (!hasWakeWord && !inFollowUpWindow && !pttSession) {
      voiceLog('voice ignored - no wake word and not in follow-up window', heard);
      lastVoiceEvidence = { ...lastVoiceEvidence, routing: 'ignored (no-wake)', vadState: 'ignored-no-wake' };
      readout('#wakeDiagnostic', wakeHint());
      return;
    }

    voiceLog('local transcript', heard);
    // Contextual correction: cheap deterministic rules first (no AI call), one
    // Ollama pass only when it can materially help (moderate confidence with
    // a proper-noun candidate), validated JSON, raw fallback on any failure.
    const correctStart = performance.now();
    const det = Core.voiceDeterministicCorrection ? Core.voiceDeterministicCorrection(heard, { audioWake: audioWakeEvidence }) : { normalizedTranscript: Core.normalizeConversationText(heard), correctedTranscript: heard, candidates: [], applied: [], changed: false };
    voiceLog('normalized transcript', det.normalizedTranscript);
    // PTT 2026-10-23: a hold-to-talk release is deliberate audio, and the user
    // asked for it to be sent as heard. It never takes the extra AI
    // "re-transcribe my command" round-trip (up to 8 s of waiting that could
    // stall the whole turn); only the free deterministic correction runs.
    let ollamaFix = null, ollamaState = pttSession ? 'skipped-ptt' : 'skipped-fast-path';
    const looksAmbiguous = !pttSession && (det.changed || (asrConfidence != null && asrConfidence < 0.75 && /(?:open|play|search|find|watch|frieren|loverboy|roblox|magnetic|youtube)\b/i.test(heard)));
    if (looksAmbiguous && det.changed === false && asrConfidence != null && asrConfidence < 0.6) {
      // Single bounded Ollama correction for genuinely ambiguous transcripts.
      ollamaState = 'requesting';
      try { ollamaFix = await ollamaTranscriptFix(heard, det.normalizedTranscript); ollamaState = ollamaFix ? 'applied' : 'no-change'; }
      catch (error) { ollamaState = `unavailable (${String(error.message || error).slice(0, 60)})`; }
    } else if (det.changed) ollamaState = 'skipped-deterministic-fix';
    const verdict = Core.voiceCorrectTranscript ? Core.voiceCorrectTranscript(heard, { asrConfidence, noSpeechProb, qualityFlags: (meta.quality && meta.quality.flags) || [], ollama: ollamaFix, audioWake: audioWakeEvidence }) : { correctedTranscript: det.correctedTranscript, policy: 'proceed', policyReason: '', candidateAlternatives: [], appliedRules: [] };
    if (ollamaFix && ollamaFix.corrected && !det.changed) verdict.correctedTranscript = ollamaFix.corrected;
    lastVoiceTimings.correctMs = Math.round(performance.now() - correctStart);
    lastVoiceEvidence = { ...lastVoiceEvidence, normalizedTranscript: det.normalizedTranscript, correctedTranscript: verdict.correctedTranscript, candidates: verdict.candidateAlternatives || det.candidates || [], appliedRules: verdict.appliedRules || det.applied || [], policy: verdict.policy, policyReason: verdict.policyReason, ollama: ollamaState, stageMs: { ...lastVoiceTimings, totalMs: Math.round(performance.now() - t0) } };
    readout('#transcriptDiagnostic', String(verdict.correctedTranscript || '').slice(0, 160));
    readout('#policyDiagnostic', `${String(verdict.policy || 'proceed').toUpperCase()} - ${String(verdict.policyReason || '').slice(0, 90)}${ollamaState.startsWith('applied') ? ' - ollama' : ''}`);
    readout('#stageDiagnostic', `wav ${lastVoiceTimings.encodeMs}ms - asr ${lastVoiceTimings.asrMs}ms - fix ${lastVoiceTimings.correctMs}ms`);
    if ((verdict.appliedRules || []).length) voiceLog('transcript corrected', verdict.appliedRules.map(r => `${r.to} (${r.reason})`).join('; '));
    if (verdict.requiresClarification) {
      // PUSH-TO-TALK SEND-AS-HEARD (2026-10-25): a hold-to-talk release is
      // deliberate audio, so it must never be held in a "Could you repeat..."
      // loop or dropped in silence. Long general questions transcribe well
      // below the old 0.45 confidence floor, and under the old policy they
      // never reached the conversation - the whole reason PTT "does not work"
      // for non-command talk. The press itself authorizes the words: route
      // the release through the normal pipeline exactly like the live mic
      // (deterministic commands first, otherwise the AI answer). The
      // pure-noise filters in decideVoiceAction stay in force, so hiss and
      // filler never reach ask().
      if (pttSession) {
        voiceLog('ptt release sent as heard', `${verdict.policyReason} - "${heard.slice(0, 80)}"`);
        readout('#policyDiagnostic', 'PTT - SENT AS HEARD');
      } else {
        // VOICE-REQUEST 2026-10-21: noise captured inside the wake follow-up
        // window is not a request. Answering it with "I did not catch that"
        // blamed the user for something they never said, so it is dropped in
        // silence.
        const pendingAnswer = Boolean(pendingQuestion && !pendingQuestion.handled && Date.now() < pendingQuestion.expiresAt);
        if (!pttSession && !pendingAnswer && !looksLikeVoiceRequest(heard)) {
          voiceLog('ambient noise ignored - no request heard', `"${heard.slice(0, 60)}"`);
          readout('#policyDiagnostic', 'IGNORED - ambient noise, no request');
          lastVoiceEvidence = { ...lastVoiceEvidence, routing: 'ignored (ambient noise)', vadState: 'ignored-ambient' };
          return;
        }
        // Cooldown: prevent repeated apologies from stale or noise transcriptions.
        // Only one clarification per 5 seconds; subsequent ones are logged but not spoken.
        const now = Date.now();
        if (now - lastClarificationAt < 5000) {
          voiceLog('clarification cooldown active, skipping repeat apology', `last at ${lastClarificationAt}, now ${now}`);
          return;
        }
        lastClarificationAt = now;
        voiceLog('low-confidence transcript held for clarification', `${verdict.policyReason} - raw: "${heard.slice(0, 80)}"`);
        readout('#wakeDiagnostic', 'UNCERTAIN - please repeat the name or command');
        // Never quote noise back at the user; ask for the command itself.
        const quote = looksLikeVoiceRequest(heard) && heard.length <= 40 ? `"${heard}"` : 'the last command';
        speak(`Sorry, Sir, I did not catch that clearly. Could you repeat ${quote}?`, ++assistantTurn, false);
        return;
      }
    }
    const finalHeard = String(verdict.correctedTranscript || heard).trim() || heard;
    // Diagnostics: the wake parser reports a rough confidence (0.6-1.0) and
    // the recognized command (if any) so the panel can show exactly what the
    // voice pipeline understood from this utterance.
    const wakeProbe = parseWake(finalHeard, { audioWake: audioWakeEvidence });
    const wakeConfidence = wakeProbe.activated ? Math.round(wakeProbe.confidence * 100) : 0;
    readout('#wakeDiagnostic', wakeProbe.activated
      ? `MATCHED "${wakeProbe.match}" - ${wakeConfidence}%${wakeProbe.command ? ` - COMMAND: ${wakeProbe.command.slice(0, 60)}` : ' - NO COMMAND'}`
      : pttSession ? `PUSH-TO-TALK - heard: ${finalHeard.slice(0, 60)}` : wakeArmedUntil && Date.now() < wakeArmedUntil ? `FOLLOW-UP WINDOW ACTIVE - heard: ${finalHeard.slice(0, 60)}` : 'Say "Jarvis" before your request');
    // Intent/entities preview for diagnostics (routing itself is unchanged).
    try {
      const cmd = (wakeProbe.command || finalHeard).replace(/^(?:hey\s+)?jarvis[\s,:-]*/i, '').trim();
      const siteSearch = Core.parseSiteSearchIntent ? Core.parseSiteSearchIntent(cmd) : null;
      const site = Core.parseWebsiteIntent ? Core.parseWebsiteIntent(cmd) : null;
      const music = Core.parseMusicIntent ? Core.parseMusicIntent(cmd) : null;
      const search = Core.parseSearchCommand ? Core.parseSearchCommand(cmd) : null;
      const found = siteSearch || site || music || search;
      lastVoiceEvidence = { ...lastVoiceEvidence, intent: found ? (siteSearch ? `site-search:${siteSearch.site}` : site ? `open-site:${site.site}` : music ? `music:${music.kind}` : 'web-search') : 'conversational', entities: found ? (siteSearch?.query || site?.site || music?.query || search || '').toString().slice(0, 80) : '-' };
      readout('#intentDiagnostic', `${lastVoiceEvidence.intent}${lastVoiceEvidence.entities && lastVoiceEvidence.entities !== '-' ? ` - ${lastVoiceEvidence.entities}` : ''}`);
    } catch { readout('#intentDiagnostic', '-'); }
    processWakeTranscript(finalHeard, meta);
    // CAPTION GUARD (2026-10-25): when the transcript was just accepted into
    // ask(), its 'Heard: ... - working on it...' caption is the honest live
    // status of the running turn - the old unconditional reset clobbered it
    // the same tick, so every running command looked like an idle HUD. All
    // other exits (ignored/failed/clarify) already set their own caption, so
    // the standby reset only runs for genuine no-turn endings.
    const routedRecently = voiceSessionAccepted.routing === finalHeard && Date.now() - voiceSessionAccepted.at < 3000;
    if (!routedRecently && recognitionEnabled && hero.dataset.mode !== 'SPEAKING' && hero.dataset.mode !== 'THINKING' && hero.dataset.mode !== 'SEARCHING' && hero.dataset.mode !== 'EXECUTING') setMode('LISTENING', 'Listening for "Jarvis"...');
  }
  // Single bounded Ollama transcript fix. Returns {corrected} or null.
  // Validated JSON only; any failure returns null so voice falls back to raw.
  async function ollamaTranscriptFix(raw, normalized) {
    const model = $('#aiModel')?.value || localStorage.getItem('jarvis-ai-model') || '';
    if (!model) return null;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const prompt = `Fix likely speech-recognition errors in this English voice transcript. Reply with JSON only: {"corrected": "...", "reason": "..."}. Rules: only fix obvious mishearings supported by the text (proper nouns, homophones); never add commands, names, dates, or recipients not hinted by the audio; if unsure, return the input unchanged. Transcript: ${JSON.stringify(raw)}`;
      const response = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], budget: 0 }), signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      const text = String(data.response || data.message || '').trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]);
      const corrected = String(parsed.corrected || '').trim().slice(0, 500);
      if (!corrected || corrected.toLowerCase() === String(raw).toLowerCase()) return null;
      // Safety: Ollama may not add words (beyond casing/punctuation) or flip negation.
      const rawWords = String(raw).toLowerCase().split(/\s+/).filter(Boolean);
      const fixWords = corrected.toLowerCase().split(/\s+/).filter(Boolean);
      if (fixWords.length > rawWords.length + 3) return null;
      if (/\bnot\b|\bnever\b|\bno\b|\bdon't\b/.test(String(raw).toLowerCase()) !== /\bnot\b|\bnever\b|\bno\b|\bdon't\b/.test(corrected.toLowerCase())) return null;
      return { corrected, reason: String(parsed.reason || '').slice(0, 160) };
    } catch { return null; }
    finally { clearTimeout(timer); }
  }
  // ROUTE EVIDENCE: client-side routing decisions currently reach only the
  // in-page diagnostics panel, so desktop.log can never say WHY a spoken
  // command did not execute - which is exactly how "the recognizer is broken"
  // turns out to be an invisible drop. One throttled (15 s per event/reason),
  // capped, fire-and-forget line per decision to the local bridge.
  const routeTelemetryState = { last: {} };
  function routeTelemetry(event, fields = {}) {
    try {
      const key = `${event}:${fields.reason || fields.stage || ''}`;
      const now = Date.now();
      if (routeTelemetryState.last[key] && now - routeTelemetryState.last[key] < 15000) return;
      routeTelemetryState.last[key] = now;
      fetch('/api/voice/route-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, at: now, mode: hero && hero.dataset ? hero.dataset.mode : '', ptt: Boolean(fields.ptt), reason: fields.reason || null, transcript: fields.transcript || null, command: fields.command || null, id: fields.id || null, epoch: fields.epoch || null, wait: fields.wait == null ? null : Number(fields.wait), kind: fields.kind || null, ms: fields.ms == null ? null : Number(fields.ms), provider: fields.provider || null }) }).catch(() => { });
    } catch { }
  }
  function processWakeTranscript(heard, meta = {}) {
    const now = Date.now();
    const mode = hero.dataset.mode;
    const wake = parseWake(heard, { audioWake: Boolean(meta.wakeSeeded) });if (wake.activated) activatedAt = now;
    const speakingNow = mode === 'SPEAKING' || mode === 'INTERRUPTED';
    // Echo verdicts come from the actual playback lifecycle: what is playing
    // right now versus what finished recently. Either one matching means this
    // transcript is our own voice coming back through the microphone.
    const echoCurrent = Core.isEchoTranscript(heard, currentSpeechText, { speaking: speakingNow, lastSpokenAt, windowMs: Core.ECHO_WINDOW_MS || 10000 });
    // Mode follow-up answers ("Roblox") are short by design and may share a
    // word with the just-spoken question ("Roblox, something else?"). While a
    // mode question is pending, a short uncontaminated reply that STARTED
    // well after playback ended is the USER, not an echo — exempt it from
    // the *recent* verdict only (live-playback echo above still blocks).
    // Own TTS tails arrive inside the post-playback blackout and stay
    // blocked, which is what breaks self-trigger loops. Logged either way.
    const pendingActive = pendingQuestion && !pendingQuestion.handled && Date.now() < pendingQuestion.expiresAt;
    const shortReply = heard.split(/\s+/).filter(Boolean).length <= 4;
    const overlapsPlayback = Core.utteranceOverlapsPlayback(
      { startedAt: meta.startedAt || now, endedAt: meta.endedAt || now },
      { ttsStartedAt, ttsEndedAt });
    const modeAnswerExempt = pendingActive && shortReply && !overlapsPlayback
      && Core.echoExemptAllowed ? Core.echoExemptAllowed({ pendingActive: Boolean(pendingActive), words: heard.split(/\s+/).filter(Boolean).length, contaminated: overlapsPlayback, startedAt: meta.startedAt || now, ttsEndedAt }) : false;
    const echoRecent = !echoCurrent && !modeAnswerExempt && Core.isEchoTranscript(heard, lastSpokenText, { speaking: speakingNow, lastSpokenAt, windowMs: Core.ECHO_WINDOW_MS || 10000 });
    if (modeAnswerExempt) voiceLog('mode answer echo-exempt', `"${heard.slice(0, 60)}" - pending ${pendingQuestion.mode}/${pendingQuestion.expected}`);
    else if (pendingActive && shortReply && !overlapsPlayback) voiceLog('mode answer echo-blocked', `"${heard.slice(0, 60)}" - inside post-TTS blackout (own-tail guard)`);
    // The same utterance arriving twice within 2.5 s (duplicate transcription
    // event) must execute only once. Short answers ("sure", "yes") count too:
    // the old >8-character floor let a duplicated one-word reply produce two
    // separate responses. Stop-barge utterances never reach this point.
    const duplicate = heard.length >= 3 && lastHandledTranscript.text === heard && now - lastHandledTranscript.at < 2500;
    // Audio captured while our own voice was playing can never use the
    // no-wake-word window and must carry a real wake word (see core).
    const contaminated = Core.utteranceOverlapsPlayback(
      { startedAt: meta.startedAt || now, endedAt: meta.endedAt || now },
      { ttsStartedAt, ttsEndedAt });
    const decision = Core.decideVoiceAction(heard, {
      mode, wake, now,
      wakeArmed: wakeArmedUntil && now < wakeArmedUntil,
      contaminated, busy: voiceBusy, duplicate, echoCurrent, echoRecent, lastAckAt, ptt: Boolean(meta.ptt)
    });if (decision.action === 'ignore') { voiceLog(`voice ignored - ${decision.reason}`, heard); routeTelemetry('ignored', { reason: decision.reason, transcript: heard, ptt: Boolean(meta.ptt) }); lastVoiceEvidence = { ...lastVoiceEvidence, routing: `ignored (${decision.reason})` };
      // PTT 2026-10-23: the release caption already put the HUD in THINKING.
      // An ignored release that simply returns left it there for good ("it is
      // loading forever"). A press always ends its own turn with real words.
      if (meta.ptt) setMode(recognitionEnabled ? 'LISTENING' : 'IDLE', recognitionEnabled ? `Not sent (${decision.reason}) - hold the key and say it again.` : `Not sent (${decision.reason}).`);
      return; }if (decision.action === 'stop-barge') {
      // A short stop phrase while speaking cuts playback at once. The decision
      // already excluded our own words, so this is the user barging in.
      // "Stop the music" and "stop the alarm" are EXCLUDED on purpose: they
      // name a different target and must not kill JARVIS's speech.
      assistantTurn++; aiAbort?.abort(); aiAbort = null; stopSpeech(); addMessage('YOU', heard); voiceLog('speech interrupted by stop command', heard); routeTelemetry('stop-barge', { transcript: heard, ptt: Boolean(meta.ptt) });
      setMode(recognitionEnabled ? 'LISTENING' : 'IDLE', recognitionEnabled ? 'Stopped. I am listening for "Jarvis"...' : 'Speech stopped.'); return;
    }
    lastHandledTranscript = { text: heard, at: now };
    wakeArmedUntil = 0;if (decision.action === 'ack') {
      addMessage('YOU', heard);
      voiceLog('wake phrase heard', wakeName());
      routeTelemetry('ack', { transcript: heard, ptt: Boolean(meta.ptt) });
      lastAckAt = now;
      if (hero.dataset.mode === 'SPEAKING') stopSpeech();
      // After the "Yes, Sir?" prompt, a follow-up window lets a plain spoken
      // reply ("what about tomorrow?") through without the wake word. The
      // window arms only after the prompt FINISHES playing (speak().onended):
      // arming immediately opened a window during playback, so JARVIS
      // transcribed its own words and answered itself (echo loop).
      const turn = ++assistantTurn; setMode('LISTENING', 'Yes, Sir? I am listening.');
      const ackTone = companionTone('ack');
      speak('Yes, Sir?', turn, true, ackTone.emotion, ackTone.intensity);
      setVoiceSession({ status: 'awaiting-command', wakeDetectedAt: now, conversationActive: true, waitingFor: 'command', pendingKind: '', lastQuestion: '', expiresAt: 0 }, 'wake-acknowledged');
      return;
    }if (decision.action === 'interrupt') { interruptForRecognizedSpeech(decision.command, heard); return; }
    voiceLog(decision.bargedIn ? 'voice command accepted - barge-in with wake word' : 'voice command accepted - Jarvis wake phrase', `${decision.command}${lastVadTrigger ? ` - in ${lastVadTrigger.db.toFixed(0)} dB over ${lastVadTrigger.noiseDb.toFixed(0)} dB ambient` : ''}`);
      routeTelemetry('accepted', { command: decision.command, transcript: heard, ptt: Boolean(meta.ptt), wait: meta && meta.endedAt ? Math.max(0, Date.now() - meta.endedAt) : null });
    lastVoiceEvidence = { ...lastVoiceEvidence, routing: `accepted -> ${String(decision.command || '').slice(0, 80)}` };
    voiceSessionAccepted = { routing: heard, at: now };
    setVoiceSession({ status: 'thinking', conversationActive: true }, 'command-accepted');
    // PTT releases are submitted as 'ptt' so ask() always preempts the previous
    // turn and never drops the deliberate line on a busy slot.
    ask(decision.command, heard, meta.ptt ? 'ptt' : 'voice');
  }
  function monitorMicrophone() {if (!micAnalyser || !micStream) return;
    // PLAYBACK WATCHDOG 2026-10-14: SPEAKING with no active TTS and no audio
    // element means playback ended without its completion event (or was
    // released out of band). Recover to listening instead of sticking in
    // SPEAKING forever. Genuine playback (ttsActive or live element) is
    // untouched, so this cannot cut real speech short.
    if (hero.dataset.mode === 'SPEAKING' && !ttsActive && !speechAudio && recognitionEnabled) {
      const nowMs = Date.now();
      if (nowMs - (monitorMicrophone._lastSpeakFix || 0) > 5000) {
        monitorMicrophone._lastSpeakFix = nowMs;
        voiceLog('playback watchdog', 'SPEAKING with no audio - resuming listening');
        setMode('LISTENING', 'Listening for "Jarvis"...');
        readout('#wakeDiagnostic', wakeHint());
      }
    }
    // WAKE-WORD 2026-10-14: health check without restarting loops blindly.
    // A dead track or ended stream surfaces once in diagnostics; recovery is
    // debounced in the track.onended handler and devicechange listener below.
    // 2026-10-14: the dead-stream episode is voice-logged (once per episode)
    // with a timestamp, and one restart is attempted while listening is
    // supposed to be on — previously the UI kept saying LISTENING while
    // capture was silently dead.
    if (!micStream.active) {
      readout('#micDiagnostic', 'STREAM ENDED - check the mic connection or pick another device');
      const nowMs = Date.now();
      if (nowMs - (monitorMicrophone._lastDeadLog || 0) > 10000) {
        monitorMicrophone._lastDeadLog = nowMs;
        voiceLog('mic stream dead while listening', `recognitionEnabled=${recognitionEnabled} muted=${micMuted} - restart attempted`);
      }
      if (recognitionEnabled && !micMuted && !micStarting && nowMs - lastMicRecoveryAt > 5000) {
        lastMicRecoveryAt = nowMs;
        voiceLog('mic recovery', 'dead stream detected by monitor - restarting once');
        stopMicrophoneMonitor();
        setTimeout(() => { if (recognitionEnabled && !micMuted) startMicrophoneMonitor().then(() => voiceLog('mic recovery', 'monitor restart succeeded')).catch(e => voiceLog('mic recovery failed', e.message)); }, 1200);
      }
      return;
    }
    try {
      const t = micStream.getAudioTracks?.()[0];
      if (t && t.readyState === 'ended') { readout('#micDiagnostic', 'DEVICE ENDED - reconnect the mic or pick another device'); return; }
    } catch {}
    micAnalyser.getByteTimeDomainData(micSamples); let energy = 0;
    for (const value of micSamples) { const sample = (value - 128) / 128; energy += sample * sample; }
    const level = Math.sqrt(energy / micSamples.length);
    const visualLevel = Math.sqrt(Math.max(0, Math.min(1, (level - micNoise) * 24)));
    hero.style.setProperty('--mic-level', visualLevel.toFixed(3));
    updateCoreVoiceVisual(visualLevel);
    hero.style.setProperty('--core-ring-opacity', (0.42 + visualLevel * 0.5).toFixed(3));
    hero.style.setProperty('--core-ring-scale', (1 + visualLevel * 0.075).toFixed(3));
    hero.style.setProperty('--core-ring-glow', `${3 + visualLevel * 15}px`);
    const meter = $('#micMeter'); if (meter) meter.style.transform = `scaleX(${Math.max(0.04, visualLevel)})`;
  }
  function stopMicrophoneMonitor() {
    clearInterval(micFrame); micAnalyser = null; micSamples = null; micStarting = false;
    wakeRing = []; try { wakeSyllableDetector?.reset(); } catch {}
    // The stream identity changes: orphan anything transcribed from it so a
    // device switch can never submit stale audio as a command.
    voiceEpoch++; micSessionEpoch++; pendingUtterance = null;if (audioProcessor) { audioProcessor.onaudioprocess = null; try { audioProcessor.disconnect(); } catch {} audioProcessor = null; }if (micBoostNode) { try { micBoostNode.disconnect(); } catch {} micBoostNode = null; }if (micHighPassNode) { try { micHighPassNode.disconnect(); } catch {} micHighPassNode = null; }if (micLowPassNode) { try { micLowPassNode.disconnect(); } catch {} micLowPassNode = null; }if (mutedCaptureGain) { try { mutedCaptureGain.disconnect(); } catch {} mutedCaptureGain = null; }
    preRollFrames = []; utteranceFrames = []; speechActive = false; speechSilenceMs = 0; speechCandidateMs = 0;if (micStream) { micStream.getTracks().forEach(track => track.stop()); micStream = null; }
    coreVoiceEnvelope = 0; hero.classList.remove('voice-active'); hero.style.setProperty('--mic-level', '0'); hero.style.setProperty('--core-ring-opacity', '0.42'); hero.style.setProperty('--core-ring-scale', '1'); hero.style.setProperty('--core-ring-glow', '3px'); const meter = $('#micMeter'); if (meter) meter.style.transform = 'scaleX(.04)';
  }
  async function refreshAudioDevices() {
    const input = $('#audioInputDevice'), output = $('#audioOutputDevice');if (!navigator.mediaDevices?.enumerateDevices || !input || !output) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const fill = (select, kind, label, preferred) => {
        const available = devices.filter(device => device.kind === kind && device.deviceId && device.deviceId !== 'default');
        select.replaceChildren(new Option(label, ''));
        for (const [index, device] of available.entries()) select.add(new Option(device.label || `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${index + 1}`, device.deviceId));
        const exists = available.some(device => device.deviceId === preferred);
        select.value = exists ? preferred : '';
        return exists;
      };
      if (!fill(input, 'audioinput', 'System default microphone', selectedMicDeviceId)) {
        selectedMicDeviceId = ''; localStorage.removeItem('jarvis-audio-input');
      }
      if (!fill(output, 'audiooutput', 'System default output', selectedOutputDeviceId)) {
        selectedOutputDeviceId = ''; localStorage.removeItem('jarvis-audio-output');
      }
      const outputSupported = typeof AudioContext !== 'undefined' && typeof AudioContext.prototype.setSinkId === 'function';
      $('#chooseAudioOutput').disabled = !navigator.mediaDevices.selectAudioOutput || !outputSupported;
      output.disabled = !outputSupported;
      readout('#audioDeviceStatus', `${devices.filter(device => device.kind === 'audioinput').length} microphone(s) - ${devices.filter(device => device.kind === 'audiooutput').length} output(s) - local Whisper uses the selected mic.`);
    } catch (error) {
      readout('#audioDeviceStatus', `Could not list audio devices: ${error.message}`);
    }
  }
  async function applyAudioOutput() {if (!audioContext) {
      readout('#audioDeviceStatus', selectedOutputDeviceId ? "Speaker saved; it will be used for JARVIS's next spoken reply." : 'JARVIS replies use the system default output.');
      return true;
    }if (typeof audioContext.setSinkId !== 'function') {
      readout('#audioDeviceStatus', 'This Edge version cannot route JARVIS replies to a selected speaker.');
      return false;
    }
    try {
      await audioContext.setSinkId(selectedOutputDeviceId || '');
      readout('#audioDeviceStatus', selectedOutputDeviceId ? 'JARVIS replies routed to the selected speaker.' : 'JARVIS replies routed to the system default output.');
      return true;
    } catch (error) {
      readout('#audioDeviceStatus', `Could not select that speaker: ${error.message}`);
      return false;
    }
  }
  function interruptForRecognizedSpeech(transcript, displayText = transcript) {
    assistantTurn++; aiAbort?.abort(); aiAbort = null; stopSpeech();
    voiceLog('speech interrupted by recognized words', transcript);
    setMode('INTERRUPTED', 'I heard you. Switching to your request...');
    setVoiceSession({ status: 'thinking', conversationActive: true }, 'barge-in');
    ask(transcript, displayText, 'barge');
  }
  // PUSH-TO-TALK GLOBAL HOTKEY (2026-10-21). The desktop host owns a
  // system-wide keyboard hook, so the push-to-talk key keeps working while
  // another application has focus - the in-page key handler only ever saw
  // key events when the JARVIS window itself was focused. The host posts the
  // press/release to the bridge and this page picks the event up here; the
  // in-page handler stays as the fallback when the host cannot install its
  // hook. Start and end are idempotent, so both paths may fire.
  let pttEventTimer = null; let lastPttEventId = 0; let lastHostEventId = 0; let lastLocalPttKeyAt = 0; let pttChannelMissing = false; let pttEventSource = null;
  // AUTO-START GUARD (2026-10-21). The hotkey channels keep the last event
  // around, so a page that starts listening later could replay an old press
  // and open a recording that nobody asked for - push-to-talk switched itself
  // on the moment the app was opened. Only an event that is genuinely fresh
  // may open a recording; an older one is dropped and logged.
  const PTT_EVENT_MAX_AGE_MS = 2500;
  // The moment this page began listening for global hotkey events. A press
  // that was recorded BEFORE this instant belongs to an earlier session and
  // must never open a recording here, no matter how recent it looks.
  let pttListeningSince = 0;
  function pttEventIsFresh(event) {
    const at = Number((event && event.at) || 0);
    if (!at) return false;
    const age = Date.now() - at;
    if (age < 0 || age > PTT_EVENT_MAX_AGE_MS) return false;
    // A press published before this window started listening is not a press
    // the user made for THIS session.
    if (pttListeningSince && at < pttListeningSince) return false;
    return true;
  }
  // HOLD WATCHDOG (2026-10-22). A press whose release never reaches the page
  // (a hidden window is throttled by Edge, the page was reloaded mid-hold, the
  // stream dropped) left pttCtl.holding open forever, and every later press hit
  // the "already holding" guard and was silently ignored - which is exactly
  // "push-to-talk worked once and now it just doesn't". A hold that stays open
  // past this window is finalized here, so the channel always recovers on its
  // own without a reload.
  const PTT_HOLD_WATCHDOG_MS = 20000;
  let pttHoldWatchdog = null;
  function armPttHoldWatchdog() {
    try { clearTimeout(pttHoldWatchdog); } catch {}
    pttHoldWatchdog = setTimeout(() => {
      // Only a hold that is genuinely old is finalized: a stale timer that
      // fires during a younger, healthy hold must never cut that hold short.
      if (!pttCtl.holding || Date.now() - pttCtl.startedAt < PTT_HOLD_WATCHDOG_MS) return;
      voiceLog('push-to-talk hold watchdog', 'no release ever arrived - finalizing the hold so the next press works');
      routeTelemetry('ptt-hold-timeout', {});
      endPushToTalk();
    }, PTT_HOLD_WATCHDOG_MS);
  }
  // The desktop host serves the push-to-talk channel on its own port and puts
  // that port in the window URL. It is independent of server.js on purpose:
  // a rollback of the bridge must never be able to break push-to-talk.
  function pttChannelPort() {
    try {
      const value = new URLSearchParams(String(location.search || '')).get('pttport');
      const port = Number(value || 0);
      return port > 0 && port < 65536 ? port : 0;
    } catch { return 0; }
  }
  function syncPttKeyToBridge() {
    const key = pttKeyFromSettings();
    fetch('/api/ptt/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }).catch(() => { });
    // The desktop host owns the system-wide hook, so it needs the key too.
    const port = pttChannelPort();
    if (port) fetch('http://127.0.0.1:' + port + '/ptt/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }).catch(() => { });
  }
  function applyGlobalPttEvent(event, source) {
    const id = Number(event.id || 0);
    if (!id) return;
    if (source === 'host') { if (id === lastHostEventId) return; lastHostEventId = id; }
    else { if (id === lastPttEventId) return; lastPttEventId = id; }
    const code = String(event.code || '').toUpperCase();
    if (code && code !== pttKeyFromSettings()) return;
    // A RELEASE IS NEVER DROPPED (2026-10-22). The freshness gate below exists
    // so a stale PRESS can never open a recording by itself - it must never
    // apply to the release. The JARVIS window is often hidden (the host moves a
    // minimized window to the tray), and Edge throttles a hidden page, so the
    // release can arrive several seconds after the press. The old code called
    // it stale, dropped it, and left the hold open forever, after which every
    // later press was ignored. A release is only meaningful while a hold is
    // open, so it is always honoured.
    if (event.action !== 'release' && !pttEventIsFresh(event)) { voiceLog('push-to-talk event ignored', `stale ${code || 'hotkey'} ${event.action || 'event'} - the key was pressed before this window started listening`); return; }
    // The in-window key handler already ran for this key press: the global
    // hook sees the same key, and acting on both would start a second
    // recording a moment after the first one finished.
    if (Date.now() - lastLocalPttKeyAt < 500) return;
    if (event.action === 'press') {
      // A press while a hold is already open means the earlier release was
      // lost. Close the dead hold and record this press instead of silently
      // doing nothing - that silent ignore is what wedged push-to-talk.
      if (pttCtl.holding) {
        voiceLog('push-to-talk press during an open hold', 'the release was lost - closing the old hold and recording this press');
        routeTelemetry('ptt-hold-selfheal', {});
        abortPushToTalk('a fresh press arrived while the previous hold never released');
      }
      voiceLog('push-to-talk pressed (system hotkey)', code || pttKeyFromSettings());
      routeTelemetry('global-hotkey', { transcript: code || pttKeyFromSettings() });
      startPushToTalk('global-hotkey');
      armPttHoldWatchdog();
    } else if (event.action === 'release') {
      if (!pttCtl.holding) return;
      voiceLog('push-to-talk released (system hotkey)', code || pttKeyFromSettings());
      routeTelemetry('global-hotkey-release', { transcript: code || pttKeyFromSettings() });
      endPushToTalk();
    }
  }
  function startGlobalPttWatcher() {
    // IDEMPOTENT, AND CHECKED FIRST (2026-10-22). This used to run
    // syncPttKeyToBridge() and then bail only when BOTH the poll timer and the
    // stream were alive. openPttStream() nulls pttEventSource while it
    // reconnects, so any second call into this function during a reconnect -
    // a mic retry, a wake-word restart - passed the guard and opened a SECOND
    // EventSource. The old source's handlers then fired against the new one,
    // closing and reopening it, and the host saw a stream that never settled
    // (the desktop log shows seven re-opens in eight minutes). Every re-open
    // dropped whatever the host was pushing, which is why the hotkey pressed
    // from another application stopped reaching the page at all. The watcher
    // is owned by the poll timer: one watcher, started once.
    if (pttEventTimer) return;
    syncPttKeyToBridge();
    // Everything published before this moment belongs to a previous session.
    if (!pttListeningSince) pttListeningSince = Date.now();
    // PUSH CHANNEL FIRST: a minimized or backgrounded window throttles the
    // page's timers, so a polled press can arrive long after the key was
    // released and the recording is already over. The host pushes the event
    // the moment the key is pressed.
    const port = pttChannelPort();
    if (port) {
      try {
        // The dedicated app window (its URL carries the channel port) is the
        // primary page. A tab the user opened in their own browser is not, and
        // is told to stand down so only one JARVIS ever listens.
        // The claim lives in sessionStorage, which belongs to ONE tab: the
        // app window claims it on load and keeps it across an F5. localStorage
        // must never be used here - it is shared by every tab of the profile,
        // so a browser tab restored at boot could claim the app-window title
        // BEFORE the real window loads, and the real JARVIS window would then
        // be told it was the duplicate and go idle. That is exactly the
        // "Another JARVIS window is already running" false positive.
        const portKey = 'jarvis-ptt-app-window-' + port;
        let isAppWindow = false;
        try {
          // Reaching this block AT ALL means the URL carries the channel port,
          // and only the host-launched app window is given that port. The latch
          // is written for compatibility, but reading it back must NEVER demote
          // this tab: sessionStorage belongs to one tab, so the only way the
          // key can already be set is that THIS tab reloaded - and a reloaded
          // app window is still the app window. The old code treated that as
          // "someone else already claimed it", connected as a secondary page,
          // and the duplicate watch then told the only real JARVIS window to
          // stand down - which switched off the microphone and global
          // push-to-talk with it.
          sessionStorage.setItem(portKey, '1');
          isAppWindow = true;
        } catch { isAppWindow = true; }
        // IDENTITY (2026-10-22). A reload, or the stream's own reconnect,
        // opens a SECOND connection from this very page while the old one is
        // still open for a moment. The host saw two connections and told the
        // new one to stand down - so the only real JARVIS window went idle,
        // released the microphone and took global push-to-talk with it. A
        // stable per-page id lets the host recognise a reconnect from the
        // same page and replace the old connection instead of superseding it.
        const clientKey = 'jarvis-ptt-client-' + port;
        let pttClientId = '';
        try {
          pttClientId = sessionStorage.getItem(clientKey) || '';
          if (!pttClientId) {
            pttClientId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
            sessionStorage.setItem(clientKey, pttClientId);
          }
        } catch { pttClientId = ''; }
        let pttStreamRetries = 0;
        let pttReconnectTimer = null;
        // ONE LIVE STREAM (2026-10-22). Every handler closes over ITS OWN
        // EventSource and ignores itself once it has been replaced, so a
        // handler left over from an earlier connection can never close the
        // live stream or stack a second reconnect on top of the pending one.
        // Reconnects are also serialised: at most one is ever scheduled.
        const schedulePttReconnect = (delay, why) => {
          if (pttReconnectTimer) return;
          if (pttStreamRetries >= 120) { voiceLog('push-to-talk stream gave up', why); return; }
          pttStreamRetries++;
          const wait = Math.max(500, delay);
          voiceLog('push-to-talk stream reconnecting', `${why} - attempt ${pttStreamRetries}, retrying in ${wait} ms`);
          pttReconnectTimer = setTimeout(() => { pttReconnectTimer = null; try { openPttStream(); } catch { } }, wait);
        };
        const openPttStream = () => {
          try { if (pttEventSource) pttEventSource.close(); } catch { }
          const source = new EventSource('http://127.0.0.1:' + port + '/ptt/stream?app=' + (isAppWindow ? '1' : '0') + (pttClientId ? '&client=' + encodeURIComponent(pttClientId) : ''));
          pttEventSource = source;
          source.onmessage = (message) => {
            if (pttEventSource !== source) return;
            try {
              const payload = JSON.parse(message.data);
              // ONE ACTIVE JARVIS. Another page connected (the URL opened in
              // the user's own browser, or a restored session). Two pages
              // would both hold the microphone and both answer, so this one
              // stands down.
              if (payload && payload.event === 'superseded') {
                // SELF-HEAL FOR THE APP WINDOW. The host sends this to the
                // connection it believes is a duplicate. Because the old
                // connection lingers across a reload, the host could briefly
                // mistake the NEW connection for the duplicate - which killed
                // the only real JARVIS window every time it started. The app
                // window (its URL carries the channel port) re-announces
                // itself instead of dying; a tab the user opened in their own
                // browser still stands down, as designed.
                if (pttChannelPort() > 0 && pttStreamRetries < 12) {
                  pttStreamRetries++;
                  voiceLog('duplicate notice ignored', `this is the app window - re-announcing to the host (attempt ${pttStreamRetries})`);
                  schedulePttReconnect(1200, 'the host briefly marked this connection as a duplicate');
                  return;
                }
                voiceLog('another JARVIS window took over', 'this window stops listening so only one JARVIS answers');
                try { stopMicrophoneMonitor(); } catch { }
                try { if (audioContext && audioContext.state === 'running') audioContext.suspend().catch(() => { }); } catch { }
                recognitionEnabled = false; micMuted = true;
                setMode('IDLE', 'Another JARVIS window is already running - this one is idle. Close it to keep just one.');
                notify('Another JARVIS window is already running. This one is idle - close it so JARVIS only listens once.');
                return;
              }
              pttStreamRetries = 0;
              applyGlobalPttEvent(payload, 'host');
            } catch { }
          };
          source.onerror = () => {
            // ONLY THE LIVE STREAM RECONNECTS. A closed or replaced
            // EventSource still fires onerror; if it were allowed to run, it
            // would close the stream that replaced it and schedule another
            // reconnect, and the channel would thrash forever - which is what
            // stopped the system-wide hotkey from reaching the page.
            if (pttEventSource !== source) return;
            try { source.close(); } catch { }
            pttEventSource = null;
            // The channel is what carries the system-wide hotkey. If it drops
            // (the host restarted, the machine slept) the page used to give up
            // silently and push-to-talk never came back. Reconnect instead.
            schedulePttReconnect(Math.min(10000, 1000 + pttStreamRetries * 500), 'the event stream dropped');
          };
        };
        openPttStream();
      } catch { }
    }
    // Fallback: the bridge channel, in case the host stream is unavailable.
    pttEventTimer = setInterval(async () => {
      if (!recognitionEnabled || micMuted) return;
      try {
        const response = await fetch('/api/ptt/event', { cache: 'no-store' });
        if (!response.ok) {
          // The bridge is missing the hotkey channel (a server.js rollback).
          // Say so once instead of failing silently.
          if (response.status === 404 && !pttChannelMissing) { pttChannelMissing = true; voiceLog('push-to-talk hotkey channel missing', 'the bridge does not expose /api/ptt/event - run tools/apply-ptt-hotkey-server.js and restart the bridge'); routeTelemetry('hotkey-channel-missing', {}); }
          return;
        }
        const event = await response.json().catch(() => ({}));
        applyGlobalPttEvent(event, 'bridge');
      } catch { }
    }, 1000);
  }
  async function startContinuous() {if (recognitionEnabled) return;
    recognitionEnabled = true; localStorage.setItem('jarvis-continuous', 'true');
    micMuted = false;
    $('#continuousToggle').checked = true; $('#micBtn').textContent = '* ALWAYS LISTENING - MUTE'; $('#micBtn').classList.add('active');
    recognitionStarting = true; recognition.lang = $('#speechLanguage').value || 'en-US';
    setMode('LISTENING', 'Starting private, local microphone recognition...');
    voiceLog('offline wake listening enabled', 'Say "Jarvis" before a command');
    startMicrophoneMonitor().then(() => {
      recognitionStarting = false; recognitionActive = true;
      const track = micStream?.getAudioTracks?.()[0];
      readout('#micDiagnostic', track ? `AVAILABLE - ${track.label || 'selected input'}` : 'UNAVAILABLE');
      readout('#recognitionDiagnostic', 'LOCAL WHISPER - READY - OFFLINE');
      readout('#wakeDiagnostic', wakeHint());
      voiceLog('local speech engine ready', track?.label || 'microphone active');
      startGlobalPttWatcher();
      setMode('LISTENING', 'Listening for "Jarvis"... your audio stays on this PC.');
    }).catch(error => {
      recognitionStarting = false; recognitionEnabled = false; recognitionActive = false; localStorage.setItem('jarvis-continuous', 'false');
      micMuted = true;
      $('#continuousToggle').checked = false; $('#micBtn').textContent = 'O RETRY VOICE'; $('#micBtn').classList.remove('active');
      readout('#micDiagnostic', `UNAVAILABLE - ${error.message}`); voiceLog('microphone monitor failed', error.message);
      readout('#recognitionDiagnostic', 'LOCAL WHISPER - NOT LISTENING');
      $('#voiceHint').textContent = 'Allow microphone access in Windows and restart listening. JARVIS uses its local English speech model; no internet speech service is needed.';
      setMode('ERROR', 'Microphone access is unavailable. Choose another microphone or allow access.');
    });
  }
  function stopContinuous() {
    try { voiceLog('voice listening stopped', String(new Error().stack || '').split('\n').slice(1, 4).join(' <- ').slice(0, 220)); } catch {}
    recognitionEnabled = false; localStorage.setItem('jarvis-continuous', 'false');
    micMuted = true;
    // Cancel all in-flight and queued transcriptions so nothing captured
    // before mute can complete after mute.
    asrBusy = false; asrPending = null;
    // Muting orphans every queued transcription so nothing captured earlier
    // can fire after the mic comes back.
    voiceEpoch++; micSessionEpoch++; voiceBusy = false; pendingUtterance = null; lastClarificationAt = 0;
    clearTimeout(recognitionRetryTimer); clearVoicePreview(); wakeArmedUntil = 0; clearTimeout(followUpTimer);
    recognitionStarting = false;
    recognitionActive = false; recognitionStarting = false; stopMicrophoneMonitor(); $('#continuousToggle').checked = false; $('#micBtn').textContent = 'O ENABLE VOICE'; $('#micBtn').classList.remove('active');
    readout('#micDiagnostic', 'MUTED');
    setMode('IDLE', 'Microphone muted. Tap Enable Voice to resume.');
  }

  // VOICE PIPELINE 2.0 — controlled microphone test + diagnostic snapshot.
  // The test records a short explicit sample through the REAL path
  // (getUserMedia -> WAV -> /api/asr/transcribe -> correction), measures
  // level/clipping/silence honestly, and never saves audio unless the user
  // clicks Save. Synthetic results are never presented as microphone data.
  async function openVoiceMicTest() {
    const phrases = ['Jarvis, what time is it?', 'Jarvis, search up Frieren.', 'Jarvis, open Loverboy on YouTube.', 'Jarvis, set an alarm for 7 AM.', 'Jarvis, play Magnetic by ILLIT.'];
    const choice = prompt(`MIC TEST - speak one of these after you press OK (5 s recording):\n\n${phrases.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nType the number you will say (or Cancel for free speech):`, '2');
    let expected = '';
    if (choice != null && /^\d$/.test(String(choice).trim())) expected = phrases[Number(choice.trim()) - 1] || '';
    voiceLog('mic test started', expected ? `expecting: "${expected}"` : 'free speech (5 s)');
    readout('#recognitionDiagnostic', 'MIC TEST - RECORDING 5 S - SPEAK NOW');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (error) { notify(`Microphone test needs mic access: ${error.message}`); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx(); const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const frames = []; const total = { peak: 0, sum: 0, n: 0, clipped: 0 };
    await new Promise(resolve => {
      proc.onaudioprocess = e => { const d = e.inputBuffer.getChannelData(0); const c = new Float32Array(d); frames.push(c); for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > total.peak) total.peak = v; total.sum += c[i] * c[i]; total.n++; if (v >= 0.99) total.clipped++; } };
      src.connect(proc); proc.connect(ctx.destination);
      setTimeout(resolve, 5000);
    });
    try { proc.disconnect(); src.disconnect(); } catch {}
    stream.getTracks().forEach(t => t.stop()); ctx.close().catch(() => {});
    const rms = Math.sqrt(total.sum / Math.max(1, total.n));
    const clipRatio = total.clipped / Math.max(1, total.n);
    const flat = new Float32Array(Math.max(1, frames.reduce((a, f) => a + f.length, 0)));
    let off = 0; for (const f of frames) { flat.set(f, off); off += f.length; }
    const quality = Core.voiceAudioQuality ? Core.voiceAudioQuality({ peak: total.peak, rms, clipRatio, durationMs: flat.length * 1000 / ctx.sampleRate }) : { flags: [], summary: 'signal-ok' };
    voiceLog('mic test audio', `peak ${total.peak.toFixed(2)} - rms ${rms.toFixed(4)} - clip ${(clipRatio * 100).toFixed(2)}% - ${quality.summary}`);
    if ((quality.flags || []).includes('too-quiet') || (quality.flags || []).includes('near-silence')) { readout('#recognitionDiagnostic', 'MIC TEST - TOO QUIET OR SILENT - move closer / raise sensitivity'); notify('The test heard almost nothing. Move closer to the mic or raise Microphone sensitivity, then test again.'); return; }
    readout('#recognitionDiagnostic', 'MIC TEST - TRANSCRIBING...');
    let raw = '', asrConf = null;
    try {
      const res = await fetch('/api/asr/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: pcmWav(flat, ctx.sampleRate), signal: AbortSignal.timeout(35000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      raw = String(data.transcript || '').trim(); asrConf = Number.isFinite(Number(data.confidence)) ? Number(data.confidence) : null;
    } catch (error) { readout('#recognitionDiagnostic', `MIC TEST FAILED - ${error.message}`); return; }
    const det = Core.voiceDeterministicCorrection ? Core.voiceDeterministicCorrection(raw) : { correctedTranscript: raw, applied: [] };
    readout('#rawTranscriptDiagnostic', raw.slice(0, 160) || '(empty)');
    readout('#transcriptDiagnostic', String(det.correctedTranscript || '').slice(0, 160));
    readout('#recognitionDiagnostic', `MIC TEST DONE${asrConf != null ? ` - conf ${(asrConf * 100).toFixed(0)}%` : ''}${det.changed ? ` - fixed: ${det.applied.map(a => a.to).join(', ')}` : ' - no fix needed'}`);
    voiceLog('mic test raw', raw || '(empty)');
    voiceLog('mic test corrected', String(det.correctedTranscript || ''));
    const report = `MIC TEST\nmic peak ${total.peak.toFixed(2)} rms ${rms.toFixed(4)} clip ${(clipRatio * 100).toFixed(2)}% quality ${quality.summary}\nraw: ${raw}\ncorrected: ${det.correctedTranscript}${expected ? `\nexpected: ${expected}` : ''}`;
    if (confirm(`${report}\n\nSave this sample as a WAV file for your own records?`)) {
      const blob = new Blob([pcmWav(flat, ctx.sampleRate)], { type: 'audio/wav' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `jarvis-mic-test-${Date.now()}.wav`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  }
  function copyVoiceSnapshot() {
    const e = lastVoiceEvidence || {};
    e.counters = { ...pipelineCounters };
    const redact = s => String(s || '').replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[redacted-key]').replace(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '[redacted-email]');
    const lines = ['JARVIS VOICE PIPELINE 2.0 SNAPSHOT', `when: ${new Date().toISOString()}`,
      `mic: ${e.micLabel || '?'} (${e.micDeviceId || '?'}) - ${e.captureRate || '?'} Hz mono -> 16 kHz PCM`,
      `vad: ${e.vadState || 'n/a'} - utterance ${e.utteranceMs || 0} ms - peak ${(Number(e.peak) || 0).toFixed(2)} rms ${(Number(e.rms) || 0).toFixed(4)} clip ${((Number(e.clipRatio) || 0) * 100).toFixed(2)}% quality [${(e.qualityFlags || []).join(', ') || 'signal-ok'}]`,
      `asr: whisper.cpp base.en-q8_0 en${e.asrConfidence != null ? ` conf ${(Number(e.asrConfidence) * 100).toFixed(0)}%` : ' conf n/a'} no-speech ${((Number(e.noSpeechProb) || 0) * 100).toFixed(0)}%`,
      `counts: frames ${e.counters?.frames ?? '?'} - vad ${e.counters?.vadTriggers ?? '?'} - utterances ${e.counters?.utterances ?? '?'} - asr ${e.counters?.asrOk ?? '?'}/${e.counters?.asrAttempts ?? '?'} ok (fail ${e.counters?.asrFail ?? '?'})`,
      `raw: ${e.rawTranscript || '-'}`, `corrected: ${e.correctedTranscript || '-'}`,
      `candidates: ${(e.candidates || []).map(c => `${c.pattern}->${c.replacement}`).join('; ') || 'none'}`,
      `rules: ${(e.appliedRules || []).map(r => r.to).join(', ') || 'none'} - ollama: ${e.ollama || 'n/a'}`,
      `intent: ${e.intent || '-'} entities: ${e.entities || '-'}`,
      `policy: ${e.policy || '-'} (${e.policyReason || ''})`,
      `stages: ${JSON.stringify(e.stageMs || {})}`, `routing: ${e.routing || 'see voice log'}`];
    const text = redact(lines.join('\n'));
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('clipboard unavailable')))
      .then(() => voiceLog('diagnostic snapshot copied', 'paste it anywhere to share pipeline state'))
      .catch(() => prompt('Copy this diagnostic snapshot:', text.slice(0, 1500)));
  }

  function tick() {
    const date = new Date();
    readout('#clock', date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }));
    readout('#headerTime', date.toLocaleTimeString([], { hour12: false }));
    readout('#date', date.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase());
  }
  tick(); setInterval(tick, 1000);
  let coreTime = 0, coreLastFrame = 0, coreMotionSpeed = .00022, coreVisualPulse = 0;
  let coreRaf = 0, coreTimer = 0, coreInView = true;
  const coreCanvas = $('#coreCanvas');
  const coreContext = coreCanvas && coreCanvas.getContext('2d');
  const coreObserver = typeof IntersectionObserver === 'function' && coreCanvas
    ? new IntersectionObserver(entries => {
        coreInView = entries.some(entry => entry.target === coreCanvas && entry.isIntersecting);
        if (coreInView) scheduleCore(0); else stopCore();
      })
    : null;

  function canAnimateCore() {
    return Boolean(coreCanvas && coreContext && coreInView && !document.hidden && (!document.hasFocus || document.hasFocus()));
  }
  function stopCore() {
    if (coreTimer) clearTimeout(coreTimer);
    if (coreRaf) cancelAnimationFrame(coreRaf);
    coreTimer = 0;
    coreRaf = 0;
  }
  function scheduleCore(delay = 0) {
    if (!canAnimateCore() || coreTimer || coreRaf) return;
    coreTimer = setTimeout(() => {
      coreTimer = 0;
      if (canAnimateCore()) coreRaf = requestAnimationFrame(animateCore);
    }, Math.max(0, delay));
  }
  function drawCoreSearchNetwork(ctx, width, height, cx, cy, radius, seconds, mode) {
    // Keep the connected search nodes beside the navigation rail, on the
    // left side of the reactor. The core itself stays centered in its bay.
    const networkRight = cx - radius * 1.72;
    const networkWidth = networkRight - 14;
    if (networkWidth < 150 || width < 760) return;
    const networkHeight = Math.min(height * 0.66, 420);
    const top = (height - networkHeight) / 2;
    const specs = [[0.02,0.5],[0.17,0.19],[0.18,0.79],[0.35,0.37],[0.39,0.65],[0.56,0.18],[0.59,0.49],[0.59,0.82],[0.79,0.33],[0.96,0.68]];
    const links = [[0,1],[0,2],[1,3],[2,3],[2,4],[3,4],[3,5],[3,6],[4,6],[4,7],[5,6],[5,8],[6,7],[6,8],[7,9],[8,9]];
    const nodes = specs.map(([x,y], index) => ({
      x: 14 + x * networkWidth,
      y: top + y * networkHeight + Math.sin(seconds * 0.22 + index * 1.7) * (mode === 'SEARCHING' ? 3.5 : 1.2)
    }));
    const searching = mode === 'SEARCHING';
    ctx.save();
    ctx.lineWidth = 0.8;
    for (let index = 0; index < links.length; index++) {
      const [a, b] = links[index], from = nodes[a], to = nodes[b];
      const shimmer = searching ? (0.12 + 0.12 * (0.5 + 0.5 * Math.sin(seconds * 1.6 + index))) : 0.085;
      ctx.strokeStyle = `rgba(78,190,238,${shimmer.toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    }
    if (searching) {
      const route = [0,1,3,5,8,9];
      for (let packet = 0; packet < 3; packet++) {
        const progress = (seconds * 1.45 + packet * 1.67) % (route.length - 1);
        const segment = Math.floor(progress), mix = progress - segment;
        const from = nodes[route[segment]], to = nodes[route[segment + 1]];
        const x = from.x + (to.x - from.x) * mix, y = from.y + (to.y - from.y) * mix;
        ctx.save(); ctx.globalAlpha = 0.72 + 0.2 * Math.sin(seconds * 2 + packet);
        ctx.shadowColor = 'rgba(108,233,255,0.9)'; ctx.shadowBlur = 10;
        ctx.fillStyle = 'rgba(226,252,255,0.94)'; ctx.beginPath(); ctx.arc(x, y, packet === 0 ? 2.5 : 1.8, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
    }
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index], prominent = index === 0 || index === 3 || index === 6 || index === 9;
      const size = prominent ? 2.8 : 1.65;
      ctx.globalAlpha = searching ? (prominent ? 0.75 : 0.48) : (prominent ? 0.44 : 0.28);
      if (prominent) { ctx.shadowColor = 'rgba(92,221,255,0.76)'; ctx.shadowBlur = searching ? 9 : 5; }
      ctx.fillStyle = prominent ? 'rgba(164,244,255,0.92)' : 'rgba(100,202,239,0.82)';
      ctx.beginPath(); ctx.arc(node.x, node.y, size, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }
  function animateCore() {
    coreRaf = 0;
    if (!canAnimateCore()) return;
    const canvas = coreCanvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) { scheduleCore(250); return; }
    const dpr = Math.min(1.25, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = coreContext;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
    const wideLayout = window.innerWidth > 1120;
    // Fit the entire reactor to the stage height, then center its visual mass.
    // The former wide-screen rule shifted it left and sized it from nearly half
    // the stage height, which clipped the outer orbit in short desktop windows.
    const coreBaseRadius = Math.min(rect.width * (wideLayout ? 0.19 : 0.33), rect.height * (wideLayout ? 0.37 : 0.41));
    const centerX = 0.5;
    const cx = rect.width * centerX, cy = rect.height / 2;
    hero.style.setProperty('--core-center-x', `${(centerX * 100).toFixed(2)}%`);
    const mode = hero.dataset.mode || 'IDLE';
    const targetSpeed = mode === 'THINKING' ? .00030 : mode === 'SEARCHING' ? .00027 : mode === 'SPEAKING' ? .00026 : mode === 'LISTENING' ? .00024 + (Number(hero.style.getPropertyValue('--mic-level')) || 0) * .00028 : .00022;
    const frameTime = performance.now(), frameDelta = coreLastFrame ? Math.min(64, frameTime - coreLastFrame) : 16;
    coreLastFrame = frameTime; coreMotionSpeed += (targetSpeed - coreMotionSpeed) * (1 - Math.exp(-frameDelta / 520)); coreTime += frameDelta * coreMotionSpeed;
    const seconds = coreTime;
    const rawPulse = Math.max(Number(getComputedStyle(document.documentElement).getPropertyValue('--wave-level')) || 0, Number(hero.style.getPropertyValue('--mic-level')) || 0);
    const pulseTau = rawPulse > coreVisualPulse ? 92 : 340;
    coreVisualPulse += (rawPulse - coreVisualPulse) * (1 - Math.exp(-frameDelta / pulseTau));
    const pulse = coreVisualPulse;
    const ringReact = Math.min(1, pulse * 1.2);
    hero.style.setProperty('--core-ring-opacity', (0.4 + ringReact * 0.38).toFixed(3));
    hero.style.setProperty('--core-ring-scale', (1 + ringReact * 0.075).toFixed(3));
    hero.style.setProperty('--core-ring-glow', (4 + ringReact * 20).toFixed(1) + 'px');
    hero.classList.toggle('voice-active', ringReact > 0.2);
    const radius = coreBaseRadius * (1 + Math.min(1, pulse) * 0.075);
    const orb = ctx.createRadialGradient(cx - radius * .32, cy - radius * .38, radius * .04, cx, cy, radius * 1.12);
    orb.addColorStop(0, `rgba(33,170,255,${.19 + pulse * .36})`); orb.addColorStop(.34, `rgba(20,125,226,${.06 + pulse * .15})`); orb.addColorStop(.62, 'rgba(12,83,126,.13)'); orb.addColorStop(1, 'rgba(5,24,44,0)');
    ctx.fillStyle = orb; ctx.beginPath(); ctx.arc(cx, cy, radius * 1.1, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, radius * .995, 0, Math.PI * 2); ctx.clip();
    ctx.globalCompositeOperation = 'screen';
    const specular = ctx.createRadialGradient(cx - radius * .37, cy - radius * .44, 1, cx - radius * .19, cy - radius * .24, radius * .82);
    specular.addColorStop(0, `rgba(246,255,255,${.28 + pulse * .22})`);
    specular.addColorStop(.16, `rgba(116,239,255,${.2 + pulse * .2})`);
    specular.addColorStop(.48, `rgba(42,181,255,${.08 + pulse * .12})`);
    specular.addColorStop(1, 'rgba(34,139,255,0)');
    ctx.fillStyle = specular; ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = `rgba(238,255,255,${.24 + pulse * .28})`; ctx.lineWidth = 1 + pulse * 1.2;
    ctx.beginPath(); ctx.ellipse(cx - radius * .22, cy - radius * .31, radius * .43, radius * .11, -.62, Math.PI * 1.06, Math.PI * 1.84); ctx.stroke();
    ctx.restore();
    const points = [];
    for (let index = 0; index < 72; index++) {
      const y = 1 - (index / 71) * 2, radial = Math.sqrt(1 - y * y), angle = Math.PI * (3 - Math.sqrt(5)) * index + seconds;
      const x0 = Math.cos(angle) * radial, z0 = Math.sin(angle) * radial;
      const x = x0 * Math.cos(seconds * .32) - z0 * Math.sin(seconds * .32), z = x0 * Math.sin(seconds * .32) + z0 * Math.cos(seconds * .32);
      const perspective = 1 + z * .13, px = cx + x * radius * perspective, py = cy + y * radius * perspective;
      points.push({ x: px, y: py, z, index });
    }
    ctx.lineWidth = .55; ctx.strokeStyle = `rgba(55,194,236,${.17 + pulse * .18})`;
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      const a = points[i], b = points[j], dx = a.x - b.x, dy = a.y - b.y, distance = dx * dx + dy * dy;
      if (distance < radius * radius * .12 && Math.abs(a.z - b.z) < .7) {
        ctx.globalAlpha = .2 + Math.max(0, a.z + b.z) * .2; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    for (const point of points) {
      const glow = .35 + Math.max(0, point.z) * .55;
      const prominent = point.index % 17 === 0, medium = !prominent && point.index % 7 === 0;
      const size = prominent ? 3.1 : medium ? 2.05 : point.z > .55 ? 1.5 : 0.95;
      if (prominent) { ctx.save(); ctx.globalAlpha = glow * 0.72; ctx.shadowColor = 'rgba(107,234,255,0.9)'; ctx.shadowBlur = 9 + pulse * 5; ctx.fillStyle = 'rgba(123,239,255,0.72)'; ctx.beginPath(); ctx.arc(point.x, point.y, size * 1.8, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
      ctx.globalAlpha = glow; ctx.fillStyle = prominent ? '#e5fcff' : 'rgba(123,239,255,0.92)'; ctx.beginPath(); ctx.arc(point.x, point.y, size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.save(); ctx.translate(cx, cy);
    for (let band = -2; band <= 2; band++) {
      const latitude = band * .47, y = Math.sin(latitude) * radius, spread = Math.cos(latitude) * radius;
      ctx.globalAlpha = .18 + Math.max(0, 1 - Math.abs(band) * .25) * .2;
      ctx.strokeStyle = band === 0 ? 'rgba(99,232,255,.8)' : 'rgba(66,183,224,.72)'; ctx.lineWidth = band === 0 ? .9 : .55;
      ctx.beginPath(); ctx.ellipse(0, y, spread, Math.max(2, radius * .045), seconds * .13, 0, Math.PI * 2); ctx.stroke();
    }
    for (let meridian = 0; meridian < 4; meridian++) {
      ctx.globalAlpha = .16 + meridian * .025; ctx.strokeStyle = 'rgba(78,199,236,.75)'; ctx.lineWidth = .55;
      ctx.beginPath(); ctx.ellipse(0, 0, radius * (.24 + (meridian % 2) * .2), radius, seconds * .08 + meridian * Math.PI / 4, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.strokeStyle = `rgba(89,220,255,${.72 + pulse * .27})`; ctx.lineWidth = 1.15 + pulse * 2; ctx.beginPath(); ctx.arc(0, 0, radius * (1 + pulse * .045), 0, Math.PI * 2); ctx.stroke();
    const nucleus = ctx.createRadialGradient(-radius * .13, -radius * .16, 1, 0, 0, radius * .45);
    nucleus.addColorStop(0, `rgba(147,249,255,${.25 + pulse * .22})`); nucleus.addColorStop(.35, 'rgba(20,174,226,.15)'); nucleus.addColorStop(1, 'rgba(16,103,177,0)');
    ctx.fillStyle = nucleus; ctx.beginPath(); ctx.arc(0, 0, radius * .52, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    const orbitRate = mode === 'THINKING' ? .20 : mode === 'LISTENING' ? .22 : .17;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(-.14);
    ctx.strokeStyle = 'rgba(49,190,228,.38)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(0, 0, radius * 1.52, radius * .25, seconds * orbitRate, 0, Math.PI * 2); ctx.stroke();
    ctx.rotate(.28); ctx.strokeStyle = 'rgba(80,151,234,.29)'; ctx.beginPath(); ctx.ellipse(0, 0, radius * 1.68, radius * .29, -seconds * orbitRate * .72, 0, Math.PI * 2); ctx.stroke();
    ctx.rotate(-.38); ctx.strokeStyle = 'rgba(55,205,233,.15)'; ctx.beginPath(); ctx.ellipse(0, 0, radius * 1.84, radius * .19, seconds * orbitRate * .58, 0, Math.PI * 2); ctx.stroke();
    for (let satellite = 0; satellite < 3; satellite++) {
      const phase = seconds * (satellite % 2 ? -1.05 : .82) + satellite * Math.PI * 2 / 3;
      const x = Math.cos(phase) * radius * (satellite === 1 ? 1.68 : 1.52), y = Math.sin(phase) * radius * (satellite === 1 ? .29 : .25);
      const size = satellite === 0 ? 3 : 2.1; ctx.globalAlpha = .55 + .35 * Math.sin(phase);
      const node = ctx.createRadialGradient(x, y, .2, x, y, size * 3.6); node.addColorStop(0, 'rgba(151,248,255,.95)'); node.addColorStop(1, 'rgba(54,192,246,0)');
      ctx.fillStyle = node; ctx.beginPath(); ctx.arc(x, y, size * 3.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#b6f8ff'; ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.restore();
    const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, radius * (1.2 + pulse * .22)); glow.addColorStop(0, `rgba(35,163,255,${.1 + pulse * .28})`); glow.addColorStop(.62, `rgba(17,125,245,${pulse * .12})`); glow.addColorStop(1, 'rgba(13,53,83,0)'); ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, radius * (1.2 + pulse * .22), 0, Math.PI * 2); ctx.fill();
    drawCoreSearchNetwork(ctx, rect.width, rect.height, cx, cy, radius, seconds, mode);
    scheduleCore(mode === 'IDLE' || mode === 'ERROR' ? 1000 / 14 : 1000 / 20);
  }
  if (coreObserver && coreCanvas) coreObserver.observe(coreCanvas);
  const wakeCore = () => canAnimateCore() ? scheduleCore(0) : stopCore();
  document.addEventListener('visibilitychange', wakeCore);
  window.addEventListener('focus', wakeCore);
  window.addEventListener('blur', stopCore);
  window.addEventListener('pagehide', () => { stopCore(); if (coreObserver) coreObserver.disconnect(); }, { once: true });
  scheduleCore(0);

  const settings = document.createElement('details'); settings.className = 'card settings'; settings.open = false;
  settings.id = 'voiceSettings';
  settings.innerHTML = '<summary class="cardhead">VOICE & LISTENING SETTINGS</summary><label>Speech language<select id="speechLanguage"><option value="en-US">English - local model</option><option value="en-GB">English - UK accent</option></select></label><label>Microphone sensitivity <span id="micGainReadout">1.8x</span><input id="micGainControl" type="range" min="1" max="3.5" step="0.1" value="1.8"></label><label>Background noise rejection <span id="noiseGateReadout">1.25x</span><input id="noiseGateControl" type="range" min="1.2" max="2.5" step="0.1" value="1.25"></label><label>Noise and echo reduction<input id="noiseSuppressionToggle" type="checkbox"></label><label>Always listen for "Jarvis"<input id="continuousToggle" type="checkbox"></label><label>Local backup voice<select id="voiceSelect"><option value="female">Microsoft Zira Desktop</option></select></label><label>Speaking speed<input id="speedControl" type="range" min="0.75" max="1.2" step="0.05" value="0.93"></label><label>Voice volume<input id="volumeControl" type="range" min="0" max="1" step="0.05" value="1"></label><label>Command sound effects<input id="sfxToggle" type="checkbox"></label><label>Thinking sound<input id="sfxThinkingToggle" type="checkbox"></label><label>Sound effects volume<input id="sfxVolumeControl" type="range" min="0" max="1" step="0.05" value="0.5"></label><div class="fishActions"><button class="chip" id="sfxPreview">PREVIEW ACK</button></div><small>Command sound effects play a short cue the moment JARVIS accepts a request, and a quiet processing tone during longer work. They use the same speaker as JARVIS replies.</small><small>Say "Jarvis" anywhere in a sentence and JARVIS will act on the request around it. It learns steady room/fan noise when listening starts, then requires sustained speech above that level. Increase noise rejection if the fan still triggers it; if it stops hearing your voice, lower this setting or raise microphone sensitivity.</small>';
  const deviceSettings = document.createElement('details'); deviceSettings.className = 'device-settings';
  deviceSettings.innerHTML = '<summary>MICROPHONE & AUDIO OUTPUT</summary><label>Microphone<select id="audioInputDevice"><option value="">System default microphone</option></select></label><label>JARVIS spoken replies<select id="audioOutputDevice"><option value="">System default output</option></select></label><label>Push-to-talk shortcut<select id="pttKeySelect"><option value="F9">Hold F9 (default)</option><option value="F8">Hold F8</option><option value="F10">Hold F10</option><option value="F11">Hold F11</option><option value="Backquote">Hold backquote (`)</option></select><button class="chip" id="pttKeyRecord" type="button">SET ANY KEY</button></label><small id="pttKeyStatus"></small><div class="device-actions"><button class="chip" id="refreshAudioDevices">REFRESH DEVICES</button><button class="chip" id="chooseAudioOutput">CHOOSE SPEAKER</button><button class="chip" id="openSoundSettings">WINDOWS SOUND SETTINGS</button></div><small id="audioDeviceStatus">Choose a device after allowing microphone access.</small><small>The selected microphone is used by local Whisper recognition. Use the sensitivity control to boost a quiet mic. Output selection applies to JARVIS spoken replies only.</small><small id="pttKeyNote">Push-to-talk: hold the shortcut key or the PTT button and speak, then release to send the command. No wake word is needed. The shortcut works while the JARVIS window is focused and never fires while you are typing in a text field.</small>';
  settings.append(deviceSettings);
  document.querySelector('.side').append(settings);
  document.querySelector('a[href="#voiceSettings"]')?.addEventListener('click', () => { settings.open = true; });
  const fishPanel = document.createElement('section'); fishPanel.className = 'card fish-card';
  fishPanel.innerHTML = '<div class="cardhead"><span>VOICE ENGINE</span><span>FISH AUDIO</span></div><strong class="fishVoiceName">Selected Fish Audio voice</strong><div class="fishStatus" id="fishStatus">Checking voice setup...</div><label class="providerLabel">Provider<select id="providerSelect"><option value="fish">Fish Audio - chosen voice</option><option value="local">Local Windows voice</option></select></label><div class="fishActions"><button class="chip" id="fishPreview">PREVIEW VOICE</button><button class="chip" id="fishSetup">GET API KEY</button></div><details class="voice-config"><summary>CHANGE VOICE</summary><label>Fish voice ID<input id="fishReferenceId" type="text" maxlength="120" placeholder="Paste the voice ID"></label><label>Fish model<input id="fishModel" type="text" maxlength="80" value="s2.1-pro-free"></label><label>API key<input id="fishKey" type="password" autocomplete="new-password" placeholder="Saved key - leave blank to keep"></label><div class="fishActions"><button class="chip" id="fishReveal">SHOW KEY</button><button class="chip" id="fishSave">SAVE VOICE</button></div><small>Paste a voice ID and API key from Fish Audio, save, then choose Preview Voice. The key stays in the JARVIS local .env file and is never shown again. Leave the key blank when changing only the voice.</small></details>';
  document.querySelector('.side').insertBefore(fishPanel, settings);
  // The schedule card is static in index.html (SCHEDULE - LOCAL). Only its
  // controls are attached here   creating a second planner card would show a
  // permanently stale duplicate of the schedule.
  const plannerCard = document.querySelector('.planner-card');
  if (plannerCard && !plannerCard.querySelector('#addAlarm')) {
    const controls = document.createElement('div');
    controls.className = 'music-controls';
    controls.innerHTML = '<button class="chip" id="addAlarm">ADD ALARM</button><button class="chip" id="addEvent">ADD EVENT</button>';
    plannerCard.insertBefore(controls, plannerCard.querySelector('.music-hint'));
  }
  $('#addAlarm').onclick=async()=>{const time=window.prompt('Alarm time, including AM or PM (example: 7:00 AM)');if(time){const answer=await handlePlannerIntent(`Set an alarm for ${time}`);notify(answer||'I could not set that alarm.');}};
  $('#addEvent').onclick=async()=>{const title=window.prompt('Event title');if(!title)return;const when=window.prompt('Date and start time (example: tomorrow at 5 PM)');if(when){const answer=await handlePlannerIntent(`Add an event called ${title} ${when}`);notify(answer||'I could not add that event.');}};
  const musicCard = document.querySelector('.music-card');
  if (musicCard && !musicCard.dataset.orbWired) {
    musicCard.dataset.orbWired = '1';
    const openBtns = musicCard.querySelectorAll('[data-orb-open]');
    for (const button of openBtns) {
      button.onclick = () => {
if (window.MusicOrb && typeof MusicOrb.show === 'function' && typeof MusicOrb.hide === 'function') {
if (button.getAttribute('data-orb-open') === 'true') MusicOrb.show(true);
          else MusicOrb.hide(true);
        } else {
          notify('Media Orb is not available yet.');
        }
      };
    }
    const diagBtn = musicCard.querySelector('[data-orb-diag]');if (diagBtn) diagBtn.onclick = () => {
      if (window.MusicOrb && typeof MusicOrb.updateDiagnostics === 'function') {
        MusicOrb.debug = !MusicOrb.debug;
        try { window.localStorage.setItem('jarvis-media-diag', MusicOrb.debug ? '1' : ''); } catch {}
        MusicOrb.updateDiagnostics();
        notify(MusicOrb.debug ? 'Media diagnostics on.' : 'Media diagnostics off.');
      }
    };
    const floatingToggle = musicCard.querySelector('[data-orb-floating-toggle]');if (floatingToggle) floatingToggle.onclick = () => {
      if (window.MusicOrb) {
        MusicOrb.floatingMode = !MusicOrb.floatingMode;
        MusicOrb.saveSettings();
        MusicOrb.updateDiagnostics?.();
        try { window.localStorage.setItem('jarvis-orb-floating', MusicOrb.floatingMode ? '1' : ''); } catch {}
        notify(MusicOrb.floatingMode ? 'Compact floating visualizer enabled.' : 'Compact floating visualizer disabled.');
if (MusicOrb.floatingMode && document.hidden) MusicOrb.createFloating?.();
      }
    };
    const statusEl = musicCard.querySelector('#orbLive');if (statusEl) {
      const unsubscribe = window.Situation && typeof Situation.subscribe === 'function' ? Situation.subscribe((situation) => {
        const mode = situation.effectiveMode || situation.mode;
        statusEl.textContent = `${mode.toUpperCase()} · ${situation.activeMode.toUpperCase()}`;
        statusEl.style.color = situation.activeMode === 'manual' ? 'var(--amber)' : (situation.mediaState && situation.mediaState.mediaActive ? 'var(--mint)' : 'var(--cyan)');
      }) : null;
      musicCard._situationUnsubscribe = unsubscribe;
    }

    musicCard.querySelector('#orbLive').textContent = 'OFF';
    musicCard.querySelector('#musicNow').textContent = 'Media Orb is ready.';
  }
  async function updateMusicCard() {
if (!musicCard) return;
    const orb = (window.MusicOrb && MusicOrb.state) || null;
    const stream = (window.MusicOrb && MusicOrb.stream) || null;
    const live = orb && orb.visible;
    const mode = orb && orb.mode || 'idle';
    const playing = live && mode === 'playing';
    const badge = musicCard.querySelector('#orbLive');
    const readout = musicCard.querySelector('#musicNow');if (badge) badge.textContent = playing ? 'PLAYING' : (live ? (stream && stream.stale ? 'STALLED' : 'ACTIVE') : 'OFF');if (badge) badge.style.color = playing ? 'var(--mint)' : (stream && stream.stale ? 'var(--amber)' : (live ? 'var(--cyan)' : ''));if (readout) {
      const identity = (window.MusicOrb && MusicOrb.identity) || null;
      const title = identity && identity.title ? identity.title : (live ? (mode === 'playing' ? 'Media playing' : 'Media detected') : 'Media Orb is ready.');
      readout.textContent = title;
      readout.dataset.playing = playing ? 'true' : 'false';
    }
  }
  updateMusicCard();
  const musicPoll = setInterval(updateMusicCard, 1000);
  window.addEventListener('beforeunload', () => { clearInterval(musicPoll); stopForegroundAppPolling(); if (window.Situation && typeof Situation.destroy === 'function') try { Situation.destroy(); } catch {}; try { const port = pttChannelPort(); if (port) sessionStorage.removeItem('jarvis-ptt-app-window-' + port); } catch {} });
  if (musicCard && musicCard._situationUnsubscribe) {
    window.addEventListener('pagehide', () => {
      if (musicCard && musicCard._situationUnsubscribe) {
        try { musicCard._situationUnsubscribe(); } catch {}
        musicCard._situationUnsubscribe = null;
      }
    });
  }
  window.addEventListener('visibilitychange', () => {
    if (window.Situation && typeof Situation.onVisibilityChange === 'function') {
      try { Situation.onVisibilityChange(); } catch {}
    }
    if (musicCard && musicCard._situationUnsubscribe) {
      if (!document.hidden) {
        try { musicCard._situationUnsubscribe(); } catch {}
        musicCard._situationUnsubscribe = null;
      }
    }
  });
  (function wireSituation() {
    const SituationModule = typeof module !== 'undefined' && module.exports ? require('./situation.js') : (window.SituationModule || null);if (!SituationModule) return;
    const engine = SituationModule.createEngine({
      getForegroundApp: () => foregroundApp,
      getMediaState: () => {
        const orb = (window.MusicOrb && MusicOrb.state) || null;
        const stream = (window.MusicOrb && MusicOrb.stream) || null;
        return {
          visible: Boolean(orb && orb.visible),
          mode: orb && orb.mode || 'idle',
          mediaActive: Boolean(stream && stream.linked && stream.activity && stream.activity.active),
          captureReady: Boolean(stream && stream.capture && stream.capture.ready),
          stalled: Boolean(stream && stream.stale),
          title: (window.MusicOrb && MusicOrb.identity && MusicOrb.identity.title) || '',
          source: (window.MusicOrb && MusicOrb.identity && MusicOrb.identity.source) || ''
        };
      },
      getJarvisState: () => {
        const mode = (hero && hero.dataset && hero.dataset.mode) || 'IDLE';
        return mode;
      },
      getWindowVisible: () => Boolean(document && document.visibilityState !== 'hidden'),
      getPlannerSnapshot: async () => {
        try {
          const data = await plannerSnapshot();
          const alarms = (data.alarms || []).filter(item => Date.parse(item.when) > Date.now()).sort((a,b)=>Date.parse(a.when)-Date.parse(b.when));
          const reminders = (data.reminders || []).filter(item => Date.parse(item.when) > Date.now()).sort((a,b)=>Date.parse(a.when)-Date.parse(b.when));
          return { alarms, reminders, activeAlarmId: data.activeAlarmId || '' };
        } catch { return { alarms: [], reminders: [], activeAlarmId: '' }; }
      },
      getAiAvailable: async () => {
        try {
          const response = await fetch('/api/ai/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
          const data = await response.json().catch(() => null);
          return Boolean(data && data.running);
        } catch { return false; }
      },
      getSpeechListening: () => Boolean(recognitionEnabled),
      getSettings: () => loadJson('jarvis-situation-settings', SituationModule.DEFAULT_SETTINGS),
      saveSettings: (settings) => { try { localStorage.setItem('jarvis-situation-settings', JSON.stringify(settings)); } catch {} }
    });
    engine.init();
    startForegroundAppPolling();
    // Browser tab control connects itself at startup (2026-10-24): tab
    // commands used to answer "not connected yet" until the user asked for a
    // controlled window by hand. Deferred so the page stays responsive, and it
    // reuses an existing controlled browser instead of opening another one.
    setTimeout(() => { localAction({ action: 'browser-control-enable' }).catch(() => {}); }, 5000);
    window.Situation = engine;
  })();
  updatePlannerCard();setInterval(updatePlannerCard,30000);
  const profilePanel = document.createElement('section'); profilePanel.className = 'card memory-card'; profilePanel.id = 'memory';
  profilePanel.innerHTML = '<div class="cardhead"><span>OPERATOR PROFILE & MEMORY</span><span class="live">LOCAL</span></div><label>Call me<input id="profileAddress" type="text" maxlength="40"></label><label>First name<input id="profileGiven" type="text" maxlength="60"></label><label>Full name<input id="profileFull" type="text" maxlength="100"></label><div class="memory-label">SAVED NOTES</div><div id="memoryList" class="memory-list"></div><small>Saved in this JARVIS app profile on this computer. Say "remember that..." to add a note.</small>';
  document.querySelector('.side').insertBefore(profilePanel, fishPanel);
  const profileAddress = $('#profileAddress'), profileGiven = $('#profileGiven'), profileFull = $('#profileFull');
  profileAddress.value = preferredName(); profileGiven.value = givenName(); profileFull.value = fullName();
  profileAddress.onchange = () => localStorage.setItem('jarvis-user-name', profileAddress.value.trim() || 'Sir');
  profileGiven.onchange = () => localStorage.setItem('jarvis-given-name', profileGiven.value.trim() || 'Tharn');
  profileFull.onchange = () => localStorage.setItem('jarvis-full-name', profileFull.value.trim() || 'Tharnphisit Leotphornphisit');
  saveMemories();
  const aiPanel = document.createElement('section'); aiPanel.className = 'card ai-panel'; aiPanel.id = 'aiSettings';
  aiPanel.innerHTML = '<div class="cardhead"><span>LOCAL AI CORE - OLLAMA</span><span class="live">ON DEVICE</span></div>'
    + '<div class="ai-primary"><div class="ai-status" id="aiStatusText">Checking local Ollama service...</div>'
    + '<div class="model-row"><select id="aiModel" aria-label="Local AI model"><option value="">No installed model found</option></select></div>'
    + '<div class="ai-actions"><button class="chip" id="aiRefresh">REFRESH</button><button class="chip" id="aiTest">TEST MODEL</button><button class="chip" id="aiSmaller">GET SMALLER MODEL</button></div></div>'
    + '<details class="ai-advanced"><summary>AI ROUTING &amp; PROVIDERS</summary><div class="ai-advanced-body">'
    + '<label class="memory-label">AI ROUTE</label><div class="model-row"><select id="aiMode" aria-label="AI provider mode"><option value="auto">Automatic: remote first, local fallback</option><option value="local">Local AI ONLY (nothing leaves this PC)</option></select></div>'
    + '<div class="ai-status" id="aiRemoteStatus">Remote AI: checking…</div>'
    + '<div class="model-row"><input id="aiZenKey" type="password" placeholder="OpenCode API key (opencode.ai/console)" style="flex:1;min-width:0;background:#06131e;border:1px solid #23485b;color:#d7f4fb;padding:6px;border-radius:4px;font:9px Segoe UI,sans-serif"><button class="chip" id="aiZenSave">SAVE KEY</button></div>'
    + '<div class="model-row"><input id="aiOrKey" type="password" placeholder="OpenRouter API key (openrouter.ai/keys)" style="flex:1;min-width:0;background:#06131e;border:1px solid #23485b;color:#d7f4fb;padding:6px;border-radius:4px;font:9px Segoe UI,sans-serif"><button class="chip" id="aiOrSave">SAVE KEY</button></div>'
    + '<div class="setup" id="aiSetup">Conversations run on your selected provider. Automatic mode tries a configured remote provider first and always falls back to Ollama; Local AI only mode contacts no remote AI at all. Screen and camera images are analyzed locally and are never sent to remote AI.</div></div></details>';
  document.querySelector('.side').insertBefore(aiPanel, profilePanel);
  // Screen Vision + Computer Access settings card (integrated into the
  // existing side panel; no new primary interface).
  const visionPanel = document.createElement('section'); visionPanel.className = 'card memory-card'; visionPanel.id = 'visionSettings';
  visionPanel.innerHTML = '<div class="cardhead"><span>SCREEN VISION &amp; COMPUTER ACCESS</span><span class="live">LOCAL</span></div>'
    + '<label style="display:flex;gap:8px;align-items:center;margin:9px 12px"><input id="svEnabled" type="checkbox"> <span style="font:8px Consolas,monospace;color:#9bb9c8;letter-spacing:.08em">ENABLE SCREEN ANALYSIS</span></label>'
    + '<div class="memory-label" style="margin:10px 12px 4px">VISION MODEL</div><div class="model-row" style="margin:4px 12px"><select id="svModel" aria-label="Vision model"><option value="">Any vision-capable model</option></select><button class="chip" id="svRefresh">REFRESH</button></div>'
    + '<div class="memory-label" style="margin:10px 12px 4px">SCREENSHOT FOLDER</div><div class="model-row" style="margin:4px 12px"><input id="svDir" type="text" style="flex:1;min-width:0;background:#06131e;border:1px solid #23485b;color:#d7f4fb;padding:6px;border-radius:4px;font:9px Consolas,monospace"><button class="chip" id="svDirSave">SAVE</button></div><div class="model-row" style="margin:4px 12px"><button class="chip" id="svOpenFolder">OPEN FOLDER</button><button class="chip" id="svList">LIST</button></div>'
    + '<label style="display:flex;gap:8px;align-items:center;margin:9px 12px"><input id="ctEnabled" type="checkbox"> <span style="font:8px Consolas,monospace;color:#9bb9c8;letter-spacing:.08em">ENABLE COMPUTER ACCESS</span></label>'
    + '<label style="display:flex;gap:8px;align-items:center;margin:7px 12px"><input id="ctFileOps" type="checkbox"> <span style="font:8px Consolas,monospace;color:#9bb9c8">ALLOW AI FILE OPERATIONS (write, move, rename)</span></label>'
    + '<label style="display:flex;gap:8px;align-items:center;margin:7px 12px"><input id="ctDeleteOps" type="checkbox"> <span style="font:8px Consolas,monospace;color:#9bb9c8">ALLOW AI DELETIONS (moves to recycle bin)</span></label>'
    + '<label style="color:#71aec0;font:8px Consolas,monospace;margin:9px 12px 4px">EXTRA SEARCH FOLDERS</label><div class="model-row" style="margin:4px 12px"><input id="ctRoots" type="text" placeholder="C:\\Data, D:\\Projects" style="flex:1;min-width:0;background:#06131e;border:1px solid #23485b;color:#d7f4fb;padding:6px;border-radius:4px;font:9px Consolas,monospace"><button class="chip" id="ctSave">SAVE</button></div>'
    + '<div class="ai-status" id="svStatus" style="padding:7px 12px;color:#9bb9c8;font-size:9px;line-height:1.45">Checking screen vision status…</div><small style="display:block;margin:4px 12px 10px;color:#668596;line-height:1.5;font-size:8px">Capture and analysis stay on this computer. File changes and deletions always need your confirmation, and deletions move to the JARVIS recycle bin.</small>';
  document.querySelector('.side').insertBefore(visionPanel, aiPanel);
  const refreshVisionCards = async () => {
    try {
      const sv = await localAction({ action: 'screen-status' });
      const ct = await localAction({ action: 'computer-status' });
      $('#svEnabled').checked = Boolean(sv.enabled);
      $('#svDir').value = sv.screenshotDir || '';
      $('#ctEnabled').checked = Boolean(ct.enabled);
      $('#ctFileOps').checked = Boolean(ct.allowAiFileOperations);
      $('#ctDeleteOps').checked = Boolean(ct.allowAiDeletions);
      $('#ctRoots').value = (ct.extraRoots || []).join(', ');
      $('#svStatus').textContent = `Screen vision ${sv.enabled ? 'ON' : 'OFF'} · computer access ${ct.enabled ? 'ON' : 'OFF'} · AI file ops ${ct.allowAiFileOperations ? 'ON' : 'OFF'} · AI deletions ${ct.allowAiDeletions ? 'ON' : 'OFF'}. Screenshots: ${sv.screenshotDir}.${sv.hasFreshContext ? ' Fresh screen context available for follow-ups.' : ''}`;
      const ai = await fetch('/api/ai/status', { cache: 'no-store', signal: AbortSignal.timeout(6000) }).then(r => r.json()).catch(() => null);
      const select = $('#svModel');
      const visionModels = (ai?.models || []).filter(m => (m.capabilities || []).includes('vision'));
      select.replaceChildren();
      const anyOption = document.createElement('option'); anyOption.value = ''; anyOption.textContent = visionModels.length ? 'Any vision-capable model' : 'No vision-capable model installed';
      select.append(anyOption);
      for (const m of visionModels) { const option = document.createElement('option'); option.value = m.name; option.textContent = `${m.name}${m.parameterSize ? ` - ${m.parameterSize}` : ''}`; select.append(option); }
      if (sv.visionModel && visionModels.some(m => m.name === sv.visionModel)) select.value = sv.visionModel;
    } catch (error) { $('#svStatus').textContent = `Status unavailable: ${error.message}`; }
  };
  refreshVisionCards();
  $('#svEnabled').onchange = async () => { const r = await localAction({ action: 'screen-settings', settings: { enabled: $('#svEnabled').checked } }); $('#svStatus').textContent = r.message || 'Saved.'; };
  $('#svRefresh').onclick = refreshVisionCards;
  $('#svModel').onchange = async () => { const r = await localAction({ action: 'screen-settings', settings: { visionModel: $('#svModel').value } }); $('#svStatus').textContent = r.ok ? `Vision model: ${$('#svModel').value || 'any vision-capable model'}.` : r.message; };
  $('#svDirSave').onclick = async () => { const r = await localAction({ action: 'screen-settings', settings: { screenshotDir: $('#svDir').value.trim() } }); $('#svStatus').textContent = r.message; if (r.ok) refreshVisionCards(); };
  $('#svOpenFolder').onclick = async () => { const r = await localAction({ action: 'screenshot-folder' }); notify?.(r.message); };
  $('#svList').onclick = async () => { const r = await localAction({ action: 'screenshots-list', withinDays: 30, limit: 12 }); notify?.(r.ok && r.screenshots?.length ? `${r.screenshots.length} recent screenshots in ${r.dir}` : (r.message || 'No screenshots yet.')); };
  $('#ctEnabled').onchange = async () => { const r = await localAction({ action: 'computer-settings', settings: { enabled: $('#ctEnabled').checked } }); if (!r.ok) { $('#ctEnabled').checked = !$('#ctEnabled').checked; } $('#svStatus').textContent = r.message || 'Saved.'; refreshVisionCards(); };
  $('#ctFileOps').onchange = async () => { const r = await localAction({ action: 'computer-settings', settings: { allowAiFileOperations: $('#ctFileOps').checked, enabled: $('#ctFileOps').checked ? true : undefined } }); $('#svStatus').textContent = r.message || 'Saved.'; refreshVisionCards(); };
  $('#ctDeleteOps').onchange = async () => { const r = await localAction({ action: 'computer-settings', settings: { allowAiDeletions: $('#ctDeleteOps').checked, enabled: $('#ctDeleteOps').checked ? true : undefined } }); $('#svStatus').textContent = r.message || 'Saved.'; refreshVisionCards(); };
  $('#ctSave').onclick = async () => {
    const roots = $('#ctRoots').value.split(',').map(item => item.trim()).filter(Boolean);
    const r = await localAction({ action: 'computer-settings', settings: { extraRoots: roots } });
    $('#svStatus').textContent = r.ok ? 'Search folders saved.' : r.message;
    if (r.ok) refreshVisionCards();
  };
  // ---- JARVIS Camera Vision panel (additive; reuses the local vision pipeline) ----
  const cameraPanel = document.createElement('section'); cameraPanel.className = 'card memory-card'; cameraPanel.id = 'cameraVision';
  // Inject camera CSS via a proper <style> element in <head> — innerHTML on a
  // <section> treats <style> as text content, which made the CSS source visible.
  const camCss = ''
    + '#cameraVision .cam-stage{transition:box-shadow .45s ease,border-color .45s ease,background .55s ease}'
    + '#cameraVision .cam-stage.cambreathe{animation:camBreathe 4.2s ease-in-out infinite;transform-origin:50% 50%}'
    + '#cameraVision .cam-stage.camscan{animation:camSweep 1.8s linear infinite;animation-delay:.35s}'
    + '#cameraVision .cam-vision .cam-stage{border-color:#39cbe770;box-shadow:0 0 22px #39cbe728, inset 0 0 28px #04141fff}'
    + '#cameraVision .cam-vision .cam-stage{background:radial-gradient(120% 100% at 50% 45%,#0a2c44,#050d17)}'
    + '#cameraVision .cam-live #camPlaceHolder{display:none!important}'
    + '#cameraVision .cam-stage{position:relative;margin:10px 12px 0;background:radial-gradient(120% 100% at 50% 45%,#0a2033,#050d17);border:1px solid #17394b;border-radius:8px;overflow:hidden;aspect-ratio:16/10;min-height:170px}'
    + '#cameraVision .cam-stage::before{content:"";position:absolute;inset:0;border-radius:8px;box-shadow:inset 0 0 30px #020b14;pointer-events:none;transition:opacity .5s ease}'
    + '#cameraVision .cam-live #camStage::before{opacity:0}'
    + '#camVideo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;display:none;transform:translateZ(0)}'
    + '#camPlaceHolder{position:absolute;inset:0;display:grid;place-items:center;color:#5d8ba1;font:9px Consolas,monospace;letter-spacing:.1em;text-align:center;padding:10px;transition:opacity .4s ease}'
    + '#cameraVision .cam-live #camPlaceHolder{opacity:0;pointer-events:none}'
    + '#camGuard{position:absolute;left:50%;top:50%;width:46%;aspect-ratio:1;transform:translate(-50%,-50%);border:1.5px solid #1d627a;border-radius:50%;opacity:0;pointer-events:none;transition:opacity .55s ease,transform .55s ease,box-shadow .55s ease;z-index:4}'
    + '#cameraVision .cam-frozen #camGuard{opacity:.85;animation:camGuardPulse 2.8s ease-in-out infinite;box-shadow:0 0 18px #1d627a55,inset 0 0 22px #02101988}'
    + '@keyframes camGuardPulse{0%,100%{opacity:.55;transform:translate(-50%,-50%) scale(1)}50%{opacity:.9;transform:translate(-50%,-50%) scale(1.04)}}'
    + '#camFrozenTag{position:absolute;left:50%;top:10px;transform:translateX(-50%);background:#04101c;border:1px solid #1d627a;color:#7fe3f7;padding:4px 9px;border-radius:4px;font:9px Consolas,monospace;letter-spacing:.1em;z-index:5;box-shadow:0 0 10px #1d627a55;opacity:0;transition:opacity .45s ease,box-shadow .45s ease;pointer-events:none}'
    + '#cameraVision .cam-frozen #camFrozenTag{opacity:1;animation:camFrozenPulse 2.4s ease-in-out infinite}'
    + '@keyframes camFrozenPulse{0%,100%{opacity:.8;box-shadow:0 0 10px #1d627a55}50%{opacity:1;box-shadow:0 0 18px #1d627a99}}'
    + '#camFrozenFrame{border-color:#1d627a;box-shadow:0 0 16px #1d627a55;transition:border-color .4s ease,box-shadow .4s ease}'
    + '#camScan{position:absolute;left:0;right:0;top:0;height:16%;pointer-events:none;opacity:0;background:linear-gradient(180deg,transparent,#39cbe714 42%,#39cbe788 50%,#39cbe714 58%,transparent);transition:opacity .45s ease}'
    + '#cameraVision .cam-scan #camScan{animation:camSweep 1.8s linear infinite;opacity:1}'
    + '@keyframes camSweep{from{transform:translateY(-14%)}to{transform:translateY(114%)}}'
    + '#camReticle{position:absolute;left:50%;top:50%;width:38%;aspect-ratio:1;transform:translate(-50%,-50%);pointer-events:none;opacity:0;transition:opacity .5s ease,transform .5s ease}'
    + '#cameraVision .cam-hud #camReticle{opacity:1}'
    + '#camReticle svg{width:100%;height:100%;overflow:visible;transition:stroke .4s ease,stroke-width .4s ease}'
    + '#cameraVision .cam-scan #camReticle svg{stroke:#39cbe7}'
    + '#cameraVision .cam-hud #camReticle svg{stroke:#7fe3f7}'
    + '#cameraVision .cam-hud .cam-ring{animation:camBreathe 4.2s ease-in-out infinite;transform-origin:50% 50%}'
    + '@keyframes camBreathe{0%,100%{opacity:.34;transform:rotate(0deg) scale(1)}50%{opacity:.78;transform:rotate(180deg) scale(1.04)}}'
    + '#cameraVision .cam-scan .cam-ring{animation:camPulse 1.1s ease-in-out infinite}'
    + '@keyframes camPulse{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:1;transform:scale(1.07)}}'
    + '#camHud{position:absolute;inset:0;pointer-events:none;font:8px Consolas,monospace;letter-spacing:.12em;color:#7fe3f7;transition:opacity .45s ease}'
    + '#cameraVision .cam-stage #camHud{opacity:.62}'
    + '#cameraVision .cam-hud #camHud{opacity:1}'
    + '#camState{position:absolute;left:10px;top:8px;color:#9be9fb;text-shadow:0 0 8px #1d627a44}'
    + '#camTimer{position:absolute;right:10px;top:8px;color:#7fe3f7;text-shadow:0 0 8px #1d627a44}'
    + '#camTrackNote{position:absolute;right:10px;bottom:8px;color:#7fe3f7;font-size:7px;letter-spacing:.1em;text-shadow:0 0 6px #1d627a33}'
    + '#camHint{position:absolute;left:10px;bottom:8px;font:8px Consolas,monospace;color:#9fc8db;letter-spacing:.06em;pointer-events:none;transition:color .4s ease,text-shadow .4s ease}'
    + '#cameraVision .cam-scan #camHint{color:#7fe3f7;text-shadow:0 0 8px #39cbe744}'
    + '#cameraVision .cam-frozen #camHint{color:#7fe3f7;text-shadow:0 0 8px #1d627a55}'
    + '#cameraVision .cam-error #camHint{color:#ffb9c4;text-shadow:0 0 8px #ff718644}'
    + '#camResultStrip{position:absolute;left:0;right:0;bottom:0;display:none;padding:8px 12px;background:linear-gradient(180deg,#04141fff,#03101aee);border-top:1px solid #17394b;color:#cfeefb;font:9px "Segoe UI",sans-serif;line-height:1.45;max-height:42%;overflow:auto;transition:opacity .4s ease,border-color .4s ease}'
    + '#cameraVision .cam-scan #camResultStrip{display:block;border-color:#39cbe766}'
    + '#cameraVision .cam-error #camResultStrip{border-color:#ffb9c470}'
    + '#cameraVision .cam-complete #camResultStrip{border-color:#1d627a99}'
    + '#cameraVision .cam-complete #camResultStrip{background:linear-gradient(180deg,#04161fff,#03101acc)}'
    + '#cameraVision .cardhead{border-bottom-color:#153446;transition:border-color .5s ease,color .5s ease,background .5s ease}'
    + '#cameraVision .cam-blue .cardhead{border-bottom-color:#1d627a;background:linear-gradient(180deg,#0d2a40,#08182a);color:#7fe3f7;box-shadow:inset 0 1px #d5f7ff18}'
    + '#cameraVision .cam-blue .cardhead .live{color:#7fe3f7;border-color:#1d627a;background:#0c273f;font-weight:600}'
    + '#cameraVision .cam-blue .cardhead span:first-child{color:#7fe3f7;text-shadow:0 0 10px #1d627a55}'
    + '#cameraVision .cam-blue .memory-label{color:#7fe3f7;text-shadow:0 0 8px #1d627a33}'
    + '#cameraVision .cam-blue select{color:#e8f7ff;border-color:#2c5f7e;background:#0a1c2c}'
    + '#cameraVision .cam-blue select option{color:#e8f7ff;background:#0a1c2c}'
    + '#cameraVision .cam-blue .ai-status{color:#e8f7ff}'
    + '#cameraVision .cam-blue .ai-status+p{color:#7fe3f7}'
    + '#cameraVision .cam-blue .chip{border-color:#2c5f7e;color:#e8f7ff;background:linear-gradient(180deg,#0e2738,#0a1a28);box-shadow:inset 0 1px #d5f7ff14}'
    + '#cameraVision .cam-blue .chip:hover{border-color:#39cbe7;color:#ffffff;box-shadow:0 0 14px #39cbe733,inset 0 0 12px #39cbe722}'
    + '#cameraVision .cam-blue .cam-hint-label{color:#7fe3f7}'
    + '#cameraVision .cam-blue input[type=text]{border-color:#2c5f7e;color:#e8f7ff;background:#0a1c2c;box-shadow:inset 0 0 14px #041018}'
    + '#cameraVision .cam-blue input[type=text]:focus{border-color:#39cbe7;box-shadow:0 0 14px #39cbe733,inset 0 0 18px #041018}'
    + '#cameraVision .cam-blue .memory-label+div .chip{border-color:#2c5f7e}'
    + '#cameraVision .cam-blue .memory-label+div .chip:hover{border-color:#39cbe7}'
    + '#cameraVision .cam-scan .chip.is-active{border-color:#56e9ff;color:#ffffff;box-shadow:0 0 14px #56e9ff33,inset 0 0 12px #56e9ff22}'
    + '#cameraVision .cam-scan .chip.is-active:hover{border-color:#7fe3f7}'
    + '#cameraVision .cam-frozen .chip.is-paused{border-color:#1d627a;color:#9fc8db;background:linear-gradient(180deg,#0a1c2c,#06131e)}'
    + '#cameraVision .cam-error .chip{border-color:#5a2a33;color:#ffb9c4;background:linear-gradient(180deg,#1a0c12,#0c0608)}'
    + '#cameraVision .cam-error .chip:hover{border-color:#ff7186;color:#ffffff}'
    + '#cameraVision .chip{transition:border-color .35s ease,color .35s ease,background .35s ease,box-shadow .35s ease}'
    + '#cameraVision .cam-error .ai-status+p{color:#ffb9c4}'
    + '@media (prefers-reduced-motion: reduce){#cameraVision .cam-ring,#cameraVision .cam-scan #camScan,#cameraVision .cam-frozen #camFrozenTag,#cameraVision .cam-frozen #camGuard{animation:none!important}#cameraVision .cam-stage,#cameraVision .cam-stage::before,#cameraVision #camReticle,#cameraVision #camGuard,#cameraVision #camFrozenTag,#cameraVision #camScan,#cameraVision .chip,#cameraVision .cardhead,#cameraVision select,#cameraVision input[type=text]{transition:none!important}}'
    + '#cameraVision .cam-stage{background:radial-gradient(120% 100% at 50% 45%,#0a2c44,#050d17);border:1px solid #17394b;border-radius:10px;overflow:hidden;position:relative;aspect-ratio:16/10;min-height:188px;transition:box-shadow .5s ease,border-color .5s ease}'
    + '#cameraVision .cam-vision .cam-stage{border-color:#39cbe766;box-shadow:0 0 18px #39cbe722, inset 0 0 24px #04141f}'
    + '#cameraVision .cam-frozen .cam-stage{border-color:#1d627a;box-shadow:0 0 22px #1d627a33, inset 0 0 26px #02101955}'
    + '#cameraVision .cam-scan #camScan{position:absolute;left:0;right:0;top:0;height:16%;pointer-events:none;opacity:1;animation:camSweep 1.8s linear infinite;animation-delay:.3s}'
    + '#cameraVision .cam-frozen #camGuard{position:absolute;left:50%;top:50%;width:46%;aspect-ratio:1;transform:translate(-50%,-50%);border:1.5px solid #1d627a;border-radius:50%;opacity:.85;pointer-events:none;animation:camGuardPulse 2.8s ease-in-out infinite;z-index:4}'
    + '#cameraVision .cam-frozen #camFrozenTag{position:absolute;left:50%;top:12px;transform:translateX(-50%);background:#04101c;border:1px solid #1d627a;color:#7fe3f7;padding:5px 10px;border-radius:4px;font:9px Consolas,monospace;letter-spacing:.1em;z-index:5;box-shadow:0 0 10px #1d627a55;animation:camFrozenPulse 2.4s ease-in-out infinite}';
  // Append the CSS as a proper <style> element in <head> so it is parsed as
  // a stylesheet, not rendered as text content.
  const camStyleEl = document.createElement('style');
  camStyleEl.id = 'cameraVisionStyles';
  camStyleEl.textContent = camCss;
  document.head.appendChild(camStyleEl);
  cameraPanel.innerHTML = '<div class="cardhead"><span>CAMERA VISION</span><span class="live" id="camLive">OFF</span></div>'
    + '<div id="camStage" class="cam-stage">'
    + '<video id="camVideo" autoplay playsinline muted style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none"></video>'
    + '<div id="camPlaceHolder" style="position:absolute;inset:0;display:grid;place-items:center;color:#5d8ba1;font:9px Consolas,monospace;letter-spacing:.1em;text-align:center;padding:10px">CAMERA OFF — press CONNECT when you want JARVIS to look.</div>'
    + '<div id="camGuide" style="position:absolute;left:50%;top:50%;width:44%;aspect-ratio:1;transform:translate(-50%,-50%);border:1px dashed #39cbe755;border-radius:50%;display:none;pointer-events:none"></div>'
    + '<div id="camGuard" style="display:none"></div>'
    + '<div id="camFrozenTag" style="display:none">FRAME FROZEN</div>'
    + '<div id="camScan"></div>'
    + '<div id="camReticle"><svg viewBox="0 0 100 100" fill="none" stroke="#39cbe7">'
    + '<circle class="cam-ring" cx="50" cy="50" r="34" stroke-width="1" stroke-dasharray="14 9" opacity=".5"/>'
    + '<path d="M50 12v10M50 78v10M12 50h10M78 50h10" stroke-width="1.2" opacity=".65"/>'
    + '<path d="M18 30v-8h8M82 30v-8h-8M18 70v8h8M82 70v8h-8" stroke-width="1.4" opacity=".8"/>'
    + '<circle cx="50" cy="50" r="1.6" fill="#39cbe7" stroke="none" opacity=".9"/></svg></div>'
    + '<div id="camHud"><span id="camState">SYSTEM OFFLINE</span><span id="camTimer"></span><span id="camTrackNote">TRACKING: TEXT ONLY MODEL — NO COORDINATES</span></div>'
    + '<div id="camHint" style="position:absolute;left:8px;bottom:6px;font:8px Consolas,monospace;color:#7fa9ba;letter-spacing:.05em;pointer-events:none">POSITIONING GUIDE ON WHEN CONNECTED</div>'
    + '<div id="camResultStrip"></div></div>'
    + '<div class="model-row" style="margin:8px 12px"><select id="camDevice" aria-label="Camera"><option value="">No camera detected yet</option></select><button class="chip" id="camReloadDevices">REFRESH</button></div>'
    + '<div class="model-row" style="margin:6px 12px"><button class="chip" id="camConnect">CONNECT</button><button class="chip" id="camDisconnect">DISCONNECT</button><button class="chip" id="camFreeze" title="Freeze the current frame for analysis">FREEZE</button><button class="chip" id="camSave">SAVE FRAME</button></div>'
    + '<div class="model-row" style="margin:6px 12px"><select id="camMode" aria-label="Analysis mode"><option value="identify">General object identification</option><option value="readtext">Read visible text</option><option value="explain">Explain how it works</option><option value="compare">Compare objects</option><option value="scene">Describe the scene</option></select><button class="chip" id="camAsk">ANALYZE</button></div>'
    + '<div class="memory-label" style="margin:10px 12px 4px">ASK ABOUT WHAT THE CAMERA SEES</div>'
    + '<div class="model-row" style="margin:4px 12px"><input id="camQuestion" type="text" placeholder="e.g. what can I use this for?" style="flex:1;min-width:0;background:#06131e;border:1px solid #23485b;color:#d7f4fb;padding:7px;border-radius:4px;font:9px \'Segoe UI\',sans-serif"><button class="chip" id="camAskBtn">ASK</button><button class="chip" id="camFollowBtn" title="Ask about the previously captured frame">SAME FRAME</button></div>'
    + '<div class="ai-status" id="camAnswer" style="padding:9px 12px;color:#c3e2ec;font-size:10px;line-height:1.5;min-height:46px">JARVIS will describe what it recognizes here. Voice replies use the normal speech system.</div>'
    + '<div class="ai-status" id="camMeta" style="padding:0 12px 5px;color:#6e96a9;font:8px Consolas,monospace"></div>'
    + '<label style="display:flex;gap:8px;align-items:center;margin:8px 12px"><input id="camAutoStop" type="checkbox" checked> <span class="cam-hint-label" style="font:8px Consolas,monospace;color:#9bb9c8">STOP CAMERA WHEN THE JARVIS WINDOW HIDES</span></label>'
    + '<div class="model-row" style="margin:5px 12px"><button class="chip" id="camClear" title="Forget the previously captured frame for follow-ups">CLEAR CONTEXT</button><button class="chip" id="camOpenSettings">CAMERA SETTINGS</button></div>'
    + '<small style="display:block;margin:3px 12px 10px;color:#668596;line-height:1.5;font-size:8px">The camera starts only on CONNECT and never resumes after a restart. Frames are analyzed on this computer with the local vision model; nothing is streamed or recorded.</small>';
  document.querySelector('.side').insertBefore(cameraPanel, visionPanel);
  const camModeDefaults = { identify: 'What is this object in front of the camera?', readtext: 'Read all clearly visible text, labels, and markings in the frame.', explain: 'How does this object work, and what is it used for?', compare: 'Compare the visible objects in front of the camera.', scene: 'Describe the scene in front of the camera.' };
  let camStream = null, camQualityTimer = 0, camBusy = false, lastCamFrame = '', lastCamAt = 0;
  let camTargetInfo = null; // { label, confidence, at }
  // Frame-freshness detection: camFramesFrozen is true whenever the open
  // camera has stopped delivering new frames (or is closed). The period is
  // configurable so an older camera that only delivers slowly can be tuned.
  let camFramesFrozen = true, camLastVideoTime = -1, camLastFrameAt = 0;
  // Bumped on every connect/disconnect so an attempt that is superseded (or
  // cancelled while it waits for permission) can never open a second stream
  // or pop the camera back on after the user closed it.
  let camConnectEpoch = 0;
  const camConnectTimeoutMs = 15000;
  const camPlayTimeoutMs = 5000;
  const camFrozenAfterMs = (() => { try { return Math.max(800, Number(localStorage.getItem('jarvis-cam-frozen-ms')) || 2000); } catch { return 2000; } })();
  const camVideo = $('#camVideo'), camStage = $('#camStage');
  let camStageName = 'OFF', camTimerHandle = 0, camSendStartedAt = 0;
  function camHudStage(name) {
    // Real states only: every transition below is driven by an actual capture
    // or model event — the HUD never shows SCANNING or a target before the
    // model has actually answered.
    camStageName = name;
    const labels = { OFF: 'SYSTEM OFFLINE', INITIALIZING: 'INITIALIZING', LIVE: 'SCANNER ACTIVE', CAPTURING: 'CAPTURING FRAME', SENDING: 'ANALYZING — LOCAL MODEL', TRACKING: 'TARGET LOCKED', COMPLETE: 'ANALYSIS COMPLETE', ERROR: 'ANALYSIS FAILED' };
    const state = $('#camState'); if (state) state.textContent = labels[name] || name;
    cameraPanel.classList.toggle('cam-hud', name !== 'OFF' && name !== 'INITIALIZING');
    cameraPanel.classList.toggle('cam-scan', name === 'CAPTURING' || name === 'SENDING');
    cameraPanel.classList.toggle('cam-track', name === 'TRACKING');
    if (camTimerHandle) { clearInterval(camTimerHandle); camTimerHandle = 0; }
    const timer = $('#camTimer');
    if (name === 'SENDING') {
      camSendStartedAt = Date.now();
      if (timer) { timer.textContent = '0.0s'; camTimerHandle = setInterval(() => { if (timer) timer.textContent = `${((Date.now() - camSendStartedAt) / 1000).toFixed(1)}s`; }, 100); }
    } else if (timer && name !== 'CAPTURING') timer.textContent = name === 'COMPLETE' && camSendStartedAt ? `${((Date.now() - camSendStartedAt) / 1000).toFixed(1)}s` : '';
    camSetStatus(name === 'LIVE' ? 'LIVE' : name === 'SENDING' || name === 'CAPTURING' || name === 'INITIALIZING' ? 'CHECKING' : name === 'ERROR' ? 'ERROR' : name === 'COMPLETE' ? 'ON' : name === 'TRACKING' ? 'TRACK' : 'OFF');
    // Update target info display
    const targetInfo = $('#camTargetInfo');
    if (targetInfo) {
      if (name === 'TRACKING' && camTargetInfo) {
        targetInfo.textContent = `TARGET: ${camTargetInfo.label} | CONF: ${(camTargetInfo.confidence * 100).toFixed(0)}%`;
      } else if (name === 'COMPLETE' && camTargetInfo) {
        targetInfo.textContent = `LAST: ${camTargetInfo.label} @ ${((Date.now() - camTargetInfo.at) / 1000).toFixed(1)}s ago`;
      } else {
        targetInfo.textContent = 'TARGET: NONE';
      }
    }
    // Show/hide target brackets on reticle
    const brackets = $('#camBrackets');
    if (brackets) brackets.style.opacity = (name === 'TRACKING' && camTargetInfo) ? '1' : '0';
  }
  function camSetStatus(state, text) {
    const pill = $('#camLive');
    pill.textContent = state;
    pill.style.color = state === 'LIVE' || state === 'ON' ? 'var(--mint)' : state === 'BUSY' || state === 'CHECKING' ? 'var(--cyan)' : state === 'ERROR' ? 'var(--red)' : '#7fa9ba';
    if (text) $('#camHint').textContent = text;
  }
  function friendlyCameraError(error) {
    const name = error?.name || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Camera permission was denied. Allow it in the browser prompt, or check Windows Settings › Privacy › Camera, then press CONNECT again.';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No webcam was found on this computer. Connect one, then press REFRESH.';
    if (name === 'NotReadableError' || name === 'TrackStartError') return 'The camera is busy — another app (Teams, Zoom, OBS, another browser) is probably using it. Close that app or pick a different camera.';
    if (name === 'OverconstrainedError') return 'The selected camera does not support the requested resolution. Press CONNECT again to use its default.';
    if (name === 'CameraTimeout') return `The camera did not start within ${Math.round(camConnectTimeoutMs / 1000)} seconds. Approve the browser camera prompt (or allow this site under Windows Settings › Privacy › Camera) and press CONNECT again.`;
    if (name === 'CameraNoPicture') return `The camera opened but no picture arrived within ${Math.round(camPlayTimeoutMs / 1000)} seconds. Check that the lens is not covered or in use by another app, then press CONNECT again.`;
    return `Camera error: ${String(error?.message || name || error).slice(0, 150)}`;
  }
  async function cameraListDevices() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) { $('#camHint').textContent = 'Camera APIs are unavailable in this window.'; return []; }
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      const select = $('#camDevice'), remembered = select.value;
      select.replaceChildren();
      if (!devices.length) { const o = document.createElement('option'); o.value = ''; o.textContent = 'No camera detected'; select.append(o); return []; }
      for (const d of devices) { const o = document.createElement('option'); o.value = d.deviceId || ''; o.textContent = d.label || `Camera ${devices.indexOf(d) + 1}`; select.append(o); }
      if (devices.some(d => (d.deviceId || '') === remembered)) select.value = remembered;
      return devices;
    } catch (error) { $('#camHint').textContent = `Device list failed: ${String(error.message).slice(0, 120)}`; return []; }
  }
  function startCamQualityWatcher() {
    stopCamQualityWatcher();
    const probe = document.createElement('canvas'); probe.width = 64; probe.height = 36;
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    camQualityTimer = setInterval(() => {
      if (!camStream) return;
      // Freshness probe: a healthy feed advances <video>.currentTime. If it
      // stops advancing while the camera is still open the feed is frozen.
      const clock = camVideo.currentTime;
      if (clock !== camLastVideoTime) { camLastVideoTime = clock; camLastFrameAt = Date.now(); if (camFramesFrozen) camSetFrozen(false); }
      else if (camLastFrameAt && Date.now() - camLastFrameAt > camFrozenAfterMs) camSetFrozen(true);
      if (!camVideo.videoWidth) return;
      try {
        pctx.drawImage(camVideo, 0, 0, 64, 36);
        const px = pctx.getImageData(0, 0, 64, 36).data;
        let sum = 0, edge = 0, n = px.length / 4;
        const lum = new Float32Array(n);
        for (let i = 0; i < n; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
        for (let i = 0; i < n; i++) sum += lum[i];
        const mean = sum / n;
        for (let y = 1; y < 36; y++) for (let x = 1; x < 64; x++) edge += Math.abs(lum[y * 64 + x] - lum[y * 64 + x - 1]) + Math.abs(lum[y * 64 + x] - lum[(y - 1) * 64 + x]);
        const hint = $('#camHint');
        if (mean < 32) { hint.textContent = 'TOO DARK — add light so JARVIS can recognize the object, Sir.'; hint.style.color = '#e8b04b'; }
        else if (mean > 235) { hint.textContent = 'TOO BRIGHT — reduce glare on the object, Sir.'; hint.style.color = '#e8b04b'; }
        else if (edge / n < 2.4) { hint.textContent = 'POSSIBLY BLURRY OR TOO FAR — hold the object closer or steadier, Sir.'; hint.style.color = '#e8b04b'; }
        else { hint.textContent = 'LIGHT AND FOCUS LOOK GOOD — ask away, Sir.'; hint.style.color = 'var(--mint)'; }
      } catch { /* frame raced the capture lifecycle */ }
    }, 800);
  }
  function stopCamQualityWatcher() { if (camQualityTimer) { clearInterval(camQualityTimer); camQualityTimer = 0; } }
  // Genuine frozen-frame state, shared by the HUD so the animation can never
  // claim frames are arriving when they are not.
  function camSetFrozen(frozen) {
    camFramesFrozen = Boolean(frozen);
    cameraPanel.classList.toggle('cam-frozen', camFramesFrozen);
    const frozenTag = $('#camFrozenTag');
    if (frozenTag) {
      frozenTag.style.display = camFramesFrozen ? 'block' : 'none';
    }
    const guard = $('#camGuard');
    if (guard) {
      guard.style.display = camFramesFrozen ? 'block' : 'none';
    }
  }
  async function cameraConnect() {
    if (!navigator.mediaDevices?.getUserMedia) { camSetStatus('ERROR', 'Camera APIs are unavailable in this window.'); return { ok: false, message: 'Camera APIs are unavailable in this window.' }; }
    if (camStream && camStream.getTracks().some(track => track.readyState === 'live')) return { ok: true, alreadyConnected: true, message: 'The camera is already connected, Sir.' };
    // A stream object can outlive its tracks (device unplugged, OS reclaimed
    // the camera). Drop it instead of reporting a connection we do not have.
    if (camStream) { camStream.getTracks().forEach(track => track.stop()); camStream = null; }
    const epoch = ++camConnectEpoch;
    camHudStage('INITIALIZING');
    camSetStatus('CHECKING', 'Initializing the camera…');
    $('#camPlaceHolder').textContent = 'INITIALIZING…';
    try {
      const deviceId = $('#camDevice').value;
      const constraints = { audio: false, video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } } };
      // The permission prompt can hang indefinitely: bound the wait so the
      // panel can never be left on INITIALIZING forever.
      let waitTimer = 0;
      const pending = navigator.mediaDevices.getUserMedia(constraints);
      const stream = await Promise.race([
        pending,
        new Promise((_, reject) => { waitTimer = setTimeout(() => { camConnectEpoch++; const e = new Error('The camera did not respond in time.'); e.name = 'CameraTimeout'; reject(e); }, camConnectTimeoutMs); })
      ]);
      clearTimeout(waitTimer);
      // A stream from a cancelled or superseded attempt is stopped, not leaked.
      pending.then(s => { if (epoch !== camConnectEpoch) s.getTracks().forEach(track => track.stop()); }).catch(() => {});
      if (epoch !== camConnectEpoch) return { ok: false, message: 'The camera connection was cancelled before it opened, Sir.' };
      if (camStream) camStream.getTracks().forEach(track => track.stop());
      camStream = stream;
      camVideo.srcObject = stream;
      camVideo.style.display = 'block';
      // play() never settles when the device opens but delivers no picture
      // (privacy shutter, stalled driver), which left connect pending on
      // INITIALIZING forever while still holding the camera open.
      let playTimer = 0;
      const playOutcome = await Promise.race([
        camVideo.play().then(() => 'playing', () => 'playing'),
        new Promise(resolve => { playTimer = setTimeout(() => resolve('no-picture'), camPlayTimeoutMs); })
      ]);
      clearTimeout(playTimer);
      if (playOutcome === 'no-picture' && !camVideo.videoWidth) {
        const e = new Error('The camera opened but no picture arrived.');
        e.name = 'CameraNoPicture';
        throw e;
      }
      $('#camPlaceHolder').style.display = 'none';
      $('#camGuide').style.display = 'block';
      camHudStage('LIVE');
      camSetStatus('LIVE', 'LIVE PREVIEW — hold the object inside the circle, Sir.');
      await cameraListDevices();
      camLastVideoTime = -1; camLastFrameAt = Date.now(); camSetFrozen(false);
      startCamQualityWatcher();
      cameraPanel.classList.add('cam-blue');
      return { ok: true, message: `The camera is connected and the preview is live, Sir.${($('#camDevice').selectedOptions[0]?.textContent || '').trim() ? ` Using ${($('#camDevice').selectedOptions[0]?.textContent || '').trim()}.` : ''}` };
    } catch (error) {
      // Release anything this attempt captured, so a failed connect can never
      // hold the device open while the panel reports an error. (getUserMedia
      // failures happen before camStream is set, so this is a no-op there.)
      if (camStream) { camStream.getTracks().forEach(track => track.stop()); camStream = null; }
      camVideo.srcObject = null; camVideo.style.display = 'none';
      const message = friendlyCameraError(error);
      camHudStage('ERROR');
      camSetStatus('ERROR', message);
      $('#camPlaceHolder').style.display = 'grid';
      $('#camPlaceHolder').textContent = 'CAMERA OFF — press CONNECT when you want JARVIS to look.';
      return { ok: false, message };
    }
  }
  function cameraDisconnect(reason = 'Camera disconnected.') {
    camConnectEpoch++; // cancel any connect still waiting on permission or the device
    stopCamQualityWatcher();
    if (camStream) { camStream.getTracks().forEach(track => track.stop()); camStream = null; }
    camVideo.srcObject = null; camVideo.style.display = 'none';
    $('#camPlaceHolder').style.display = 'grid';
    $('#camPlaceHolder').textContent = 'CAMERA OFF — press CONNECT when you want JARVIS to look.';
    $('#camGuide').style.display = 'none';
    camHudStage('OFF');
    camTargetInfo = null;
    camLastVideoTime = -1; camLastFrameAt = 0;    camSetFrozen(false);
    camHideFrozenFrame();
    const frozenTag = $('#camFrozenTag'); if (frozenTag) frozenTag.style.display = 'none';
    const guard = $('#camGuard'); if (guard) guard.style.display = 'none';
    const stripAfterClose = $('#camResultStrip'); if (stripAfterClose) stripAfterClose.style.display = 'none';
    cameraPanel.classList.remove('cam-blue');
    camSetStatus('OFF', reason);
    return { ok: true, message: reason === 'Camera disconnected.' ? 'The camera is disconnected, Sir.' : reason };
  }
  // Wait for the video element to have a valid frame before capturing.
  // Returns a Promise that resolves when videoWidth > 0, or rejects after timeout.
  async function waitForVideoFrame(timeoutMs = 3000) {
    if (!camStream) throw new Error('CameraNotConnected');
    if (camVideo.videoWidth > 0) return; // already ready
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('CameraNoFrames'));
      }, timeoutMs);
      function onReady() {
        if (camVideo.videoWidth > 0) {
          cleanup();
          resolve();
        }
      }
      function cleanup() {
        clearTimeout(timer);
        camVideo.removeEventListener('loadedmetadata', onReady);
        camVideo.removeEventListener('canplay', onReady);
      }
      camVideo.addEventListener('loadedmetadata', onReady);
      camVideo.addEventListener('canplay', onReady);
    });
  }

  async function cameraCaptureFrame() {
    await waitForVideoFrame();
    if (!camStream) throw new Error('CameraNotConnected');
    if (!camVideo.videoWidth) throw new Error('CameraNoFrames');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1280 / camVideo.videoWidth);
    canvas.width = Math.round(camVideo.videoWidth * scale); canvas.height = Math.round(camVideo.videoHeight * scale);
    canvas.getContext('2d').drawImage(camVideo, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.86);
  }
  // Show the captured frame as a frozen still in the UI.
  function camShowFrozenFrame(imageDataUrl) {
    let img = $('#camFrozenFrame');
    if (!img) {
      img = document.createElement('img');
      img.id = 'camFrozenFrame';
      img.style.cssText = 'max-width:100%;height:auto;border:2px solid #3a5a6d;border-radius:4px;background:#0a1a20;box-shadow:0 0 12px rgba(0,200,255,0.15);display:block;margin:6px auto 0;';
      const answerArea = $('#camAnswer');
      if (answerArea && answerArea.parentNode) answerArea.parentNode.insertBefore(img, answerArea.nextSibling);
    }
    img.src = imageDataUrl;
    img.style.display = 'block';
  }

  function camHideFrozenFrame() {
    const img = $('#camFrozenFrame');
    if (img) img.style.display = 'none';
  }

  // Display a camera result or status line in the panel. Restored: this
  // function had been deleted while its call sites were left in place, which
  // made every camera control throw before it could do any work.
  function camAnswerShow(text, meta = {}) {
    const area = $('#camAnswer');
    const body = String(text || '').trim();
    area.textContent = body || 'No answer was returned.';
    area.style.color = /fail|error|denied|not found|unavailable|unable|too (?:dark|blurry|far|large)|no answer/i.test(body) ? '#ffb9c4' : '#c3e2ec';
    // Declared at function scope: the frozen-frame styling further down (which
    // sits outside the strip block) also reads it. Keeping this inside the
    // `if (body)` branch made every call with a visible frozen frame throw
    // "uncertain is not defined" and abort the whole camera action.
    const uncertain = /cannot (?:identify|tell|determine|be (?:sure|certain))|not (?:clear|sure|certain)|too (?:dark|blurry|far|large)|unable to/i.test(body);
    const strip = $('#camResultStrip');
    if (strip) {
      if (body) {
        strip.textContent = (uncertain ? '⚠ NO CONFIDENT TARGET — ' : '◎ ') + (body.length > 160 ? `${body.slice(0, 160)}…` : body);
        strip.style.color = uncertain ? '#e8b04b' : '#cfeefb';
        strip.style.display = 'block';
      } else strip.style.display = 'none';
    }
    const frozenFrame = $('#camFrozenFrame');
    if (frozenFrame && frozenFrame.style.display !== 'none') {
      frozenFrame.style.borderColor = uncertain ? '#1d627a' : '#1d627a';
      frozenFrame.style.boxShadow = uncertain ? '0 0 10px #1d627a55' : '0 0 16px #1d627a55';
    }
    $('#camMeta').textContent = [meta.model ? `local model: ${meta.model}` : '', meta.mode ? `mode: ${meta.mode}` : '', meta.followUp ? 'same-frame follow-up' : (meta.capturedAt ? `frame: ${new Date(meta.capturedAt).toLocaleTimeString()}` : ''), meta.savedPath ? `saved: ${meta.savedPath}` : ''].filter(Boolean).join('  ·  ');
  }
  // Check if a vision-capable model is available before starting analysis.
  // A failed or timed-out probe is INCONCLUSIVE and must not block analysis:
  // the server runs the same check authoritatively and replies with the real
  // reason. Blocking here is what made the first ANALYZE click fail while the
  // second (warmer) one succeeded.
  async function camCheckVisionModel() {
    try {
      const status = await localAction({ action: 'screen-status' });
      if (status?.visionModels?.length) return { ok: true, models: status.visionModels };
      // Use /api/ai/status which returns Ollama models with capabilities
      const aiStatus = await fetch('/api/ai/status', { cache: 'no-store', signal: AbortSignal.timeout(4000) }).then(r => r.json()).catch(() => ({ ok: false }));
      // Ollama unreachable/errored, or the request timed out (cold start):
      // let the analysis proceed and let the server report the true error.
      if (aiStatus?.ok === false || !Array.isArray(aiStatus?.models)) return { ok: true, models: [], inconclusive: true };
      const vision = aiStatus.models.filter(m => Array.isArray(m.capabilities) && m.capabilities.includes('vision')).map(m => m.name);
      return vision.length ? { ok: true, models: vision } : { ok: false, message: 'No locally installed Ollama model supports image analysis. Install a vision model (for example: ollama pull qwen3.5:4b), then press Refresh in AI Settings. JARVIS will not send frames to a cloud service.' };
    } catch {
      return { ok: true, models: [], inconclusive: true };
    }
  }
  async function cameraAsk(question, mode, preferFollow = false) {
    // Camera analysis reuses the local screen-vision pipeline, so honor the
    // same enabled setting. Only a definite "disabled" blocks; a transient
    // status failure falls through and the server answers honestly.
    const status = await localAction({ action: 'screen-status' });
    if (status && status.enabled === false) return { ok: false, message: 'Local analysis is disabled in the Screen Vision card; camera analysis uses the same local pipeline, Sir.' };
    if (camBusy) return { ok: false, message: 'I am still analyzing the previous frame. One moment, Sir.' };
    const wanted = (mode || $('#camMode')?.value || 'identify');
    const asked = String(question || '').trim() || camModeDefaults[wanted] || camModeDefaults.identify;
    const freshFollow = preferFollow && lastCamAt && (Date.now() - lastCamAt < 10 * 60 * 1000) && lastCamFrame;
    if (!camStream && !freshFollow) return { ok: false, needsCamera: true, message: 'The camera is not connected. Say "Jarvis, connect to my webcam" or press CONNECT first, Sir — I will not turn it on silently.' };
    
    // Pre-check vision model availability for fresh captures (not follow-ups)
    if (!freshFollow) {
      const visionCheck = await camCheckVisionModel();
      if (!visionCheck.ok) {
        camHudStage('ERROR');
        camAnswerShow(visionCheck.message, { model: '' });
        return { ok: false, message: visionCheck.message };
      }
    }
    
    camBusy = true;        camHudStage(freshFollow ? 'SENDING' : 'CAPTURING');
    // Dynamic status text based on AI router mode (local vs remote)
    const router = latestAIStatus && latestAIStatus.router ? latestAIStatus.router : null;
    const remoteFirst = Boolean(router && router.mode !== 'local' && Array.isArray(router.remoteEligible) && router.remoteEligible.length);
    const remotePretty = { opencode: 'OpenCode', openrouter: 'OpenRouter', freebuff: 'remote AI' };
    const aiRouteName = remoteFirst ? (remotePretty[router.remoteEligible[0]] || 'remote AI') : '';
    const statusText = freshFollow
      ? (aiRouteName ? `Sending follow-up to ${aiRouteName}…` : 'Sending follow-up to local model…')
      : (aiRouteName ? `Capturing a frame and sending to ${aiRouteName}…` : 'Capturing a frame and analyzing it locally…');
    $('#camAnswer').textContent = statusText;
    cameraPanel.classList.add('cam-blue');
    camHideFrozenFrame();
    try {
      let result;
      if (freshFollow) {
        // Send the cached frame so the server can route through the AI gateway
        result = await localAction({ action: 'camera-follow', question: asked, imageB64: lastCamFrame });
        if (result.stale && camStream) result = await analyzeFresh();
      } else result = await analyzeFresh();
      async function analyzeFresh() {
        const imageB64 = await cameraCaptureFrame();
        // Show the frozen frame immediately so user sees what was captured
        camShowFrozenFrame(imageB64); // cameraCaptureFrame() already returns a data URL
        camHudStage('SENDING');
        const response = await fetch('/api/camera/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageB64, question: asked, mode: wanted }), signal: AbortSignal.timeout(600000) });
        const parsed = await response.json();
        if (parsed.ok) { lastCamFrame = imageB64; lastCamAt = Date.now(); }
        return parsed;
      }
      camHudStage(result?.ok ? (result.target ? 'TRACKING' : 'COMPLETE') : 'ERROR');
      camAnswerShow(result.response || result.message || 'The analysis did not return an answer.', result);
      if (result.ok && result.target) {
        // Target detected - enter tracking mode
        camTargetInfo = { label: result.target, confidence: result.confidence || 0.8, at: Date.now() };
      }
      // Return structured response for the normal speech pipeline.
      // The voice-command path (reply -> ask -> speak) and UI button path
      // both use this. Do NOT call speak() here — let the centralized
      // speech controller handle it to avoid duplicate/conflicting playback.
      if (result.ok) {
        return { 
          ok: true, 
          response: result.response, 
          speech_text: result.response, 
          emotion: 'neutral', 
          emotion_intensity: 0.5, 
          speaking_rate: 1,
          model: result.model,
          mode: result.mode,
          followUp: result.followUp,
          capturedAt: result.capturedAt,
          followUpSupported: result.followUpSupported
        };
      }
      return result;
    } catch (error) {
      const message = error?.name === 'CameraNotConnected' ? 'The camera is not connected. Press CONNECT first, Sir.' : error?.name === 'CameraNoFrames' ? 'The camera has not produced a frame yet. Check the preview and try again.' : (error?.name === 'AbortError' || error?.name === 'TimeoutError') ? 'The vision model did not answer in time. The first analysis after a quiet period must reload the local vision model, which can take several minutes on this CPU — try ANALYZE again and keep the JARVIS window open.' : `Camera analysis failed: ${String(error.message).slice(0, 150)}`;
      camHudStage('ERROR');
      camAnswerShow(message, { model: '' });
      camHideFrozenFrame();
      return { ok: false, message };
    } finally {
      camBusy = false;
      if (camStream && camStageName !== 'COMPLETE' && camStageName !== 'ERROR') camHudStage('LIVE');
      else if (!camStream) camHudStage('OFF');
    }
  }
  async function cameraSaveActiveFrame({ imageB64 } = {}) {
    let frame = imageB64 || lastCamFrame;
    if (!frame && camStream) { try { frame = await cameraCaptureFrame(); } catch { frame = ''; } }
    if (!frame) return { ok: false, message: 'There is no camera frame to save yet. Connect and analyze first, Sir.' };
    try {
      const response = await fetch('/api/camera/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageB64: frame }), signal: AbortSignal.timeout(30000) });
      const result = await response.json();
      const savedPath = result.path || result.savedPath;
      if (savedPath) camAnswerShow(`${result.message || 'Frame saved.'}\n${savedPath}`, { savedPath });
      else if (!result.ok) camAnswerShow(result.message || 'That frame could not be saved.', {});
      notify?.(result.ok ? (result.message || 'Frame saved.') : (result.message || 'Could not save the frame.'));
      return result;
    } catch (error) { return { ok: false, message: `Saving the frame failed: ${String(error.message).slice(0, 150)}` }; }
  }
  function camEnterVisionMode() {
    cameraPanel.classList.add('cam-vision');
    cameraPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (camStream && camStageName === 'LIVE') camHudStage('LIVE');
  }
  function camExitVisionMode() {
    cameraPanel.classList.remove('cam-vision');
    const strip = $('#camResultStrip'); if (strip) strip.style.display = 'none';
    if ($('#camAutoStop').checked && camStream) return cameraDisconnect('Vision mode closed — the camera stopped, Sir.');
    camHudStage(camStream ? 'LIVE' : 'OFF');
    return { ok: true, message: 'Vision mode closed. The normal interface is back, Sir.' };
  }
  $('#camConnect').onclick = async () => { const r = await cameraConnect(); if (!r.ok) notify?.(r.message); if (!r.alreadyConnected) camAnswerShow(r.message, {}); };
  $('#camDisconnect').onclick = () => { const result = cameraDisconnect(); camAnswerShow(result.message, {}); };
  $('#camReloadDevices').onclick = async () => { const devices = await cameraListDevices(); notify?.(devices.length ? `${devices.length} camera(s) found.` : 'No camera detected.'); };
  $('#camFreeze').onclick = async () => { try { const frame = await cameraCaptureFrame(); lastCamFrame = frame; lastCamAt = Date.now(); camShowFrozenFrame(frame); camAnswerShow('Frame frozen. Use SAME FRAME to analyze it, or ANALYZE for a fresh one.', {}); } catch (error) { camAnswerShow(`Could not freeze a frame: ${String(error.message).slice(0, 120)}`, {}); } };
  $('#camAsk').onclick = async () => { camEnterVisionMode(); const r = await cameraAsk('', $('#camMode').value, false); if (r.needsCamera) notify?.(r.message); else if (r.ok) { const turn = ++assistantTurn; await speak(r.response, turn, r.followUp, r.emotion || 'neutral', r.emotion_intensity ?? 0.5, r.speech_text || r.response, r.speaking_rate || 1); } };
  $('#camAskBtn').onclick = async () => { camEnterVisionMode(); const r = await cameraAsk($('#camQuestion').value.trim(), $('#camMode').value, false); if (r.needsCamera) notify?.(r.message); else if (r.ok) { const turn = ++assistantTurn; await speak(r.response, turn, r.followUp, r.emotion || 'neutral', r.emotion_intensity ?? 0.5, r.speech_text || r.response, r.speaking_rate || 1); } };
  $('#camFollowBtn').onclick = async () => { camEnterVisionMode(); const r = await cameraAsk($('#camQuestion').value.trim(), $('#camMode').value, true); if (r.needsCamera) notify?.(r.message); else if (r.ok) { const turn = ++assistantTurn; await speak(r.response, turn, r.followUp, r.emotion || 'neutral', r.emotion_intensity ?? 0.5, r.speech_text || r.response, r.speaking_rate || 1); } };
  $('#camSave').onclick = () => cameraSaveActiveFrame();
  $('#camClear').onclick = async () => { const r = await localAction({ action: 'camera-clear' }); lastCamFrame = ''; lastCamAt = 0; camAnswerShow(r.message || 'Camera context cleared.', {}); };
  $('#camOpenSettings').onclick = () => notify?.('Pick the camera in the selector above; Windows camera permissions live in Settings › Privacy › Camera.');
  $('#camAutoStop').onchange = () => { try { localStorage.setItem('jarvis-cam-autostop', $('#camAutoStop').checked ? '1' : '0'); } catch {} };
  try { $('#camAutoStop').checked = localStorage.getItem('jarvis-cam-autostop') !== '0'; } catch {}
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && $('#camAutoStop').checked && camStream) cameraDisconnect('Camera stopped automatically because the JARVIS window was hidden.');
  });
  window.addEventListener('beforeunload', () => { if (camStream) camStream.getTracks().forEach(track => track.stop()); });
  cameraListDevices();
  // Reachable from the voice command pipeline.
  window.JarvisCamera = {
    connect: cameraConnect,
    disconnect: () => cameraDisconnect(),
    ask: (question, mode, preferFollow) => cameraAsk(question, mode, preferFollow === undefined ? true : preferFollow),
    save: () => cameraSaveActiveFrame(),
    setMode: m => { const s = $('#camMode'); if (s && m) s.value = m; },
    isConnected: () => Boolean(camStream),
    enterVision: camEnterVisionMode,
    exitVision: camExitVisionMode,
    retry: () => cameraAsk($('#camQuestion').value.trim(), $('#camMode').value, false),
    stage: () => camStageName,
    frameFresh: () => Boolean(camStream) && !camFramesFrozen && camLastFrameAt > 0,
    panel: cameraPanel
  };
  const aiModel = $('#aiModel'), aiStatusText = $('#aiStatusText');
  let latestAIStatus = null;
  aiModel.onchange = () => { localStorage.setItem('jarvis-ai-model', aiModel.value); localStorage.setItem('jarvis-ai-model-preferred', aiModel.value); };
  // Foreground application info for the Situation Engine. Kept app-side and
  // explicit: we only inspect the foreground window title/process identity to
  // infer likely activity. We do not capture the screen, read window contents,
  // or record audio for this purpose.
  let foregroundApp = { name: '', title: '', source: 'unknown', at: 0 };
  let foregroundAppTimer = 0;
  async function refreshForegroundApp() {
    try {
      const response = await fetch('/api/apps/foreground', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) { foregroundApp.source = 'unavailable'; return; }
      const data = await response.json().catch(() => null);
      if (!data || typeof data !== 'object') { foregroundApp.source = 'unavailable'; return; }
      foregroundApp = {
        name: String(data.name || '').trim(),
        title: String(data.title || '').trim(),
        source: data.source || 'windows',
        at: Date.now()
      };
    } catch { foregroundApp.source = 'unavailable'; }
  }
  function startForegroundAppPolling() {if (foregroundAppTimer) return;
    refreshForegroundApp();
    foregroundAppTimer = setInterval(refreshForegroundApp, 4000);
  }
  function stopForegroundAppPolling() {if (foregroundAppTimer) { clearInterval(foregroundAppTimer); foregroundAppTimer = 0; }
  }

  async function refreshAIStatus() {
    try {
      const status = await fetch('/api/ai/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) }).then(response => response.json());
      latestAIStatus = status;
      const remembered = localStorage.getItem('jarvis-ai-model-preferred');
      aiModel.replaceChildren();
      if (status.models.length) {
        for (const item of status.models) { const option = document.createElement('option'); option.value = item.name; option.textContent = `${item.name}${item.parameterSize ? ` - ${item.parameterSize}` : ''}`; aiModel.append(option); }
        const recommendedInstalled = status.models.some(item => item.name === status.recommendation.model);
        aiModel.value = status.models.some(item => item.name === remembered) ? remembered : recommendedInstalled ? status.recommendation.model : status.models[0].name;
        localStorage.setItem('jarvis-ai-model', aiModel.value);
if (!remembered) localStorage.setItem('jarvis-ai-model-preferred', aiModel.value);
        aiStatusText.textContent = `Ollama is running - ${status.models.length} installed model${status.models.length === 1 ? '' : 's'}. Press TEST MODEL before your first question. ${status.hardware.cpu}, ${status.hardware.ramGB} GB RAM.`;
        aiStatusText.className = 'ai-status';
      } else {
        const option = document.createElement('option'); option.value = status.recommendation.model; option.textContent = `Suggested: ${status.recommendation.model}`; aiModel.append(option);
        aiModel.value = status.recommendation.model;
        aiStatusText.textContent = status.message;
        aiStatusText.className = 'ai-status ai-error';
      }
      $('#aiSetup').textContent = status.models.length
        ? `Recommended for this computer: ${status.recommendation.model}. ${status.recommendation.reason} AI chat stays on this PC; no cloud fallback.`
        : `Recommended for this computer: ${status.recommendation.model}. ${status.recommendation.reason} Start Ollama, then use GET SMALLER MODEL here to install it.`;
      const router = status.router || null;
      if (router) applyRouterView(router);
      const smallerButton = $('#aiSmaller');
      const smallerInstalled = status.models.some(item => item.name === 'qwen3:1.7b');
      smallerButton.disabled = !status.running || status.recommendation.model !== 'qwen3:1.7b' && !smallerInstalled;
      smallerButton.textContent = smallerInstalled ? 'USE QWEN3 1.7B' : status.running ? 'GET SMALLER - 1.4 GB' : 'OLLAMA OFFLINE';
      voiceLog('Ollama status', status.running ? `${status.models.length} model(s) detected` : status.message);
      return status;
    } catch (error) {
      latestAIStatus = null;
      $('#aiSmaller').disabled = true;
      aiStatusText.textContent = `Could not check Ollama: ${error.message}`; aiStatusText.className = 'ai-status ai-error';
      voiceLog('Ollama status failed', error.message); return null;
    }
  }
  $('#aiRefresh').onclick = refreshAIStatus;
  // AI ROUTE controls (provider router): mode select + remote key entry.
  // The key is sent once to /api/action and never displayed after saving;
  // status views show only a masked prefix…suffix from the server.
  const modeSelect = $('#aiMode'), remoteStatus = $('#aiRemoteStatus'), zenKey = $('#aiZenKey'), orKey = $('#aiOrKey');
  function applyRouterView(router) {
    if (!modeSelect || !remoteStatus || !router) return;
    if ([...modeSelect.options].some(option => option.value === router.mode)) modeSelect.value = router.mode;
    const providers = router.providers || {};
    const lines = [];
    if (router.mode === 'local') lines.push('LOCAL AI ONLY — remote AI is never contacted, even with a saved key.');
    else {
      const configuredList = [];
      if (router.configured && router.configured.opencode) configuredList.push(`OpenCode (${router.masked.opencodeModel || 'free model'}, key ${router.masked.opencodeKey || 'saved'})`);
      if (router.configured && router.configured.openrouter) configuredList.push(`OpenRouter (${router.masked.openrouterModel || ':free model'}, key ${router.masked.openrouterKey || 'saved'})`);
      const el = providers.opencode || {}, gl = providers.openrouter || {};
      const stats = [];
      if (el.calls) stats.push(`OpenCode ${el.ok} OK / ${el.failed} failed, avg ${(el.avgLatencyMs / 1000).toFixed(1)}s`);
      if (gl.calls) stats.push(`OpenRouter ${gl.ok} OK / ${gl.failed} failed, avg ${(gl.avgLatencyMs / 1000).toFixed(1)}s`);
      lines.push(configuredList.length
        ? `AUTOMATIC — ${configuredList.join(' then ')}, Ollama as fallback.${stats.length ? ` ${stats.join('; ')}.${el.coolingDown || gl.coolingDown ? ' Cooling down after errors: yes.' : ''}` : ''}`
        : 'AUTOMATIC — no remote provider configured yet, so everything runs locally on Ollama. Add an OpenCode or OpenRouter API key below to enable faster cloud replies; until then behavior is identical to before.');
    }
    remoteStatus.textContent = lines.join(' ');
    remoteStatus.className = 'ai-status';
  }
  modeSelect.onchange = async () => {
    modeSelect.disabled = true;
    try {
      const result = await localAction({ action: 'ai-config-set', mode: modeSelect.value });
      if (result && result.gateway) applyRouterView(result.gateway);
      if (remoteStatus && result && result.message) remoteStatus.textContent = result.message;
    } catch (error) { if (remoteStatus) remoteStatus.textContent = `Saving the mode failed: ${error.message}`; }
    finally { modeSelect.disabled = false; }
  };
  $('#aiZenSave').onclick = async () => {
    const button = $('#aiZenSave');
    button.disabled = true;
    try {
      const result = await localAction({ action: 'ai-key-set', zenKey: zenKey.value.trim() });
      if (result.ok) zenKey.value = '';
      if (result.gateway) applyRouterView(result.gateway);
      if (remoteStatus) remoteStatus.textContent = result.message || (result.ok ? 'API key saved.' : 'Key not saved.');
    } catch (error) { if (remoteStatus) remoteStatus.textContent = `Saving the key failed: ${error.message}`; }
    finally { button.disabled = false; }
  };
  $('#aiOrSave').onclick = async () => {
    const button = $('#aiOrSave');
    button.disabled = true;
    try {
      const result = await localAction({ action: 'ai-key-set', openrouterKey: orKey.value.trim() });
      if (result.ok) orKey.value = '';
      if (result.gateway) applyRouterView(result.gateway);
      if (remoteStatus) remoteStatus.textContent = result.message || (result.ok ? 'OpenRouter API key saved.' : 'Key not saved.');
    } catch (error) { if (remoteStatus) remoteStatus.textContent = `Saving the key failed: ${error.message}`; }
    finally { button.disabled = false; }
  };
  $('#aiSmaller').onclick = async () => {
    const button = $('#aiSmaller'), targetModel = 'qwen3:1.7b';if (!latestAIStatus?.running) { aiStatusText.textContent = 'Start Ollama first, then press REFRESH.'; return; }if (latestAIStatus.models.some(item => item.name === targetModel)) {
      aiModel.value = targetModel; aiModel.dispatchEvent(new Event('change', { bubbles: true }));
      aiStatusText.textContent = 'SMALLER MODEL SELECTED - qwen3:1.7b'; aiStatusText.className = 'ai-status ai-ready';
      return;
    }
    button.disabled = true; button.textContent = 'DOWNLOADING...';
    aiStatusText.textContent = 'Downloading qwen3:1.7b from Ollama. This is about 1.4 GB; JARVIS will select it when the download finishes.';
    try {
      const response = await fetch('/api/ai/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: targetModel }), signal: AbortSignal.timeout(30 * 60 * 1000) });
      if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.message || `Download failed (${response.status}).`); }
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', completed = false;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) {
if (!line.trim()) continue;
          const event = JSON.parse(line);
if (event.error) throw new Error(event.error);
if (event.total && Number.isFinite(event.completed)) aiStatusText.textContent = `Downloading smaller model - ${Math.floor(100 * event.completed / event.total)}%`;
          else if (event.status) aiStatusText.textContent = `Downloading smaller model - ${event.status}`;
if (event.status === 'success') completed = true;
        }
      }
      if (!completed) throw new Error('Ollama ended the download before confirming success. Press REFRESH to check the model list.');
      localStorage.setItem('jarvis-ai-model-preferred', targetModel); localStorage.setItem('jarvis-ai-model', targetModel);
      await refreshAIStatus(); aiModel.value = targetModel;
      aiStatusText.textContent = 'SMALLER MODEL READY - qwen3:1.7b selected'; aiStatusText.className = 'ai-status ai-ready';
    } catch (error) {
      aiStatusText.textContent = `Smaller model setup failed: ${error.message}`; aiStatusText.className = 'ai-status ai-error';
    } finally { button.disabled = false; await refreshAIStatus(); }
  };
  $('#aiTest').onclick = async () => {
    const model = aiModel.value;if (!model) { aiStatusText.textContent = 'No local model selected. Install Ollama and a model first.'; return; }
    $('#aiTest').disabled = true; aiStatusText.textContent = `Testing ${model} locally...`;
    try {
      const response = await fetch('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(180000) });
      const result = await response.json();
      aiStatusText.textContent = result.ok ? `MODEL VERIFIED - ${model} replied: "${result.response.slice(0, 140)}"` : (result.message || 'Local model test failed.');
      aiStatusText.className = `ai-status ${result.ok ? 'ai-ready' : 'ai-error'}`;
      voiceLog(result.ok ? 'local model test passed' : 'local model test failed', result.message || model);
    } catch (error) { aiStatusText.textContent = `Model test failed: ${error.message}`; aiStatusText.className = 'ai-status ai-error'; voiceLog('local model test failed', error.message); }
    finally { $('#aiTest').disabled = false; }
  };
  refreshAIStatus();
  const providerSelect = $('#providerSelect');
  providerSelect.value = localStorage.getItem('jarvis-provider') || 'fish';
  $('#fishSetup').onclick = () => window.open('https://fish.audio/app/api-keys', '_blank', 'noopener');
  $('#fishPreview').onclick = () => { const turn = ++assistantTurn; speak('Good evening. JARVIS systems are online and ready.', turn); };
  $('#fishReveal').onclick = () => { const key = $('#fishKey'), reveal = key.type === 'password'; key.type = reveal ? 'text' : 'password'; $('#fishReveal').textContent = reveal ? 'HIDE KEY' : 'SHOW KEY'; };
  $('#fishSave').onclick = async () => {
    const saveButton = $('#fishSave'); saveButton.disabled = true; $('#fishStatus').textContent = 'Saving voice settings on this PC...';
    try {
      const response = await fetch('/api/voice/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: providerSelect.value, referenceId: $('#fishReferenceId').value.trim(), model: $('#fishModel').value.trim(), apiKey: $('#fishKey').value }), signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || 'Voice settings could not be saved.');
      $('#fishKey').value = ''; $('#fishKey').type = 'password'; $('#fishReveal').textContent = 'SHOW KEY';
      localStorage.setItem('jarvis-provider', result.config.provider); providerSelect.value = result.config.provider;
      $('#fishStatus').textContent = result.message; notify(result.message); await refreshFishStatus();
    } catch (error) { $('#fishStatus').textContent = error.message; notify(error.message); }
    finally { saveButton.disabled = false; }
  };
  providerSelect.onchange = () => { localStorage.setItem('jarvis-provider', providerSelect.value); refreshFishStatus(); };
  async function refreshFishStatus() {
    try {
      const config = await fetch('/api/config', { cache: 'no-store' }).then(response => response.json());
      if (!$('#fishReferenceId').value) $('#fishReferenceId').value = config.referenceId || '';
      if (!$('#fishModel').value) $('#fishModel').value = config.model || 's2.1-pro-free';
      $('#fishKey').placeholder = config.configured ? 'Saved key - leave blank to keep' : 'Paste your Fish Audio API key';
      if (providerSelect.value === 'local') { $('#fishStatus').textContent = 'Local voice active - Microsoft Zira Desktop'; setTtsStatus('LOCAL VOICE'); return; }
      if (!config.configured) { $('#fishStatus').textContent = 'Fish key not set. The local Windows voice will be used as a clear fallback.'; setTtsStatus('LOCAL FALLBACK'); return; }
      $('#fishStatus').textContent = 'Checking access to your selected Fish Audio voice...';
      const verification = await fetch('/api/fish-status', { cache: 'no-store' }).then(response => response.json());
      if (verification.voiceName) $('.fishVoiceName').textContent = verification.voiceName;
      $('#fishStatus').textContent = verification.message; setTtsStatus(verification.ok ? 'FISH AUDIO' : (config.fallback === 'local' ? 'LOCAL FALLBACK' : 'VOICE ERROR'));
    } catch { $('#fishStatus').textContent = 'The local service is unavailable. Check the JARVIS tray status.'; setTtsStatus('OFFLINE'); }
  }
  const voiceSelect = $('#voiceSelect'), speedControl = $('#speedControl'), volumeControl = $('#volumeControl');
  const continuousToggle = $('#continuousToggle'), speechLanguage = $('#speechLanguage'), noiseSuppressionToggle = $('#noiseSuppressionToggle');
  // Re-arm listening once after replacing Edge ASR with local Whisper; honor later mute choices.
  if (localStorage.getItem('jarvis-local-wake-v3') !== '1') {
    localStorage.setItem('jarvis-continuous', 'true');
    localStorage.setItem('jarvis-local-wake-v3', '1');
  }
  voiceSelect.value = localStorage.getItem('jarvis-voice') || 'female';
  const micGainControl = $('#micGainControl'); micGainControl.value = localStorage.getItem('jarvis-mic-gain') || '1.8'; $('#micGainReadout').textContent = `${Number(micGainControl.value).toFixed(1)}x`;
  const noiseGateControl = $('#noiseGateControl'); noiseGateControl.value = localStorage.getItem('jarvis-noise-gate') || '1.25'; $('#noiseGateReadout').textContent = `${Number(noiseGateControl.value).toFixed(1)}x`; speechGate.thresholdRatio = Number(noiseGateControl.value);
  speedControl.value = localStorage.getItem('jarvis-rate') || '0.93';
  volumeControl.value = localStorage.getItem('jarvis-volume') || '1';
  speechLanguage.value = localStorage.getItem('jarvis-speech-language') || 'en-US';
  noiseSuppressionToggle.checked = localStorage.getItem('jarvis-noise-suppression') !== 'false';
  continuousToggle.checked = localStorage.getItem('jarvis-continuous') !== 'false';
  const memoryWindowLabel = document.createElement('label');
  memoryWindowLabel.innerHTML = 'AI conversation context<select id="memoryWindow"><option value="8">8 messages</option><option value="12">12 messages</option><option value="18">18 messages</option></select>';
  settings.insertBefore(memoryWindowLabel, settings.querySelector('small'));
  $('#memoryWindow').value = localStorage.getItem('jarvis-ai-history') || '18';
  $('#memoryWindow').onchange = () => localStorage.setItem('jarvis-ai-history', $('#memoryWindow').value);
  const debugBox = document.createElement('details'); debugBox.className = 'debug-box'; debugBox.id = 'voiceDiagnostics';
    debugBox.innerHTML = '<summary>VOICE PIPELINE DIAGNOSTICS</summary><div class="debug-grid"><span>Voice state</span><span id="voiceStateDiagnostic">INITIALIZING</span><span>Microphone capture</span><span id="micDiagnostic">CHECKING</span><span>Mic device / format</span><span id="micFormatDiagnostic">unknown mic - unknown format</span><span>Speech recognition</span><span id="recognitionDiagnostic">CHECKING</span><span>Wake phrase</span><span id="wakeDiagnostic">Say "Jarvis" before your request</span><span>Raw ASR transcript</span><span id="rawTranscriptDiagnostic">-</span><span>Corrected transcript</span><span id="transcriptDiagnostic"> </span><span>Intent / entities</span><span id="intentDiagnostic">-</span><span>Confidence / policy</span><span id="policyDiagnostic">-</span><span>Stage timing</span><span id="stageDiagnostic">-</span><span>Input / noise level</span><span id="confidenceDiagnostic">Waiting for microphone</span></div><div class="debug-log" id="voiceLog"></div><div class="device-actions"><button class="chip" id="micTestBtn">MIC TEST</button><button class="chip" id="copyVoiceSnapshot">COPY SNAPSHOT</button></div><small>Whisper transcribes audio locally (base.en, English). Guarded correction fixes only likely proper-noun mishearings; the raw transcript is always kept. JARVIS does not record or save microphone audio or send it to a cloud speech service.</small>';
  settings.insertBefore(debugBox, settings.querySelector('small'));
  // Keep every identity surface in step with the theme (JARVIS / Karen /
  // Venom). A theme switch updates all of them at once, including the mask
  // labels and the one-time interaction hint.
  function refreshAssistantIdentity() {
    const venom = venomMode();
    const karen = karenMode();
    // Rebuild the audio wake detector so its threshold follows the mode.
    wakeSyllableDetector = null;
    document.body.dataset.assistant = venom ? 'venom' : karen ? 'karen' : 'jarvis';
    document.title = venom ? 'VENOM — Command Center' : karen ? 'K.A.R.E.N. — Command Center' : 'J.A.R.V.I.S. — Command Center';
    for (const el of document.querySelectorAll('#feed .msg .who')) {
      if (/^(?:J\.A\.R\.V\.I\.S\.|KAREN|VENOM)$/i.test(String(el.textContent || '').trim())) el.textContent = assistantName();
    }
    const wakeEl = $('#wakeDiagnostic');
    if (wakeEl && /before your request|for a new request/i.test(String(wakeEl.textContent || ''))) wakeEl.textContent = wakeHint();
    const captionEl = $('#caption');
    if (captionEl) captionEl.textContent = karenify(captionEl.textContent || '');
    // The small sidebar hint named "JARVIS" even in Karen mode, so the one
    // always-visible reminder contradicted the wake word the HUD was using.
    const voiceHintEl = $('#voiceHint');
    if (voiceHintEl) voiceHintEl.textContent = `PRIVATE OFFLINE SPEECH · SAY “${wakeName().toUpperCase()}”`;
    const alwaysLabel = continuousToggle && continuousToggle.parentElement;
    if (alwaysLabel && alwaysLabel.childNodes[0]) alwaysLabel.childNodes[0].nodeValue = `Always listen for "${wakeName()}"`;
    const karenMaskEl = document.querySelector('.karen-mask');
    if (karenMaskEl) {
      if (!karen) {
        karenMaskEl.classList.remove('mask-optics', 'mask-hint');
        karenMaskEl.setAttribute('aria-pressed', 'false');
        const cap = karenMaskEl.querySelector('.karen-mask-cap');
        if (cap) cap.textContent = 'KAREN · OPTICS';
      } else if (!karenMaskEl.classList.contains('mask-optics')) {
        // Point out the interaction once when Karen mode opens.
        karenMaskEl.classList.remove('mask-hint');
        void karenMaskEl.offsetWidth;
        karenMaskEl.classList.add('mask-hint');
        clearTimeout(karenMaskEl.hintTimer);
        karenMaskEl.hintTimer = setTimeout(() => karenMaskEl.classList.remove('mask-hint'), 6200);
      }
    }
    const venomMaskEl = document.querySelector('.venom-mask');
    if (venomMaskEl) {
      if (!venom) {
        venomMaskEl.classList.remove('mask-optics', 'mask-hint');
        venomMaskEl.setAttribute('aria-pressed', 'false');
        const cap = venomMaskEl.querySelector('.venom-mask-cap');
        if (cap) cap.textContent = 'VENOM · SYMBIOTE';
      } else if (!venomMaskEl.classList.contains('mask-optics')) {
        // Point out the interaction once when Venom mode opens.
        venomMaskEl.classList.remove('mask-hint');
        void venomMaskEl.offsetWidth;
        venomMaskEl.classList.add('mask-hint');
        clearTimeout(venomMaskEl.hintTimer);
        venomMaskEl.hintTimer = setTimeout(() => venomMaskEl.classList.remove('mask-hint'), 6200);
      }
    }
  }
  document.addEventListener('jarvis-theme-change', refreshAssistantIdentity);
  refreshAssistantIdentity();
  // Interactive Karen mask: the lenses follow the pointer across the core bay
  // and a click (or Enter/Space) snaps them into a focus blink. Scoped to the
  // Spider-Man palette by CSS, so JARVIS keeps its normal HUD.
  const karenMask = document.querySelector('.karen-mask');
  const coreStage = $('#core');
  if (karenMask) {
    // Click = persistent optics overlay, not a hidden blink: the mask grows, a
    // live readout panel slides in, the web lights up and a scan sweeps the
    // face. Clicking again retracts it. aria-pressed exposes the state.
    const opticsHint = karenMask.querySelector('.karen-mask-hint');
    const setKarenOptics = active => {
      karenMask.classList.toggle('mask-optics', active);
      karenMask.classList.remove('mask-hint');
      karenMask.setAttribute('aria-pressed', active ? 'true' : 'false');
      karenMask.setAttribute('aria-label', active
        ? 'Karen optics online - press to close the optics overlay'
        : 'Karen mask - press to open the optics overlay');
      const cap = karenMask.querySelector('.karen-mask-cap');
      if (cap) cap.textContent = active ? 'KAREN · OPTICS ONLINE' : 'KAREN · OPTICS';
      if (opticsHint) opticsHint.textContent = active ? 'CLICK TO CLOSE' : 'CLICK TO FOCUS';
    };
    // One shared lens-look routine: the lenses track the pointer anywhere over
    // the core bay OR the mask itself, so the head visibly "looks at" you
    // before you click it.
    const lookAt = (clientX, clientY) => {
      if (!karenMode()) return;
      const rect = karenMask.getBoundingClientRect();
      if (!rect.width) return;
      const dx = Math.max(-1, Math.min(1, (clientX - (rect.left + rect.width / 2)) / Math.max(60, rect.width)));
      const dy = Math.max(-1, Math.min(1, (clientY - (rect.top + rect.height / 2)) / Math.max(60, rect.height)));
      karenMask.style.setProperty('--mask-look-x', `${(dx * 4.5).toFixed(2)}px`);
      karenMask.style.setProperty('--mask-look-y', `${(dy * 3.2).toFixed(2)}px`);
    };
    const restEyes = () => {
      karenMask.style.removeProperty('--mask-look-x');
      karenMask.style.removeProperty('--mask-look-y');
    };
    karenMask.addEventListener('click', () => {
      if (!karenMode()) return;
      setKarenOptics(!karenMask.classList.contains('mask-optics'));
      // Visible answer to the click: the head snaps toward its own centre, the
      // hero web flares, and the whole bay catches a short pulsing ring. It is
      // deliberately brief (one CSS animation) so the HUD never stays noisy.
      karenMask.classList.remove('mask-burst');
      void karenMask.offsetWidth;
      karenMask.classList.add('mask-burst');
      const heroEl = $('#hero');
      if (heroEl) {
        heroEl.classList.remove('mask-flare');
        void heroEl.offsetWidth;
        heroEl.classList.add('mask-flare');
        clearTimeout(heroEl.maskFlareTimer);
        heroEl.maskFlareTimer = setTimeout(() => heroEl.classList.remove('mask-flare'), 1100);
      }
      setTimeout(() => karenMask.classList.remove('mask-burst'), 700);
    });
    karenMask.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); karenMask.click(); }
      if (event.key === 'Escape') setKarenOptics(false);
    });
    karenMask.addEventListener('pointermove', event => lookAt(event.clientX, event.clientY));
    karenMask.addEventListener('pointerleave', restEyes);
    if (coreStage) {
      coreStage.addEventListener('pointermove', event => lookAt(event.clientX, event.clientY));
      coreStage.addEventListener('pointerleave', restEyes);
    }
  }
  // Interactive Venom mask. It follows the pointer with its white eyes and a
  // click opens the symbiote link panel, mirroring Karen's optics interaction
  // without sharing her state or her Spider-Man CSS.
  const venomMask = document.querySelector('.venom-mask');
  if (venomMask) {
    const opticsHint = venomMask.querySelector('.venom-mask-hint');
    const setVenomOptics = active => {
      venomMask.classList.toggle('mask-optics', active);
      venomMask.classList.remove('mask-hint');
      venomMask.setAttribute('aria-pressed', active ? 'true' : 'false');
      venomMask.setAttribute('aria-label', active
        ? 'Venom symbiote link online - press to close the link panel'
        : 'Venom mask - press to open the symbiote link');
      const cap = venomMask.querySelector('.venom-mask-cap');
      if (cap) cap.textContent = active ? 'VENOM · SYMBIOTE ONLINE' : 'VENOM · SYMBIOTE';
      if (opticsHint) opticsHint.textContent = active ? 'CLICK TO CLOSE' : 'CLICK TO BOND';
    };
    const lookAtVenom = (clientX, clientY) => {
      if (!venomMode()) return;
      const rect = venomMask.getBoundingClientRect();
      if (!rect.width) return;
      const dx = Math.max(-1, Math.min(1, (clientX - (rect.left + rect.width / 2)) / Math.max(60, rect.width)));
      const dy = Math.max(-1, Math.min(1, (clientY - (rect.top + rect.height / 2)) / Math.max(60, rect.height)));
      venomMask.style.setProperty('--mask-look-x', `${(dx * 4.5).toFixed(2)}px`);
      venomMask.style.setProperty('--mask-look-y', `${(dy * 3.2).toFixed(2)}px`);
    };
    const restVenomEyes = () => {
      venomMask.style.removeProperty('--mask-look-x');
      venomMask.style.removeProperty('--mask-look-y');
    };
    venomMask.addEventListener('click', () => {
      if (!venomMode()) return;
      setVenomOptics(!venomMask.classList.contains('mask-optics'));
      venomMask.classList.remove('mask-burst');
      void venomMask.offsetWidth;
      venomMask.classList.add('mask-burst');
      const heroEl = $('#hero');
      if (heroEl) {
        heroEl.classList.remove('venom-flare');
        void heroEl.offsetWidth;
        heroEl.classList.add('venom-flare');
        clearTimeout(heroEl.venomFlareTimer);
        heroEl.venomFlareTimer = setTimeout(() => heroEl.classList.remove('venom-flare'), 1100);
      }
      setTimeout(() => venomMask.classList.remove('mask-burst'), 700);
    });
    venomMask.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); venomMask.click(); }
      if (event.key === 'Escape') setVenomOptics(false);
    });
    venomMask.addEventListener('pointermove', event => lookAtVenom(event.clientX, event.clientY));
    venomMask.addEventListener('pointerleave', restVenomEyes);
    if (coreStage) {
      coreStage.addEventListener('pointermove', event => lookAtVenom(event.clientX, event.clientY));
      coreStage.addEventListener('pointerleave', restVenomEyes);
    }
  }
  transitionVoice('IDLE', 'Waiting for microphone permission');
  voiceSelect.onchange = () => localStorage.setItem('jarvis-voice', voiceSelect.value);
  micGainControl.oninput = () => {
    const gain = Number(micGainControl.value); localStorage.setItem('jarvis-mic-gain', String(gain)); $('#micGainReadout').textContent = `${gain.toFixed(1)}x`;if (micBoostNode) micBoostNode.gain.setTargetAtTime(gain, audioContext.currentTime, .04);
  };
  noiseGateControl.oninput = () => {
    const ratio = Number(noiseGateControl.value); localStorage.setItem('jarvis-noise-gate', String(ratio)); speechGate.thresholdRatio = ratio; $('#noiseGateReadout').textContent = `${ratio.toFixed(1)}x`;
  };
  speedControl.oninput = () => localStorage.setItem('jarvis-rate', speedControl.value);
  volumeControl.oninput = () => localStorage.setItem('jarvis-volume', volumeControl.value);
  // Command sound effects: independent toggles, persisted with the rest of the
  // voice settings so they survive a restart.
  const sfxToggle = $('#sfxToggle'), sfxThinkingToggle = $('#sfxThinkingToggle'), sfxVolumeControl = $('#sfxVolumeControl'), sfxPreview = $('#sfxPreview');
  if (sfxToggle) {
    sfxToggle.checked = SFX.settings().enabled;
    if (sfxThinkingToggle) sfxThinkingToggle.checked = SFX.settings().thinking;
    if (sfxVolumeControl) sfxVolumeControl.value = String(SFX.settings().volume);
    sfxToggle.onchange = () => { SFX.set('enabled', sfxToggle.checked); if (sfxToggle.checked) SFX.ack(); };
    if (sfxThinkingToggle) sfxThinkingToggle.onchange = () => SFX.set('thinking', sfxThinkingToggle.checked);
    if (sfxVolumeControl) sfxVolumeControl.oninput = () => { SFX.set('volume', sfxVolumeControl.value); if (Number(sfxVolumeControl.value) > 0) SFX.ack(); };
    if (sfxPreview) sfxPreview.onclick = () => SFX.ack();
  }
  speechLanguage.onchange = () => {
    localStorage.setItem('jarvis-speech-language', speechLanguage.value);
    recognition.lang = speechLanguage.value;
    readout('#recognitionDiagnostic', `LANGUAGE CHANGED - ${recognition.lang}`);
    voiceLog('speech language changed', recognition.lang);
  };
  noiseSuppressionToggle.onchange = async () => {
    localStorage.setItem('jarvis-noise-suppression', String(noiseSuppressionToggle.checked));if (!recognitionEnabled) { readout('#audioDeviceStatus', `Noise and echo reduction ${noiseSuppressionToggle.checked ? 'enabled' : 'disabled'} for the next listening session.`); return; }
    stopMicrophoneMonitor();
    try { await startMicrophoneMonitor(); readout('#audioDeviceStatus', `Microphone restarted with noise and echo reduction ${noiseSuppressionToggle.checked ? 'on' : 'off'}.`); }
    catch (error) { readout('#audioDeviceStatus', `Could not restart the microphone: ${error.message}`); }
  };
  $('#audioInputDevice').onchange = () => {
    selectedMicDeviceId = $('#audioInputDevice').value;if (selectedMicDeviceId) localStorage.setItem('jarvis-audio-input', selectedMicDeviceId); else localStorage.removeItem('jarvis-audio-input');if (recognitionEnabled) {
      stopMicrophoneMonitor();
      startMicrophoneMonitor().then(() => {
        readout('#audioDeviceStatus', 'Microphone switched. Local Whisper is using this input.');
        readout('#micDiagnostic', `AVAILABLE - ${micStream?.getAudioTracks?.()[0]?.label || 'selected input'}`);
      })
        .catch(error => readout('#audioDeviceStatus', `Could not open that microphone: ${error.message}`));
    }
  };
  $('#audioOutputDevice').onchange = async () => {
    selectedOutputDeviceId = $('#audioOutputDevice').value;if (selectedOutputDeviceId) localStorage.setItem('jarvis-audio-output', selectedOutputDeviceId); else localStorage.removeItem('jarvis-audio-output');if (!await applyAudioOutput()) notify('JARVIS could not switch to that output device. Check speaker permission or choose another device.');
  };
  $('#refreshAudioDevices').onclick = refreshAudioDevices;
  const micTestBtn = $('#micTestBtn'); if (micTestBtn) micTestBtn.onclick = openVoiceMicTest;
  const snapBtn = $('#copyVoiceSnapshot'); if (snapBtn) snapBtn.onclick = copyVoiceSnapshot;
  $('#chooseAudioOutput').onclick = async () => {
    try {
      if (!navigator.mediaDevices?.selectAudioOutput) { notify('This Edge version does not support choosing a speaker from JARVIS.'); return; }
      const device = await navigator.mediaDevices.selectAudioOutput();
      selectedOutputDeviceId = device.deviceId; localStorage.setItem('jarvis-audio-output', selectedOutputDeviceId);
      await refreshAudioDevices(); $('#audioOutputDevice').value = selectedOutputDeviceId;
      if (!await applyAudioOutput()) notify('The speaker was selected, but this Edge audio context could not switch to it.');
    } catch (error) {
      if (error.name !== 'NotAllowedError') notify(`Could not select a speaker: ${error.message}`);
    }
  };
  $('#openSoundSettings').onclick = async () => {
    const result = await localAction({ action: 'open-sound-settings' });
    notify(result.message || 'Opening Windows Sound Settings.');
  };
  navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
    voiceLog('audio devices changed', 're-enumerating inputs; selected mic re-validated');
    await refreshAudioDevices();
    // If the selected mic vanished mid-session, the track ends silently.
    // Recover once (debounced) instead of restarting in a loop.
    if (recognitionEnabled && !micMuted && !micStream?.active && Date.now() - lastMicRecoveryAt > 5000) {
      lastMicRecoveryAt = Date.now();
      voiceLog('mic recovery', 'stream inactive after device change - restarting once');
      try { await startMicrophoneMonitor(); } catch (error) { voiceLog('mic recovery failed', error.message); }
    }
  });
  refreshAudioDevices();
  continuousToggle.onchange = () => continuousToggle.checked ? startContinuous() : stopContinuous();
  async function minimizeToTray() {
    try {
      const response = await fetch('/api/window/minimize', { method: 'POST', signal: AbortSignal.timeout(5000) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message);
    } catch (error) { notify(error.message || 'Could not minimize JARVIS to the tray.'); }
  }
  // Tray restore: clicking the tray icon shows the window again without
  // reloading the page, but a dead capture stream would leave JARVIS deaf.
  // Verify the microphone path is alive and restart it if it is not, so a
  // click always returns to a listening JARVIS.
  document.addEventListener('visibilitychange', () => {if (document.hidden) { voiceLog('window hidden', 'tray icon keeps the bridge running'); return; }if (!recognitionEnabled || micMuted) return;
      // A hidden page can leave the audio context suspended, which would mute
      // the spoken answer even though the recording worked. Wake it up as soon
      // as the window is back.
      try { if (audioContext && audioContext.state === 'suspended') audioContext.resume().catch(() => { }); } catch { }
      if (!micStream?.active) {
      voiceLog('window restored', 'microphone stream was dead; restarting monitor');
      startMicrophoneMonitor().then(() => voiceLog('microphone restarted', 'listening again')).catch(error => voiceLog('mic restart failed', error.message));
    } else voiceLog('window restored', 'microphone still active');
  });
  $('#trayBtn').onclick = minimizeToTray;
  $('#micBtn').onclick = () => recognitionEnabled ? stopContinuous() : startContinuous();
  // ---- PUSH-TO-TALK wiring (keyboard shortcut + GUI hold button) ----
  {
    // Single applier for the shortcut: persists it, syncs the preset select
    // (adding a custom option for keys outside the list), and updates the
    // hint, button title, and diagnostics with the real configured key.
    function applyPttKey(code, { persist = true } = {}) {
      const trimmed = String(code || '').trim();
      const normalized = /^[A-Za-z0-9]+$/.test(trimmed) ? trimmed.toUpperCase() : 'F9';
      if (persist) localStorage.setItem('jarvis-ptt-key', normalized);
      const label = pttKeyLabel();
      const select = $('#pttKeySelect');
      if (select) {
        let option = Array.from(select.options).find(o => String(o.value).toUpperCase() === normalized);
        if (!option) { option = document.createElement('option'); option.value = normalized; option.textContent = `Hold ${label} (custom)`; select.add(option); }
        select.value = normalized;
      }
      $('#voiceHint').textContent = `PRIVATE OFFLINE SPEECH - SAY "JARVIS", OR HOLD ${label} / THE PTT BUTTON`;
      $('#pttBtn').title = `Push-to-talk: hold ${label} (or hold this button) and speak, then release to send.`;
      voiceLog(persist ? 'push-to-talk key set' : 'push-to-talk key restored', label);
      return label;
    }
    applyPttKey(localStorage.getItem('jarvis-ptt-key'), { persist: false });
    const keySelect = $('#pttKeySelect');
    if (keySelect) keySelect.onchange = () => applyPttKey(keySelect.value);
    // SET ANY KEY capture: the next key pressed (except Escape and bare or
    // held modifiers) becomes the hold-to-talk key. Escape or losing focus
    // cancels without changing the current shortcut.
    let pttKeyCapturing = false;
    const pttKeyChip = $('#pttKeyRecord');
    const pttKeyStatus = $('#pttKeyStatus');
    const modifierCode = code => /^(?:Shift|Control|Alt|Meta|OS)(?:Left|Right)?$/.test(code) || code === 'CapsLock' || code === 'NumLock';
    const endCapture = (message) => {
      pttKeyCapturing = false;
      if (pttKeyChip) pttKeyChip.textContent = 'SET ANY KEY';
      if (pttKeyStatus) pttKeyStatus.textContent = String(message || '');
    };
    if (pttKeyChip) pttKeyChip.addEventListener('click', () => {
      pttKeyCapturing = true;
      pttKeyChip.textContent = 'PRESS ANY KEY (ESC CANCELS)';
      if (pttKeyStatus) pttKeyStatus.textContent = 'Press the key you want to hold for push-to-talk. Escape cancels.';
      voiceLog('push-to-talk key capture', 'waiting for the new key');
    });
    // Keyboard hold-to-talk. The configured key is matched by event.code;
    // auto-repeat is ignored, typing fields are never hijacked, and plain
    // modifiers (Ctrl/Alt/Meta combos) are left to the operating system.
    document.addEventListener('keydown', event => {
      if (pttKeyCapturing) {
        event.preventDefault();
        if (event.repeat) return;
        if (event.code === 'Escape') { endCapture('Key selection cancelled; the shortcut is unchanged.'); voiceLog('push-to-talk key capture', 'cancelled'); return; }
        if (event.ctrlKey || event.altKey || event.metaKey) { if (pttKeyStatus) pttKeyStatus.textContent = 'Plain keys only: release Ctrl/Alt/Windows and press the key by itself.'; return; }
        if (modifierCode(event.code)) return;
        const label = applyPttKey(event.code);
        endCapture(`Shortcut changed: hold ${label}. The change takes effect immediately.`);
        return;
      }
      if (String(event.code).toUpperCase() !== pttKeyFromSettings()) return;
      if (event.repeat) { event.preventDefault(); return; }
      const target = event.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(String(target.tagName || '')))) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      lastLocalPttKeyAt = Date.now();
      startPushToTalk('key');
    });
    document.addEventListener('keyup', event => {
      if (String(event.code).toUpperCase() !== pttKeyFromSettings()) return;
      event.preventDefault();
      if (pttCtl.holding) endPushToTalk();
    });
    // Missing key-up safety net: a missed release event must never leave the
    // app in permanent "listening" state - the hold watchdog (armed for every
    // source above) finalizes a hold whose release never arrived.
    // 2026-10-24: a focus loss must NOT abort an active push-to-talk hold. The
    // global host keyboard hook delivers its own press/release independently of
    // window focus, so background push-to-talk (user not focused on the app, or
    // mid-hold alt-tab) used to get its hold killed here and never transcribe.
    window.addEventListener('blur', () => {
      if (pttKeyCapturing) endCapture('Key selection cancelled when the window lost focus; the shortcut is unchanged.');
    });
    // 2026-10-24: a hidden window must not abort an active push-to-talk hold
    // either - the release arrives over the global channel whenever the key is
    // let go, and the watchdog covers a release that never does. Aborting here is
    // what made push-to-talk stop working while the app was in the background.
    document.addEventListener('visibilitychange', () => { if (pttKeyCapturing) endCapture('Key selection cancelled when the window is hidden; the shortcut is unchanged.'); });
    // Shutdown while held: finalize or reset so nothing stays half-recorded.
    window.addEventListener('beforeunload', () => { try { if (pttCtl.holding) endPushToTalk(); else if (pttCtl.active) resetPttSession(); } catch {} });
    // GUI hold button: pointerdown starts, pointerup/cancel finalizes, pointer
    // capture keeps the release event even when the pointer leaves the button.
    const pttButton = $('#pttBtn');
    if (pttButton) {
      pttButton.addEventListener('contextmenu', event => event.preventDefault());
      pttButton.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        try { pttButton.setPointerCapture?.(event.pointerId); } catch {}
        startPushToTalk('button');
      });
      const releasePttButton = () => { if (pttCtl.holding && pttCtl.source === 'button') endPushToTalk(); };
      pttButton.addEventListener('pointerup', releasePttButton);
      pttButton.addEventListener('pointercancel', releasePttButton);
      pttButton.addEventListener('lostpointercapture', releasePttButton);
    }
    updatePttButtonState();
  }
  $('#stopBtn').onclick = () => { assistantTurn++; stopSpeech(); setMode(recognitionEnabled ? 'LISTENING' : 'IDLE', recognitionEnabled ? 'Speech stopped. I am listening.' : 'Speech stopped.'); };
  // Enter submits exactly once (2026-10-19). The keydown handler suppresses the
  // form's implicit submission (preventDefault), so a single Enter can never
  // double-fire through both the keydown and the submit handler. The send
  // button, the discovery card and the synthetic "confirm" submit still flow
  // through the form path. Whitespace-only input never reaches the pipeline,
  // and the input is cleared synchronously inside ask() so a held Enter cannot
  // spam the model.
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    const value = input.value;
    if (!value.trim()) return;
    ask(value);
  });
  $('#form').addEventListener('submit', event => { event.preventDefault(); const value = input.value; if (!value.trim()) return; ask(value); });
  $('#clearChat').onclick = clearChatLog;
  document.querySelectorAll('.chip[data-cmd]').forEach(button => button.addEventListener('click', () => ask(button.dataset.cmd)));
  $('#bridgeState').textContent = 'CHECKING'; checkBridge(); setInterval(checkBridge, 5000); refreshFishStatus();
  // ---- SYSTEM MONITOR 2.0: one poller, live Windows metrics -> existing gauges ----
  // Single setInterval (2.5s), paused when tab hidden, no duplicate loops.
  // Absent readings stay "…" (never fake 0); per-metric N/A shown individually.
  let sysTimer = null, sysBusy = false, sysFail = 0;
  const sysHist = { cpu: [], ram: [] };
  function fmtBps(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v); if (!Number.isFinite(n)) return null;
    if (n < 1024) return `${Math.round(n)} B/s`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB/s`;
    return `${(n / 1048576).toFixed(1)} MB/s`;
  }
  function fmtUptime(s) {
    if (s === null || s === undefined) return null;
    const n = Math.floor(Number(s)); if (!Number.isFinite(n)) return null;
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${n}s`;
  }
  function setGauge(valId, ringId, text, pct) {
    const v = $(`#${valId}`); if (v) v.textContent = text;
    const r = $(`#${ringId}`); if (r) r.style.setProperty('--g', `${pct === null ? 0 : Math.max(0, Math.min(100, pct))}%`);
  }
  function setRow(id, text) { const el = $(`#${id}`); if (el) el.textContent = text; }
  function drawSysGraph() {
    const cv = $('#sysGraph'); if (!cv) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const series = [{ d: sysHist.cpu, c: '#56e9ff' }, { d: sysHist.ram, c: '#43e9c4' }];
    ctx.strokeStyle = '#143446'; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, (H / 4) * i); ctx.lineTo(W, (H / 4) * i); ctx.stroke(); }
    for (const s of series) {
      if (s.d.length < 2) continue;
      ctx.strokeStyle = s.c; ctx.lineWidth = 1.5; ctx.beginPath();
      s.d.forEach((v, i) => {
        const x = (i / 59) * W + (W - (Math.min(s.d.length, 60) / 60) * W);
        const y = H - Math.max(0, Math.min(100, v)) / 100 * (H - 4) - 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }
  async function refreshSystemMonitor(manual = false) {
    if (sysBusy) return; sysBusy = true;
    try {
      const res = await fetch('/api/system', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const s = await res.json();
      sysFail = 0;
      const cpuP = s.cpu && typeof s.cpu.pct === 'number' ? s.cpu.pct : null;
      const ramP = s.mem && typeof s.mem.pct === 'number' ? s.mem.pct : null;
      const dskP = s.drives && s.drives.primary && typeof s.drives.primary.pct === 'number' ? s.drives.primary.pct : null;
      const netT = s.net && typeof s.net.totalBps === 'number' ? s.net.totalBps : null;
      setGauge('cpuVal', 'cpuRing', cpuP === null ? '…' : `${cpuP}%`, cpuP);
      setGauge('ramVal', 'ramRing', ramP === null ? '…' : `${ramP}%`, ramP);
      setGauge('diskVal', 'diskRing', dskP === null ? '…' : `${dskP}%`, dskP);
      setGauge('netVal', 'netRing', netT === null ? '…' : (fmtBps(netT) || '…'), netT === null ? null : Math.min(100, netT / 10485.76));
      const nProcs = s.procs && typeof s.procs.count === 'number' ? s.procs.count : (Array.isArray(s.procs?.list) ? s.procs.list.length : null);
      setGauge('procVal', 'gpuRing', nProcs === null ? '…' : String(nProcs), null);
      setGauge('uptimeVal', 'upRing', fmtUptime(s.uptimeSeconds) || '…', null);
      if (typeof cpuP === 'number') { sysHist.cpu.push(cpuP); if (sysHist.cpu.length > 60) sysHist.cpu.shift(); }
      if (typeof ramP === 'number') { sysHist.ram.push(ramP); if (sysHist.ram.length > 60) sysHist.ram.shift(); }
      drawSysGraph();
      const label = { initializing: 'INIT…', connected: '● LIVE', partial: '◐ PARTIAL', unavailable: '○ WAITING', stale: '○ STALE', error: '● ERROR' }[s.status] || '● LIVE';
      setRow('sysStatus', label);
      setRow('sysState', `${s.status || 'unknown'}${manual ? ' · refreshed' : ''}`);
      setRow('sysCpu', s.cpu?.pct !== null && s.cpu?.pct !== undefined ? `${s.cpu.pct}% · ${s.cpu.model || ''} · ${s.cpu.count || '?'} cores`.trim() : 'unavailable');
      setRow('sysRam', s.mem?.pct !== null && s.mem?.pct !== undefined ? `${s.mem.pct}% · ${s.mem.usedGB} / ${s.mem.totalGB} GB used` : 'unavailable');
      if (s.gpu && s.gpu.pct !== null && s.gpu.pct !== undefined) setRow('sysGpu', `${s.gpu.pct}% · ${s.gpu.name || 'GPU'}`);
      else if (s.gpu && s.gpu.name) setRow('sysGpu', `${s.gpu.name} · utilization N/A`);
      else setRow('sysGpu', 'unavailable on this PC');
      if (s.drives?.primary) setRow('sysDisk', `${s.drives.primary.name} ${s.drives.primary.freeGB} GB free of ${s.drives.primary.totalGB} GB (${s.drives.primary.pct ?? '?'}%)`);
      else if (s.drives?.list?.length) setRow('sysDisk', s.drives.list.slice(0, 3).map(d => `${d.name} ${d.freeGB}GB free`).join(' · '));
      else setRow('sysDisk', 'unavailable');
      if (s.net && typeof s.net.totalBps === 'number') setRow('sysNet', `↓ ${fmtBps(s.net.downBps)} ↑ ${fmtBps(s.net.upBps)}`);
      else if (s.net?.interfaces?.length) setRow('sysNet', `${s.net.interfaces.length} interface(s) · throughput N/A`);
      else setRow('sysNet', 'unavailable');
      setRow('sysTop', s.procs?.top ? `${s.procs.top.name} · ${s.procs.top.ramMB} MB` : 'unavailable');
      setRow('sysUpdated', s.updatedAtIso ? new Date(s.updatedAtIso).toLocaleTimeString() : 'never');
      window.__jarvisSystem = s;
    } catch (e) {
      sysFail++;
      setRow('sysStatus', sysFail >= 3 ? '● ERROR' : '○ RETRYING');
      setRow('sysState', `update failed (${sysFail}x): ${String(e.message || e).slice(0, 80)}`);
    } finally { sysBusy = false; }
  }
  function startSystemMonitor() {
    if (sysTimer) return;
    refreshSystemMonitor();
    sysTimer = setInterval(() => { if (!document.hidden) refreshSystemMonitor(); }, 2500);
  }
  function stopSystemMonitor() { if (sysTimer) { clearInterval(sysTimer); sysTimer = null; } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSystemMonitor(); });
  window.addEventListener('beforeunload', stopSystemMonitor);
  const sysBtn = $('#sysRefresh'); if (sysBtn) sysBtn.onclick = () => refreshSystemMonitor(true);
  window.__jarvisRefreshSystem = () => refreshSystemMonitor(true);
  startSystemMonitor();
  restorePendingEmail();

  readout('#recognitionDiagnostic', 'LOCAL WHISPER - CHECKING MODEL');
  // ASR-DIAG 2026-10-14: this used to be a single fetch. If the local service was
  // still binding its port (or blipped once) the catch handler put the HUD into
  // ERROR and voice never started again for the whole session — even though the
  // recognizer was healthy. Retry a few times, and only report a real failure.
  const checkAsrReady = async (attempt = 1, maxAttempts = 4) => {
    try {
      const response = await fetch('/api/asr/status', { cache: 'no-store' });
      if (!response.ok) throw new Error(`The local service answered HTTP ${response.status}.`);
      const status = await response.json();
      if (status.ready) {
        readout('#recognitionDiagnostic', 'LOCAL WHISPER - READY - OFFLINE');
        if (continuousToggle.checked) setTimeout(startContinuous, 900);
        return true;
      }
      // A definite "not ready" is a real, stable condition: report it truthfully.
      continuousToggle.checked = false; $('#micBtn').textContent = 'LOCAL VOICE FILES MISSING'; $('#micBtn').disabled = true;
      readout('#recognitionDiagnostic', 'LOCAL WHISPER - FILES MISSING');
      $('#voiceHint').textContent = status.message || 'Local voice model files are missing from the JARVIS folder.';
      setMode('ERROR', 'Local voice recognition files are missing.');
      voiceLog('local recognition unavailable', status.message || 'files missing');
      return false;
    } catch (error) {
      if (attempt < maxAttempts) {
        voiceLog('local recognition check retrying', `attempt ${attempt}/${maxAttempts} - ${String(error.message).slice(0, 80)}`);
        readout('#recognitionDiagnostic', `LOCAL WHISPER - RETRYING (${attempt}/${maxAttempts - 1})`);
        await new Promise(resolve => setTimeout(resolve, 1200 * attempt));
        return checkAsrReady(attempt + 1, maxAttempts);
      }
      readout('#recognitionDiagnostic', 'LOCAL SERVICE UNAVAILABLE');
      voiceLog('local recognition unavailable', String(error.message).slice(0, 120));
      setMode('ERROR', 'JARVIS could not reach the local speech recognition service.');
      return false;
    }
  };
  checkAsrReady();
})(
);
