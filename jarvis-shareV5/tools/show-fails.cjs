'use strict';
// Extracts failing tests and their error details from a node --test output file.
// The reporter uses mojibake prefixes on this Windows console: pass = Γ£ö, fail = Γ£û.
const fs = require('fs');
const file = process.argv[2];
const raw = fs.readFileSync(file);
// Detect UTF-16LE (starts with FFFE) vs UTF-8 (BOM EF BB BF).
let text;
if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) text = raw.toString('utf16le');
else text = raw.toString('utf8').replace(/^\uFEFF/, '');

const lines = text.split(/\r?\n/);
const passPrefix = '\u0393\u00a3\u00f6'; // Γ£ö
const failPrefix = '\u0393\u00a3\u00fb'; // Γ£û
const skipPrefix = '\u0393\u00a3\u00f9'; // Γ£ù (todo/skip)

let fails = 0;
let passes = 0;
const out = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  const t = l.trim();
  if (t.startsWith(failPrefix)) {
    fails++;
    out.push('\n===== FAIL: ' + t.slice(failPrefix.length).trim());
    // collect following indented detail lines until next test marker or blank summary
    for (let j = i + 1; j < lines.length; j++) {
      const n = lines[j];
      const nt = n.trim();
      if (nt.startsWith(passPrefix) || nt.startsWith(failPrefix) || nt.startsWith(skipPrefix)) break;
      if (/^[ℹ#]/.test(nt)) break;
      out.push(n);
    }
  } else if (t.startsWith(passPrefix)) {
    passes++;
  }
}
console.log(out.join('\n'));
console.log('\n===== SUMMARY =====');
console.log('pass=' + passes + ' fail=' + fails);
