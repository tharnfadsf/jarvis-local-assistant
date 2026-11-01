// Re-applies the push-to-talk hotkey channel, the fast ASR decode and the
// asr-trace diagnostic to server.js.
//
// WHY THIS EXISTS: another work stream in this project keeps restoring older
// snapshots of server.js, which silently removes the push-to-talk hotkey
// channel (and the fast greedy decode). When that happens, run:
//
//     node tools/apply-ptt-hotkey-server.js
//
// from the jarvis folder, then restart the bridge (the desktop host restarts
// it within seconds, or kill the node process that owns the port).
//
// Every replacement is verified: the script aborts without writing if an
// anchor is missing or ambiguous, so it can never corrupt the file.
const fs = require('fs');
const path = require('path');
const target = path.join(__dirname, '..', 'server.js');
let text = fs.readFileSync(target, 'utf8');
const before = text;
const applied = [];
const already = [];
const skipped = [];

function swap(label, from, to) {
  if (!text.includes(from)) { skipped.push(label + ' (anchor not found)'); return; }
  if (text.split(from).length - 1 !== 1) { skipped.push(label + ' (anchor not unique)'); return; }
  text = text.replace(from, to);
  applied.push(label);
}
function ensure(label, marker, from, to) {
  if (text.includes(marker)) { already.push(label); return; }
  swap(label, from, to);
}

// 1) Fast, greedy decode (ASR-SPEED 2026-10-21).
ensure('greedy-flags', "'-bs', '1', '-nf'",
  "      '-bs', '5', '-bo', '5', '-tp', '0', '-et', '2.4', '-lpt', '-1.0', '-nth', '0.5',",
  "      '-bs', '1', '-nf',");
ensure('greedy-comment', 'ASR-SPEED 2026-10-21: greedy decoding',
  "    // ACTIVATION 3.0 flags: no-speech threshold 0.5 (0.6 ate quiet leading\n    // words like a soft \"Jarvis\"), --carry-initial-prompt so the entity prompt\n    // also guides very short utterances (bare \"Jarvis\"), temperature fallback\n    // kept (no -nf) for deterministic-first decoding.",
  "    // ASR-SPEED 2026-10-21: greedy decoding (beam 1) with temperature fallback\n    // disabled. Beam 5 plus six temperature retries turned noisy or music-backed\n    // clips into 45 s+ decodes; the client gave up at 35 s and the HUD reported a\n    // broken recognizer. Greedy keeps the same entity prompt and no-speech\n    // threshold and transcribes typical commands in 1-4 s.");

// 2) Do not retry a clip that already timed out.
ensure('no-retry-after-timeout', 'if (firstError && firstError.killed) throw firstError;',
  "    } catch (firstError) {\n      // JSON-full output can fail on odd builds; retry once as plain text so a\n      // flag regression never takes voice recognition fully offline.",
  "    } catch (firstError) {\n      // A timeout means whisper was genuinely too slow for this clip; retrying\n      // the same file only doubles a wait the user has already given up on.\n      if (firstError && firstError.killed) throw firstError;\n      // JSON-full output can fail on odd builds; retry once as plain text so a\n      // flag regression never takes voice recognition fully offline.");

// 3) Say how long the clip was and how long the decode took.
ensure('asr-failure-detail', 'audio=${((audio.length - 44)',
  "    console.error('[JARVIS local ASR]', error.message);",
  "    console.error('[JARVIS local ASR]', error.message, `audio=${((audio.length - 44) / 32000).toFixed(1)}s decode=${Date.now() - startedAt}ms`);");

// 4) The asr-trace diagnostic (one line per ASR request in desktop.log).
ensure('asr-trace', '[JARVIS asr-trace] ok',
  "          const out = await transcribeLocalWav(Buffer.concat(chunks));\n          // transcribeLocalWav now returns structured evidence; keep the",
  "          const out = await transcribeLocalWav(Buffer.concat(chunks));\n          console.log(`[JARVIS asr-trace] ok ${size}B decode=${out && out.decodeMs != null ? out.decodeMs + 'ms' : '?'} transcript=\"${String((out && out.transcript) || '').slice(0, 40)}\" conf=${out && out.confidence != null ? Number(out.confidence).toFixed(2) : '?'} noSpeech=${out && out.noSpeechProb != null ? Number(out.noSpeechProb).toFixed(2) : '?'}`);\n          // transcribeLocalWav now returns structured evidence; keep the");
ensure('asr-trace-fail', '[JARVIS asr-trace] FAIL',
  "        catch (error) { json(res, error.status || 503, { ok: false, message: error.message || 'Local speech recognition failed.' }); }",
  "        catch (error) { console.log(`[JARVIS asr-trace] FAIL ${size}B status=${(error && error.status) || 503} ${String((error && error.message) || error).slice(0, 90)}`); json(res, error.status || 503, { ok: false, message: error.message || 'Local speech recognition failed.' }); }");

