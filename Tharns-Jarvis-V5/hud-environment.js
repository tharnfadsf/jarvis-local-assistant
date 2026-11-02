'use strict';

/*
 * Lightweight ambient layer for the JARVIS HUD.
 * This module is deliberately read-only: it observes assistant/media state and
 * draws on a pointer-transparent canvas behind the app. It never touches audio,
 * camera, network, or desktop-control pipelines.
 */
(function (root, factory) {
  const environment = factory();
  if (typeof module === 'object' && module.exports) module.exports = environment;
  if (root && root.document && typeof root.requestAnimationFrame === 'function') environment.start(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const CANVAS_ID = 'jarvisHudEnvironment';
  const DESKTOP_ANCHORS = [
    [.035, .13], [.22, .08], [.5, .065], [.78, .09], [.965, .17], [.96, .43], [.97, .73],
    [.8, .92], [.5, .94], [.2, .91], [.035, .8], [.03, .49], [.16, .28], [.84, .3], [.87, .63]
  ];
  const MOBILE_ANCHORS = [
    [.08, .16], [.5, .06], [.92, .17], [.96, .48], [.88, .84], [.5, .94], [.12, .84], [.04, .5], [.27, .36], [.74, .62]
  ];
  const DESKTOP_EDGES = [
    [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11], [11, 0],
    [1, 12], [12, 13], [13, 14], [14, 5], [13, 8], [2, 13], [3, 14], [10, 12]
  ];
  const MOBILE_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 0], [1, 8], [8, 9], [9, 3], [6, 8]];
  const MODE_TUNING = {
    IDLE: { speed: .24, intensity: .22, scanPeriod: 62 },
    LISTENING: { speed: .4, intensity: .34, scanPeriod: 44 },
    THINKING: { speed: .7, intensity: .4, scanPeriod: 27 },
    SEARCHING: { speed: .58, intensity: .36, scanPeriod: 31 },
    EXECUTING: { speed: .42, intensity: .3, scanPeriod: 39 },
    SPEAKING: { speed: .46, intensity: .36, scanPeriod: 37 },
    INTERRUPTED: { speed: .52, intensity: .38, scanPeriod: 34 },
    ERROR: { speed: .2, intensity: .18, scanPeriod: 68 },
    SCANNING: { speed: .62, intensity: .38, scanPeriod: 23 }
  };

  function clamp(value, min = 0, max = 1) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
  }

  function normalizeMode(value) {
    const mode = String(value || 'IDLE').trim().toUpperCase();
    return Object.prototype.hasOwnProperty.call(MODE_TUNING, mode) ? mode : 'IDLE';
  }

  function anchorLayout(width, height) {
    const w = Math.max(1, Number(width) || 1);
    const h = Math.max(1, Number(height) || 1);
    const anchors = w < 620 ? MOBILE_ANCHORS : DESKTOP_ANCHORS;
    return anchors.map(([u, v], index) => ({
      x: u * w,
      y: v * h,
      depth: .22 + ((index * 7) % 10) / 13,
      phase: index * 1.618,
      speed: .45 + ((index * 5) % 9) / 10
    }));
  }

  function mediaEnergy(stream) {
    if (!stream || stream.linked !== true || stream.stale === true) return 0;
    const metrics = stream.metrics || {};
    return clamp(Math.max(
      Number(metrics.level) || 0,
      (Number(metrics.bass) || 0) * .55,
      (Number(metrics.pulse) || 0) * .9
    ));
  }

  function animationProfile(mode, stream) {
    const normalized = normalizeMode(mode);
    const base = MODE_TUNING[normalized];
    const energy = mediaEnergy(stream);
    return {
      mode: normalized,
      speed: base.speed * (1 + energy * .45),
      intensity: clamp(base.intensity + energy * .25),
      scanPeriod: base.scanPeriod / (1 + energy * .18),
      mediaEnergy: energy
    };
  }

  function targetFrameInterval(profile, mobile, reducedMotion) {
    if (reducedMotion) return 0;
    const mode = normalizeMode(profile && profile.mode);
    if (mobile) return mode === 'IDLE' || mode === 'ERROR' ? 1000 / 9 : 1000 / 14;
    if (Number(profile && profile.mediaEnergy) > .08) return 1000 / 20;
    if (mode === 'IDLE' || mode === 'ERROR') return 1000 / 11;
    return mode === 'THINKING' || mode === 'SCANNING' ? 1000 / 18 : 1000 / 16;
  }

  function makeEdges(pointCount, mobile) {
    return (mobile ? MOBILE_EDGES : DESKTOP_EDGES).filter(([a, b]) => a < pointCount && b < pointCount);
  }

  function rgba(color, alpha) {
    const value = String(color || '').trim();
    let channels = null;
    const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      let raw = hex[1];
      if (raw.length === 3) raw = raw.split('').map(character => character + character).join('');
      channels = [0, 2, 4].map(index => parseInt(raw.slice(index, index + 2), 16));
    } else {
      const rgb = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (rgb) channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    }
    if (!channels) channels = [86, 233, 255];
    return `rgba(${channels[0]},${channels[1]},${channels[2]},${clamp(alpha)})`;
  }

  function start(win) {
    const doc = win.document;
    if (!doc || doc.getElementById(CANVAS_ID)) return null;

    const canvas = doc.createElement('canvas');
    canvas.id = CANVAS_ID;
    canvas.className = 'hud-environment-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    doc.body.prepend(canvas);
    const context = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!context) { canvas.remove(); return null; }

    let width = 0, height = 0, dpr = 1, raf = 0, frameTimer = 0, lastFrame = 0, lastZoneRead = 0, lastThemeRead = 0;
    let phase = 0, currentIntensity = .2, currentSpeed = .24, cyan = '#56e9ff', blue = '#19a9e4', mint = '#43e9c4';
    let points = [], edges = [], zones = [], disposed = false;
    const reducedMotion = win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)');

    function activeWindow() {
      return !disposed && !doc.hidden && (typeof doc.hasFocus !== 'function' || doc.hasFocus());
    }

    function stopScheduledFrame() {
      if (frameTimer) win.clearTimeout(frameTimer);
      if (raf) win.cancelAnimationFrame(raf);
      frameTimer = 0;
      raf = 0;
    }

    function queueFrame(delay = 0) {
      if (!activeWindow() || frameTimer || raf) return;
      frameTimer = win.setTimeout(() => {
        frameTimer = 0;
        if (activeWindow()) raf = win.requestAnimationFrame(frame);
      }, Math.max(0, delay));
    }

    function resize() {
      width = Math.max(1, win.innerWidth || doc.documentElement.clientWidth || 1);
      height = Math.max(1, win.innerHeight || doc.documentElement.clientHeight || 1);
      dpr = Math.min(1.15, Math.max(1, win.devicePixelRatio || 1));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      points = anchorLayout(width, height);
      edges = makeEdges(points.length, width < 620);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reducedMotion && reducedMotion.matches && !disposed) {
        stopScheduledFrame();
        lastFrame = 0;
        if (activeWindow()) frame(win.performance.now());
      } else queueFrame(0);
    }

    function refreshZones(now) {
      if (now - lastZoneRead < 900) return;
      lastZoneRead = now;
      zones = Array.from(doc.querySelectorAll('.card, .topbar, .rail'))
        .map(element => element.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.height > 0);
    }

    function visibilityAt(x, y) {
      for (const zone of zones) {
        if (x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom) return .5;
      }
      return 1;
    }

    function refreshTheme(now) {
      if (now - lastThemeRead < 800) return;
      lastThemeRead = now;
      const hero = doc.getElementById('hero');
      const styles = win.getComputedStyle(hero || doc.documentElement);
      cyan = styles.getPropertyValue('--cyan').trim() || '#56e9ff';
      blue = styles.getPropertyValue('--blue').trim() || '#19a9e4';
      mint = styles.getPropertyValue('--mint').trim() || '#43e9c4';
    }

    function getMode() {
      const hero = doc.getElementById('hero');
      if (doc.querySelector('#cameraVision.cam-scan')) return 'SCANNING';
      return hero && hero.dataset ? hero.dataset.mode || 'IDLE' : 'IDLE';
    }

    function getMediaStream() {
      const orb = win.MusicOrb;
      return orb && orb.stream ? orb.stream : null;
    }

    function drawCornerGuides(profile) {
      const size = Math.max(13, Math.min(27, width * .02));
      const inset = Math.max(13, Math.min(25, Math.min(width, height) * .022));
      context.save();
      context.strokeStyle = cyan;
      context.lineWidth = 1;
      context.globalAlpha = .12 + profile.intensity * .07;
      const corners = [
        [inset, inset, 1, 1], [width - inset, inset, -1, 1],
        [inset, height - inset, 1, -1], [width - inset, height - inset, -1, -1]
      ];
      for (const [x, y, sx, sy] of corners) {
        context.beginPath();
        context.moveTo(x + sx * size, y); context.lineTo(x, y); context.lineTo(x, y + sy * size);
        context.stroke();
      }
      context.restore();
    }

    function drawNetwork(profile, nowSeconds) {
      const positions = points.map((point, index) => ({
        x: point.x + Math.sin(nowSeconds * point.speed + point.phase) * point.depth * 7,
        y: point.y + Math.cos(nowSeconds * point.speed * .72 + point.phase) * point.depth * 6,
        point,
        index
      }));

      context.save();
      context.lineWidth = .75;
      for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
        const [from, to] = edges[edgeIndex];
        const a = positions[from], b = positions[to];
        const alpha = (.09 + profile.intensity * .08 + profile.mediaEnergy * .08) * visibilityAt((a.x + b.x) / 2, (a.y + b.y) / 2);
        context.strokeStyle = edgeIndex % 4 === 0 ? blue : cyan;
        context.globalAlpha = alpha;
        context.setLineDash(edgeIndex % 3 === 0 ? [2, 7] : []);
        context.beginPath();
        context.moveTo(a.x, a.y);
        const bend = Math.sin(nowSeconds * .12 + edgeIndex) * Math.min(26, width * .018);
        context.quadraticCurveTo((a.x + b.x) / 2 + bend, (a.y + b.y) / 2 - bend * .45, b.x, b.y);
        context.stroke();
      }

      // A few travelling light packets follow the same network, making the
      // screen-wide detail feel connected rather than randomly scattered.
      const packetEdges = [0, 2, 4, 7, 9, 12, 14, 17].filter(index => index < edges.length);
      for (let index = 0; index < packetEdges.length; index++) {
        const [from, to] = edges[packetEdges[index]];
        const a = positions[from], b = positions[to];
        const travel = (nowSeconds * (.035 + (index % 4) * .009) + index * .173) % 1;
        const progress = index % 2 ? 1 - travel : travel;
        const x = a.x + (b.x - a.x) * progress;
        const y = a.y + (b.y - a.y) * progress;
        context.globalAlpha = (.17 + profile.intensity * .16 + profile.mediaEnergy * .18) * visibilityAt(x, y);
        context.fillStyle = index % 3 === 0 ? mint : cyan;
        context.shadowColor = context.fillStyle;
        context.shadowBlur = 4 + profile.mediaEnergy * 4;
        context.beginPath(); context.arc(x, y, .8 + (index % 3) * .35, 0, Math.PI * 2); context.fill();
      }
      context.restore();

      context.save();
      for (const { x, y, point } of positions) {
        const alpha = (.13 + point.depth * .07 + profile.mediaEnergy * .1) * visibilityAt(x, y);
        context.globalAlpha = alpha;
        context.fillStyle = point.depth > .82 ? mint : cyan;
        context.shadowColor = context.fillStyle;
        context.shadowBlur = 3 + point.depth * 2;
        context.beginPath(); context.arc(x, y, .7 + point.depth * 1.05, 0, Math.PI * 2); context.fill();
      }
      context.restore();
    }

    function drawSweep(profile, nowSeconds) {
      const position = (nowSeconds / profile.scanPeriod) % 1;
      const y = position * height;
      const sweep = context.createLinearGradient(0, y - 24, 0, y + 24);
      sweep.addColorStop(0, rgba(cyan, 0));
      sweep.addColorStop(.5, rgba(cyan, .025 + profile.intensity * .018 + profile.mediaEnergy * .025));
      sweep.addColorStop(1, rgba(cyan, 0));
      context.fillStyle = sweep;
      context.fillRect(0, y - 24, width, 48);
      context.globalAlpha = .035 + profile.intensity * .025 + profile.mediaEnergy * .035;
      context.strokeStyle = cyan;
      context.lineWidth = 1;
      context.beginPath(); context.moveTo(0, Math.round(y) + .5); context.lineTo(width, Math.round(y) + .5); context.stroke();
      context.globalAlpha = 1;
    }

    function frame(now) {
      raf = 0;
      if (!activeWindow()) return;
      const staticOnly = Boolean(reducedMotion && reducedMotion.matches);
      const delta = lastFrame ? Math.min(.12, Math.max(0, (now - lastFrame) / 1000)) : 0;
      lastFrame = now;
      refreshZones(now);
      refreshTheme(now);

      const profile = animationProfile(getMode(), getMediaStream());
      currentSpeed += (profile.speed - currentSpeed) * Math.min(1, delta * 1.8);
      currentIntensity += (profile.intensity - currentIntensity) * Math.min(1, delta * 1.6);
      const smoothedProfile = { ...profile, speed: currentSpeed, intensity: currentIntensity };
      if (!staticOnly) phase += delta * currentSpeed;
      const nowSeconds = staticOnly ? 0 : phase;

      context.clearRect(0, 0, width, height);
      drawCornerGuides(smoothedProfile);
      drawNetwork(smoothedProfile, nowSeconds);
      drawSweep(smoothedProfile, nowSeconds);
      if (!staticOnly) queueFrame(targetFrameInterval(profile, width < 620, false));
    }

    function onVisibility() {
      if (!activeWindow()) { stopScheduledFrame(); return; }
      lastFrame = 0;
      queueFrame(0);
    }

    function onBlur() {
      stopScheduledFrame();
    }

    function onMotionPreference() {
      if (reducedMotion && reducedMotion.matches) {
        stopScheduledFrame();
        lastFrame = 0;
        if (activeWindow()) frame(win.performance.now());
      } else if (activeWindow()) {
        queueFrame(0);
      }
    }

    function dispose() {
      disposed = true;
      stopScheduledFrame();
      win.removeEventListener('resize', resize);
      win.removeEventListener('focus', onVisibility);
      win.removeEventListener('blur', onBlur);
      doc.removeEventListener('visibilitychange', onVisibility);
      if (reducedMotion && reducedMotion.removeEventListener) reducedMotion.removeEventListener('change', onMotionPreference);
      canvas.remove();
    }

    resize();
    refreshZones(win.performance.now());
    win.addEventListener('resize', resize, { passive: true });
    win.addEventListener('focus', onVisibility);
    win.addEventListener('blur', onBlur);
    doc.addEventListener('visibilitychange', onVisibility);
    if (reducedMotion && reducedMotion.addEventListener) reducedMotion.addEventListener('change', onMotionPreference);
    win.addEventListener('pagehide', dispose, { once: true });
    queueFrame(0);
    return { canvas, dispose };
  }

  return { anchorLayout, animationProfile, clamp, mediaEnergy, normalizeMode, start, targetFrameInterval };
});
