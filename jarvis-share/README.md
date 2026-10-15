# J.A.R.V.I.S. — Share Package

> Thai? Read `README-TH.md` (วิธีแชร์ภาษาไทย).
> Easiest send: run `Send-To-Discord.ps1` (asks for your webhook each time, never saves it).

Clean, shareable copy of the J.A.R.V.I.S. desktop assistant project.
No code was changed to build this folder — it is a curated copy of the
working project, minus local secrets, local build artefacts, and history.

> Local bridge untouched: your live `offline-asr/` binaries, `.env`,
> `planner-data.json`, `JARVIS.exe`, backups, and logs stay where they are
> in the main project folder. Nothing was moved or edited there.

## What's inside

Flat runtime layout (kept flat on purpose — the code uses relative
imports like `./jarvis-core.js`, so do not move files into subfolders):

- UI: `index.html`, `app.js`, `jarvis-core.js`, `music-orb.js`
- Server: `server.js`, `start-server.mjs`
- Features: `browser-tabs.js`, `computer-tools.js`, `screen-vision.js`,
  `media-monitor.js`, `system-monitor.js`, `youtube-discovery.js`,
  `discord.js`, `discord-bot.js`, `mail.js`, `situation.js`,
  `wakeword-oww.js`
- Config templates: `.env.example`, `manifest.json`,
  `conversation-library.json`, `creator-vocab.json`,
  `voice-correction-config.json`
- Launch: `Start-Jarvis.bat`, `Configure-Fish-Voice.bat`,
  `Configure-Fish-Voice.ps1`, `alarm.ps1`, `jarvis-audio-loopback.ps1`,
  `jarvis-media-sessions.ps1`, `restore-backup.ps1`,
  `fix-watchdog-admin.ps1`, `test-capture.ps1`
- Desktop: `JarvisDesktop.cs`, `jarvis.ico`, `jarvis-icon.png`
- Docs: `README.txt` (full manual), `SERVER_RESTART_GUIDE.md`
- `tests/`, `scripts/`, `wakeword-models/README.md`
- `offline-asr/` placeholder only (see below)

## What's NOT included (on purpose)

- `.env` — your API keys and personal settings. Share `.env.example` instead.
- `planner-data.json` — your local alarms, calendar, and reminders.
- `offline-asr/models/*.bin`, `offline-asr/runtime/*` — ~90 MB of local
  speech binaries. Kept out so this folder stays emailable.
- `JARVIS.exe` — your local desktop build. Rebuild on each machine.
- Backups (`backup-*`, `safety-backup-*`, `known-good-backup-*`,
  `_broken_backup*`), `*.bak`, `*.backup`, `*.log`, `tmp-*` — local history.
- `.git/` history — this folder is a fresh export, ready for its own repo.

See `SHARE-CONTENTS.txt` for the exact file list.

## Setup on a new machine

1. Copy this folder, then create your local config:
   `copy .env.example .env` and fill in your own keys.
2. Install prerequisites: Node.js and Microsoft Edge
   (see `README.txt` → Launch section).
3. Restore the local speech bridge (not included):
   copy your own `offline-asr/models/` and `offline-asr/runtime/`
   folders into `offline-asr/`, keeping the same layout.
4. Install Ollama for local AI (optional but recommended):
   https://ollama.ai — then pull a model, e.g. `ollama pull qwen3:1.7b`.
5. Launch with `Start-Jarvis.bat`.
6. Allow microphone access, enable Always Listen, say “Jarvis, open Steam”.

Full behaviour manual: open `README.txt` in this folder.

## Run the tests

From this folder:

    node --test tests/core.test.js tests/voice-improvements.test.js tests/memory.test.js tests/flows.test.js tests/files-tabs.test.js tests/server.test.js tests/browser-tabs.test.js tests/voice-echo-regression.test.js tests/calendar-music-tabs.test.js tests/phrase-expansion.test.js tests/email-voice-repair.test.js tests/file-calendar-repair.test.js tests/ai-orchestration.test.js tests/music-orb.test.js tests/music-orb-audio.test.js tests/media-monitor.test.js

(Matches the verified command in `README.txt`.)

## Push to GitHub

This folder has no `.git` history, so it can become a fresh repo:

    cd jarvis-share
    git init -b main
    git add .
    git commit -m "Share clean J.A.R.V.I.S. package"
    gh repo create your-name/jarvis --private --source=. --push
    # without the gh CLI:
    # git remote add origin https://github.com/your-name/jarvis.git
    # git push -u origin main

`.gitignore` in this folder already excludes `.env`,
`planner-data.json`, `*.log`, models, and binaries — check
`git status` before the first commit to confirm no secret is staged.

## Voice tips

- You don't need to say "open" every time: just say the app name —
  "Jarvis, Steam" opens Steam. Works for common apps, browsers, games,
  Windows utilities, and sites ("Jarvis, YouTube").
- "Open X" still works for everything, including apps not on the
  bare-name shortcut list.
