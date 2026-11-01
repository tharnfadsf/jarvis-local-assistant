'use strict';
// JARVIS Share — runtime platform capabilities (2026-10-28 upgrade).
//
// One honest feature-support table computed from the ACTUAL runtime OS and the
// tools that are really installed. Nothing here claims a feature exists just
// because the UI can render it: every entry says full / partial / unavailable
// with a short reason, so the setup wizard and the health route report the
// same truth the action layer enforces.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const PLATFORM = process.platform;
const IS_WINDOWS = PLATFORM === 'win32';
const IS_MACOS = PLATFORM === 'darwin';
const IS_LINUX = PLATFORM === 'linux';

function runtimeInfo() {
  let release = '';
  let distro = '';
  try { release = os.release(); } catch {}
  if (IS_LINUX) {
    // /etc/os-release is the reliable Linux identity source (Arch writes ID=arch).
    try {
      const text = fs.readFileSync('/etc/os-release', 'utf8');
      const pick = (key) => {
        const match = text.match(new RegExp(`^${key}=(?:"([^"]*)"|(.*))$`, 'm'));
        return match ? (match[1] ?? match[2]).trim() : '';
      };
      distro = pick('ID') || pick('NAME') || '';
    } catch { distro = ''; }
  }
  return {
    os: PLATFORM === 'darwin' ? 'macOS' : PLATFORM === 'win32' ? 'Windows' : 'Linux',
    osVersion: release,
    arch: os.arch(),
    isWindows: IS_WINDOWS,
    isMacOS: IS_MACOS,
    isLinux: IS_LINUX,
    isArchLinux: distro === 'arch' || distro === 'archarm' || distro.startsWith('arch'),
    distro,
    node: process.version,
    host: os.hostname()
  };
}

// Which offline speech (whisper.cpp) runtime ships for this OS.
function asrBinaryLayout(platform) {
  if (platform === 'win32') return { dir: 'offline-asr/runtime/Release', binary: 'whisper-cli.exe', supported: true, note: 'Copy models/ and runtime/ from a working JARVIS install.' };
  if (platform === 'darwin') {
    return {
      dir: 'offline-asr/runtime/darwin',
      binary: 'whisper-cli',
      supported: false,
      note: 'No macOS whisper.cpp build ships with your install yet. Voice transcription on macOS needs entry.app/whisper.cpp compiled once (brew install whisper-cpp) and placed at this path. Live voice is unavailable until then; typed commands work.'
    };
  }
  return {
    dir: 'offline-asr/runtime/linux/' + os.arch(),
    binary: 'whisper-cli',
    supported: false,
    note: 'On Linux build whisper.cpp once (poky/aur: "sudo pacman -S whisper.cpp" or compile from source) and drop whisper-cli here. Live voice is unavailable until then; typed commands work.'
  };
}

