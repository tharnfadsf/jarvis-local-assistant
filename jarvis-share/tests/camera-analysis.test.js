import { describe, it, expect } from './_compat.mjs';
import { createScreenVision, validateCameraImage, pickVisionModel } from '../screen-vision.js';

const sv = createScreenVision({ root: process.cwd(), ollamaUrl: 'http://127.0.0.1:11434', log: () => {} });

describe('screen-vision camera image validation', () => {
  it('rejects garbage that is not base64', () => {
    const r = validateCameraImage('this is not an image');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no camera frame|unreadable/i);
  });
  it('rejects an empty frame', () => {
    expect(validateCameraImage('').ok).toBe(false);
  });
  it('rejects a frame below the minimum size', () => {
    const r = validateCameraImage('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12NgYGB4DwABAgEAff9zWQAAAABJRU5ErkJggg==');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/blank or too small/i);
  });
  it('accepts a real, adequately sized PNG frame', () => {
    const b64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAE6SURBVHhe7cgxAQAADIOw+TfdCUACHHlyty1iiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKIygPcUksyyfhVMwAAAABJRU5ErkJggg==';
    const r = validateCameraImage(b64);
    expect(r.ok).toBe(true);
    expect(typeof r.imageB64).toBe('string');
    expect(r.imageB64.length).toBeGreaterThan(500);
  });
  it('strips data:image prefix before acceptance', () => {
    const b64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAE6SURBVHhe7cgxAQAADIOw+TfdCUACHHlyty1iiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKICyIuiLgg4oKIygPcUksyyfhVMwAAAABJRU5ErkJggg==';
    const r = validateCameraImage(b64);
    expect(r.ok).toBe(true);
    expect(r.imageB64.startsWith('iVBOR')).toBe(true);
  });
});

describe('screen-vision pickVisionModel', () => {
  const capable = [
    { name: 'qwen3:1.7b', capabilities: ['completion','tools'] },
    { name: 'qwen3.5:4b', capabilities: ['completion','vision'] },
    { name: 'qwen3.8:27b', capabilities: ['completion','vision','tools'] },
  ];
  it('picks the first vision-capable model when none is preferred', () => {
    const r = pickVisionModel(capable, '');
    expect(r.ok).toBe(true);
    expect(r.model).toBe('qwen3.5:4b');
  });
  it('honors a preferred vision model', () => {
    const r = pickVisionModel(capable, 'qwen3.8:27b');
    expect(r.ok).toBe(true);
    expect(r.model).toBe('qwen3.8:27b');
  });
  it('rejects a preferred model that is not vision-capable', () => {
    expect(pickVisionModel(capable, 'qwen3:1.7b').ok).toBe(false);
  });
  it('reports honestly when nothing supports vision', () => {
    expect(pickVisionModel([{ name: 'tiny', capabilities: [] }], '').ok).toBe(false);
  });
});
