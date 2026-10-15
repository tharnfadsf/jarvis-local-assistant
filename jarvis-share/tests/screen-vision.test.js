'use strict';
// Unit tests for JARVIS Screen Vision pure helpers: vision-model selection,
// vision request building, screenshot naming, and capture-target handling.
// The Windows capture itself and live inference are verified at runtime.
const test = require('node:test');
const assert = require('node:assert');
const { pickVisionModel, buildVisionRequestBody, screenshotFileName, normalizeTarget, expandHomeJars } = require('../screen-vision.js');

test('pickVisionModel selects only vision-capable models', () => {
  const models = [
    { name: 'qwen3:1.7b', capabilities: ['completion', 'tools'] },
    { name: 'qwen3.5:4b', capabilities: ['completion', 'vision'] },
    { name: 'qwen3.8:27b', capabilities: ['vision'] }
  ];
  const pick = pickVisionModel(models, '');
  assert.equal(pick.ok, true);
  assert.equal(pick.model, 'qwen3.5:4b');
  assert.equal(pickVisionModel(models, 'qwen3.8:27b').model, 'qwen3.8:27b');
  assert.equal(pickVisionModel(models, 'qwen3:1.7b').ok, false, 'a text-only model must not be claimed as vision-capable');
});

test('pickVisionModel reports honestly when nothing supports vision', () => {
  const pick = pickVisionModel([{ name: 'qwen3:1.7b', capabilities: ['completion'] }], '');
  assert.equal(pick.ok, false);
  assert.match(pick.message, /No locally installed Ollama model supports image/);
  const empty = pickVisionModel([], '');
  assert.equal(empty.ok, false);
});

test('buildVisionRequestBody clamps options and embeds the image', () => {
  const body = buildVisionRequestBody({ question: 'What error is shown?', model: 'qwen3.5:4b', imageB64: 'abc', options: { numCtx: 999, maxTokens: 99999 } });
  assert.equal(body.model, 'qwen3.5:4b');
  assert.equal(body.stream, false);
  assert.equal(body.options.num_ctx, 2048);
  assert.equal(body.options.num_predict, 1024);
  assert.deepEqual(body.messages[0].images, ['abc']);
  assert.match(body.messages[0].content, /What error is shown\?/);
});

test('screenshotFileName produces unique timestamped names', () => {
  const now = new Date(2026, 10, 11, 11, 22, 33); // month index 10 = November
  const first = screenshotFileName(now, 'window');
  assert.match(first, /^jarvis-window-20261111-112233\.png$/);
  const clash = new Set([first.toLowerCase()]);
  const second = screenshotFileName(now, 'window', clash);
  assert.match(second, /-2\.png$/);
  assert.notEqual(second, first);
});

test('normalizeTarget accepts spoken variants and rejects unknown ones', () => {
  assert.equal(normalizeTarget('monitor2'), 'display2');
  assert.equal(normalizeTarget('Display 2'), 'display2');
  assert.equal(normalizeTarget('desktop'), 'desktop');
  assert.equal(normalizeTarget('window'), 'window');
  assert.equal(normalizeTarget('banana'), 'screen');
  assert.equal(normalizeTarget(''), 'screen');
});

test('expandHomeJars expands env vars and ~ without shell', () => {
  const home = expandHomeJars('~');
  assert.ok(/^[A-Za-z]:[\\/]/.test(home), 'home resolves to an absolute path');
  const local = expandHomeJars('%LOCALAPPDATA%\\JARVIS\\Screenshots');
  assert.match(local, /^[A-Za-z]:[\\/]/);
  assert.ok(local.includes('JARVIS'));
  assert.equal(expandHomeJars('relative/folder'), 'relative/folder');
});
