(() => {
  'use strict';
  const states = [
    'IDLE', 'LISTENING_FOR_WAKE_WORD', 'LISTENING_FOR_COMMAND', 'THINKING',
    'SEARCHING', 'EXECUTING', 'SPEAKING', 'INTERRUPTED', 'ERROR'
  ];
  const transitions = {
    IDLE: ['LISTENING_FOR_WAKE_WORD', 'LISTENING_FOR_COMMAND', 'THINKING', 'SEARCHING', 'EXECUTING', 'ERROR'],
    LISTENING_FOR_WAKE_WORD: ['LISTENING_FOR_COMMAND', 'THINKING', 'SEARCHING', 'EXECUTING', 'SPEAKING', 'IDLE', 'ERROR', 'INTERRUPTED'],
    LISTENING_FOR_COMMAND: ['LISTENING_FOR_WAKE_WORD', 'THINKING', 'SEARCHING', 'EXECUTING', 'SPEAKING', 'IDLE', 'ERROR', 'INTERRUPTED'],
    THINKING: ['SPEAKING', 'LISTENING_FOR_WAKE_WORD', 'LISTENING_FOR_COMMAND', 'SEARCHING', 'EXECUTING', 'ERROR'],
    SEARCHING: ['THINKING', 'SPEAKING', 'LISTENING_FOR_WAKE_WORD', 'LISTENING_FOR_COMMAND', 'EXECUTING', 'ERROR'],
    EXECUTING: ['THINKING', 'SPEAKING', 'LISTENING_FOR_WAKE_WORD', 'LISTENING_FOR_COMMAND', 'SEARCHING', 'ERROR'],
    SPEAKING: ['LISTENING_FOR_WAKE_WORD', 'LISTENING_FOR_COMMAND', 'INTERRUPTED', 'THINKING', 'IDLE', 'ERROR'],
    INTERRUPTED: ['LISTENING_FOR_COMMAND', 'LISTENING_FOR_WAKE_WORD', 'THINKING', 'SPEAKING', 'IDLE', 'ERROR'],
    ERROR: ['LISTENING_FOR_WAKE_WORD', 'LISTENING_FOR_COMMAND', 'IDLE', 'THINKING']
  };
  class VoiceStateMachine {
    constructor(onChange = () => {}) { this.state = 'IDLE'; this.onChange = onChange; }
    transition(next, detail = '') {
      if (!states.includes(next)) throw new Error(`Unknown JARVIS voice state: ${next}`);
      if (next === this.state) { this.onChange(next, detail); return next; }
      if (!transitions[this.state].includes(next)) throw new Error(`Invalid JARVIS voice transition: ${this.state} → ${next}`);
      this.state = next; this.onChange(next, detail); return next;
    }
  }
  class SpeechGate {
    // Threshold and onset are tuned so normal conversational speech (roughly 2-3x
    // the learned room/fan noise floor measured right at the mic) opens the gate
    // quickly, while brief clicks and isolated keyboard taps still fail the
    // sustained-onset requirement below.
    constructor({ calibrationMs = 600, onsetMs = 150, thresholdRatio = 1.25, noiseFloor = 0.003 } = {}) {
      this.calibrationMs = calibrationMs; this.onsetMs = onsetMs; this.thresholdRatio = thresholdRatio; this.initialNoiseFloor = noiseFloor; this.reset();
    }
    reset() { this.noiseFloor = this.initialNoiseFloor; this.calibratingMs = 0; this.calibrationSamples = []; this.candidateMs = 0; }
    sample(rmsValue, durationMs, speechActive = false) {
      const rms = Math.max(0, Number(rmsValue) || 0), duration = Math.max(0, Number(durationMs) || 0);
      if (!speechActive && this.calibratingMs < this.calibrationMs) {
        this.calibrationSamples.push(rms); this.calibratingMs += duration;
        if (this.calibratingMs >= this.calibrationMs) {
          const sorted = [...this.calibrationSamples].sort((a, b) => a - b);
          this.noiseFloor = Math.max(0.0008, sorted[Math.floor((sorted.length - 1) * 0.25)] ?? this.initialNoiseFloor);
        }
        return { ready: this.calibratingMs >= this.calibrationMs, calibrating: this.calibratingMs < this.calibrationMs, noiseFloor: this.noiseFloor, threshold: this.noiseFloor * this.thresholdRatio, voice: false, trigger: false, candidateMs: 0 };
      }
      const threshold = Math.max(0.0008, this.noiseFloor * this.thresholdRatio);
      const voice = rms > threshold;
      if (!speechActive) {
        // Track a slowly changing fan/room baseline even when it is louder than
        // the old fixed threshold. Cap upward tracking so a loud TV cannot
        // permanently desensitize the mic (which forced shouting afterwards),
        // and recover faster when the room goes quiet so normal volume keeps
        // working. Real speech cannot teach itself as noise: anything above
        // threshold opens the gate instead of adapting.
        const boundedObservation = Math.min(rms, this.noiseFloor * 1.25);
        const rate = rms < this.noiseFloor * 0.5 ? 0.1 : 0.025;
        this.noiseFloor += (boundedObservation - this.noiseFloor) * rate;
        this.candidateMs = voice ? this.candidateMs + duration : Math.max(0, this.candidateMs - duration * 0.6);
      } else this.candidateMs = 0;
      const trigger = !speechActive && this.candidateMs >= this.onsetMs;
      if (trigger) this.candidateMs = 0;
      return { ready: true, calibrating: false, noiseFloor: this.noiseFloor, threshold, voice: speechActive ? rms > threshold * 0.6 : voice, trigger, candidateMs: this.candidateMs };
    }
  }
  // Phonetic mishearings observed from the offline English recognizer for the
  // word JARVIS itself. Each is a full-utterance replacement for "jarvis" (and
  // optionally a "hey/hay/hi" lead-in), so the wake word survives Whisper noise.
  const wakeAliases = [
    'jarvis', 'jarvus', 'jervis', 'javis', 'jarvies', 'jarviss', 'jarves', 'jarvice',
    'jarwis', 'jarvise', 'djarvis', 'jarbis', 'jarvies', 'george is', 'jervis', 'harvis', 'jarvish',
    'aidarius', 'a darius', 'adarius', 'they obviously', 'they are obviously', 'hey obviously'
  ];
  const wakeAliasSet = new Set(wakeAliases);
  const wakeAliasPhrases = [...wakeAliasSet].sort((a, b) => b.length - a.length);

  function stripLeadIns(value) {
    return value
      .replace(/^(?:(?:hey|hay|hi|hello|okay|ok|um+|uh+|erm+|hmm+|so)\b[\s,.;:!?-]*)+/i, '')
      .replace(/^(?:(?:can|could|will)\s+you\s+(?:please\s+)?|please\s+|just\s+)+/i, '')
      .trim();
  }

  function parseWakeTranscript(transcript, customPhrase = 'Hey JARVIS') {
    const original = String(transcript || '').trim();
    const clean = original.replace(/^[\s,.;:!?-]+/, '');
    // Normalized text: lowercase, fillers stripped only where they do not carry
    // meaning (never remove negations such as "not" or "don't"). Alias matching
    // runs on the normalized form so that "Uh, hey Jarvis" and "Hey Jarvis" hit
    // the same wake path without weakening the exact-phrase requirement.
    // Keep the full wake text (including an optional "Hey"/"Hi" greeting and
    // punctuation such as commas) for the reported match, while the command
    // continuation is taken from the alias-stripped remainder.
    const leadStripped = clean.replace(/^(?:(?:hey|hay|hi|hello|okay|ok|um+|uh+|erm+|hmm+|so)\b[\s,.;:!?-]*)+/i, '');
    const leadWords = clean.slice(0, clean.length - leadStripped.length).trim().split(/[\s,.;:!?-]+/).filter(Boolean).length;
    const normalized = stripLeadIns(clean).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const normalizedWords = normalized.split(' ').filter(Boolean);
    const originalWords = clean.replace(/\s+/g, ' ').split(' ').filter(Boolean);

    // 1) Alias matching at the START of the utterance (after lead-in strip):
    //    covers "hey obviously", "a darius", "jarvis" and all single-word sound
    //    variants, so a command spoken after the wake word is preserved. Multi-
    //    word aliases only count here — a mid-sentence "they obviously" is just
    //    an ordinary sentence and must never wake JARVIS.
    let aliasSpan = null;
    if (normalizedWords.length) {
      for (const alias of wakeAliasPhrases) {
        const parts = alias.split(' ');
        if (parts.length > normalizedWords.length) continue;
        if (parts.every((part, offset) => normalizedWords[offset] === part)) {
          aliasSpan = { start: 0, end: parts.length, matched: alias };
          break;
        }
      }
    }

    // 2) Explicit custom-phrase override (defaults to the JARVIS set).
    if (!aliasSpan) {
      const configured = String(customPhrase || '').trim();
      if (configured && !/jarvis/i.test(configured)) {
        const escaped = configured.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = clean.match(new RegExp(`^${escaped}(?=[\\s,.;:!?-]|$)`, 'i'));
        if (match) {
          return { activated: true, match: match[0].trim(), command: clean.slice(match[0].length).trim(), transcript: original, confidence: 1 };
        }
        return { activated: false, match: '', command: '', transcript: original, confidence: 0 };
      }
    }

    if (aliasSpan) {
      const before = normalizedWords.slice(0, aliasSpan.start).join(' ').trim();
      const after = normalizedWords.slice(aliasSpan.end).join(' ').trim();
      const stripped = stripLeadIns(after) || '';
      const command = [before, stripped].filter(Boolean).join(' ').replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, '').trim();
      // Report the wake match with the original transcript casing, including an
      // optional "Hey" lead-in, so callers see "Hey Jarvis" / "Jarvis" — while
      // the stripped command keeps only the actual request.
      const aliasParts = aliasSpan.matched.split(' ');
      const leadSlice = originalWords.slice(0, leadWords).filter(word => /^(?:hey|hay|hi|hello)[\s,.!?:;]*$/i.test(word));
      const baseCase = originalWords.slice(leadWords, leadWords + aliasParts.length).join(' ') || aliasSpan.matched;
      const matchCase = [...leadSlice, baseCase].join(' ');
      return { activated: true, match: matchCase, command, transcript: original, confidence: 0.9 };
    }

    // 3) Loose anywhere-fallback: the plain word "jarvis" (or any single-word
    // alias) appearing anywhere still activates, so "Could you open Roblox,
    // Jarvis?" keeps working, but multi-word aliases like "they obviously" do
    // NOT activate from arbitrary mid-sentence placement.
    for (const alias of wakeAliasPhrases.filter(a => !a.includes(' '))) {
      const index = normalizedWords.indexOf(alias);
      if (index === -1) continue;
      const before = normalizedWords.slice(0, index).join(' ').trim();
      const after = normalizedWords.slice(index + 1).join(' ').trim();
      const command = [before, after].filter(Boolean).join(' ').replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, '').trim();
      const matchCase = originalWords[index];
      return { activated: true, match: matchCase || alias, command, transcript: original, confidence: 0.6 };
    }
    return { activated: false, match: '', command: '', transcript: original, confidence: 0 };
  }
  const websiteUrls = { youtube: 'https://www.youtube.com/', 'youtube-music': 'https://music.youtube.com/', google: 'https://www.google.com/', gmail: 'https://mail.google.com/', docs: 'https://docs.google.com/document/u/0/', slides: 'https://docs.google.com/presentation/u/0/', toddle: 'https://web.toddleapp.com/', wikipedia: 'https://www.wikipedia.org/', tiktok: 'https://www.tiktok.com/', instagram: 'https://www.instagram.com/', discord: 'https://discord.com/app', roblox: 'https://www.roblox.com/' };
  // Small edit-distance helper for conservative allowlist correction only.
  function editDistance(a, b) {
    const x = String(a || ''), y = String(b || '');
    if (x === y) return 0;
    if (!x.length) return y.length;
    if (!y.length) return x.length;
    let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
    for (let i = 1; i <= x.length; i++) {
      const row = [i];
      for (let j = 1; j <= y.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = row;
    }
    return prev[y.length];
  }
  function parseWebsiteIntent(text) {
    const normalized = String(text || '').trim()
      .replace(/^(?:hey jarvis[, ]*)?(?:(?:can|could) you(?: please)?(?: just)?|please|just)\s+/i, '')
      .replace(/^(?:open\s+up|fire\s+up)\s+/i, 'open ')
      // "open Roblox again" reuses the known destination instead of searching
      // for an app literally called "roblox again".
      .replace(/\s+again[.!?]*$/i, '')
      .replace(/\s+for me[.!?]*$/i, '').trim();
    // "navigate to X" is the same website navigation as "open X" through the
    // controlled browser. Stripped suffix "in a new tab" is handled by the
    // caller (app.js), which passes newTab explicitly.
    const navigated = normalized.replace(/^(?:navigate\s+to|navigate)\s+/i, 'open ');
    const match = navigated.match(/^(?:open|go to|visit|launch)\s+(?:the\s+)?(youtube\s+music|music|youtube|google|gmail|google\s+docs?(?:\.com)?|docs|google\s+slides|slides|toddle(?:\.com)?|toodle(?:\.com)?|wikipedia|tiktok|instagram|discord|roblox)(?:\s+(?:website|web|site|app|portal))?[.!?]*$/i);
    if (match) {
      let site = match[1].toLowerCase().replace(/\s+/g, '-');
      if (site === 'music') site = 'youtube-music';
      if (site === 'google-docs' || site === 'google-doc' || site === 'google-doc.com' || site === 'google-docs.com' || site === 'google-doc-com' || site === 'google-docs-com') site = 'docs';
      if (site === 'google-slides' || site === 'google-slide') site = 'slides';
if (site === 'toodle' || site === 'toodle.com' || site === 'toodle-com') site = 'toddle';
      return { site, url: websiteUrls[site] };
    }
    // Conservative ASR cleanup ("open youtub"): single-token site names within
    // edit distance 2 of the allowlist resolve to the site. Anything else
    // stays unmatched so ordinary speech is never hijacked into navigation.
    const loose = navigated.match(/^(?:open|go to|visit|launch)\s+(?:the\s+)?([a-z][a-z0-9-]*)(?:\s+(?:website|web|site))?[.!?]*$/i);
    if (loose) {
      const token = loose[1].toLowerCase();
      // Real app/file words fall through to the app opener, never to a site.
      if (!/^(?:mail|maps|news|photos|camera|notes|store|settings|clock|files|music|video|docs|drive)$/i.test(token) && token.length >= 3) {
        let best = '', bestDist = 3;
        for (const key of Object.keys(websiteUrls)) {
          const dist = editDistance(token, key.replace(/-/g, ''));
          if (dist < bestDist) { bestDist = dist; best = key; }
        }
        if (best && bestDist <= 2) return { site: best, url: websiteUrls[best], corrected: token };
      }
    }
    return null;
  }
  // Bare app names (2026-10-15): "Steam" means "open Steam". The whole
  // utterance must be just the name — no verbs, no extra words — and the
  // name must be on the launchable allowlist, so ordinary talk ("I like
  // Steam games", "what is Steam") never fires the launcher. Anything not
  // on the list falls through to the normal pipeline unchanged.
  const BARE_LAUNCH_SITES = ['youtube', 'google', 'gmail', 'docs', 'slides', 'toddle', 'wikipedia', 'tiktok', 'instagram', 'discord'];
  const BARE_LAUNCH_APPS = ['chrome', 'google chrome', 'edge', 'microsoft edge', 'firefox', 'brave', 'steam', 'riot client', 'epic games', 'gog galaxy', 'roblox', 'minecraft', 'valorant', 'spotify', 'calculator', 'notepad', 'notepad++', 'paint', 'settings', 'task manager', 'file explorer', 'explorer', 'control panel', 'command prompt', 'cmd', 'powershell', 'terminal', 'snipping tool', 'microsoft store', 'store', 'photos', 'clock'];
  function parseBareAppName(input) {
    const cleaned = stripPoliteLead(input).replace(/[.!?]+$/, '').replace(/\bplease\b|\bfor me\b/ig, '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return null;
    // Bare entity only: short, plain words, no sentence structure.
    if (!/^[A-Za-z][A-Za-z0-9 .&'+\-]{0,39}$/.test(cleaned)) return null;
    if (cleaned.split(/\s+/).length > 3) return null;
    if (/\b(?:open|launch|start|close|play|stop|pause|search|find|show|what|what's|when|where|why|how|is|are|was|were|do|does|did|can|could|would|should|will|tell|give|my|the|a|an|and|or|but|for|with|about|that|this|it|i|you|he|she|we|they|me|him|her|us|them|to|of|in|on|at|by|from|as|like|love|hate|want|need|hello|hi|hey|thanks|thank)\b/i.test(cleaned)) return null;
    const key = cleaned.toLowerCase();
    if (BARE_LAUNCH_SITES.includes(key)) return { kind: 'site', name: key };
    if (BARE_LAUNCH_APPS.includes(key)) return { kind: 'app', name: cleaned };
    return null;
  }
  // "check my todo list" / "do i have any homework" / "what's due" (2026-10-15).
  // Reads the Toddle todo list on demand, without entering study mode.
  // Deliberately narrow: ordinary talk ABOUT homework ("my homework is hard",
  // "tell me about homework") must never trigger a lookup, so every branch
  // needs a check verb or a due/any question framing.
  const TODO_LOOK = 'check|see|show|pull\\s*up|bring\\s*up|look\\s*(?:at|up|over|through)|read|open|view|list|refresh|remind';
  const TODO_NOUNS = 'to\\s*-?\\s*do\\s*lists?|todo\\s*lists?|todo|to\\s*do|todos|homework|assignments?|schoolwork|revision\\s*work|work\\s*due';
  const TODO_DUEWORD = /\bdue\b|\boutstanding\b|\bpending\b|\bassigned\b/i;
  function parseTodoIntent(input) {
    const text = String(input || '').trim()
      .replace(/^(?:(?:hey|hi|hello|okay|yo)\s+)?jarvis[\s,:-]*(?:please[\s,:-]+)?/i, '')
      .replace(/^(?:(?:can|could|would|will)\s+you(?:\s+please)?(?:\s+just)?|please|kindly|just)\s+/i, '')
      .replace(/[.!?]+$/, '').trim();
    if (!text) return null;
    const noun = new RegExp(TODO_NOUNS + '\\b', 'i');
    // "open the todo app" / "check my homework app" mean launching an
    // application, which the app opener owns — never a list read.
    if (/\bapp(?:lication)?\b\s*$/i.test(text)) return null;
    // Imperative: a lookup verb, then (only) filler words and due-flags before
    // the noun. Anchored to the end so trailing clauses ("...list again",
    // "...for tomorrow") stay a match while real sentences ("my homework is
    // hard", "tell me about homework") cannot reach it.
    const imperative = new RegExp(
      '^(?:' + TODO_LOOK + ')\\s+(?:(?:my|the|our|me|if|i|have|got|what|any|all|current|upcoming|left|still|on)\\s+)*'
      + '(?:due|outstanding|pending|left\\s+to\\s+do)?\\s*'
      + '(?:' + TODO_NOUNS + ')\\b[^.?!]*'
      + '(?:\\s+(?:again|now|please|today|tonight|tomorrow|for\\s+me))?\\s*$', 'i');
    if (imperative.test(text)) return { site: 'toddle' };
    // Existence question: "do i have any homework", "is there any assignment",
    // "do i have anything due today".
    if (/^(?:do\s+i\s+have|do\s+we\s+have|is\s+there|are\s+there|any)\b/i.test(text)
      && (noun.test(text) || TODO_DUEWORD.test(text))) {
      return { site: 'toddle' };
    }
    // "due process" is legal English, not coursework.
    if (/\bdue\s+process\b/i.test(text)) return null;
    // "what's due", "what do I have due", "what is outstanding / pending",
    // "what homework do I have".
    if (/^what(?:'s|\s+is|\s+are|\s+do\s+i\s+have|\s+do\s+we\s+have|\s+have\s+i\s+got(?:\s+left)?)?\b/i.test(text)
      && (TODO_DUEWORD.test(text) || (noun.test(text) && /\bdo\s+(?:i|we)\s+have\b/i.test(text)))) {
      return { site: 'toddle' };
    }
    // "when is my maths homework due" — needs a school noun, so "when is
    // dinner due" stays an ordinary question.
    if (/^when\b/i.test(text) && /\bdue\b/i.test(text) && noun.test(text)) return { site: 'toddle' };
    // "what's on toddle", "what's on my todo".
    if (/\btoddle\b|\bto\s*-?\s*do\b/i.test(text)
      && /^(?:what(?:'s|\s+is|\s+are)\b.*\bon\b|.*\bon\s+(?:my\s+)?(?:toddle|to\s*-?\s*do)\b)/i.test(text)) {
      return { site: 'toddle' };
    }
    // Bare "my todo list".
    if (/^my\s+(?:to\s*-?\s*do\s*list?|todo\s*list?)\b/i.test(text)) return { site: 'toddle' };
    return null;
  }
  // "Open Magnetic on YouTube" style requests: a wide net of polite leads,
  // verbs, and media nouns, but ALWAYS ending visibly on a known site with a
  // real query — so bare app names ("open Chrome") and bare sites
  // ("open YouTube") never match here.
  const MEDIA_NOUNS = 'song|track|video|channel|artist|movie|trailer|playlist|album|film|clip|episode|podcast';
  function parseSiteSearchIntent(input) {
    const text = String(input || '').trim()
      .replace(/^(?:(?:hey|hi|hello|okay|yo)\s+)?jarvis[\s,:-]*(?:please[\s,:-]+)?/i, '')
      .replace(/^(?:(?:please\s+)?(?:can|could|would|will)\s+you(?:\s+please)?(?:\s+just)?|please|could you please|kindly|just)\s+/i, '')
      .replace(/[.!?]+$/, '').replace(/\s+(?:please|for me)$/i, '').trim();
    const match = text.match(new RegExp('^(search(?:\\s+(?:up|for))?|look\\s+(?:up|for)|find|open(?:\\s+up)?|play|watch|pull\\s+up|bring\\s+up|show(?:\\s+me)?|get(?:\\s+me)?|queue\\s+up|start)\\s+(?:(?:this|the)\\s+)?(?:(?:' + MEDIA_NOUNS + ')\\s+)?(.+?)\\s+(?:on|in|using)\\s+(youtube\\s+music|youtube|google)(?:\\s+(?:website|web|site))?$', 'i'));
    if (!match) return null;
    const query = match[2].trim().replace(new RegExp('^(?:the\\s+)?(?:' + MEDIA_NOUNS + ')\\s+', 'i'), '');
    const provider = match[3].toLowerCase().replace(/\s+/g, ' ');
    if (!query || /^(?:this|that|it|something)$/.test(query.toLowerCase())) return null;
    return { site: provider === 'youtube music' ? 'youtube-music' : provider, query, silent: /^(?:search|look\s+(?:up|for)|find|pull\s+up|bring\s+up|show|get|queue\s+up)/i.test(match[1]) };
  }
function parseSearchCommand(input) {
    let text = String(input || '').trim()
      .replace(/^(?:(?:hey|hi|hello|okay|yo)\s+)?jarvis[\s,:-]*/i, '')
      .replace(/^(?:(?:can|could|would) you(?: please)?|please|just)\s+/i, '')
      .replace(/[.!?]+$/, '').trim();
    // Remove filler words that appear as parenthetical elements or standalone
    text = text.replace(/,\s*(?:uh|um|like|you know)\s*,/gi, ' ');
    text = text.replace(/^(?:uh|um|like|you know)\s*,?\s*/i, '');
    text = text.replace(/,\s*(?:uh|um|like|you know)\s*$/i, '');
    // Remove "for me" / "for us" — handles both comma-surrounded and inline forms
    text = text.replace(/,\s*for\s+(?:me|us)\s*,/gi, ' ');
    text = text.replace(/\s+for\s+(?:me|us)\b/i, '');
    // Clean up any leftover commas from filler removal
    text = text.replace(/\s*,\s*/g, ' ').replace(/\s+/g, ' ').trim();
    // Match search command patterns — command phrase is fully consumed before
    // extracting the query, so "for" in "look up for" never leaks into it.
    // Order matters: more specific patterns must come before generic ones.
    const patterns = [
      /^look\s+up\s+what\s+we\s+have\s+for\s+(.+)$/i,
      /^search\s+the\s+web\s+for\s+(.+)$/i,
      /^look\s+up\s+(?:for\s+)?(.+)$/i,
      /^search\s+up\s+(?:for\s+)?(.+)$/i,
      /^search\s+(?:for\s+)?(.+)$/i,
      /^google\s+(.+)$/i,
      /^find\s+(.+)$/i,
    ];
    let match = null;
    for (const pattern of patterns) {
      match = text.match(pattern);
      if (match) break;
    }
    if (!match) return null;
    let query = match[1].trim();
    // Extract explicit destination: "on Google", "on YouTube Music",
    // "on YouTube", "on the web". Only match known destinations so "on Friday"
    // or "on Frieren" stays in the query.
    const destMatch = query.match(/^(.+?)\s+on\s+(google|youtube\s+music|youtube|the\s+web|web)$/i);
    let site = 'google';
    if (destMatch) {
      query = destMatch[1].trim();
      const dest = destMatch[2].toLowerCase().replace(/\s+/g, ' ');
      if (dest === 'youtube music') site = 'youtube-music';
      else if (dest === 'youtube') site = 'youtube';
      else site = 'google';
    }
    return query ? { site, query, silent: true } : null;
  }
  // "Open a new tab on Google" / "open a new tab to Google" — opens a fresh
  // tab at google.com in the controlled browser session.
  function parseOpenGoogleTabIntent(input) {
    const text = String(input || '').trim()
      .replace(/^(?:(?:hey|hi|hello|okay)\s+)?jarvis[\s,:-]*/i, '')
      .replace(/^(?:(?:can|could|would) you(?: please)?|please|just)\s+/i, '')
      .replace(/[.!?]+$/, '').trim();
    const match = text.match(/^(?:open|start|launch)\s+(?:a\s+)?new\s+tab\s+(?:on|to|in)\s+google$/i);
    return match ? { url: 'https://www.google.com' } : null;
  }
  function isDirectResearchQuestion(input) {
    const text = String(input || '').trim().replace(/^(?:(?:hey|hi|hello|okay)\s+)?jarvis[\s,:-]*/i, '').replace(/^(?:(?:can|could|would) you(?: please)?|please|just)\s+/i, '').trim();
    if (/^(?:how are you|how is your day|how's your day|what should i eat|what can you do|what do you remember)\b/i.test(text)) return false;
    return /^(?:what (?:is|are|was|were|does|do|did)\b|who (?:is|are|was|were)\b|why\b|how (?:does|do|did|is|are|can|could|to)\b|where (?:is|are|was|were|can)\b|when (?:is|are|was|were|did|does|do)\b|which\b)/i.test(text);
  }
  function parseCloseIntent(input) {
    const text = String(input || '').trim().replace(/^(?:(?:hey|hi|hello|okay)\s+)?jarvis[\s,:-]*/i, '').replace(/^(?:(?:can|could|would) you(?: please)?|please|just)\s+/i, '').replace(/[.!?]+$/, '').trim();
    // Tab targets keep their own branch so "close the YouTube tab" is never
    // treated as "close an application named YouTube tab".
    if (/\btabs?\b/i.test(text) && /^(?:close|shut|exit|quit)\b/i.test(text)) {
      const bare = text.replace(/\s+(?:and\s+)?keep (?:the\s+)?browser(?:\s+open)?$/i, '').trim();
      const bareTab = bare.match(/^(?:close|shut|exit|quit)\s+(?:(?:the|this|current|my|active)\s+)?(?:(?:browser|chrome|edge|firefox|brave)\s+)?tab(?:\s+please)?$/i);
      if (bareTab) return { kind: 'close-current-tab' };
      if (/tabs?$/i.test(bare)) {
        const ordinal = parseOrdinalTarget(bare);
        if (ordinal) return { kind: 'close-tab-position', position: ordinal.position, last: ordinal.last };
        const namedTab = bare.match(/^(?:close|shut|exit|quit)\s+(?:(?:the|this|current|my|active)\s+)?(.+?)\s+tabs?$/i);
        const query = namedTab?.[1]?.trim() || '';
        if (query && !/^(?:the|this|current|my|active|browser|one|some|all)$/i.test(query)) return { kind: 'close-named-tab', query };
        return { kind: 'close-current-tab' };
      }
      // Qualified tab targets: "close the tab playing music", "close the tab
      // for youtube". Without this branch those fell through to "close an app
      // named ...", which can never work.
      const qualified = bare.match(/^(?:close|shut|exit|quit)\s+(?:(?:the|this|current|my|active)\s+)?tab\s+(.+)$/i);
      if (qualified) {
        const qualifier = qualified[1].trim();
        if (/^(?:playing(?: some)? music|playing audio|with (?:music|audio|sound))$/i.test(qualifier)) return { kind: 'close-music-tab' };
        const forSite = qualifier.match(/^(?:for|about|on|showing|with)\s+(.+)$/i);
        if (forSite && forSite[1].trim()) return { kind: 'close-named-tab', query: forSite[1].trim() };
        if (qualifier) return { kind: 'close-named-tab', query: qualifier };
      }
    }
    const current = text.match(/^(?:close|shut|exit|quit)\s+(?:(?:the|this|current|my|active)\s+)?(?:app|application|program|window|it)(?:\s+please)?$/i);
    if (current) return { kind: 'close-current-app' };
    const named = text.match(/^(?:close|shut|exit|quit)\s+(?:(?:the|this|my|active)\s+)?(.+?)(?:\s+please)?$/i);
    if (!named || /^(?:tabs?|window|application|program|app|it|this|active)$/i.test(named[1].trim())) return null;
    const name = named[1].replace(/^(?:app|application|program)\s+/i, '').replace(/\s+(?:app|application|program)$/i, '').trim();
    return name ? { kind: 'close-app', name } : { kind: 'close-current-app' };
  }
  function parseMusicIntent(input) {
    const text = String(input || '').trim().replace(/[.!?]+$/, '')
      .replace(/^(?:(?:hey|hi|okay)\s+)?jarvis\b[\s,:-]*/i, '');
    // "Put Magnetic on", "Put the song Magnetic on"
    const putOn = text.match(/^(?:could you\s+|can you\s+|please\s+)?put\s+(?:the\s+song\s+|my\s+song\s+)?(.+?)\s+on$/i);
    if (putOn) {
      const query = putOn[1]?.trim();
      if (query && !/^(?:music|the music)$/i.test(query)) return { kind: 'search', query };
      return null;
    }
    // Explicit play requests. "Play the song Magnetic" and "Play Magnetic by ILLIT"
    // both resolve to the same search; ordinary speech stays excluded.
    const play = text.match(/^(?:could you\s+|can you\s+|please\s+)?play\s+(?:my\s+playlist\s+(.+)|the song\s+(.+)|something\s+(.+)|(.+?)(?:\s+by\s+(.+))?)$/i);
    if (play) {
      // Preserve the "by" separator: "Magnetic by ILLIT" must stay a whole
      // artist-qualified query ("Magnetic ILLIT" dropped the connective the
      // user actually said, which regressed a conversational music test).
      const query = (play[1] ? `playlist ${play[1]}` : play[2] ? play[2] : play[3] ? `${play[3]} music` : `${play[4]}${play[5] ? ` by ${play[5]}` : ''}`).trim();
      // A trailing site ("play Magnetic on YouTube") belongs to the
      // site-search parser, which keeps the site and query separate. Claiming
      // it here would search YouTube Music for "Magnetic on YouTube".
      if (/\s+(?:on|in|using)\s+(?:youtube\s+music|youtube|google)$/i.test(query)) return null;
      return query ? { kind: 'search', query } : null;
    }
    // "Open this song on YouTube Music" names no track: route to a
    // clarification instead of an app launch for "this song on youtube music".
    // With a real title ("open Magnetic on YouTube Music") the site-search
    // parser already handles it.
    const openSong = text.match(/^(?:could you\s+|can you\s+|please\s+)?(?:open|play)\s+(?:this\s+)?song(?:\s+on\s+(?:youtube music|music|youtube))?\s*$/i);
    if (openSong) return { kind: 'search', query: '' };
    return null;
  }
  function parseOpenTabIntent(input) {
    const text = String(input || '').trim().replace(/^(?:(?:hey|hi|hello|okay)\s+)?jarvis[\s,:-]*/i, '').replace(/^(?:(?:can|could|would) you(?: please)?|please|just)\s+/i, '').replace(/[.!?]+$/, '').replace(/\s+please$/i, '').trim();
    if (/^(?:open(?: up)? (?:a )?new tabs?|new tabs?)$/i.test(text)) return { kind: 'open-new-tab' };
    return null;
  }
  // Reopen recently closed tabs/windows (Ctrl+Shift+T in the controlled browser).
  // Flexible keyword matching covers many natural phrasings without exact strings.
  // Returns { kind:'reopen-closed-tab', count, target:'tab'|'window', vague } or null.
  // Vague phrases ("undo that") set vague:true and only execute when caller
  // confirms recent tab-close context; otherwise the caller must clarify.
  function parseReopenTabIntent(input) {
    let text = String(input || '').trim()
      .replace(/^(?:(?:hey|hi|hello|okay)\s+)?jarvis[\s,:-]*/i, '')
      .replace(/^(?:(?:can|could|would) you(?: please)?(?: just)?|please|just)\s+/i, '')
      .replace(/[.!?]+$/, '').replace(/\s+please$/i, '').trim();
    if (!text) return null;
    // ASR fixes: "control shift tea/tee/see" -> "control shift t".
    text = text.replace(/\bcontrol shift (?:tea|tee|see|de)\b/gi, 'control shift t')
      .replace(/\bctrl shift (?:tea|tee|see|de)\b/gi, 'ctrl shift t');
    const lower = text.toLowerCase();
    // Count: words one..ten, digits, or quantifiers.
    const countWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    let count = 1;
    const digitHit = lower.match(/\blast\s+(\d{1,2})\b/) || lower.match(/\b(\d{1,2})\s+closed?\s+tabs?\b/);
    if (digitHit) count = Math.max(1, Math.min(10, Number(digitHit[1])));
    else {
      const wordHit = lower.match(/\blast\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/);
      if (wordHit) count = countWords[wordHit[1]];
    }
    if (/\bmultiple\b|\blast few\b|\blast several\b|\bseveral\b|\bfew\b/i.test(text)) count = 3;
    if (/\ball\b|\beverything\b/i.test(text)) count = 5; // capped, never unlimited
    const mentionsWindow = /\bwindow\b/i.test(text);
    const mentionsTab = /\btabs?\b|\bpages?\b|\bwebsites?\b|\bwebpages?\b|\bsites?\b/i.test(text);
    const mentionsClosed = /\bclosed?\b|\bclosure\b|\baccident/i.test(text)
      || /\bprevious\b|\blast\b|\bjust\b/i.test(text)
      || /\b(ctrl|control)\s*\+?\s*shift\s*\+?\s*t\b/i.test(text)
      || /\bshortcuts?\b/i.test(text);
    const restoreVerb = /\b(reopen|restore|recover|retrieve|bring back|get back|bringback|undo|reverse|re-open)\b/i.test(text)
      || /\bbring\b.+\bback\b/i.test(text) || /\bget\b.+\bback\b/i.test(text);
    const shortcutOnly = /^(?:press|use|do|trigger|perform|execute|run)\s+(?:the\s+|that\s+)?(?:control|ctrl)\s*\+?\s*shift\s*\+?\s*t\b/i.test(text)
      || /\b(reopen|restore|recently closed|undo close|tab recovery)\s+(?:tab\s+)?shortcuts?\b/i.test(text)
      || /^(?:use|do|trigger|perform)\s+the\s+(?:reopen|restore|undo close|tab recovery)\s+shortcut/i.test(text);
    if (shortcutOnly) return { kind: 'reopen-closed-tab', count, target: mentionsWindow ? 'window' : 'tab', vague: false };
    // Explicit reopen: restore verb + tab/window reference, or closed-tab context.
    if (restoreVerb && (mentionsTab || mentionsWindow)) return { kind: 'reopen-closed-tab', count, target: mentionsWindow ? 'window' : 'tab', vague: false };
    if (restoreVerb && mentionsClosed && /\b(that|it|what)\b/i.test(text)) {
      // "bring that back", "reopen what I closed" — tab context via closed/what.
      if (/\btab\b|\bpage\b|\bwebsite\b|\bclosed\b|\bclose\b/i.test(text)) return { kind: 'reopen-closed-tab', count, target: mentionsWindow ? 'window' : 'tab', vague: false };
    }
    // Conversational accident reports with tab context.
    if (mentionsTab && /\baccident/i.test(text)) return { kind: 'reopen-closed-tab', count, target: mentionsWindow ? 'window' : 'tab', vague: false };
    if (/\bclosed?\s+something\s+by\s+accident\b/i.test(text)) return { kind: 'reopen-closed-tab', count, target: 'tab', vague: false };
    // "I lost my tab" / "I lost my page" — lost tab.
    if (/\blost\b.+\b(my\s+)?(tab|page|website)\b/i.test(text)) return { kind: 'reopen-closed-tab', count, target: 'tab', vague: false };
    // Generic "open old/previous tab" should reuse the normal closed-tab
    // reopen path instead of any designated Edge destination.
    if (/^open (?:my )?(?:old|previous|last) (?:tab|page)$/i.test(text)) return { kind: 'reopen-closed-tab', count: 1, target: 'tab', vague: false };
    // "I closed the wrong tab" / "I closed the wrong page" — mistaken close.
    if (mentionsTab && /\bwrong\s+(?:tab|page|website)\b/i.test(text)) return { kind: 'reopen-closed-tab', count, target: mentionsWindow ? 'window' : 'tab', vague: false };
    if (/\brecently closed\b/i.test(text) && mentionsTab) return { kind: 'reopen-closed-tab', count, target: mentionsWindow ? 'window' : 'tab', vague: false };
    if (/\brestore\b/i.test(text) && /\bwhat i was looking at\b/i.test(text)) return { kind: 'reopen-closed-tab', count, target: 'tab', vague: false };
    if (/\btake me back\b/i.test(text) && mentionsTab) return { kind: 'reopen-closed-tab', count, target: mentionsWindow ? 'window' : 'tab', vague: false };
    if (/\b(?:need|want)\b.+\bback\b/i.test(text) && mentionsTab) return { kind: 'reopen-closed-tab', count, target: mentionsWindow ? 'window' : 'tab', vague: false };
    // Vague: undo/bring-back with no tab reference — needs recent-close context.
    if (/^(?:undo that|reverse that|bring that back|get that back|can you bring that back|bring it back|get it back)$/i.test(text)) {
      return { kind: 'reopen-closed-tab', count: 1, target: 'tab', vague: true };
    }
    return null;
  }
  function parseMusicPanelCommand(input) {
    const text = String(input || '').trim().replace(/^(?:(?:hey|hi|hello|okay)\s+)?jarvis[\s,:-]*/i, '').replace(/^(?:(?:can|could|would) you(?: please)?|please|just)\s+/i, '').replace(/[.!?]+$/, '').replace(/\s+please$/i, '').trim();
    if (/^(?:show|open|bring up)(?: the)? music (?:player|panel|orb)$/i.test(text)) return { action: 'show' };
    if (/^(?:hide|close|dismiss)(?: the)? music (?:player|panel|orb)$/i.test(text)) return { action: 'hide' };
    return null;
  }
  // "Ping me" / "test the webhook": explicit requests to fire the Discord
  // notification channel immediately (fixed texts, never free-form).
  function parseDiscordPingCommand(input) {
    const lead = stripPoliteLead(input).replace(/[.!?]+$/, '').replace(/\s+please$/i, '').trim();
    if (/^(?:ping me|send me a ping|ping my (?:phone|discord))(?: on discord)?$/i.test(lead)) return 'ping';
    if (/^(?:test(?: the)? (?:discord )?webhook|test discord notifications?|check discord notifications?)$/i.test(lead)) return 'test';
    return null;
  }
  // Hybrid router gate: true when a request needs Ollama interpretation and
  // tool orchestration instead of a deterministic one-shot handler. Simple
  // commands (one action verb, no references, no questions about results)
  // must keep the fast path — every example below the fast list returns
  // false. Compound, referential, or result-questioning requests return true.
  function needsAiPlanning(input) {
    const text = stripPoliteLead(input).replace(/[.!?]+$/, '').trim();
    const lower = text.toLowerCase();
    const words = lower.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 60) return false;
    // References to previous results plus an action need context resolution.
    if (/\b(that|those|it|they|them|the (?:second|first|third|last|other) (?:one|file|folder|result|tab))\b/i.test(text)
      && /\b(open|read|show|tell|summar|list|look|check|close|play|delete|move|copy)\b/i.test(text)) return true;
    // A question about found items (what is inside, which one) needs results.
    if (/\b(what(?:'s| is)|which|whose|contains?|inside)\b/i.test(text)
      && /\b(folder|file|project|document|them|there|it)\b/i.test(text)) return true;
    // Two or more distinct action verbs joined into one utterance.
    const verbs = lower.match(/\b(find|search|look|open|tell|show|read|list|summar|check|play|close|move|copy|create|set|remind)\b/g) || [];
    if ([...new Set(verbs)].length >= 2 && /(\band\b|\bthen\b|[,;]\s*|\bafter that\b|\bnow\b)/.test(lower)) return true;
    return false;
  }
  // Follow-up references against the most recent file-search results.
  // Returns the referenced item or null (never guesses across types: a folder
  // request matches folders only).
  function resolveTaskReference(input, results = []) {
    const lower = String(input || '').toLowerCase();
    const list = Array.isArray(results) ? results : [];
    if (!list.length) return null;
    const folders = list.filter(item => item && item.type === 'folder');
    const files = list.filter(item => item && item.type !== 'folder');
    if (/\bthat folder\b|\bthe folder\b/.test(lower)) return folders[0] || null;
    if (/\bthat file\b|\bthe file\b/.test(lower)) return files[0] || list[0] || null;
    if (/\bfirst (?:file|one)\b/.test(lower)) return files[0] || list[0] || null;
    if (/\bthat one\b|\bthis one\b|\bit\b/.test(lower)) return list[0] || null;
    return null;
  }
  // "Open my Roblox folder" / "launch the project folder": open-verb plus a
  // folder-ish target. Deliberately requires the folder noun (or directory)
  // so "open Roblox" still goes to the app launcher and "open the calendar"
  // still reaches the planner. Known Windows folders ("open downloads
  // folder") are handled by the dedicated known-folder branch instead.
  function parseFolderOpenIntent(input) {
    const text = stripPoliteLead(input).replace(/[.!?]+$/, '').trim();
    const match = text.match(/^(?:open|launch|show me|show)\s+(?:my\s+|the\s+)?(.+?)\s+(folder|directory)$/i);
    if (!match) return null;
    const query = match[1].trim().replace(/^(?:my|the)\s+/i, '').trim();
    if (!query || /^(?:downloads?|documents?|desktop|pictures?|photos?|videos?|music)$/i.test(query)) return null;
    return { query: query.slice(0, 100) };
  }
  // Music transport commands: pause/resume/play/stop accept a target
  // (the music, the song, it, this, playback, what's playing) or stand alone;
  // skip/next/previous/replay take an optional target; volume needs up/down.
  // Deliberately NOT matching: "stop talking", "stop the alarm", "play on".
  const MUSIC_CONTROL_PATTERN = /^(?:(?<verb>pause|resume|continue|play|stop)(?:\s+(?:the\s+)?(?:music|song|this\s+song|that\s+song|it|this|that|playback)|(?:\s+what(?:'s|s| is) playing))?|(?<skip>next|skip)(?:\s+(?:song|track|it|this))?|(?<prev>previous|replay)(?:\s+(?:song|track|the\s+song))?|(?<vol>volume\s+(?:up|down)))$/i;
  function parseMusicControl(input) {
    const match = String(input || '').toLowerCase().match(MUSIC_CONTROL_PATTERN);
    if (!match) return null;
    const groups = match.groups || {};
    if (groups.vol) return { command: groups.vol.replace(/\s+/, '-') };
    if (groups.skip) return { command: 'next' };
    if (groups.prev) return { command: groups.prev };
    const verb = groups.verb || '';
    if (verb === 'resume' || verb === 'continue') return { command: 'play' };
    if (verb === 'pause' || verb === 'play' || verb === 'stop') return { command: verb };
    return null;
  }
  // Mixed small talk plus a music action ("I'm bored, put some music on").
  // Pure so it is unit-testable; the caller opens the service without ever
  // claiming playback. Refusals ("don't put music on") never match.
  function extractEmbeddedMusicCommand(input) {
    const lower = String(input || '').toLowerCase();
    if (/\bput (?:some |the )?music on\b/.test(lower)
      && !/(?:do not|don't|don't|never|stop)\b/i.test(lower)) return 'open-music';
    return null;
  }
  // Recognize natural music commands that don't match parseWebsiteIntent's strict
  // "open <site>" pattern. Catches "open some music", "play some music",
  // "let's listen to music", "put on some music", and specific song/artist
  // requests. Returns { kind:'open-music' } or { kind:'search-music', query }.
  function parseMusicOpenIntent(input) {
    const text = String(input || '').trim()
      .replace(/^(?:(?:hey|hi|hello|okay|yo)\s+)?jarvis[\s,:-]*(?:please[\s,:-]+)?/i, '')
      .replace(/^(?:(?:can|could|would|will)\s+you(?:\s+please)?(?:\s+just)?|please|just)\s+/i, '')
      .replace(/[.!?]+$/, '').replace(/\s+(?:please|for me)$/i, '').trim();
    const lower = text.toLowerCase();
    // Refusals never match.
    if (/(?:do not|don't|don't|never|stop)\b/i.test(lower)) return null;
    // General music requests: "open some music", "play some music",
    // "let's listen to music", "put on some music", "I want music", etc.
    if (/^(?:open|play|start|turn\s+on|put\s+on|listen\s+to|queue\s+up)\s+(?:some\s+|the\s+|me\s+)?music$/i.test(text)
      || /^(?:open|play|start|turn\s+on|put\s+on|listen\s+to|queue\s+up)\s+(?:some\s+|a\s+|the\s+|any\s+)?song$/i.test(text)
      || /^(?:open|launch|start)\s+(?:youtube\s+music|the\s+music\s+(?:player|service|app))$/i.test(text)
      || /^(?:let's|lets)\s+(?:listen\s+to|play|hear)\s+(?:some\s+|a\s+)?(?:music|song|tracks?)$/i.test(text)
      || /^i\s+(?:want|would\s+like|need)\s+(?:(?:some|a|any|the)\s+)?(?:music|song|track|tune)$/i.test(text)
      || /^i\s+(?:want|would\s+like|need)\s+(?:some|a|any|the)\s+(?:music|song|track|tune)\s+(?:playing|to play|to listen to)?$/i.test(text)) {
      return { kind: 'open-music' };
    }
    // Specific song or artist: "play [song name]" / "play [artist name]".
    // Only match when there's a real query — never claim playback for a
    // bare "play" with no target.
    const playMatch = text.match(/^(?:play|listen\s+to)\s+(.+)$/i);
    if (playMatch) {
      const query = playMatch[1].trim()
        .replace(/^(?:the\s+)?(?:song|track|artist|band)\s+/i, '')
        .replace(/\s+(?:on|in|using)\s+(?:youtube\s+music|youtube|spotify)$/i, '')
        .trim();
      if (query && query.length >= 2 && !/^(?:some|the|it|this|that|music)$/i.test(query)) {
        return { kind: 'search-music', query };
      }
    }
    return null;
  }
  // Detect when a command requires browser access (opening websites, the
  // browser itself, or Chrome). Used to auto-enable browser control before
  // attempting navigation so the user never needs "enable browser control".
  function parseBrowserNeedIntent(input) {
    const text = String(input || '').trim()
      .replace(/^(?:(?:hey|hi|hello|okay|yo)\s+)?jarvis[\s,:-]*(?:please[\s,:-]+)?/i, '')
      .replace(/^(?:(?:can|could|would|will)\s+you(?:\s+please)?(?:\s+just)?|please|just)\s+/i, '')
      .replace(/[.!?]+$/, '').replace(/\s+(?:please|for me)$/i, '').trim();
    const lower = text.toLowerCase();
    // "open Chrome", "open browser", "open Google Chrome", etc.
    if (/^(?:open|launch|start|fire\s+up|bring\s+up)\s+(?:up\s+)?(?:the\s+|my\s+)?(?:browser|chrome|google\s+chrome|firefox|edge|internet\s+explorer|web\s+browser)$/i.test(text)) return { kind: 'open-browser' };
    // Website navigation always needs the browser.
    if (parseWebsiteIntent(text)) return { kind: 'open-website' };
    return null;
  }
  // YouTube video transport: next-video vs seek vs skip-ad vs pause/resume.
  // Pure so it is unit-testable. Deliberately separate from parseMusicControl
  // (which only knows song/track/it/this): every "skip" here names a video,
  // a time offset, or an ad, so the caller can route to the real YouTube tab
  // instead of the generic music handler.
  function parseYouTubeControl(input) {
    const text = stripPoliteLead(input).replace(/[.!?]+$/, '').trim();
    if (!text) return null;
    const lower = text.toLowerCase();
    // Refusals and unrelated "skip" nouns never match.
    if (/^(?:do not|don't|don’t|never)\b/i.test(text)) return null;
    // Skip advertisement: only when an ad noun is present.
    if (/\bskip\b[^.]{0,24}\bads?\b/i.test(text) || /\bskip\b[^.]{0,24}\badvertisement\b/i.test(text) || /\bskip\b[^.]{0,24}\bcommercial\b/i.test(text)) {
      return { kind: 'skip-ad' };
    }
    // Seek forward: "skip ahead 10 seconds", "skip forward 30 seconds",
    // "go forward 10 seconds", "fast forward", "seek forward 15 seconds".
    let m = lower.match(/\b(?:skip\s+(?:ahead|forward)|fast\s*forward|seek\s+forward|go\s+forward|forward)\b(?:\s+(?:by\s+|for\s+)?(\d{1,3})\s*(?:sec(?:ond)?s?|s\b))?/);
    if (m && /\b(?:ahead|forward|seek|fast)\b/.test(lower) && /\b(?:skip|seek|forward|fast)\b/.test(lower)) {
      // Require an explicit seek verb context so "go to the next video" never
      // lands here. "skip ahead"/"skip forward"/"fast forward"/"seek forward"
      // are seek; plain "skip this video" is handled below.
      if (/\bskip\s+(?:ahead|forward)\b|\bfast\s*forward\b|\bseek\s+forward\b|\bgo\s+forward\b/.test(lower)) {
        const seconds = m[1] ? Math.min(300, Math.max(1, Number(m[1]))) : 10;
        return { kind: 'seek-forward', seconds };
      }
    }
    // Seek backward: "go back 10 seconds", "rewind 15 seconds",
    // "rewind a little", "seek back", "back 10 seconds", "back up a bit".
    m = lower.match(/\b(?:go\s+back|rewind|seek\s+back|back\s+up|move\s+back)\b(?:\s+(?:by\s+|for\s+)?(\d{1,3})\s*(?:sec(?:ond)?s?|s\b))?/);
    if (m && /\b(?:go\s+back|rewind|seek\s+back|back\s+up|move\s+back)\b/.test(lower)) {
      // "go back to the previous video" names a video target: not a seek.
      if (/\bvideo\b|\btrack\b|\bsong\b/.test(lower) && !/\bsecond|\bsec\b|\brewind\b/.test(lower)) {
        // fall through to previous-video below
      } else {
        let seconds = m[1] ? Math.min(300, Math.max(1, Number(m[1]))) : 10;
        if (/\ba\s+little\b|\ba\s+bit\b|\ba\s+lil\b/.test(lower) && !m[1]) seconds = 10;
        return { kind: 'seek-back', seconds };
      }
    }
    // Bare "back 10 seconds" / "forward 30 seconds" without a verb.
    m = lower.match(/^(?:back|backward)\s+(\d{1,3})\s*(?:sec(?:ond)?s?|s)?$/);
    if (m) return { kind: 'seek-back', seconds: Math.min(300, Math.max(1, Number(m[1]))) };
    m = lower.match(/^(?:forward|ahead)\s+(\d{1,3})\s*(?:sec(?:ond)?s?|s)?$/);
    if (m) return { kind: 'seek-forward', seconds: Math.min(300, Math.max(1, Number(m[1]))) };
    // Previous video (explicit video/track noun required so "go back 10
    // seconds" never lands here).
    if (/^(?:go\s+back\s+to|back\s+to|play\s+the|go\s+to\s+the)\s+(?:the\s+|previous\s+)?(?:previous\s+)?(?:video|youtube\s+video)\b/i.test(text)
      || /^(?:previous|replay)(?:\s+(?:video|youtube\s+video|the\s+video))$/i.test(text)
      || /^play\s+the\s+previous\s+video$/i.test(text)) {
      return { kind: 'previous-video' };
    }
    // Next video: explicit video/one/playlist context required so bare music
    // "skip"/"next" keep flowing to parseMusicControl unchanged.
    if (/^(?:skip|next)\s+(?:to\s+)?(?:the\s+)?next(?:\s+(?:video|youtube\s+video))?$/i.test(text)
      || /^(?:skip|next)(?:\s+(?:this|that|the))?\s+(?:video|youtube\s+video|vid|episode|clip)(?:\s+(?:please|for me))?$/i.test(text)
      || /^skip\s+(?:this|that|the)\s+one(?:\s+(?:please|for me))?$/i.test(text)
      || /^play\s+the\s+next\s+(?:video|youtube\s+video)(?:\s+(?:please|for me))?$/i.test(text)
      || /^go\s+to\s+the\s+next\s+(?:video|youtube\s+video)(?:\s+(?:please|for me))?$/i.test(text)
      || /^skip\s+to\s+(?:the\s+)?next(?:\s+(?:video|one))?(?:\s+(?:please|for me))?$/i.test(text)
      || /^next\s+(?:video|youtube\s+video|one|up)(?:\s+(?:please|for me))?$/i.test(text)) {
      return { kind: 'next-video' };
    }
    // Video-scoped pause/resume so "pause the video" targets the YouTube tab
    // even when several music tabs are open.
    if (/^(?:pause|resume|continue|play|stop)(?:\s+(?:the\s+|this\s+|that\s+)?(?:video|youtube(?:\s+video)?|playback|it))?(?:\s+(?:please|for me))?$/i.test(text)
      && /\bvideo\b|\byoutube\b|\bplayback\b/.test(lower)) {
      const verb = (lower.match(/^(pause|resume|continue|play|stop)/) || [])[1] || '';
      if (verb === 'resume' || verb === 'continue') return { kind: 'play' };
      if (verb === 'pause' || verb === 'play' || verb === 'stop') return { kind: verb };
    }
    return null;
  }
  // "I'm bored" YouTube discovery. Pure and side-effect free: classifies the
  // request and extracts a topic/query or a selection index. The caller owns
  // search, history, and browser navigation.
  function parseDiscoveryIntent(input) {
    const text = stripPoliteLead(input).replace(/[.!?]+$/, '').trim();
    if (!text) return null;
    const lower = text.toLowerCase();
    if (/^(?:do not|don't|don’t|never)\b/i.test(text)) return null;
    // Preference memory controls.
    if (/^(?:clear|forget|delete|reset)(?:\s+(?:my|the|all))?\s+(?:video|watch|youtube|viewing|recommendation)\s+(?:preferences|history|memory)(?:\s+please)?$/i.test(text)
      || /^forget\s+what\s+i\s+(?:watched|watch)(?:\s+please)?$/i.test(text)) {
      return { kind: 'discovery-clear' };
    }
    // Go back to previous recommendations.
    if (/^(?:go\s+back\s+to|show\s+me\s+)?(?:the\s+)?previous\s+recommendations?(?:\s+please)?$/i.test(text)
      || /^go\s+back$/i.test(text) && /recommend|video|suggest/i.test(lower) === false && false) {
      return { kind: 'discovery-back' };
    }
    if (/^go\s+back\s+to\s+the\s+previous\s+recommendations?$/i.test(text)) return { kind: 'discovery-back' };
    // Open/play a numbered recommendation: "open the first one", "play the
    // second video", "open number 3", "play it", "open that one".
    const ordinalWords = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, '1st': 1, '2nd': 2, '3rd': 3 };
    let sel = text.match(/^(?:open|play|show|watch|start)\s+(?:the\s+)?(first|second|third|fourth|fifth|sixth|1st|2nd|3rd|\d)(?:\s+(?:one|video|result|recommendation|option|choice))?(?:\s+please)?$/i);
    if (sel) {
      const raw = sel[1].toLowerCase();
      const index = ordinalWords[raw] || Number(raw);
      if (index >= 1 && index <= 6) return { kind: 'discovery-open', index };
    }
    if (/^(?:open|play|watch|show)\s+(?:it|that(?:\s+one)?|this(?:\s+one)?|that\s+video|this\s+video)(?:\s+please)?$/i.test(text)) {
      return { kind: 'discovery-open', index: 1 };
    }
    // "Show me more" / "another one" / "surprise me" pagination.
    if (/^(?:show\s+me\s+more|find\s+more|more\s+(?:videos|results|options)|another\s+one|give\s+me\s+another(?:\s+one)?|one\s+more)(?:\s+please)?$/i.test(text)) {
      return { kind: 'discovery-more' };
    }
    if (/^surprise\s+me(?:\s+with\s+(?:a\s+)?(?:a\s+video|video|something))?(?:\s+please)?$/i.test(text)) {
      return { kind: 'discovery-again' };
    }
    // Refinements: "find something funnier", "something about AI instead",
    // "find something shorter", "not that kind of video".
    let refine = text.match(/^(?:find|show|get|give)(?:\s+me)?\s+something\s+(funnier|scarier|shorter|longer|newer|better|different|else|educational|funny|interesting)(?:\s+please)?$/i);
    if (refine) return { kind: 'discovery-refine', refinement: refine[1].toLowerCase() };
    if (/^(?:something|anything)\s+about\s+(.+)$/i.test(text) || /^.+?\s+instead$/i.test(text) && /\babout\b/i.test(text)) {
      const about = text.match(/about\s+(.+?)(?:\s+instead)?$/i);
      if (about && about[1].trim()) return { kind: 'discovery-refine', topic: about[1].trim().slice(0, 120) };
    }
    if (/^not\s+that\s+kind\s+of\s+video(?:\s+please)?$/i.test(text)) return { kind: 'discovery-refine', refinement: 'different' };
    if (/^find\s+another\s+one\s+like\s+that$/i.test(text)) return { kind: 'discovery-similar' };
    // Fresh discovery requests.
    if (/^i\s*(?:am|’m|'m)\s+(?:so\s+)?bored(?:\s+right\s+now)?(?:\s+please)?$/i.test(text)
      || /^(?:so\s+bored(?:\s+right\s+now)?|bored\s+out\s+of\s+my\s+mind|there\s+is\s+nothing\s+to\s+do|i\s+have\s+nothing\s+to\s+do|killing\s+time)(?:\s+please)?$/i.test(text)) {
      return { kind: 'discovery-bored' };
    }
    // "Find a Cool Video" (button + voice): one varied pick, opened for the
    // user. Same discovery pipeline as boredom mode, different presentation.
    // MUST come before the general find/show/get/give pattern below.
    if (/^(?:find|show|get|give)(?:\s+me)?\s+(?:a\s+)?cool\s+videos?(?:\s+please)?$/i.test(text)
      || /^(?:find|show|get|give)(?:\s+me)?\s+something\s+interesting\s+to\s+watch(?:\s+please)?$/i.test(text)) {
      return { kind: 'discovery-cool' };
    }
    // "Find something other than gaming": varied pick outside one family.
    let otherThan = text.match(/^(?:find|show|get|give)(?:\s+me)?\s+something\s+(?:other\s+than|besides|not)\s+(.+?)(?:\s+please)?$/i);
    if (otherThan && otherThan[1].trim()) {
      return { kind: 'discovery-cool', avoid: otherThan[1].trim().slice(0, 60) };
    }
    // "Show me another video": fresh pick (resolves against context when any).
    if (/^(?:show|find|give|get)(?:\s+me)?\s+another\s+(?:video|one|pick)(?:\s+please)?$/i.test(text)) {
      return { kind: 'discovery-more' };
    }
    // Rejection: "not that", "don't like that" — adjust the next search.
    if (/^(?:no[,.]?\s+)?(?:not\s+that(?:\s+one|\s+video)?|do\s*no?t\s+like\s+that|did\s*no?t\s+like\s+that|skip\s+that(?:\s+one|\s+video)?)(?:\s+please)?$/i.test(text)) {
      return { kind: 'discovery-refine', refinement: 'different' };
    }
    let req = text.match(/^(?:find(?:\s+me)?|show(?:\s+me)?|get(?:\s+me)?|give(?:\s+me)?|recommend|surprise(?:\s+me)?(?:\s+with)?|play(?:\s+me)?)\s+(?:me\s+)?(?:a\s+|an\s+|some\s+|something\s+)?(.+?)(?:\s+please)?$/i);
    if (req) {
      const rest = req[1].trim();
      // Must be watch-related so ordinary "find X files" never lands here.
      if (/\b(?:to\s+watch|watch|youtube|video|videos|shorts?|entertaining|entertainment|interesting|funny|fun|bored|recommendation|recommend|suggest|surprise)\b/i.test(text)) {
        // Drop the media wrapper to get the topic: "a good youtube video" ->
        // "", "something funny" -> "funny", "a video about roblox" -> "roblox".
        let topic = rest
          .replace(/^(?:something\s+|anything\s+|some\s+)?(?:good\s+|great\s+|cool\s+|nice\s+|decent\s+)?(?:youtube\s+)?(?:videos?\s+|shorts\s+|clips?\s+)?(?:to\s+watch\s*)?/i, '')
          .replace(/^(?:to\s+watch\s*)/i, '')
          .replace(/\b(?:on\s+youtube|youtube\s+video|youtube|videos|to\s+watch|for\s+me)\b/gi, ' ')
          .replace(/\s+/g, ' ').trim();
        const aboutMatch = text.match(/\babout\s+(.+?)(?:\s+please)?$/i);
        if (aboutMatch && aboutMatch[1].trim()) topic = aboutMatch[1].trim().slice(0, 120);
        else if (/^(?:i\s+want\s+to\s+watch|i\s+am\s+bored)/i.test(text)) topic = '';
        topic = topic.replace(/\bvideos?\b/gi, ' ').replace(/\bclips?\b/gi, ' ').replace(/\s+/g, ' ').trim();
        topic = topic.replace(/^(?:a|an|the)\s+/i, '').trim().slice(0, 120);
        // Bare media wrappers ("a good video", "something to watch") carry no
        // topic: treat as a generic bored request for varied suggestions.
        if (/^(?:good|great|cool|nice|decent|new|best|top)?$/i.test(topic)) topic = '';
        if (/^(?:i\s+have\s+nothing|there\s+is\s+nothing|killing\s+time)/i.test(text)) topic = '';
        return { kind: topic ? 'discovery-search' : 'discovery-bored', topic, query: topic };
      }
    }
    if (/^i\s+want\s+to\s+watch\s+(?:something\s+)?(.+?)(?:\s+please)?$/i.test(text)) {
      const topic = (text.match(/^i\s+want\s+to\s+watch\s+(?:something\s+)?(.+?)(?:\s+please)?$/i) || [])[1] || '';
      const clean = topic.replace(/\binteresting\b/i, '').trim().slice(0, 120);
      return { kind: clean ? 'discovery-search' : 'discovery-bored', topic: clean, query: clean };
    }
    return null;
  }
  // Local topic helpers for discovery (no network, no model needed).
  // Maps free text onto a safe YouTube search query; returns '' when the
  // request is a generic "I'm bored" with no usable topic.
  function extractDiscoveryTopic(input) {
    const text = String(input || '').toLowerCase();
    const about = text.match(/\babout\s+([a-z0-9][a-z0-9 .'\-]{1,80})/);
    if (about) return about[1].replace(/\s+(please|for me|instead)$/, '').trim().slice(0, 120);
    for (const word of ['roblox', 'minecraft', 'gaming', 'funny', 'comedy', 'science', 'space', 'astronomy', 'technology', 'ai', 'artificial intelligence', 'coding', 'programming', 'documentary', 'music', 'tutorial', 'mystery', 'history', 'nature', 'cooking', 'short']) {
      if (text.includes(word)) return word === 'artificial intelligence' ? 'AI' : word;
    }
    return '';
  }
  function discoveryQueriesFor(topic, { varied = false } = {}) {
    const clean = String(topic || '').trim().slice(0, 120);
    if (clean) return [clean];
    if (varied) return ['funny videos', 'interesting science explained', 'gaming highlights'];
    return ['interesting videos'];
  }
  // "Find a Cool Video" rotation pool: broad families so gaming is one option
  // among many, never the default. Pure and deterministic (round-robin via
  // counter) so variety is testable and never random without relevance.
  function coolTopicPool() {
    return [
      { q: 'interesting science experiments', family: 'science' },
      { q: 'funny videos', family: 'fun' },
      { q: 'space discoveries', family: 'space' },
      { q: 'cool tech inventions', family: 'tech' },
      { q: 'roblox funny moments', family: 'gaming' },
      { q: 'unsolved mysteries explained', family: 'mystery' },
      { q: 'cool coding projects', family: 'coding' },
      { q: 'engineering marvels', family: 'engineering' },
      { q: 'fascinating documentaries', family: 'documentary' },
      { q: 'AI explained simply', family: 'ai' },
      { q: 'anime highlights', family: 'anime' },
      { q: 'amazing music performances', family: 'music' },
      { q: 'surprising facts', family: 'facts' },
      { q: 'how things work', family: 'howto' },
      { q: 'gaming highlights', family: 'gaming' },
      { q: 'ocean discoveries', family: 'nature' }
    ];
  }
  // Order rotation candidates: skip recently used topics and avoided
  // families, boost a repeated personal interest (heard 2+ times) to the
  // front when it survives filtering, then round-robin from counter.
  function pickCoolTopic({ recentTopics = [], avoid = '', counter = 0, preferredFamilies = [] } = {}) {
    const pool = coolTopicPool();
    const recent = new Set((Array.isArray(recentTopics) ? recentTopics : []).map(s => String(s).toLowerCase()));
    const avoidWords = String(avoid || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const familyOf = word => {
      const w = String(word).toLowerCase();
      if (/^(gaming|roblox|minecraft|fortnite)$/.test(w)) return 'gaming';
      if (/^(anime|animation)$/.test(w)) return 'anime';
      if (/^(space|astronomy)$/.test(w)) return 'space';
      if (/^(science)$/.test(w)) return 'science';
      if (/^(music)$/.test(w)) return 'music';
      return w;
    };
    const avoided = new Set(avoidWords.map(familyOf));
    let remaining = pool.filter(entry => !recent.has(entry.q.toLowerCase()) && !avoided.has(entry.family));
    if (!remaining.length) {
      remaining = pool.filter(entry => !avoided.has(entry.family));
    }
    if (!remaining.length) remaining = pool.slice();
    const preferred = (Array.isArray(preferredFamilies) ? preferredFamilies : []).map(f => String(f).toLowerCase());
    const boosted = remaining.filter(entry => preferred.includes(entry.family));
    const ordered = [...boosted, ...remaining.filter(entry => !preferred.includes(entry.family))];
    const start = Number.isFinite(Number(counter)) ? Math.abs(Math.floor(Number(counter))) % ordered.length : 0;
    const rotated = [...ordered.slice(start), ...ordered.slice(0, start)];
    return { topic: rotated[0].q, family: rotated[0].family, choices: rotated.slice(0, 3).map(entry => entry.q) };
  }
  function toConversationMessages(history, limit = 16) {
    return (Array.isArray(history) ? history : []).slice(-Math.max(2, limit)).map(item => ({
      role: item.who === 'YOU' || item.role === 'user' ? 'user' : 'assistant',
      content: String(item.text ?? item.content ?? '').slice(0, 6000)
    })).filter(item => item.content.trim());
  }
  function normalizeConversationText(value) {
    let text = String(value || '').toLowerCase().replace(/[’‘]/g, "'").trim();
    text = text.replace(/\b(can't)\b/g, 'cannot').replace(/\bwon't\b/g, 'will not').replace(/\b(don't)\b/g, 'do not').replace(/\bdoesn't\b/g, 'does not').replace(/\bdidn't\b/g, 'did not').replace(/\bi'm\b/g, 'i am').replace(/\bi've\b/g, 'i have').replace(/\bi'd\b/g, 'i would').replace(/\byou're\b/g, 'you are').replace(/\byou've\b/g, 'you have').replace(/\byou'd\b/g, 'you would').replace(/\bit's\b/g, 'it is').replace(/\bthat's\b/g, 'that is').replace(/\bwhat's\b/g, 'what is').replace(/\bhow's\b/g, 'how is').replace(/\bthere's\b/g, 'there is');
    text = text.replace(/\b(gonna|wanna|gotta|hafta)\b/g, (match, word) => ({ gonna: 'going to', wanna: 'want to', gotta: 'got to', hafta: 'have to' }[word] || word))
      .replace(/\b(kinda|sorta)\b/g, (match, word) => (word === 'kinda' ? 'kind of' : 'sort of'))
      .replace(/\b(lemme|gimme)\b/g, (match, word) => (word === 'lemme' ? 'let me' : 'give me'))
      .replace(/\bdunno\b/g, 'do not know')
      .replace(/\b(i|you|we|they)'ll\b/g, '$1 will');
    text = text.replace(/\bidk\b/g, 'i do not know').replace(/\bim\b/g, 'i am').replace(/\bur\b/g, 'you are').replace(/\bthx\b/g, 'thanks').replace(/\bty\b/g, 'thank you');
    // Strip hesitation only at the start. Preserve literal uses such as "the well is deep".
    text = text.replace(/^well\s*,\s*/i, '').replace(/^well\s+(?=(?:i\b|it\b|today\b|that\b|you\b|okay\b|ok\b|fine\b|great\b|good\b|bad\b|terrible\b|not\b|maybe\b|i guess\b))/i, '');
    text = text.replace(/^(?:(?:um+|uh+|erm+|hmm+|so|like)\b[\s,]*)+/i, '');
    return text.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }
  function flattenConversationLibrary(library) {
    return (library?.categories || []).flatMap(category => category.intents || []);
  }
  // Natural Discord phrasings:
  //   "Send Alex a message on Discord", "Message Alex on Discord",
  //   "DM Alex", "Send Alex a Discord message"
  // The message body is optional; when it is missing JARVIS asks for the text
  // before anything is sent. Never match generic "message" phrases that do not
  // mention Discord.
  function parseDiscordIntent(input) {
    const text = String(input || '').trim().replace(/[.!?]+$/, '')
      .replace(/^(?:(?:hey|hi|okay)\s+)?jarvis\b[\s,:-]*/i, '');
    const patterns = [
      /^(?:(?:can|could|would) you\s+|please\s+)?send\s+(?:a\s+)?(?:dm\s+|discord\s+message\s+|message\s+)?(?:to\s+)?([A-Za-z0-9_\-\.\s]{2,40}?)\s+(?:on\s+discord|a\s+discord\s+message)(?:\s+(?:saying|that|about|:|,|-)\s+(.+))?$/i,
      /^(?:(?:can|could|would) you\s+|please\s+)?(?:message|dm|discord\s+message)\s+([A-Za-z0-9_\-\.\s]{2,40}?)(?:\s+on\s+discord)?(?:\s+(?:saying|that|about|:|,|-)\s+(.+))?$/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const recipient = match[1].trim().replace(/\s+(?:a\s+)?message$/i, '').trim();
        const body = (match[2] || '').trim();
        if (recipient && recipient.toLowerCase() !== 'discord') return { kind: 'send-discord', recipient, body };
      }
    }
    return null;
  }
  // Intent ids whose replies are an invitation to keep talking. When the
  // app hands back one of these replies, it arms the shared pending question
  // so the user can continue WITHOUT another wake word. Deliberately narrow:
  // command confirmations and factual answers never arm the bridge.
  const CONVERSATION_BRIDGE_INTENTS = [
    'mood_positive', 'mood_okay', 'mood_negative',
    'feeling_stressed', 'feeling_angry', 'feeling_lonely', 'feeling_excited', 'feeling_worried',
    'good_news', 'need_encouragement', 'need_distraction',
    'lets_talk', 'joke_request', 'surprise', 'interesting_fact', 'guess_what', 'curiosity',
    'boredom', 'how_are_you', 'what_now', 'wait'
  ];
  // Conversational TASKS the local model must generate fresh each time
  // (quiz, riddle, story, challenge, re-explanation). Classified by pattern
  // match; the app routes them to Ollama with a task instruction so the
  // model invents new content per turn, and the follow-up bridge keeps the
  // mic open for the user's answer. Falls back to small offline pools in
  // the library when the model is unavailable.
  const CONVERSATION_TASK_INTENTS = {
    quiz_request: {
      instruction: 'Ask me ONE short quiz or trivia question on a fun general-knowledge topic and wait for my answer. Do not reveal the answer until I have tried. One question only.',
      topicFrom: 'quiz me on (.+)$|quiz about (.+)$'
    },
    riddle_request: {
      instruction: 'Tell me ONE original riddle and wait for my guess. Do not reveal the answer until I have tried. One riddle only.',
      topicFrom: ''
    },
    story_request: {
      instruction: 'Tell me a short original story, spoken naturally, a few sentences long. One complete story, no cliffhanger.',
      topicFrom: 'story about (.+)$'
    },
    challenge_request: {
      instruction: 'Give me ONE small fun challenge or brain-teaser I can try right now, explained simply, and wait to see how I do.',
      topicFrom: ''
    },
    explain_differently: {
      instruction: 'Explain your previous answer differently: new words, another angle, more simply. Do not repeat the earlier explanation unchanged.',
      topicFrom: ''
    },
  };
  const CONVERSATION_TASK_PATTERNS = {
    quiz_request: [/\bquiz me\b/i, /\bquiz time\b/i, /\btest my knowledge\b/i, /\bask me a (?:quiz |trivia )?question\b/i, /\bgive me a trivia (?:question|game)\b/i, /\btrivia question\b/, /\bdo a quiz\b/i, /\bquiz about\b/i, /\bquiz on\b/i, /\bquick quiz\b/i, /\btest me\b/i],
    riddle_request: [/\btell me a riddle\b/i, /\bgive me a riddle\b/i, /\bask me a riddle\b/i, /\ba riddle please\b/i, /\bany riddles?\b/i, /\bknow any riddles\b/i, /\briddle me this\b/i, /\bhit me with a riddle\b/i, /\btry a riddle\b/i, /\bdo a riddle\b/i, /\briddle time\b/i],
    story_request: [/\btell me a story\b/i, /\btell me a short story\b/i, /\bmake up a story\b/i, /\bread me a story\b/i, /\bi want a story\b/i, /\bstory time\b/i, /\btell an original story\b/i, /\binvent a story\b/i, /\bcompose a story\b/i, /\bgive me a story\b/i, /\bnarrate a story\b/i],
    challenge_request: [/\bgive me a challenge\b/i, /\bchallenge me\b/i, /\bturn up the challenge\b/i, /\bgive me a brain-teaser\b/i, /\bbrain teaser\b/, /\btest my brain\b/i, /\bgive me a puzzle\b/i, /\bpuzzle me\b/i, /\bset me a challenge\b/i, /\bi want a challenge\b/i, /\bgive me something hard\b/i],
    explain_differently: [/\bexplain (?:that|it|this) differently\b/i, /\bcan you explain differently\b/i, /\bi don'?t understand,? explain differently\b/i, /\bthat didn'?t help,? explain (?:it )?differently\b/i, /\bsay it another way\b/i, /\bput it differently\b/i, /\bexplain simpler\b/i, /\bexplain it more simply\b/i, /\bin simpler terms?\b/i, /\bsimpler please\b/i, /\bexplain again differently\b/i],
  };
  function parseConversationTaskIntent(input) {
    const text = String(input || '').trim();
    if (!text) return null;
    const lead = stripPoliteLead(text).replace(/[.!?]+$/, '').trim();
    if (!lead) return null;
    for (const [task, patterns] of Object.entries(CONVERSATION_TASK_PATTERNS)) {
      for (const re of patterns) {
        if (!re.test(lead)) continue;
        let topic = '';
        if (CONVERSATION_TASK_INTENTS[task].topicFrom) {
          const hit = lead.match(new RegExp(CONVERSATION_TASK_INTENTS[task].topicFrom, 'i'));
          if (hit) topic = String(hit[1] || hit[2] || '').trim().slice(0, 80);
        }
        return { task, topic };
      }
    }
    return null;
  }
  function classifyLocalConversation(input, history = [], library = null) {
    const text = normalizeConversationText(input);
    if (!text) return null;
    const intents = flattenConversationLibrary(library).filter(intent => intent.id !== 'app_open_success');
    if (!intents.length) return null;
    const priorAssistant = [...(Array.isArray(history) ? history : [])].reverse().find(item => item.who !== 'YOU' && item.role !== 'user' && String(item.text ?? item.content ?? '').trim());
    const priorQuestion = String(priorAssistant?.text ?? priorAssistant?.content ?? '');
    const askedWellbeing = /\b(?:how are you|how have you|how is your day|how has your day|how are things)\b/i.test(priorQuestion);
    const contextQuestion = priorQuestion.includes('?');
    const tokens = text.split(' ');
    const shortAnswer = tokens.length <= 4;
    const shortOnly = new Set(['short_yes', 'short_no', 'short_maybe', 'filler']);
    let best = null;
    for (const intent of intents) {
      let score = 0, matchedPhrase = '';
      for (const rawPhrase of intent.patterns || []) {
        const phrase = normalizeConversationText(rawPhrase);
        if (!phrase) continue;
        const exact = phrase === text;
        const contained = (` ${text} `).includes(` ${phrase} `);
        if (!exact && !contained) continue;
        const words = phrase.split(' ').length;
        const candidate = exact ? 20 + words : words === 1 ? 1 : 6 + words;
        if (candidate > score) { score = candidate; matchedPhrase = phrase; }
      }
      if (!score) continue;
      if (intent.id === 'mood_positive' || intent.id === 'mood_okay' || intent.id === 'mood_negative') {
        if (askedWellbeing) score += 12;
        if (/\b(?:not|never|do not|cannot)\s+(?:feeling\s+)?(?:bad|awful|terrible|rough|stressed|upset|down)\b/.test(text) && intent.id === 'mood_okay') score += 18;
        if (/\b(?:not|never|do not|cannot)\s+(?:feeling\s+)?(?:good|great|amazing|fantastic|well)\b/.test(text) && intent.id === 'mood_negative') score += 18;
      }
      if (intent.id === 'acknowledgement' && !askedWellbeing && shortAnswer) score += 8;
      if (shortOnly.has(intent.id) && (!contextQuestion || !shortAnswer)) continue;
      if (intent.id === 'filler' && !contextQuestion) continue;
      if ((intent.id === 'short_yes' || intent.id === 'short_no' || intent.id === 'short_maybe') && !contextQuestion) continue;
      if (!best || score > best.score) best = { intent, score, matchedPhrase };
    }
    if (!best || best.score < 6) return null;
    // The confusion intent is only for a genuine "I did not understand YOU".
    // Whisper returns tiny broken fragments ("what", "huh", "explain that")
    // for partial captures; reacting to those with a long "let me rephrase"
    // speech made JARVIS punt instead of answering real requests. Require at
    // least two words (or a question mark in the original input) before the
    // confusion intent is allowed to win; single-word utterances fall through
    // to the model, which answers everything else.
    if (best.intent.id === 'confusion' && tokens.length < 2 && !/\?\s*$/.test(String(input || '').trim())) return null;
    if (best.intent.id === 'confusion' && tokens.length <= 3 && /^(?:what|huh)\b/.test(text)) return null;
    // Keep factual and open-ended questions on the Ollama path, even when they
    // mention a broad topic such as school, music, or games.
    const questionLike = /\?/.test(String(input)) || /^(?:who|what|when|where|why|how|can you|could you|would you|is there|are there|should i|do you think|what do you)\b/.test(text);
    const localQuestionIntents = new Set(['how_are_you', 'boredom', 'joke_request', 'confusion', 'surprise', 'follow_up', 'hobby_followup', 'topic_change', 'interesting_fact', 'guess_what', 'lets_talk', 'what_now', 'curiosity', 'wait', 'capability', 'who_are_you', 'are_you_ai', 'are_you_listening', 'repeat_request', 'troubleshooting', 'introduction', 'greeting', 'wake_greeting', 'thanks', 'goodbye', 'politeness', 'thank_user', 'acknowledgement', 'opinion']);
    // If the input looks like a genuine question and the matched intent is NOT a
    // known local conversational intent, or the score is low (short/partial match),
    // defer to Ollama for a natural answer rather than using a canned response.
    if (questionLike && (!localQuestionIntents.has(best.intent.id) || best.score < 20 + best.matchedPhrase.split(' ').length)) return null;
    return { intentId: best.intent.id, categoryId: (library.categories || []).find(category => (category.intents || []).some(item => item.id === best.intent.id))?.id || '', matchedPhrase: best.matchedPhrase };
  }
  const PERSONALITY_STYLES = {
    professional: { prefix: '', suffix: '', tone: 'neutral', cinematic: false },
    casual: { prefix: '', suffix: '', tone: 'friendly', cinematic: false },
    witty: { prefix: '', suffix: '', tone: 'humorous', cinematic: false },
    dry: { prefix: '', suffix: '', tone: 'dry', cinematic: false },
    confident: { prefix: '', suffix: '', tone: 'confident', cinematic: false },
    concise: { prefix: '', suffix: '', tone: 'direct', cinematic: false }
  };

  function applyPersonalityStyle(text, style = 'professional') {
    const s = PERSONALITY_STYLES[style] || PERSONALITY_STYLES.professional;
    // Inject tone-based opening/closing without overwhelming short replies
    if (style === 'witty' && /^\s*(okay|alright|sure|fine)\s*$/i.test(text)) {
      text = 'Makes sense, Sir. ' + text;
    }
    if (style === 'dry' && /^\s*(really?|oh|hmm)\s*$/i.test(text)) {
      text = text + ', Sir. I suppose that makes sense.';
    }
    if (style === 'concise' && text.split(' ').length > 12) {
      text = text.split(' ').slice(0, 12).join(' ') + ', Sir.';
    }
    return prefixIfNeeded(text, s) || text;
  }

  function prefixIfNeeded(text, style) {
    const lower = text.trim().toLowerCase();
    // Only add prefix for conversational openings, not commands or confirmations
    if (/^\w/.test(lower) && !/^\s*(okay|alright|sure|no|yes|stop|cancel).*/i.test(lower)) {
      return (style.prefix || '') + text;
    }
    return null;
  }

  function chooseConversationResponse(library, intentId, recentResponses = [], random = Math.random, variables = {}) {
    const intent = flattenConversationLibrary(library).find(item => item.id === intentId);
    if (!intent || !intent.responses?.length) return '';
    const recent = new Set((Array.isArray(recentResponses) ? recentResponses : []).slice(-24));
    const substitute = raw => {
      let out = raw;
      for (const [key, value] of Object.entries(variables || {})) out = out.replaceAll(`{${key}}`, String(value));
      return out;
    };
    // Track per-intent recent history with bounded window for variation
    let excluded = new Set();
    for (const r of recent) {
      if (recent.has(r)) excluded.add(r);
      const sub = substitute(r);
      if (sub && !recent.has(sub)) excluded.add(sub);
    }
    // Also exclude the immediately previous response if present
    if (recentResponses && recentResponses.length > 0) {
      const last = substitute(recentResponses[recentResponses.length - 1]);
      if (last) excluded.add(last);
    }
    let choices = intent.responses.filter(response => !excluded.has(response) && !excluded.has(substitute(response)));
    if (!choices.length) choices = intent.responses;
    // Weight selection: favor responses that vary in length and opening phrase
    const weighted = choices.map(c => {
      const w = 1 + (c.split(' ').length - 8) * 0.1; // longer responses get slight boost
      return { text: c, weight: Math.max(0.1, w) };
    });
    const totalWeight = weighted.reduce((sum, c) => sum + c.weight, 0);
    const draw = Math.random() * totalWeight;
    let accumulator = 0;
    const chosen = weighted.find(c => { accumulator += c.weight; return accumulator >= draw; }) || weighted[0];
    const result = substitute(chosen.text);
    // Apply personality style based on context variables
    const style = (variables.style || 'professional').trim() || 'professional';
    return applyPersonalityStyle(result, style);
  }
  function replyLocally(input, history = [], library = null, recentResponses = [], random = Math.random) {
    const match = classifyLocalConversation(input, history, library);
    if (!match) return null;
    const response = chooseConversationResponse(library, match.intentId, recentResponses, random, variablesFromHistory(history));
    if (response && response.trim().length > 0) return { ...match, response };
    // Local library didn't produce a suitable response — fall back to Ollama
    // when available and the input is not a pure command.
    const isPureCommand = /^(?:open|close|launch|search|play|pause|stop|cancel|set)\s+/i.test(String(input).trim());
    if (!isPureCommand) {
      // Quick Ollama check: try to get a contextual reply.
      // In production this would call /api/ai/stream, but we guard against
      // offline/missing-model scenarios so JARVIS never blocks.
      try {
        const fallback = ollamaFallback(input, history, match.intentId);
        if (fallback && fallback.trim().length > 0) return { ...match, response: fallback, aiGenerated: true };
      } catch (e) {
        // Ollama unavailable or error — keep silent and let the caller handle it.
      }
    }
    // If still no response, return the library choice even if limited,
    // so the voice pipeline doesn't hang waiting for AI.
    return response ? { ...match, response } : null;
  }

  // Simple Ollama fallback that produces a short, context-aware reply.
  // Uses the /api/ai/fast endpoint if available, otherwise returns a
  // curated deterministic response based on intent and user text.
  function ollamaFallback(input, history, intentId) {
    const text = String(input || '').trim();
    const lower = text.toLowerCase();
    // If we have a conversational intent, generate a natural reply.
    if (intentId === 'how_are_you') {
      if (/bad|terrible|rough|sad|down|not great/.test(lower)) return "I'm sorry to hear that, Sir. Want to talk about it?";
      if (/good|great|awesome|fantastic|excellent/.test(lower)) return "That's wonderful to hear, Sir! What's making you happy?";
      return "I'm doing well, Sir! How about yourself?";
    }
    if (intentId === 'mood_positive') {
      if (/great|fantastic|excellent/.test(lower)) return "Thank you, Sir! That's good to know.";
      return "That's wonderful, Sir! What's the good word?";
    }
    if (intentId === 'mood_negative') {
      return "I'm sorry to hear that, Sir. Is there anything I can do to help?";
    }
    if (intentId === 'greeting' || intentId === 'wake_greeting') {
      return "Hello, Sir! How can I help you today?";
    }
    if (intentId === 'thanks') {
      return "You're welcome, Sir! Glad I could help.";
    }
    if (intentId === 'goodbye') {
      return "Goodbye, Sir! Come back whenever you want to talk.";
    }
    if (intentId === 'confusion') {
      return "What do you mean, Sir? Could you clarify?";
    }
    if (intentId === 'politeness' || intentId === 'thank_user') {
      return "You're welcome, Sir.";
    }
    if (intentId === 'acknowledgement') {
      return "Okay, Sir.";
    }
    // For unhandled intents, return a brief, natural placeholder.
    return null;
  }

  // Extract simple variables from conversation history for persona injection.
  function variablesFromHistory(history = []) {
    const texts = (history || [])
      .filter(item => item && typeof item.text === 'string')
      .map(item => item.text);
    if (!texts.length) return {};
    const lastUser = texts[texts.length - 1] || '';
    // Detect if user mentioned a name or topic we can reference.
    const nameMatch = lastUser.match(/\b(my name is|i am|call me)\s+(\w+)/i);
    const topicMatch = lastUser.match(/\b(i'm (?:feeling|working on|thinking about)|i have been)|(?:about|regarding)\s+(\w+)/i);
    return {
      userName: nameMatch ? nameMatch[2] : undefined,
      lastTopic: topicMatch ? topicMatch[2] || topicMatch[1] : undefined,
      conversationLength: texts.length
    };
  }
  // "Check AI status" / "is Ollama running": explicit local-service diagnostic.
  function parseAiDiagnoseCommand(input) {
    const lead = stripPoliteLead(input).replace(/[.!?]+$/, '').replace(/\s+please$/i, '').trim();
    return /^(?:check|test|diagnose)(?: the)? ai(?: status| health)?$|^(?:is )?ollama (?:working|running|ok|okay|up|alive)$|^ai (?:status|health|diagnostic|diagnostics)$/i.test(lead);
  }
  // Shared lead-in stripping used by the newer pipeline helpers so voice,
  // chat, and UI text all reach the parsers in the same shape.
  function stripPoliteLead(value) {
    return String(value || '').trim()
      .replace(/^(?:(?:hey|hi|hello|okay|ok)\s+)?jarvis[\s,:-]*/i, '')
      .replace(/^(?:(?:can|could|would|will) you(?: please)?(?: just)?|please|just)\s+/i, '')
      .replace(/\s+for me[.!?]*$/i, '')
      .trim();
  }
  // Natural date parsing shared by the planner parser and the multi-turn
  // calendar flow. Local computer time zone, no UTC conversion.
  function parseNaturalDate(value, now = new Date()) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (/\btomorrow\b/i.test(value)) date.setDate(date.getDate() + 1);
    else if (/\b(?:day after tomorrow)\b/i.test(value)) date.setDate(date.getDate() + 2);
    else {
      const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      const dayMatch = value.match(/\b(?:(next|on|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
      if (dayMatch) {
        const qualifier = (dayMatch[1] || '').toLowerCase();
        const target = weekdays.indexOf(dayMatch[2].toLowerCase());
        let delta = (target - date.getDay() + 7) % 7;
        if (delta === 0) delta = 7; // "on Friday" spoken on a Friday means next week
        else if (qualifier === 'next') delta += 7;
        date.setDate(date.getDate() + delta);
      }
    }
    return date;
  }
  // Calendar timezone for all operations. Local computer time is authoritative;
  // prompts explicitly name Asia/Bangkok (user's configured zone) so the
  // local Ollama model interprets dates/times in the right zone.
  const CALENDAR_TIMEZONE = 'Asia/Bangkok';
  function calendarTimezone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || CALENDAR_TIMEZONE; } catch { return CALENDAR_TIMEZONE; } }
  // Normalize harmless time variations before validation: whitespace,
  // capitalization, punctuation, and common Whisper transcription artifacts.
  // Handles "10:39AM", "10:39 Am", "10:39 a m" (spaced), "10 39 AM" (space
  // instead of colon), "10.39 AM", "10-39 AM", "2:30 p.m.", "10 o'clock".
  function normalizeTimeString(value) {
    let s = String(value || '').trim();
    if (!s) return '';
    // Collapse unicode quotes/dashes to ASCII for parsing.
    s = s.replace(/[’‘]/g, "'").replace(/[–—]/g, '-');
    // "a.m." / "p.m." (with any spacing/dots) -> "am" / "pm".
    s = s.replace(/\b([ap])\s*\.\s*m\s*\.?/gi, '$1m');
    // Whisper often emits "a m" / "p m" with a space -> "am" / "pm".
    s = s.replace(/\b([ap])\s+m\b/gi, '$1m');
    // "10.39" or "10-39" as time separator -> "10:39" (only when it looks
    // like a time: 1-2 digits, separator, exactly 2 digits).
    s = s.replace(/\b(\d{1,2})[.\-](\d{2})\b/g, '$1:$2');
    // "1039 AM" (fused digits, colon lost) -> "10:39 AM". The trailing
    // meridiem is required so years and plain numbers are never touched.
    s = s.replace(/\b(\d{1,2})(\d{2})\s*(am|pm)\b/gi, '$1:$2 $3');
    // Spoken minutes ("thirty nine", "twenty-five") -> digits, before the
    // space-join rule below so "ten thirty nine AM" can still gain a colon.
    // Only runs inside time parsing, never on general chat text.
    s = s.replace(/\b(twenty|thirty|forty|fifty)(?:[-\s]+(one|two|three|four|five|six|seven|eight|nine|\d))?\b/gi,
      (m, tens, ones) => {
        const base = { twenty: 20, thirty: 30, forty: 40, fifty: 50 }[tens.toLowerCase()];
        // Ones may already be digits: hour-word normalization runs before
        // this rule, so "thirty nine" can arrive as "thirty 9".
        const extra = !ones ? 0 : (/^\d$/.test(ones) ? Number(ones) : ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 }[ones.toLowerCase()] || 0));
        return String(base + extra);
      });
    // "10 39 AM" (space instead of colon, colon lost in transcription) ->
    // "10:39 AM". Only when a bare hour + 2-digit minute appear together.
    s = s.replace(/\b(\d{1,2})\s+(\d{2})\b/g, (m, h, mi, off, full) => {
      // If already has a colon nearby, leave it; otherwise join with colon.
      const before = String(full || '').slice(Math.max(0, off - 1), off);
      if (before === ':') return m;
      return `${h}:${mi}`;
    });
    // "10 o'clock" -> "10" (meridiem, if present, is preserved separately).
    s = s.replace(/\s*o'?clock\b/gi, '');
    // Collapse whitespace.
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }
  // Normalize a valid time answer for storage, preserving AM/PM so the
  // completer never sees a validated field as ambiguous. "10:39AM",
  // "10:39 a m", "10 39 AM" all become "10:39 AM"-style explicit values;
  // 24h "14:30" stays 24h.
  function normalizeTimeForStorage(raw) {
    // Words first so hour words become digits before the space-join rule
    // inside normalizeTimeString ("ten thirty nine AM" -> "10:39 AM").
    const norm = normalizeTimeString(normalizeTimeWords(raw)).trim().replace(/\s+/g, ' ');
    // Ensure a space before AM/PM for consistent re-parsing ("10:39AM" -> "10:39 AM").
    return norm.replace(/(\d)(am|pm)\b/i, '$1 $2').replace(/\s+/g, ' ').trim();
  }
  // Format parsed hour/minute for storage without losing AM/PM explicitness.
  // hour is 0-23 from parseNaturalTime. 0 and 13-23 are explicit 24h;
  // 1-11 need " AM"; 12 needs " PM" (noon). This prevents "10:39 AM" from
  // collapsing to ambiguous bare "10:39".
  function formatTimeForStorage(hour, minute) {
    const mm = String(minute).padStart(2, '0');
    if (hour === 0 || hour > 12) return `${hour}:${mm}`;
    if (hour === 12) return `12:${mm} PM`;
    return `${hour}:${mm} AM`;
  }
  // Accepts normalized variants; preserves explicit AM/PM exactly and never
  // silently flips it. Bare 1-12 without meridiem is ambiguous (needs one
  // clarification); 24h times (13-23, 0:xx) and noon/midnight are explicit.
  function parseNaturalTime(value) {
    // Words before string cleanup for the same reason as above: digit-form
    // hours are required before minutes can be joined with a colon.
    const withWords = normalizeTimeString(normalizeTimeWords(value));
    if (!withWords) return null;
    if (/\bnoon\b/i.test(withWords)) return { hour: 12, minute: 0 };
    if (/\bmidnight\b/i.test(withWords)) return { hour: 0, minute: 0 };
    // "half past ten (in the morning)" -> 10:30 (+AM/PM if stated).
    const half = withWords.match(/\bhalf\s+past\s+(\d{1,2})\b/i);
    if (half) {
      const h = Number(half[1]);
      if (h >= 1 && h <= 12) {
        const isPm = /\b(?:pm|afternoon|evening|night)\b/i.test(withWords);
        const isAm = /\b(?:am|morning)\b/i.test(withWords);
        if (isPm && !isAm) return { hour: (h % 12) + 12, minute: 30 };
        if (isAm && !isPm) return { hour: h % 12, minute: 30 };
        return { ambiguous: true, hour: h, minute: 30 };
      }
    }
    const match = withWords.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)?\b/i);
    if (!match) return null;
    const rawHour = Number(match[1]), minute = Number(match[2] || 0);
    const meridiem = String(match[3] || '').replaceAll('.', '').replace(/\s+/g, '').toLowerCase() || '';
    if (rawHour > 23 || minute > 59 || (rawHour === 0 && meridiem)) return { error: 'invalid' };
    if (!meridiem && rawHour >= 1 && rawHour <= 12) return { ambiguous: true, hour: rawHour, minute };
    const hour = meridiem ? (rawHour % 12) + (meridiem === 'pm' ? 12 : 0) : rawHour;
    return { hour, minute };
  }
  function parsePlannerIntent(input, now = new Date()) {
    // Speech recognition often keeps polite lead-ins after wake-word removal.
    // Normalize those here so the same command works by voice, chat, and UI.
    const text = String(input || '').trim()
      .replace(/^(?:(?:hey|hi|okay)\s+)?jarvis[\s,:-]*/i, '')
      .replace(/^(?:(?:can|could|would) you(?: please)?|please|just)\s+/i, '')
      .replace(/[?.!]+$/, '').trim(), lower = text.toLowerCase();
    if (/^(?:show|list)(?: me)? my alarms?$/.test(lower)) return { kind: 'list-alarms' };
    if (/^(?:what(?:'s| is) on my calendar|what do i have|show my calendar|calendar|is there anything on (?:my )?calendar|anything on (?:my )?calendar|do i have anything (?:on (?:my )?calendar)?)(?: today)?$/.test(lower)) return { kind: 'list-events', day: /tomorrow/.test(lower) ? 'tomorrow' : 'today' };
    if (/^(?:what do i have|what(?:'s| is) on my calendar|is there anything on (?:my )?calendar|anything on (?:my )?calendar|do i have anything (?:on (?:my )?calendar)?) tomorrow$/.test(lower)) return { kind: 'list-events', day: 'tomorrow' };
    // Natural schedule-list phrasings. These must beat generic recall ("what
    // was I supposed to do today" retrieves the actual schedule, not a chat
    // summary) and the app/website openers ("open the calendar" is a list
    // request, not an app launch).
    if (/^(?:open(?: up)?(?: the)? calendar|show (?:me )?(?:my )?(?:calendar|schedule|events)|list (?:my )?(?:calendar|events|schedule)|what(?:'s| is) on my schedule|what(?:'s| is) my schedule|what was i supposed to do today|show (?:me )?today(?:'s)? (?:calendar|schedule|events))$/.test(lower)) return { kind: 'list-events', day: 'today' };
    if (/^(?:show (?:me )?tomorrow(?:'s)? (?:calendar|schedule|events)|what(?:'s| is) on my schedule tomorrow|what am i supposed to do tomorrow)$/.test(lower)) return { kind: 'list-events', day: 'tomorrow' };
    const atTime = text.match(/^(?:do i have anything|is anything|what is) (?:scheduled )?(?:at|for) (.+)$/i);
    if (atTime) {
      const time = atTime[1].match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i);
      if (time) return { kind: 'events-at-time', hour: Number(time[1]), minute: Number(time[2] || 0), meridiem: (time[3] || '').replaceAll('.','').toLowerCase() };
      // "What is for dinner?" must never reach the calendar: only genuine
      // "do I have anything ..." phrasings may ask for a missing time.
      if (/^(?:do i have anything|is anything)/i.test(text)) return { kind: 'clarify', message: 'What time should I check on your calendar?' };
      return null;
    }
    if (/^(?:snooze)(?: for (\d+) minutes?)?$/.test(lower)) return { kind: 'snooze-alarm', minutes: Number(lower.match(/for (\d+)/)?.[1] || 10) };
    if (/^(?:turn off|dismiss|stop) (?:the )?alarm$/.test(lower)) return { kind: 'dismiss-alarm' };
    const cancelAlarm = lower.match(/^(?:cancel|delete|remove|disable)\s+(?:(?:the|my|a|an)\s+)?(.+)?$/i);
    if (cancelAlarm && (/\balarm\b/i.test(cancelAlarm[0]))) {
      let query = (cancelAlarm[1] || '').trim();
      query = query.replace(/^alarm\s+(?:at|for)\s+/i, '')
        .replace(/\s+alarm$/i, '').replace(/^(?:the|my)\s+/i, '').trim();
      if (/^alarm$/i.test(query)) query = '';
      const time = query.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
      if (time && !time[3] && Number(time[1]) >= 1 && Number(time[1]) <= 12) {
        return { kind: 'clarify', message: `Do you mean ${time[1]}:${String(Number(time[2] || 0)).padStart(2, '0')} AM or PM?` };
      }
      return { kind: 'cancel-alarm', query };
    }

    const parseDate = value => parseNaturalDate(value, now);
    const parseTime = value => parseNaturalTime(value);
    const setTime = (date, time) => { date.setHours(time.hour, time.minute, 0, 0); return date; };
    const iso = date => date.toISOString();
    const alarmMatch = text.match(/\b(?:set|create) (?:an? )?alarm\b|\bwake me up\b/i);
    if (alarmMatch) {
      const time = parseTime(text); if (!time) return { kind: 'clarify', message: 'What time should I set the alarm for, including AM or PM?' };
      if (time.ambiguous) return { kind: 'clarify-alarm', hour: time.hour, minute: time.minute, date: iso(parseDate(text)), repeat: /\bweekdays\b/i.test(text) ? 'weekdays' : 'none', message: `Did you mean ${time.hour}:${String(time.minute).padStart(2,'0')} AM or PM?` };
      if (time.error) return { kind: 'clarify', message: 'That time does not look valid. Please say an hour and minute.' };
      let date = setTime(parseDate(text), time); const recurring = /\bweekdays\b/i.test(text);
      if (date <= now && !/tomorrow|next\s+/i.test(text)) date.setDate(date.getDate() + (recurring ? 1 : 1));
      while (recurring && date.getDay() === 0 || recurring && date.getDay() === 6) date.setDate(date.getDate() + 1);
      return { kind: 'create-alarm', when: iso(date), repeat: recurring ? 'weekdays' : 'none', title: 'JARVIS alarm' };
    }
    const reminderMatch = text.match(/^remind me to (.+?) (?:in (\d+) minutes?|at (.+))$/i);
    if (reminderMatch) {
      let date;
      if (reminderMatch[2]) date = new Date(now.getTime() + Number(reminderMatch[2]) * 60000);
      else {
        const time = parseTime(reminderMatch[3]);
        if (!time || time.ambiguous || time.error) return { kind: 'clarify', message: 'Should I remind you in the morning or evening? Tell me AM or PM.' };
        date = setTime(parseDate(reminderMatch[3]), time); if (date <= now) date.setDate(date.getDate() + 1);
      }
      return { kind: 'create-reminder', title: reminderMatch[1].trim(), when: iso(date) };
    }
    const eventVerb = /^(?:add|schedule|create|make|set)\b/i.test(text);
    const eventNoun = /\b(?:event|meeting|appointment|calendar)\b/i.test(text);
    if (eventVerb && (eventNoun || /^schedule\b/i.test(text)) && !/\balarm\b/i.test(text)) {
      // One-message creation still works when both the day and the time are
      // known. Incomplete requests return null so the multi-turn calendar flow
      // collects only the missing fields (a stateless "clarify" answer would be
      // forgotten on the next utterance).
      const hasDate = /\b(?:today|tomorrow|tonight|day after tomorrow|(?:next|on|this)?\s*(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/i.test(text);
      const time = parseTime(text);
      if (!time || !hasDate) return null;
      if (time.ambiguous) return null;
      if (time.error) return { kind: 'clarify', message: 'That event time does not look valid.' };
      const date = setTime(parseDate(text), time); if (date <= now) date.setDate(date.getDate() + 1);
      const named = text.match(/\b(?:called|named)\s+(.+?)(?=\s+(?:today|tomorrow|next|on|at|from)\b|[,.!?]|$)/i);
      const subject = text.match(/\bschedule (?:a|an) (.+?)(?=\s+(?:today|tomorrow|next|on|at)\b|[,.!?]|$)/i)
        || text.match(/^schedule\s+(.+?)(?=\s+(?:today|tomorrow|next|on|at|from)\b|[,.!?]|$)/i);
      const title = (named?.[1] || subject?.[1] || 'Meeting').trim();
      const reminder = Number(text.match(/\bremind me (\d+) minutes? before\b/i)?.[1] || 0);
      return { kind: 'create-event', title, start: iso(date), end: iso(new Date(date.getTime() + 60 * 60000)), reminderMinutes: reminder };
    }
    const cancelEvent = text.match(/^(?:cancel|delete|remove) (?:my )?(.+?)(?: tomorrow| today)?$/i);
    if (cancelEvent) {
      // "that event", "the meeting", "it" refer to the most recently touched
      // event: an empty query lets the caller fall back to it, or ask which
      // event is meant. Without this, cancellations could never resolve.
      let query = cancelEvent[1].trim().replace(/^(?:that|this|the|my)\s+/i, '').trim();
      if (/^it$/i.test(query)) query = '';
      if (/^(?:event|meeting|appointment|calendar)s?$/.test(query)) query = '';
      if (!query || /\b(?:meeting|event|revision|appointment)\b/i.test(cancelEvent[1])) return { kind: 'cancel-event-query', query };
    }
    // Editing means moving: the backend has no rename, so "edit", "change",
    // "reschedule" all resolve to a move with a new start time. Bare targets
    // without a destination get a clarification with an example instead of a
    // dead end. Leading articles are stripped so "the dentist meeting"
    // matches a stored "dentist meeting".
    const stripArticle = value => String(value || '').trim().replace(/^(?:the|my)\s+/i, '').trim();
    const edit = text.match(/^(?:edit|change|update|reschedule|postpone|push back|bring forward) (?:my )?(.+?)(?: to (.+))?$/i);
    if (edit && (/\b(?:event|meeting|appointment|calendar)\b/i.test(edit[1]) || /^(?:it|that|this)$/i.test(edit[1].trim()))) {
      const target = stripArticle(edit[1]);
      const destination = (edit[2] || '').trim();
      if (!destination) return { kind: 'clarify', message: `What new time should “${target || 'that event'}” move to? For example: move ${target || 'that event'} to tomorrow at 5 PM.` };
      const time = parseTime(destination);
      if (!time || time.ambiguous || time.error) return { kind: 'clarify', message: 'What new time should I use, including AM or PM?' };
      const date = setTime(parseDate(destination), time);
      if (date <= now) date.setDate(date.getDate() + 1);
      return { kind: 'move-event-query', query: /^(?:it|that event|this event|the event)$/i.test(target) || !target ? '' : target, start: iso(date), explicitDate: /\btoday\b|\btomorrow\b|\b(?:next|on)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(destination) };
    }
    const move = text.match(/^move (?:my )?(.+?) to (.+)$/i);
    if (move) {
      const time = parseTime(move[2]);
      if (!time || time.ambiguous || time.error) return { kind: 'clarify', message: 'What new time should I use, including AM or PM?' };
      const date = setTime(parseDate(move[2]), time);
      if (date <= now) date.setDate(date.getDate() + 1);
      const target = stripArticle(move[1]);
      return { kind: 'move-event-query', query: target.toLowerCase() === 'it' || !target ? '' : target, start: iso(date), explicitDate: /\btoday\b|\btomorrow\b|\b(?:next|on)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(move[2]) };
    }
    return null;
  }

  // =====================================================================
  // Echo guard (Phase 2). Kept in core so it is unit-testable: JARVIS's
  // own TTS is picked up by the microphone, and the local recognizer may
  // transcribe it after playback already ended.
  // =====================================================================
  const ECHO_WINDOW_MS = 10000;
  // Bare interruption phrases, checked while JARVIS is speaking. Deliberately
  // narrow so ordinary speech never cuts JARVIS off by accident: two-word and
  // longer phrases that merely START with "stop" (for example "stop the music,")
  // do NOT match.
  const STOPPED_SPEECH_PATTERN = /^(?:stop|stop talking|stop speaking|stop it|stop that|be quiet|quiet|silence|hush|shush|that's enough|thats enough|enough|enough of that|cancel that|never mind|nevermind|shut up|that will be all|that'll be all|zip it|cross out that|scratch that)$/;
  // Settle time after TTS ends during which a new utterance may still contain
  // speaker reverb picked up by the microphone.
  const VOICE_SETTLE_MS = 400;
  // True when a captured utterance overlaps TTS playback closely enough that it
  // may contain JARVIS's own audio. Such audio must never use the no-wake-word
  // follow-up window and must carry a real wake word to be acted on.
  function utteranceOverlapsPlayback(utterance = {}, playback = {}, settleMs = VOICE_SETTLE_MS) {
    const startedAt = Number(utterance.startedAt) || 0;
    const endedAt = Number(utterance.endedAt) || 0;
    const ttsStartedAt = Number(playback.ttsStartedAt) || 0;
    if (!startedAt || !ttsStartedAt) return false;
    const ttsEndedAt = Number(playback.ttsEndedAt) || Date.now();
    const settle = Math.max(0, Number(settleMs) || 0);
    return startedAt < ttsEndedAt + settle && endedAt > ttsStartedAt - settle;
  }
  // Single routing decision for one transcript. Pure: the caller supplies the
  // wake parse, the echo verdicts, and the pipeline state; this returns exactly
  // one action so one utterance can never execute twice. Side effects
  // (speaking, mode changes, command execution) stay with the caller.
  // Actions: ignore {reason} | ack | command {command} | interrupt {command} |
  // stop-barge. transcript is always echoed back for display/logging.
  function decideVoiceAction(heard, ctx = {}) {
    const text = String(heard || '').trim();
    const now = Number(ctx.now) || Date.now();
    if (!text) return { action: 'ignore', reason: 'empty', transcript: text };
    if (/^(?:um+|uh+|ugh+|ah+|er+|eh+|erm+|hmm+|mm+|hm+|emm+)[.!?,\s]*$/i.test(text)) return { action: 'ignore', reason: 'filler', transcript: text };
    if (/^((?:um+|uh+|ugh+|ah+|er+|eh+|erm+|hmm+|mm+|hm+|emm+|well|so)\b[\s,.!?]*)+$/i.test(text) && text.length < 30) return { action: 'ignore', reason: 'filler', transcript: text };
    if (ctx.duplicate) return { action: 'ignore', reason: 'duplicate', transcript: text };
    const wake = ctx.wake || parseWakeTranscript(text, 'Jarvis');
    const bareStop = text.toLowerCase().replace(/[.!?]+$/, '').replace(/^(?:hey\s+)?jarvis[\s,:-]*/i, '').trim();
    const isStop = STOPPED_SPEECH_PATTERN.test(bareStop);
    const speaking = ctx.mode === 'SPEAKING';
    const echoCurrent = Boolean(ctx.echoCurrent);
    const echoRecent = Boolean(ctx.echoRecent);
    // Audio that overlapped own playback: never the follow-up window, never a
    // bare acknowledgement. Only a stop barge-in (that is not itself our own
    // words) or a real wake word with a command that is not our own speech.
    if (ctx.contaminated) {
      if (speaking && isStop && !echoCurrent) return { action: 'stop-barge', command: '', transcript: text };
      if (!wake.activated) return { action: 'ignore', reason: 'contaminated-no-wake', transcript: text };
      if (echoCurrent || echoRecent) return { action: 'ignore', reason: 'echo', transcript: text };
      if (ctx.busy) return { action: 'ignore', reason: 'busy', transcript: text };
      if (!wake.command) return { action: 'ignore', reason: 'contaminated-bare-wake', transcript: text };
      return { action: 'command', command: wake.command, transcript: text, bargedIn: speaking };
    }
    // Barge-in outranks the echo guard: a short "stop" while speaking must cut
    // playback unless those exact words are what JARVIS is saying right now.
    if (speaking && isStop && !echoCurrent) return { action: 'stop-barge', command: '', transcript: text };
    if (echoCurrent || echoRecent) return { action: 'ignore', reason: 'echo', transcript: text };
    const armed = Boolean(ctx.wakeArmed);
    const command = wake.activated ? wake.command : (armed ? text : '');
    if (!wake.activated && !command) return { action: 'ignore', reason: 'no-wake', transcript: text };
    if (ctx.busy) return { action: 'ignore', reason: 'busy', transcript: text };
    if (!command) {
      const lastAckAt = Number(ctx.lastAckAt) || 0;
      const cooldown = Number(ctx.ackCooldownMs) || 4000;
      if (lastAckAt && now - lastAckAt < cooldown) return { action: 'ignore', reason: 'ack-cooldown', transcript: text };
      // A bare greeting addressed to JARVIS ("Hello, Jarvis.") IS a command in
      // its own right: it must reach the greeting handler and be answered
      // properly instead of falling through to the generic "Yes, Sir?" ack,
      // which never acknowledged the greeting at all.
      const greeting = parseGreetingIntent(text, new Date(now));
      if (greeting && !ctx.busy) return { action: 'command', command: text, transcript: text, greeting: true };
      return { action: 'ack', command: '', transcript: text };
    }
    if (speaking) {
      if (isStop) return { action: 'stop-barge', command: '', transcript: text };
      if (wake.activated && wake.confidence >= 0.9) return { action: 'interrupt', command, transcript: text };
      return { action: 'ignore', reason: 'speaking-low-confidence', transcript: text };
    }
    return { action: 'command', command, transcript: text };
  }
  // No-wake-word follow-up window. It exists for exactly three cases: the
  // "Yes, Sir?" acknowledgement (an explicit invitation to speak), an active
  // multi-turn workflow waiting for a specific answer, and an active shared
  // pending question (greeting, voice mode, alarm, reminder, planner
  // clarification). A finished answer, an error, or idle chatter must return
  // to wake-word standby.
  // Every follow-up window is 5 s (2026-10-15, was 15 s / 20 s). They are kept
  // as separate constants rather than one shared value because they answer
  // different questions, but they must stay in step with each other AND with
  // PENDING_QUESTION_TTL_MS below: shouldArmFollowUp takes
  // Math.max(FOLLOW_UP_WINDOW_MS, remaining-TTL), so a longer pending-question
  // TTL would silently keep the mic hot long after the window was "shortened".
  const FOLLOW_UP_WINDOW_MS = 5000;
  const ACK_FOLLOW_UP_MS = 5000;
  // Multi-turn workflows (calendar/email/Discord) hold the window for 5 s
  // from the end of the spoken question. The workflow data itself lives longer
  // (flow TTL); only the hot-mic window is bounded.
  const FLOW_FOLLOW_UP_MS = 5000;
  function shouldArmFollowUp({ pendingKind = '', ackPrompt = false, recognitionEnabled = false, pending = null } = {}) {
    if (!recognitionEnabled) return { armed: false, ms: 0, reason: 'mic-off' };
    if (pending && pendingQuestionActive(pending)) {
      const now = Date.now();
      const remaining = pendingQuestionRemainingMs(pending, now);
      // Arm for the shorter of the pending question's own TTL and a hard cap,
      // never dropping below the standard window so the first words of a
      // quick answer are never cut off before they reach the recogniser.
      const ms = Math.min(PENDING_QUESTION_MAX_WINDOW_MS, Math.max(FOLLOW_UP_WINDOW_MS, remaining || FOLLOW_UP_WINDOW_MS));
      return { armed: true, ms, reason: `pending-${pending.intent || pending.kind || 'question'}` };
    }
    if (pendingKind === 'calendar' || pendingKind === 'email' || pendingKind === 'discord') {
      return { armed: true, ms: FLOW_FOLLOW_UP_MS, reason: `pending-${pendingKind}` };
    }
    if (ackPrompt) return { armed: true, ms: ACK_FOLLOW_UP_MS, reason: 'ack' };
    return { armed: false, ms: 0, reason: 'standby' };
  }
  function isEchoTranscript(transcript, spoken, { speaking = false, lastSpokenAt = 0, now = Date.now(), windowMs = ECHO_WINDOW_MS } = {}) {
    const active = Boolean(speaking);
    const recent = now - lastSpokenAt < windowMs;
    if (!active && !recent) return false;
    if (!spoken) return active && recent;
    const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const heard = normalize(transcript);
    if (!heard || heard.length < 3) return false;
    const own = normalize(spoken);
    if (!own) return active && recent;
    if (own.includes(heard)) return true;
    const heardWords = heard.split(/\s+/).filter(word => word.length > 1);
    if (!heardWords.length) return false;
    const spokenWords = new Set(own.split(/\s+/));
    if (heardWords.length <= 2) return heardWords.every(word => spokenWords.has(word));
    return heardWords.filter(word => spokenWords.has(word)).length / heardWords.length >= 0.6;
  }

  // =====================================================================
  // SPEECH PLAYBACK CONTROLLER (2026-10-15, core export). Verbatim move of
  // the app-side class so the one-delivery-per-response contract is
  // unit-testable in Node. Every response is claimed by (requestId,
  // responseId) before playback starts, so a duplicate callback — a double
  // event, a retry, or a stale handler from an older request — can never
  // start a second copy of the same audio. Claims may be RELEASED only when
  // the pipeline failed before any audio was accepted (pre-playback
  // failure), so an explicit user retry can run while a late duplicate
  // still cannot restart audio that already reached the speakers.
  // =====================================================================
  class SpeechController {
    constructor() {
      this.spokenResponses = new Map(); // requestId -> Set(responseId)
      this.currentRequestId = null;
      this.currentResponseId = null;
      this.playbackEpoch = 0;
    }
    // Unique identity for each user request and each response, so
    // legitimately asking the same question twice still works.
    generateRequestId() {
      return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }
    generateResponseId(text) {
      return `resp_${Date.now()}_${SpeechController.hashText(text)}`;
    }
    static hashText(text) {
      let hash = 0;
      const value = String(text || '');
      for (let i = 0; i < value.length; i++) {
        hash = ((hash << 5) - hash) + value.charCodeAt(i);
        hash |= 0;
      }
      return Math.abs(hash).toString(36);
    }
    hasBeenSpoken(requestId, responseId) {
      const set = this.spokenResponses.get(requestId);
      return set ? set.has(responseId) : false;
    }
    markSpoken(requestId, responseId) {
      if (!this.spokenResponses.has(requestId)) this.spokenResponses.set(requestId, new Set());
      this.spokenResponses.get(requestId).add(responseId);
      // Bound memory: keep the most recent 50 requests.
      if (this.spokenResponses.size > 50) {
        const firstKey = this.spokenResponses.keys().next().value;
        this.spokenResponses.delete(firstKey);
      }
    }
    // Claim the single playback slot for a response. Returns the current
    // playback epoch on success, or 0 when this exact response was already
    // claimed for this request (duplicate callback, retry, or stale
    // handler). Claims are deliberately never auto-released so a late
    // duplicate must not silently replay a failed or interrupted response;
    // release() below is the one deliberate exception for pre-playback
    // failures.
    claim(requestId, responseId) {
      if (this.hasBeenSpoken(requestId, responseId)) return 0;
      this.markSpoken(requestId, responseId);
      this.currentRequestId = requestId;
      this.currentResponseId = responseId;
      this.playbackEpoch += 1;
      return this.playbackEpoch;
    }
    // Explicit release for a response that failed BEFORE playback started.
    // Never called after audio begins, so delivered audio cannot restart.
    release(requestId, responseId) {
      const set = this.spokenResponses.get(requestId);
      if (set) {
        set.delete(responseId);
        if (!set.size) this.spokenResponses.delete(requestId);
      }
      if (this.currentRequestId === requestId && this.currentResponseId === responseId)
        { this.currentRequestId = null; this.currentResponseId = null; }
    }
    // Set current request context.
    setRequestContext(requestId) {
      this.currentRequestId = requestId;
    }
    getCurrentRequestId() {
      return this.currentRequestId;
    }
  }

  // =====================================================================
  // SHARED CONVERSATIONAL STATE (2026-10-14).
  //
  // One pending-question record for EVERY workflow, instead of a separate
  // ad-hoc flag per feature. Greetings, voice modes, alarms, reminders and
  // planner clarifications now publish the same shape the calendar/email/
  // Discord flows already used, so "is JARVIS waiting for an answer, and
  // for which field?" is answered in exactly one place.
  //
  // The record tracks: whether JARVIS is waiting, the exact question asked,
  // the conversation/workflow id, the intent, the required field, what has
  // already been collected, the previous-turn context, whether the response
  // was already processed, the expiry, and cancellation.
  // =====================================================================
  // Must match the follow-up windows above: a pending question lives exactly as
  // long as the mic stays hot for it, or the user is still answerable after
  // JARVIS has already returned to wake-word standby.
  const PENDING_QUESTION_TTL_MS = 5000;
  const PENDING_QUESTION_MAX_WINDOW_MS = 60000;
  function createPendingQuestion({
    kind = 'question', question = '', requiredField = '',
    conversationId = '', intent = '', collected = {}, context = {},
    ttlMs = PENDING_QUESTION_TTL_MS, now = Date.now(), extra = {}, askedAt = null
  } = {}) {
    const at = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : Date.now());
    const ttl = Math.max(1000, Number(ttlMs) || PENDING_QUESTION_TTL_MS);
    return {
      id: `pq-${at}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      // Workflow identifier: which conversation this question belongs to.
      conversationId: conversationId || `conversation-${at}`,
      // Intent, e.g. greeting | calendar | alarm | reminder | mode | planner.
      intent: intent || kind,
      question: String(question || ''),
      // The field this answer must fill (meridiem, time, subject, mood ...).
      requiredField: String(requiredField || ''),
      // Information already collected in this workflow.
      collected: collected && typeof collected === 'object' ? { ...collected } : {},
      // Relevant context from the previous turn.
      context: context && typeof context === 'object' ? { ...context } : {},
      waiting: true,
      handled: false,
      cancelled: false,
      cancelReason: '',
      askedAt: typeof askedAt === 'number' ? askedAt : at,
      createdAt: at,
      touchedAt: at,
      expiresAt: at + ttl,
      ttlMs: ttl,
      ...extra
    };
  }
  function pendingQuestionActive(pq, now = Date.now()) {
    if (!pq || pq.cancelled || pq.handled) return false;
    return Number(pq.expiresAt) > now;
  }
  function pendingQuestionRemainingMs(pq, now = Date.now()) {
    if (!pq) return 0;
    return Math.max(0, (Number(pq.expiresAt) || 0) - now);
  }
  function pendingQuestionWaiting(pq, now = Date.now()) {
    return pendingQuestionActive(pq, now) && Boolean(pq.waiting);
  }
  // Re-arm the same workflow for a follow-up clarification: the question
  // changes, everything already collected stays, the TTL restarts.
  function refreshPendingQuestion(pq, { question = '', requiredField = '', collected = null, context = null, ttlMs = null, now = Date.now() } = {}) {
    if (!pq) return null;
    const at = typeof now === 'number' ? now : Date.now();
    if (question) pq.question = String(question);
    if (requiredField) pq.requiredField = String(requiredField);
    if (collected && typeof collected === 'object') pq.collected = { ...pq.collected, ...collected };
    if (context && typeof context === 'object') pq.context = { ...pq.context, ...context };
    const ttl = ttlMs == null ? (Number(pq.ttlMs) || PENDING_QUESTION_TTL_MS) : Math.max(1000, Number(ttlMs));
    pq.ttlMs = ttl;
    pq.expiresAt = at + ttl;
    pq.touchedAt = at;
    pq.handled = false;
    pq.waiting = true;
    return pq;
  }
  function cancelPendingQuestion(pq, reason = '') {
    if (!pq) return null;
    pq.cancelled = true;
    pq.waiting = false;
    pq.handled = true;
    pq.cancelReason = String(reason || '');
    return pq;
  }
  function markPendingQuestionHandled(pq, now = Date.now()) {
    if (!pq) return null;
    pq.handled = true;
    pq.waiting = false;
    pq.touchedAt = typeof now === 'number' ? now : Date.now();
    return pq;
  }
  // Unambiguous abandonment phrases. Deliberately narrow: "nothing much" or
  // "not now" can be a real answer to a wellbeing question, so they are not
  // cancellations.
  function isPendingCancellation(input) {
    // Punctuation and word spacing do not matter: "never mind", "nevermind"
    // and "Never mind!" are the same cancellation.
    const packed = String(input || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!packed) return false;
    const phrases = new Set([
      'cancel', 'cancelit', 'cancelthat', 'cancelthis', 'nevermind', 'nevermindit',
      'forgetit', 'forgetthat', 'forgetthis', 'forgetaboutit', 'forgetaboutthat',
      'abort', 'stop', 'stopit', 'stopthat', 'stopthis', 'stopasking', 'stopplease',
      'skipit', 'skipthat', 'skipthis', 'thatisall', 'thatwillbeall', 'thatllbeall',
      'wearedone', 'iamdone', 'imdone', 'goodbye', 'bye', 'byebye', 'nothingthanks',
      'nonethanks', 'noneed', 'noneedthanks', 'dontbother',      'quit', 'exit',
      'forgetitthanks', 'endourconversation', 'imdonechatting', 'wearedonechatting', 'thatsenoughchatting'
    ]);
    return phrases.has(packed);
  }
  // A bare AM/PM answer to a time-clarification question.
  function parseMeridiemAnswer(value) {
    const text = String(value || '').trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ').replace(/[.']/g, '');
    if (!text) return null;
    if (/^(?:am|a ?m|in the morning|morning)$/.test(text)) return 'am';
    if (/^(?:pm|p ?m|in the afternoon|in the evening|afternoon|evening|at night|night)$/.test(text)) return 'pm';
    return null;
  }
  // True when an utterance is clearly a NEW request rather than an answer to
  // the pending question. Used so an unrelated command is never swallowed by
  // an old calendar/reminder workflow.
  function pendingAnswerIsNewRequest(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    const cleaned = raw.replace(/[.!?]+$/, '');
    // A genuine question of our own is a new request, not an answer.
    if (/\?\s*$/.test(raw) || /^(?:who|what|when|where|why|how|can you|could you|would you|should i|do you think|is there|are there)\b/i.test(cleaned)) return true;
    if (looksLikeDeterministicCommand(cleaned)) return true;
    // A long utterance is almost never a short field answer.
    const words = cleaned.split(/\s+/).filter(Boolean).length;
    return words > 14;
  }

  // =====================================================================
  // GREETINGS (2026-10-14).
  //
  // The greeting intent used to pick one line at random out of a pool that
  // mixed morning/afternoon/evening replies with "Welcome back" and archaic
  // phrasing, so "Good morning, Jarvis" could be answered with "Good
  // evening, Sir." or "Welcome back! How goes it?". Greetings are now
  // recognised by FORM (time-of-day, hello, how-are-you, what's-up, nice to
  // see you) and answered with a reply that fits the real local clock, the
  // user's configured form of address, and a rotating variation counter.
  // =====================================================================
  function localTimeOfDay(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    const hour = Number.isFinite(d.getHours) ? d.getHours() : new Date(d).getHours();
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 22) return 'evening';
    return 'night';
  }
  function greetingNormalize(value) {
    let text = String(value || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").trim();
    // ASR routinely drops apostrophes: "what's up" -> "what s up", so the
    // apostrophe itself is optional in every contraction rule below.
    text = text.replace(/\b(what|how|it|that|there|i|you|we|they|he|she)'?\s?s\b/g, '$1 is')
      .replace(/\b(what|how|it|that|there|i|you|we|they|he|she)'?\s?re\b/g, '$1 are')
      .replace(/\b(what|how|it|that|there|i|you|we|they)'?\s?ve\b/g, '$1 have')
      .replace(/\b(what|how|it|that|there|i|you|we|they)'?\s?ll\b/g, '$1 will')
      .replace(/\b(what|how|it|that|there|i|you|we|they)'?\s?d\b/g, '$1 would')
      .replace(/\bi'?\s?m\b/g, 'i am')
      .replace(/\blet'?\s?s\b/g, 'let us');
    // Punctuation carries no meaning for a greeting: "Good morning, Jarvis."
    // and "good morning jarvis" are the same utterance. Keeping only word
    // characters also makes the trailing-address strip below reliable.
    return text.replace(/[^a-z0-9']+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const GREETING_FORMS = [
    { id: 'time_morning', re: /^(?:good\s+)?morning\b/, timeOfDay: 'morning' },
    { id: 'time_afternoon', re: /^(?:good\s+)?afternoon\b/, timeOfDay: 'afternoon' },
    { id: 'time_evening', re: /^(?:good\s+)?evening\b/, timeOfDay: 'evening' },
    { id: 'goodnight', re: /^(?:good\s*night|goodnight)\b/ },
    { id: 'howareyou', re: /^how (?:are you|have you been|are things|is everything|is life)\b/ },
    { id: 'howgoesit', re: /^how (?:is it going|goes it|are you doing|is your day|has your day been|is your day going|was your day|have you been)\b/ },
    { id: 'whatsup', re: /^(?:what is up|what up|what is happening|what is new|sup)\b/ },
    { id: 'nice', re: /^(?:nice|good|great|glad|happy|lovely) to see you\b/ },
    { id: 'hello', re: /^(?:hello|hi|hey|yo|hiya|howdy|greetings|salutations|good day|good to see you)\b/ }
  ];
  const GREETING_TAIL_WORDS = new Set(['sir', 'madam', 'maam', 'jarvis', 'there', 'again', 'to you', 'you', 'mate', 'friend', 'all', 'everyone', 'guys']);
  function matchGreetingForm(text, now) {
    for (const form of GREETING_FORMS) {
      const match = text.match(form.re);
      if (!match) continue;
      const rest = text.slice(match[0].length).trim()
        .replace(/^(?:there|sir|madam|maam|jarvis|again|to you|you|mate|friend|all|everyone|guys)\s+/g, '')
        .trim();
      // A greeting that carries an actual instruction ("good morning, open
      // YouTube") is a command, not a greeting.
      if (rest && !GREETING_TAIL_WORDS.has(rest)
        && !/^how (?:are you|is it going|have you been)\b/.test(rest)
        && !/^(?:how can i help|what can i do for you|what is on)\b/.test(rest)) continue;
      return {
        isGreeting: true,
        form: form.id,
        text,
        transcript: '',
        asksWellbeing: form.id === 'howareyou' || form.id === 'howgoesit' || /^how (?:are you|is it going|have you been)\b/.test(rest),
        mentionedTimeOfDay: form.timeOfDay || null,
        actualTimeOfDay: localTimeOfDay(now)
      };
    }
    return null;
  }
  function parseGreetingIntent(input, now = new Date()) {
    const raw = greetingNormalize(input);
    if (!raw) return null;
    // Try the utterance as spoken first, then with a leading wake name
    // removed ("Jarvis, good morning"). Order matters: "Hey, Jarvis." must not
    // lose its "hey" to the wake-name strip.
    const candidates = [raw, raw.replace(/^(?:(?:hey|hi|ok|okay|yo)\s+)?jarvis\b\s*/i, ' ').trim()];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const hit = matchGreetingForm(candidate, now);
      if (hit) { hit.transcript = String(input || '').trim(); return hit; }
    }
    return null;
  }
  // Only trust the user's time-of-day phrase when it is close to the real
  // clock; "Good morning" at 18:00 is answered with an evening greeting
  // (they are either in another timezone or referring to an earlier event)
  // instead of JARVIS insisting on a morning that does not exist.
  function resolveGreetingTimeOfDay(greeting, now = new Date()) {
    const actual = localTimeOfDay(now);
    const mentioned = greeting && greeting.mentionedTimeOfDay;
    if (!mentioned) return actual;
    const order = ['morning', 'afternoon', 'evening', 'night'];
    const a = order.indexOf(mentioned), b = order.indexOf(actual);
    if (a < 0 || b < 0) return actual;
    const distance = Math.min(Math.abs(a - b), order.length - Math.abs(a - b));
    return distance <= 1 ? mentioned : actual;
  }
  // Greeting copy (2026-10-15, greatly expanded). Every array is keyed by time of
  // day where the wording would otherwise contradict itself: nothing in
  // `night` says "good morning", and nothing claims a time the user never used.
  // Two rules the composer depends on, so keep them when editing:
  //   1. Openers and statements contain NO question marks — they are concatenated
  //      with a question, and two '?' in one reply reads badly.
  //   2. GREETING_NICE_REPLIES contains no '?' either, because the 'nice' branch
  //      appends a question on odd counters and would double up.
  const GREETING_OPENERS = {
    morning: ['Good morning, {address}.', 'Morning, {address}.', 'Good morning to you, {address}.', 'Morning, {address}. The day is young.', 'A good morning to you, {address}.', 'Top of the morning, {address}.', 'Good morning, {address}. I am glad you are up.', 'Morning, {address}. I trust the night was kind.'],
    afternoon: ['Good afternoon, {address}.', 'Afternoon, {address}.', 'Good afternoon to you, {address}.', 'Afternoon, {address}. The day is well underway.', 'Good afternoon, {address}. I hope it has gone well so far.', 'Hello again, {address}. Afternoon.', 'Afternoon, {address}. I trust the morning was productive.'],
    evening: ['Good evening, {address}.', 'Evening, {address}.', 'Good evening to you, {address}.', 'Evening, {address}. The day is drawing to a close.', 'Good evening, {address}. I trust the day treated you well.', 'Evening, {address}. A quieter part of the day.', 'Good evening, {address}. I am entirely at your disposal.'],
    night: ['Good evening, {address}.', 'Still up, {address}.', 'Night, {address}.', 'Good evening, {address}. A late one tonight.', 'Late hour, {address}. I am still here.', 'Still awake, {address}.', 'Good evening, {address}. The house has gone quiet.']
  };
  // A plain "Hello, Jarvis." is answered with a hello, not with a time-of-day
  // greeting it never used.
  const GREETING_HELLO_OPENERS = ['Hello, {address}.', 'Hi, {address}.', 'Hello there, {address}.', 'Hello, {address}. Good to hear from you.', 'Hi there, {address}.', 'Hello again, {address}.', 'Well, hello, {address}.', 'Greetings, {address}.', 'Hello, {address}. I am here.', 'Hey, {address}.', 'Hello, {address}. At your service, as always.', 'Hello, {address}. Right away.'];
  const GREETING_TIME_QUESTIONS = {
    // No {address} here: these are appended to an opener that already said it,
    // which produced "Still awake, Sir. ... What is keeping you up, Sir?".
    morning: ['How is your morning going?', 'Did you sleep well?', 'What is first on the list today?', 'How is the day starting for you?', 'Are you ready to begin?', 'What would you like to tackle first?', 'How are you settling in today?', 'Anything you want to get out of the way early?'],
    afternoon: ['How is your afternoon treating you?', 'How is the day going so far?', 'Anything left before the evening?', 'How has the morning treated you?', 'What is on the rest of your day?', 'Are you ready for the afternoon?', 'Anything you would like to finish before this is over?', 'How is the day shaping up?'],
    evening: ['How is your evening going?', 'How was the rest of your day?', 'Anything left to wrap up tonight?', 'How are you settling into the evening?', 'Is there anything left outstanding?', 'What would you like to close out today?', 'How has the day finished for you?', 'Anything you would like to look over before resting?'],
    night: ['How is your night going?', 'Working late again?', 'How are you holding up this late?', 'Is it a long one tonight?', 'What is keeping you up?', 'Are you winding down at all?', 'Anything urgent at this hour?', 'How late are we making it?']
  };
  const GREETING_STATEMENTS = {
    morning: ['The systems are ready whenever you are.', 'Everything has been quiet on my side.', 'All systems are online and standing by.', 'Nothing has happened overnight that needs your attention.', 'The console came up clean and is waiting.', 'I have been holding station since first light.', 'Everything is where you left it last night.'],
    afternoon: ['I am here and ready when you need me.', 'Everything is running as it should.', 'The console is quiet and yours.', 'Nothing has needed your attention so far today.', 'All systems remain nominal.', 'I have kept everything in order this afternoon.', 'The afternoon is yours, whenever you want it.'],
    evening: ['I am here and ready when you need me.', 'The evening shift is manned, Sir.', 'The day wound down without incident.', 'Everything has been steady this evening.', 'Nothing outstanding on my side.', 'The console is settled and quiet.', 'I have everything ready for the evening.'],
    night: ['I am here and ready when you need me.', 'Quiet night on my side, Sir.', 'Everything has settled down for the night.', 'The house is quiet and the systems are steady.', 'Nothing has disturbed the night so far.', 'All remains in order at this hour.', 'The console is dimmed and ready.']
  };
  const GREETING_HELLO_QUESTIONS = ['How are you doing today?', 'What can I do for you today?', 'What are we getting into today?', 'How has your day been so far?', 'What is on your mind today?', 'What shall we do today?', 'How are you feeling today?', 'What would you like to start with?', 'Is there anything you need from me?', 'What is the plan for today?', 'How can I be of service?', 'Where shall we begin?'];
  const GREETING_HELLO_STATEMENTS = ['I am online and ready.', 'Everything is running as it should.', 'Good to have you at the console.', 'All systems are online and standing by.', 'The console is quiet and yours.', 'I am here and ready when you need me.', 'Nothing needs your attention just yet.', 'Everything is exactly where you left it.', 'Systems are nominal and waiting.', 'I have been holding station, as always.', 'The workshop is quiet and in order.', 'Nothing outstanding, and all is ready.'];
  const GREETING_NICE_REPLIES = ['Good to see you too, {address}.', 'Always a pleasure, {address}.', 'Likewise, {address}. It has been too long.', 'Good to see you, {address}. I do hope all is well.', 'The pleasure is entirely mine, {address}.', 'Good to see you, {address}. It is good to hear from you.', 'And you, {address}. I trust everything is in order.', 'It is good to have you here, {address}.'];
  const GREETING_WELLBEING_REPLIES = [
    'I am running well, {address}. How are you doing today?',
    'All systems are green, {address}. And you?',
    'Doing well, thank you for asking, {address}.',
    'Steady and ready, {address}. How is your day going?',
    'Very well, {address}. I trust the same for you.',
    'Running smoothly, {address}. How have the last few hours been?',
    'I am in good order, {address}. And yourself?',
    'Everything is nominal here, {address}. How are things with you?',
    'Thank you, {address}. I am ready for whatever comes next.',
    'Fit as ever, {address}. How is the day treating you?'
  ];
  // Deliberately longer greetings (the "longer one" request). Composed as
  // opener + a fuller status sentence + a question, and used on only one shape
  // so the short forms still dominate the rotation and JARVIS does not monologue.
  const GREETING_LONG_MIDDLES = {
    morning: [
      'Nothing came up overnight that needs your attention, and I have left your settings exactly as they were.',
      'The console has been quiet since last night, and everything is where you left it.',
      'No faults to report, no alarms waiting, and the whole morning is still ahead of you.'
    ],
    afternoon: [
      'The day has run without incident so far, and nothing has needed you while you were away.',
      'Everything stayed steady through the morning, and the afternoon is still entirely yours.',
      'No faults, nothing outstanding, and a clear run at whatever you want to finish.'
    ],
    evening: [
      'The day has wound down quietly, with nothing left outstanding that needs a decision tonight.',
      'Everything has been steady all day, and the evening is free for whatever you have in mind.',
      'No faults to report, and the evening ahead is entirely at your disposal.'
    ],
    night: [
      'The house has gone quiet and nothing has disturbed the night, so the hour is entirely yours.',
      'All remains in order this late, and nothing is waiting that cannot wait until morning.',
      'Systems are steady, the console is dimmed, and I am here for as long as you need me.'
    ]
  };
  function fillAddress(template, address) {
    return String(template || '').replaceAll('{address}', String(address || 'Sir').trim() || 'Sir');
  }
  function pickVariant(list, counter) {
    if (!Array.isArray(list) || !list.length) return '';
    const index = ((Number(counter) || 0) % list.length + list.length) % list.length;
    return list[index];
  }
  // Compose the spoken reply to a greeting. `variant` rotates the shape so
  // JARVIS does not repeat the same sentence and does not ask a question on
  // every single greeting.
  function composeGreetingReply(greeting, { address = 'Sir', style = 'professional', variant = 0, now = new Date() } = {}) {
    const counter = Number.isFinite(Number(variant)) ? Number(variant) : 0;
    const sir = fillAddress('{address}', address);
    let text = '', asks = false;
    if (greeting && greeting.form === 'goodnight') {
      text = pickVariant([
        `Good night, ${sir}. Sleep well.`,
        `Good night, ${sir}. I will keep everything running.`,
        `Good night, ${sir}. I will be right here in the morning.`
      ], counter);
    } else if (greeting && (greeting.form === 'howareyou' || greeting.form === 'howgoesit' || greeting.asksWellbeing)) {
      text = fillAddress(pickVariant(GREETING_WELLBEING_REPLIES, counter), address);
      asks = /\?\s*$/.test(text) || / and you\b/i.test(text) || /yourself\b/i.test(text);
    } else if (greeting && greeting.form === 'whatsup') {
      // "Not much" is a statement plus a question back; never echo the user's
      // own "what's up" wording.
      const statement = pickVariant(GREETING_STATEMENTS[localTimeOfDay(now)] || GREETING_STATEMENTS.evening, counter)
        .replace(/[.,;:!]?\s*Sir\.?$/i, '').replace(/[.,;:!]+$/, '').trim();
      text = `${statement}, ${sir}. ${fillAddress(pickVariant(GREETING_HELLO_QUESTIONS, counter + 1), address)}`;
      asks = true;
    } else if (greeting && greeting.form === 'nice') {
      text = fillAddress(pickVariant(GREETING_NICE_REPLIES, counter), address);
      if (counter % 2 === 1) { text += ` ${fillAddress(pickVariant(GREETING_HELLO_QUESTIONS, counter), address)}`; asks = true; }
    } else {
      // Time-of-day greeting ("good morning") or a plain hello.
      const isTimeGreeting = Boolean(greeting && String(greeting.form || '').startsWith('time_'));
      const opener = fillAddress(pickVariant(GREETING_OPENERS[resolveGreetingTimeOfDay(greeting, now)] || GREETING_OPENERS.evening, counter), address);
      const shape = ((counter % 5) + 5) % 5;
      if (isTimeGreeting) {
        const questions = GREETING_TIME_QUESTIONS[resolveGreetingTimeOfDay(greeting, now)] || GREETING_TIME_QUESTIONS.evening;
        if (shape === 4) { text = `${opener} ${fillAddress(pickVariant(GREETING_LONG_MIDDLES[resolveGreetingTimeOfDay(greeting, now)] || GREETING_LONG_MIDDLES.evening, counter), address)} ${fillAddress(pickVariant(questions, counter + 1), address)}`; asks = true; }
        else if (shape === 0 || shape === 3) { text = `${opener} ${fillAddress(pickVariant(questions, counter), address)}`; asks = true; }
        else if (shape === 1) {
          // The opener has already addressed them, so a trailing ", Sir." in
          // the statement would produce "Still up, Sir. ... Sir.". Stripping it
          // also strips the closing period, so restore sentence punctuation.
          const stmt = pickVariant(GREETING_STATEMENTS[resolveGreetingTimeOfDay(greeting, now)] || GREETING_STATEMENTS.evening, counter)
            .replace(/,?\s*Sir\.?$/i, '').trim();
          text = `${opener} ${stmt}${/[.!?]$/.test(stmt) ? '' : '.'}`;
        }
        else { text = fillAddress(pickVariant(questions, counter + 1), address); asks = true; }
      } else {
        if (shape === 4) { text = `${fillAddress(pickVariant(GREETING_HELLO_OPENERS, counter), address)} ${fillAddress(pickVariant(GREETING_LONG_MIDDLES[resolveGreetingTimeOfDay(greeting, now)] || GREETING_LONG_MIDDLES.evening, counter), address)} ${fillAddress(pickVariant(GREETING_HELLO_QUESTIONS, counter), address)}`; asks = true; }
        else if (shape === 0 || shape === 2) { text = `${fillAddress(pickVariant(GREETING_HELLO_OPENERS, counter), address)} ${fillAddress(pickVariant(GREETING_HELLO_QUESTIONS, counter), address)}`; asks = true; }
        else { text = `${fillAddress(pickVariant(GREETING_HELLO_OPENERS, counter), address)} ${pickVariant(GREETING_HELLO_STATEMENTS, counter)}`; }
      }
    }
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (style && style !== 'professional') text = applyPersonalityStyle(text, style) || text;
    return { text, asks, form: greeting ? greeting.form : 'hello', timeOfDay: resolveGreetingTimeOfDay(greeting, now) };
  }
  // The reply to the user's answer of JARVIS's own wellbeing question.
  // Sentiment-aware, never asks "how are you?" straight back (that is what
  // created the awkward "How goes it?" loop), and stays varied.
  function composeGreetingFollowUp(answer, { address = 'Sir', style = 'professional', variant = 0 } = {}) {
    const text = String(answer || '').trim();
    const lower = text.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const sir = fillAddress('{address}', address);
    const counter = Number.isFinite(Number(variant)) ? Number(variant) : 0;
    const asksBack = /^(?:and you|you|yourself|how about you|what about you|you too)\b/.test(lower) || /\b(?:and you|how about you)\s*\??$/.test(lower);
    // "not bad", "not terrible", "not too shabby" are compliments, so the
    // negation must be resolved before the sentiment is decided.
    const negatedPositive = /\b(?:not|never)\s+(?:too\s+|that\s+)?(?:bad|terrible|awful|shabby|horrible)\b/.test(lower);
    const negatedNegative = /\b(?:not|never|no)\s+(?:\w+\s+){0,2}?(?:good|great|fine|well|amazing|fantastic|wonderful|excellent|brilliant|okay|ok|alright|my best)\b/.test(lower);
    const negative = negatedNegative || (!negatedPositive && /\b(?:bad|awful|terrible|rough|stressed|tired|exhausted|sick|sad|upset|down|horrible|dreadful|overwhelmed|struggling)\b/.test(lower));
    const positive = !negative && !asksBack && (negatedPositive
      || /\b(?:good|great|fine|well|amazing|fantastic|wonderful|excellent|brilliant|pretty good|alright|okay|ok|lovely|decent|busy|productive|energized|excited|happy|calm|relaxed|chill)\b/.test(lower)
      || /\b(?:no complaints|cannot complain|same as usual|better now|all good)\b/.test(lower));
    let reply;
    if (asksBack) reply = pickVariant([
      `I am running well, ${sir}. Thank you for asking.`,
      `All systems are green on my side, ${sir}.`,
      `Doing well, ${sir}. Everything is where it should be.`,
      `Operating smoothly, ${sir}. I appreciate you checking on me.`,
      `All nominal here, ${sir}. How can I help next?`
    ], counter);
    else if (negative) reply = pickVariant([
      `Sorry to hear that, ${sir}. I am here if you want to talk or want a hand with something.`,
      `That sounds rough, ${sir}. Tell me if there is anything I can take off your plate.`,
      `Understood, ${sir}. I will keep things light for you.`,
      `I am sorry, ${sir}. We can take things one step at a time.`,
      `That is tough, ${sir}; let me know if a distraction or a hand would help.`
    ], counter);
    else if (positive) reply = pickVariant([
      `Glad to hear it, ${sir}.`,
      `Good to hear, ${sir}. I am here when you need me.`,
      `That is good to hear, ${sir}. Let me know what is next.`,
      `Pleasant to hear, ${sir}.`,
      `Wonderful, ${sir}. What are we getting up to?`,
      `Excellent, ${sir}. I am at your service.`
    ], counter);
    else reply = pickVariant([
      `Understood, ${sir}. I am right here.`,
      `Noted, ${sir}. What would you like to do next?`,
      `Thank you for telling me, ${sir}.`,
      `Acknowledged, ${sir}. I am paying attention.`,
      `Sure thing, ${sir}. What is on your mind?`,
      `I am listening, ${sir}. What shall we do?`,
      `Of course, ${sir}. How can I help?`,
      `Right with you, ${sir}. What would you like to explore?`,
      `Got you, ${sir}. What sounds good right now?`,
      `Got it, ${sir}. We can move in any direction you like.`
    ], counter);
    reply = applyPersonalityStyle(String(reply).replace(/\s+/g, ' ').trim(), style || 'professional') || String(reply);
    return { text: reply, sentiment: asksBack ? 'asks-back' : negative ? 'negative' : positive ? 'positive' : 'neutral' };
  }

  // =====================================================================
  // Deterministic command detection (Phase 3). Used by the pending-flow
  // resolver so a real computer command spoken mid-workflow ("open
  // Steam") still routes to its handler, while short answers ("4 PM")
  // stay with the workflow.
  // =====================================================================
  function looksLikeDeterministicCommand(input) {
    const text = stripPoliteLead(input).replace(/[.!?]+$/, '').trim();
    if (!text) return false;
    if (parseWebsiteIntent(text) || parseMusicIntent(text) || parseSearchCommand(text) || parseSiteSearchIntent(text) || parseCloseIntent(text)) return true;
    if (parsePlannerIntent(text)) return true;
    if (parseReopenTabIntent(text)) return true;
    // A phrase that starts a different workflow ("set a calendar event" while
    // an email draft is in progress) is a command too — it must leave the
    // current flow alone rather than be stored as an answer.
    if (parseCalendarFlowStart(text) || parseEmailFlowStart(text)) return true;
    if (parseDiscordIntent(text)) {
      // "message Alex the homework is done" while drafting a Discord reply
      // is still a command; the flow only keeps composing replies that are
      // addressed to the pending recipient.
      return true;
    }
    if (/^(?:open|launch|start)\s+(?:up\s+|the\s+)?\S+/i.test(text) && !/^(?:open|launch|start)\s+(?:it|that|one)$/i.test(text)) return true;
    // Bare app names ("Steam") are commands too, so they escape a pending
    // flow instead of being stored as an answer.
    if (parseBareAppName(text)) return true;
    if (/^(?:find|search for|look for|look up|locate)\s+\S+/i.test(text)) return true;
    if (/^(?:switch to|focus)\s+\S+/i.test(text)) return true;
    if (MUSIC_CONTROL_PATTERN.test(text)) return true;
    if (parseYouTubeControl(text) || parseDiscoveryIntent(text)) return true;
    if (/\b(?:shut down|power off|turn off)\s+(?:my\s+)?(?:computer|pc|laptop)\b/i.test(text)) return true;
    return false;
  }

  // =====================================================================
  // Pending multi-turn flows (Phases 6/7/8): calendar, email, Discord.
  // Replies resolve against the active flow BEFORE general classification.
  // =====================================================================
  const flowOrders = { calendar: ['title', 'date', 'time', 'duration'], email: ['to', 'subject', 'body'], discord: ['recipient', 'body'] };
  const wordNumberMap = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12' };
  const normalizeTimeWords = value => String(value || '').replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi, match => wordNumberMap[match.toLowerCase()]);
  // "One hour" -> 60 (minutes). Skip words ("default", "whatever") mean the
  // standard hour. Bare numbers and anything without an explicit unit return
  // null so a time answer is never mistaken for a duration.
  const DURATION_SKIP_RE = /^(?:skip|default|standard|usual|normal|whatever|don'?t know|not sure|doesn'?t matter|an hour|one hour)$/i;
  function parseNaturalDuration(value) {
    const text = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!text) return null;
    if (DURATION_SKIP_RE.test(text)) return 60;
    const norm = normalizeTimeWords(text);
    const half = /\bhalf\s+(?:an?\s+)?hour\b/.test(norm);
    if (half) return 30;
    const match = norm.match(/\b(\d{1,3})\s*(hours?|hrs?|minutes?|mins?)\b/);
    if (match) {
      const n = Number(match[1]);
      if (!Number.isFinite(n) || n <= 0) return null;
      const minutes = /^\s*h/i.test(match[2]) ? n * 60 : n;
      if (minutes < 5 || minutes > 720) return null;
      return minutes;
    }
    // At the duration step a bare DIGIT number means minutes ("90" -> 90
    // minutes). Word-numbers ("seven") stay null so they are never mistaken
    // for a duration — they belong to time answers. The mid-flow capture
    // still requires an explicit unit on top of this.
    const bare = text.match(/^\s*(\d{1,3})\s*$/);
    if (bare) {
      const n = Number(bare[1]);
      if (Number.isFinite(n) && n >= 5 && n <= 720) return n;
    }
    return null;
  }
  const flowValidators = {
    calendar: {
      title: value => value.trim().length >= 2 && value.trim().split(/\s+/).length <= 14,
      date: value => /\b(?:today|tomorrow|tonight|day after tomorrow|(?:next|on|this)?\s*(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/i.test(value),
      // Strict: a time step is complete only with explicit AM/PM, 24h time,
      // or noon/midnight. Bare "10" or "10:39" without meridiem is ambiguous
      // and must re-ask (not complete prematurely and fail later in the
      // completer, which caused the infinite AM/PM loop).
      time: value => {
        const t = normalizeTimeWords(normalizeTimeString(value));
        if (/\bnoon\b|\bmidnight\b/i.test(t)) return true;
        const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?m\.?|p\.?m\.?)?\b/i);
        if (!m) return false;
        const hasMeridiem = Boolean(m[3]);
        const h = Number(m[1]), mi = m[2] !== undefined ? Number(m[2]) : 0;
        if (!Number.isFinite(h) || !Number.isFinite(mi) || mi > 59 || h > 23) return false;
        if (hasMeridiem) return h >= 1 && h <= 12;
        // No meridiem: only 24h clock with minutes counts as explicit
        // ("14:30", "0:15"). "10:39" or "10" without AM/PM stays ambiguous.
        if (m[2] !== undefined) return h === 0 || h > 12;
        return false;
      },
      // Optional-with-default: "one hour", "30 minutes", "half an hour" all
      // pass, and so do skip words. Anything unparseable still fills the
      // field — the completer falls back to the standard hour.
      duration: value => parseNaturalDuration(value) != null
    },
    email: {
      // Recipients may be addresses OR bare names ("John"). Requiring an
      // address here caused the recipient-question loop: a name failed, the
      // flow re-asked, and no answer could ever pass. Names are kept with an
      // unresolved status and resolved (or asked as an address) later.
      to: value => {
        const clean = value.trim();
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return true;
        return /^[A-Za-z][A-Za-z0-9 .'\-]{1,39}$/.test(clean)
          && !/^(?:skip|later|none|blank|not sure|no one yet|cancel|it|that|this|them|him|her|you|me|someone|somebody|anybody|anyone|nobody|everybody|everyone)$/i.test(clean);
      },
      subject: value => value.trim().length >= 2 && value.trim().split(/\s+/).length <= 16,
      body: value => value.trim().length >= 2
    },
    discord: {
      recipient: value => /^[a-z0-9 _.\-]{2,40}$/i.test(value.trim()) && !/^(?:it|that|this|the message|something)$/i.test(value.trim()),
      body: value => value.trim().length >= 1
    }
  };
  // Email recipient resolution status: 'address' (usable), 'name' (kept but
  // needs an address before sending), '' (empty/skipped).
  function emailToStatus(value) {
    const clean = String(value || '').trim();
    if (!clean || clean === '__SKIP__') return '';
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return 'address';
    return 'name';
  }
  const structuredFlowFields = new Set(['date', 'time', 'to']);
  function flowQuestion(kind, step) {
    const table = {
      calendar: { title: 'What is the event for?', date: 'What day should I put it on?', time: 'What time is it?', duration: 'How long should it last?' },
      email: { to: 'Who should the email go to?', subject: 'What should the subject be?', body: 'What should the email say?' },
      discord: { recipient: 'Who should I message on Discord?', body: 'What should I say?' }
    };
    return table[kind]?.[step] || 'Could you tell me that again?';
  }
  function isFlowCancel(input) {
    const text = String(input || '').trim().replace(/[.!?]+$/, '');
    return /^(?:cancel|never\s*mind|nevermind|forget\s+(?:it|that|this)|abort|stop\s+(?:that|this|it)|discard|delete\s+(?:that|this|it)|don'?t\s+(?:do|create|send|bother)\s+(?:it|that|this)|no(?:pe| thanks)?|actually\s+(?:cancel|forget)(?:\s+it|\s+that)?)$/i.test(text)
      || /^(?:cancel|forget|abort)\s+(?:the\s+)?(?:event|meeting|email|e-mail|mail|message|draft|it|that|this)$/i.test(text);
  }
  function startPendingFlow(kind, { values = {}, question = '', ttlMs = 240000, now = Date.now() } = {}) {
    const order = flowOrders[kind];
    if (!order) return null;
    const at = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : Date.now());
    const flow = { kind, order: [...order], values: { ...values }, step: '', question: '', createdAt: at, expiresAt: at + ttlMs, id: `flow-${at}-${Math.random().toString(36).slice(2, 8)}` };
    recomputeFlowStep(flow, question);
    return flow;
  }
  function recomputeFlowStep(flow, question = '') {
    const spec = flowValidators[flow.kind] || {};
    void spec;
    flow.step = flow.order.find(field => !String(flow.values[field] ?? '').trim()) || '';
    flow.completed = !flow.step;
    flow.question = flow.completed ? '' : (question || (flow.step ? flowQuestion(flow.kind, flow.step) : ''));
    return flow;
  }
  function detectFlowCorrection(flow, raw, spec) {
    const lead = raw.replace(/^(?:actually|in fact|instead|on second thought)[,:\s]+/i, '').trim();
    if (!lead) return null;
    for (const field of structuredFlowFields) {
      if (field === flow.step) continue;
      if (!String(flow.values[field] ?? '').trim()) continue;
      if (spec[field] && spec[field](lead)) return { field, value: lead };
    }
    return null;
  }
  // Returns one of: none | expired | cancelled | unrelated | reask | answer |
  // correction | complete. "unrelated" keeps the flow alive for later.
  function advancePendingFlow(flow, input, now = Date.now()) {
    if (!flow) return { type: 'none' };
    // Infinite-loop fix: a completed calendar flow that still carries an
    // invalid/ambiguous time must be reopened so the next answer is merged
    // instead of ignored. Previously `if (flow.completed) return complete`
    // ignored all new input, so one bad transcription ("10:39 a m",
    // "10 39 AM") stuck the user in the same AM/PM question forever.
    if (flow.completed) {
      if (flow.kind === 'calendar') {
        const stored = parseNaturalTime(String(flow.values.time || ''));
        if (!stored || stored.error || stored.ambiguous) {
          const reopened = { ...flow, values: { ...flow.values, time: '' }, completed: false, touchedAt: now };
          recomputeFlowStep(reopened);
          flow = reopened;
        } else {
          return { type: 'complete', flow };
        }
      } else {
        return { type: 'complete', flow };
      }
    }
    if (now > flow.expiresAt) return { type: 'expired', flow };
    let raw = String(input || '').trim().replace(/^[,.\s]+/, '').replace(/[.!?]+$/, '').trim();
    if (!raw) return { type: 'unrelated', flow };
    if (isFlowCancel(raw)) return { type: 'cancelled', flow };
    // The email recipient may be skipped deliberately ("skip", "not sure yet")
    // so drafts without a recipient stay possible. This runs BEFORE the
    // deterministic check: at the 'to' step, "skip" answers the question and
    // must not be mistaken for a music-skip command.
    if (flow.kind === 'email' && flow.step === 'to' && /^(?:skip|later|no one yet|not sure|none|blank)$/i.test(raw)) {
      const values = { ...flow.values, to: '__SKIP__' };
      const nextFlow = { ...flow, values, touchedAt: now };
      recomputeFlowStep(nextFlow);
      return nextFlow.completed ? { type: 'complete', flow: nextFlow, field: 'to' } : { type: 'answer', flow: nextFlow, field: 'to' };
    }
    if (looksLikeDeterministicCommand(raw)) return { type: 'unrelated', flow };
    // A greeting addressed to JARVIS mid-workflow ("Hello, Jarvis.") is a new
    // social turn, not an answer: keep the collected fields and let the
    // caller route it to the greeting handler instead of storing it as the
    // event title, recipient, or message body.
    if (parseGreetingIntent(raw, new Date(now))) return { type: 'unrelated', flow };
    raw = raw.replace(/^(?:actually|in fact|instead|on second thought)[,:\s]+/i, '').trim();
    if (!raw) return { type: 'unrelated', flow };
    const spec = flowValidators[flow.kind] || {};
    // AM/PM resolution after an ambiguous time question. Accepts both bare
    // answers ("PM") and natural phrases ("in the afternoon", "in the
    // morning") through the shared meridiem parser.
    if (flow.kind === 'calendar' && flow.values.timeAmbiguous && parseMeridiemAnswer(raw)) {
      const meridiem = parseMeridiemAnswer(raw);
      const pending = flow.values.timeAmbiguous;
      const hour24 = meridiem === 'pm' ? (pending.hour % 12) + 12 : pending.hour % 12;
      // Store with explicit AM/PM/24h so re-parsing never sees it as ambiguous.
      const values = { ...flow.values, time: formatTimeForStorage(hour24, pending.minute) };
      delete values.timeAmbiguous;
      const nextFlow = { ...flow, values };
      recomputeFlowStep(nextFlow);
      return nextFlow.completed ? { type: 'complete', flow: nextFlow, field: 'time' } : { type: 'answer', flow: nextFlow, field: 'time' };
    }
    const stepValidator = spec[flow.step];
    const stepPass = stepValidator ? stepValidator(raw) : raw.split(/\s+/).length <= 24;
    if (stepPass) {
      let storedValue = raw;
      // Normalize calendar time answers preserving AM/PM so "10:39AM",
      // "10:39 Am", "10:39 a m", "10 39 AM" all converge to an explicit
      // value and the completer never re-asks for a validated field.
      if (flow.kind === 'calendar' && flow.step === 'time') {
        const parsed = parseNaturalTime(raw);
        if (parsed && !parsed.error && !parsed.ambiguous) {
          storedValue = formatTimeForStorage(parsed.hour, parsed.minute);
        }
      }
      const values = { ...flow.values, [flow.step]: storedValue };
      // An explicit time answer resolves any earlier ambiguous time.
      if (flow.kind === 'calendar' && flow.step === 'time' && String(storedValue || '').trim()) {
        const check = parseNaturalTime(storedValue);
        if (check && !check.error && !check.ambiguous) delete values.timeAmbiguous;
      }
      // Duration answers are stored as minutes so the completer never has to
      // re-parse colloquial phrasing ("one hour" -> "60").
      if (flow.kind === 'calendar' && flow.step === 'duration') {
        const minutes = parseNaturalDuration(raw);
        values.duration = String(minutes != null ? minutes : 60);
      }
      // Out-of-order backfill only for calendar structured fields (a bare
      // "tomorrow" answers the date step early). Email and Discord validators
      // are intentionally loose, so backfilling there copies one answer into
      // every empty field ("John" would become recipient, subject, AND body).
      if (flow.kind === 'calendar') {
        for (const field of flow.order) {
          if (field !== flow.step && !String(values[field] ?? '').trim() && spec[field] && spec[field](raw)) {
            if (field === 'time') {
              const backParsed = parseNaturalTime(raw);
              values[field] = (backParsed && !backParsed.error && !backParsed.ambiguous)
                ? formatTimeForStorage(backParsed.hour, backParsed.minute)
                : raw;
              if (backParsed && !backParsed.error && !backParsed.ambiguous) delete values.timeAmbiguous;
            } else if (field === 'duration') {
              const backMinutes = parseNaturalDuration(raw);
              values[field] = String(backMinutes != null ? backMinutes : 60);
            } else {
              values[field] = raw;
            }
          }
        }
      }
      const nextFlow = { ...flow, values, touchedAt: now };
      recomputeFlowStep(nextFlow);
      // If the answered time was actually ambiguous (should not happen with
      // the strict validator, but guard anyway), keep the flow open at the
      // time step with a specific AM/PM question instead of completing.
      if (flow.kind === 'calendar' && nextFlow.completed) {
        const finalTime = parseNaturalTime(String(nextFlow.values.time || ''));
        if (!finalTime || finalTime.error || finalTime.ambiguous) {
          const reopened = { ...nextFlow, values: { ...nextFlow.values, time: '' }, completed: false, touchedAt: now };
          if (finalTime && finalTime.ambiguous) {
            reopened.values.timeAmbiguous = { hour: finalTime.hour, minute: finalTime.minute };
            recomputeFlowStep(reopened, `Did you mean ${finalTime.hour}:${String(finalTime.minute).padStart(2, '0')} AM or PM?`);
          } else {
            recomputeFlowStep(reopened);
          }
          return { type: 'answer', flow: reopened, field: flow.step };
        }
        delete nextFlow.values.timeAmbiguous;
      }
      return nextFlow.completed ? { type: 'complete', flow: nextFlow, field: flow.step } : { type: 'answer', flow: nextFlow, field: flow.step };
    }
    // Calendar duration said out of order ("make it two hours" while the time
    // question is pending): fill the duration field, keep the current step,
    // and re-ask the same question. An explicit unit is required so a bare
    // time answer ("seven") can never land here.
    if (flow.kind === 'calendar' && flow.step !== 'duration' && !String(flow.values.duration || '').trim()
      && /\b(hours?|hrs?|minutes?|mins?)\b/i.test(raw)) {
      const minutes = parseNaturalDuration(raw);
      if (minutes != null) {
        const values = { ...flow.values, duration: String(minutes) };
        const nextFlow = { ...flow, values, touchedAt: now };
        // The step does not change, so re-ask the SAME question (which may
        // be a specific clarification such as "Did you mean 3:30 AM or PM?").
        // Recomputing a generic question here used to discard it.
        recomputeFlowStep(nextFlow, flow.question);
        return { type: 'answer', flow: nextFlow, field: 'duration' };
      }
    }
    // Calendar time step: an ambiguous numeric answer ("10", "10:39" without
    // AM/PM) should ask once for AM/PM instead of a generic re-ask, and must
    // not complete. This keeps collected title/date and records the pending
    // hour/minute for the bare "am"/"pm" resolution above.
    if (flow.kind === 'calendar' && flow.step === 'time') {
      const attempt = parseNaturalTime(raw);
      if (attempt && attempt.ambiguous) {
        const values = { ...flow.values, timeAmbiguous: { hour: attempt.hour, minute: attempt.minute } };
        const nextFlow = { ...flow, values, touchedAt: now };
        // Keep the time field empty so the step stays at time.
        recomputeFlowStep(nextFlow, `Did you mean ${attempt.hour}:${String(attempt.minute).padStart(2, '0')} AM or PM?`);
        return { type: 'answer', flow: nextFlow, field: 'time' };
      }
    }
    const correction = detectFlowCorrection(flow, raw, spec);
    if (correction) {
      const values = { ...flow.values, [correction.field]: correction.value };
      const nextFlow = { ...flow, values, touchedAt: now };
      recomputeFlowStep(nextFlow);
      return { type: 'correction', flow: nextFlow, field: correction.field };
    }
    return { type: 'reask', flow };
  }
  // Start of the multi-turn calendar workflow: "set a calendar event".
  function parseCalendarFlowStart(input, now = new Date()) {
    const text = stripPoliteLead(input).replace(/[?!.]+$/, '').trim();
    const verb = /^(?:set|create|add|make|schedule|book|put)\b/i.test(text);
    const noun = /\b(?:event|meeting|appointment|calendar)\b/i.test(text);
    if (!verb || !(noun || /^schedule\b/i.test(text))) return null;
    if (/\balarm\b/i.test(text) || /\bremind me\b/i.test(text)) return null;
    if (parsePlannerIntent(text, now)) return null; // complete one-shot stays on the fast path
    const values = {};
    let rest = text
      .replace(/^(?:set|create|add|make|schedule|book|put)\s+(?:a|an|the)?\s*(?:new\s+)?(?:calendar\s+)?(?:event|meeting|appointment|calendar)\b/i, ' ')
      .replace(/^\s*(?:set|create|add|make|schedule|book|put)\s+/i, ' ')
      .replace(/^\s*(?:called|named|for|about|regarding|titled)\s+/i, ' ');
    const dayToken = rest.match(/\b(day after tomorrow|today|tomorrow|tonight)\b/i);
    if (dayToken) values.date = dayToken[1].toLowerCase();
    const weekday = rest.match(/\b(?:(?:next|on|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
    if (!values.date && weekday) values.date = weekday[0].toLowerCase().replace(/\s+/g, ' ').trim();
    const time = parseNaturalTime(rest);
    if (time && !time.error) {
      if (time.ambiguous) values.timeAmbiguous = { hour: time.hour, minute: time.minute };
      else values.time = formatTimeForStorage(time.hour, time.minute);
    }
    // A duration said up front ("... for two hours") is kept so it is never
    // asked again: "one hour" must not be re-parsed as a time later.
    const durationMinutes = parseNaturalDuration(rest);
    if (durationMinutes != null && /\b(hours?|hrs?|minutes?|mins?)\b/i.test(rest)) values.duration = String(durationMinutes);
    rest = rest
      .replace(/\b(?:day after tomorrow|today|tomorrow|tonight)\b/ig, ' ')
      .replace(/\b(?:(?:next|on|this)\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/ig, ' ')
      .replace(/\b(?:at\s*)?\d{1,2}(?::\d{2}|\s+\d{2})?\s*(?:a\s*\.?\s*m\s*\.?|p\s*\.?\s*m\s*\.?)?\b/ig, ' ')
      .replace(/\b(?:noon|midnight|o'?clock)\b/ig, ' ')
      .replace(/\b(?:for\s+)?(?:\d+\s*(?:hours?|hrs?|minutes?|mins?)|half\s+(?:an?\s+)?hour|an?\s+hour)\b/ig, ' ')
      .replace(/\s+/g, ' ').replace(/^[\s,.\-:]+|[\s,.\-:]+$/g, '').trim();
    if (rest && !/^(?:the|a|an|on|at)$/i.test(rest)) values.title = rest.slice(0, 120);
    const flow = startPendingFlow('calendar', { values, now });
    if (!flow || flow.completed) return null;
    if (values.timeAmbiguous && flow.step === 'time') flow.question = `Did you mean ${values.timeAmbiguous.hour}:${String(values.timeAmbiguous.minute).padStart(2, '0')} AM or PM?`;
    return flow;
  }
  // Start of the multi-turn email workflow (Phase 7).
  // Splitter shared by the flow starter and the one-shot path: pulls whatever
  // recipient, subject, and body the original command already contains so
  // answered questions are never asked again.
  function extractEmailParts(input) {
    const text = stripPoliteLead(input).replace(/[?!.]+$/, '').trim();
    const values = {};
    const to = text.match(/\b(?:to|for)\s+([^\s@]+@[^\s@]+\.[^\s@]+)/i);
    if (to) values.to = to[1];
    if (!values.to) {
      const nameTo = text.match(/\b(?:to|for)\s+([A-Za-z][A-Za-z .'\-]{1,39}?)(?=\s+(?:about|regarding|concerning|subject|body|with|say(?:s|ing)?(?:\s+that)?|that|please)\b|$)/i);
      if (nameTo && !/^(?:my|the|an?)\s+/i.test(nameTo[1])) values.to = nameTo[1].trim();
    }
    const subject = text.match(/\bsubject\s+(.+?)(?=\s+body\s|\s+and\s+say(?:s|ing)?(?:\s+that)?\s+|$)/i);
    if (subject) values.subject = subject[1].trim();
    const body = text.match(/\bbody\s+(.+)$/i);
    if (body) values.body = body[1].trim();
    if (!values.body) {
      const said = text.match(/\b(?:and\s+)?say(?:s|ing)?(?:\s+that)?\s+(.+)$/i);
      if (said) values.body = said[1].trim();
    }
    if (!values.subject) {
      // "write an email about my absence" pre-fills the subject from the topic
      // so the flow only asks for what is still missing.
      const topic = text.match(/\b(?:about|regarding|concerning)\s+(.+)$/i);
      if (topic) values.subject = topic[1].trim().slice(0, 80);
    }
    return values;
  }
  // Email summarization over genuinely retrieved messages only. Quotes the
  // source for dates, questions, and action cues; never invents content.
  // Snippets are untrusted data: displayed, never acted on.
  function summarizeEmail(item = {}, detail = false) {
    const from = String(item.from || 'unknown sender').slice(0, 120);
    const subject = String(item.subject || '(no subject)').slice(0, 160);
    const date = String(item.date || '').slice(0, 80);
    const snippet = String(item.snippet || '').replace(/\s+/g, ' ').trim();
    const deadlines = [...new Set([...snippet.matchAll(/\b(?:tomorrow|today|tonight|next week|this (?:week|weekend)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\d{1,2}:\d{2}(?:\s*(?:am|pm))?)\b/gi)].map(m => m[0]))].slice(0, 4);
    const questions = [...snippet.matchAll(/[^.?!]{4,140}\?/g)].map(m => m[0].trim()).slice(0, 3);
    const actionCues = [...snippet.matchAll(/\b(?:please\s+)?(?:confirm|approve|review|sign|send|reply|respond|complete|fill(?:\s+out| in)?|submit|pay|attend|join|call|schedule)\b[^.?!]{0,80}/gi)].map(m => m[0].trim()).slice(0, 3);
    let summary = `From ${from} — “${subject}”${date ? ` (${date})` : ''}.`;
    if (snippet) summary += ` ${snippet.slice(0, 220)}${snippet.length > 220 ? '…' : ''}`;
    else summary += ' No readable preview was retrieved.';
    if (deadlines.length) summary += ` Dates mentioned: ${deadlines.join('; ')}.`;
    if (!detail) return summary;
    if (actionCues.length) summary += ` Possible actions: ${actionCues.join('; ')}.`;
    if (questions.length) summary += ` Open questions: ${questions.join(' ')}`;
    return summary;
  }
  function parseEmailFlowStart(input, now = Date.now()) {
    const text = stripPoliteLead(input).replace(/[?!.]+$/, '').trim();
    if (!/^(?:write|draft|compose|send|start)\s+(?:an?\s+)?(?:email|e-?mail)\b/i.test(text)) return null;
    const values = extractEmailParts(input);
    const flow = startPendingFlow('email', { values, now });
    if (!flow || flow.completed) return null; // complete drafts use the one-shot path
    return flow;
  }

  // =====================================================================
  // File search pipeline (Phase 5): query parsing, filters, ranking.
  // =====================================================================
  const folderAliases = { desktop: 'Desktop', document: 'Documents', documents: 'Documents', download: 'Downloads', downloads: 'Downloads', picture: 'Pictures', pictures: 'Pictures', photo: 'Pictures', photos: 'Pictures', image: 'Pictures', images: 'Pictures', video: 'Videos', videos: 'Videos', movie: 'Videos', movies: 'Videos', music: 'Music' };
  const extensionAliases = { pdf: '.pdf', python: '.py', text: '.txt', txt: '.txt', csv: '.csv', json: '.json', word: '.docx', doc: '.docx', docx: '.docx', excel: '.xlsx', sheet: '.xlsx', spreadsheet: '.xlsx', xlsx: '.xlsx', powerpoint: '.pptx', ppt: '.pptx', zip: '.zip', mp3: '.mp3', mp4: '.mp4', javascript: '.js', js: '.js', markdown: '.md', md: '.md' };
  function parseFileSearchIntent(input) {
    const text = stripPoliteLead(input).replace(/[?!.]+$/, '').trim();
    const match = text.match(/^(?:where (?:did i|have i|do i keep|was|is|are)|where(?:'s| is)|where did i put)\s+(?:my\s+|the\s+|some\s+)?(.+)$/i)
      || text.match(/^(?:find(?: me)?|search for|search\s+my\s+files?\s+for|search\s+(?:my|the)\s+computer\s+for|look for|look up|locate)\s+(?:my\s+|the\s+|some\s+)?(.+)$/i);
    if (!match) return null;
    let rest = match[1].trim().replace(/\s+on\s+(?:my|this|the)\s+computer$/i, ' ').trim();
    const intent = { query: '', folder: '', folders: [], extension: '', latest: false, withinDays: 0 };
    // Explicit file-request markers ("called", "named", "anything", a folder
    // noun, "my files", "on my computer"). A bare "find X" still needs a
    // fileish word elsewhere so "find the meaning of photosynthesis" keeps
    // going to the assistant instead of file search.
    intent.explicit = /\b(?:called|named|files?|folders?|director(?:y|ies)|dir|anything)\b/i.test(rest)
      || /\bon\s+(?:my|this|the)\s+computer$/i.test(match[1])
      || /\bmy\s+files?\b/i.test(rest);
    const folderClause = rest.match(/\s+(?:in|inside|under)\s+(?:my\s+)?(desktop|documents?|downloads?|pictures?|photos?|images?|videos?|movies?|music)(?:\s+folder)?$/i);
    if (folderClause) {
      intent.folder = folderAliases[folderClause[1].toLowerCase()] || 'Documents';
      rest = rest.slice(0, folderClause.index).trim();
    } else {
      const onlyFolder = rest.match(/^(?:my\s+)?(desktop|documents?|downloads?|pictures?|photos?|images?|videos?|movies?|music)(?:\s+folder|s)?$/i);
      if (onlyFolder) {
        intent.folder = folderAliases[onlyFolder[1].toLowerCase().replace(/s$/, '')] || folderAliases[onlyFolder[1].toLowerCase()] || 'Documents';
        rest = '';
      }
    }
    // Multi-root requests ("in my Documents and Downloads"): collect every
    // distinct known folder named after in/inside/under/from. Only set when
    // two or more differ so single-folder behavior is untouched.
    const multiRoots = [...rest.matchAll(/(?:in|inside|under|from)\s+(?:my\s+|the\s+)?(desktop|documents?|downloads?|pictures?|photos?|images?|videos?|movies?|music)\b/gi)]
      .map(hit => folderAliases[hit[1].toLowerCase().replace(/s$/, '')] || folderAliases[hit[1].toLowerCase()])
      .filter(Boolean);
    const uniqueRoots = [...new Set(multiRoots)];
    if (uniqueRoots.length >= 2) {
      intent.folders = uniqueRoots;
      rest = rest.replace(/(?:in|inside|under|from)\s+(?:my\s+|the\s+)?(?:desktop|documents?|downloads?|pictures?|photos?|images?|videos?|movies?|music)(?:\s+and\s+(?:my\s+|the\s+)?(?:desktop|documents?|downloads?|pictures?|photos?|images?|videos?|movies?|music))+/gi, ' ').trim();
    }
    if (/\b(?:latest|newest|most recent|recent)\b/i.test(rest)) {
      intent.latest = true;
      rest = rest.replace(/\b(?:latest|newest|most recent|recent)\b/ig, ' ');
    }
    // Recency clause: "pdf files from this week" must filter by age and keep
    // the words out of the name tokens, otherwise every token has to appear
    // in a file name and nothing matches.
    const recency = rest.match(/\b(?:from\s+|in\s+|of\s+)?(?:the\s+)?(?:last|past|previous|this)\s+(week|month|year|day|days)\b/i);
    if (recency) {
      intent.latest = true;
      const unit = recency[1].toLowerCase();
      intent.withinDays = unit === 'week' ? 7 : unit === 'month' ? 31 : unit === 'year' ? 365 : 1;
      rest = rest.replace(recency[0], ' ');
    } else {
      const dayWord = rest.match(/\b(today|yesterday)\b/i);
      if (dayWord) {
        intent.latest = true;
        intent.withinDays = dayWord[1].toLowerCase() === 'yesterday' ? 2 : 1;
        rest = rest.replace(dayWord[0], ' ');
      }
    }
    const extWord = rest.match(/\b(\w{1,10})\s+files?\b/i);
    if (extWord && extensionAliases[extWord[1].toLowerCase()]) {
      intent.extension = extensionAliases[extWord[1].toLowerCase()];
      rest = rest.replace(extWord[0], ' ');
    }
    if (!intent.extension) {
      const leading = rest.match(/^(?:the\s+)?(\w{2,10})(?:\s+file)?\b/i);
      if (leading && extensionAliases[leading[1].toLowerCase()] && /^\S+(\s+\S+)?$/.test(rest.split(/\s+(?:about|regarding|called|named)\s+/i)[0].trim())) {
        intent.extension = extensionAliases[leading[1].toLowerCase()];
        rest = rest.replace(leading[0], ' ');
      }
    }
    const dotExt = rest.match(/(?:^|\s)(\.[a-z0-9]{1,6})\b/i);
    if (dotExt && /^\.[a-z0-9]{1,6}$/i.test(dotExt[1])) {
      intent.extension = dotExt[1].toLowerCase();
      rest = rest.replace(dotExt[0], ' ');
    }
    rest = rest.replace(/\b(?:files?|folders?|called|named|about|related to|of|my|the|a|an|one|all|anything|something|director(?:y|ies)|dir|computer|saved|stored|save|where|did|i|me|for|on|put|keep|is|it|that)\b/ig, ' ')
      .replace(/\s+/g, ' ').replace(/^[\s,.\-]+|[\s,.\-]+$/g, '').trim();
    intent.query = rest.slice(0, 100);
    if (!intent.query && !intent.folder && !intent.extension && !intent.latest) return null;
    if (!intent.query && !intent.folder) intent.latest = true; // "find any pdf" ranks newest first
    return intent;
  }
  function rankFileResults(results, intent = {}) {
    const query = String(intent.query || '').trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const ext = String(intent.extension || '').toLowerCase();
    const scored = [];
    for (const item of (Array.isArray(results) ? results : [])) {
      const name = String(item?.name || '').toLowerCase();
      if (!name) continue;
      const base = name.replace(/\.[^.]+$/, '');
      let score = 0;
      if (query) {
        if (base === query || name === query || name === `${query}${ext}`) score = 100;
        else if (name.startsWith(query) || base.startsWith(query)) score = 80;
        else if (name.includes(query)) score = 60;
        else if (tokens.length && tokens.every(token => name.includes(token))) score = 45;
        else if (tokens.some(token => token.length > 2 && name.includes(token))) score = 25;
        else continue; // matched only by removed filler words: drop it
      } else score = 40;
      if (ext && name.endsWith(ext)) score += 10;
      scored.push({ item, score, modified: Date.parse(item.modified) || 0, name });
    }
    if (intent.latest) scored.sort((a, b) => b.modified - a.modified || b.score - a.score || a.name.localeCompare(b.name));
    else scored.sort((a, b) => b.score - a.score || b.modified - a.modified || a.name.localeCompare(b.name));
    return scored.map(row => row.item);
  }
  const ordinalWords = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  // "the second result", "the 3rd event", "the last tab" -> 1-based position
  // or { last: true }. Only called where a list is active.
  function parseOrdinalTarget(input) {
    const text = String(input || '').trim().replace(/[.!?]+$/, '');
    const noun = '(?:\\s+(?:one|result|results|file|files|folder|folders|event|events|tab|tabs|match|matches|item|items|entry|entries|option|options))?';
    const word = text.match(new RegExp(`\\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)${noun}\\b`, 'i'));
    if (word) return { last: word[1].toLowerCase() === 'last', position: word[1].toLowerCase() === 'last' ? null : ordinalWords[word[1].toLowerCase()] };
    const numeric = text.match(/\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (numeric) return { last: false, position: Number(numeric[1]) };
    return null;
  }

  // =====================================================================
  // Browser tab matching (Phase 9): pure helper shared by server/tests.
  //
  // Naive substring matching could not resolve natural phrases against real
  // video titles ("close the Tick-Tack dance" vs
  // "ILLIT (아일릿) 'Tick-Tack' Dance Practice - YouTube"), and made a tab
  // whose title merely contains the word "YouTube" match every YouTube
  // request. Scoring below compares DISTINCTIVE tokens instead, and ranks
  // candidates so a single clear winner is acted on without asking again.
  // =====================================================================
  // Words that carry no identifying signal in a page title. Kept small and
  // explicit so distinctive names (Tick-Tack, ILLIT, dance) still count.
  const TAB_NOISE_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'my', 'me', 'this', 'that', 'it', 'is', 'are', 'be', 'please', 'tab', 'tabs', 'page', 'video', 'watch', 'home', 'app', 'www', 'com', 'http', 'https']);
  // Normalize for COMPARISON ONLY. The original title is never modified, so
  // Thai/Unicode characters survive into the reply that names the tab.
  function normalizeTabText(value) {
    return String(value || '')
      .toLowerCase()
      // Curly quotes and typographic dashes used in real YouTube titles.
      .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      // Keep letters/digits from ANY script (Thai included); split on the rest.
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function tabTextTokens(value) {
    return normalizeTabText(value).split(' ').filter(Boolean);
  }
  // Score one tab against one query. Returns 0 when nothing meaningful matches.
  // Signals, strongest first: exact normalized title hit, exact video id in the
  // URL, distinctive-token overlap, and finally a plain substring fallback.
  function scoreTabMatch(tab, query) {
    const rawQuery = String(query || '').trim();
    if (!rawQuery) return 0;
    const title = String(tab?.title || '');
    const url = String(tab?.url || '');
    const nTitle = normalizeTabText(title);
    const nUrl = normalizeTabText(url);
    const nQuery = normalizeTabText(rawQuery);
    if (!nQuery) return 0;

    // Exact normalized title equals the query: strongest possible signal.
    if (nTitle === nQuery) return 100;
    // A URL is a very specific identifier; an exact hit outranks token overlap.
    if (nUrl && nUrl === nQuery) return 95;
    // Whole-query substring of the title (handles "tick-tack" inside a title).
    if (nTitle.includes(nQuery)) return 80;
    // Case-insensitive whole-query substring of the normalized URL as well,
    // so host/owner tokens like "atlassian" (from acme.atlassian.net) match.
    if (nUrl && nUrl.includes(nQuery)) return 80;

    // Distinctive-token overlap. Query tokens that are noise ("the", "tab")
    // are dropped so they cannot inflate the score.
    const qTokens = tabTextTokens(rawQuery).filter(token => !TAB_NOISE_WORDS.has(token));
    if (!qTokens.length) return 0;
    const tTokens = new Set(tabTextTokens(title));
    const uTokens = new Set(tabTextTokens(url));
    let hits = 0;
    for (const token of qTokens) {
      if (tTokens.has(token)) { hits += 1; continue; }
      // A query token that is a prefix of a title token still counts (e.g.
      // "dance" vs "dances", "tick" vs "ticktack" is deliberately NOT matched).
      if ([...tTokens].some(t => t.length >= 4 && token.length >= 4 && (t.startsWith(token) || token.startsWith(t)))) { hits += 0.5; continue; }
      if ([...uTokens].some(t => t.length >= 4 && token.length >= 4 && (t.startsWith(token) || token.startsWith(t)))) hits += 0.4;
    }
    if (hits <= 0) return 0;
    // Coverage ratio matters more than raw count: matching every distinctive
    // word of the query outranks matching one word of a long query.
    const coverage = hits / qTokens.length;
    if (coverage < 0.5) return 0;
    return Math.round(coverage * 60);
  }
  function matchBrowserTabs(tabs, query) {
    const list = Array.isArray(tabs) ? tabs : [];
    const q = String(query || '').trim();
    if (!q) return { matches: [], scored: [] };
    const scored = [];
    for (const tab of list) {
      const score = scoreTabMatch(tab, q);
      if (score > 0) scored.push({ tab, score });
    }
    scored.sort((a, b) => b.score - a.score);
    // Keep every scored candidate, best first, so the caller can ask with the
    // real titles and re-rank on the user's answer.
    return { matches: scored.map(item => item.tab), scored, best: scored[0] || null };
  }

  // =====================================================================
  // Persistent memory and conversation recall (Phase 4).
  // =====================================================================
  function containsSensitiveData(text) {
    const value = String(text || '');
    if (/sk-[A-Za-z0-9_-]{10,}/.test(value)) return true;
    if (/\bBearer\s+[A-Za-z0-9._-]{10,}/i.test(value)) return true;
    if (/\b(?:password|passcode|api[_ -]?key|access[_ -]?key|secret|token|credential|app password|bot token|private key)s?\b\s*(?:is|=|:)\s*\S{4,}/i.test(value)) return true;
    return false;
  }
  function migrateMemory(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const migrated = [];
    for (const item of list) {
      if (!item) continue;
      if (typeof item === 'string') {
        if (item.trim()) migrated.push({ id: `mem-legacy-${migrated.length}`, text: item.trim().slice(0, 240), at: 0, kind: 'note' });
      } else if (typeof item === 'object' && typeof item.text === 'string' && item.text.trim()) {
        migrated.push({ id: item.id || `mem-${migrated.length}`, text: item.text.trim().slice(0, 240), at: Number(item.at) || 0, kind: item.kind || 'note' });
      }
    }
    return migrated.slice(-50);
  }
  function addMemoryEntry(list, text, now = Date.now()) {
    const clean = String(text || '').trim().replace(/[.\s]+$/, '').slice(0, 240);
    if (!clean) return { list, entry: null, reason: 'empty' };
    if (containsSensitiveData(clean)) return { list, entry: null, reason: 'sensitive' };
    const lower = clean.toLowerCase();
    if ((Array.isArray(list) ? list : []).some(item => String(item?.text ?? item).toLowerCase() === lower)) return { list, entry: null, reason: 'duplicate' };
    const entry = { id: `mem-${now}-${Math.random().toString(36).slice(2, 7)}`, text: clean, at: now, kind: 'note' };
    return { list: [...list, entry].slice(-50), entry, reason: null };
  }
  function forgetMemoryMatching(list, query) {
    const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { list, removed: [] };
    const removed = [], kept = [];
    for (const item of (Array.isArray(list) ? list : [])) {
      const text = String(item?.text ?? item ?? '').toLowerCase();
      if (tokens.every(token => text.includes(token))) removed.push(item);
      else kept.push(item);
    }
    return { list: kept, removed };
  }
  function searchHistory(history, query, limit = 6) {
    const tokens = String(query || '').toLowerCase().split(/\s+/).filter(token => token.length > 1);
    if (!tokens.length) return [];
    const rows = [];
    for (const item of (Array.isArray(history) ? history : [])) {
      const text = String(item?.text ?? item?.content ?? '').toLowerCase();
      if (!text) continue;
      let score = 0;
      for (const token of tokens) if (text.includes(token)) score += token.length > 4 ? 2 : 1;
      if (score) rows.push({ who: item.who || item.role || '', text: String(item.text ?? item.content ?? ''), at: Number(item.at) || 0, score });
    }
    rows.sort((a, b) => b.score - a.score || b.at - a.at);
    return rows.slice(0, Math.max(1, limit));
  }
  function historyForDay(history, startMs, endMs) {
    return (Array.isArray(history) ? history : []).filter(item => {
      const at = Number(item?.at) || 0;
      return at >= startMs && at < endMs;
    });
  }
  function summarizeMessages(messages, label = '') {
    const rows = Array.isArray(messages) ? messages : [];
    if (!rows.length) return '';
    const asks = rows.filter(item => item.who === 'YOU' || item.role === 'user').map(item => String(item.text ?? item.content ?? '').trim()).filter(Boolean);
    const parts = [`${label ? `${label}: ` : ''}${rows.length} message${rows.length === 1 ? '' : 's'}.`];
    if (asks.length) parts.push(`You asked about ${asks.slice(-3).map(text => `"${text.slice(0, 70)}"`).join(', ')}.`);
    else parts.push('Only JARVIS spoke during that stretch.');
    return parts.join(' ');
  }
  // Recall commands (Phase 4). Deterministic retrieval first; the model only
  // interprets when stored information needs to be woven into an answer.
  function parseMemoryCommand(input) {
    const text = stripPoliteLead(input).replace(/[?!.]+$/, '').trim();
    if (!text) return null;
    let match = text.match(/^(?:remember that|remember|note that|note)\s+(.+)$/i);
    if (match) return { kind: 'remember', text: match[1].trim() };
    match = text.match(/^forget (?:what i told you (?:about|regarding)|about|the (?:fact )?that)\s+(.+)$/i);
    if (match) return { kind: 'forget', query: match[1].trim() };
    if (/^forget (?:everything|all(?: of your)? memor(?:y|ies)|what you remember|my (?:memory|memories)|all stored (?:conversations|history)|conversation history)\b/i.test(text)) return { kind: 'forget-all' };
    match = text.match(/^(?:search|look in|check|go through) (?:our|your|the) (?:stored |saved |past |previous )?(?:conversations|conversation history|history|chats?|chat log)(?: for| about| containing| with)?\s+(.+)$/i);
    if (match) return { kind: 'search-history', query: match[1].trim() };
    if (/^(?:do you )?remember (?:what we |anything we )?(?:talked about|discussed) (?:yesterday|earlier|before|last time)\b/i.test(text)) return { kind: 'recall-yesterday' };
    if (/^(?:what did we (?:talk about|discuss) (?:yesterday|earlier)|what happened yesterday)\b/i.test(text)) return { kind: 'recall-yesterday' };
    if (/^what did i ask you to do last time$/i.test(text)) return { kind: 'recall-last-tasks' };
    if (/^(?:show (?:me )?)?what you (?:have )?(?:remembered|remember about me)|what do you remember about me$/i.test(text)) return { kind: 'show-memory' };
    if (/^continue (?:the |our )?(?:project|conversation|work)\b/i.test(text)) return { kind: 'continue-context' };
    match = text.match(/^(?:did i (?:ever )?(?:mention|talk about|say anything about|bring up)|have i (?:ever )?(?:mentioned|talked about)|did we (?:ever )?(?:talk about|discuss))\s+(.+)$/i);
    if (match && match[1].trim()) return { kind: 'did-mention', query: match[1].trim() };
    return null;
  }
  // "Research backyard chickens": deep-research mode (web search first, then a
  // longer, structured model answer). Distinct from a quick lookup question.
  function parseResearchCommand(input) {
    const text = stripPoliteLead(input).replace(/[.!?]+$/, '').replace(/\s+please$/i, '').trim();
    const match = text.match(/^(?:research|look into|dig into|do a deep dive into|deep dive into)\s+(.+)$/i);
    if (!match || !match[1].trim()) return null;
    return { query: match[1].trim().slice(0, 240) };
  }
  // "Did I mention X": searches saved notes first, then stored conversation,
  // and answers with quoted evidence. Vague queries get a clarification
  // question instead of a fabricated yes/no.
  function answerDidMention(query, notes = [], history = []) {
    const stopwords = new Set(['the', 'a', 'an', 'about', 'this', 'that', 'it', 'to', 'for', 'of', 'on', 'in', 'and', 'or', 'my', 'your', 'me', 'you', 'we', 'us', 'our', 'is', 'was', 'at', 'with', 'from']);
    const meaningful = String(query || '').toLowerCase().split(/\s+/).filter(token => token.length > 2 && !stopwords.has(token));
    if (!meaningful.length) return { found: false, reply: `What exactly should I look for, Sir? “${String(query || '').trim()}” is too vague to search your notes for.` };
    const noteHits = (Array.isArray(notes) ? notes : []).filter(entry => meaningful.every(token => String(entry?.text ?? entry ?? '').toLowerCase().includes(token))).slice(0, 2);
    const hits = searchHistory(history, meaningful.join(' '), 3).slice(0, 2);
    if (!noteHits.length && !hits.length) return { found: false, reply: `I do not have anything about “${String(query || '').trim()}” in your saved notes or our stored conversations, Sir.` };
    const parts = [];
    if (noteHits.length) parts.push(`your saved note${noteHits.length === 1 ? '' : 's'}: ${noteHits.map(entry => `“${String(entry?.text ?? entry ?? '').slice(0, 90)}”`).join('; ')}`);
    if (hits.length) parts.push(hits.map(hit => {
      const when = hit.at ? ` (${new Date(hit.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})` : '';
      return `you mentioned “${String(hit.text).slice(0, 90)}”${when}`;
    }).join('; '));
    return { found: true, reply: `Yes — ${parts.join('. ')}.` };
  }
  function buildRecall(history, summaries = [], query = '', limit = 6) {
    const rows = Array.isArray(history) ? history : [];
    // With a query only real keyword hits are returned (possibly none) so the
    // model never sees duplicated recent context. Without one ("continue where
    // we left off") the recent tail of the archive is used as background.
    const messages = query ? searchHistory(rows, query, limit) : rows.slice(-8);
    return { messages, summaries: (Array.isArray(summaries) ? summaries : []).slice(-3), searched: Boolean(query) && messages.length > 0 };
  }

  // =====================================================================
  // Structured calendar extraction (Ollama understanding engine).
  // The local model returns JSON; trusted code validates it here before any
  // calendar operation runs. Never execute unconstrained model text.
  // Schema:
  //   intent: create|list|get_next|update|reschedule|cancel|clarify
  //   title, date (YYYY-MM-DD or natural), start_time (HH:MM 24h or h:MM AM/PM),
  //   end_time/durationMinutes, timezone, location, reminderMinutes,
  //   missing_fields[], confidence 0..1, clarification_question, target_event
  // =====================================================================
  const CALENDAR_INTENTS = new Set(['create', 'list', 'get_next', 'update', 'reschedule', 'cancel', 'clarify']);
  function validateCalendarExtraction(data) {
    const errors = [];
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, errors: ['extraction must be an object'] };
    const out = {};
    const intent = String(data.intent || '').trim().toLowerCase();
    if (!CALENDAR_INTENTS.has(intent)) errors.push(`intent must be one of ${[...CALENDAR_INTENTS].join(', ')}`);
    else out.intent = intent;
    if (data.title !== undefined) {
      const t = String(data.title || '').trim().slice(0, 160);
      if (t) out.title = t;
    }
    if (data.date !== undefined && String(data.date || '').trim()) {
      const d = String(data.date).trim().slice(0, 60);
      // Accept YYYY-MM-DD or natural language; natural dates are resolved
      // deterministically later via parseNaturalDate.
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        const parsed = Date.parse(`${d}T00:00:00`);
        if (!Number.isFinite(parsed)) errors.push('date is not a valid YYYY-MM-DD');
        else out.date = d;
      } else if (d.length >= 3 && d.length <= 60) {
        out.date = d;
      } else errors.push('date is invalid');
    }
    const checkTime = (key) => {
      if (data[key] === undefined || String(data[key] || '').trim() === '') return;
      const raw = String(data[key]).trim().slice(0, 30);
      // Treat placeholders ("-", "n/a", "not specified") as missing, not errors.
      if (/^(?:-|n\/a|none|not specified|\(not specified\)|unknown)$/i.test(raw)) return;
      const parsed = parseNaturalTime(raw);
      if (!parsed || parsed.error) errors.push(`${key} is not a valid time: ${raw}`);
      else if (parsed.ambiguous) errors.push(`${key} is ambiguous without AM/PM: ${raw}`);
      else out[key] = formatTimeForStorage(parsed.hour, parsed.minute);
    };
    checkTime('start_time');
    checkTime('end_time');
    if (data.durationMinutes !== undefined && String(data.durationMinutes || '').trim() !== '') {
      const n = Number(data.durationMinutes);
      if (!Number.isFinite(n) || n <= 0 || n > 1440) errors.push('durationMinutes must be 1..1440');
      else out.durationMinutes = Math.round(n);
    }
    if (data.duration !== undefined && String(data.duration || '').trim() !== '' && out.durationMinutes === undefined) {
      const rawDur = String(data.duration).trim();
      const asNum = Number(rawDur);
      if (Number.isFinite(asNum) && asNum > 0 && asNum <= 1440) out.durationMinutes = Math.round(asNum);
      else {
        const hm = rawDur.match(/(\d+)\s*h(?:ours?)?(?:\s*(\d+)\s*m)?/i) || rawDur.match(/(\d+)\s*(?:min(?:utes?)?|m)\b/i);
        if (hm) {
          const mins = hm[2] !== undefined && /h/i.test(rawDur) ? Number(hm[1]) * 60 + Number(hm[2] || 0) : Number(hm[1]);
          if (Number.isFinite(mins) && mins > 0 && mins <= 1440) out.durationMinutes = Math.round(mins);
          else errors.push('duration is invalid');
        } else errors.push('duration is invalid');
      }
    }
    if (data.timezone !== undefined && String(data.timezone || '').trim()) {
      out.timezone = String(data.timezone).trim().slice(0, 60);
    } else {
      out.timezone = CALENDAR_TIMEZONE;
    }
    if (data.location !== undefined && String(data.location || '').trim()) {
      const loc = String(data.location).trim().slice(0, 160);
      // Drop placeholders and invented generic rooms ("study room" for homework
      // was never stated). Genuine locations survive; absence stays absent.
      if (!/^(?:-|n\/a|none|not specified|\(not specified\)|unknown|study room)$/i.test(loc)) {
        out.location = loc;
      }
    }
    if (data.reminderMinutes !== undefined && String(data.reminderMinutes || '').trim() !== '') {
      const r = Number(data.reminderMinutes);
      if (!Number.isFinite(r) || r < 0 || r > 1440) errors.push('reminderMinutes must be 0..1440');
      else out.reminderMinutes = Math.round(r);
    }
    if (data.reminder_settings !== undefined && data.reminder_settings !== null) {
      const rs = data.reminder_settings;
      if (typeof rs === 'object' && !Array.isArray(rs)) {
        if (rs.reminderMinutes !== undefined) {
          const r = Number(rs.reminderMinutes);
          if (!Number.isFinite(r) || r < 0 || r > 1440) errors.push('reminder_settings.reminderMinutes must be 0..1440');
          else out.reminderMinutes = Math.round(r);
        }
      }
    }
    if (data.missing_fields !== undefined) {
      if (!Array.isArray(data.missing_fields)) errors.push('missing_fields must be an array');
      else {
        const allowed = new Set(['title', 'date', 'start_time', 'end_time', 'target_event']);
        out.missing_fields = data.missing_fields.map(f => String(f || '').trim()).filter(Boolean).slice(0, 5);
        for (const f of out.missing_fields) if (!allowed.has(f)) errors.push(`missing_fields contains unknown field: ${f}`);
      }
    } else {
      out.missing_fields = [];
    }
    if (data.confidence !== undefined) {
      const c = Number(data.confidence);
      if (!Number.isFinite(c) || c < 0 || c > 1) errors.push('confidence must be 0..1');
      else out.confidence = c;
    } else {
      out.confidence = 0.5;
    }
    if (data.clarification_question !== undefined && String(data.clarification_question || '').trim()) {
      out.clarification_question = String(data.clarification_question).trim().slice(0, 300);
    }
    if (data.target_event !== undefined && String(data.target_event || '').trim()) {
      out.target_event = String(data.target_event).trim().slice(0, 160);
    }
    // Intent-specific requirements: create needs title+date+time (or declare
    // them missing); reschedule/update needs target + new time; cancel needs target.
    if (out.intent === 'create') {
      const need = [];
      if (!out.title) need.push('title');
      if (!out.date) need.push('date');
      if (!out.start_time) need.push('start_time');
      // If the model claims complete but fields are absent, force missing_fields.
      if (need.length && (!out.missing_fields || !out.missing_fields.length)) out.missing_fields = need;
    }
    if ((out.intent === 'reschedule' || out.intent === 'update') && !out.target_event && !out.title) {
      if (!out.missing_fields.includes('target_event')) out.missing_fields.push('target_event');
    }
    if (out.intent === 'cancel' && !out.target_event) {
      if (!out.missing_fields.includes('target_event')) out.missing_fields.push('target_event');
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, data: out };
  }
  // Resolve a validated extraction's date+time into a local Date using
  // deterministic parsing only (never trust model-computed timestamps).
  function resolveCalendarDateTime(dateStr, timeStr, now = new Date()) {
    const date = parseNaturalDate(String(dateStr || 'today'), now);
    if (!date) return null;
    // YYYY-MM-DD from the model: set explicitly in local time.
    const isoDate = String(dateStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDate) {
      date.setFullYear(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]));
    }
    const time = parseNaturalTime(String(timeStr || ''));
    if (!time || time.error || time.ambiguous) return null;
    date.setHours(time.hour, time.minute, 0, 0);
    return date;
  }

  // ============================================================
  // VOICE PIPELINE 2.0 — contextual correction + confidence policy.
  // Pure functions (no DOM, no network) so node tests and the browser UI
  // share the exact same correction behavior. The pipeline order is:
  // RAW ASR -> normalize -> deterministic candidates -> guarded correction
  // -> confidence policy -> existing command router. The raw transcript is
  // always preserved; correction never invents commands, and time/date,
  // negation, numbers, and recipients are never rewritten by a rule.
  // Each rule carries an intent guard: a replacement only fires when the
  // surrounding command context actually supports it, so "Friday" (a weekday)
  // is never rewritten to "Frieren" (anime) in a calendar sentence, and
  // "lower the volume" is never rewritten to "Loverboy" (a title).
  // ============================================================
  function voiceAudioQuality({ peak = 0, rms = 0, clipRatio = 0, durationMs = 0 } = {}) {
    const flags = [];
    if (!(durationMs > 0)) flags.push('no-audio');
    if (peak < 0.02) flags.push('too-quiet');
    if (clipRatio > 0.01) flags.push('clipping');
    if (rms < 0.005 && peak < 0.05) flags.push('near-silence');
    return { peak, rms, clipRatio, durationMs, flags,
      ok: flags.length === 0,
      summary: flags.length ? flags.join(', ') : 'signal-ok' };
  }
  // Small phonetic similarity (0..1) used to rank correction candidates.
  // Combines normalized edit distance with a consonant-skeleton match so
  // "fry day" scores close to "frieren" while unrelated words do not.
  function voicePhoneticSimilarity(a, b) {
    const x = String(a || '').toLowerCase().replace(/[^a-z]/g, '');
    const y = String(b || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!x || !y) return 0;
    if (x === y) return 1;
    const skeleton = s => s.replace(/[aeiouy]/g, '');
    const sx = skeleton(x), sy = skeleton(y);
    const dist = editDistance(x, y);
    const base = 1 - dist / Math.max(x.length, y.length);
    const skelBonus = sx && sx === sy ? 0.15 : 0;
    return Math.max(0, Math.min(1, base + skelBonus));
  }
  const VOICE_COMMAND_HINT = /(?:open|play|search|find|look up|google|watch|put on|queue|start|launch|show me|pull up|bring up)\b/i;
  const VOICE_VOLUME_HINT = /\bvolume\b/i;
  const VOICE_WEEKDAY_HINT = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|week|meeting|appointment|calendar|remind|alarm)\b/i;
  const VOICE_GAME_HINT = /\b(?:open|play|launch|game|roblox|minecraft|steam)\b/i;
  // Guarded deterministic rules. `when` receives the normalized sentence and
  // must return true for the replacement to apply.
  const VOICE_CORRECTION_RULES = [
    { from: /\bfry\s*day\b/g, to: 'Frieren',
      when: t => VOICE_COMMAND_HINT.test(t) && !VOICE_WEEKDAY_HINT.test(t),
      reason: 'search/media context favors the title Frieren over the weekday' },
    { from: /\bfriday\b/g, to: 'Frieren',
      when: t => /(?:search|look up|find|play|watch|open)\b[^.]*\bfriday\b/i.test(t) && !VOICE_WEEKDAY_HINT.test(t.replace(/\bfriday\b/i, '')),
      reason: 'proper-noun query context favors Frieren; weekday context keeps Friday' },
    { from: /\blower\s*boy\b/g, to: 'Loverboy',
      when: t => VOICE_COMMAND_HINT.test(t) && !VOICE_VOLUME_HINT.test(t),
      reason: 'media/open context favors the title Loverboy; volume commands are untouched' },
    { from: /\brow\s*blocks?\b|\broad\s*blocks?\b|\bro\s*blocks\b/g, to: 'Roblox',
      when: t => VOICE_GAME_HINT.test(t),
      reason: 'gaming context favors Roblox' },
    { from: /\byou\s*tube\b|\byoutub\b|\butube\b/g, to: 'YouTube',
      when: () => true, reason: 'known service name' },
    { from: /\bdiscord\b/i, to: 'Discord', when: () => false, reason: 'reserved (casing only, handled by router)' },
    { from: /\bmagnetick\b|\bmagnatic\b/g, to: 'Magnetic',
      when: t => /\b(?:song|music|play|illit)\b/i.test(t),
      reason: 'music context favors the song Magnetic' },
    { from: /\bharvis\b|\bjarvish\b|\bjarvice\b/g, to: 'Jarvis',
      when: t => /^\s*(?:hey|hi|hello|okay|yo)?\s*(?:harvis|jarvish|jarvice)\b/i.test(t),
      reason: 'utterance-start wake-word mishearing' },
  ];
  function voiceBuildCandidates(normalized) {
    const out = [];
    for (const rule of VOICE_CORRECTION_RULES) {
      const sample = rule.from.source.slice(0, 40);
      if (rule.from.global) rule.from.lastIndex = 0;
      if (rule.from.test(normalized)) out.push({ pattern: sample, replacement: rule.to, reason: rule.reason });
      if (rule.from.global) rule.from.lastIndex = 0;
    }
    return out;
  }
  // Guarded phonetic fallback for mishearings the regex rules never saw
  // (e.g. synthetic-voice test produced "priren" for Frieren). Fires ONLY when
  // ALL hold: command context (open/play/search), token length >= 5, token is
  // not a common English word, similarity >= 0.65 to exactly one known entity,
  // and weekday/volume guards pass. Never touches negation, dates, or numbers
  // (tokens with digits are skipped).
  const VOICE_KNOWN_ENTITIES = ['Frieren', 'Loverboy', 'Roblox', 'YouTube', 'Magnetic', 'Discord', 'Google', 'Gmail', 'Minecraft', 'Spotify', 'Steam', 'ILLIT'];
  const VOICE_COMMON_WORDS = new Set(('the,a,an,and,or,but,for,with,from,that,this,these,those,search,open,play,find,look,volume,friday,monday,tuesday,wednesday,thursday,saturday,sunday,today,tomorrow,meeting,reminder,alarm,music,song,video,please,could,would,printer,paper,lower,under,over,before,after,about,which,while,there,their,house,mouse,printer,player,paper').split(','));
  function voicePhoneticEntityFix(sentence) {
    // Command context required; weekday sentences stay untouched so a real
    // "Friday" is never rewritten (regex rules already handle the
    // search-context "Friday"->Frieren case explicitly).
    if (!VOICE_COMMAND_HINT.test(sentence)) return { text: sentence, applied: [] };
    if (VOICE_WEEKDAY_HINT.test(sentence) && !/(?:search|play|watch)\b/i.test(sentence)) return { text: sentence, applied: [] };
    const applied = [];
    const out = sentence.replace(/\b[a-z][a-z'-]{4,}\b/gi, token => {
      const lower = token.toLowerCase();
      if (VOICE_COMMON_WORDS.has(lower) || /\d/.test(token)) return token;
      if (VOICE_KNOWN_ENTITIES.some(e => e.toLowerCase() === lower)) return token;
      let best = '', bestScore = 0;
      for (const entity of VOICE_KNOWN_ENTITIES) {
        const s = voicePhoneticSimilarity(lower, entity.toLowerCase());
        if (s > bestScore) { bestScore = s; best = entity; }
      }
      if (best && bestScore >= 0.65) {
        // Volume guard: never "fix" anything in a volume command to Loverboy.
        if (best === 'Loverboy' && VOICE_VOLUME_HINT.test(sentence)) return token;
        applied.push({ from: token, to: best, reason: `phonetic entity match (${Math.round(bestScore * 100)}% similar)` });
        return best;
      }
      return token;
    });
    return { text: out, applied };
  }
  // Deterministic correction: applies only guarded rules, preserves negation,
  // numbers, dates, and recipients, and reports every change for diagnostics.
  function voiceDeterministicCorrection(rawTranscript) {
    const raw = String(rawTranscript || '');
    const deFilled = raw.replace(/^(?:(?:um+|uh+|ugh+|ah+|er+|eh+|erm+|hmm+|mm+|hm+|well|so|like|okay|right|hey|hi)\b[\s,.!?-]+)+/i, '').trim() || raw;
    const normalized = typeof normalizeConversationText === 'function' ? normalizeConversationText(deFilled) : deFilled.toLowerCase();
    let corrected = normalized;
    const applied = [];
    for (const rule of VOICE_CORRECTION_RULES) {
      if (!rule.when(normalized)) continue;
      const before = corrected;
      corrected = corrected.replace(rule.from, rule.to);
      if (corrected !== before) applied.push({ from: rule.from.source.slice(0, 48), to: rule.to, reason: rule.reason });
      if (rule.from.global) rule.from.lastIndex = 0;
    }
    // Phonetic fallback for unseen mishearings (runs after the explicit
    // rules so exact patterns always win over similarity guesses).
    try {
      const phonetic = voicePhoneticEntityFix(corrected);
      if (phonetic.text !== corrected) { corrected = phonetic.text; for (const a of phonetic.applied) applied.push(a); }
    } catch {}
    // Restore sentence-case for display without changing meaning.
    const display = corrected ? corrected.charAt(0).toUpperCase() + corrected.slice(1) : corrected;
    return { rawTranscript: raw, normalizedTranscript: normalized, correctedTranscript: display,
      candidates: voiceBuildCandidates(normalized), applied, changed: applied.length > 0 };
  }
  // =====================================================================
  // YouTube creator vocabulary + correction (2026-10-14). An editable
  // creator-vocab.json (loaded via setCreatorVocab) maps canonical creator
  // names to aliases, transcription mistakes, and pronunciation hints.
  // correctCreatorQuery rewrites ONLY inside search/media command context;
  // ordinary conversation, wake words, and follow-ups are never touched.
  // Phrases (e.g. "thanks for watching") are a separate category and can
  // never become creator names. Raw text is always preserved for
  // diagnostics; the normalized query travels separately.
  // =====================================================================
  const CREATOR_SEARCH_HINT = /(?:search|find|look\s*up|lookup|show|watch|open|play)\b/i;
  const CREATOR_VERB_LEAD = /^(?:search(?: for| up)?|find|look\s*up|lookup|show(?: me)?|watch|open)\b/i;
  let creatorVocab = { creators: [], phrases: [] };
  function setCreatorVocab(data) {
    const creators = [], phrases = [];
    const list = data && Array.isArray(data.creators) ? data.creators : [];
    for (const entry of list) {
      const canonical = String((entry && entry.canonical) || '').trim();
      if (!canonical) continue;
      const aliases = [...new Set((Array.isArray(entry.aliases) ? entry.aliases : []).map(a => String(a || '').trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
      if (!aliases.length) continue;
      creators.push({ canonical, aliases, verifiedUrl: String((entry && entry.verifiedUrl) || '').trim() });
    }
    const plist = data && Array.isArray(data.phrases) ? data.phrases : [];
    for (const entry of plist) {
      const phrase = String((entry && entry.phrase) || '').trim();
      if (!phrase) continue;
      const aliases = [...new Set([phrase, ...((Array.isArray(entry.aliases) ? entry.aliases : []).map(a => String(a || '').trim()).filter(Boolean))])].sort((a, b) => b.length - a.length);
      phrases.push({ phrase, aliases });
    }
    creatorVocab = { creators, phrases };
    return { creators: creators.length, phrases: phrases.length };
  }
  function creatorAliasMatch(text, alias) {
    const t = String(text || '');
    const a = String(alias || '').trim();
    if (!a) return -1;
    if (/[^\x00-\x7F]/.test(a)) return t.toLowerCase().indexOf(a.toLowerCase());
    const hit = t.toLowerCase().search(new RegExp(`(?<![a-z0-9])${a.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`));
    return hit;
  }
  // Longest-alias match wins so "z bing z" beats "z" fragments. Returns
  // { entry, alias, index } or null. Phrases are matched separately and
  // never returned as creators.
  function findCreatorMatch(text, extra = []) {
    const all = [...creatorVocab.creators, ...(Array.isArray(extra) ? extra : [])];
    let best = null;
    for (const entry of all) {
      for (const alias of (entry.aliases || [])) {
        const index = creatorAliasMatch(text, alias);
        if (index >= 0 && (!best || alias.length > best.alias.length)) best = { entry, alias, index };
      }
    }
    return best;
  }
  function matchKnownPhrase(text) {
    let best = null;
    for (const entry of creatorVocab.phrases) {
      for (const alias of (entry.aliases || [])) {
        const index = creatorAliasMatch(text, alias);
        if (index >= 0 && (!best || alias.length > best.alias.length)) best = { entry, alias, index };
      }
    }
    return best;
  }
  // Rewrite a creator alias to its canonical spelling inside search/media
  // commands. Returns { text, query, changed, hasCreator, applied,
  // confidence }. query is the normalized search string; text keeps the
  // command shape with the canonical name in place.
  function correctCreatorQuery(input, { learned = [] } = {}) {
    const original = String(input || '');
    const out = { text: original, query: '', changed: false, hasCreator: false, applied: [], confidence: 0 };
    if (!original || !CREATOR_SEARCH_HINT.test(original)) return out;
    // Never rewrite the wake-word lead-in itself.
    const lead = stripPoliteLead(original);
    const match = findCreatorMatch(lead, learned);
    if (!match) return out;
    if (match.entry.canonical.toLowerCase() === match.alias.toLowerCase()) {
      out.hasCreator = true; out.confidence = 0.95;
      out.query = lead;
      return out;
    }
    const before = lead;
    const fixed = lead.slice(0, match.index) + match.entry.canonical + lead.slice(match.index + match.alias.length);
    if (fixed !== before) {
      out.text = original.replace(before, fixed);
      out.query = fixed;
      out.changed = true;
      out.hasCreator = true;
      out.confidence = match.alias.includes(' ') ? 0.95 : 0.9;
      out.applied.push({ from: match.alias, to: match.entry.canonical, reason: 'creator vocabulary alias' });
    }
    return out;
  }
  // Natural creator-search variations. Returns null when no creator-search
  // shape is present. { name, topic, officialOnly, similar } — name may be
  // '' for nameless "channels like these" (caller clarifies, never guesses).
  function extractCreatorSearch(input) {
    const text = String(input || '').trim();
    if (!text) return null;
    const lead = stripPoliteLead(text).replace(/[.!?]+$/, '').trim();
    if (!lead) return null;
    const cleanTail = s => String(s || '').trim()
      .replace(/\s+(?:on\s+)?youtube(?:\s+music)?(?:\s+channel)?$/i, '')
      .replace(/\s+(?:channel|videos?|clips?)$/i, '')
      .replace(/^(?:the\s+|a\s+|an\s+)/i, '').trim().slice(0, 80);
    let m;
    if ((m = lead.match(/^(?:find|show|get)\s+(?:the\s+)?official\s+(?:youtube\s+)?channel\s+(?:for\s+|of\s+)?(.+)$/i))
      || (m = lead.match(/^(?:find|show)\s+(?:the\s+)?official\s+(.+?)\s+channel$/i))) {
      return { name: cleanTail(m[1]), topic: '', officialOnly: true, similar: false };
    }
    if ((m = lead.match(/^(?:find|show(?:\s+me)?|open)\s+(?:the\s+)?(?:youtube\s+)?channel\s+(.+)$/i))) {
      return { name: cleanTail(m[1]), topic: '', officialOnly: false, similar: false };
    }
    if ((m = lead.match(/^open\s+(.+?)'s\s+channel$/i))) {
      return { name: cleanTail(m[1]), topic: '', officialOnly: false, similar: false };
    }
    if ((m = lead.match(/^open\s+(.+?)\s+channel$/i))) {
      const name = cleanTail(m[1]);
      if (name && !/^(?:youtube|new|another)$/i.test(name)) return { name, topic: '', officialOnly: false, similar: false };
    }
    if ((m = lead.match(/^(?:show(?:\s+me)?|find)\s+(?:videos?\s+)?(?:by|from)\s+(.+?)(?:\s+about\s+(.+))?$/i))) {
      return { name: cleanTail(m[1]), topic: cleanTail(m[2] || ''), officialOnly: false, similar: false };
    }
    if ((m = lead.match(/^look\s*up\s+(.+)$/i))) {
      return { name: cleanTail(m[1]), topic: '', officialOnly: false, similar: false };
    }
    if ((m = lead.match(/^(?:find|search)(?:\s+for)?\s+(?:more\s+|other\s+)?(?:youtube\s+)?channels?\s+like\s+(.+)$/i))) {
      const name = cleanTail(m[1].replace(/^(?:these|those|them)$/i, ''));
      return { name, topic: '', officialOnly: false, similar: true };
    }
    if ((m = lead.match(/^(?:search|find)\s+(.+?)\s+and\s+(.+)$/i))) {
      return { name: cleanTail(m[1]), topic: cleanTail(m[2]), officialOnly: false, similar: false };
    }
    return null;
  }

  // Confidence policy shared by UI and tests. `asr` is the structured server
  // result above. Returns one of: proceed | correct-and-proceed | clarify.
  function voiceConfidencePolicy({ asrConfidence = null, noSpeechProb = null, correctionChanged = false, qualityFlags = [] } = {}) {
    if (qualityFlags.includes('no-audio') || qualityFlags.includes('near-silence')) return { decision: 'clarify', reason: 'no usable audio captured' };
    if (Number.isFinite(Number(noSpeechProb)) && Number(noSpeechProb) > 0.85) return { decision: 'clarify', reason: 'recognizer reports no speech in this audio' };
    if (Number.isFinite(Number(asrConfidence))) {
      if (asrConfidence >= 0.75 && !correctionChanged) return { decision: 'proceed', reason: 'high recognizer confidence, no correction needed' };
      if (asrConfidence >= 0.75) return { decision: 'correct-and-proceed', reason: 'high confidence with a guarded proper-noun fix' };
      if (asrConfidence >= 0.45) return { decision: 'correct-and-proceed', reason: 'moderate confidence; guarded correction applied' };
      return { decision: 'clarify', reason: 'low recognizer confidence; ask for the uncertain part' };
    }
    // No confidence signal (plain-text fallback): trust guarded rules only.
    if (correctionChanged) return { decision: 'correct-and-proceed', reason: 'no confidence signal; one guarded fix applied' };
    return { decision: 'proceed', reason: 'no confidence signal; transcript passed through unchanged' };
  }
  // One-call structured correction: deterministic first, then (optionally) a
  // single Ollama pass whose JSON is validated. Never throws; falls back to
  // the deterministic result so voice keeps working offline.
  function voiceCorrectTranscript(rawTranscript, { asrConfidence = null, noSpeechProb = null, qualityFlags = [], ollama = null } = {}) {
    const det = voiceDeterministicCorrection(rawTranscript);
    const policy = voiceConfidencePolicy({ asrConfidence, noSpeechProb, correctionChanged: det.changed, qualityFlags });
    const out = { rawTranscript: det.rawTranscript, normalizedTranscript: det.normalizedTranscript,
      correctedTranscript: det.correctedTranscript, language: 'en', detectedIntent: '', recognizedEntities: [],
      candidateAlternatives: det.candidates, confidence: Number.isFinite(Number(asrConfidence)) ? Number(asrConfidence) : null,
      correctionReason: det.applied.length ? det.applied.map(a => `${a.to} (${a.reason})`).join('; ') : 'no correction applied',
      requiresClarification: policy.decision === 'clarify', policy: policy.decision, policyReason: policy.reason,
      appliedRules: det.applied, ollamaUsed: false };
    if (ollama && typeof ollama === 'object' && ollama.corrected) out.ollamaUsed = true;
    return out;
  }

  // WAKE-WORD 2026-10-14 (additive, no behavior change to existing callers):
  // Optional openWakeWord "hey_jarvis" sidecar config + a pure combiner so a
  // frame-level OWW score can EARLY-HINT the existing Whisper text decision
  // without ever replacing it. Whisper text always decides commands; OWW can
  // only add evidence. Threshold default 0.5 per openWakeWord docs; tune with
  // measured tests, never by lowering until everything triggers.
  // Licenses: openWakeWord code Apache-2.0; pre-trained models (incl.
  // hey_jarvis_v0.1) CC BY-NC-SA 4.0. Inference stays local/offline/free.
  const WAKEWORD_OWW_CONFIG = {
    engine: 'openWakeWord-hey_jarvis (optional sidecar)',
    model: 'hey_jarvis_v0.1',
    frameMs: 80, frameSamples16k: 1280, sampleRate: 16000,
    defaultThreshold: 0.5, codeLicense: 'Apache-2.0', modelLicense: 'CC BY-NC-SA 4.0',
    offline: true,
  };
  // Combine an optional frame score (0..1, or null when sidecar absent) with
  // the existing text wake parse. Pure and side-effect free.
  // - score null/NaN: returns the text decision unchanged (pipeline unchanged).
  // - score >= threshold with cooldown ok: boosts a 0.6 anywhere-match to the
  //   0.9 start-match band for the EARLY gate only; never creates activation
  //   from silence and never overrides echo/contamination guards (caller owns
  //   those via decideVoiceAction).
  function wakeWordWithOwwScore(wake, score, { threshold = WAKEWORD_OWW_CONFIG.defaultThreshold, now = Date.now(), lastAt = 0, cooldownMs = 2500 } = {}) {
    const base = wake || { activated: false, confidence: 0, match: '', command: '', transcript: '' };
    const s = Number(score);
    if (!Number.isFinite(s)) return { ...base, owwScore: null, owwBoosted: false };
    const clamped = Math.max(0, Math.min(1, s));
    const cooled = !lastAt || (now - lastAt >= cooldownMs);
    const boosted = base.activated && (base.confidence || 0) >= 0.6 && (base.confidence || 0) < 0.9
      && clamped >= threshold && cooled;
    return {
      ...base,
      owwScore: clamped,
      owwBoosted: boosted,
      confidence: boosted ? 0.9 : base.confidence,
    };
  }

  // =====================================================================
  // Camera vs screen intent routing (2026-10-14). Centralized deterministic
  // layer connecting natural spoken requests to the EXISTING handlers:
  // webcam questions -> window.JarvisCamera.ask (same as ASK buttons),
  // screen questions -> localAction screen-describe (same as screen card).
  // Pure and unit-testable. Returns null when the utterance is not a
  // camera/screen question so ordinary conversation never matches.
  // - Screen requires explicit screen/monitor/display/screenshot words (or an
  //   error/page/app-open phrasing that implies the display). A bare
  //   "what am I looking at?" is a CAMERA question, never screen.
  // - Camera requires a deictic anchor (this/that/it/holding/camera/view/
  //   scene/frame/front of me/looking at) or an explicit camera noun, plus a
  //   camera verb/question shape. Contractions and case are normalized.
  // - `fullText` (unstripped) is checked for screen words so "describe the
  //   scene on my screen" still routes to screen even after lead stripping.
  // =====================================================================
  const CAMERA_SCREEN_WORDS = /\bscreen\b|\bmonitor\b|\bdisplay\b|\bscreenshot\b/i;
  function parseScreenIntent(lead, fullText = '') {
    const text = String(lead || '').trim();
    if (!text) return null;
    if (!CAMERA_SCREEN_WORDS.test(text) && !CAMERA_SCREEN_WORDS.test(String(fullText || ''))) {
      // Implied-display phrasings: error/page/app-open questions refer to
      // what is visibly on screen even without the word "screen".
      if (!/what does this (?:error|page) (?:mean|say|show)|(?:what|which) (?:app|window|program|site|page) is (?:open|on)/i.test(text)) return null;
    }
    const screenRe = /(?:what(?:'s| is) (?:on|shown? (?:on|in)) (?:my|the) (?:screen|monitor|current display)(?: right now)?|what am i (?:looking at|seeing) (?:on (?:my|the) (?:screen|monitor|display))|what (?:do|can|are) you see(?:ing)? (?:on (?:my|the) (?:screen|monitor|display))|read (?:the )?(?:text|contents|error) (?:on|from) (?:my|the) screen|(?:explain|describe) (?:what(?:'s| is) )?(?:on )?(?:my |the )?screen|look at (?:my|the) screen|can you see (?:my|the) screen|what does this (?:error|page) (?:mean|say|show)|(?:see|analyze|check|inspect|show me) (?:my|the) (?:screen|monitor|display)|(?:what|which) (?:app|window|program|site|page) is (?:open(?: on)?|on) (?:my|the) (?:screen|display))/i;
    return screenRe.test(text) ? { kind: 'screen' } : null;
  }
  function parseCameraIntent(lead, fullText = '') {
    const text = String(lead || '').trim();
    if (!text) return null;
    const raw = String(fullText || text);
    // Screen words always win: never route a screen question to the webcam.
    if (CAMERA_SCREEN_WORDS.test(raw)) return null;
    const t = text.replace(/[''ʼ]/g, "'").toLowerCase();
    // Anaphoric follow-ups ("describe it in more detail", bare "in more
    // detail", "tell me more") are only meaningful against a recent frame.
    // They carry no anchor, so they are carved out BEFORE the anchor guard.
    // The caller still gates on a recent frame, so ordinary conversation is
    // never hijacked: without one these fall through to the normal pipeline.
    if (/^(?:in more detail|more details?|tell me more(?: about it)?|describe it in more detail)(?:[,.?!].*)?$/i.test(t)) return { kind: 'camera-follow', mode: 'identify' };
    // Anchor guard: without something visibly referenced, this is ordinary
    // conversation (e.g. "describe your day", "how does this algorithm
    // work" is still camera-anchored via "this" + how-does-work — handled
    // below only with the exact work/use phrasing, never bare "explain X").
    const hasAnchor = /\bthis\b|\bthat\b|\bit\b|\bholding\b|\bshowing\b|\bcamera\b|\bwebcam\b|\bview\b|\bscene\b|\bframe\b|\bfront of me\b|\blooking at\b|\bseeing\b|\bthese\b|\btwo\b/i.test(t);
    if (!hasAnchor) return null;
    const hit = (re) => re.test(t);
    // Order: most specific first. Each returns the existing camera mode used
    // by the ASK buttons (identify/scene/readtext/explain/compare).
    if (hit(/^(?:what am i (?:holding|showing)|what(?:'s| is) (?:this|that)(?: (?:object|thing|product))?|identify (?:this|that|the)(?: (?:object|thing|product))?|what is (?:that small \w+ )?in (?:my hands|front of me)|name (?:this|that)(?: (?:object|thing))?)/)
      || hit(/identify (?:that|this)(?: (?:object|product|thing))?/)) return { kind: 'camera', mode: 'identify' };
    if (hit(/read (?:this|it|that)|read (?:the )?(?:label|labels|text|markings?)(?: (?:for|to) me)?/)) return { kind: 'camera', mode: 'readtext' };
    if (hit(/compare (?:these|the two)|difference between (?:these|the two)/)) return { kind: 'camera', mode: 'compare' };
    if (hit(/how does (?:this|it|that) work|how do i (?:use|open|clean|hold|operate) (?:this|it|that)|what can i (?:use (?:this|it|that) for|do with (?:this|it|that))|what(?:'s| is) (?:this|it|that) made (?:of|from)|is (?:there )?(?:anything )?wrong with (?:this|it|that)|give me instructions for using this|explain how (?:this|it|that) works?/)) return { kind: 'camera', mode: 'explain' };
    if (hit(/describe the scene|describe everything (?:you can see|that you see)|describe (?:what(?:'s| is) )?in front of me|describe (?:the )?(?:camera )?view|what am i (?:looking at|seeing)|what(?:'s| is) in front of me|what (?:do|can|are) you see(?:ing)?/)) return { kind: 'camera', mode: 'scene' };
    if (hit(/analyz[es] (?:the )?(?:camera|webcam)(?: (?:view|feed|frame))?|take (?:a )?frame and analyz|check (?:the )?(?:camera|webcam)|look (?:through|at) (?:the )?(?:camera|webcam)/)) return { kind: 'camera', mode: 'identify' };
    // Anaphoric follow-ups ("describe it in more detail", "how does it
    // work", "read it", "what about it"): camera-follow when a recent frame
    // exists; the caller falls back to a fresh capture otherwise.
    if (hit(/^(?:describe it(?: in more detail)?|in more detail|tell me more about it|how does it work|what about (?:it|that|this)|read it|zoom in on (?:it|that)|focus on (?:it|that))(?:[,.?!].*)?$/)) return { kind: 'camera-follow', mode: 'identify' };
    return null;
  }

  // RESPONSE ENVELOPE + ANSWER QUALITY (2026-10-14)
  // One shared definition of "this model output is not a user-facing answer",
  // used by the server (retry decision) AND the client (delivery gate) so the
  // two can never disagree. Pure and side-effect free.
  //
  // Background: a small local model sometimes returns the structured response
  // CONTRACT itself instead of an answer — and when it runs out of tokens
  // mid-object, that truncated envelope no longer parses, so the raw JSON used
  // to fall through to the chat UI. These helpers recover the user-facing text
  // from a known schema and reject answers that merely echo the request.
  const RESPONSE_ENVELOPE_KEYS = ['response_text', 'speech_text', 'emotion', 'emotion_intensity', 'speaking_style', 'speaking_rate', 'pause_hints', 'pronunciation_hints'];
  const RESPONSE_ENVELOPE_KEY_RE = new RegExp(`"?\\b(${RESPONSE_ENVELOPE_KEYS.join('|')})"?\\s*:`);

  // True when the text is (or begins) a structured response envelope rather
  // than prose. Requires BOTH a JSON/fence opening AND a known contract key,
  // so ordinary answers that merely mention a word like "response" or that
  // start with a brace for another reason are never misclassified.
  function looksLikeResponseEnvelope(text) {
    const s = String(text || '').trim();
    if (!s) return false;
    const fence = s.match(/^```(?:json)?\s*([\s\S]*)/i);
    const body = fence ? fence[1] : s;
    if (!/^[[{]/.test(body) && !new RegExp('^(' + RESPONSE_ENVELOPE_KEYS.join('|') + ')\\s*:', 'i').test(body)) return false;
    return RESPONSE_ENVELOPE_KEY_RE.test(body);
  }

  // Recover the user-facing answer from a response envelope. Prefers a real
  // JSON.parse of the complete object; falls back to reading the single
  // `response_text` string value out of a TRUNCATED envelope (a model that ran
  // out of tokens part-way through the object). Returns '' when nothing
  // user-facing can be recovered — never returns the raw envelope, and never
  // strips braces blindly.
  function recoverEnvelopeText(text) {
    const s = String(text || '').trim();
    if (!looksLikeResponseEnvelope(s)) return '';
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [];
    if (fence) candidates.push(fence[1].trim());
    candidates.push(s);
    const first = s.indexOf('{'), last = s.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(s.slice(first, last + 1));
    for (const candidate of candidates) {
      try {
        const obj = JSON.parse(candidate);
        if (obj && typeof obj === 'object' && typeof obj.response_text === 'string' && obj.response_text.trim()) return obj.response_text.trim();
      } catch {}
    }
    const colonQuoted = s.match(/response_text\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    if (colonQuoted && colonQuoted[1].trim()) return colonQuoted[1].trim();
    const colonPlain = s.match(/response_text\s*:\s*([^,\n]+?)(?=\s+(?:speech_text|emotion|speaking_rate|pause_hints|pronunciation_hints)\s*:|$)/i);
    if (colonPlain && colonPlain[1].trim()) return colonPlain[1].trim().replace(/^["']|["']$/g, '');
    // Truncated envelope: the value may be cut off mid-string, so the closing
    // quote is optional — the model simply ran out of tokens inside the object.
    const field = s.match(/"response_text"\s*:\s*"((?:[^"\\]|\\.)*)"?/);
    if (field) {
      try {
        const value = JSON.parse(`"${field[1]}"`);
        if (typeof value === 'string' && value.trim()) return value.trim();
      } catch {
        const value = field[1].replace(/\\[nrt]/g, ' ').replace(/\\"/g, '"').trim();
        if (value) return value;
      }
    }
    return '';
  }

  // Comparison tokens for echo detection. Function words, fillers and the
  // wake word/call name are dropped from BOTH sides so "Hey Jarvis, what
  // should I do this afternoon?" and "Jarvis, what should I do this
  // afternoon?" compare equal while real content words still count.
  const ECHO_STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'about', 'from', 'by', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'he', 'she', 'it', 'its', 'we', 'us', 'our', 'they', 'them', 'their', 'this', 'that', 'these', 'those', 'there', 'here', 'what', 'whats', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'please', 'thanks', 'thank', 'ok', 'okay', 'hey', 'hi', 'hello', 'jarvis', 'sir', 'madam', 'just', 'now', 'really', 'very', 'some', 'any', 'all', 'up', 'out', 'so', 'not', 'no', 'yes', 'yeah', 'yep', 'sup', 'tell', 'say', 'said', 'give', 'show', 'make', 'want', 'need', 'like', 'know', 'think', 'let', 'lets', 'us', 'get', 'got', 'going', 'go', 'do']);

  function echoTokens(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word && !ECHO_STOPWORDS.has(word));
  }

  // Delivery gate for a generated answer.
  // Deliberately NARROW so legitimate answers survive: a maths answer reuses
  // the question's numbers ("144 divided by 12 is 12."), a joke reuses the
  // prompt words, and a summary quotes the source. Those all add content or
  // end as a statement, so none of them trip the checks below.
  //   empty            - blank / no content tokens
  //   envelope         - the raw structured response object
  //   metadata-only    - nothing but contract labels / numbers
  //   exact-echo       - same content words as the request, nothing added
  //   question-return  - the request handed back as a question, nothing added
  function answerQuality(answer, { question = '' } = {}) {
    const text = String(answer || '').trim();
    if (!text) return { ok: false, reason: 'empty' };
    if (looksLikeResponseEnvelope(text)) return { ok: false, reason: 'envelope' };
    const answerTokens = echoTokens(text);
    if (!answerTokens.length) {
      // Only punctuation/filler with no content words at all.
      if (/^[\s\W]*$/.test(text)) return { ok: false, reason: 'empty' };
      return { ok: true, reason: 'ok' };
    }
    // Metadata-only: contract field names and their values with no user-facing
    // sentence behind them. Removing the known keys leaves almost nothing.
    // Requires a key immediately followed by ":", so ordinary prose that merely
    // uses a word like "emotion" or "response" is never caught here.
    if (RESPONSE_ENVELOPE_KEY_RE.test(text) && !/^(?:yes|no|sure|certainly|of course)\b/i.test(text)) {
      const remainder = text.replace(new RegExp(`"?\\b(${RESPONSE_ENVELOPE_KEYS.join('|')})"?\\s*:\\s*(?:"[^"]*"|[^",}\n]*)`, 'gi'), ' ');
      const meaningful = echoTokens(remainder).filter(word => !/^\d+$/.test(word));
      if (meaningful.length <= 2) return { ok: false, reason: 'metadata-only' };
    }
    const questionTokens = echoTokens(question);
    if (questionTokens.length) {
      // Exact echo: same content words in the same order, nothing new added.
      if (answerTokens.join(' ') === questionTokens.join(' ')) return { ok: false, reason: 'exact-echo' };
      // Question returned as a question: every content word comes from the
      // request and it is still phrased as a question back to the user.
      const questionSet = new Set(questionTokens);
      const addsNothing = answerTokens.every(token => questionSet.has(token));
      if (addsNothing && /[?]\s*$/.test(text) && answerTokens.length >= 2) return { ok: false, reason: 'question-return' };
    }
    // Bare stub: a 1-3 word fragment ending in "ready" with no verb and no
    // address ("Roblox house ready."). A real confirmation is a complete
    // sentence ("Roblox is open, Sir." or "Roblox is ready."). Short polite
    // replies ("Yes, sir.") never end in "ready" and are unaffected.
    {
      const bare = text.replace(/[.!?]+$/, '').trim();
      const words = bare.split(/\s+/).filter(Boolean);
      if (words.length >= 1 && words.length <= 3 && /\bready$/i.test(bare)
        && !/\bsir\b/i.test(bare)
        && !/\b(is|are|was|were|be|been|has|have|had|will|shall|open|opened|launched|started)\b/i.test(bare)) {
        return { ok: false, reason: 'stub' };
      }
    }
    return { ok: true, reason: 'ok' };
  }

  // =====================================================================
  // Independent low-volume wake-word path (2026-10-14). A dedicated,
  // frame-level "Hey Jarvis" syllable-envelope detector fed by UNGATED
  // microphone audio (every capture frame, including while speaking).
  //
  // Why it exists: the command voice gate + quality gate + Whisper text
  // match can only see utterances loud enough to open the gate, so quiet
  // wake phrases never reached any detector. This path never lowers that
  // gate: it runs BEFORE/REGARDLESS of the gate decision and, on a
  // confirmed event, forces command capture + TTS interruption directly.
  // Whisper transcription + parseWakeTranscript + echo/contamination guards
  // remain the authoritative verifier (a proposal without a transcribed
  // wake word executes nothing).
  //
  // Heuristic, honestly labelled: a two-burst syllable envelope
  // ("hey JAR-vis", ~0.3-1.2 s, >=2 energy peaks with a valley) above an
  // independent slow noise floor. It is NOT the openWakeWord neural model
  // (evaluated; not installed — see wakeword-models/README.md). Thresholds
  // below are unit-calibrated defaults pending live measurement; tune with
  // WAKEWORD-TEST-PROCEDURE.md numbers, never blindly.
  // =====================================================================
  const WAKE_TEMPLATE_DEFAULTS = {
    threshold: 0.5, speakThreshold: 0.65,
    needFrames: 2, speakNeedFrames: 3, windowFrames: 4,
    cooldownMs: 2500, floorInit: 0.0025, ringFrames: 16,
  };
  function wakeTemplateScore(frames, floor) {
    // frames: [{rms, ms}]. Returns 0..1 pattern score for a "hey jarvis"
    // shaped envelope: 250-1200 ms of voice-like energy with >=2 peaks.
    if (!Array.isArray(frames) || !frames.length || !(floor > 0)) return 0;
    const rel = frames.map(f => Math.max(0, Number(f.rms) || 0) / floor);
    let voicedMs = 0, peak = 0;
    for (let i = 0; i < rel.length; i++) {
      if (rel[i] > 1.15) voicedMs += Math.max(0, Number(frames[i].ms) || 0);
      if (rel[i] > peak) peak = rel[i];
    }
    // Count peaks: local maxima above 1.25x floor separated by a >=10% dip.
    let peaks = 0, lastPeakIdx = -10;
    for (let i = 1; i < rel.length - 1; i++) {
      if (rel[i] > 1.25 && rel[i] >= rel[i - 1] && rel[i] >= rel[i + 1]) {
        const dip = Math.min(rel[i - 1], rel[i + 1]);
        if (rel[i] - dip >= Math.max(0.1, rel[i] * 0.1) && i - lastPeakIdx >= 1) { peaks++; lastPeakIdx = i; }
      }
    }
    if (rel.length >= 2) {
      const last = rel.length - 1;
      if (rel[last] > 1.25 && rel[last] >= rel[last - 1] && last - lastPeakIdx >= 1) peaks++;
      if (rel[0] > 1.25 && rel[0] >= rel[1]) peaks++;
    }
    const durFit = voicedMs < 150 ? voicedMs / 150
      : voicedMs <= 1200 ? 1
      : Math.max(0, 1 - (voicedMs - 1200) / 1200);
    // A lone peak (click, clap, door slam) scores low: a wake phrase needs
    // >=2 syllable bursts. The multi-peak factor below enforces it.
    const peakFit = peaks <= 0 ? 0 : peaks === 1 ? 0.2 : 1;
    const promFit = peak < 1.15 ? 0 : peak >= 2 ? 1 : (peak - 1.15) / (2 - 1.15);
    const multiFit = peaks >= 2 ? 1 : 0.55;
    // Transient gate: one frame holding most of the ring energy is an
    // impulse (click/slam), not speech — suppress regardless of peaks.
    let transientFit = 1;
    {
      let total = 0, max = 0;
      for (const f of frames) { const e = (Number(f.rms) || 0) ** 2; total += e; if (e > max) max = e; }
      if (total > 0 && max / total > 0.6) transientFit = 0.3;
    }
    // Onset gate: a real wake phrase starts from relative quiet. Sustained
    // loud audio (TV, ongoing speech) has no quiet onset and is suppressed
    // so it cannot repeatedly force captures; the command gate + Whisper
    // path still handles loud interruptions such as "stop".
    const onset = Math.min(...rel.slice(0, Math.min(3, rel.length)));
    const onsetFit = onset < 1.35 ? 1 : 0.35;
    return Math.max(0, Math.min(1, (durFit * 0.35 + peakFit * 0.4 + promFit * 0.25) * onsetFit * multiFit * transientFit));
  }
  class WakeSyllableDetector {
    constructor(options = {}) {
      const d = WAKE_TEMPLATE_DEFAULTS;
      this.threshold = Number(options.threshold ?? d.threshold);
      this.speakThreshold = Number(options.speakThreshold ?? d.speakThreshold);
      this.needFrames = Math.max(1, Math.floor(Number(options.needFrames ?? d.needFrames)));
      this.speakNeedFrames = Math.max(1, Math.floor(Number(options.speakNeedFrames ?? d.speakNeedFrames)));
      this.windowFrames = Math.max(1, Math.floor(Number(options.windowFrames ?? d.windowFrames)));
      this.cooldownMs = Math.max(0, Number(options.cooldownMs ?? d.cooldownMs));
      this.floor = Math.max(0.0005, Number(options.floorInit ?? d.floorInit));
      this.ringCap = Math.max(4, Math.floor(Number(options.ringFrames ?? d.ringFrames)));
      this.reset();
    }
    reset() { this.ring = []; this.scores = []; this.lastFireAt = 0; }
    sample(rmsValue, durationMs, { speaking = false, now = Date.now() } = {}) {
      const rms = Math.max(0, Number(rmsValue) || 0);
      const ms = Math.max(1, Number(durationMs) || 0);
      // Independent slow floor: tracks the room, not the command gate.
      // Rises slowly (loud TV cannot quickly desensitize), falls faster
      // (quiet room recovery keeps normal volume working). While speaking,
      // TTS output joins the floor faster so our own voice alone scores
      // low (single-mic limit; see report).
      if (rms < this.floor * 0.5) this.floor += (rms - this.floor) * 0.1;
      else if (rms < this.floor * 1.5) this.floor += (rms - this.floor) * (speaking ? 0.05 : 0.02);
      else this.floor += (Math.min(rms, this.floor * 1.3) - this.floor) * (speaking ? 0.05 : 0.008);
      this.floor = Math.max(0.0005, this.floor);
      this.ring.push({ rms, ms });
      if (this.ring.length > this.ringCap) this.ring.shift();
      const score = wakeTemplateScore(this.ring, this.floor);
      this.scores.push(score);
      if (this.scores.length > this.windowFrames) this.scores.shift();
      const thr = speaking ? this.speakThreshold : this.threshold;
      const need = speaking ? this.speakNeedFrames : this.needFrames;
      const recent = this.scores.slice(-need);
      const smoothed = recent.length >= need && recent.every(s => s >= thr);
      let fired = false;
      if (smoothed && (!this.lastFireAt || now - this.lastFireAt >= this.cooldownMs)) {
        fired = true;
        this.lastFireAt = now;
      }
      return { score, floor: this.floor, threshold: thr, speaking, fired };
    }
  }

  // =====================================================================
  // Voice-only modes (2026-10-14). Central mode + intent registry for the
  // existing command dispatcher. No GUI: modes reuse voice routing,
  // open-site/open-app/focus-app launching, conversation UI, and the speech
  // controller. Pure and unit-testable; the caller (app.js) owns launching,
  // follow-up state, and speech.
  //
  // Rules: aliases require an explicit mode/request phrasing so ordinary
  // conversation ("my homework is hard", "good morning") never activates a
  // mode. parseModeIntent returns { mode, extra } or null.
  // =====================================================================
  const MODE_FOLLOWUP_MS = 5000;
  const MODE_GAMES = {
    'roblox': 'Roblox', 'minecraft': 'Minecraft', 'genshin impact': 'Genshin Impact',
    'genshin': 'Genshin Impact', 'geometry dash': 'Geometry Dash', 'stardew valley': 'Stardew Valley',
    'stardew': 'Stardew Valley',
  };
  // Mobile-only / unsupported through the Windows launcher: named honestly so
  // callers report accurately instead of guessing executable paths.
  const MODE_GAMES_UNAVAILABLE = { 'brawl stars': 'mobile-only' };
  const MODES = {
    study: {
      label: 'Study', expect: 'subject',
      sites: ['toddle', 'youtube', 'youtube-music', 'gmail', 'docs', 'slides'], apps: [],
      aliases: [/\bstudy\s+mode\b/i, /\bschool\s+mode\b/i, /let'?s\s+study\b/i, /let'?s\s+do(?: my)? homework\b/i, /let'?s\s+get some schoolwork done\b/i, /time to (?:do homework|study)\b/i, /help me with my [\w ]{0,24}?(?:homework|assignments?)\b/i, /\bhomework\s+mode\b/i],
      // No follow-up question by design (2026-10-15). Study mode used to ask
      // "what subject should we start with?"; it now opens the workspace and
      // reads the Toddle todo/upcoming list instead, so it asks nothing.
      questions: [],
      help: 'Study mode prepares your school workspace: Toddle, YouTube, YouTube Music, Gmail, Google Docs, and Google Slides — reusing open tabs. Then I read your Toddle todo and upcoming work back to you. It asks no follow-up question. Say "study mode, start with math" to name a subject up front.',
    },
    gaming: {
      label: 'Gaming', expect: 'game',
      sites: ['youtube', 'roblox'], apps: [],
      aliases: [/\bgaming\s+mode\b/i, /\bgame\s+mode\b/i, /let'?s\s+game\b/i, /let'?s\s+play\b/i, /\bgaming\s+time\b/i, /i'?m (?:gonna|going to) play\b/i, /\btime to play\b/i, /\bwant to play\b/i, /\bwould like to play\b/i, /\blike to play\b/i, /\bwanna play\b/i, /\bplay\b(?:\s+\w+){0,3}\s+games?\b/i, /\bi want to game\b/i],
      questions: ["Any games you're interested in today?", 'What are we playing, sir?', 'Which game is the target today?', 'What are you in the mood to play?', 'Roblox, something else, or are we exploring options?', 'Have you already picked a game?', "What's today's gaming plan?", 'Which game should I get ready?', 'What are we loading up today?', 'Do you have a specific game in mind?', 'What are we playing first?', 'Which game are we focusing on today?', 'Are we continuing a game or starting something new?', 'Anything specific you want to play?', "What's on the menu today, gaming-wise?", 'Have you decided what we are playing, or should we brainstorm?', 'What type of games do you want to play, Sir?', 'What kind of game are you in the mood for, Sir?', 'Something chill, competitive, or story-driven today, Sir?', 'Do you want Roblox or something different this time, Sir?', 'Are we feeling action, adventure, or something relaxing, Sir?'],
      help: 'Gaming mode readies YouTube and Roblox without duplicating them, then asks whether to open another game. Answer with a game name — no wake word needed. Say "gaming mode, get Roblox ready" to skip the question.',
    },
    focus: {
      label: 'Focus', expect: 'task', style: 'concise',
      sites: [], apps: [],
      aliases: [/\bfocus\s+mode\b/i, /\bdeep\s+work(?:\s+mode)?\b/i, /i need to focus\b/i, /\bneed to focus\b/i, /\bfocus\s+session\b/i, /\bconcentrat(?:e|ion)(?:\s+mode)?\b/i],
      questions: ['What is the one thing we should finish first?', "What's the target for this focus session?", 'Which task deserves your full attention?', 'Would you like a short sprint or a longer work session?'],
      help: 'Focus mode keeps replies concise and asks for your one target. Say "focus mode for 25 minutes" to note a session length, or "remind me in 25 minutes" for a real timer.',
    },
    coding: {
      label: 'Coding', expect: 'project',
      sites: [], apps: [],
      aliases: [/\bcoding\s+mode\b/i, /\bdeveloper\s+mode\b/i, /\bprogramming\s+mode\b/i, /\bcode\s+mode\b/i, /let'?s\s+code\b/i],
      questions: ['What are we building today?', 'Which project are we working on?', 'Are we debugging a problem or creating something new?', "What's the current technical challenge?", 'Which part of the code needs attention?'],
      help: 'Coding mode focuses your named editor or project when you tell me which one, and routes programming questions to the local AI. I never run shell commands or change code unprompted.',
    },
    relax: {
      label: 'Relax', expect: 'break', style: 'calm',
      sites: [], apps: [],
      aliases: [/\brelax\s+mode\b/i, /\bchill\s+mode\b/i, /\bunwind(?:\s+mode)?\b/i, /need a break\b/i, /take a break\b/i, /i need to relax\b/i],
      questions: ['What kind of break would feel good right now?', 'Music, videos, or a quiet reset?', 'What mood are we going for?', 'Would you prefer something funny, calm, or energetic?', 'Want some music while you take a break?'],
      help: 'Relax mode offers YouTube Music and asks what kind of break you want. Nothing opens until you choose.',
    },
    music: {
      label: 'Music', expect: 'song',
      sites: [], apps: [],
      aliases: [/\bmusic\s+mode\b/i, /put (?:some |on some )?music on\b/i, /play some music\b/i, /i want (?:to listen to )?music\b/i, /music time\b/i],
      questions: ['What are we listening to?', 'Any song or artist in mind?', 'What mood should the music match?', 'Want something familiar or something new?', 'What should I queue up?'],
      help: 'Music mode searches YouTube Music. Say "music mode, play Magnetic" to skip the question.',
    },
    movie: {
      label: 'Movie', expect: 'watch',
      sites: ['youtube'], apps: [],
      aliases: [/\bmovie\s+mode\b/i, /\bvideo\s+mode\b/i, /\bwatch\s+mode\b/i, /let'?s\s+watch\b/i, /\bmovie\s+night\b/i, /find (?:me )?(?:a |something to )?watch\b/i],
      questions: ['What are we watching today?', 'Anything specific, or are we browsing?', 'Do you want something funny, educational, or story-driven?', 'Any creator or channel in mind?'],
      help: 'Movie mode readies YouTube and asks what to watch. Name a title and I search for it.',
    },
    creative: {
      label: 'Creative', expect: 'idea',
      sites: [], apps: [],
      aliases: [/\bcreative\s+mode\b/i, /\bbrainstorm(?:ing)?(?:\s+mode)?\b/i, /\bcreative\s+project\b/i],
      questions: ['What are we creating today?', 'Are we writing, designing, or building something?', "What's the idea you are imagining?", 'Do you have a starting point, or should we brainstorm?', 'What would you like the finished result to do?'],
      help: 'Creative mode brainstorms with you first and only opens tools once the task names them.',
    },
    research: {
      label: 'Research', expect: 'topic',
      sites: [], apps: [],
      aliases: [/\bresearch\s+mode\b/i, /\binvestigat(?:e|ing)\b/i],
      questions: ['What are we investigating today?', "What's the main question we are trying to answer?", 'Do you need a quick overview or a deeper investigation?', "What's the topic?", 'What do you already know about it?'],
      help: 'Research mode asks for your topic, then uses the browser and local AI. Google Docs opens only when notes are actually useful.',
    },
    writing: {
      label: 'Writing', expect: 'writing',
      sites: [], apps: [],
      aliases: [/\bwriting\s+mode\b/i, /help me write\b/i, /\bessay\s+mode\b/i],
      questions: ['What are we writing?', 'Is this an essay, a report, an email, or something else?', "What's the purpose of this piece?", 'Do you have a draft, or are we starting from scratch?'],
      help: 'Writing mode asks what and whom the piece is for, focusing Google Docs only when needed. Nothing is ever sent without your explicit instruction.',
    },
    presentation: {
      label: 'Presentation', expect: 'presentation',
      sites: ['slides'], apps: [],
      aliases: [/\bpresentation\s+mode\b/i, /\bslides?\s+mode\b/i, /work on my .*slides?\b/i, /prepar(?:e|ing)(?: a)? slides?\b/i, /prepar(?:e|ing) a presentation\b/i],
      questions: ['What topic are we presenting?', "Who's the audience?", 'Are we starting a new presentation or improving an existing one?', 'How many slides are you aiming for?'],
      help: 'Presentation mode focuses Google Slides without duplicating tabs and asks for your topic and audience.',
    },
    workout: {
      label: 'Workout', expect: 'workout',
      sites: [], apps: [],
      aliases: [/\bworkout\s+mode\b/i, /\bexercise\s+mode\b/i, /\bgym\s+mode\b/i, /\bfitness\s+mode\b/i, /let'?s\s+(?:work out|exercise)\b/i],
      questions: ['What kind of movement are you in the mood for?', 'Are we doing strength work, cardio, or a recovery session?', 'Want music while you get ready?', 'Would you prefer something short or a more structured session?'],
      help: 'Workout mode asks what kind of session you want and can put on music. I keep suggestions balanced and safe.',
    },
    morning: {
      label: 'Morning', expect: 'priority',
      sites: [], apps: [],
      aliases: [/\bmorning\s+mode\b/i, /\bstart(?:-| )day\s+mode\b/i, /\bstart my day\b/i, /\bbegin the day\b/i],
      questions: ["What's the main mission for today?", 'Should we start with your schedule or your top priority?', 'What do you want to get done first?', 'Anything important to prepare for today?'],
      help: 'Morning mode reviews your real calendar and reminders for today, then asks your top priority.',
    },
    winddown: {
      label: 'Wind-down', expect: 'winddown', style: 'calm',
      sites: [], apps: [],
      aliases: [/\bwind[-\s]?down\s+mode\b/i, /\bend (?:of|the) day\b/i, /\bwrapping up\b/i, /call it a (?:day|night)\b/i, /\bbedtime\s+mode\b/i],
      questions: ['Would you like some calm music or a quick look at tomorrow?', 'Anything important to prepare before winding down?', "Shall we review tomorrow's priorities?", 'Would you prefer a quiet break?'],
      help: 'Wind-down mode offers calm music or a look at confirmed events for tomorrow. It never changes alarms or cancels events.',
    },
    social: {
      label: 'Social', expect: 'social',
      sites: ['discord'], apps: [],
      aliases: [/\bsocial\s+mode\b/i, /\bchat\s+mode\b/i, /catch up with friends\b/i, /talk to friends\b/i, /message mode\b/i],
      questions: ['Are we catching up with friends or drafting a message?', 'Who or what are we trying to connect with?', 'Want to chat, or should we prepare a message first?'],
      help: 'Social mode reuses your open Discord and asks whether to chat or draft. Messages are never sent without a clear instruction.',
    },
    content: {
      label: 'Content creation', expect: 'content',
      sites: [], apps: [],
      aliases: [/\bcontent(?:\s+creation)?\s+mode\b/i, /\bcreator\s+mode\b/i, /make a video\b/i, /plan .*video\b/i, /new video\b/i],
      questions: ['What are we making today?', 'Are we brainstorming, scripting, or editing?', 'What platform is this for?', 'Do you already have footage or an idea?'],
      help: 'Content mode asks whether you want ideas, an outline, a script, or editing help. Nothing uploads without explicit authorization.',
    },
    bored: {
      label: 'Bored', expect: 'activity',
      sites: [], apps: [],
      aliases: [/\bi'?m\s+bored\b/i, /\bso\s+bored\b/i, /\bbored\s+mode\b/i, /\bnothing to do\b/i, /\bkilling time\b/i, /\bentertain me\b/i],
      questions: ['Want to game, create something, or discover something interesting?', 'Are you looking for something fun, useful, or completely random?', 'Should we find something to watch or start a project?', 'What kind of energy are you in the mood for?'],
      help: 'Bored mode pulls fresh picks and asks whether to game, create, or discover. Answer with your choice — no wake word needed.',
    },
    cooldown: {
      label: 'Cool-down', expect: 'feeling', style: 'calm',
      sites: [], apps: [],
      aliases: [/\bi'?m\s+angry\b/i, /\bangry\s+mode\b/i, /\bcool[-\s]?down(?:\s+mode)?\b/i, /need to (?:cool|calm) down\b/i, /calm me down\b/i, /\bfrustrat(?:ed|ing|ion)?\b/i],
      questions: ['Do you want to talk it through, take a break, or change the subject?', 'Would you rather vent for a moment or focus on something else?', "What's bothering you, or would you prefer a distraction?", 'Want a little space, some music, or help thinking through what happened?'],
      help: 'Cool-down mode stays calm and asks whether to talk, take a break, or redirect. It opens nothing unless you ask.',
    },
    conversation: {
      label: 'Conversation', expect: 'free',
      sites: [], apps: [],
      aliases: [/\bconversation(?:al)?\s+mode\b/i, /let'?s have (?:a |one )?(?:real |long |proper )?conversation\b/i, /\bstay with me for a chat\b/i, /\bstart conversation mode\b/i, /\benable conversation(?:al)? mode\b/i, /\bjust chat(?:ting)? with me\b/i, /let(?:'?s|\s+us)\s+(?:chat|talk)\b/i, /can\s+we\s+(?:chat|talk)\b/i, /i\s*(?:'d like to|'d love to|would like to|want to|need to)\s+(?:chat|talk)\b/i],
      questions: [],
      help: "Conversation mode keeps a sustained no-wake-word dialogue open: each exchange renews the listening window, so you can simply keep talking. Say 'exit conversation mode', 'turn off conversation mode', or 'I am done chatting' to return to normal listening.",
    },
  };
  function parseModeIntent(input) {
    const text = String(input || '').trim();
    if (!text) return null;
    const lead = stripPoliteLead(text).replace(/[.!?]+$/, '').trim();
    if (!lead) return null;
    // Mode switching / exit phrasing resolves before any single mode.
    if (/^(?:exit(?: this)? mode|leave (?:this )?mode|go back to normal|stop asking(?: me)? questions?|cancel(?: this)?(?! that)|never ?mind|quit (?:this )?mode)\b/i.test(lead) && !/^cancel that$/i.test(lead)) {
      return { mode: '__exit', extra: {} };
    }
    // Explicit deactivation of a NAMED mode: "turn off music mode",
    // "stop gaming mode", "disable movie mode", "exit conversation mode".
    // Resolves BEFORE alias matching so a mode's own activation alias (e.g.
    // /music mode/) can never re-activate through its off phrase — the actual
    // historical root cause of "does not turn off" on music/gaming modes.
    const namedOff = lead.match(/^(?:turn off|switch off|disable|stop|exit|leave|end|quit)\s+(?:the\s+|our\s+|this\s+|my\s+)?([a-z][a-z -]*?)\s+mode$/i);
    if (namedOff) {
      const id = modeIdFromName(namedOff[1]);
      if (id) return { mode: '__exit', extra: { forMode: id } };
    }
    // Natural spoken deactivations that do not fit the strict
    // "<verb> <mode> mode" shape ("music mode off", "cancel music",
    // "stop searching") still resolve to an exit instead of a new mode.
    if (/^(?:music mode off|cancel music|stop searching|stop the search|quit searching|stop this (?:search|music))$/i.test(lead)) {
      return { mode: '__exit', extra: {} };
    }

    const namedOffSuffix = lead.match(/^(?:turn|stop|quit|exit|disable|cancel)\s+([a-z][a-z -]*?)\s+mode\s+(?:off|out|now)?$/i);
    if (namedOffSuffix) {
      const id = modeIdFromName(namedOffSuffix[1]);
      if (id) return { mode: '__exit', extra: { forMode: id } };
    }
    // Phrases that mean "back to wake-word standby" without naming a mode.
    // Bare "normal" is included so "switch to normal" resolves, not just
    // "switch to normal mode".
    if (/^(?:return to normal(?: mode again| again| mode)?|back to normal mode|normal mode|normal)$/.test(lead)) {
      return { mode: '__exit', extra: {} };
    }
    const switchTo = lead.match(/^(?:switch|change)(?: to| into)? (.+)$/i);
    if (switchTo) {
      const inner = parseModeIntent(switchTo[1].trim());
      // An __exit result here is the user genuinely going back to normal
      // ("switch to normal mode"), NOT a deactivation to swallow: named
      // deactivations ("switch off music mode") already resolved above, so
      // nothing is lost by honouring the exit. Dropping it made
      // "switch to normal mode" fall through every alias and return null,
      // leaving the user in the mode they asked to leave.
      if (inner) return inner.mode === '__exit' ? { mode: '__exit', extra: inner.extra } : { mode: inner.mode, extra: inner.extra, switched: true };
    }
    const actually = lead.match(/^actually[,:]?\s+(.+)$/i);
    if (actually) {
      const inner = parseModeIntent(actually[1].trim());
      if (inner) return inner.mode === '__exit' ? { mode: '__exit', extra: inner.extra } : { mode: inner.mode, extra: inner.extra, switched: true };
    }
    // "What modes do you have?" / "What can you do in study mode?"
    if (/^(?:what modes do you have|list (?:your|the) modes?|show (?:me )?(?:your|the) modes?|(?:all |available )?modes list)\b/i.test(lead)) {
      return { mode: '__list', extra: {} };
    }
    const modeHelp = lead.match(/^what can you do in (?:the )?(\w[\w -]*?)(?: mode)?$/i)
      || lead.match(/^(?:help|about)(?: me)? with (?:the )?(\w[\w -]*?)(?: mode)?$/i);
    if (modeHelp) {
      const id = modeIdFromName(modeHelp[1]);
      if (id) return { mode: '__help', extra: { forMode: id } };
    }
    for (const [id, def] of Object.entries(MODES)) {
      if (!def.aliases.some(re => re.test(lead))) continue;
      return { mode: id, extra: extractModeExtra(lead, id) };
    }
    return null;
  }
  function modeIdFromName(name) {
    const n = String(name || '').toLowerCase().replace(/\s+mode\s*$/, '').trim();
    const map = { study: 'study', school: 'study', gaming: 'gaming', game: 'gaming', focus: 'focus', coding: 'coding', code: 'coding', developer: 'coding', relax: 'relax', music: 'music', movie: 'movie', video: 'movie', creative: 'creative', research: 'research', writing: 'writing', presentation: 'presentation', slides: 'presentation', workout: 'workout', exercise: 'workout', morning: 'morning', 'wind-down': 'winddown', winddown: 'winddown', social: 'social', chat: 'social', content: 'content', bored: 'bored', cooldown: 'cooldown', angry: 'cooldown', conversation: 'conversation', conversational: 'conversation' };
    return map[n] || null;
  }
  // Pull a same-utterance task out of a mode command ("gaming mode, get
  // Roblox ready", "music mode, play Magnetic", "focus mode for 25
  // minutes"). Only explicit phrasings count; never guess.
  function extractModeExtra(lead, mode) {
    const extra = {};
    const gameHit = lead.match(/(?:get|load(?: up)?|start|play|launch|open)\s+([A-Za-z][A-Za-z0-9 .'-]{1,40}?)(?:\s+ready|\s+up)?$/i);
    if (mode === 'gaming' && gameHit) extra.gameRaw = gameHit[1].trim();
    const songHit = lead.match(/(?:play|search(?: for)?|put on|queue(?: up)?)\s+(.+)$/i);
    if (mode === 'music' && songHit) extra.song = songHit[1].trim().slice(0, 120);
    if ((mode === 'music' || mode === 'relax' || mode === 'workout' || mode === 'movie') && !extra.song) {
      const watchHit = lead.match(/search for (.+)$/i);
      if (watchHit) extra.song = watchHit[1].trim().slice(0, 120);
    }
    const subjHit = lead.match(/(?:start(?:ing)? with|begin with|study|focus on|work on)\s+([A-Za-z][A-Za-z0-9 .'-]{1,40})$/i);
    if ((mode === 'study' || mode === 'focus' || mode === 'research' || mode === 'writing' || mode === 'presentation') && subjHit) {
      const subj = subjHit[1].trim();
      // "study mode" itself is the mode trigger, not a subject named "mode".
      if (!/^(?:mode|study|gaming|focus|coding|relax|music|movie|research|writing|presentation|workout|morning|social|content|bored|school|homework)$/i.test(subj)) extra.subject = subj;
    }
    const minHit = lead.match(/for (\d{1,3})\s*minutes?\b/i);
    if (minHit) extra.minutes = Math.max(1, Math.min(180, Number(minHit[1])));
    const topicHit = lead.match(/investigate\s+(.+)$/i) || lead.match(/research\s+(?!mode\b)(.+)$/i);
    if (mode === 'research' && topicHit && topicHit[1]) {
      const topic = topicHit[1].trim();
      if (topic && !/^(?:mode|something)$/i.test(topic)) extra.topic = topic.slice(0, 120);
    }
    const projHit = lead.match(/open my (.+?) project$/i);
    if (mode === 'coding' && projHit) extra.project = projHit[1].trim().slice(0, 80);
    return extra;
  }
  // Resolve a known game name from free text. Returns { name } for a known
  // launchable game, { name, unsupported } for mobile-only titles, or null.
  function parseModeGame(text) {
    const t = String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    for (const [alias, name] of Object.entries(MODE_GAMES)) {
      if (t === alias || t.includes(alias)) return { name };
    }
    for (const [alias, reason] of Object.entries(MODE_GAMES_UNAVAILABLE)) {
      if (t === alias || t.includes(alias)) return { name: alias.replace(/\b\w/g, c => c.toUpperCase()), unsupported: reason };
    }
    const m = t.match(/^(?:let'?s play|play|load(?: up)?|start|get|launch|open|i want to play|probably)\s+(.+?)(?:\s+(?:please|today|now|first))?$/);
    if (m && m[1].trim().length >= 2 && m[1].trim().length <= 40) return { name: m[1].trim(), generic: true };
    if (/^[a-z0-9][a-z0-9 .'-]{1,39}$/.test(t) && t.split(' ').length <= 3 && !/^(?:yes|no|yeah|nope|sure|okay|ok|cancel|stop|nerg|nothing|something|anything|everything|maybe|later|skip|uh+|um+|uhm+|erm+|hmm+|mm+|ah|oh|huh|er|huh\?)$/.test(t)) {
      return { name: t, generic: true };
    }
    return null;
  }
  // Deterministic question rotation (persisted counter in the caller): every
  // mode asks a varied question without repeating the last one.
  function modeQuestion(modeId, index) {
    const def = MODES[modeId];
    if (!def || !def.questions.length) return '';
    const list = def.questions;
    return list[Math.abs(Math.floor(Number(index) || 0)) % list.length];
  }
  function modeHelpText(modeId) {
    const def = MODES[modeId];
    return def ? `${def.label} mode — ${def.help}` : '';
  }
  function modeListText() {
    return 'Study mode prepares the school workspace. Gaming mode readies YouTube and Roblox, then asks about other games. Focus mode sets a task. Coding mode works on your project. Relax, music, movie, workout, morning, wind-down, social, content, creative, research, writing, presentation, bored, and cool-down modes are ready too. Name one, Sir.';
  }

  // =====================================================================
  // Hesitation / filler detection + music-answer classification (2026-10-14).
  //
  // "Ugh" after "Any song or artist in mind?" used to become a YouTube Music
  // search for "Ugh" because the song branch searched ANY short reply. The
  // deterministic guard below separates filler, unsure reactions, permission
  // to choose ("anything"), polite declines ("nothing"), cancellations and
  // genuine requests BEFORE any search runs. isFillerReply is deliberately
  // generic so other modes can reuse it; classifyMusicAnswer adds the
  // music-specific kinds. Context still decides: "Play Ugh by BTS" is a
  // request even though bare "Ugh" is filler.
  // =====================================================================
  const FILLER_SINGLE_RE = /^(?:ugh+|um+|uh+|er+|ah+|erm+|hmm+|mm+|hm+|m|huh+|eh+|oh+|ooh+|oops|whoa+|wow+|phew+|tsk+|meh+)$/;
  const FILLER_WORD_RE = /^(?:ugh|um|uh|er|ah|erm|hmm|mm|hm|m|huh|eh|oh|well|so|like|just|actually|right|okay|hey|hi)$/;
  const STALL_SINGLE_RE = /^(?:what|huh|wait|hold on|sorry|pardon|come again|say again|repeat that|one more time)$/;
  const LEAD_FILLER_RE = /^(?:ugh+|um+|uh+|er+|ah+|erm+|hmm+|mm+|hm+|eh+|oh+|well|so|like|okay|right|hey|hi|please)[,.\s]+/i;
  function normalizeFillerText(value) {
    let text = String(value || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").trim();
    // Punctuation carries no meaning for filler detection ("Ugh." == "ugh").
    text = text.replace(/[.!?,;:…~*\-_"“”‘’()\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
    // Stuttered repeats ("um um um", "uh uh") collapse to one.
    text = text.replace(/\b(um+|uh+|er+|ah+|hmm+|mm+|hm+|eh+)(?:\s+\1)+\b/g, '$1');
    // Stretched spellings ("ummm", "hmmmm", "uuuh") collapse to the base.
    text = text.replace(/\bumm+\b/g, 'um').replace(/\buhh+\b/g, 'uh')
      .replace(/\bhmmm+\b/g, 'hmm').replace(/\bmmmm+\b/g, 'mm')
      .replace(/\bughh+\b/g, 'ugh');
    return text.replace(/\s+/g, ' ').trim();
  }
  function stripLeadFiller(text) {
    let out = String(text || '').trim(), prev = '';
    while (out !== prev) { prev = out; out = out.replace(LEAD_FILLER_RE, '').trim(); }
    return out;
  }
  // True when the utterance is hesitation, a frustrated reaction, a stall, or
  // an unintelligible fragment — never a searchable title by itself.
  const MUSIC_RETRY_RE = /\b(again|repeat|replay|restart|one more time|retry)\b/i;

  function musicSearchPolicy({ query = '', transcript = '', history = [], now = Date.now() } = {}) {
    const q = String(query || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const list = (Array.isArray(history) ? history : []).filter(h => h && now - Number(h.at || 0) < 120000);
    if (!q) return { allow: false, reason: 'empty', history: list };
    if (MUSIC_RETRY_RE.test(String(transcript || ''))) return { allow: true, reason: 'explicit-retry', history: [...list, { query: q, at: now }] };
    const same = list.filter(h => String(h.query || '').toLowerCase() === q);
    const recent = same.filter(h => now - Number(h.at || 0) < 60000);
    // Three identical searches in quick succession (a new request while the
    // same query is still recent) indicate a runaway loop, not a refresh.
    if (same.length >= 2 && recent.length >= 1) return { allow: false, reason: 'loop-trip', history: [...list, { query: q, at: now }] };
    if (recent.length >= 1) return { allow: false, reason: 'duplicate', history: [...list, { query: q, at: now }] };
    return { allow: true, reason: 'fresh', history: [...list, { query: q, at: now }] };
  }
  function echoExemptAllowed({ pendingActive = false, words = 99, contaminated = true, startedAt = 0, ttsEndedAt = 0, blackoutMs = 1500 } = {}) {
    if (!pendingActive || words > 4 || contaminated) return false;
    if (!ttsEndedAt || !startedAt) return true;
    const gap = Number(startedAt) - Number(ttsEndedAt);
    const blackout = Math.max(0, Number(blackoutMs) || 0);
    // Own TTS tails arrive inside (or immediately after) the post-playback
    // blackout and stay blocked; a genuine answer arrives a little later but
    // still within a short window after playback ended.
    if (gap <= blackout) return false;
    if (gap > 4000) return false;
    return true;
  }
  function isFillerReply(input) {
    const text = normalizeFillerText(input);
    if (!text) return true;
    if (/^[a-z]$/.test(text)) return true;
    const words = text.split(' ').filter(Boolean);
    if (words.length === 1) {
      if (FILLER_SINGLE_RE.test(words[0])) return true;
      if (STALL_SINGLE_RE.test(text)) return true;
      return false;
    }
    if (words.length <= 4 && words.every(w => FILLER_WORD_RE.test(w))) return true;
    return false;
  }
  const MUSIC_UNSURE_RE = /^(?:i(?: am|'m)?\s+(?:not sure|unsure|uncertain)|i do ?n'?t know|i dont know|dunno|not sure|no idea|haven'?t(?: a| any)? idea|can'?t decide|not certain|not really sure|hard to say)\b/;
  const MUSIC_ANYTHING_RE = /^(?:anything|whatever|you pick|your pick|your choice|surprise me|something(?: good| nice)?|dealer'?s choice|i'?m easy|up to you|yes|yeah|yep|yup|sure|ok|okay|please do|go ahead|do it|pick(?: one| something| for me)?|you choose|choose for me)\b/;
  const MUSIC_NOTHING_RE = /^(?:nothing|none|no|nope|nah|not now|later|not right now|not today|pass|skip|leave it(?: alone)?|leave music(?: paused| off)?|keep it quiet|no music|pause it|stay paused|i'?m (?:good|done|ok|okay))\b/;
  const MUSIC_BARE_STOP_RE = /^(?:it|that|this|them|they|him|her|me|you|us|what|when|where|which|who|how|why|please|thanks|thank you|maybe|probably|song|music|tune|track|video|songs|a song|the song)\b/;
  const MUSIC_GENERIC_TITLE_RE = /^(?:a|an|some|any|good|nice|great|my|the)\s+(?:song|music|tune|track|video|songs|tunes)(?:\s+(?:for me|please))?$/;
  // Classify one answer to "which song / artist?". Returns { kind, title? }:
  // cancel | filler | unsure | anything | nothing | request. Never searches.
  // Matching runs on a normalized lowercase copy, but a returned title is
  // sliced from the user's own casing ("Magnetic by ILLIT", not "magnetic
  // by illit") so spoken and displayed replies read naturally.
  function classifyMusicAnswer(input) {
    if (isPendingCancellation(input)) return { kind: 'cancel' };
    // Typed commands keep their wake word and politeness ("Hey Jarvis, play
    // ... sir"); voice transcripts arrive pre-stripped. Normalize both to the
    // bare request so "jarvis" never becomes part of a search query.
    const deWaked = String(input || '')
      .replace(/^(?:(?:hey|hi|hello|ok|okay|yo)\s+)?jarvis\b[\s,;:*-]*/i, '')
      .replace(/^(?:please\s+|can you\s+|could you\s+|would you\s+|kindly\s+)/i, '')
      .replace(/(?:\s+(?:please|for me|for us|sir|madam)\s*)+$/i, '').trim();
    const light = deWaked.replace(/[\u2018\u2019]/g, "'").replace(/[.!?,;:…~*\-_"“”‘’()\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
    const core = stripLeadFiller(normalizeFillerText(deWaked));
    if (!core) return { kind: 'filler' };
    if (MUSIC_UNSURE_RE.test(core)) return { kind: 'unsure' };
    if (MUSIC_ANYTHING_RE.test(core)) return { kind: 'anything' };
    if (MUSIC_NOTHING_RE.test(core)) return { kind: 'nothing' };
    if (isFillerReply(core)) return { kind: 'filler' };
    // A bare verb with no object ("play", "search") is incomplete, not a query.
    if (/^(?:play|search|put on|queue(?: up)?)$/.test(core)) return { kind: 'filler' };
    const display = stripLeadFiller(light);
    const verb = core.match(/^(?:play|search(?: for)?|put on|queue(?: up)?)\s+(.+)$/);
    if (verb) {
      const rawTitle = (display.match(/^(?:play|search(?: for)?|put on|queue(?: up)?)\s+(.+)$/i)?.[1] || verb[1]).trim().slice(0, 120);
      const title = verb[1].trim().slice(0, 120);
      if (!title) return { kind: 'filler' };
      // "play some music" names no content: permission, not a query.
      if (MUSIC_GENERIC_TITLE_RE.test(title)) return { kind: 'anything' };
      // "play anything" / "play whatever" asks for a free choice, not a
      // literal search for the word "anything".
      if (MUSIC_ANYTHING_RE.test(title)) return { kind: 'anything' };
      // "play Ugh by BTS": the artist phrase makes even a filler word specific.
      const by = title.match(/^(.+?)\s+by\s+([a-z0-9][a-z0-9 .'\-&]{1,60})$/);
      if (by && by[1].trim().length >= 2 && by[2].trim().length >= 2) {
        const rawBy = rawTitle.match(/^(.+?)\s+by\s+(.+)$/i);
        return { kind: 'request', title: rawBy ? `${rawBy[1].trim()} by ${rawBy[2].trim()}`.slice(0, 120) : rawTitle };
      }
      if (MUSIC_BARE_STOP_RE.test(title)) return { kind: 'filler' };
      const alnum = title.replace(/[^a-z0-9]/gi, '');
      if (alnum.length >= 2) return { kind: 'request', title: rawTitle };
      return { kind: 'filler' };
    }
    // Bare title ("Magnetic", "Magnetic by ILLIT", "U2"): specific enough
    // unless it is a stop word or too short to mean anything.
    const byBare = core.match(/^(.+?)\s+by\s+([a-z0-9][a-z0-9 .'\-&]{1,60})$/);
    if (byBare && byBare[1].trim().length >= 2 && byBare[2].trim().length >= 2) return { kind: 'request', title: display.slice(0, 120) };
    if (MUSIC_BARE_STOP_RE.test(core) || MUSIC_GENERIC_TITLE_RE.test(core)) {
      return MUSIC_GENERIC_TITLE_RE.test(core) ? { kind: 'anything' } : { kind: 'filler' };
    }
    const bare = core.replace(/[^a-z0-9]/gi, '');
    if (bare.length >= 3 || (bare.length >= 2 && /\d/.test(bare))) return { kind: 'request', title: display.slice(0, 120) };
    return { kind: 'filler' };
  }

  // =====================================================================
  // Restore-my-tab intent (2026-10-14). Dedicated routing for bringing back
  // the user's designated YouTube destination in Microsoft Edge — never a
  // generic app lookup, process lookup, or tab-title match. Pure.
  // Checked BEFORE parseReopenTabIntent in the dispatcher: "restore my tab"
  // matches both, and this specific destination wins by order. Genuinely
  // different requests ("reopen my closed tab", "undo that") do not match
  // here and keep the native closed-tab path. Close/switch/other-tab
  // phrasings never match.
  // =====================================================================
  const MY_TAB_URL = 'https://www.youtube.com/watch?v=1597gE1VeU4';
  function parseRestoreTabIntent(input) {
    const text = stripPoliteLead(String(input || '')).replace(/[.!?]+$/, '').trim();
    if (!text) return null;
    if (/^(?:close|shut|switch|move|send|pin|mute|unmute|reload|refresh|duplicate)\b/i.test(text)) return null;
    if (/\bother\b.*\btab\b|\btab\b.*\bother\b/i.test(text) && !/\bmy\b/i.test(text)) return null;
    const hit =
      /\bbring\s+my\s+tab\s+back\b/i.test(text) ||
      /\bget\s+my\s+tab\s+back\b/i.test(text) ||
      /\brestore\s+my\s+tab\b/i.test(text) ||
      /\btake\s+me\s+back\s+to\s+my\s+tab\b/i.test(text) ||
      /\bopen\s+my\s+(?:youtube\s+)?tab\s+again\b/i.test(text) ||
      /\breturn\s+to\s+my\s+(?:tab|video)\b/i.test(text) ||
      (/\bbring\s+(?:it|that)\s+back\b/i.test(text) && /\bmy\s+(?:tab|video|youtube)\b/i.test(text));
    if (!hit) return null;
    // "my other tab" / "another tab" is never the designated destination.
    if (/\b(other|another|different)\b/i.test(text)) return null;
    return { kind: 'restore-my-tab', url: MY_TAB_URL };
  }
  // playing, or during the short post-playback tail hold, microphone frames
  // must NOT seed normal command capture — JARVIS's own voice can never
  // enter the transcription/execution pipeline. The ONLY exception is a
  // barge-energy latch (deliberately loud user speech over playback), which
  // seeds an interruption-only candidate that still needs a stop phrase or
  // a real wake word from Whisper text to act. All thresholds below are
  // unit-calibrated defaults; tune with measured live tests, never blindly.
  // =====================================================================
  const PLAYBACK_DEFAULTS = {
    tailCooldownMs: 600, // supplementary post-playback hold (event-gated first)
    bargeFloorMult: 6, // vs the command-gate noise floor
    bargeSpeakMult: 3, // vs the rolling TTS playback level
    bargeFrames: 2, // consecutive loud frames to latch
  };
  // One-frame barge-energy test. Pure.
  function bargeFrame({ rms = 0, commandFloor = 0.0008, speakLevel = 0.004 } = {}) {
    const r = Math.max(0, Number(rms) || 0);
    const floor = Math.max(0.0008, Number(commandFloor) || 0.0008);
    const speak = Math.max(0.0008, Number(speakLevel) || 0.0008);
    return r > Math.max(floor * PLAYBACK_DEFAULTS.bargeFloorMult, speak * PLAYBACK_DEFAULTS.bargeSpeakMult);
  }
  // Central seed decision. Pure. ttsActive = audio actually playing (not
  // merely generated); holdActive = inside the post-playback tail window;
  // bargeLatch = deliberate loud speech latched over 2 consecutive frames.
  // `sfxActive` covers the short acknowledgment / thinking cues. They are JARVIS's
  // own audio, so the microphone must stay gated while they sound exactly as it
  // does for TTS - otherwise the acknowledgment chirp could be transcribed as a
  // wake word. Barge-in still bypasses so "stop" keeps working.
  function playbackGateDecision({ ttsActive = false, holdActive = false, bargeLatch = false, sfxActive = false } = {}) {
    if (bargeLatch) return { seed: true, reason: 'barge' };
    if (ttsActive) return { seed: false, reason: 'playback' };
    if (sfxActive) return { seed: false, reason: 'sfx' };
    if (holdActive) return { seed: false, reason: 'tail-hold' };
    return { seed: true, reason: 'idle' };
  }

  // =====================================================================
  // Local ASR diagnostics (2026-10-14). Pure helpers shared by the server
  // (which runs whisper.cpp) and the UI (which reports failures). They
  // classify WHERE recognition failed so one vague message never hides the
  // stage again. No audio, secrets, or transcripts are logged by these.
  // =====================================================================
  // Mirror of the server's WAV gate: small mono 16 kHz 16-bit PCM only.
  function validateAsrWav(audio) {
    if (!audio || typeof audio.length !== 'number' || audio.length < 1200 || audio.length > 4 * 1024 * 1024) {
      return { ok: false, status: 400, reason: 'empty-or-too-large' };
    }
    const ascii = (at, len) => String.fromCharCode(...audio.slice(at, at + len));
    const u16 = (at) => (audio[at] || 0) | ((audio[at + 1] || 0) << 8);
    const u32 = (at) => (audio[at] || 0) | ((audio[at + 1] || 0) << 8) | ((audio[at + 2] || 0) << 16) | ((audio[at + 3] || 0) * 16777216);
    if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE' || u16(20) !== 1 || u16(22) !== 1 || u32(24) !== 16000 || u16(34) !== 16) {
      return { ok: false, status: 400, reason: 'bad-format' };
    }
    return { ok: true, status: 200, reason: 'wav-ok' };
  }
  // Classify a client-side ASR failure into a stage. Inputs mirror what the
  // UI catch sites actually have: fetch failure (unreachable bridge),
  // HTTP status, and the server message. Pure and unit-testable.
  function asrFailureInfo({ fetchFailed = false, status = 0, message = '' } = {}) {
    const msg = String(message || '');
    if (fetchFailed) return { stage: 'unreachable', label: 'UNREACHABLE', hint: 'local service did not answer' };
    if (Number(status) === 429) return { stage: 'busy', label: 'BUSY', hint: 'previous decode still running' };
    if (Number(status) === 400) return { stage: 'audio', label: 'AUDIO', hint: 'mic audio rejected by the gate' };
    if (Number(status) === 503 && /model|missing|restore the offline-asr/i.test(msg)) return { stage: 'model', label: 'MODEL', hint: 'engine or model files missing' };
    if (Number(status) === 503 && /too long|timeout/i.test(msg)) return { stage: 'timeout', label: 'TIMEOUT', hint: 'decode exceeded its budget' };
    if (Number(status) === 503) return { stage: 'decode', label: 'DECODE', hint: 'engine failed on valid audio' };
    if (/request failed|fetch failed|ECONNREFUSED|failed to fetch|networkerror|abort/i.test(msg)) return { stage: 'unreachable', label: 'UNREACHABLE', hint: 'local service did not answer' };
    return { stage: 'unknown', label: 'ERROR', hint: msg.slice(0, 80) || 'unclassified failure' };
  }

  // =====================================================================
  // RESPONSE CLEANUP + NATURAL SPEECH (2026-10-14)
  // One shared pipeline so every answer - Ollama, screen vision, camera,
  // commands - is cleaned the same way. Pure, unit-tested, no I/O.
  //
  //   displayText -> stripInternalAnnotations + normalizeDisplayText
  //   speechText  -> the above + toNaturalSpeech (never raw Markdown)
  //
  // Design rules kept deliberately narrow so legitimate technical answers,
  // maths, code and user-requested literals survive untouched.
  // =====================================================================

  // Internal processing notes. Keyed on the INTERNAL VERB plus the shape of the
  // note, never on the model name alone, so a genuine answer that mentions a
  // model (the user asking "what is qwen3.5:4b?") is never stripped.
  const INTERNAL_NOTE = /\((?:analy[sz]ed|processed|generated|answered|answered by|generated by|produced|rendered|described|read|handled|resolved|served)\s+(?:locally\s+)?(?:with|by|via|using|on)\s+[^)]{0,80}\)/gi;
  const INTERNAL_NOTE_ALT = /\(\s*(?:analy[sz]ed\s+locally|local(?:ly)?\s+analysis|analysis\s+done\s+locally|processed\s+locally|generated\s+locally|routed\s+through[^)]*|internal(?:\s+\w+)?|routing|model\s*[:=][^)]*|engine\s*[:=][^)]*|via\s+local\s+\w+|no\s+web\s+search|offline\s+mode|routing\s+decision)\s*\)/gi;
  const INTERNAL_PREFIX = /^\s*(?:analy[sz]ed\s+locally\b|internal\s*:\s*|note\s*:\s*analysis|processed\s+locally\b)/gi;

  function stripInternalAnnotations(text) {
    let out = String(text || '');
    if (!out.trim()) return '';
    out = out.replace(INTERNAL_NOTE, ' ');
    out = out.replace(INTERNAL_NOTE_ALT, ' ');
    out = out.replace(INTERNAL_PREFIX, '');
    // Tidy the punctuation the removal leaves behind: "(answer)." -> "answer",
    // " , " -> ", ", stray sentence-final periods before a closing mark.
    out = out
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/([(\[{])\s+/g, '$1')
      .replace(/\s+([)\]}])/g, '$1')
      .replace(/(^|[.!?])\s*\.\s*$/g, '$1')
      .replace(/\.\s*\)/g, ')')
      .replace(/^\s*[:;,]\s*/, '')      // a stripped prefix must not leave a dangling colon
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    return out;
  }

  // Markdown -> plain text for display. Fenced/inline code is preserved
  // verbatim because literal characters matter there.
  function normalizeDisplayText(text) {
    let out = String(text || '');
    if (!out) return '';
    const blocks = [];
    // Protect code so markdown stripping never corrupts code.
    out = out.replace(/```[\s\S]*?```/g, m => { blocks.push(m); return `\u0000C${blocks.length - 1}\u0000`; });
    out = out.replace(/`([^`\n]+)`/g, m => { blocks.push(m); return `\u0000C${blocks.length - 1}\u0000`; });
    // Links keep their label, drop the target.
    out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');        // headings
    out = out.replace(/^\s{0,3}>\s?/gm, '');              // quotes
    out = out.replace(/^\s{0,3}([-*_])\s*\1\s*\1[\s\S]*?$/gm, ''); // thematic breaks
    out = out.replace(/(\*\*\*|___)(.*?)\1/g, '$2');
    out = out.replace(/(\*\*|__)(.*?)\1/g, '$2');
    out = out.replace(/(^|[\s(])[*_](?=\S)([^*_]+?)(?<=\S)[*_](?=[\s).,!?:;]|$)/g, '$1$2');
    out = out.replace(/~~(.*?)~~/g, '$1');
    out = out.replace(/\|/g, ' ');                        // table pipes
    out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '');         // bullets
    out = out.replace(/[ \t]+$/gm, '');
    blocks.forEach((b, i) => { out = out.replace(`\u0000C${i}\u0000`, b); });
    return out.replace(/\n{3,}/g, '\n\n').trim();
  }

  const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  function underHundred(n) {
    if (n < 20) return ONES[n];
    return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  }
  // Compact integer-to-words. Range is deliberately limited to what spoken UI
  // numbers need; anything larger is left as digits rather than guessed at.
  function numberToWords(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0 || n > 999999) return String(value);
    if (n < 20) return ONES[n];
    if (n < 100) return underHundred(n);
    if (n < 1000) {
      const r = n % 100;
      return ONES[Math.floor(n / 100)] + ' hundred' + (r ? ' and ' + underHundred(r) : '');
    }
    const t = Math.floor(n / 1000), r = n % 1000;
    return numberToWords(t) + ' thousand' + (r ? (r < 100 ? ' and ' : ' ') + numberToWords(r) : '');
  }
  const numberToWordsPoint = value => {
    const s = String(value);
    const [int, frac] = s.split('.');
    if (frac === undefined) return numberToWords(int);
    return numberToWords(int) + ' point ' + frac.split('').map(d => ONES[Number(d)]).join(' ');
  };

  const UNIT_WORDS = { gb: 'gigabytes', mb: 'megabytes', kb: 'kilobytes', tb: 'terabytes', ms: 'milliseconds', hz: 'hertz', khz: 'kilohertz', mhz: 'megahertz', ghz: 'gigahertz' };
  const SITE_WORDS = [
    [/(?:https?:\/\/)?(?:www\.)?music\.youtube\.com(?:\/\S*)?/gi, 'YouTube Music'],
    [/(?:https?:\/\/)?(?:www\.)?youtube\.com(?:\/\S*)?/gi, 'YouTube'],
    [/(?:https?:\/\/)?(?:www\.)?open\.spotify\.com(?:\/\S*)?/gi, 'Spotify'],
    [/(?:https?:\/\/)?(?:www\.)?github\.com(?:\/\S*)?/gi, 'GitHub'],
    [/(?:https?:\/\/)?(?:www\.)?discord\.com(?:\/\S*)?/gi, 'Discord'],
  ];

  // Spoken form of m:ss (elapsed / total playback), e.g. "0:09 / 3:42" ->
  // "nine seconds into a three-minute-and-forty-two-second track".
  const MEDIA_NOUN = /\b(?:track|song|video|clip|playback|recording|episode|live\s+stream|timelapse)\b/i;
  const plural = (n, word) => `${numberToWords(n)} ${word}${Number(n) === 1 ? '' : 's'}`;
  function progressToSpeech(text) {
    return text.replace(/\b\d{1,2}:([0-5]\d)\s*(?:\/|of)\s*(\d{1,3}):([0-5]\d)\b/gi,
      (whole, as, b, bs) => {
        const tail = MEDIA_NOUN.test(text) ? ` ${text.match(MEDIA_NOUN)[0].toLowerCase()}` : ' track';
        const total = Number(b) > 0
          ? `${numberToWords(b)}-minute-and-${numberToWords(bs)}-second`
          : `${numberToWords(bs)}-second`;
        return `${plural(as, 'second')} into a ${total}${tail}`;
      });
  }
  // Spoken form of a bare duration, and of percentages / byte-ish units.
  function measuresToSpeech(text) {
    return text
      // 3:42 -> "three minutes and forty-two seconds" (but never a clock time)
      .replace(/(?<![\d/:.\w])(\d{1,3}):([0-5]\d)(?![\d:/\w])(?!\s*(?:a\.?m|p\.?m)\b)/gi,
        (m, a, b, off, full) => `${numberToWords(a)} minute${a === '1' ? '' : 's'} and ${numberToWords(b)} second${b === '1' ? '' : 's'}`)
      // 7:30 PM stays a clock time
      .replace(/(?<![\d/:.\w])(\d{1,2}):([0-5]\d)\s*([ap])\.?\s*m\.?/gi,
        (_, h, m, ap) => `${numberToWords(Number(h))} ${numberToWords(Number(m))} ${ap.toLowerCase() === 'a' ? 'A M' : 'P M'}`)
      // 50% -> "fifty percent"
      .replace(/(\d+(?:\.\d+)?)\s*%/g, (_, n) => `${numberToWordsPoint(n)} percent`)
      // 8.2 GB -> "eight point two gigabytes"
      .replace(/(\d+(?:\.\d+)?)\s*(GB|MB|KB|TB|ms|Hz|kHz|MHz|GHz)\b/gi,
        (_, n, u) => `${numberToWordsPoint(n)} ${UNIT_WORDS[String(u).toLowerCase()] || String(u).toLowerCase()}`);
  }

  function toNaturalSpeech(text) {
    let out = String(text || '');
    if (!out.trim()) return '';
    // First, strip internal annotations (model names, routing info, etc.)
    out = stripInternalAnnotations(out);
    // Code is protected first: spoken conversions must never rewrite a literal
    // inside a code block or inline code span, where characters matter.
    const blocks = [];
    out = out.replace(/```[\s\S]*?```/g, m => { blocks.push(m); return `\u0000C${blocks.length - 1}\u0000`; });
    out = out.replace(/`([^`\n]+)`/g, m => { blocks.push(m); return `\u0000C${blocks.length - 1}\u0000`; });
    // Known sites become names; a bare leftover URL is dropped rather than read.
    for (const [re, name] of SITE_WORDS) out = out.replace(re, name);
    out = out.replace(/https?:\/\/\S+/gi, ' ');
    out = out.replace(/\bwww\.\S+/gi, ' ');
    out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    out = out.replace(/(\*\*\*|___)(.*?)\1/g, '$2');
    out = out.replace(/(\*\*|__)(.*?)\1/g, '$2');
    out = out.replace(/~~(.*?)~~/g, '$1');
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1$2');
    out = out.replace(/^\s{0,3}[-*+][ \t]+/gm, '');
    out = progressToSpeech(out);
    out = measuresToSpeech(out);
    blocks.forEach((b, i) => { out = out.replace(`\u0000C${i}\u0000`, b); });
    // Never send Markdown syntax to TTS: the code CONTENT survives verbatim,
    // only the fence and backtick markers are removed so nothing is read aloud
    // as "backtick".
    out = out.replace(/```[a-zA-Z0-9+#._-]*\s*/g, ' ').replace(/```/g, ' ').replace(/`([^`]*)`/g, '$1');
    out = out.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
    return out;
  }

  // Single entry point used by the UI pipeline.
  function prepareResponse(text, { speech = false } = {}) {
    const cleaned = stripInternalAnnotations(normalizeDisplayText(text));
    return speech ? toNaturalSpeech(cleaned) : cleaned;
  }

  const api = { states, VoiceStateMachine, SpeechGate, SpeechController, parseWakeTranscript, parseWebsiteIntent, parseBareAppName, parseTodoIntent, parseSiteSearchIntent, parseSearchCommand, isDirectResearchQuestion, parseCloseIntent, parseMusicIntent, musicSearchPolicy, echoExemptAllowed, parseDiscordIntent, toConversationMessages, normalizeConversationText, classifyLocalConversation, chooseConversationResponse, replyLocally, CONVERSATION_BRIDGE_INTENTS, parseConversationTaskIntent, CONVERSATION_TASK_INTENTS, parsePlannerIntent, stripPoliteLead, parseNaturalDate, parseNaturalTime, normalizeTimeString, normalizeTimeForStorage, formatTimeForStorage, normalizeTimeWords, calendarTimezone, CALENDAR_TIMEZONE, validateCalendarExtraction, resolveCalendarDateTime, isEchoTranscript, ECHO_WINDOW_MS, looksLikeDeterministicCommand, flowOrders, flowValidators, flowQuestion, isFlowCancel, startPendingFlow, parseNaturalDuration, recomputeFlowStep, normalizeFillerText, isFillerReply, classifyMusicAnswer, advancePendingFlow, parseCalendarFlowStart, parseEmailFlowStart, parseFileSearchIntent, rankFileResults, parseOrdinalTarget, matchBrowserTabs, containsSensitiveData, migrateMemory, addMemoryEntry, forgetMemoryMatching, searchHistory, historyForDay, summarizeMessages, parseMemoryCommand, buildRecall, answerDidMention, STOPPED_SPEECH_PATTERN, VOICE_SETTLE_MS, utteranceOverlapsPlayback, decideVoiceAction, extractEmbeddedMusicCommand, parseMusicOpenIntent, parseBrowserNeedIntent, FOLLOW_UP_WINDOW_MS, shouldArmFollowUp, parseAiDiagnoseCommand, extractEmailParts, emailToStatus, summarizeEmail, parseDiscordPingCommand, needsAiPlanning, resolveTaskReference, MUSIC_CONTROL_PATTERN, parseMusicControl, parseResearchCommand, parseOpenTabIntent, parseMusicPanelCommand, parseOpenGoogleTabIntent, parseYouTubeControl, parseDiscoveryIntent, extractDiscoveryTopic, discoveryQueriesFor, coolTopicPool, pickCoolTopic, voiceAudioQuality, voicePhoneticSimilarity, voiceDeterministicCorrection, voiceConfidencePolicy, voiceCorrectTranscript, voiceBuildCandidates, VOICE_PIPELINE_VERSION: '2.0', parseReopenTabIntent, WAKEWORD_OWW_CONFIG, wakeWordWithOwwScore, parseScreenIntent, parseCameraIntent, WAKE_TEMPLATE_DEFAULTS, wakeTemplateScore, WakeSyllableDetector, MODE_FOLLOWUP_MS, MODES, MODE_GAMES, PENDING_QUESTION_TTL_MS, PENDING_QUESTION_MAX_WINDOW_MS, createPendingQuestion, pendingQuestionActive, pendingQuestionRemainingMs, pendingQuestionWaiting, refreshPendingQuestion, cancelPendingQuestion, markPendingQuestionHandled, isPendingCancellation, parseMeridiemAnswer, pendingAnswerIsNewRequest, localTimeOfDay, greetingNormalize, parseGreetingIntent, resolveGreetingTimeOfDay, composeGreetingReply, composeGreetingFollowUp, parseModeIntent, modeIdFromName, extractModeExtra, parseModeGame, modeQuestion, modeHelpText, modeListText, validateAsrWav, asrFailureInfo, PLAYBACK_DEFAULTS, bargeFrame, playbackGateDecision, MY_TAB_URL, parseRestoreTabIntent, setCreatorVocab, findCreatorMatch, matchKnownPhrase, correctCreatorQuery, extractCreatorSearch, RESPONSE_ENVELOPE_KEYS, looksLikeResponseEnvelope, recoverEnvelopeText, answerQuality, echoTokens, stripInternalAnnotations, normalizeDisplayText, toNaturalSpeech, prepareResponse, numberToWords, numberToWordsPoint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.JarvisCore = api;
})();
