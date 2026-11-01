# J.A.R.V.I.S. — Share Package

> Thai? Read `README-TH.md` (วิธีแชร์ภาษาไทย).
> **Download page:** Open `download.html` in a browser for platform-specific packages.
> Easiest send: run `Send-To-Discord.ps1` (asks for your webhook each time, never saves it).

Clean, shareable copy of the J.A.R.V.I.S. desktop assistant project.
**Now with cross-platform support for Windows and macOS.**
No code was changed to build this folder — it is a curated copy of the
working project, minus local secrets, local build artefacts, and history.

> Local bridge untouched: your live `offline-asr/` binaries, `.env`,
> `planner-data.json`, `JARVIS.exe`, backups, and logs stay where they are
> in the main project folder. Nothing was moved or edited there.
## GitHub

This is a **share package** — a self-contained, distributable copy of JARVIS
that works on any Windows PC out of the box.

### Quick start

1. Extract the folder
2. Copy `.env.example` to `.env` and fill in your API keys (Fish Audio, etc.)
3. Double-click **Start-Jarvis.bat**
4. JARVIS.exe launches the server, opens your browser, and installs the
   system-wide push-to-talk hotkey

### What's included

- **Voice recognition** — Whisper.cpp + English model (offline, local)
- **Push-to-talk** — global hotkey via JARVIS.exe system hook (works in any app)
- **Music orb** — visualizer + transport controls
- **All themes** — sakura, venom, bloom, mist, sparks, fireflies, aurora,
  rainbow, ripple, stars, leaves, symbiote, spiderman
- **No Iron Man suit** — the default theme is clean

### Size

~110 MB (includes the 78 MB Whisper English model)

### Requirements

- Windows 10/11
- Node.js v18+ (already bundled via node_modules/ws)
- A microphone

### API keys (optional)

Create `.env` from `.env.example`. Keys you may want to add:
- FISH_API_KEY — Fish Audio voice (cloud TTS, optional)
- JARVIS_OLLAMA_URL — local Ollama for AI (optional)
- Discord bot token + webhook (optional)
- SMTP settings (optional, for email)

JARVIS works without any keys — voice and local features all work offline.

### Building from source

The desktop host (JARVIS.exe) source is in `JarvisDesktop.cs`.
Compile with the .NET SDK targeting Windows desktop.

---
## Supported Platforms

| Platform | Architectures | Installer | Status |
|----------|---------------|-----------|--------|
| Windows 10/11 | x64, ARM64 | `.exe` installer, `.zip` | ✅ Verified |
| macOS 10.15+ | Intel (x64), Apple Silicon (ARM64) | `.dmg`, `.zip`, `.app` | ✅ Verified |
| Linux | x64, ARM64 | Manual (ZIP) | 🧪 Experimental |

## What's inside

Flat runtime layout (kept flat on purpose — the code uses relative
imports like `./jarvis-core.js`, so do not move files into subfolders):

- UI: `index.html`, `app.js`, `jarvis-core.js`, `music-orb.js`
- Server: `server.js`, `start-server.mjs`, `memory-vault.js`
- Features: `browser-tabs.js`, `computer-tools.js`, `platform.js`,
  `screen-vision.js`, `screen-assist.js` (screen pointing), `screen-help-phrases.js`,
  `media-monitor.js`, `system-monitor.js`, `youtube-discovery.js`,
  `discord.js`, `discord-bot.js`, `mail.js`, `situation.js`,
  `wakeword-oww.js`, `ai-router.js`
- Config templates: `.env.example`, `manifest.json`,
  `conversation-library.json`, `creator-vocab.json`,
  `voice-correction-config.json`
- Launch: `Start-Jarvis.bat`, `start-jarvis.sh`, `Configure-Fish-Voice.bat`,
  `Configure-Fish-Voice.ps1`, `alarm.ps1`, `jarvis-audio-loopback.ps1`,
  `jarvis-media-sessions.ps1`, `restore-backup.ps1`,
  `fix-watchdog-admin.ps1`, `test-capture.ps1`
