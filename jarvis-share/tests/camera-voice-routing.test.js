'use strict';
// Camera vs screen voice-routing tests (2026-10-14).
// Scope: transcript -> intent mapping only (pure, no camera/mic needed).
// Handler execution is verified in the desktop app per the task checklist.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../jarvis-core.js');

const lead = (spoken) => Core.stripPoliteLead(spoken).replace(/[.!?]+$/, '').trim();
const cam = (spoken) => Core.parseCameraIntent(lead(spoken), spoken);
const scr = (spoken) => Core.parseScreenIntent(lead(spoken), spoken);

test('all task camera commands route to the webcam with the right mode', () => {
  const cases = [
    ['Hey Jarvis, what am I holding?', 'identify'],
    ['Hey Jarvis, describe the scene.', 'scene'],
    ['Hey Jarvis, what is this?', 'identify'],
    ['Hey Jarvis, explain how this works.', 'explain'],
    ['Hey Jarvis, what am I looking at?', 'scene'],
    ['Hey Jarvis, identify that object.', 'identify'],
    ["Hey Jarvis, describe what's in front of me.", 'scene'],
    ['Hey Jarvis, read this.', 'readtext'],
    ['Hey Jarvis, analyze the camera.', 'identify'],
  ];
  for (const [spoken, mode] of cases) {
    const hit = cam(spoken);
    assert.ok(hit && (hit.kind === 'camera' || hit.kind === 'camera-follow'), `${spoken} must route to camera`);
    assert.equal(hit.mode, mode, `${spoken} must use mode ${mode}`);
    assert.equal(scr(spoken), null, `${spoken} must NOT route to screen`);
  }
});

test('screen commands stay on screen recognition, never the webcam', () => {
  for (const spoken of [
    'Hey Jarvis, what is on my screen?',
    'Hey Jarvis, describe what is on my screen',
    'Hey Jarvis, read the error on my screen',
    'Hey Jarvis, what app is open on my screen?',
  ]) {
    assert.ok(scr(spoken), `${spoken} must route to screen`);
    assert.equal(cam(spoken), null, `${spoken} must NOT route to camera`);
  }
});

test('wording variations, contractions, and polite leads still route', () => {
  const variants = [
    'Jarvis, what am I holding',
    'hey jarvis, DESCRIBE THE SCENE',
    'Hi Jarvis, could you identify that object?',
    'Hey Jarvis, please read this label for me',
    'Jarvis, how do I use this',
    'Hey Jarvis, what can I use this for',
    'Jarvis, compare these objects',
    'Hey Jarvis, take a frame and analyze',
    'Hey Jarvis, what is that thing?',
  ];
  for (const spoken of variants) {
    const hit = cam(spoken);
    assert.ok(hit && hit.kind === 'camera', `${spoken} must route to camera`);
  }
});

test('ordinary conversation never activates the camera', () => {
  for (const spoken of [
    'Hey Jarvis, what time is it?',
    'Hey Jarvis, tell me a joke',
    'Hey Jarvis, describe your day',
    'Hey Jarvis, how are you?',
    'Hey Jarvis, open YouTube',
    'Hey Jarvis, what did I ask yesterday?',
  ]) {
    assert.equal(cam(spoken), null, `${spoken} must NOT route to camera`);
    assert.equal(scr(spoken), null, `${spoken} must NOT route to screen`);
  }
});

test('anaphoric follow-ups map to camera-follow, not fresh intents', () => {
  for (const spoken of [
    'Hey Jarvis, describe it in more detail',
    'Hey Jarvis, in more detail',
    'Hey Jarvis, tell me more about it',
  ]) {
    const hit = cam(spoken);
    assert.ok(hit, `${spoken} must map to a camera follow-up`);
    assert.equal(hit.kind, 'camera-follow', spoken);
  }
  // "How does it work?" is answerable fresh (explain mode); the caller reuses
  // the last frame when one is recent via the follow-up window.
  const how = cam('Hey Jarvis, how does it work?');
  assert.ok(how && how.kind === 'camera' && how.mode === 'explain');
});
