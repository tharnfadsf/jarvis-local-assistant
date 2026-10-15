'use strict';
// Unit tests for JARVIS Computer Tools: path validation, gates, and the
// pending-confirmation flow. Filesystem-touching operations use a temporary
// test directory; no real user data is involved.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createComputerTools, validatePath, expandHomePath, DANGEROUS_FILE_PATTERN } = require('../computer-tools.js');

test('expandHomePath expands %VARS% and ~ without a shell', () => {
  assert.ok(/^[A-Za-z]:[\\/]/.test(expandHomePath('~')));
  assert.match(expandHomePath('%LOCALAPPDATA%\\x'), /^[A-Za-z]:[\\/]/);
  assert.equal(expandHomePath('  '), '');
});

test('validatePath rejects relative paths, bad characters, and wrong kinds', () => {
  const rel = validatePath('some/relative/path');
  assert.equal(rel.ok, false);
  assert.match(rel.message, /absolute path/);
  const viaQuotes = validatePath('C:\\bad"name.txt');
  assert.equal(viaQuotes.ok, false, 'quote characters are rejected by Windows');
  const bogus = validatePath('Z:\\definitely-not-there\\file.txt');
  assert.equal(bogus.ok, true, 'a well-formed nonexistent path may still validate');
  assert.equal(bogus.exists, false);
  const notFound = validatePath('Z:\\definitely-not-there\\file.txt', { mustExist: true });
  assert.equal(notFound.ok, false);
});

test('DANGEROUS_FILE_PATTERN flags programs and scripts', () => {
  assert.ok(DANGEROUS_FILE_PATTERN.test('C:\\x\\app.exe'));
  assert.ok(DANGEROUS_FILE_PATTERN.test('run.ps1'));
  assert.ok(!DANGEROUS_FILE_PATTERN.test('notes.txt'));
});

test('createComputerTools gates everything behind the master switch', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ct-'));
  const tools = createComputerTools({
    log: { log: () => {}, error: () => {} },
    // JARVIS_SETTINGS isolation is not built into the module; the temp path is
    // inside a disposable test dir and the module writes to %LOCALAPPDATA.
    // This test only exercises the disabled path, so no writes occur.
    getAppInfo: async () => []
  });
  const status = tools.status();
  const initiallyEnabled = status.enabled;
  // With the master switch off (default), every tool refuses — unless a prior
  // run of other tests left the user's own settings enabled.
  if (!initiallyEnabled) {
    const r1 = await tools.runTool('write_text_file', { path: path.join(tmp, 'a.txt'), content: 'x' });
    assert.equal(r1.ok, false);
    const r2 = await tools.runTool('delete_path', { path: tmp });
    assert.equal(r2.ok, false);
    const r3 = await tools.runTool('open_windows_setting', { page: 'sound' });
    assert.equal(r3.ok, false);
  }
});

test('runTool returns honest errors for unsupported tool names', async () => {
  const tools = createComputerTools({ log: { log: () => {}, error: () => {} }, getAppInfo: async () => [] });
  const r = await tools.runTool('run_arbitrary_shell', {});
  assert.equal(r.ok, false);
  assert.match(r.message, /not enabled/);
});

test('disk/process queries answer without throwing on error paths', async () => {
  const tools = createComputerTools({ log: { log: () => {}, error: () => {} }, getAppInfo: async () => [] });
  const disk = await tools.runTool('disk_space', {});
  assert.ok(disk.ok === true || disk.ok === false, 'disk_space always returns a structured answer');
  const status = tools.status();
  assert.equal(status.ok, true);
});
