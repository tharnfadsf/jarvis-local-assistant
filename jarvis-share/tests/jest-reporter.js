#!/usr/bin/env node
// Standalone JUnit reporter for node --test. Writes test-results.xml.
// Run: node jest-reporter.js && node --test tests/*.test.js  --test-reporter=./jest-reporter.js
import { TestReporter } from 'node:test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok as assertOk } from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, 'test-results.xml');

class JUnitReporter extends TestReporter {
  constructor() {
    super();
    this._suite = null;
    this._tests = [];
    this._skipped = 0;
    this._failures = 0;
    this._time = 0;
  }

  async onSuite(suite) {
    this._suite = suite;
  }

  async onTest(test, state) {
    const started = test.duration ? test.duration : 0;
    this._time += started;
    const file = test.filepath ? test.filepath.replace(/\\/g, '/') : '';
    const name = test.name;
    const fullName = suiteFileName(this._suite) + '.' + name;
    let failureMessage = null;
    let failureType = null;
    if (state === 'fail') {
      this._failures++;
      const error = test.error;
      failureType = (error && error.name) || 'Error';
      failureMessage = error ? String(error.message || error).slice(0, 2000) : '';
    } else if (state === 'skip') {
      this._skipped++;
    }
    this._tests.push({ name: fullName, state, file, failureType, failureMessage, duration: started });
  }

  async onRunComplete(contexts, results) {
    const testsuites = buildXml(this._tests, this._time, this._skipped, this._failures, results);
    try {
      writeFileSync(outPath, testsuites, { encoding: 'utf8', mode: 0o644 });
    } catch (e) {
      this._errorHandler(e);
    }
  }

  _errorHandler(e) {
    if (typeof process !== 'undefined' && process.stderr) {
      process.stderr.write(`[junit-reporter] write failed: ${String(e && e.message || e)}\n`);
    }
  }
}

function suiteFileName(suite) {
  if (!suite) return 'jest';
  const file = suite.filepath;
  if (!file) return 'jest';
  return file.replace(/\\/g, '/').split('/').pop().replace(/\.test\.js$/i, '').slice(0, 200);
}

function buildXml(tests, timeMs, skipped, failures, results) {
  const started = new Date(results && results.startedAt ? results.startedAt : Date.now()).toISOString();
  const time = String((timeMs / 1000).toFixed(3));
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += `<testsuites tests="${tests.length}" failures="${failures}" skipped="${skipped}" time="${time}">\n`;
  xml += `  <testsuite name="jest" tests="${tests.length}" failures="${failures}" skipped="${skipped}" time="${time}">\n`;
  if (results && results.testsRun !== undefined) {
    xml += `    <properties>\n      <property name="tests" value="${tests.length}"/>\n      <property name="failures" value="${failures}"/>\n      <property name="skipped" value="${skipped}"/>\n      <property name="time" value="${time}"/>\n    </properties>\n`;
  }
  for (const t of tests) {
    const passed = t.state === 'pass' || t.state === undefined || t.state === null;
    const skipped = t.state === 'skip';
    const failure = t.state === 'fail';
    const className = t.file || 'jest';
    xml += `    <testcase name="${escapeXml(t.name)}" classname="${escapeXml(className)}" time="${String(t.duration / 1000).toFixed(6)}">\n`;
    if (skipped) {
      xml += `      <skipped/>\n`;
    } else if (failure) {
      const msg = t.failureMessage ? escapeXml(t.failureMessage) : '';
      xml += `      <failure type="${escapeXml(t.failureType)}" message="${msg}"/>\n`;
      const stack = t.failureType === 'Error' && msg ? escapeXml(msg) : '';
      if (stack) xml += `      <system-err>${stack}</system-err>\n`;
    }
    xml += `    </testcase>\n`;
  }
  xml += `  </testsuite>\n`;
  xml += `</testsuites>\n`;
  return xml;
}

function escapeXml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export default JUnitReporter;
