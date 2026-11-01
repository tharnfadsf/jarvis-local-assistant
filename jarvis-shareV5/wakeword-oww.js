/* JARVIS wake-word sidecar — openWakeWord (optional) + tuned local fallback.
 *
 * Purpose: improve "Jarvis" detection at normal speaking volume without
 * replacing the existing Whisper command pipeline.
 *
 * - Primary (always available): the existing mic -> VAD -> Whisper -> text
 *   path in app.js, with the tuning fixes applied there (quiet-audio gate
 *   ordering, mid-sentence wake acceptance, disconnect/drop diagnostics).
 * - Optional enhancement: official openWakeWord "hey_jarvis" model run
 *   locally via onnxruntime-web using 16 kHz mono 80 ms (1280-sample) frames.
 *   When model files are present under /wakeword-models/, app.js loads this
 *   file dynamically and uses scores as an EARLY wake hint only. Whisper
 *   remains the final command recognizer. When files are absent, this module
 *   reports `available:false` and the pipeline is unchanged (fully reversible).
 *
 * Privacy: all inference is local. No audio is streamed, saved, or sent to
 * any cloud service. No always-on transcription is added.
 *
 * Licenses (do NOT assume one covers the other):
 * - openWakeWord code: Apache-2.0 (https://github.com/dscripka/openWakeWord)
 * - openWakeWord pre-trained models (incl. hey_jarvis_v0.1): Creative Commons
 *   Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0),
 *   per the openWakeWord README. Verify before any commercial use.
 * - openwakeword-web browser port pattern (kousthubraja/openWakeWord `web/`):
 *   Apache-2.0 for code; bundled model files retain their original licenses.
 * - onnxruntime-web: check its own license when vendoring.
 *
 * Expected local files (NOT shipped; download once, stay offline after):
 *   wakeword-models/melspectrogram.onnx
 *   wakeword-models/embedding_model.onnx
 *   wakeword-models/hey_jarvis_v0.1.onnx
 * Source: official openWakeWord GitHub releases
 * (https://github.com/dscripka/openWakeWord/releases). Keep them same-origin
 * (the upstream release assets omit CORS headers, so hot-linking fails).
 *
 * Frame contract (matches openWakeWord): 16-bit 16 kHz mono PCM, frames that
 * are multiples of 80 ms. Longer frames raise efficiency but add latency.
 * Default threshold 0.5 per openWakeWord docs; TUNE with measured tests, never
 * by lowering until everything triggers.
 */
(() => {
  'use strict';

  const DEFAULTS = {
    threshold: 0.5,
    modelsPath: '/wakeword-models/',
    files: ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx'],
    sampleRate: 16000,
    frameSamples: 1280, // 80 ms @ 16 kHz
  };

  const state = {
    available: false,
    reason: 'not-initialized',
    threshold: DEFAULTS.threshold,
    lastScore: 0,
    activations: 0,
    frames: 0,
    lastActivationAt: 0,
    cooldownMs: 2500, // one activation per 2.5 s max (matches duplicate guard in app.js)
  };

  // Pure helper (unit-testable, no audio needed): turn a 0..1 frame score into
  // a wake decision with cooldown. Returns {fired, score}.
  function scoreToDecision(score, { threshold = DEFAULTS.threshold, now = Date.now(), lastAt = 0, cooldownMs = state.cooldownMs } = {}) {
    const s = Math.max(0, Math.min(1, Number(score) || 0));
    if (!(s >= threshold)) return { fired: false, score: s };
    if (lastAt && now - lastAt < cooldownMs) return { fired: false, score: s, cooledDown: true };
    return { fired: true, score: s };
  }

  // Downsample + interleave-safe: collapse any AudioContext rate to 16 kHz
  // mono float for the ONNX front-end. Pure and testable.
  function to16kMono(input, sourceRate, targetRate = DEFAULTS.sampleRate) {
    const src = input instanceof Float32Array ? input : Float32Array.from(input || []);
    if (!src.length || !(sourceRate > 0)) return new Float32Array(0);
    if (sourceRate === targetRate) return src.slice();
    const outLen = Math.max(1, Math.floor(src.length * targetRate / sourceRate));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * sourceRate / targetRate;
      const left = Math.floor(pos), mix = pos - left;
      const a = src[left] || 0, b = src[Math.min(left + 1, src.length - 1)] || 0;
      const v = a * (1 - mix) + b * mix;
      out[i] = Math.max(-1, Math.min(1, v));
    }
    return out;
  }

  // Probe for locally vendored model files without downloading weights.
  // Uses HEAD so no audio or model bytes move unless the host serves them.
  async function probeLocalModels(modelsPath = DEFAULTS.modelsPath, files = DEFAULTS.files) {
    const checked = [];
    for (const name of files) {
      try {
        const res = await fetch(modelsPath + name, { method: 'HEAD', cache: 'no-cache' });
        checked.push({ file: name, ok: res.ok, status: res.status });
      } catch (error) {
        checked.push({ file: name, ok: false, status: 0, error: String((error && error.message) || error) });
      }
    }
    return checked;
  }

  async function init({ threshold = DEFAULTS.threshold, modelsPath = DEFAULTS.modelsPath } = {}) {
    state.threshold = Math.max(0.05, Math.min(0.95, Number(threshold) || DEFAULTS.threshold));
    const checked = await probeLocalModels(modelsPath, DEFAULTS.files);
    const missing = checked.filter(c => !c.ok).map(c => c.file);
    if (missing.length) {
      state.available = false;
      state.reason = `local-models-missing: ${missing.join(', ')} (pipeline unchanged; see wakeword-models/README.md)`;
      return { available: false, reason: state.reason, checked };
    }
    // Models are present but onnxruntime-web wiring is intentionally NOT
    // auto-initialized here: the host page (app.js) owns the AudioContext and
    // must pass 16 kHz frames explicitly. This keeps the sidecar side-effect
    // free and reversible. Full ONNX session code belongs in the documented
    // port (openwakeword-web pattern) once vendored.
    state.available = true;
    state.reason = 'local-models-present; early-hint mode (Whisper still decides commands)';
    return { available: true, reason: state.reason, checked };
  }

  function recordScore(score, now = Date.now()) {
    state.frames += 1;
    state.lastScore = Math.max(0, Math.min(1, Number(score) || 0));
    const d = scoreToDecision(state.lastScore, { threshold: state.threshold, now, lastAt: state.lastActivationAt, cooldownMs: state.cooldownMs });
    if (d.fired) {
      state.activations += 1;
      state.lastActivationAt = now;
    }
    return d;
  }

  function snapshot() {
    return {
      available: state.available, reason: state.reason, threshold: state.threshold,
      lastScore: state.lastScore, frames: state.frames, activations: state.activations,
      lastActivationAt: state.lastActivationAt, engine: 'openWakeWord-hey_jarvis (optional sidecar)',
      modelLicense: 'CC BY-NC-SA 4.0', codeLicense: 'Apache-2.0', offline: true,
    };
  }

  const api = { DEFAULTS, scoreToDecision, to16kMono, probeLocalModels, init, recordScore, snapshot, _state: state };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.JarvisWakeWord = api;
})();
