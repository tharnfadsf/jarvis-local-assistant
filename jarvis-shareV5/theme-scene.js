'use strict';
// =====================================================================
// THEME SCENES (2026-10-31)
// A small, self-contained ambient layer inside the core bay. Every themed
// palette gets its own hand-built animation, driven by the live HUD colours:
//
//   love / pink custom ....... cherry blossom + soft pink mountain ridges
//   spiderman / red custom ... fire: flame bed, rising embers
//   venom .................... symbiote: black-violet tendrils, drifting spores
//   frustrated ............... sharp sparks
//   happy / yellow custom .... warm pollen glow
//   sad ...................... slow drifting mist (calm, never gloomy)
//   curious .................. fireflies
//   media .................... aurora ribbons
//   rgb ...................... cycling bokeh
//   green custom ............. falling leaves
//   violet custom ............ starfield
//   blue custom / teal ....... water ripples
//
// Base (blue) / AUTO / THINKING keep the deck's Iron Man suit hologram —
// the JARVIS companion statue — instead of blanking out with the themes.
//
// It is interactive: the pointer pulls motes toward the cursor and a click
// throws a burst of that scene's particles. Everything is decorative, so the
// canvas is pointer-events:none and the listeners live on the stage.
// =====================================================================
(function () {
  const canvas = document.getElementById('themeScene');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  // The scene covers the whole hero card (petals can fall past the core bay),
  // so the canvas' parent is the sizing + pointer surface.
  const stage = canvas.parentElement;
  const hero = document.getElementById('hero') || stage;
  if (!stage) return;

  const TAU = Math.PI * 2;
  const rand = (min, max) => min + Math.random() * (max - min);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const reducedMotion = () => typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function cssVar(name, fallback) {
    try {
      const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    } catch { return fallback; }
  }
  function channels(hex) {
    const match = String(hex || '').trim().match(/^#([\da-f]{6})$/i);
    if (!match) {
      const rgb = String(hex || '').match(/rgba?\(([^)]+)\)/i);
      if (rgb) {
        const parts = rgb[1].split(',').map(Number);
        if (parts.length >= 3) return { r: parts[0], g: parts[1], b: parts[2] };
      }
      return { r: 86, g: 233, b: 255 };
    }
    const packed = parseInt(match[1], 16);
    return { r: (packed >> 16) & 255, g: (packed >> 8) & 255, b: packed & 255 };
  }
  function rgba(color, alpha) {
    const c = channels(color);
    return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${clamp(alpha, 0, 1).toFixed(3)})`;
  }
  function mix(a, b, amount) {
    const x = channels(a), y = channels(b);
    const r = Math.round(x.r + (y.r - x.r) * amount);
    const g = Math.round(x.g + (y.g - x.g) * amount);
    const bl = Math.round(x.b + (y.b - x.b) * amount);
    return `#${[r, g, bl].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  }
  function hueOf(hex) {
    const { r, g, b } = channels(hex);
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), delta = max - min;
    if (!delta) return 0;
    let hue = max === rn ? ((gn - bn) / delta) % 6 : max === gn ? (bn - rn) / delta + 2 : (rn - gn) / delta + 4;
    hue *= 60;
    return hue < 0 ? hue + 360 : hue;
  }

  // ------------------------------------------------------------------
  // Scene selection
  // ------------------------------------------------------------------
  function sceneFor(themeName, accent) {
    if (themeName === 'spiderman') return 'fire';
    if (themeName === 'venom') return 'symbiote';
    switch (themeName) {
      case 'love': return 'sakura';
      case 'happy': return 'bloom';
      case 'sad': return 'mist';
      case 'frustrated': return 'sparks';
      case 'curious': return 'fireflies';
      case 'media': return 'aurora';
      case 'rgb': return 'rainbow';
      case 'blue':
      case 'thinking':
      case 'auto': return 'none';
      case 'custom': {
        const hue = hueOf(accent);
        if (hue >= 300 || hue < 16) return 'sakura';
        if (hue < 48) return 'fire';
        if (hue < 92) return 'bloom';
        if (hue < 170) return 'ripple';
        if (hue < 262) return 'mist';
        if (hue < 300) return 'stars';
        return 'sakura';
      }
      default: return 'none';
    }
  }

  // ------------------------------------------------------------------
  // Scene state
  // ------------------------------------------------------------------
  let width = 0, height = 0, dpr = 1;
  let scene = 'none';
  let fade = 0, targetFade = 0;
  let t = 0, lastFrame = 0;
  let raf = 0;
  let pendingBursts = [];
  const pointer = { x: 0, y: 0, active: false, vx: 0, vy: 0 };
  // Iron Man hologram state: auto-spin, pointer tilt, and a spin boost on click.
  const suit = { angle: 0, spin: 1.2, tilt: 0, boost: false, boostAt: 0 };

  const P = {
    sakura: [],
    petalsBurst: [],
    embers: [],
    flames: 0,
    pollen: [],
    mist: [],
    sparks: [],
    flies: [],
    droplets: [],
    ripples: [],
    stars: [],
    bokeh: [],
    leaves: [],
    meteors: [],
    symbioteSpores: [],
    tendrils: []
  };

  function palette() {
    const cyan = cssVar('--cyan', '#56e9ff');
    const blue = cssVar('--blue', '#19a9e4');
    const mint = cssVar('--mint', '#43e9c4');
    const red = cssVar('--red', '#ff7186');
    return { cyan, blue, mint, red, pink: mix(cyan, '#ffffff', 0.32), deep: mix(blue, '#000000', 0.3) };
  }

  function clearScene(list) {
    for (const key of Object.keys(P)) {
      if (Array.isArray(P[key])) P[key].length = 0;
    }
  }

  // ------------------------------------------------------------------
  // Particles
  // ------------------------------------------------------------------
  function spawnPetal(fromBurst) {
    const h = height || 1, w = width || 1;
    return {
      x: fromBurst ? fromBurst.x : rand(-20, w + 20),
      y: fromBurst ? fromBurst.y : rand(-h * 0.35, 0),
      size: rand(8, 15),
      vy: rand(16, 34),
      vx: rand(-9, 9),
      sway: rand(0.4, 1.2),
      phase: rand(0, TAU),
      spin: rand(-1.2, 1.2),
      angle: rand(0, TAU),
      alpha: rand(0.55, 0.95)
    };
  }
  function spawnEmber(fromBurst) {
    return {
      x: fromBurst ? fromBurst.x + rand(-14, 14) : rand(0, width),
      y: fromBurst ? fromBurst.y : height + rand(0, 30),
      vy: rand(-46, -18),
      vx: rand(-12, 12),
      size: rand(1.4, 3.4),
      life: rand(1.2, 2.6),
      age: 0
    };
  }
  function spawnSymbioteSpore(fromBurst) {
    return {
      x: fromBurst ? fromBurst.x + rand(-20, 20) : rand(0, width),
      y: fromBurst ? fromBurst.y : rand(height * 0.42, height + 30),
      vx: rand(-12, 12),
      vy: rand(-18, -4),
      size: rand(1.2, 3.4),
      life: rand(2.2, 5.2),
      age: 0,
      phase: rand(0, TAU)
    };
  }
  function spawnTendril(x) {
    const baseX = Number.isFinite(x) ? x + rand(-34, 34) : rand(-width * 0.08, width * 1.08);
    return {
      x: clamp(baseX, -width * 0.1, width * 1.1),
      len: rand(height * 0.28, height * 0.78),
      width: rand(9, 26),
      phase: rand(0, TAU),
      speed: rand(0.22, 0.6),
      drift: rand(-52, 52),
      alpha: rand(0.24, 0.58)
    };
  }
  function spawnPollen() {
    return {
      x: rand(0, width), y: rand(0, height),
      vy: rand(-14, -4), vx: rand(-4, 4),
      size: rand(1, 2.6), phase: rand(0, TAU), alpha: rand(0.25, 0.75)
    };
  }
  function spawnMist() {
    return {
      x: rand(-width * 0.3, width), y: rand(height * 0.35, height * 1.05),
      w: rand(width * 0.18, width * 0.42), h: rand(18, 42),
      vx: rand(2, 9), alpha: rand(0.04, 0.11)
    };
  }
  function spawnSpark() {
    return {
      x: rand(-30, width), y: rand(-30, height * 0.4),
      vx: rand(30, 90), vy: rand(60, 150),
      len: rand(6, 18), life: rand(0.6, 1.6), age: 0
    };
  }
  function spawnFly() {
    return {
      x: rand(0, width), y: rand(height * 0.15, height * 0.9),
      vx: rand(-8, 8), vy: rand(-6, 6),
      phase: rand(0, TAU), bob: rand(0.4, 1.4), size: rand(1.2, 2.6)
    };
  }
  function spawnDroplet() {
    return { x: rand(0, width), y: rand(0, height), r: rand(0.8, 2.2), vy: rand(6, 16), alpha: rand(0.1, 0.35) };
  }
  function spawnRipples(x, y) {
    P.ripples.push({ x, y, r: 2, life: 1, speed: rand(22, 38) });
    if (P.ripples.length > 8) P.ripples.shift();
  }
  function spawnStars() {
    for (let i = 0; i < 46; i++) {
      P.stars.push({ x: rand(0, width), y: rand(0, height * 0.9), r: rand(0.5, 1.6), phase: rand(0, TAU), speed: rand(0.6, 2.4) });
    }
  }
  function spawnBokeh() {
    for (let i = 0; i < 26; i++) {
      P.bokeh.push({ x: rand(0, width), y: rand(0, height), r: rand(7, 26), hue: rand(0, 360), speed: rand(0.1, 0.5), vy: rand(-10, -2) });
    }
  }
  function spawnLeaves() {
    for (let i = 0; i < 22; i++) {
      P.leaves.push({
        x: rand(0, width), y: rand(-height, height), size: rand(5, 10),
        vy: rand(12, 26), vx: rand(-14, 6), phase: rand(0, TAU), angle: rand(0, TAU), spin: rand(-1, 1)
      });
    }
  }

  function seedScene(name) {
    clearScene();
    pendingBursts = [];
    if (name === 'sakura') { for (let i = 0; i < 30; i++) P.sakura.push(spawnPetal()); }
    if (name === 'fire') { for (let i = 0; i < 42; i++) P.embers.push(spawnEmber()); }
    if (name === 'symbiote') {
      for (let i = 0; i < 11; i++) P.tendrils.push(spawnTendril());
      for (let i = 0; i < 36; i++) P.symbioteSpores.push(spawnSymbioteSpore());
    }
    if (name === 'bloom') { for (let i = 0; i < 34; i++) P.pollen.push(spawnPollen()); }
    if (name === 'mist') { for (let i = 0; i < 9; i++) P.mist.push(spawnMist()); }
    if (name === 'sparks') { for (let i = 0; i < 26; i++) P.sparks.push(spawnSpark()); }
    if (name === 'fireflies') { for (let i = 0; i < 18; i++) P.flies.push(spawnFly()); }
    if (name === 'stars') { spawnStars(); }
    if (name === 'rainbow') { spawnBokeh(); }
    if (name === 'leaves') { spawnLeaves(); }
    if (name === 'ripple') { for (let i = 0; i < 22; i++) P.droplets.push(spawnDroplet()); }
  }

  function burst(x, y) {
    if (scene === 'sakura') for (let i = 0; i < 14; i++) P.sakura.push(spawnPetal({ x, y }));
    else if (scene === 'fire') for (let i = 0; i < 18; i++) P.embers.push(spawnEmber({ x, y }));
    else if (scene === 'symbiote') {
      for (let i = 0; i < 22; i++) P.symbioteSpores.push(spawnSymbioteSpore({ x, y }));
      if (P.tendrils.length < 16) P.tendrils.push(spawnTendril(x));
    }
    else if (scene === 'bloom' || scene === 'fireflies') for (let i = 0; i < 10; i++) {
      const p = spawnPollen(); p.x = x; p.y = y; p.vy = rand(-70, -20); p.vx = rand(-50, 50); P.pollen.push(p);
    }
    else if (scene === 'ripple') { spawnRipples(x, y); spawnRipples(x, y); }
    else if (scene === 'stars' || scene === 'rainbow') {
      P.meteors.push({ x, y, vx: rand(-160, 160), vy: rand(-180, -60), life: 1 });
    } else if (scene === 'leaves') for (let i = 0; i < 8; i++) {
      P.leaves.push({ x, y, size: rand(5, 10), vy: rand(-40, -10), vx: rand(-40, 40), phase: rand(0, TAU), angle: rand(0, TAU), spin: rand(-2, 2) });
    } else if (scene === 'sparks') {
      for (let i = 0; i < 10; i++) P.sparks.push({ x, y, vx: rand(-140, 140), vy: rand(-160, -20), len: rand(8, 20), life: 1, age: 0 });
    }
    if (P.sakura.length > 80) P.sakura.splice(0, P.sakura.length - 80);
    if (P.embers.length > 90) P.embers.splice(0, P.embers.length - 90);
    if (P.pollen.length > 80) P.pollen.splice(0, P.pollen.length - 80);
    if (P.symbioteSpores.length > 110) P.symbioteSpores.splice(0, P.symbioteSpores.length - 110);
    if (P.tendrils.length > 16) P.tendrils.splice(0, P.tendrils.length - 16);
  }

  // ------------------------------------------------------------------
  // Drawing helpers
  // ------------------------------------------------------------------
  // A sakura petal: rounded base, two shoulders and the little notch at the
  // tip that makes it read as a blossom petal instead of a dot.
  function drawPetal(petal, color, vein) {
    ctx.save();
    ctx.translate(petal.x, petal.y);
    ctx.rotate(petal.angle);
    ctx.globalAlpha = petal.alpha;
    const s = petal.size;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, s * 0.6);
    ctx.bezierCurveTo(-s * 0.95, s * 0.15, -s * 0.78, -s * 0.62, -s * 0.34, -s * 0.78);
    ctx.quadraticCurveTo(-s * 0.12, -s * 0.86, 0, -s * 0.62);
    ctx.quadraticCurveTo(s * 0.12, -s * 0.86, s * 0.34, -s * 0.78);
    ctx.bezierCurveTo(s * 0.78, -s * 0.62, s * 0.95, s * 0.15, 0, s * 0.6);
    ctx.fill();
    if (vein) {
      ctx.strokeStyle = vein;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(0, s * 0.45);
      ctx.quadraticCurveTo(s * 0.06, -s * 0.1, 0, -s * 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------
  // Iron Man hologram
  // A hand-drawn wireframe suit — helmet with faceplate and eye slits,
  // pauldrons, arc-reactor chest, gauntlets and thruster boots — is baked
  // once into front/back sprite canvases. Spinning is a horizontal squeeze
  // of that sprite with a flip to the back bake past 90°, so the figure
  // stays a readable suit at every angle instead of a stack of pipes.
  // The arc reactor is drawn per frame as a true 3D ellipse so it slides
  // and foreshortens while the suit rotates; the deck light, dashed rings,
  // measurement ticks and the scan band carry the hologram feel.
  // ------------------------------------------------------------------
  const SPR_BAKE = 4;
  const SPR_W = 100 * SPR_BAKE, SPR_H = 220 * SPR_BAKE;
  const ci = (cx, cy, r, n = 10) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
  const mirrored = pts => pts.map(([x, y]) => [100 - x, y]);
  const joint = (cx, cy, r) => ci(cx, cy, r, 8);

  // One polyline per entry: pts in a 100x220 author grid (center x=50, feet
  // y=217). w = stroke weight, a = alpha, closed = fill+stroke polygon,
  // fill = interior alpha, glow = baked bloom, mirror = draw also mirrored.
  const SUIT_LINES = (() => {
    const shared = [
      // helmet shell
      { pts: [[41, 26], [39.5, 18], [41, 11], [45, 7.5], [55, 7.5], [59, 11], [60.5, 18], [59, 26], [56, 31.5], [44, 31.5]], w: 2.2, closed: 1, fill: 0.05 },
      // neck posts
      { pts: [[43.5, 33], [43.5, 37]], w: 2 }, { pts: [[56.5, 33], [56.5, 37]], w: 2 },
      // pauldrons
      { pts: [[27, 33.5], [36, 30.5], [41, 34.5], [39, 45], [28.5, 43.5], [26, 38]], w: 2, closed: 1, fill: 0.045, mirror: 1 },
      { pts: [[33, 33], [33.5, 42.5]], w: 1.1, mirror: 1 },
      // collar
      { pts: [[41, 34], [44, 32.5]], w: 1.4, a: 0.7, mirror: 1 },
      { pts: [[44, 38], [47, 36.5]], w: 1.2, a: 0.6, mirror: 1 },
      // chest plate
      { pts: [[43.5, 35], [38.5, 41], [36, 54], [38, 68], [42, 77], [46, 80], [54, 80], [58, 68], [62, 54], [62, 41], [56.5, 35]], w: 2.2, closed: 1, fill: 0.04 },
      // waist V + pelvis + belt
      { pts: [[44, 74], [50, 78.5], [56, 74]], w: 1.4 },
      { pts: [[41.5, 80], [39, 86], [40.5, 93.5], [46, 98.5], [54, 98.5], [59.5, 93.5], [61, 86], [58.5, 80]], w: 2, closed: 1, fill: 0.04 },
      { pts: [[42, 83.5], [58, 83.5]], w: 2.2, a: 0.85, glow: 0.7 },
      { pts: [[50, 92], [50, 98]], w: 1.2 },
      // arms (mirrored): upper, elbow guard, forearm, cuffs, fist
      { pts: [[29.5, 36.5], [25, 41], [21.5, 48], [20, 56], [19.8, 62]], w: 2, mirror: 1 },
      { pts: [[37, 38.5], [33, 42], [29.5, 48], [27.5, 56], [26.5, 63]], w: 1.4, a: 0.75, mirror: 1 },
      { pts: [[19.8, 62], [24, 60.5], [26.5, 63], [25.8, 68], [21.5, 68.5], [18.5, 66]], w: 1.8, closed: 1, mirror: 1 },
      { pts: [[18.5, 68.5], [16, 76], [13.5, 83], [11, 88]], w: 2, mirror: 1 },
      { pts: [[24, 68], [22, 76], [20, 83], [19, 88.5]], w: 1.4, a: 0.75, mirror: 1 },
      { pts: [[10.5, 84], [19.5, 85]], w: 2, mirror: 1 },
      { pts: [[12, 79], [20.5, 80]], w: 1.4, a: 0.7, mirror: 1 },
      { pts: [[10, 88], [15.5, 87.5], [18, 92.5], [15.5, 96.5], [10.5, 95.5], [9, 91.5]], w: 1.8, closed: 1, mirror: 1 },
      { pts: [[10.5, 91], [17.5, 90.5]], w: 1, a: 0.7, mirror: 1 },
      { pts: joint(32.5, 37, 1.7), w: 1, closed: 1, mirror: 1 },
      // legs (mirrored): thigh, knee cap, shin, thruster boot
      { pts: [[38.5, 96], [35.5, 106], [34, 119], [33.5, 132]], w: 2, mirror: 1 },
      { pts: [[45.5, 97.5], [44.5, 108], [44, 122], [43.5, 133]], w: 1.6, a: 0.8, mirror: 1 },
      { pts: [[34.5, 108], [44, 107.5]], w: 1, a: 0.5, mirror: 1 },
      { pts: [[33.5, 132.5], [38, 130.5], [42.5, 132], [43.5, 139], [40.5, 146], [35.5, 145], [33.5, 139]], w: 1.8, closed: 1, mirror: 1 },
      { pts: [[33.5, 146], [33, 158], [33.5, 170], [34, 180]], w: 2, mirror: 1 },
      { pts: [[43.5, 147], [44.5, 158], [45, 168], [45.5, 176]], w: 1.6, a: 0.8, mirror: 1 },
      { pts: [[33.5, 180], [31, 187], [29.5, 196], [29, 206], [30, 214], [33.5, 216.5], [44, 217], [47, 214], [47, 203], [45.5, 196], [44.5, 180]], w: 2.2, closed: 1, fill: 0.04, mirror: 1 },
      { pts: [[33, 183], [45, 183.5]], w: 2, a: 0.8, mirror: 1 },
      { pts: [[32.5, 196], [46, 196]], w: 1.4, a: 0.8, mirror: 1 },
      { pts: [[31.5, 205], [46.5, 205]], w: 2.2, a: 0.9, glow: 0.7, mirror: 1 },
      { pts: [[30, 214], [46.5, 214]], w: 1.6, a: 0.8, mirror: 1 }
    ];
    const front = [
      // faceplate: visor seam, brows, eye slits, cheeks, jaw vents, chin plate
      { pts: [[40.5, 16.5], [59.5, 16.5]], w: 2.2, glow: 0.8 },
      { pts: [[41.5, 12.8], [48, 11.8]], w: 1, a: 0.55 }, { pts: [[58.5, 12.8], [52, 11.8]], w: 1, a: 0.55 },
      { pts: [[44, 13.2], [48.5, 12.6], [48.5, 15], [44.5, 15.6]], w: 1.2, closed: 1, glow: 0.9, mirror: 1 },
      { pts: [[42, 20], [45, 19.5]], w: 1, a: 0.6, mirror: 1 },
      { pts: [[44.5, 23], [46.5, 29]], w: 1.1, a: 0.7, mirror: 1 },
      { pts: [[47, 22.5], [48, 28]], w: 1, a: 0.5, mirror: 1 },
      { pts: [[46, 29], [54, 29], [53, 31], [47, 31]], w: 1, closed: 1 },
      // chest plates: pec arcs, sub-pec, ab slats, ribs, belly seam
      { pts: [[49, 44], [43, 42.5], [38.5, 47]], w: 1.5, mirror: 1 },
      { pts: [[46, 52], [40.5, 51]], w: 1.1, a: 0.6, mirror: 1 },
      { pts: [[41, 58], [46.5, 58]], w: 1.4, a: 0.75, mirror: 1 },
      { pts: [[42, 63], [46, 63]], w: 1.2, a: 0.6, mirror: 1 },
      { pts: [[43, 68], [45.5, 68]], w: 1, a: 0.5, mirror: 1 },
      { pts: [[50, 45], [50, 78]], w: 1.6, a: 0.8 },
      { pts: [[39, 50], [37.5, 58], [38.5, 64]], w: 1, a: 0.55, mirror: 1 }
    ];
    const back = [
      // helmet rear seam, spine, shoulder blades, backpack plate
      { pts: [[50, 8], [50, 16]], w: 1.2, a: 0.7 },
      { pts: [[50, 36], [50, 96]], w: 1.8, a: 0.8 },
      { pts: [[44, 38], [36, 40], [34, 50]], w: 1, a: 0.6, mirror: 1 },
      { pts: [[40, 36], [60, 36], [60, 50], [40, 50]], w: 1, closed: 1, fill: 0.07 },
      { pts: [[43.5, 37.5], [43.5, 48.5]], w: 1, a: 0.6 }, { pts: [[56.5, 37.5], [56.5, 48.5]], w: 1, a: 0.6 },
      { pts: [[40, 43], [60, 43]], w: 1, a: 0.5 }
    ];
    return { shared, front, back };
  })();

  let suitFrontSpr = null, suitBackSpr = null, suitBakeKey = '';

  function bakeSuit(pal) {
    const ink = rgba(mix(pal.cyan, pal.blue, 0.4), 0.92);
    const soft = rgba(mix(pal.cyan, pal.blue, 0.5), 0.55);
    const hot = mix(pal.cyan, '#ffffff', 0.62);
    const bake = lineList => {
      const cv = document.createElement('canvas');
      cv.width = SPR_W; cv.height = SPR_H;
      const c2 = cv.getContext('2d');
      c2.lineCap = 'round'; c2.lineJoin = 'round';
      for (const line of lineList) {
        const variants = line.mirror ? [line.pts, mirrored(line.pts)] : [line.pts];
        for (const pts of variants) {
          c2.beginPath();
          pts.forEach(([x, y], i) => (i ? c2.lineTo(x * SPR_BAKE, y * SPR_BAKE) : c2.moveTo(x * SPR_BAKE, y * SPR_BAKE)));
          if (line.closed) c2.closePath();
          if (line.fill) { c2.fillStyle = rgba(pal.cyan, line.fill); c2.globalAlpha = 1; c2.fill(); }
          c2.lineWidth = Math.max(1, (line.w || 1) * SPR_BAKE * 0.5);
          c2.strokeStyle = line.glow ? hot : ((line.w || 1) < 1.5 ? soft : ink);
          c2.globalAlpha = line.a == null ? 1 : clamp(line.a, 0, 1);
          if (line.glow) { c2.shadowColor = rgba(pal.mint, 0.9); c2.shadowBlur = line.glow * SPR_BAKE * 0.9; }
          c2.stroke();
          c2.shadowBlur = 0;
        }
      }
      return cv;
    };
    suitFrontSpr = bake(SUIT_LINES.shared.concat(SUIT_LINES.front));
    suitBackSpr = bake(SUIT_LINES.shared.concat(SUIT_LINES.back));
    suitBakeKey = pal.cyan + pal.blue + pal.mint;
  }

  function drawSuit(pal, dt) {
    const bakeKey = pal.cyan + pal.blue + pal.mint;
    if (!suitFrontSpr || suitBakeKey !== bakeKey) bakeSuit(pal);

    const cosA = Math.cos(suit.angle), sinA = Math.sin(suit.angle);
    const facing = Math.abs(cosA);
    const squeeze = Math.max(0.085, facing);
    const fromBehind = cosA < 0;
    const front = Math.max(0, cosA);
    const bob = Math.sin(t * 1.05) * 0.005;

    // placement: the suit stands on its deck in the left third — clear of
    // the wordmark ring, the section label and the status row
    const suitH = Math.min(height * 0.62, width * 0.6) * (1 + suit.tilt * 0.08);
    const suitW = suitH * (100 / 220);
    const footY = height * 0.925 + bob * height;
    const originX = Math.min(Math.max(width * (width < 640 ? 0.3 : 0.255), suitW * 1.42 + 8), width * 0.36);
    const beamTop = footY - suitH * 1.08;

    const X = ax => originX + (ax - 50) / 100 * suitW * squeeze;
    const Y = ay => footY - (ay / 220) * suitH;

    // projection light column behind the figure
    const beam = ctx.createLinearGradient(0, beamTop, 0, footY);
    beam.addColorStop(0, rgba(pal.cyan, 0));
    beam.addColorStop(0.55, rgba(pal.cyan, 0.028));
    beam.addColorStop(1, rgba(pal.cyan, 0.068));
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(originX - suitW * 0.4, beamTop);
    ctx.lineTo(originX + suitW * 0.4, beamTop);
    ctx.lineTo(originX + suitW * 0.95, footY + suitW * 0.03);
    ctx.lineTo(originX - suitW * 0.95, footY + suitW * 0.03);
    ctx.closePath();
    ctx.fill();

    // the deck: pooled light plus counter-rotating dashed rings tied to spin
    ctx.save();
    ctx.translate(originX, footY);
    const pool = ctx.createRadialGradient(0, 0, 1, 0, 0, suitW * 1.05);
    pool.addColorStop(0, rgba(pal.cyan, 0.16));
    pool.addColorStop(1, rgba(pal.cyan, 0));
    ctx.fillStyle = pool;
    ctx.beginPath(); ctx.ellipse(0, 0, suitW * 1.05, suitW * 0.25, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = rgba(pal.cyan, 0.1);
    ctx.beginPath(); ctx.ellipse(0, 0, suitW * 0.3, suitW * 0.072, 0, 0, TAU); ctx.fill();
    ctx.lineWidth = 1;
    const deckRings = [
      { rx: suitW * 0.42, a: 0.34, dash: [5, 7], off: -suit.angle * 60 },
      { rx: suitW * 0.78, a: 0.22, dash: [2, 9], off: suit.angle * 34 },
      { rx: suitW * 1.05, a: 0.13, dash: [12, 6], off: -suit.angle * 20 }
    ];
    for (const ringDef of deckRings) {
      ctx.strokeStyle = rgba(pal.cyan, ringDef.a);
      ctx.setLineDash(ringDef.dash);
      ctx.lineDashOffset = ringDef.off;
      ctx.beginPath(); ctx.ellipse(0, 0, ringDef.rx, ringDef.rx * 0.24, 0, 0, TAU); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    // measurement ticks flanking the statue
    ctx.save();
    ctx.strokeStyle = rgba(pal.cyan, 0.2);
    ctx.lineWidth = 1;
    for (let i = 0; i < 9; i++) {
      const y = footY - suitH * (0.06 + i * 0.112);
      const len = suitW * (0.05 + 0.03 * Math.abs(Math.sin(t * 0.7 + i * 0.8)));
      for (const dir of [-1, 1]) {
        const x0 = originX + dir * suitW * (1.32 + 0.06 * (i % 2));
        const x1 = x0 + dir * len;
        if (x1 < 3 || x1 > width - 3) continue;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      }
    }
    ctx.restore();

    // the wireframe suit: horizontal squeeze of the baked sprite, flipped to
    // its back bake while the far side faces the viewer
    let flicker = 0.93 + 0.07 * Math.sin(t * 26 + Math.sin(t * 13.1) * 2.2);
    if (Math.sin(t * 0.63) * Math.sin(t * 0.127) > 0.994) flicker *= 0.62; // rare blip
    ctx.imageSmoothingEnabled = true;
    ctx.save();
    ctx.globalAlpha = clamp((0.5 + 0.5 * facing) * flicker, 0.14, 1);
    ctx.drawImage(fromBehind ? suitBackSpr : suitFrontSpr,
      originX - suitW * squeeze * 0.5, footY - suitH, suitW * squeeze, suitH);
    ctx.restore();

    // edge-on: the flat of the suit reads as a bright vertical core
    if (facing < 0.26) {
      const streak = (0.26 - facing) / 0.26 * 0.5;
      const gx = ctx.createLinearGradient(originX - 3, 0, originX + 3, 0);
      gx.addColorStop(0, rgba(pal.cyan, 0));
      gx.addColorStop(0.5, rgba(mix(pal.cyan, '#ffffff', 0.4), streak));
      gx.addColorStop(1, rgba(pal.cyan, 0));
      ctx.fillStyle = gx;
      ctx.fillRect(originX - 3, footY - suitH * 0.98, 6, suitH * 0.98);
    }

    // arc reactor: drawn per frame as the foreshortening circle it is,
    // sliding with the rotation and glowing toward the viewer
    if (front > 0.05) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = clamp(Math.max(0.05, front * front), 0, 1) * flicker;
      const cx0 = originX + sinA * suitW * 0.09;
      const cy0 = Y(42.5);
      const R = suitW * 0.046;
      const pulse = 0.78 + 0.22 * Math.sin(t * 3.4);
      const glow = ctx.createRadialGradient(cx0, cy0, 1, cx0, cy0, R * 2.4 * pulse);
      glow.addColorStop(0, 'rgba(255,255,255,0.95)');
      glow.addColorStop(0.3, rgba(pal.cyan, 0.7));
      glow.addColorStop(1, rgba(pal.cyan, 0));
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(cx0, cy0, R * 2.4 * pulse, 0, TAU); ctx.fill();
      ctx.strokeStyle = mix(pal.cyan, '#ffffff', 0.5);
      ctx.shadowColor = rgba(pal.cyan, 0.9);
      ctx.shadowBlur = 5;
      ctx.lineWidth = 2.1;
      ctx.beginPath(); ctx.ellipse(cx0, cy0, R * facing, R, 0, 0, TAU); ctx.stroke();
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.ellipse(cx0, cy0, R * 0.55 * facing, R * 0.55, 0, 0, TAU); ctx.stroke();
      ctx.lineWidth = 1.1;
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx0 + dir * R * 0.6 * facing, cy0);
        ctx.lineTo(cx0 + dir * R * 0.96 * facing, cy0);
        ctx.moveTo(cx0, cy0 + dir * R * 0.6);
        ctx.lineTo(cx0, cy0 + dir * R * 0.96);
        ctx.stroke();
      }
      ctx.restore();
    }

    // hologram scan band riding over the statue
    const scanT = (t * 0.16) % 1;
    const scanY = footY - suitH * (1.02 - scanT * 1.06);
    const bandH = suitH * 0.05;
    const sweep = ctx.createLinearGradient(0, scanY - bandH, 0, scanY + bandH);
    sweep.addColorStop(0, rgba(pal.cyan, 0));
    sweep.addColorStop(0.5, rgba(pal.cyan, 0.09));
    sweep.addColorStop(1, rgba(pal.cyan, 0));
    ctx.fillStyle = sweep;
    ctx.fillRect(originX - suitW * 0.72, scanY - bandH, suitW * 1.44, bandH * 2);

    // spin physics: smooth pull back to idle speed, boost decays on its own
    if (suit.boost && t - suit.boostAt > 1.1) suit.boost = false;
    const target = suit.boost ? 5.2 : 0.68;
    suit.spin += (target - suit.spin) * Math.min(1, dt * 3.2);
    suit.angle += suit.spin * dt * 1.1;
    const tiltTarget = pointer.active ? ((pointer.y / Math.max(1, height)) - 0.5) * 0.55 : Math.sin(t * 0.3) * 0.05;
    suit.tilt += (tiltTarget - suit.tilt) * Math.min(1, dt * 2.8);
  }

  // Two pink mountain ridges: sharp alternating peaks for the far range, a
  // softer lower range in front. Rendered once per frame, cheap and static so
  // the falling petals stay the moving element.
  function drawMountains(pal) {
    const layers = [
      { base: 0.9, amp: 0.3, alpha: 0.15, color: mix(pal.cyan, '#2a0a18', 0.52), peaks: 6, seed: 1.9 },
      { base: 1.0, amp: 0.19, alpha: 0.26, color: mix(pal.cyan, '#12030a', 0.66), peaks: 9, seed: 3.4 }
    ];
    layers.forEach((layer, layerIndex) => {
      const baseY = height * layer.base;
      const amp = height * layer.amp;
      const step = width / layer.peaks;
      const points = [];
      for (let i = 0; i <= layer.peaks; i++) {
        const x = i * step;
        const isPeak = i % 2 === 0;
        const wobble = Math.sin(i * layer.seed + layerIndex) * 0.5 + Math.sin(i * layer.seed * 2.1) * 0.3;
        const t = isPeak ? 0.55 + Math.max(0, wobble) * 0.45 : 0.12 + Math.max(0, -wobble) * 0.12;
        points.push({ x, y: baseY - amp * t });
      }
      ctx.beginPath();
      ctx.moveTo(0, height);
      ctx.lineTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.lineTo(width, height);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, baseY - amp, 0, height);
      grad.addColorStop(0, rgba(layer.color, layer.alpha + 0.06));
      grad.addColorStop(1, rgba(layer.color, layer.alpha * 0.3));
      ctx.fillStyle = grad;
      ctx.fill();
      // faint light along the ridge line
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.strokeStyle = rgba(pal.cyan, 0.16 - layerIndex * 0.05);
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    // pink haze sitting on the valley floor
    const haze = ctx.createLinearGradient(0, height * 0.78, 0, height);
    haze.addColorStop(0, rgba(pal.cyan, 0));
    haze.addColorStop(1, rgba(pal.cyan, 0.07));
    ctx.fillStyle = haze;
    ctx.fillRect(0, height * 0.78, width, height * 0.22);
  }

  function drawFlameBed(pal, time) {
    const bedTop = height * 0.62;
    const flick = 0.78 + 0.22 * Math.sin(time * 6.2) + 0.12 * Math.sin(time * 13.7);
    const grad = ctx.createLinearGradient(0, bedTop, 0, height);
    grad.addColorStop(0, rgba(pal.red, 0));
    grad.addColorStop(0.42, rgba(pal.red, 0.14 * flick));
    grad.addColorStop(0.78, rgba(pal.red, 0.26 * flick));
    grad.addColorStop(1, rgba(mix(pal.red, '#ffbf4d', 0.45), 0.46 * flick));
    ctx.fillStyle = grad;
    ctx.fillRect(0, bedTop, width, height - bedTop);
    // Layered flame silhouettes: three wavy bands of rising heat. Vertical
    // blobs read as columns, so the tongues are drawn as an undulating edge
    // across the whole width instead.
    ctx.save();
    const layers = [
      { y: 0.9, amp: 0.045, alpha: 0.1, color: pal.red, speed: 1.3, freq: 0.012 },
      { y: 0.94, amp: 0.07, alpha: 0.15, color: mix(pal.red, '#ff9a3c', 0.4), speed: 2.0, freq: 0.017 },
      { y: 0.99, amp: 0.05, alpha: 0.24, color: mix(pal.red, '#ffd166', 0.55), speed: 2.9, freq: 0.024 }
    ];
    layers.forEach((layer, index) => {
      const baseY = height * layer.y;
      ctx.beginPath();
      ctx.moveTo(0, height);
      ctx.lineTo(0, baseY);
      for (let x = 0; x <= width + 14; x += 14) {
        const y = baseY
          - Math.abs(Math.sin(x * layer.freq + time * layer.speed + index * 1.7)) * height * layer.amp
          - Math.sin(x * layer.freq * 0.5 - time * layer.speed * 0.7) * height * layer.amp * 0.4;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, baseY - height * layer.amp * 1.8, 0, height);
      grad.addColorStop(0, rgba(layer.color, 0));
      grad.addColorStop(0.5, rgba(layer.color, layer.alpha * flick));
      grad.addColorStop(1, rgba(layer.color, Math.min(1, layer.alpha * 1.7 * flick)));
      ctx.fillStyle = grad;
      ctx.fill();
    });
    // glow pooling on the floor
    const pool = ctx.createRadialGradient(width / 2, height * 1.02, 10, width / 2, height * 1.02, width * 0.62);
    pool.addColorStop(0, rgba(mix(pal.red, '#ffb347', 0.5), 0.2 * flick));
    pool.addColorStop(1, rgba(pal.red, 0));
    ctx.fillStyle = pool;
    ctx.fillRect(0, height * 0.6, width, height * 0.4);
    ctx.restore();
  }

  function drawSymbiote(pal, time, dt) {
    // A dark violet bloom on the floor gives the tendrils something to grow
    // out of instead of floating over the normal HUD background.
    const floor = height * 0.55;
    const haze = ctx.createLinearGradient(0, floor, 0, height);
    haze.addColorStop(0, rgba(pal.blue, 0));
    haze.addColorStop(0.7, rgba(pal.blue, 0.12));
    haze.addColorStop(1, rgba(pal.blue, 0.3));
    ctx.fillStyle = haze;
    ctx.fillRect(0, floor, width, height - floor);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const td of P.tendrils) {
      const points = [];
      const steps = 7;
      for (let i = 0; i <= steps; i++) {
        const p = i / steps;
        const x = td.x
          + Math.sin(time * td.speed + td.phase + p * 3.4) * (12 + 42 * p)
          + Math.sin(time * td.speed * 1.7 + td.phase + p * 5.2) * 11 * p
          + td.drift * p * p;
        const y = height + 18 - td.len * p;
        points.push({ x, y });
      }
      const strokeCurve = (lineWidth, color, alpha) => {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length - 1; i++) {
          const midX = (points[i].x + points[i + 1].x) / 2;
          const midY = (points[i].y + points[i + 1].y) / 2;
          ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
        }
        const last = points[points.length - 1];
        ctx.lineTo(last.x, last.y);
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = color;
        ctx.globalAlpha = fade * alpha;
        ctx.stroke();
      };
      strokeCurve(td.width, rgba(mix('#040108', pal.blue, 0.28), td.alpha), 0.95);
      strokeCurve(td.width * 0.46, rgba(pal.blue, td.alpha * 0.78), 0.9);
      strokeCurve(td.width * 0.15, rgba(mix(pal.cyan, '#ffffff', 0.3), td.alpha), 0.85);
      const tip = points[points.length - 1];
      ctx.globalAlpha = fade * td.alpha;
      ctx.fillStyle = rgba(pal.cyan, 0.65);
      ctx.shadowColor = pal.cyan;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, Math.max(1.2, td.width * 0.17), 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.restore();

    for (let i = P.symbioteSpores.length - 1; i >= 0; i--) {
      const spore = P.symbioteSpores[i];
      spore.age += dt;
      spore.x += (spore.vx + Math.sin(time * 1.7 + spore.phase) * 5) * dt;
      spore.y += spore.vy * dt;
      if (spore.age >= spore.life || spore.y < -12) {
        const next = spawnSymbioteSpore();
        next.y = height + rand(0, 30);
        P.symbioteSpores[i] = next;
        continue;
      }
      if (pointer.active) {
        const dx = spore.x - pointer.x, dy = spore.y - pointer.y, d2 = dx * dx + dy * dy;
        if (d2 < 14000 && d2 > 1) {
          const d = Math.sqrt(d2);
          spore.x += (dx / d) * 18 * dt;
          spore.y += (dy / d) * 18 * dt;
        }
      }
      const life = clamp(spore.age / spore.life, 0, 1);
      ctx.globalAlpha = fade * (1 - life) * 0.82;
      ctx.fillStyle = i % 6 === 0 ? '#f4e9ff' : pal.cyan;
      ctx.shadowColor = pal.cyan;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(spore.x, spore.y, spore.size * (1 - life * 0.35), 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // A slow symbiote pulse around the core, timed against the normal rings.
    const pulse = (time * 0.18) % 1;
    ctx.globalAlpha = fade * (1 - pulse) * 0.2;
    ctx.strokeStyle = rgba(pal.cyan, 1);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(width / 2, height * 0.47, width * (0.15 + pulse * 0.32), height * (0.07 + pulse * 0.3), 0, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = fade;
  }

  // ------------------------------------------------------------------
  // Frame
  // ------------------------------------------------------------------
  function frame(now) {
    raf = 0;
    if (document.hidden) return;
    const dt = clamp((now - lastFrame) / 1000, 0, 0.05) || 0.016;
    lastFrame = now;
    t += dt;
    const pal = palette();

    // fade toward the target so a theme change never pops
    fade += (targetFade - fade) * Math.min(1, dt * 4);
    canvas.style.opacity = fade.toFixed(3);

    ctx.clearRect(0, 0, width, height);
    if (fade < 0.02) { schedule(); return; }

    ctx.save();
    ctx.globalAlpha = fade;

    const px = pointer.active ? pointer.x : width / 2;
    const py = pointer.active ? pointer.y : height / 2;

    switch (scene) {
      case 'sakura': {
        drawMountains(pal, t);
        for (let i = P.sakura.length - 1; i >= 0; i--) {
          const p = P.sakura[i];
          p.phase += dt * p.sway;
          // pointer breeze
          if (pointer.active) {
            const dx = px - p.x, dy = py - p.y;
            const dist2 = dx * dx + dy * dy;
            if (dist2 < 32000) { p.vx += (dx / Math.sqrt(dist2 + 1)) * 26 * dt; p.vy += (dy / Math.sqrt(dist2 + 1)) * 10 * dt; }
          }
          p.vx *= 0.985;
          p.vy += (24 - p.vy) * 0.02;
          p.x += (p.vx + Math.sin(p.phase) * 14) * dt;
          p.y += p.vy * dt;
          p.angle += p.spin * dt;
          if (p.y > height + 30 || p.x < -60 || p.x > width + 60) {
            P.sakura[i] = spawnPetal();
            continue;
          }
          drawPetal(p, i % 5 === 0 ? pal.pink : mix(pal.cyan, '#ffffff', 0.58), rgba(pal.cyan, 0.5));
        }
        break;
      }
      case 'fire': {
        drawFlameBed(pal, t);
        for (let i = P.embers.length - 1; i >= 0; i--) {
          const e = P.embers[i];
          e.age += dt;
          e.x += (e.vx + Math.sin(t * 3 + i) * 9) * dt;
          e.y += e.vy * dt;
          if (pointer.active) {
            const dx = e.x - px, dy = e.y - py;
            const d2 = dx * dx + dy * dy;
            if (d2 < 16000 && d2 > 1) { const d = Math.sqrt(d2); e.x += (dx / d) * 26 * dt; e.y += (dy / d) * 26 * dt; }
          }
          const life = clamp(e.age / e.life, 0, 1);
          if (life >= 1 || e.y < -20) { P.embers[i] = spawnEmber(); continue; }
          ctx.globalAlpha = fade * (1 - life) * 0.9;
          ctx.fillStyle = life < 0.35 ? '#fff0c4' : pal.red;
          ctx.shadowColor = pal.red;
          ctx.shadowBlur = 8;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.size * (1 - life * 0.5), 0, TAU);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
        break;
      }
      case 'symbiote': {
        drawSymbiote(pal, t, dt);
        break;
      }
      case 'bloom': {
        for (let i = P.pollen.length - 1; i >= 0; i--) {
          const p = P.pollen[i];
          p.phase += dt * 1.6;
          p.x += (p.vx + Math.sin(p.phase) * 6) * dt;
          p.y += p.vy * dt;
          if (pointer.active) {
            const dx = px - p.x, dy = py - p.y, d2 = dx * dx + dy * dy;
            if (d2 < 26000) { p.x += dx * 0.5 * dt; p.y += dy * 0.5 * dt; }
          }
          if (p.y < -10) { p.y = height + 8; p.x = rand(0, width); }
          const twinkle = 0.55 + 0.45 * Math.sin(t * 2 + p.phase);
          ctx.globalAlpha = fade * p.alpha * twinkle;
          ctx.fillStyle = mix(pal.cyan, '#fff6c8', 0.45);
          ctx.shadowColor = pal.cyan;
          ctx.shadowBlur = 6;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
          ctx.shadowBlur = 0;
        }
        break;
      }
      case 'mist': {
        for (const band of P.mist) {
          band.x += band.vx * dt;
          if (band.x > width + band.w) band.x = -band.w;
          const grad = ctx.createLinearGradient(band.x, band.y, band.x + band.w, band.y);
          grad.addColorStop(0, rgba(pal.cyan, 0));
          grad.addColorStop(0.5, rgba(pal.cyan, band.alpha));
          grad.addColorStop(1, rgba(pal.cyan, 0));
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.ellipse(band.x + band.w / 2, band.y, band.w / 2, band.h, 0, 0, TAU);
          ctx.fill();
        }
        break;
      }
      case 'sparks': {
        for (let i = P.sparks.length - 1; i >= 0; i--) {
          const s = P.sparks[i];
          s.age += dt;
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          if (s.age > s.life || s.y > height + 20) { P.sparks[i] = spawnSpark(); continue; }
          ctx.globalAlpha = fade * (1 - s.age / s.life);
          ctx.strokeStyle = pal.red;
          ctx.lineWidth = 1.4;
          ctx.shadowColor = pal.red;
          ctx.shadowBlur = 6;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x - s.vx * 0.03, s.y - s.vy * 0.03);
          ctx.stroke();
          ctx.shadowBlur = 0;
        }
        break;
      }
      case 'fireflies': {
        for (const f of P.flies) {
          f.phase += dt * f.bob;
          f.x += (f.vx + Math.sin(f.phase) * 8) * dt;
          f.y += (f.vy + Math.cos(f.phase * 0.8) * 6) * dt;
          if (pointer.active) {
            const dx = px - f.x, dy = py - f.y, d2 = dx * dx + dy * dy;
            if (d2 < 42000) { f.x += dx * 0.6 * dt; f.y += dy * 0.6 * dt; }
          }
          if (f.x < 0 || f.x > width) f.vx *= -1;
          if (f.y < height * 0.1 || f.y > height * 0.95) f.vy *= -1;
          const glow = 0.35 + 0.65 * Math.pow(Math.sin(t * 1.6 + f.phase), 2);
          ctx.globalAlpha = fade * glow;
          ctx.fillStyle = mix(pal.cyan, '#ffffff', 0.2);
          ctx.shadowColor = pal.cyan;
          ctx.shadowBlur = 12;
          ctx.beginPath(); ctx.arc(f.x, f.y, f.size, 0, TAU); ctx.fill();
          ctx.shadowBlur = 0;
        }
        break;
      }
      case 'aurora': {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let band = 0; band < 3; band++) {
          const top = height * (0.24 + band * 0.1);
          ctx.beginPath();
          ctx.moveTo(0, top);
          for (let x = 0; x <= width; x += 26) {
            const y = top + Math.sin(x * 0.008 + t * (0.6 + band * 0.25) + band) * 26
              + Math.sin(x * 0.003 - t * 0.4 + band * 2) * 18;
            ctx.lineTo(x, y);
          }
          const grad = ctx.createLinearGradient(0, top - 40, 0, top + 70);
          grad.addColorStop(0, rgba(band === 1 ? pal.cyan : pal.mint, 0));
          grad.addColorStop(0.45, rgba(band === 1 ? pal.cyan : pal.mint, 0.12));
          grad.addColorStop(1, rgba(pal.blue, 0));
          ctx.strokeStyle = grad;
          ctx.lineWidth = 38 - band * 8;
          ctx.lineCap = 'round';
          ctx.stroke();
        }
        ctx.restore();
        break;
      }
      case 'rainbow': {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const b of P.bokeh) {
          b.hue = (b.hue + b.speed * dt * 26) % 360;
          b.y += b.vy * dt;
          if (b.y < -40) { b.y = height + 40; b.x = rand(0, width); }
          ctx.fillStyle = `hsla(${b.hue.toFixed(0)}, 88%, 66%, 0.16)`;
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
        }
        ctx.restore();
        break;
      }
      case 'ripple': {
        for (let i = P.droplets.length - 1; i >= 0; i--) {
          const d = P.droplets[i];
          d.y += d.vy * dt;
          if (d.y > height) {
            spawnRipples(d.x, height - 4);
            P.droplets[i] = spawnDroplet();
            continue;
          }
          ctx.globalAlpha = fade * d.alpha;
          ctx.fillStyle = pal.cyan;
          ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, TAU); ctx.fill();
        }
        for (let i = P.ripples.length - 1; i >= 0; i--) {
          const r = P.ripples[i];
          r.r += r.speed * dt;
          r.life -= dt * 0.8;
          if (r.life <= 0) { P.ripples.splice(i, 1); continue; }
          ctx.globalAlpha = fade * r.life * 0.5;
          ctx.strokeStyle = pal.cyan;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.ellipse(r.x, r.y, r.r, r.r * 0.32, 0, 0, TAU); ctx.stroke();
        }
        break;
      }
      case 'stars': {
        for (const s of P.stars) {
          const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(t * s.speed + s.phase));
          ctx.globalAlpha = fade * twinkle * 0.8;
          ctx.fillStyle = mix(pal.purple || pal.cyan, '#ffffff', 0.4);
          ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.fill();
        }
        for (let i = P.meteors.length - 1; i >= 0; i--) {
          const m = P.meteors[i];
          m.life -= dt * 1.4;
          m.x += m.vx * dt; m.y += m.vy * dt;
          if (m.life <= 0) { P.meteors.splice(i, 1); continue; }
          ctx.globalAlpha = fade * m.life;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx * 0.06, m.y - m.vy * 0.06); ctx.stroke();
        }
        break;
      }
      case 'leaves': {
        for (const leaf of P.leaves) {
          leaf.phase += dt * 1.4;
          leaf.angle += leaf.spin * dt;
          leaf.x += (leaf.vx + Math.sin(leaf.phase) * 18) * dt;
          leaf.y += leaf.vy * dt;
          if (leaf.y > height + 30) { leaf.y = -20; leaf.x = rand(0, width); }
          if (leaf.x < -40) leaf.x = width + 30;
          if (leaf.x > width + 40) leaf.x = -30;
          ctx.save();
          ctx.translate(leaf.x, leaf.y);
          ctx.rotate(leaf.angle);
          ctx.globalAlpha = fade * 0.75;
          ctx.fillStyle = mix(pal.mint, '#8bd450', 0.35);
          ctx.beginPath();
          ctx.ellipse(0, 0, leaf.size * 0.55, leaf.size, 0, 0, TAU);
          ctx.fill();
          ctx.restore();
        }
        break;
      }
      default: break;
    }

    ctx.restore();
    schedule();
  }

  function schedule() {
    if (raf) return;
    if (reducedMotion()) return;
    if (targetFade <= 0.01 && fade <= 0.02) return;
    raf = requestAnimationFrame(frame);
  }

  function resize() {
    const box = stage.getBoundingClientRect();
    if (!box.width || !box.height) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    width = box.width;
    height = box.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (scene !== 'none') {
      seedScene(scene);
      if (reducedMotion()) { targetFade = 0.85; fade = 0.85; frame(performance.now()); }
      else schedule();
    }
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  function refresh(force) {
    const themeName = document.documentElement.dataset.theme || '';
    const accent = cssVar('--cyan', '#56e9ff');
    const mode = hero ? String(hero.dataset.mode || 'IDLE').toUpperCase() : 'IDLE';
    const quiet = mode === 'THINKING' || mode === 'SEARCHING';
    const mapped = sceneFor(themeName, accent);    const next = quiet ? 'none' : mapped;
    if (next !== scene) {
      scene = next;
      seedScene(next);
      if (!reducedMotion()) { fade = 0; targetFade = next === 'none' ? 0 : 0.9; }
      else { fade = next === 'none' ? 0 : 0.88; targetFade = fade; }
      lastFrame = performance.now();
      schedule();
      return;
    }
    targetFade = next === 'none' ? 0 : 0.9;
    if (!reducedMotion()) schedule();
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(resize).observe(stage);
  } else {
    window.addEventListener('resize', resize);
  }

  // Pointer / click interaction. Listeners sit on the stage, which is above
  // the decorative canvas, so nothing here steals clicks from the HUD.
  stage.addEventListener('pointermove', event => {
    const box = stage.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    pointer.vx = x - pointer.x; pointer.vy = y - pointer.y;
    pointer.x = x; pointer.y = y; pointer.active = true;
  });
  stage.addEventListener('pointerleave', () => { pointer.active = false; });
  stage.addEventListener('pointerdown', event => {
    if (scene === 'none') return;
    const box = stage.getBoundingClientRect();
    burst(event.clientX - box.left, event.clientY - box.top);
    if (scene === 'ripple') spawnRipples(event.clientX - box.left, event.clientY - box.top);
    if (!reducedMotion()) { targetFade = Math.max(targetFade, 0.9); schedule(); }
  });

  document.addEventListener('jarvis-theme-change', () => refresh());
  if (hero) {
    new MutationObserver(() => refresh()).observe(hero, { attributes: true, attributeFilter: ['data-mode'] });
  }
  new MutationObserver(() => refresh()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });

  resize();
  refresh();
  window.addEventListener('resize', resize);

  window.JarvisThemeScene = {
    refresh,
    current: () => scene,
    sceneFor,
    setVisible(visible) { targetFade = visible ? 0.9 : 0; }
  };
})();