// 5) The push-to-talk hotkey channel.
ensure('ptt-state', 'let pttEvent = { id: 0',
  "let asrBusy = false;",
  "let asrBusy = false;\n// PUSH-TO-TALK GLOBAL HOTKEY CHANNEL (2026-10-21). The desktop host owns a\n// system-wide keyboard hook, so the push-to-talk key works even when another\n// application has focus. The host posts the press/release here and the JARVIS\n// page polls the last event. In-memory only, never persisted.\nlet pttEvent = { id: 0, action: '', code: '', at: 0 };\nlet pttKeyConfig = { key: 'F9' };\n// PUSH-TO-TALK EVENT EXPIRY (2026-10-21). The bridge keeps the last hotkey\n// event in memory and the page polls it. A press that is older than this\n// window belongs to an earlier session: serving it would switch push-to-talk\n// on the moment the app is opened, with nobody touching the key.\nconst PTT_EVENT_TTL_MS = 4000;");
ensure('ptt-routes', "req.url === '/api/ptt/event'",
  "    if (req.method === 'GET' && req.url === '/api/media/status')",
  "    // PUSH-TO-TALK HOTKEY CHANNEL (2026-10-21). GET returns the last event so\n    // the page can pick up a press/release that happened while another window\n    // had focus; POST publishes a new event from the desktop host.\n    if (req.method === 'GET' && req.url === '/api/ptt/event') return json(res, 200, { ok: true, id: pttEvent.id, action: pttEvent.action, code: pttEvent.code, at: pttEvent.at });\n    if (req.method === 'GET' && req.url === '/api/ptt/config') return json(res, 200, { ok: true, key: pttKeyConfig.key });\n    if (req.method === 'POST' && req.url === '/api/ptt/config') {\n      const parts = []; let bytes = 0;\n      req.on('data', chunk => { bytes += chunk.length; if (bytes > 1000) { req.destroy(); return; } parts.push(chunk); });\n      req.on('end', () => {\n        try {\n          const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');\n          const key = String(body.key || '').trim().toUpperCase();\n          if (key) pttKeyConfig = { key };\n          json(res, 200, { ok: true, key: pttKeyConfig.key });\n        } catch { json(res, 400, { ok: false, message: 'Invalid push-to-talk key.' }); }\n      });\n      return;\n    }\n    if (req.method === 'POST' && req.url === '/api/ptt/event') {\n      const parts = []; let bytes = 0;\n      req.on('data', chunk => { bytes += chunk.length; if (bytes > 1000) { req.destroy(); return; } parts.push(chunk); });\n      req.on('end', () => {\n        try {\n          const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');\n          const action = String(body.action || '').toLowerCase() === 'release' ? 'release' : 'press';\n          const code = String(body.code || '').trim().toUpperCase();\n          if (code) pttEvent = { id: pttEvent.id + 1, action, code, at: Date.now() };\n          json(res, 200, { ok: true, id: pttEvent.id, action: pttEvent.action, code: pttEvent.code, at: pttEvent.at });\n        } catch { json(res, 400, { ok: false, message: 'Invalid push-to-talk event.' }); }\n      });\n      return;\n    }\n    if (req.method === 'GET' && req.url === '/api/media/status')");

// 5b) The event expiry window must exist even when the state block is already
// in place (a restore can bring the state back without the window).
ensure('ptt-ttl', 'const PTT_EVENT_TTL_MS = 4000;',
  "let pttKeyConfig = { key: 'F9' };",
  "let pttKeyConfig = { key: 'F9' };\n// PUSH-TO-TALK EVENT EXPIRY (2026-10-21). The bridge keeps the last hotkey\n// event in memory and the page polls it. A press that is older than this\n// window belongs to an earlier session: serving it would switch push-to-talk\n// on the moment the app is opened, with nobody touching the key.\nconst PTT_EVENT_TTL_MS = 4000;");

// 5c) The GET route must never serve an expired event.
ensure('ptt-event-expiry', "const expired = !pttEvent.at",
  "if (req.method === 'GET' && req.url === '/api/ptt/event') return json(res, 200, { ok: true, id: pttEvent.id, action: pttEvent.action, code: pttEvent.code, at: pttEvent.at });",
  "if (req.method === 'GET' && req.url === '/api/ptt/event') {\n      // An expired event is reported as an empty action: the page then sees\n      // \"nothing happened\" instead of a press from an earlier session.\n      const expired = !pttEvent.at || (Date.now() - pttEvent.at) > PTT_EVENT_TTL_MS;\n      return json(res, 200, { ok: true, id: pttEvent.id, action: expired ? '' : pttEvent.action, code: pttEvent.code, at: pttEvent.at });\n    }");

fs.writeFileSync(target, text);
console.log('applied: ' + (applied.join(', ') || '(nothing)'));
console.log('already present: ' + (already.join(', ') || '(nothing)'));
if (skipped.length) console.log('skipped: ' + skipped.join(', '));
console.log('bytes: ' + before.length + ' -> ' + text.length);
