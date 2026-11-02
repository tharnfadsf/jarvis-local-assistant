#!/usr/bin/env bash
# Tharn's Jarvis V5 - Arch Linux installer.
# Usage:  bash install-arch.sh
#
# This installer is deliberately simple:
#   - checks/installs Node.js 22+
#   - offers the small whisper-cpp and espeak-ng packages
#   - copies the app to ~/.local/share/Tharns-Jarvis-V5
#   - creates a menu entry, a desktop shortcut, and a terminal command
#   - optionally installs Ollama and the recommended local AI model
set -euo pipefail

APP_NAME="Tharns-Jarvis-V5"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$HOME/.local/share/$APP_NAME"
BIN_DIR="$HOME/.local/bin"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/tharns-jarvis"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

say()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m%s\033[0m\n' "$*"; exit 1; }

ask_yes() {
  local reply=""
  read -r -p "$1 [Y/n] " reply || true
  [[ -z "${reply}" || "${reply}" =~ ^[Yy] ]]
}
ask_no() {
  local reply=""
  read -r -p "$1 [y/N] " reply || true
  [[ "${reply}" =~ ^[Yy] ]]
}

if [[ "${EUID}" -eq 0 ]]; then
  die "Please run this installer as your normal user, not as root.
It installs into your home folder and uses sudo only for package installs."
fi

if [[ ! -f "$SCRIPT_DIR/server.js" || ! -d "$SCRIPT_DIR/offline-asr" ]]; then
  die "server.js or offline-asr is missing.
Please extract the complete Tharn's Jarvis V5 ZIP first, then run this script."
fi

say "Tharn's Jarvis V5 - Arch Linux installer"
echo "Install location: $APP_DIR"

if ! command -v pacman >/dev/null 2>&1; then
  warn "pacman was not found. This installer is intended for Arch Linux.
You can still run the portable launcher with:  bash start-jarvis.sh"
fi

# ---------------------------------------------------------------- Node.js
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js is required."
  if command -v pacman >/dev/null 2>&1 && ask_yes "Install Node.js now with sudo pacman -S --needed nodejs?"; then
    sudo pacman -S --needed nodejs
  else
    die "Install Node.js 22 or newer, then run this installer again."
  fi
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  warn "Node.js $(node --version 2>/dev/null || echo unknown) is too old; version 22 or newer is required."
  if command -v pacman >/dev/null 2>&1 && ask_yes "Upgrade Node.js now with sudo pacman -Syu --needed nodejs?"; then
    sudo pacman -Syu --needed nodejs
  fi
  NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
  [ "${NODE_MAJOR:-0}" -ge 22 ] || die "Node.js 22+ is still missing. Install it from https://nodejs.org/ and retry."
fi
echo "Node.js: $(node --version)"

# ------------------------------------------------------- local speech/voice
if command -v whisper-cli >/dev/null 2>&1; then
  echo "Local speech recognition: whisper-cli found."
elif command -v pacman >/dev/null 2>&1; then
  warn "Local speech recognition needs whisper-cpp (about 3.4 MB)."
  if ask_yes "Install whisper-cpp now? (recommended)"; then
    sudo pacman -S --needed whisper-cpp
  else
    warn "Skipped. Voice input will stay off until you run: sudo pacman -S whisper-cpp"
  fi
else
  warn "whisper-cli not found. Install the whisper-cpp package to enable local speech recognition."
fi

if command -v espeak-ng >/dev/null 2>&1; then
  echo "Local voice output: espeak-ng found."
elif command -v pacman >/dev/null 2>&1; then
  warn "Local voice output needs espeak-ng (a small offline voice)."
  if ask_yes "Install espeak-ng now? (recommended)"; then
    sudo pacman -S --needed espeak-ng
  else
    warn "Skipped. JARVIS can still show text, but it will have no local voice."
  fi
else
  warn "espeak-ng not found. Install it to enable offline voice output."
fi

# ---------------------------------------------------------- browser control
if ! command -v google-chrome >/dev/null 2>&1 \
   && ! command -v google-chrome-stable >/dev/null 2>&1 \
   && ! command -v chromium >/dev/null 2>&1 \
   && ! command -v brave-browser >/dev/null 2>&1; then
  warn "Browser tab/music control works best with Chromium, Chrome, or Brave."
  if command -v pacman >/dev/null 2>&1 && ask_no "Install Chromium? It is optional and a larger download."; then
    sudo pacman -S --needed chromium
  fi
fi

# ---------------------------------------------------------------- Ollama AI
if command -v ollama >/dev/null 2>&1; then
  echo "Local AI: Ollama found."
else
  warn "JARVIS needs a local AI model for full conversations."
  echo "You can install Ollama later from https://ollama.com/download"
  echo "or let this installer do it now (Ollama + qwen3:1.7b, about 1.5 GB)."
  if command -v pacman >/dev/null 2>&1 && ask_no "Install Ollama and download qwen3:1.7b now?"; then
    sudo pacman -S --needed ollama
    sudo systemctl enable --now ollama
    sleep 3
    if ! ollama pull qwen3:1.7b; then
      warn "The model download did not finish. Start Ollama and run: ollama pull qwen3:1.7b"
    fi
  fi
fi

# ------------------------------------------------------------- copy the app
say "Installing files..."
mkdir -p "$APP_DIR" "$BIN_DIR" "$STATE_DIR" "$APPS_DIR"

if [[ "$(cd "$SCRIPT_DIR" && pwd -P)" != "$(cd "$APP_DIR" && pwd -P 2>/dev/null || echo "")" ]]; then
  cp -a "$SCRIPT_DIR/." "$APP_DIR/"
fi

chmod +x "$APP_DIR/start-jarvis.sh" "$APP_DIR/install-arch.sh" "$APP_DIR/uninstall-arch.sh" 2>/dev/null || true

# Keep user data if this is an update. planner-data.json lives in the app
# folder, so it is intentionally not deleted by the installer.
if [[ ! -f "$APP_DIR/planner-data.json" ]]; then
  printf '{"alarms":[],"reminders":[],"events":[]}\n' > "$APP_DIR/planner-data.json"
fi

# ---------------------------------------------------------- app launcher
cat > "$BIN_DIR/tharns-jarvis" <<'LAUNCHER'
#!/usr/bin/env bash
# Start Tharn's Jarvis V5 in the background and open the web UI.
set -u
APP_DIR="$HOME/.local/share/Tharns-Jarvis-V5"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/tharns-jarvis"
LOG="$STATE_DIR/jarvis.log"
PIDFILE="$STATE_DIR/jarvis.pid"
PORT="${JARVIS_PORT:-4199}"
URL="http://127.0.0.1:${PORT}"

mkdir -p "$STATE_DIR"

healthy() {
  node -e "fetch(process.argv[1] + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" "$URL" >/dev/null 2>&1
}

open_url() {
  # Prefer a Chromium-based browser for microphone access and tab control.
  if command -v chromium >/dev/null 2>&1; then
    nohup chromium "$1" >/dev/null 2>&1 &
  elif command -v google-chrome-stable >/dev/null 2>&1; then
    nohup google-chrome-stable "$1" >/dev/null 2>&1 &
  elif command -v google-chrome >/dev/null 2>&1; then
    nohup google-chrome "$1" >/dev/null 2>&1 &
  elif command -v brave-browser >/dev/null 2>&1; then
    nohup brave-browser "$1" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null 2>&1; then
    nohup xdg-open "$1" >/dev/null 2>&1 &
  elif command -v gio >/dev/null 2>&1; then
    nohup gio open "$1" >/dev/null 2>&1 &
  fi
}

if healthy; then
  open_url "$URL"
  exit 0
fi

cd "$APP_DIR" || exit 1
nohup node server.js >>"$LOG" 2>&1 &
echo "$!" > "$PIDFILE"

for _ in $(seq 1 40); do
  if healthy; then break; fi
  sleep 0.25
done

open_url "$URL"
LAUNCHER
chmod +x "$BIN_DIR/tharns-jarvis"

cat > "$BIN_DIR/tharns-jarvis-stop" <<'STOPPER'
#!/usr/bin/env bash
set -u
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/tharns-jarvis"
PIDFILE="$STATE_DIR/jarvis.pid"
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    echo "Stopped Tharn's Jarvis V5 (PID $PID)."
  else
    echo "Tharn's Jarvis V5 is not running."
  fi
  rm -f "$PIDFILE"
else
  echo "No saved Tharn's Jarvis V5 process was found."
fi
STOPPER
chmod +x "$BIN_DIR/tharns-jarvis-stop"

# ------------------------------------------------------- menu + shortcut
cat > "$APPS_DIR/tharns-jarvis.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Tharn's Jarvis V5
Comment=Local-first desktop assistant
Exec=$BIN_DIR/tharns-jarvis
Icon=$APP_DIR/jarvis-icon.png
Terminal=false
Categories=Utility;AudioVideo;
StartupNotify=false
EOF
chmod +x "$APPS_DIR/tharns-jarvis.desktop"

DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
[ -n "$DESKTOP_DIR" ] || DESKTOP_DIR="$HOME/Desktop"
if [ -d "$DESKTOP_DIR" ]; then
  cp "$APPS_DIR/tharns-jarvis.desktop" "$DESKTOP_DIR/Tharns-Jarvis-V5.desktop" 2>/dev/null || true
  chmod +x "$DESKTOP_DIR/Tharns-Jarvis-V5.desktop" 2>/dev/null || true
  if command -v gio >/dev/null 2>&1; then
    gio set "$DESKTOP_DIR/Tharns-Jarvis-V5.desktop" metadata::trusted true 2>/dev/null || true
  fi
fi

# Refresh the desktop database when the helper is available.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi

cat > "$APP_DIR/uninstall-arch.sh" <<'UNINSTALL'
#!/usr/bin/env bash
set -u
APP_DIR="$HOME/.local/share/Tharns-Jarvis-V5"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
[ -n "${DESKTOP_DIR:-}" ] || DESKTOP_DIR="${XDG_DESKTOP_DIR:-$HOME/Desktop}"
if [ -x "$BIN_DIR/tharns-jarvis-stop" ]; then
  "$BIN_DIR/tharns-jarvis-stop" >/dev/null 2>&1 || true
fi
rm -f "$BIN_DIR/tharns-jarvis" "$BIN_DIR/tharns-jarvis-stop"
rm -f "$APPS_DIR/tharns-jarvis.desktop"
rm -f "$DESKTOP_DIR/Tharns-Jarvis-V5.desktop"
rm -rf "$APP_DIR"
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$HOME/.local/share/JARVIS"
  echo "Removed the app and JARVIS data."
else
  echo "Removed the app. Your JARVIS memory/planner data is still in ~/.local/share/JARVIS."
  echo "Run with --purge to remove that too."
fi
UNINSTALL
chmod +x "$APP_DIR/uninstall-arch.sh"

say "Done."
echo "App folder:       $APP_DIR"
echo "App menu entry:   Tharn's Jarvis V5"
echo "Terminal command: $BIN_DIR/tharns-jarvis"
echo "Stop command:     $BIN_DIR/tharns-jarvis-stop"
echo
echo "If the terminal command is not on your PATH, use the app menu or the full path above."
echo "The first time JARVIS opens, allow microphone access in the browser."

if ask_yes "Launch Tharn's Jarvis V5 now?"; then
  "$BIN_DIR/tharns-jarvis"
fi
