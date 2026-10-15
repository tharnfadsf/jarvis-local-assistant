'use strict';
// ASR diagnostics tests (2026-10-14). The vague "needs attention" message now
// names the failing stage; these pin the classifier + shared WAV gate.
// Live transcription is verified in the desktop app per the task checklist.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../jarvis-core.js');

function wav({ bytes = 32044, rate = 16000, channels = 1, bits = 16, riff = 'RIFF', wave = 'WAVE' } = {}) {
  const buf = Buffer.alloc(bytes);
  buf.write(riff, 0); buf.writeUInt32LE(36, 4); buf.write(wave, 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * channels * (bits / 8), 28);
  buf.writeUInt16LE(channels * (bits / 8), 32); buf.writeUInt16LE(bits, 34);
  return buf;
}

test('valid 16kHz mono PCM passes the shared gate', () => {
  assert.deepEqual(Core.validateAsrWav(wav()).ok, true);
});

test('empty, tiny, and oversized audio are rejected as audio-stage', () => {
  assert.equal(Core.validateAsrWav(Buffer.alloc(0)).reason, 'empty-or-too-large');
  assert.equal(Core.validateAsrWav(Buffer.alloc(1199)).reason, 'empty-or-too-large');
  assert.equal(Core.validateAsrWav(Buffer.alloc(4 * 1024 * 1024 + 1)).reason, 'empty-or-too-large');
  assert.equal(Core.validateAsrWav(null).reason, 'empty-or-too-large');
});

test('wrong rate, channels, format, or container are rejected', () => {
  assert.equal(Core.validateAsrWav(wav({ rate: 48000 })).reason, 'bad-format');
  assert.equal(Core.validateAsrWav(wav({ channels: 2 })).reason, 'bad-format');
  assert.equal(Core.validateAsrWav(wav({ riff: 'RIFX' })).reason, 'bad-format');
  const badBits = wav({ bits: 8 });
  assert.equal(Core.validateAsrWav(badBits).reason, 'bad-format');
});

test('failures classify to the right stage', () => {
  assert.equal(Core.asrFailureInfo({ message: 'Local recognition request failed: fetch failed' }).stage, 'unreachable');
  assert.equal(Core.asrFailureInfo({ message: 'aborted' }).stage, 'unreachable');
  assert.equal(Core.asrFailureInfo({ status: 429, message: 'still transcribing' }).stage, 'busy');
  assert.equal(Core.asrFailureInfo({ status: 400, message: 'empty or too large' }).stage, 'audio');
  assert.equal(Core.asrFailureInfo({ status: 503, message: 'Local speech recognition files are missing. Restore the offline-asr folder' }).stage, 'model');
  assert.equal(Core.asrFailureInfo({ status: 503, message: 'recognition took too long' }).stage, 'timeout');
  assert.equal(Core.asrFailureInfo({ status: 503, message: 'could not process that audio' }).stage, 'decode');
  assert.equal(Core.asrFailureInfo({}).stage, 'unknown');
});

test('staged labels stay short and user-safe (no stack traces)', () => {
  const info = Core.asrFailureInfo({ status: 503, message: 'Error: ENOENT stack at foo()' });
  assert.ok(info.label.length <= 12);
  assert.ok(!/stack|at foo/.test(info.label));
});
