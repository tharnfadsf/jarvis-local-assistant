// Ensures the bridge keeps the push-to-talk channel state. A concurrent work
// stream keeps restoring server.js snapshots that contain the routes but not
// the state, which makes the bridge throw "pttEvent is not defined" and fail.
const fs = require('fs');
const file = 'server.js';
let text = fs.readFileSync(file, 'utf8');
if (text.includes('let pttEvent = { id: 0')) {
  console.log('push-to-talk channel state already present.');
  process.exit(0);
}
const anchor = 'const expired = !pttEvent.at';
if (!text.includes(anchor)) {
  console.log('anchor not found - the bridge copy of the channel is not present; nothing to do.');
  process.exit(0);
}
const decl = [
  '// PUSH-TO-TALK HOTKEY CHANNEL (2026-10-21). The desktop host serves the',
  '// live press/release stream on its own port, so this bridge copy is only a',
  '// fallback - but the state must exist, or the fallback route throws.',
  "let pttEvent = { id: 0, action: '', code: '', at: 0 };",
  "let pttKeyConfig = { key: 'F9' };",
  'const PTT_EVENT_TTL_MS = 30000;',
  '',
].join('\n');
text = text.replace(anchor, decl + anchor);
fs.writeFileSync(file, text);
console.log('push-to-talk channel state inserted.');
