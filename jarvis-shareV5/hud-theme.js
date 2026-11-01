'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.JarvisHudThemeCore = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const PALETTES = Object.freeze({
    blue: Object.freeze({ cyan: '#56e9ff', blue: '#19a9e4', mint: '#43e9c4', red: '#ff7186', purple: '#b496ff', hue: '0deg' }),
    happy: Object.freeze({ cyan: '#85fff0', blue: '#27cddd', mint: '#56f4b9', red: '#ff8294', purple: '#c2aaff', hue: '-9deg' }),
    sad: Object.freeze({ cyan: '#82b9ff', blue: '#3d78df', mint: '#72c9ec', red: '#ff8294', purple: '#9b9fff', hue: '27deg' }),
    frustrated: Object.freeze({ cyan: '#ff91a4', blue: '#df4d6d', mint: '#ffab8e', red: '#ff7186', purple: '#e483b8', hue: '154deg' }),
    curious: Object.freeze({ cyan: '#62f1df', blue: '#24babc', mint: '#74eacb', red: '#ff8294', purple: '#a7a0ff', hue: '-15deg' }),
    love: Object.freeze({ cyan: '#ff8fc7', blue: '#c94f94', mint: '#ffb0d8', red: '#ff7186', purple: '#dc8cff', hue: '148deg' }),
    spiderman: Object.freeze({ cyan: '#ff465d', blue: '#c20f2f', mint: '#ff8290', red: '#f20d35', purple: '#ff9aaa', hue: '170deg' }),
    // Venom is the symbiote counterpart to Karen's Spider-Man mode. The core
    // is violet, the secondary ink is deep purple, and red is reserved for the
    // tongue/alert accent rather than the whole HUD.
    venom: Object.freeze({ cyan: '#b96bff', blue: '#6d21c9', mint: '#e7ccff', red: '#ff3d6e', purple: '#a855f7', hue: '92deg' }),
    thinking: Object.freeze({ cyan: '#91c9ff', blue: '#416ee5', mint: '#63dce9', red: '#ff8294', purple: '#9b8eff', hue: '24deg' }),
    // MEDIA REACTIVE needs a real base palette: without it `selectedPalette()`
    // returned undefined colors whenever no media mood had been detected yet,
    // so choosing that theme changed nothing until a track started playing.
    media: Object.freeze({ cyan: '#7dd6ff', blue: '#2f8fe8', mint: '#59e7d2', red: '#ff8fa8', purple: '#b49bff', hue: '4deg' }),
    rgb: Object.freeze({ cyan: '#56e9ff', blue: '#19a9e4', mint: '#43e9c4', red: '#ff7186', purple: '#b496ff', hue: '0deg' })
  });
  const COLOR_KEYS = Object.freeze(['cyan', 'blue', 'mint', 'red', 'purple']);

  function mixHex(from, to, amount) {
    const a = String(from).match(/[\da-f]{2}/gi) || [], b = String(to).match(/[\da-f]{2}/gi) || [];
    if (a.length < 3 || b.length < 3) return from;
    const channels = a.map((value, index) => Math.round(parseInt(value, 16) + (parseInt(b[index], 16) - parseInt(value, 16)) * amount));
    return `#${channels.map(value => value.toString(16).padStart(2, '0')).join('')}`;
  }


  function vividHex(value, minLightness = 0.64) {
    const hex = String(value || '').replace('#', '');
    const parts = hex.match(/[\da-f]{2}/gi);
    if (!parts || parts.length < 3) return value;
    let [r, g, b] = parts.slice(0, 3).map(part => parseInt(part, 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let h = 0, s = 0, l = (max + min) / 2;
    if (delta) {
      s = delta / (1 - Math.abs(2 * l - 1));
      h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
      h = (h * 60 + 360) % 360;
    }
    l = Math.max(l, minLightness);
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    const rgb = h < 60 ? [c,x,0] : h < 120 ? [x,c,0] : h < 180 ? [0,c,x] : h < 240 ? [0,x,c] : h < 300 ? [x,0,c] : [c,0,x];
    return '#' + rgb.map(channel => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('');
  }

  function moodForEmotion(value) {
    const emotion = String(value || '').toLowerCase();
    if (/love|loving|romantic|affection|adore|crush|compassion|tender|warmth|warm/.test(emotion)) return 'love';
    if (/happy|excited|proud|celebrat|playful|amused|joy/.test(emotion)) return 'happy';
    if (/sad|lonely|disappoint|tired|exhaust|sympathetic/.test(emotion)) return 'sad';
    if (/angry|frustrat/.test(emotion)) return 'frustrated';
    if (/curious|curiosity|surpris/.test(emotion)) return 'curious';
    return 'blue';
  }

  function validTheme(value) {
    return value === 'auto' || value === 'media' || value === 'custom' || Object.prototype.hasOwnProperty.call(PALETTES, value);
  }

  function hueOfHex(value) {
    const match = String(value || '').match(/^#([\da-f]{6})$/i);
    if (!match) return 187;
    const rgb = match[1].match(/[\da-f]{2}/gi).map(channel => parseInt(channel, 16) / 255);
    const max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min;
    if (!delta) return 0;
    let hue = max === rgb[0] ? ((rgb[1] - rgb[2]) / delta) % 6 : max === rgb[1] ? (rgb[2] - rgb[0]) / delta + 2 : (rgb[0] - rgb[1]) / delta + 4;
    hue *= 60;
    return hue < 0 ? hue + 360 : hue;
  }

  function createController(options = {}) {
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const root = options.root || (doc && doc.documentElement);
    const select = options.select || null;
    const colorInput = options.colorInput || null;
    const storage = options.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const now = options.now || Date.now;
    let choice = 'auto', mood = 'blue', mediaMood = '', mode = 'IDLE', thinkingActive = false, thinkingTimer = 0, mediaLevel = 0, mediaUpdatedAt = 0, customColor = '#56e9ff';

    try {
      const saved = storage && storage.getItem('jarvis-hud-theme');
      if (validTheme(saved)) choice = saved;
      const savedColor = storage && storage.getItem('jarvis-hud-custom-color');
      if (savedColor && /^#[\da-f]{6}$/i.test(savedColor)) customColor = savedColor;
    } catch {}

    function selectedPalette() {
      const name = choice === 'auto' ? (thinkingActive ? 'thinking' : (mediaMood || mood)) : choice === 'media' ? (mediaMood || 'media') : choice;
      if (name === 'custom') {
        // The picker is an exact user choice. Brightening it here made pink,
        // purple, and red palettes drift toward pale cyan and left a blue cast.
        const accent = customColor;
        const hue = hueOfHex(accent);
        const rotation = ((hue - 187 + 540) % 360) - 180;
        return {
          name,
          cyan: accent,
          blue: mixHex('#171014', accent, 0.54),
          mint: mixHex(accent, '#f0fff9', 0.27),
          red: mixHex(accent, '#ff5877', 0.38),
          purple: mixHex(accent, '#c6a9ff', 0.48),
          hue: `${rotation}deg`
        };
      }
      if (name !== 'media') return { name, ...PALETTES[name] };
      const palette = {};
      const level = Math.max(0, Math.min(1, mediaLevel));
      for (const key of COLOR_KEYS) palette[key] = mixHex(PALETTES.media[key], PALETTES.happy[key], level);
      palette.hue = `${4 - 12 * level}deg`;
      return { name, ...palette };
    }

    function apply() {
      const palette = selectedPalette();
      if (root && root.style && typeof root.style.setProperty === 'function') {
        for (const key of COLOR_KEYS) root.style.setProperty(`--${key}`, palette[key]);
        root.style.setProperty('--hud-hue', palette.hue || '0deg');
        // Neutral graphite surfaces avoid leaving a navy cast under red, pink, or custom colors.
        root.style.setProperty('--hud-blue-ink', mixHex('#111116', palette.blue, 0.18));
        root.style.setProperty('--hud-bg', mixHex('#090a0e', palette.blue, 0.15));
        root.style.setProperty('--hud-panel', mixHex('#101116', palette.blue, 0.18));
        root.style.setProperty('--hud-panel-raised', mixHex('#17191f', palette.cyan, 0.16));
        root.style.setProperty('--hud-panel-edge', mixHex('#32343b', palette.cyan, 0.34));
        root.style.setProperty('--hud-halo', mixHex('#190c12', palette.blue, 0.22));
        // The glow belongs to the active palette. Using the custom-color
        // default here left a blue halo around pink, red and amber themes.
        const glowBase = palette.name === 'custom' ? customColor : palette.cyan;
        root.style.setProperty('--hud-glow', mixHex(glowBase, '#ffffff', 0.12));
        root.style.setProperty('--hud-ink', mixHex('#07070a', palette.blue, 0.1));
        if (root.dataset) root.dataset.theme = palette.name;
      }
      const venom = palette.name === 'venom';
      const karen = palette.name === 'spiderman';
      const coreName = doc && typeof doc.querySelector === 'function' && doc.querySelector('.core-wordmark h2');
      if (coreName) coreName.textContent = venom ? 'VENOM' : karen ? 'KAREN' : 'JARVIS';
      const coreLabel = doc && typeof doc.querySelector === 'function' && doc.querySelector('.hero>.section-label');
      if (coreLabel) coreLabel.textContent = venom
        ? 'VENOM ARTIFICIAL INTELLIGENCE CORE'
        : karen ? 'KAREN ARTIFICIAL INTELLIGENCE CORE' : 'JARVIS ARTIFICIAL INTELLIGENCE CORE';
      // The subtitle and build line are part of the identity, not generic
      // decoration. Switch them with the active assistant so Venom does not
      // inherit the JARVIS wording.
      const coreSub = doc && typeof doc.querySelector === 'function' && doc.querySelector('.core-wordmark span');
      if (coreSub) coreSub.textContent = venom ? 'SYMBIOTE CORE' : 'AI CORE';
      const coreVer = doc && typeof doc.querySelector === 'function' && doc.querySelector('.corever');
      if (coreVer) coreVer.textContent = venom ? 'SYMBIOTE SYSTEM · V 1.0' : 'PERSONAL SYSTEM · V 1.0';
      // The app reacts to this event to swap the assistant name, wake word and
      // listening labels without polling the DOM.
      try {
        if (doc && typeof doc.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          doc.dispatchEvent(new CustomEvent('jarvis-theme-change', { detail: { name: palette.name, choice, customColor } }));
        }
      } catch {}
      return palette;
    }

    function setTheme(value, persist = true) {
      if (!validTheme(value)) return false;
      choice = value;
      if (select && select.value !== value) select.value = value;
      if (persist) { try { storage && storage.setItem('jarvis-hud-theme', value); } catch {} }
      apply();
      return true;
    }

    function setColor(value, persist = true) {
      if (!/^#[\da-f]{6}$/i.test(String(value || ''))) return false;
      customColor = String(value).toLowerCase();
      if (colorInput && colorInput.value !== customColor) colorInput.value = customColor;
      choice = 'custom';
      if (select && select.value !== choice) select.value = choice;
      if (persist) {
        try { storage && storage.setItem('jarvis-hud-theme', choice); storage && storage.setItem('jarvis-hud-custom-color', customColor); } catch {}
      }
      apply();
      return true;
    }

    if (select) {
      select.value = choice;
      if (typeof select.addEventListener === 'function') select.addEventListener('change', () => setTheme(select.value));
    }
    if (colorInput) {
      colorInput.value = customColor;
      if (typeof colorInput.addEventListener === 'function') {
        colorInput.addEventListener('input', () => setColor(colorInput.value, false));
        colorInput.addEventListener('change', () => setColor(colorInput.value, true));
      }
    }
    const controller = {
      setTheme,
      setColor,
      setMode(value) {
        const nextMode = String(value || 'IDLE').toUpperCase();
        const shouldThink = nextMode === 'THINKING' || nextMode === 'SEARCHING';
        if (nextMode !== mode || !shouldThink) {
          if (thinkingTimer) clearTimeout(thinkingTimer);
          thinkingTimer = 0;
          thinkingActive = false;
        }
        mode = nextMode;
        if (shouldThink && !thinkingActive && !thinkingTimer) {
          thinkingTimer = setTimeout(() => { thinkingTimer = 0; if (mode === nextMode) { thinkingActive = true; apply(); } }, 4200);
        }
        return apply();
      },
      setMood(value) { mood = moodForEmotion(value); return choice === 'auto' ? apply() : selectedPalette(); },
      setMediaMood(value, active = true) {
        mediaMood = active ? moodForEmotion(value) : '';
        return (choice === 'auto' || choice === 'media') ? apply() : selectedPalette();
      },
      updateMedia(metrics) {
        if (choice !== 'media') return selectedPalette();
        const time = Number(now());
        if (time - mediaUpdatedAt < 140) return selectedPalette();
        mediaUpdatedAt = time;
        const level = Math.max(0, Math.min(1, Number(metrics && metrics.level) || 0));
        if (Math.abs(level - mediaLevel) < 0.025) return selectedPalette();
        mediaLevel = level;
        return apply();
      },
      current() { return { choice, mood, mediaMood, mode, thinkingActive, mediaLevel, customColor, palette: selectedPalette() }; },
      isKaren() { return selectedPalette().name === 'spiderman'; },
      isVenom() { return selectedPalette().name === 'venom'; }
    };
    apply();
    return controller;
  }

  return { PALETTES, COLOR_KEYS, createController, moodForEmotion, validTheme, hueOfHex };
});
