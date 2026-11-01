# Wake-word models (optional, offline, local-only)

The tuned Whisper + VAD pipeline works with **no downloads**. This folder
enables the optional openWakeWord `hey_jarvis` early-hint sidecar.

## Evaluated options

| Engine | Code license | Model license | Windows | `hey jarvis` model | Verdict |
|---|---|---|---|---|---|
| openWakeWord (dscripka) | Apache-2.0 | CC BY-NC-SA 4.0 (all pre-trained models) | Yes via onnxruntime (no tflite needed) | Yes: `hey_jarvis_v0.1` (.tflite + .onnx in releases) | **Selected** — exact phrase, browser-ready ONNX path (`melspectrogram` + `embedding` + `hey_jarvis`), 80 ms frames, threshold 0.5 |
| sherpa-onnx (k2-fsa) | Apache-2.0 | Apache-2.0 (check each model) | Yes (x64/x86/arm64), NodeJS + WASM | Custom KWS training required for "jarvis" | Fallback only — no pre-trained `jarvis` keyword, heavier native binaries. NOT installed (avoid competing engines). |

Do NOT assume the code license covers the models. openWakeWord's README
states pre-trained models are CC BY-NC-SA 4.0 (non-commercial, share-alike)
due to training-data licensing. Verify before any commercial use.

## Enable the sidecar (one-time, then stay offline)

1. Download from the official releases
   (https://github.com/dscripka/openWakeWord/releases) into this folder:
   - `melspectrogram.onnx`
   - `embedding_model.onnx`
   - `hey_jarvis_v0.1.onnx`
2. Keep them same-origin (upstream release assets omit CORS headers, so
   hot-linking fails — this is why they must be hosted locally).
3. Reload JARVIS, enable voice, watch the voice log for:
   `wake sidecar - local-models-present; early-hint mode`.
   Absence logs `local-models-missing ... pipeline unchanged` and everything
   works as before (fully reversible — delete the files to disable).
4. Vendor `onnxruntime-web` locally if you go beyond probing to full frame
   scoring (see the `openwakeword-web` pattern: kousthubraja/openWakeWord
   `web/`, Apache-2.0 code, models retain original licenses).

## Contract

- 16-bit 16 kHz mono PCM, frames that are multiples of 80 ms
  (1280 samples). Longer frames = more efficient, more latency.
- Score 0..1 per frame; default threshold 0.5. Tune with the 30-trial
  procedure in `WAKEWORD-TEST-PROCEDURE.md`, never by lowering blindly.
- The sidecar is an EARLY HINT only. Whisper text always decides commands;
  echo, contamination, duplicate, and busy guards stay authoritative.
- No audio is streamed, saved, or sent anywhere. No always-on transcription.

## Privacy

Inference runs on this PC. No cloud audio processing, no paid API, no
telemetry. The mic pipeline logs levels/scores/diagnostics only — never
continuous recordings.
