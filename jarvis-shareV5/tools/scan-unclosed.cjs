'use strict';
// Finds unclosed delimiters and extra closers in a JS file, ignoring strings,
// comments, template literals and regex literals. Prints remaining openers.
const fs = require('fs');
const file = process.argv[2];
const raw = fs.readFileSync(file, 'utf8').split('\n');
const s = raw.join('\n');

let line = 1;
let i = 0;
let state = null; // null | 'lc' | 'bc' | "'" | '"' | '`' | 're'
const tplStack = [];
const stack = []; // {ch, line}
let prevSig = '';

function isRegexStart() {
  if (!prevSig) return true;
  return !/[a-zA-Z0-9_$)\]'"`]/.test(prevSig);
}

while (i < s.length) {
  const c = s[i], n = s[i + 1];
  if (c === '\n') { line++; if (state === 'lc') state = null; i++; continue; }
  if (state === 'lc' || state === 'bc') {
    if (state === 'bc' && c === '*' && n === '/') { state = null; i += 2; continue; }
    i++; continue;
  }
  if (state === "'" || state === '"') {
    if (c === '\\') { i += 2; continue; }
    if ((state === "'" && c === "'") || (state === '"' && c === '"')) { state = null; prevSig = '"'; }
    i++; continue;
  }
  if (state === '`') {
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { state = tplStack.pop() || null; prevSig = '"'; i++; continue; }
    if (c === '$' && n === '{') { tplStack.push('`'); state = null; stack.push({ ch: '{', line }); prevSig = '{'; i += 2; continue; }
    i++; continue;
  }
  if (state === 're') {
    if (c === '\\') { i += 2; continue; }
    if (c === '[') { i++; while (i < s.length && s[i] !== ']') { if (s[i] === '\\') i++; i++; } i++; continue; }
    if (c === '/') { state = null; prevSig = '"'; i++; while (/[gimsuy]/.test(s[i] || '')) i++; continue; }
    if (c === '\n') { state = null; line++; i++; continue; }
    i++; continue;
  }
  if (c === '/' && n === '/') { state = 'lc'; i += 2; continue; }
  if (c === '/' && n === '*') { state = 'bc'; i += 2; continue; }
  if (c === "'" || c === '"') { state = c; i++; continue; }
  if (c === '`') { tplStack.push(state); state = '`'; i++; continue; }
  if (c === '/' && isRegexStart()) {
    let j = i + 1, ok = false;
    while (j < s.length && s[j] !== '\n') {
      if (s[j] === '\\') { j += 2; continue; }
      if (s[j] === '[') { j++; while (j < s.length && s[j] !== ']') { if (s[j] === '\\') j++; j++; } j++; continue; }
      if (s[j] === '/') { ok = true; break; }
      j++;
    }
    if (ok) { state = 're'; i++; continue; }
    prevSig = c; i++; continue;
  }
  if (/\s/.test(c)) { i++; continue; }
  if (c === '{' || c === '(' || c === '[') { stack.push({ ch: c, line }); prevSig = c; i++; continue; }
  if (c === '}' || c === ')' || c === ']') {
    const open = c === '}' ? '{' : c === ')' ? '(' : '[';
    if (stack.length && stack[stack.length - 1].ch === open) stack.pop();
    else {
      console.log(`EXTRA/UNMATCHED closer ${c} at line ${line}`);
    }
    prevSig = c; i++; continue;
  }
  prevSig = c; i++;
}

console.log('Remaining unclosed openers:', stack.length);
for (const item of stack.slice(-40)) {
  console.log(`  ${item.ch} at line ${item.line}`);
}
if (stack.length > 40) {
  console.log('  ... and', stack.length - 40, 'more (deepest first):');
  for (const item of stack.slice(0, 40)) {
    console.log(`  ${item.ch} at line ${item.line}`);
  }
}