// Screen capture engines by OS. Windows: the existing PrintWindow/GDP capture
// path. macOS: ScreenCaptureKit needs a signed helper — not implemented yet.
// Linux: PipeWire/grim exist on Wayland/X11 but the capture code is Windows-only.
function featureSupport(platform) {
  const platformName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
  const rows = [];
  const add = (key, label, status, note) => rows.push({ key, label, status, note, platform: platformName });

  add('conversation', 'AI conversations (Ollama / OpenAI-compatible providers)', 'full', 'Runs identically on every OS via local HTTP AI endpoints.');
  add('browser_tabs', 'Browser tab control (Chrome/Edge/Brave via DevTools protocol)', 'full', 'Chrome DevTools protocol is cross-platform; screenshots UIA overlay stays Windows-only.');

  if (platform === 'win32') {
    add('app_control', 'Open / close / focus desktop apps', 'full', 'Start-menu and installed-app discovery via PowerShell.');
    add('screen_capture', 'Screen analysis / screen pointing (Clicky)', 'full', 'GDI + UI Automation capture is supported.');
    add('media_control', 'Media session transport (play/pause/skip)', 'full', 'Windows media sessions + loopback audio.');
    add('local_tts', 'Local system voice fallback', 'full', 'Windows SAPI voice.');
    add('alarms_persistent', 'Persistent alarms across reboots', 'full', 'Task Scheduler integration.');
    add('system_monitor', 'CPU / RAM / disk / GPU monitor', 'full', 'Windows performance counters.');
    add('window_close_current', 'Close current tab / active window', 'full', 'SendInput / WM_CLOSE helpers.');
    add('asr_live', 'Offline live voice (wake-word + transcription)', 'full', 'whisper.cpp runtime ships for Windows.');
    add('volume_control', 'Volume control', 'full', 'Windows audio sessions.');
    add('shutdown_system', 'PC shutdown (with confirmation)', 'full', 'shutdown.exe with a cancel window.');
    add('sound_settings', 'Open Sound Settings', 'full', 'ms-settings:sound.');
  } else if (platform === 'darwin') {
    add('app_control', 'Open / close / focus desktop apps', 'partial', 'Implemented via `open` + `osascript` (AppleScript) in the new launcher; not all apps answer AppleScript quit politely. Not your own Windows Start-menu install discovery.');
    add('screen_capture', 'Screen analysis / screen pointing', 'unavailable', 'macOS needs a ScreenCaptureKit helper with a signed .app and screen-recording permission. Not shipped in this release; the UI reports it as unavailable instead of pretending.');
    add('media_control', 'Media session transport', 'partial', 'AppleScript to Music.app / Spotify (not the Windows media-session API).');
    add('local_tts', 'Local system voice fallback', 'partial', 'macOS `say` command (built in).');
    add('alarms_persistent', 'Persistent alarms across reboots', 'partial', 'launchd plist generation when the user confirms; reminder fallback into conversation otherwise. No silent user-facing crontab writes.');
    add('system_monitor', 'CPU / RAM / disk monitor', 'partial', 'ps-based CPU/RAM; no Windows GPU counters equivalent on all Macs.');
    add('window_close_current', 'Close current tab / active window', 'partial', 'AppleScript System Events (needs Accessibility permission).');
    add('asr_live', 'Offline live voice', 'unavailable', asrBinaryLayout(platform).note);
    add('volume_control', 'Volume control', 'partial', 'osascript volume set (needs Automation permission).');
    add('shutdown_system', 'PC shutdown', 'partial', '`osascript -e "tell app \"System Events\" to shut down"` with confirmation.');
    add('sound_settings', 'Open Sound Settings', 'partial', 'opens Apple > System Settings > Sound via `open`.');
  } else {
    add('app_control', 'Open / close / focus desktop apps', 'partial', 'Applies desktop .desktop / .applications entries. Depends on your desktop environment; the wizard lists what is detected.');
    add('screen_capture', 'Screen analysis / screen pointing', 'unavailable', 'Needs PipeWire or grim + a protocol entry; not shipped in this release.');
    add('media_control', 'Media session transport', 'partial', 'MPRIS players when playerctl / dbus exists (checked at runtime below).');
    add('local_tts', 'Local system voice fallback', 'partial', '`spd-say`/`espeak-ng` when installed (checked below).');
    add('alarms_persistent', 'Persistent alarms across reboots', 'partial', 'systemd --user timer generation when the user confirms; in-session fallback otherwise.');
    add('system_monitor', 'CPU / RAM / disk monitor', 'partial', '/proc-based CPU/RAM; no Windows GPU counters equivalent.');
    add('window_close_current', 'Close current tab / active window', 'partial', 'xdotool / wmctrl when installed (checked below).');
    add('asr_live', 'Offline live voice', 'unavailable', asrBinaryLayout(platform).note);
    add('volume_control', 'Volume control', 'partial', 'pactl / amixer when PulseALSA or PipeWire tools are installed.');
    add('shutdown_system', 'PC shutdown', 'partial', 'systemctl poweroff / loginctl dependent.}');
    add('sound_settings', 'Open Sound Settings', 'partial', 'opens your desktop environment sound panel via xdg-open.');
  }

  return rows;
}

// Existence probes used to refine Linux/macOS entries in the wizard.
async function detectOptionalTools(overrides = {}) {
  const probe = async (name) => {
    if (Object.prototype.hasOwnProperty.call(overrides, name)) return Boolean(overrides[name]);
    try { await execFileAsync('which', [name], { timeout: 2500 }); return true; } catch { return false; }
  };
  const tools = {};
  if (!IS_WINDOWS) {
    const names = IS_MACOS
      ? ['osascript', 'say', 'open', 'brew', 'ollama']
      : ['xdg-open', 'playerctl', 'dbus-send', 'xdotool', 'wmctrl', 'spd-say', 'espeak-ng', 'pactl', 'amixer', 'grim', 'ollama', 'systemctl', 'pacman', 'flatpak'];
    for (const name of names) tools[name] = await probe(name);
  } else {
    tools.ollama = true; // detected separately in the setup wizard
  }
  return tools;
}

module.exports = { runtimeInfo, featureSupport, asrBinaryLayout, detectOptionalTools, PLATFORM, IS_WINDOWS, IS_MACOS, IS_LINUX };