- Desktop: `JarvisDesktop.cs`, `jarvis.ico`, `jarvis-icon.png`
- Docs: `README.md`, `README-TH.md`, `README.txt` (full manual), `SERVER_RESTART_GUIDE.md`, `download.html`
- `tests/`, `scripts/`, `wakeword-models/README.md`
- `offline-asr/` — whisper.cpp runtime + English base model (included)

## What it can do

- **Voice control, fully local** — open apps, games and sites, type, click,
  scroll and drive the browser. Speech never leaves the machine.
- **Screen pointing (screen help)** — say "where is this button?",
  "where do I click to send?" or "point me at the reply box" and JARVIS
  looks at the screen locally, then marks the exact spot with the blue
  pointer for about 25 seconds ("close screen help" clears it). A generic
  "help me" or "I'm stuck" gets the same pointer offered. When JARVIS is
  not fully sure, the spoken answer says so instead of pretending.
- **Camera and screen analysis** — ask questions about your webcam or
  what is on the screen right now.
- **Memory** — notes and conversation history are saved as plain Markdown
  you can open later in Obsidian or any editor.
- **Music and media** — play/pause/skip, volume, and real YouTube picks.
- **Calendar, alarms, reminders** — plus email and Discord actions.
- **Voice modes and helpers** — study, gaming, focus, coding, relax and
  more; system monitor; file, window and browser tools.
- **Cross-platform app control** — "Open Calculator", "Close Chrome", "Switch to Safari" work on both Windows and macOS.

## What's NOT included (on purpose)

- `.env` — your API keys and personal settings. Share `.env.example` instead.
- `planner-data.json` — your local alarms, calendar, and reminders.
- ,  — ~90 MB of local
  speech binaries. Kept out so this folder stays emailable.
- `JARVIS.exe` / `JARVIS.app` — your local desktop build. Rebuild on each machine.
- Backups (`backup-*`, `safety-backup-*`, `known-good-backup-*`,
  `_broken_backup*`), `*.bak`, `*.backup`, `*.log`, `tmp-*` — local history.
- `.git/` history — this folder is a fresh export, ready for its own repo.

See `SHARE-CONTENTS.txt` for the exact file list.

## Quick Start (Windows)

1. **Download:** Open `download.html` and download the Windows installer or ZIP.
2. **Install:** Run the `.exe` installer, or extract the ZIP to a folder.
3. **Configure:** Copy `.env.example` to `.env` and fill in your keys.
4. **Prerequisites:** Install Node.js 18+ and Chrome/Edge/Brave.
5. **Offline speech:** The `offline-asr/` folder with Whisper model and runtime is included. Local voice works out of the box.
6. **Ollama (optional):** `winget install Ollama.Ollama` then `ollama pull qwen3:1.7b`.
7. **Launch:** Run `Start-Jarvis.bat` (or double-click `JARVIS.exe` if built).
8. **Test:** Allow microphone, click "ENABLE VOICE", say "Jarvis, open Chrome".

## Quick Start (macOS)

1. **Download:** Open `download.html` and download the `.dmg` or `.zip`.
2. **Install:** Open the `.dmg` and drag `JARVIS.app` to Applications, or extract the ZIP.
3. **Configure:** Copy `.env.example` to `.env` and fill in your keys.
   ```bash
   cp .env.example .env
   # Edit .env with your favorite editor
   ```
4. **Prerequisites:** Install Node.js 18+ (`brew install node`) and Chrome/Edge/Brave.
5. **Offline speech:** The `offline-asr/` folder is included.
6. **Ollama (optional):** `brew install ollama` then `ollama pull qwen3:1.7b`.
7. **Launch:** Double-click `JARVIS.app` in Applications, or run `./start-jarvis.sh` from Terminal.
8. **Permissions:** Grant Microphone, Screen Recording, and Accessibility permissions when prompted.
9. **Test:** Click "ENABLE VOICE", say "Jarvis, open Safari".

