'use strict';
// JARVIS Platform Abstraction Layer
// Provides cross-platform utilities for Windows and macOS.
// All platform-specific code should go through this module.

const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const PLATFORM = process.platform; // 'win32', 'darwin', 'linux'
const IS_WINDOWS = PLATFORM === 'win32';
const IS_MACOS = PLATFORM === 'darwin';
const IS_LINUX = PLATFORM === 'linux';

const ARCH = process.arch; // 'x64', 'arm64', etc.

// Platform identifiers for distribution packages
const DISTRO = {
  WINDOWS_X64: 'windows-x64',
  WINDOWS_ARM64: 'windows-arm64',
  MACOS_X64: 'macos-x64',
  MACOS_ARM64: 'macos-arm64',
  LINUX_X64: 'linux-x64',
  LINUX_ARM64: 'linux-arm64'
};

function getDistroId() {
  if (IS_WINDOWS) return ARCH === 'arm64' ? DISTRO.WINDOWS_ARM64 : DISTRO.WINDOWS_X64;
  if (IS_MACOS) return ARCH === 'arm64' ? DISTRO.MACOS_ARM64 : DISTRO.MACOS_X64;
  if (IS_LINUX) return ARCH === 'arm64' ? DISTRO.LINUX_ARM64 : DISTRO.LINUX_X64;
  return `unknown-${PLATFORM}-${ARCH}`;
}

function getPlatformName() {
  if (IS_WINDOWS) return 'Windows';
  if (IS_MACOS) return 'macOS';
  if (IS_LINUX) return 'Linux';
  return PLATFORM;
}

function getUserDataDir() {
  // Returns the appropriate user data directory for the platform
  if (IS_WINDOWS) {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  }
  if (IS_MACOS) {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  // Linux/XDG
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function getJarvisDataDir() {
  return path.join(getUserDataDir(), 'JARVIS');
}

function getConfigDir() {
  if (IS_WINDOWS) {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (IS_MACOS) {
    return path.join(os.homedir(), 'Library', 'Preferences');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function getKnownFolders() {
  const home = os.homedir();
  if (IS_WINDOWS) {
    return {
      Desktop: path.join(home, 'Desktop'),
      Documents: path.join(home, 'Documents'),
      Downloads: path.join(home, 'Downloads'),
      Pictures: path.join(home, 'Pictures'),
      Videos: path.join(home, 'Videos'),
      Music: path.join(home, 'Music'),
      AppData: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
      ProgramFiles: process.env.ProgramFiles || 'C:\\Program Files',
      'ProgramFiles(x86)': process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    };
  }
  if (IS_MACOS) {
    return {
      Desktop: path.join(home, 'Desktop'),
      Documents: path.join(home, 'Documents'),
      Downloads: path.join(home, 'Downloads'),
      Pictures: path.join(home, 'Pictures'),
      Videos: path.join(home, 'Movies'),
      Music: path.join(home, 'Music'),
      Applications: '/Applications',
      'Applications/User': path.join(home, 'Applications'),
      Library: path.join(home, 'Library'),
      'AppSupport': path.join(home, 'Library', 'Application Support')
    };
  }
  // Linux - XDG directories
  return {
    Desktop: path.join(home, 'Desktop'),
    Documents: path.join(home, 'Documents'),
    Downloads: path.join(home, 'Downloads'),
    Pictures: path.join(home, 'Pictures'),
    Videos: path.join(home, 'Videos'),
    Music: path.join(home, 'Music'),
    '.config': path.join(home, '.config'),
    '.local': path.join(home, '.local')
  };
}

// Expand environment variables and ~ in paths (cross-platform)
function expandPath(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  value = value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  // Windows-style %VAR%
  value = value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => process.env[name] || m);
  // Unix-style $VAR or ${VAR}
  value = value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => process.env[name] || m);
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => process.env[name] || m);
  // Tilde expansion
  if (value === '~') return os.homedir();
  if (/^~[\\/]/.test(value)) return path.join(os.homedir(), value.slice(2));
  return value;
}

// Normalize path separators for current platform
function normalizePath(p) {
  return path.normalize(expandPath(p));
}

// Dangerous file extensions that should never be executed without explicit confirmation
const DANGEROUS_EXTENSIONS = {
  win32: /\.(?:exe|bat|cmd|ps1|psm1|msi|scr|com|pif|reg|lnk|vbs|vbe|wsf|wsh|hta|jar)$/i,
  darwin: /\.(?:app|dmg|pkg|command|sh|bash|zsh|fish)$/i,
  linux: /\.(?:appimage|deb|rpm|sh|bash|zsh|fish|bin|run)$/i
};

function isDangerousFile(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const pattern = DANGEROUS_EXTENSIONS[PLATFORM] || DANGEROUS_EXTENSIONS.linux;
  return pattern.test(ext);
}

// Platform-specific command to open a file/URL with default application
function getOpenCommand(target) {
  if (IS_WINDOWS) {
    // Use PowerShell Start-Process for proper handling
    return ['powershell.exe', '-NoProfile', '-Command', `Start-Process "${target.replace(/"/g, '""')}"`];
  }
  if (IS_MACOS) {
    return ['open', target];
  }
  // Linux - xdg-open
  return ['xdg-open', target];
}

// Platform-specific command to reveal a file in file manager
function getRevealCommand(filepath) {
  if (IS_WINDOWS) {
    return ['explorer.exe', '/select,', filepath.replace('/', '\\')];
  }
  if (IS_MACOS) {
    return ['open', '-R', filepath];
  }
  // Linux - try common file managers
  return ['xdg-open', path.dirname(filepath)];
}

// Get list of running processes (cross-platform)
async function getProcesses() {
  if (IS_WINDOWS) {
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-Command', 'Get-Process | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress'
      ], { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
      return JSON.parse(stdout || '[]');
    } catch {
      return [];
    }
  }
  if (IS_MACOS) {
    try {
      // Use ps for process list
      const { stdout } = await execFileAsync('ps', ['-eo', 'pid,comm,args'], { timeout: 5000 });
      const lines = stdout.trim().split('\n').slice(1);
      return lines.map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          Id: parseInt(parts[0], 10),
          ProcessName: parts[1],
          Command: parts.slice(2).join(' ')
        };
      });
    } catch {
      return [];
    }
  }
  // Linux
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,comm,args'], { timeout: 5000 });
    const lines = stdout.trim().split('\n').slice(1);
    return lines.map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        Id: parseInt(parts[0], 10),
        ProcessName: parts[1],
        Command: parts.slice(2).join(' ')
      };
    });
  } catch {
    return [];
  }
}

