'use strict';
// =====================================================================
// MUSIC ORB — AUDIO REACTOR ENGINE (2026-11-01)
// A shared 3D holographic reactor replaces the old circle-plus-glow look in
// every presentation of the Music Orb: floating strip, compact bubble,
// expanded stage and full-screen Music Mode. It augments window.MusicOrb
// in-place (it must load AFTER music-orb.js), so playback, media sessions,
// capture, seek, volume, diagnostics and the animation loop are untouched.
//
// Depth is real layering: every mechanical ring is drawn in two halves
// (rear half behind the core, front half in front of it), each band has its
// own 3D tilt and rotation axis, and the mechanical outer ring is a
// segmented engineered structure — not extra circular borders. Every
// reactive input (core pulse, conduit flow, segment illumination, corona
// ticks) is mapped from the measured Windows output FFT buckets in
// stream.bars (bass/lowMid/mid/high are real frequency bands, never
// invented). With no capture the reactor settles into a calm idle shell.
//
// Theme personality: colours come from the live HUD palette, and each theme
// also gets its own motion/energy tuning below. The suit-red/gold identity
// of the physical armour is untouched; the orb follows the theme fully.
// =====================================================================
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const attach = () => {
    const orb = window.MusicOrb;
    if (!orb || typeof orb !== 'object' || orb.__reactorUpgraded) return false;
    upgrade(orb);
    return true;
  };

  const TAU = Math.PI * 2;
  const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));

  function channels(value) {
    const text = String(value || '').trim();
    let match = text.match(/^#([0-9a-f]{6})$/i);
    if (match) {
      const packed = parseInt(match[1], 16);
      return { r: (packed >> 16) & 255, g: (packed >> 8) & 255, b: packed & 255 };
    }
    match = text.match(/rgba?\(([^)]+)\)/i);
    if (match) {
      const parts = match[1].split(',').map(Number);
      if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) return { r: parts[0], g: parts[1], b: parts[2] };
    }
    return { r: 86, g: 233, b: 255 };
  }
  function rgba(color, alpha) {
    const c = channels(color);
    const a = Math.max(0, Math.min(1, Number(alpha) || 0));
    return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${a.toFixed(3)})`;
  }
  function mixHex(a, b, amount) {
    const x = channels(a), y = channels(b);
    const t = Math.max(0, Math.min(1, Number(amount) || 0));
    const r = Math.round(x.r + (y.r - x.r) * t);
    const g = Math.round(x.g + (y.g - x.g) * t);
    const bl = Math.round(x.b + (y.b - x.b) * t);
    return '#' + [r, g, bl].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  // Linear interpolation over the 12 measured buckets, mirroring the helper
  // inside music-orb.js so the reactor reads the same spectrum.
  function spectrumAt(bars, position) {
    if (!Array.isArray(bars) || !bars.length) return 0;
    const clamped = Math.max(0, Math.min(0.9999, clamp01(position)));
    const scaled = clamped * (bars.length - 1);
    const index = Math.floor(scaled);
    const next = Math.min(bars.length - 1, index + 1);
    const frac = scaled - index;
    return clamp01(bars[index] + (bars[next] - bars[index]) * frac);
  }
  function hashString(text) {
    let hash = 2166136261;
    const source = String(text || 'jarvis');
    for (let i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash >>> 0;
  }
  function seededRandom(seed) {
    let state = (seed >>> 0) || 1;
    return () => {
      state ^= state << 13; state >>>= 0;
      state ^= state >> 17;
      state ^= state << 5; state >>>= 0;
      return (state >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------------
  // Theme personality. Colour = live palette; motion/energy per theme so
  // every mood changes atmosphere and movement, not just hue.
  // ------------------------------------------------------------------
  function reactorPalette(orb) {
    const now = performance.now();
    if (orb._reactorPal && now - orb._reactorPalAt < 320) return orb._reactorPal;
    const theme = document.documentElement.dataset.theme || 'blue';
    const read = name => {
      let value = '';
      try { value = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch {}
      return value;
    };
    const pal = {
      theme,
      cyan: read('--cyan') || '#43dcff',
      blue: read('--blue') || '#1a86e0',
      mint: read('--mint') || '#84d8ef',
      red: read('--red') || '#ff7186',
      purple: read('--purple') || '#93b4ff',
      ice: read('--hud-ice') || '#b8e9ff',
      atmo: read('--hud-atmo') || '#123a5e',
      slate: read('--hud-slate') || '#0e2233',
      motion: 1, energy: 1, glow: 1, scan: 0
    };
    pal.energyColor = pal.cyan;
    pal.ringColor = pal.cyan;
    pal.secondary = pal.mint;
    switch (theme) {
      case 'happy': pal.motion = 1.3; pal.energy = 1.25; pal.secondary = pal.cyan; break;
      case 'sad': pal.motion = 0.52; pal.energy = 0.7; pal.glow = 0.72; break;
      case 'frustrated':
        pal.ringColor = pal.red; pal.energyColor = pal.red; pal.secondary = pal.red;
        pal.energy = 1.18; pal.motion = 1.08; break;
      case 'curious': pal.ringColor = pal.mint; pal.secondary = pal.ice; pal.motion = 1.16; pal.scan = 1; break;
      case 'thinking': pal.energyColor = pal.ice; pal.ringColor = pal.cyan; pal.motion = 0.85; pal.scan = 0.4; break;
      case 'love': pal.motion = 0.92; pal.secondary = pal.red; break;
      case 'venom': pal.ringColor = pal.cyan; pal.secondary = pal.purple; pal.motion = 1.12; break;
      case 'spiderman':
        pal.ringColor = pal.red; pal.energyColor = pal.red; pal.secondary = pal.ice;
        pal.motion = 1.2; pal.energy = 1.15; break;
      case 'media': pal.motion = 1.05; break;
      case 'rgb': {
        // Smooth spectrum rotation: internal energy and the mechanical ring
        // walk the wheel together (the CSS layer animates --cyan/--blue, and
        // this time-based lift keeps the canvas colours coordinated with it).
        const hue = (now * 0.0075) % 360;
        const shift = hex => {
          const c = channels(hex);
          const max = Math.max(c.r, c.g, c.b) / 255, min = Math.min(c.r, c.g, c.b) / 255;
          const l = (max + min) / 2;
          const d = max - min;
          let h = 0, s = 0;
          if (d) {
            s = d / (1 - Math.abs(2 * l - 1));
            const r = c.r / 255, g = c.g / 255, b = c.b / 255;
            h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            h = (h * 60 + 360) % 360;
          }
          const c2 = (1 - Math.abs(2 * l - 1)) * s;
          const x = c2 * (1 - Math.abs((h / 60) % 2 - 1));
          const m = l - c2 / 2;
          const rot = (h + hue) % 360;
          const rgb = rot < 60 ? [c2, x, 0] : rot < 120 ? [x, c2, 0] : rot < 180 ? [0, c2, x] : rot < 240 ? [0, x, c2] : rot < 300 ? [x, 0, c2] : [c2, 0, x];
          return '#' + rgb.map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
        };
        pal.cyan = shift(pal.cyan); pal.blue = shift(pal.blue); pal.mint = shift(pal.mint);
        pal.energyColor = pal.cyan; pal.ringColor = pal.cyan; pal.secondary = pal.mint;
        break;
      }
      default: break;
    }
    orb._reactorPal = pal;
    orb._reactorPalAt = now;
    return pal;
  }

  // ------------------------------------------------------------------
  // Geometry: a ring segment on a 3D-tilted ellipse. The tilt squashes the
  // ellipse vertically (k) and the lower half of the squash is the half
  // facing the viewer.
  // ------------------------------------------------------------------
  function ringPoint(cx, cy, radius, k, angle) {
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius * k
    };
  }
  function radialAngle(angle, k) {
    // Screen-space direction of the local radius vector.
    return Math.atan2(Math.sin(angle) * k, Math.cos(angle));
  }
  function isFrontHalf(angle, k) {
    return Math.sin(angle) >= 0; // lower half of the flattened ellipse
  }

  // One mechanical segmented band. driver === 'spectrum' maps each segment to
  // a mirrored spectrum bucket; driver === 'high' lights the whole band with
  // the measured high band instead. half === 'back' draws the far side thin.
  function drawBandSegment(orb, ctx, def, m, P) {
    const { cx, cy } = def;
    // structural under-ring keeps the band attached to the core
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, def.k);
    ctx.strokeStyle = rgba(P.blue, def.back ? 0.16 : 0.3);
    ctx.lineWidth = Math.max(1, def.radius * 0.012);
    ctx.beginPath(); ctx.arc(0, 0, def.radius, 0, TAU); ctx.stroke();
    ctx.restore();

    for (let index = 0; index < def.segs; index++) {
      const unit = index / def.segs;
      const angle = def.rot + unit * TAU;
      if (isFrontHalf(angle, def.k) !== !def.back) continue;
      let energy = 0;
      if (def.driver === 'spectrum') {
        const mirrored = unit <= 0.5 ? unit * 2 : (1 - unit) * 2;
        energy = spectrumAt(m.bars, mirrored);
      } else if (def.driver === 'high') {
        energy = clamp01(m.high * 1.35 - 0.35 * Math.abs(unit - 0.5));
      } else if (def.driver === 'mid') {
        energy = clamp01(m.mid * 1.1 + 0.1 * Math.sin(unit * TAU * 3 + def.rot * 5));
      } else {
        energy = clamp01(m.lowMid * 1.1);
      }
      const facing = isFrontHalf(angle, def.k) ? 1 : 0.42;
      const push = def.radius * def.out * m.bass * m.dynamics * def.outMul;
      const radius = def.radius + push;
      const point = ringPoint(cx, cy, radius, def.k, angle);
      const localAngle = radialAngle(angle, def.k);
      const segArc = (TAU / def.segs) * def.cover;
      const tangentWidth = Math.max(2.2, radius * segArc * 0.72);
      const plateLength = def.height;
      const alpha = def.baseAlpha * facing * (def.back ? m.act * 0.5 : 1);
      ctx.save();
      ctx.translate(point.x, point.y);
      ctx.rotate(localAngle);
      // plate body
      ctx.beginPath();
      ctx.roundRect(-plateLength * 0.22, -tangentWidth / 2, plateLength, tangentWidth, Math.min(6, tangentWidth * 0.4));
      const tone = energy > 0.45 ? P.ice : (def.warm ? P.ringColor : P.blue);
      ctx.fillStyle = rgba(mixHex(tone, P.blue, 0.62), alpha * (0.5 + 0.5 * energy));
      ctx.fill();
      ctx.lineWidth = Math.max(0.8, Math.min(2, radius * 0.006));
      ctx.strokeStyle = rgba(P.ringColor, alpha * (0.36 + 0.6 * energy));
      ctx.stroke();
      // leading edge light
      if (energy > 0.05 && !def.back) {
        ctx.fillStyle = rgba(m.defHighlight, alpha * energy * 0.9);
        ctx.fillRect(plateLength * 0.7, -tangentWidth * 0.28, Math.max(2, plateLength * 0.14), tangentWidth * 0.56);
      }
      ctx.restore();
      // edge cap: a small bolt on each segment of the front half
      if (!def.back && facing === 1 && def.bolt) {
        ctx.save();
        ctx.translate(point.x, point.y);
        ctx.rotate(localAngle);
        ctx.fillStyle = rgba(P.ice, alpha * (0.5 + 0.5 * energy));
        ctx.beginPath(); ctx.arc(plateLength * 0.06, 0, Math.max(1, tangentWidth * 0.14), 0, TAU); ctx.fill();
        ctx.restore();
      }
    }
  }

  // ------------------------------------------------------------------
  // Stage backdrop and projection deck (expanded stage / Music Mode).
  // ------------------------------------------------------------------
  function drawBackdrop(orb, ctx, L, m, P) {
    if (L.stage === 'compact') {
      const aura = ctx.createRadialGradient(L.cx, L.cy, L.R * 0.22, L.cx, L.cy, L.R * 2.4);
      aura.addColorStop(0, rgba(P.energyColor, 0.12 + 0.2 * m.intensity));
      aura.addColorStop(0.55, rgba(P.blue, 0.05 + 0.06 * m.lowMid));
      aura.addColorStop(1, rgba(P.blue, 0));
      ctx.fillStyle = aura;
      ctx.beginPath(); ctx.arc(L.cx, L.cy, L.R * 2.4, 0, TAU); ctx.fill();
      return;
    }
    ctx.save();
    const glow = ctx.createRadialGradient(L.cx, L.cy, L.R * 0.4, L.cx, L.cy, Math.max(L.W, L.H) * 0.72);
    glow.addColorStop(0, rgba(P.ringColor, 0.1 + 0.14 * m.intensity));
    glow.addColorStop(0.42, rgba(P.atmo, 0.28));
    glow.addColorStop(1, rgba(P.atmo, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, L.W, L.H);
    // far telemetry: a faint lattice ofticks around the reactor
    ctx.strokeStyle = rgba(P.slate, 0.5);
    ctx.lineWidth = 1;
    const marks = L.stage === 'music' ? 64 : 40;
    for (let index = 0; index < marks; index++) {
      const angle = (index / marks) * TAU;
      const inner = L.R * 2.28;
      const outer = inner + (index % 4 === 0 ? L.R * 0.085 : L.R * 0.045);
      ctx.globalAlpha = index % 2 ? 0.22 : 0.13;
      ctx.beginPath();
      ctx.moveTo(L.cx + Math.cos(angle) * inner, L.cy + Math.sin(angle) * inner);
      ctx.lineTo(L.cx + Math.cos(angle) * outer, L.cy + Math.sin(angle) * outer);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // projection deck under the reactor
    const deckY = L.cy + L.R * 1.62;
    const pool = ctx.createRadialGradient(L.cx, deckY, 1, L.cx, deckY, L.R * 1.6);
    pool.addColorStop(0, rgba(P.ringColor, 0.2));
    pool.addColorStop(1, rgba(P.ringColor, 0));
    ctx.fillStyle = pool;
    ctx.beginPath(); ctx.ellipse(L.cx, deckY, L.R * 1.6, L.R * 0.3, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = rgba(P.ringColor, 0.24);
    ctx.setLineDash([6, 9]);
    ctx.lineDashOffset = -m.t * 0.004;
    ctx.beginPath(); ctx.ellipse(L.cx, deckY, L.R * 1.42, L.R * 0.26, 0, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ------------------------------------------------------------------
  // Spectrum corona: the measured spectrum wrapped upwinding around the
  // reactor, mirrored so low frequencies colour both sides of the centre.
  // ------------------------------------------------------------------
  function drawSpectrumCorona(orb, ctx, L, m, P) {
    if (L.skipCorona) return;
    const count = L.detail > 1 ? 64 : 40;
    const inner = L.R * 1.98;
    const reach = L.R * (0.3 + 0.34 * m.dynamics);
    ctx.save();
    ctx.lineCap = 'round';
    for (let index = 0; index < count; index++) {
      const unit = index / count;
      const mirrored = unit <= 0.5 ? unit * 2 : (1 - unit) * 2;
      const value = spectrumAt(m.bars, mirrored);
      const peak = spectrumAt(m.peaks, mirrored);
      const angle = -Math.PI / 2 + unit * TAU - m.coronaRot;
      const start = inner;
      const end = inner + reach * value;
      const bandStart = 0.3, bandBreak = 0.64;
      const ring = mirrored < bandStart ? P.blue : mirrored < bandBreak ? P.ringColor : P.ice;
      ctx.strokeStyle = rgba(ring, m.live ? 0.28 + 0.55 * value : 0.2);
      ctx.lineWidth = Math.max(1, L.R * (value > 0.55 ? 0.022 : 0.013));
      ctx.beginPath();
      const p0 = ringPoint(L.cx, L.cy, start, 1, angle);
      const p1 = ringPoint(L.cx, L.cy, end, 1, angle);
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
      if (m.live && peak > 0.28 && index % 2 === 0) {
        const capPoint = ringPoint(L.cx, L.cy, inner + reach * peak + L.R * 0.045, 1, angle);
        ctx.fillStyle = rgba(P.secondary, 0.85);
        ctx.fillRect(capPoint.x - 1.6, capPoint.y - 1.6, 3.2, 3.2);
      }
    }
    // outer hairline keeps the corona attached to the instrument
    ctx.strokeStyle = rgba(P.slate, 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(L.cx, L.cy, inner - L.R * 0.06, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------------
  // Deck spectrum: a slim mirrored bar platform sitting low on the stage,
  // connected to the deck so the frequency data feels part of the reactor.
  // 'waveform' and 'mirror' change its layout; 'circular' stays in the ring.
  // ------------------------------------------------------------------
  function drawDeckBars(orb, ctx, L, m, P) {
    if (L.stage !== 'expanded' && L.stage !== 'music') return;
    if (m.style === 'circular') return;
    const bandCount = m.style === 'waveform' ? 14 : 22;
    const spread = L.stage === 'music' ? Math.min(L.W * 0.42, L.R * 3.1) : Math.min(L.W * 0.34, L.R * 3.3);
    const startX = L.cx - spread / 2;
    const baseY = Math.min(L.cy + L.R * 2.16, L.H - 16);
    const maxH = L.R * 0.46;
    ctx.save();
    if (m.style === 'waveform') {
      ctx.strokeStyle = rgba(P.ringColor, m.live ? 0.85 : 0.4);
      ctx.lineWidth = Math.max(1.2, L.R * 0.024);
      ctx.shadowColor = rgba(P.ringColor, 0.5);
      ctx.shadowBlur = 6 * m.dynamics;
      ctx.beginPath();
      for (let step = 0; step <= 96; step++) {
        const unit = step / 96;
        const mirrored1 = unit <= 0.5 ? unit * 2 : (1 - unit) * 2;
        const value = spectrumAt(m.bars, mirrored1);
        const x = startX + unit * spread;
        const y = baseY - Math.max(1.5, maxH * value * (m.live ? 0.3 + 0.7 * m.dynamics : 0.14));
        if (step === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    } else {
      const mirror = m.style === 'mirror';
      const step = spread / (bandCount - 1);
      const width = Math.max(2, Math.min(step * 0.42, L.R * 0.078));
      for (let index = 0; index < bandCount; index++) {
        const unit = index / (bandCount - 1);
        const local = mirror ? (unit <= 0.5 ? unit * 2 : (1 - unit) * 2) : unit;
        const value = spectrumAt(m.bars, local);
        const height = Math.max(2, maxH * value * (m.live ? 0.28 + 0.72 * m.dynamics : 0.14));
        const x = startX + index * step - width / 2;
        const ring = index < bandCount * 0.28 ? P.blue : index < bandCount * 0.62 ? P.ringColor : P.ice;
        const grad = ctx.createLinearGradient(0, baseY, 0, baseY - maxH);
        grad.addColorStop(0, rgba(ring, 0.9));
        grad.addColorStop(0.6, rgba(mixHex(ring, P.ice, 0.55), 0.92));
        grad.addColorStop(1, rgba(P.ice, 0.95));
        ctx.fillStyle = grad;
        if (height > 4) { ctx.shadowColor = rgba(ring, 0.55 * m.glow); ctx.shadowBlur = Math.min(12, height * 0.4); }
        ctx.beginPath(); ctx.roundRect(x, baseY - height, width, height, Math.min(width / 2, 4)); ctx.fill();
        ctx.shadowBlur = 0;
        // deck reflection
        ctx.globalAlpha = 0.22;
        ctx.beginPath(); ctx.roundRect(x, baseY + 3, width, height * 0.42, 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = rgba(P.slate, 0.6);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(startX - 8, baseY + 1); ctx.lineTo(startX + spread + 8, baseY + 1); ctx.stroke();
    }
    // band labels keep the instrument readable
    ctx.fillStyle = rgba(P.slate, 0.95);
    ctx.font = `${Math.max(7, Math.round(L.R * 0.11))}px Consolas, monospace`;
    ctx.textAlign = 'left'; ctx.fillText('LOW', startX, baseY + 15);
    ctx.textAlign = 'center'; ctx.fillText('MID', L.cx, baseY + 15);
    ctx.textAlign = 'right'; ctx.fillText('HIGH', startX + spread, baseY + 15);
    ctx.restore();
  }

  // ------------------------------------------------------------------
  // Compact bubble rail: right hand micro-bars sharing the same language.
  // ------------------------------------------------------------------
  function drawRail(orb, ctx, L, m, P) {
    const startX = L.cx + L.R * 2.0, endX = L.W - 16;
    const baseY = L.H - 22, maxH = L.H * 0.5;
    const spacing = (endX - startX) / Math.max(1, m.bars.length - 1);
    ctx.save();
    ctx.strokeStyle = rgba(P.slate, 0.55);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(startX - 6, baseY + 1); ctx.lineTo(endX + 6, baseY + 1); ctx.stroke();
    for (let index = 0; index < m.bars.length; index++) {
      const value = clamp01(m.bars[index]);
      const peak = clamp01(m.peaks[index]);
      const scaler = m.live ? 0.24 + 0.76 * m.dynamics : 0.12;
      const height = Math.max(2, maxH * value * scaler);
      const width = Math.max(2, Math.min(7, spacing * 0.5));
      const x = startX + index * spacing - width / 2;
      const ring = index < 4 ? P.blue : index < 8 ? P.ringColor : P.ice;
      ctx.fillStyle = rgba(ring, 0.95);
      if (height > 4) { ctx.shadowColor = rgba(ring, 0.5); ctx.shadowBlur = Math.min(9, height * 0.45); }
      ctx.beginPath(); ctx.roundRect(x, baseY - height, width, height, Math.min(width / 2, 3)); ctx.fill();
      ctx.shadowBlur = 0;
      if (peak > 0.04) {
        const capY = baseY - Math.max(3, maxH * peak * scaler);
        ctx.fillStyle = rgba(P.secondary, 0.85);
        ctx.fillRect(x - 0.8, capY - 1.6, width + 1.6, 2);
      }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------
  // Generative art disc. The pipeline carries no real album artwork — only
  // title/artist from the Windows media session — so the plate is a
  // deterministic holographic "identity disc" derived from the track data,
  // the same presentation every track change keeps stable.
  // ------------------------------------------------------------------
  function drawArtDisc(orb, ctx, L, m, P) {
    if (!L.art || L.W < 540) return;
    const identity = orb.identity || {};
    const key = identity.title || identity.app || '';
    if (!key) return;
    const discX = L.artX, discY = L.cy, radius = L.R * 0.86;
    const seed = hashString(key);
    const rand = seededRandom(seed);
    if (orb._artSeed !== seed) {
      orb._artSeed = seed;
      orb._artRings = Array.from({ length: 5 }, (_, ring) => ({
        base: 0.34 + ring * 0.15 + rand() * 0.04,
        cut: rand() * TAU,
        span: TAU * (0.4 + rand() * 0.5),
        dash: ring % 2 ? [4, 7] : [],
        tint: rand()
      }));
    }
    ctx.save();
    ctx.translate(discX, discY);
    // base plate
    const plate = ctx.createRadialGradient(-radius * 0.3, -radius * 0.35, 1, 0, 0, radius);
    plate.addColorStop(0, rgba(P.blue, 0.34));
    plate.addColorStop(0.72, rgba(P.atmo, 0.24));
    plate.addColorStop(1, rgba(P.atmo, 0));
    ctx.fillStyle = plate;
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, TAU); ctx.fill();
    ctx.strokeStyle = rgba(P.ringColor, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, TAU); ctx.stroke();
    for (const ring of (orb._artRings || [])) {
      const spin = m.t * 0.00002 * (ring.base > 0.6 ? -0.9 : 1.1) + seed % 7;
      ctx.save();
      ctx.rotate(spin);
      ctx.strokeStyle = rgba(mixHex(P.ringColor, ring.tint > 0.6 ? P.secondary : P.blue, ring.tint), 0.42);
      ctx.lineWidth = Math.max(1, radius * 0.02);
      ctx.setLineDash(ring.dash);
      ctx.beginPath(); ctx.arc(0, 0, radius * ring.base, ring.cut, ring.cut + ring.span); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    // identity letters, kept readable
    const words = key.split(/\s+/).filter(Boolean).slice(0, 2);
    ctx.fillStyle = rgba(P.ice, 0.85);
    ctx.font = `600 ${Math.max(9, Math.round(radius * 0.2))}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(words.map(w => w.charAt(0).toUpperCase()).join(''), 0, 0);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  // ------------------------------------------------------------------
  // Energy core: sculpted nucleus, nutating gimbal rims, measured pulse.
  // ------------------------------------------------------------------
  function drawCore(orb, ctx, L, m, P) {
    const coreR = L.R * (0.5 + 0.2 * m.intensity * m.dyn + 0.05 * m.pulse) * (m.hover ? 1.04 : 1);
    const nutation = m.t * 0.00016 * P.motion;
    // reactor halo
    ctx.save();
    const halo = ctx.createRadialGradient(L.cx, L.cy, coreR * 0.2, L.cx, L.cy, coreR * 2.7);
    halo.addColorStop(0, rgba(P.energyColor, (0.2 + 0.25 * m.intensity) * m.glow * 0.9));
    halo.addColorStop(0.5, rgba(P.secondary, 0.09 + 0.1 * m.lowMid));
    halo.addColorStop(1, rgba(P.secondary, 0));
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(L.cx, L.cy, coreR * 2.7, 0, TAU); ctx.fill();
    ctx.restore();
    // hex casing: six machined casing arcs
    ctx.save();
    ctx.translate(L.cx, L.cy);
    for (let index = 0; index < 6; index++) {
      const angle = index * TAU / 6 + nutation * 0.6;
      const start = angle + 0.1, len = TAU / 6 - 0.2;
      ctx.strokeStyle = rgba(mixHex(P.ringColor, P.blue, 0.5), 0.5 + 0.3 * m.lowMid);
      ctx.lineWidth = Math.max(1.4, coreR * 0.1);
      ctx.beginPath(); ctx.arc(0, 0, coreR * 1.06, start, start + len); ctx.stroke();
      // casing bolts
      ctx.fillStyle = rgba(P.ice, 0.5 + 0.3 * m.mid);
      const b = ringPoint(0, 0, coreR * 1.06, 1, angle);
      ctx.beginPath(); ctx.arc(b.x, b.y, Math.max(1, coreR * 0.045), 0, TAU); ctx.fill();
    }
    ctx.restore();
    // internal gimbal rims (3D-tilted, counter-rotating)
    ctx.save();
    for (let index = 0; index < 2; index++) {
      const radius = coreR * (0.66 - index * 0.24);
      const k = 0.44 + index * 0.18 + 0.08 * Math.sin(nutation * (1.4 + index));
      const spin = m.t * (0.0004 + 0.0006 * m.mid) * (index ? -1.4 : 1) * P.motion + index * 1.3;
      ctx.save();
      ctx.translate(L.cx, L.cy);
      ctx.scale(1, k);
      ctx.rotate(spin);
      ctx.strokeStyle = rgba(index ? P.secondary : P.ice, 0.28 + 0.5 * Math.min(1, m.mid * 1.3) * m.dyn);
      ctx.lineWidth = Math.max(1, coreR * 0.035);
      ctx.setLineDash(index ? [coreR * 0.06, coreR * 0.16] : []);
      ctx.beginPath(); ctx.arc(0, 0, radius, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    ctx.restore();
    // nucleus
    ctx.save();
    const nucleon = ctx.createRadialGradient(L.cx - coreR * 0.25, L.cy - coreR * 0.3, coreR * 0.05, L.cx, L.cy, coreR);
    nucleon.addColorStop(0, 'rgba(255,255,255,0.96)');
    nucleon.addColorStop(0.34, rgba(P.ice, 0.6 + 0.35 * m.intensity));
    nucleon.addColorStop(0.72, rgba(P.ringColor, 0.3 + 0.4 * m.intensity));
    nucleon.addColorStop(1, rgba(P.blue, 0.06));
    ctx.fillStyle = nucleon;
    ctx.beginPath(); ctx.arc(L.cx, L.cy, coreR, 0, TAU); ctx.fill();
    // inner lens + specular
    ctx.globalCompositeOperation = 'screen';
    const lens = ctx.createRadialGradient(L.cx, L.cy, 1, L.cx, L.cy, coreR * 0.5);
    lens.addColorStop(0, rgba(P.energyColor, 0.4 + 0.4 * m.intensity));
    lens.addColorStop(1, rgba(P.energyColor, 0));
    ctx.fillStyle = lens;
    ctx.beginPath(); ctx.arc(L.cx, L.cy, coreR * 0.55, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // sculpted specular streak
    ctx.save();
    ctx.beginPath(); ctx.arc(L.cx, L.cy, coreR * 0.985, 0, TAU); ctx.clip();
    ctx.strokeStyle = `rgba(255,255,255,${(0.24 + 0.28 * m.intensity).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.8, coreR * 0.05);
    ctx.beginPath();
    ctx.ellipse(L.cx - coreR * 0.2, L.cy - coreR * 0.3, coreR * 0.42, coreR * 0.1, -0.62, Math.PI * 1.06, Math.PI * 1.84);
    ctx.stroke();
    ctx.restore();
    // rim
    ctx.strokeStyle = rgba(P.ice, 0.24 + 0.5 * m.intensity);
    ctx.lineWidth = Math.max(1, coreR * 0.045);
    ctx.shadowColor = rgba(P.ringColor, 0.55);
    ctx.shadowBlur = coreR * 0.24 * m.glow;
    ctx.beginPath(); ctx.arc(L.cx, L.cy, coreR * 1.01, 0, TAU); ctx.stroke();
    ctx.restore();
    return coreR;
  }

  // Energy paths: six conduits from the casing to the first band, with pulse
  // packets whose speed follows the measured mid band.
  function drawConduits(orb, ctx, L, m, P, coreR) {
    const count = 6, inner = coreR * 1.1, outer = L.R * 1.24;
    ctx.save();
    for (let index = 0; index < count; index++) {
      const angle = (index / count) * TAU + m.t * 0.00006 * P.motion;
      const a = ringPoint(L.cx, L.cy, inner, 0.22, angle);
      const b = ringPoint(L.cx, L.cy, outer, 0.22, angle);
      ctx.strokeStyle = rgba(P.ringColor, 0.14 + 0.3 * m.lowMid);
      ctx.lineWidth = Math.max(1, L.R * 0.014);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      if (m.live) {
        const travel = (m.t * 0.00024 * (0.5 + m.mid) + index / count) % 1;
        const point = ringPoint(L.cx, L.cy, inner + (outer - inner) * travel, 0.22, angle);
        ctx.fillStyle = rgba(P.ice, 0.5 + 0.5 * m.mid);
        ctx.shadowColor = rgba(P.ringColor, 0.8);
        ctx.shadowBlur = 5;
        ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(1.1, L.R * 0.018), 0, TAU); ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    ctx.restore();
  }

  // Measured transient shock rings, retained from the old pipeline.
  function drawShockRings(orb, ctx, L, m, P) {
    const now = m.t || performance.now();
    if (!m.frozen && m.live && m.pulse > 0.45 && now - (orb.lastImpactAt || 0) > 260) {
      orb.lastImpactAt = now;
      (orb.impactRings || (orb.impactRings = [])).push({ born: now, strength: Math.max(m.pulse, m.intensity * 0.72) });
      if (orb.impactRings.length > 4) orb.impactRings.shift();
    }
    const rings = orb.impactRings || (orb.impactRings = []);
    for (let index = rings.length - 1; index >= 0; index--) {
      const shock = rings[index];
      const progress = clamp01((now - shock.born) / 720);
      if (progress >= 1) { rings.splice(index, 1); continue; }
      const fade = (1 - progress) * (1 - progress) * shock.strength;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.strokeStyle = rgba(P.ice, 0.9);
      ctx.lineWidth = Math.max(1, L.R * (0.05 * (1 - progress) + 0.01));
      ctx.shadowColor = rgba(P.ringColor, 0.8);
      ctx.shadowBlur = L.R * 0.16 * fade;
      ctx.beginPath(); ctx.arc(L.cx, L.cy, L.R * (1.2 + progress * 1.5), 0, TAU); ctx.stroke();
      ctx.restore();
    }
  }

  // Track progress arc around the outer instrument when duration is known.
  function drawTrackArc(orb, ctx, L, m, P) {
    if (!L.trackArc) return;
    const duration = orb.seekDuration();
    if (!(duration > 0)) return;
    const radius = Math.min(L.R * (L.stage === 'music' ? 2.42 : 2.18), Math.min(L.W, L.H) / 2 - 8);
    const ratio = clamp01((Number(orb.displayTime) || 0) / duration);
    ctx.save();
    ctx.strokeStyle = rgba(P.slate, 0.6);
    ctx.lineWidth = Math.max(2, L.R * 0.03);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(L.cx, L.cy, radius, -Math.PI / 2, Math.PI * 1.5); ctx.stroke();
    ctx.strokeStyle = rgba(P.ringColor, 0.9);
    ctx.beginPath(); ctx.arc(L.cx, L.cy, radius, -Math.PI / 2, -Math.PI / 2 + TAU * ratio); ctx.stroke();
    const marker = -Math.PI / 2 + TAU * ratio;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath(); ctx.arc(L.cx + Math.cos(marker) * radius, L.cy + Math.sin(marker) * radius, Math.max(2.2, L.R * 0.032), 0, TAU); ctx.fill();
    ctx.restore();
  }

  function drawIdleShell(orb, ctx, L, m, P) {
    if (m.live) return;
    ctx.save();
    ctx.strokeStyle = rgba(P.ringColor, 0.16);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 7]);
    ctx.beginPath(); ctx.arc(L.cx, L.cy, L.R * 1.7, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ------------------------------------------------------------------
  // Orchestrator: one instrument, four presentations.
  // ------------------------------------------------------------------
  function drawAudioReactor(orb, ctx, W, H, input) {
    if (!ctx || !W || !H) return;
    const P = reactorPalette(orb);
    const stage = input.stage || 'compact';
    const live = Boolean(orb.stream && orb.stream.linked && orb.stream.frames && !orb.stream.stale) && input.live !== false;
    const metrics = live && orb.stream.metrics ? orb.stream.metrics : {};
    const level = clamp01(metrics.level), bass = clamp01(metrics.bass), lowMid = clamp01(metrics.lowMid);
    const mid = clamp01(metrics.mid), high = clamp01(metrics.high), pulse = clamp01(metrics.pulse);
    const intensity = Math.pow(level, 0.6);
    const dynamics = 0.22 + 0.78 * intensity;
    const t = input.frozen ? 0 : (Number.isFinite(input.t) ? input.t : performance.now());
    if (!(orb.peaks && orb.peaks.length === 12)) orb.peaks = new Array(12).fill(0);
    if (live) {
      const bars = orb.stream && Array.isArray(orb.stream.bars) ? orb.stream.bars : new Array(12).fill(0);
      for (let index = 0; index < 12; index++) {
        const value = clamp01(bars[index]);
        orb.peaks[index] = value >= orb.peaks[index] ? value : Math.max(0, orb.peaks[index] - 0.01);
      }
    }
    const bars = live ? (Array.isArray(orb.stream.bars) ? orb.stream.bars : new Array(12).fill(0)) : new Array(12).fill(0);
    const m = {
      live, frozen: Boolean(input.frozen), t,
      level, bass, lowMid, mid, high, pulse, intensity, dynamics,
      act: live ? 0.4 + 0.6 * intensity : 0.24,
      dyn: live ? dynamics : 0.2,
      glow: Math.max(0.2, Number(orb.settings && orb.settings.glow) || 1),
      style: (orb.settings && orb.settings.style) || 'spectrum',
      bars, peaks: orb.peaks,
      bars12: bars,
      coronaRot: t * 0.00004 * P.motion * (live ? 1 + 0.6 * high : 0.3),
      defHighlight: P.ice,
      hover: Boolean(orb.hover)
    };

    // Layout ----------------------------------------------------------
    let cx, cy, R;
    if (stage === 'music') {
      cx = Math.round(W / 2); cy = Math.round(H * 0.5); R = Math.min(W, H) * 0.27;
    } else if (stage === 'expanded') {
      // Everything above/below the core (bands, corona, deck bars, track arc)
      // is placed in multiples of R, so the layout is derived from R first.
      R = Math.min(H * 0.185, 52, W * 0.11);
      cy = Math.round(R * 2.3 + 12); cx = Math.round(W * 0.5);
    } else {
      cx = Math.round(W * 0.29); cy = Math.round(H * 0.47); R = Math.min(H * 0.23, 32);
    }
    const identity = orb.identity || {};
    const L = {
      stage, cx, cy, R, W, H,
      detail: stage === 'music' ? 2 : stage === 'expanded' ? 1 : 0.7,
      art: (stage === 'expanded') && Boolean(identity.title) && m.style !== 'circular',
      artX: Math.round(W * 0.14),
      trackArc: stage !== 'compact'
    };
    // Render order: deck/backdrop → far gyro → near gyro rear → frame rear
    // → conduits → core → near halves → spectrum corona → composition extras.
    // The compact bubble carries its frequency data in the side rail, so the
    // corona stays exclusive to the bigger stages where it has room.
    drawBackdrop(orb, ctx, L, m, P);
    if (stage === 'compact') L.skipCorona = true;

    const precessA = t * 0.00005 * P.motion * (live ? 1 + 0.5 * mid : 0.25);
    const precessB = t * 0.000035 * P.motion * (live ? 1 + 0.4 * high : 0.2);
    const bands = [
      { back: true, cx, cy, radius: R * 1.46, k: 0.4 + 0.1 * bass, rot: precessA, segs: L.detail > 1 ? 20 : 12, height: R * 0.2, cover: 0.62, baseAlpha: 0.5, out: 0.42, outMul: 1, driver: 'spectrum', bolt: true },
      { back: true, cx, cy, radius: R * 1.82, k: 0.22 + 0.06 * mid, rot: -precessB * 1.2, segs: 10, height: R * 0.14, cover: 0.5, baseAlpha: 0.4, out: 0.12, outMul: 0.7, driver: 'high', bolt: false },
      { back: true, cx, cy, radius: R * 1.12, k: 0.6, rot: precessA * 1.6, segs: 12, height: R * 0.1, cover: 0.44, baseAlpha: 0.34, out: 0.05, outMul: 0.5, driver: 'mid', bolt: false }
    ];
    // far halves first, smallest last so the depth stacking stays readable
    for (let index = bands.length - 1; index >= 0; index--) drawBandSegment(orb, ctx, bands[index], m, P);
    const coreR = drawCore(orb, ctx, L, m, P);
    drawConduits(orb, ctx, L, m, P, coreR);
    for (const band of bands) drawBandSegment(orb, ctx, Object.assign({}, band, { back: false }), m, P);
    drawSpectrumCorona(orb, ctx, L, m, P);
    if (stage === 'compact') drawRail(orb, ctx, L, m, P);
    else drawDeckBars(orb, ctx, L, m, P);
    drawArtDisc(orb, ctx, L, m, P);
    drawShockRings(orb, ctx, L, m, P);
    drawTrackArc(orb, ctx, L, m, P);
    drawIdleShell(orb, ctx, L, m, P);
  }

  // ------------------------------------------------------------------
  // Overrides. The last-wins object keys below replace the live draw
  // pipeline of music-orb.js while every functional method (stream, poll,
  // transport, seek, settings, floating window) stays exactly as shipped.
  // ------------------------------------------------------------------
  const upgraded = {
    __reactorUpgraded: true,

    draw(t, frozen) {
      const ctx = this.ctx;
      if (!ctx) return;
      const W = this.canvas.width, H = this.canvas.height;
      ctx.clearRect(0, 0, W, H);
      const stream = this.stream;
      const live = Boolean(stream && stream.linked && stream.frames && !stream.stale);
      const bars = live && Array.isArray(stream.bars) ? stream.bars : new Array(12).fill(0);
      if (document.body.classList.contains('music-mode')) return this.drawMusicMode(t, frozen, { live });
      this.drawAudioReactor(ctx, W, H, { stage: this.state && this.state.expanded ? 'expanded' : 'compact', live, t, frozen });
    },

    drawMusicMode(t, frozen, input) {
      const ctx = this.ctx;
      if (!ctx) return;
      const W = this.canvas.width, H = this.canvas.height;
      ctx.clearRect(0, 0, W, H);
      const karen = document.documentElement.dataset.theme === 'spiderman';
      if (karen) {
        // Karen keeps her own web-composed stage (the spider rig below uses
        // the retained drawWebStage / drawStageSpider helpers).
        const stream = this.stream;
        const live = Boolean(stream && stream.linked && stream.frames && !stream.stale);
        const metrics = live && stream.metrics ? stream.metrics : {};
        const level = clamp01(metrics.level), bass = clamp01(metrics.bass), lowMid = clamp01(metrics.lowMid);
        const mid = clamp01(metrics.mid), high = clamp01(metrics.high), pulse = clamp01(metrics.pulse);
        const intensity = Math.pow(level, 0.6);
        const pal = reactorPalette(this);
        const red = pal.ringColor;
        const cyan = pal.ice;
        const bandH = Math.max(60, Math.min(H * 0.18, 120));
        const cx = Math.round(W * 0.5), cy = Math.round((H - bandH) * 0.5 + bandH * 0.1);
        const base = Math.max(80, Math.min((H - bandH) * 0.35, W * 0.22, 220));
        const floor = ctx.createRadialGradient(cx, H * 0.98, base * 0.2, cx, H * 0.98, Math.max(W, H) * 0.62);
        floor.addColorStop(0, rgba(red, 0.1 + 0.1 * intensity));
        floor.addColorStop(0.55, rgba(red, 0.03 + 0.04 * intensity));
        floor.addColorStop(1, rgba(red, 0));
        ctx.fillStyle = floor; ctx.fillRect(0, 0, W, H);
        this.drawWebStage(ctx, cx, cy, base, base * (2.5 + 0.1 * bass), t, cyan, red, intensity);
        const auraR = base * (2.3 + 0.6 * intensity);
        const aura = ctx.createRadialGradient(cx, cy, base * 0.25, cx, cy, auraR);
        aura.addColorStop(0, rgba(red, 0.2 + 0.22 * intensity));
        aura.addColorStop(0.55, rgba(red, 0.06 + 0.09 * lowMid));
        aura.addColorStop(1, rgba(red, 0));
        ctx.fillStyle = aura; ctx.beginPath(); ctx.arc(cx, cy, auraR, 0, TAU); ctx.fill();
        const reactorR = base * 0.2;
        const reactor = ctx.createRadialGradient(cx, cy, 0, cx, cy, reactorR);
        reactor.addColorStop(0, 'rgba(255,255,255,0.9)');
        reactor.addColorStop(0.55, rgba(red, 0.85));
        reactor.addColorStop(1, rgba(red, 0.4));
        ctx.fillStyle = reactor; ctx.beginPath(); ctx.arc(cx, cy, reactorR, 0, TAU); ctx.fill();
        ctx.strokeStyle = rgba(cyan, 0.7); ctx.lineWidth = Math.max(1, base * 0.02);
        ctx.beginPath(); ctx.arc(cx, cy, reactorR * 0.8, 0, TAU); ctx.stroke();
        const body = ctx.createRadialGradient(cx - base * 0.32, cy - base * 0.36, base * 0.03, cx, cy, base * 0.3);
        body.addColorStop(0, rgba(red, 0.95));
        body.addColorStop(0.4, rgba(red, 0.5));
        body.addColorStop(1, rgba('#20040a', 0.4));
        ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, base * (0.6 + 0.5 * intensity)); ctx.fill();
        void bass; void mid; void high; void pulse;
        return;
      }
      this.drawAudioReactor(ctx, W, H, { stage: 'music', live: input && input.live, t, frozen });
    },

    drawFloatingBars(ctx, W, H, bars, peaks, m) {
      if (!ctx) return;
      const P = reactorPalette(this);
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const live = Boolean(m && m.live);
      const level = clamp01(m && m.level), intensity = clamp01(m && m.intensity), pulse = clamp01(m && m.pulse);
      const bass = clamp01(m && m.bass), glow = clamp01(m && m.glow) || 0;
      const lensX = 29 * dpr, lensY = H / 2, lensR = Math.min(14 * dpr, H * 0.3) * (0.88 + intensity * 0.3 + pulse * 0.12);
      ctx.clearRect(0, 0, W, H);
      // nucleus
      const lens = ctx.createRadialGradient(lensX - lensR * 0.3, lensY - lensR * 0.35, 1, lensX, lensY, lensR);
      lens.addColorStop(0, 'rgba(224,253,255,0.95)');
      lens.addColorStop(0.32, rgba(P.ice, 0.55 + intensity * 0.3));
      lens.addColorStop(0.75, rgba(P.ringColor, 0.5 + intensity * 0.3));
      lens.addColorStop(1, rgba(P.blue, 0.2));
      ctx.save();
      ctx.fillStyle = lens;
      ctx.shadowColor = rgba(P.ringColor, 0.6);
      ctx.shadowBlur = (4 + intensity * 8) * dpr * clamp01(Math.max(glow, 0.5));
      ctx.beginPath(); ctx.arc(lensX, lensY, lensR, 0, TAU); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = rgba(P.ice, 0.7);
      ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.arc(lensX, lensY, lensR * 1.02, 0, TAU); ctx.stroke();
      // mechanical collar: two counter-rotating sleeve arcs (3D-tilted)
      const collar = m && Number.isFinite(m.t) ? m.t : performance.now();
      ctx.save();
      for (let arcIndex = 0; arcIndex < 2; arcIndex++) {
        const k = arcIndex ? 0.34 : 0.6;
        const rot = collar * 0.0005 * (arcIndex ? -1 : 1);
        const radius = lensR * (1.32 + arcIndex * 0.22);
        ctx.strokeStyle = rgba(arcIndex ? P.ringColor : P.ice, (arcIndex ? 0.4 : 0.6) + 0.3 * bass);
        ctx.lineWidth = Math.max(1, lensR * 0.16);
        ctx.beginPath();
        ctx.ellipse(lensX, lensY, radius, radius * k, 0, rot, rot + TAU * 0.62);
        ctx.stroke();
      }
      ctx.restore();
      // slim integrated tick rail sharing the reactor language
      const sampled = Array.isArray(bars) ? bars : [];
      const count = 26;
      const railX = lensX + lensR * 2.4, railEnd = W - 10 * dpr;
      const baseY = H - 5 * dpr, maxH = H * 0.52;
      ctx.save();
      ctx.lineCap = 'round';
      for (let index = 0; index < count; index++) {
        const unit = index / (count - 1);
        const mirrored = unit <= 0.5 ? unit * 2 : (1 - unit) * 2;
        const value = spectrumAt(sampled, mirrored);
        const x = railX + unit * (railEnd - railX);
        const height = Math.max(1.4 * dpr, maxH * value * (live ? 0.3 + 0.7 * intensity : 0.12));
        const ring = mirrored < 0.3 ? P.blue : mirrored < 0.64 ? P.ringColor : P.ice;
        ctx.strokeStyle = rgba(ring, live ? 0.35 + 0.55 * value : 0.2);
        ctx.lineWidth = Math.max(1, lensR * 0.12);
        ctx.beginPath(); ctx.moveTo(x, baseY); ctx.lineTo(x, baseY - height); ctx.stroke();
      }
      ctx.restore();
    }
  };

  Object.assign(window.MusicOrb, upgraded);
  window.MusicOrb.drawAudioReactor = function (ctx, W, H, input) { drawAudioReactor(this, ctx, W, H, input); };
})();
