// Minimal compat helper for ESM test files importing from this project's
// tests/ directory. Re-exports describe/it from node:test and provides a
// chainable `expect(actual).toBe(expected).toMatch(pattern)` surface.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

export { describe, it };

function expect(actual) {
  return {
    toBe(expected) {
      assert.strictEqual(actual, expected);
      return this;
    },
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected);
      return this;
    },
    toMatch(pattern) {
      const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
      assert.ok(re.test(actual));
      return this;
    },
    toBeGreaterThan(n) {
      assert.ok(actual > n);
      return this;
    },
    toHaveLength(len) {
      assert.strictEqual(actual.length, len);
      return this;
    },
  };
}

export { expect };