## Platform-Specific Features

| Feature | Windows | macOS |
|---------|---------|-------|
| App launch/close | ✅ Full | ✅ Full |
| Browser tab control (Chrome/Edge) | ✅ Full | ✅ Full |
| System monitor (CPU/RAM/GPU) | ✅ Full | ✅ Full (no GPU util) |
| File operations | ✅ Full | ✅ Full |
| Screen pointing | ✅ Full | ✅ Full |
| Camera access | ✅ Full | ✅ Full |
| Wake-word detection | ✅ Full | ✅ Full |
| Local TTS (Fish Audio) | ✅ Full | ✅ Full |
| Windows TTS fallback | ✅ Yes | N/A |
| macOS TTS fallback | N/A | ✅ Yes |
| Discord webhook | ✅ Full | ✅ Full |
| Persistent alarms (Task Scheduler) | ✅ Yes | ⚠️ Use Discord/webhook |
| PowerShell automation | ✅ Full | ❌ N/A |
| AppleScript automation | ❌ N/A | ✅ Full |

## Memory & Data Locations

| Platform | Path |
|----------|------|
| Windows | `%LOCALAPPDATA%\JARVIS\` |
| macOS | `~/Library/Application Support/JARVIS/` |
| Linux | `~/.local/share/JARVIS/` |

Memory vault (Markdown notes + conversation logs):
- Windows: `%USERPROFILE%\Documents\JARVIS\`
- macOS: `~/Documents/JARVIS/`
- Linux: `~/Documents/JARVIS/`

Set `JARVIS_VAULT_PATH` in `.env` to customize.

## Security & Privacy

- **No personal data bundled:** No API keys, conversation history, browser profiles, or private config.
- **No credential theft:** Roblox cookies, browser sessions, and auth tokens are never collected or transmitted.
- **Local-only processing:** Speech recognition, wake-word, and screen analysis run entirely on your machine.
- **Transparent network:** Only explicit features (Fish Audio TTS, Ollama AI, Discord webhooks) make outbound requests.
- **Permissions:** Uses OS-native permission dialogs for microphone, camera, screen, and accessibility.

## Build from Source

```bash
# Windows
node scripts/build-windows.js

# macOS
node scripts/build-macos.js

# Or use the universal script
node scripts/package.js current
```

Outputs go to `dist/` with SHA256 checksums.

## Run the Tests

```bash
# Core tests
node --test tests/core.test.js tests/voice-improvements.test.js tests/memory.test.js tests/flows.test.js tests/files-tabs.test.js tests/server.test.js tests/browser-tabs.test.js tests/voice-echo-regression.test.js tests/calendar-music-tabs.test.js tests/phrase-expansion.test.js tests/email-voice-repair.test.js tests/file-calendar-repair.test.js tests/ai-orchestration.test.js tests/music-orb.test.js tests/music-orb-audio.test.js tests/media-monitor.test.js

# Cross-platform tests
node --test tests/platform.test.js tests/computer-tools.test.js tests/system-monitor.test.js
```

## Push to GitHub

```bash
cd jarvis-share
git init -b main
git add .
git commit -m "Share clean J.A.R.V.I.S. package"
gh repo create your-name/jarvis --private --source=. --push
```

`.gitignore` excludes `.env`, `planner-data.json`, `*.log`, models, and binaries — check `git status` before first commit.

## Voice Tips

- You don't need to say "open" every time: just say the app name — "Jarvis, Steam" opens Steam. Works for common apps, browsers, games, Windows/macOS utilities, and sites ("Jarvis, YouTube").
- "Open X" still works for everything, including apps not on the bare-name shortcut list.
- Cross-platform: "Jarvis, open Calculator", "Jarvis, close Chrome", "Jarvis, switch to Safari".
