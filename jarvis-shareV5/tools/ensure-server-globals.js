// Ensures the module-level constants that server.js depends on exist.
//
// A concurrent work stream refactored server.js and dropped several
// module-scope declarations (asrCliPath, asrModelPath, ASR_PROMPT, the ASR
// queue state, systemMonitor, plannerData). Every request that touched them
// then failed at runtime - the speech recognizer answered HTTP 503, the system
// monitor logged a ReferenceError every second.
//
//   node tools/ensure-server-globals.js
//
// The script is idempotent: it only adds what is missing.
const fs = require('fs');
const file = 'server.js';
let text = fs.readFileSync(file, 'utf8');
const added = [];

function has(pattern) { return new RegExp('^\\s*(const|let|var)\\s+' + pattern + '\\b', 'm').test(text); }
function add(name, code) {
  if (has(name)) return;
  const anchor = "const root = __dirname;";
  if (!text.includes(anchor)) { console.log('anchor not found - cannot insert ' + name); return; }
  text = text.replace(anchor, anchor + '\n' + code);
  added.push(name);
}

add('asrCliPath', "// Offline speech recognizer (whisper.cpp) and its model.\nconst asrCliPath = path.join(root, 'offline-asr', 'runtime', 'Release', 'whisper-cli.exe');\nconst asrModelPath = path.join(root, 'offline-asr', 'models', 'ggml-base.en-q8_0.bin');");
add('ASR_PROMPT', "const ASR_PROMPT = 'JARVIS. Open, close, start, search, play, pause, resume. Frieren, Roblox, YouTube, Google, Discord, Loverboy, Magnetic, anime, playlist, calendar, reminder, alarm.';");
add('asrBusy', "// Single-slot recognizer queue state.\nlet asrBusy = false;\nlet asrTail = Promise.resolve();\nlet asrWaiters = 0;");
add('systemMonitor', "const systemMonitor = createSystemMonitor({ root });");
add('plannerData', "let plannerData = { alarms: [], reminders: [], events: [] };");

fs.writeFileSync(file, text);
console.log('added: ' + (added.join(', ') || '(nothing - all present)'));