// Find process by name (cross-platform)
async function findProcessByName(name) {
  const processes = await getProcesses();
  const lowerName = name.toLowerCase();
  return processes.filter(p => 
    (p.ProcessName && p.ProcessName.toLowerCase().includes(lowerName)) ||
    (p.Command && p.Command.toLowerCase().includes(lowerName))
  );
}

// Close application gracefully (cross-platform)
async function closeApp(pid, force = false) {
  if (IS_WINDOWS) {
    try {
      const script = force
        ? `Stop-Process -Id ${pid} -Force`
        : `$p = Get-Process -Id ${pid}; if ($p.MainWindowHandle) { $p.CloseMainWindow() } else { $p.Kill() }`;
      await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000 });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }
  // macOS/Linux - send SIGTERM first, then SIGKILL if forced
  try {
    const signal = force ? 'SIGKILL' : 'SIGTERM';
    process.kill(pid, signal);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// Get system information (cross-platform)
function getSystemInfo() {
  return {
    platform: PLATFORM,
    platformName: getPlatformName(),
    arch: ARCH,
    distro: getDistroId(),
    hostname: os.hostname(),
    uptime: os.uptime(),
    cpus: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    homedir: os.homedir(),
    userDataDir: getUserDataDir(),
    jarvisDataDir: getJarvisDataDir(),
    configDir: getConfigDir(),
    knownFolders: getKnownFolders()
  };
}

// Check if running in a packaged/bundled environment
function isPackaged() {
  // Check for common packaging indicators
  return !!(process.pkg || process.resourcesPath || process.execPath.includes('app.asar') || process.env.JARVIS_PACKAGED);
}

module.exports = {
  PLATFORM,
  IS_WINDOWS,
  IS_MACOS,
  IS_LINUX,
  ARCH,
  DISTRO,
  getDistroId,
  getPlatformName,
  getUserDataDir,
  getJarvisDataDir,
  getConfigDir,
  getKnownFolders,
  expandPath,
  normalizePath,
  isDangerousFile,
  getOpenCommand,
  getRevealCommand,
  getProcesses,
  findProcessByName,
  closeApp,
  getSystemInfo,
  isPackaged
};