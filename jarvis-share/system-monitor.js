'use strict';
// JARVIS System Monitor 2.0 — authoritative local Windows metrics service.
//
// Why this module exists: the SYSTEM MONITOR card in index.html showed static
// "--" forever because no backend collected CPU/RAM/disk/net/GPU and no
// frontend polled anything. This is the single source of truth:
//   Windows metrics source -> System Monitor backend -> GET /api/system
//   -> existing System Monitor GUI (+ voice answers via handleAction).
//
// Design:
// - One instance per server (created in server.js). One internal setInterval.
// - Fast/cheap sources every tick (os.cpus/mem/uptime). Expensive PowerShell
//   / nvidia-smi sources on slower staggered schedules with timeouts.
// - Never throws out of getSnapshot(); unavailable readings are null with a
//   per-section status so the GUI can show "N/A" for one metric while the
//   rest keeps updating.
// - No admin required. No Task Manager automation or screenshotting.
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clampPct(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}
function gb(bytes) {
  if (!Number.isFinite(Number(bytes))) return null;
  return Math.round((Number(bytes) / (1024 ** 3)) * 10) / 10;
}

// ---- CPU sampling via os.cpus() (no PowerShell cost) ----
function snapshotCpuTimes() {
  try {
    return os.cpus().map(c => ({ ...c.times }));
  } catch { return []; }
}
function cpuPctBetween(prev, curr) {
  if (!prev || !curr || prev.length !== curr.length || !curr.length) {
    return { total: null, cores: [] };
  }
  const cores = curr.map((c, i) => {
    const p = prev[i] || { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const pIdle = p.idle || 0;
    const cIdle = c.idle || 0;
    const pTot = (p.user || 0) + (p.nice || 0) + (p.sys || 0) + pIdle + (p.irq || 0);
    const cTot = (c.user || 0) + (c.nice || 0) + (c.sys || 0) + cIdle + (c.irq || 0);
    const tDiff = cTot - pTot;
    const iDiff = cIdle - pIdle;
    if (tDiff <= 0) return null;
    return clampPct((1 - iDiff / tDiff) * 100);
  });
  const valid = cores.filter(v => v !== null);
  const total = valid.length ? Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10 : null;
  return { total, cores };
}

async function runPs(script, timeout = 8000) {
  if (!isWin) throw new Error('Windows metrics unavailable on this platform.');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, timeout, maxBuffer: 5 * 1024 * 1024 });
  return String(stdout || '').trim();
}
function parsePsJson(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  // PowerShell ConvertTo-Json may emit warnings on earlier lines; last JSON wins.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]);
      return v;
    } catch {}
  }
  try { return JSON.parse(lines.join('\n')); } catch { return null; }
}
function asArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function createSystemMonitor({ intervalMs = 2000, log = console } = {}) {
  const interval = Math.max(1000, Math.min(10000, Number(intervalMs) || 2000));
  let timer = null;
  let started = false;
  let tick = 0;
  let prevCpu = snapshotCpuTimes();
  let prevCpuAt = Date.now();
  const cpuModel = (() => { try { return os.cpus()[0]?.model || 'Unknown CPU'; } catch { return 'Unknown CPU'; } })();
  const cpuCount = (() => { try { return os.cpus().length || 0; } catch { return 0; } })();
  const cpuFreqMHz = (() => { try { const c = os.cpus(); const s = c.map(x => x.speed || 0).filter(Boolean); return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null; } catch { return null; } })();

  const state = {
    fast: { cpu: null, cores: [], mem: null, uptime: null },
    drives: { at: 0, data: [], status: 'initializing', error: null },
    procs: { at: 0, data: [], status: 'initializing', error: null },
    net: { at: 0, data: null, status: 'initializing', error: null, prevBytes: null, prevAt: 0 },
    gpu: { at: 0, data: null, status: 'initializing', error: null },
    diskIo: { at: 0, data: null, status: 'initializing', error: null },
    lastOk: 0,
    lastAttempt: 0,
    lastError: null,
    consecErrors: 0,
  };

  async function collectDrives() {
    try {
      const out = await runPs(
        `Get-PSDrive -PSProvider FileSystem | ForEach-Object { [pscustomobject]@{ name=$_.Name; usedGB=[math]::Round($_.Used/1GB,1); freeGB=[math]::Round($_.Free/1GB,1) } } | ConvertTo-Json -Compress`,
        8000);
      const rows = asArray(parsePsJson(out)).filter(r => r && r.name);
      state.drives.data = rows.map(r => {
        const used = toNum(r.usedGB) || 0;
        const free = toNum(r.freeGB) || 0;
        const total = Math.round((used + free) * 10) / 10;
        return {
          name: `${String(r.name).replace(/:?$/, ':')}`,
          usedGB: used, freeGB: free, totalGB: total,
          pct: total > 0 ? clampPct((used / total) * 100) : null,
        };
      });
      state.drives.status = state.drives.data.length ? 'ok' : 'unavailable';
      state.drives.error = null;
      state.drives.at = Date.now();
    } catch (e) {
      state.drives.status = state.drives.data.length ? 'stale' : 'unavailable';
      state.drives.error = String((e && e.message) || e).slice(0, 160);
    }
  }

  async function collectProcs() {
    try {
      // NOTE: no CPU property here — resolving per-process CPU time makes
      // Get-Process 5-10x slower under load. Top-by-RAM answers "what is
      // using the most" reliably without hanging the tick.
      const out = await runPs(
        `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 Name,Id,@{n='ramMB';e={[math]::Round($_.WorkingSet64/1MB,0)}},@{n='title';e={$_.MainWindowTitle}} | ConvertTo-Json -Compress`,
        12000);
      const rows = asArray(parsePsJson(out)).filter(r => r && r.Name);
      state.procs.data = rows.map(r => ({
        name: String(r.Name).slice(0, 60),
        pid: toNum(r.Id),
        cpuSeconds: toNum(r.CPU),
        ramMB: toNum(r.ramMB) || 0,
        title: String(r.title || '').slice(0, 80),
      }));
      state.procs.status = 'ok';
      state.procs.error = null;
      state.procs.at = Date.now();
    } catch (e) {
      state.procs.status = state.procs.data.length ? 'stale' : 'unavailable';
      state.procs.error = String((e && e.message) || e).slice(0, 160);
    }
  }

  async function collectNet() {
    // Throughput is derived from cumulative byte-counter deltas over time —
    // never shown as speed directly. Get-NetAdapterStatistics is fast (no
    // Get-Counter sampling delay) and works without admin.
    try {
      const out = await runPs(
        `Get-NetAdapterStatistics | ForEach-Object { [pscustomobject]@{ name=$_.Name; recv=$_.ReceivedBytes; sent=$_.SentBytes } } | ConvertTo-Json -Compress`,
        12000);
      const rows = asArray(parsePsJson(out)).filter(r => r && (r.recv !== undefined || r.sent !== undefined));
      let recv = 0, sent = 0;
      for (const r of rows) { recv += toNum(r.recv) || 0; sent += toNum(r.sent) || 0; }
      const now = Date.now();
      let down = null, up = null, total = null;
      if (state.net.prevBytes && now > state.net.prevAt + 500) {
        const dt = (now - state.net.prevAt) / 1000;
        const dR = recv - state.net.prevBytes.recv, dS = sent - state.net.prevBytes.sent;
        if (dR >= 0 && dS >= 0 && dt > 0) {
          down = Math.round(dR / dt); up = Math.round(dS / dt); total = down + up;
        }
      }
      state.net.prevBytes = { recv, sent };
      state.net.prevAt = now;
      const ifaces = [];
      try {
        const nis = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(nis)) {
          const v4 = (addrs || []).find(a => a.family === 'IPv4' && !a.internal);
          ifaces.push({ name: String(name).slice(0, 60), address: v4 ? v4.address : null, up: Boolean(v4) });
        }
      } catch {}
      state.net.data = {
        downBps: down, upBps: up, totalBps: total,
        interfaces: ifaces.filter(i => i.up).slice(0, 8),
      };
      state.net.status = 'ok';
      state.net.error = null;
      state.net.at = Date.now();
    } catch (e) {
      // Fallback: still report interface list from Node so NET isn't fully blank.
      try {
        const nis = os.networkInterfaces();
        const ifaces = [];
        for (const [name, addrs] of Object.entries(nis)) {
          const v4 = (addrs || []).find(a => a.family === 'IPv4' && !a.internal);
          if (v4) ifaces.push({ name: String(name).slice(0, 60), address: v4.address, up: true });
        }
        if (ifaces.length && !state.net.data) {
          state.net.data = { downBps: null, upBps: null, totalBps: null, interfaces: ifaces.slice(0, 8) };
        }
      } catch {}
      state.net.status = state.net.data ? 'stale' : 'unavailable';
      state.net.error = String((e && e.message) || e).slice(0, 160);
    }
  }

  async function collectGpu() {
    // 1) Prefer nvidia-smi when present (real util + VRAM + temp).
    try {
      const { stdout } = await execFileAsync('nvidia-smi',
        ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
        { windowsHide: true, timeout: 6000, maxBuffer: 64 * 1024 });
      const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean)[0];
      if (line) {
        const parts = line.split(',').map(s => s.trim());
        if (parts.length >= 4) {
          state.gpu.data = {
            name: parts[0].slice(0, 80) || 'GPU',
            pct: clampPct(parts[1]),
            memUsedMB: toNum(parts[2]),
            memTotalMB: toNum(parts[3]),
            tempC: toNum(parts[4]),
            source: 'nvidia-smi',
          };
          state.gpu.status = 'ok';
          state.gpu.error = null;
          state.gpu.at = Date.now();
          return;
        }
      }
    } catch {}
    // 2) Fallback: adapter name via CIM (no utilization); mark util unavailable.
    try {
      const out = await runPs(
        `Get-CimInstance Win32_VideoController | Select-Object -First 2 Name,@{n='ramGB';e={[math]::Round($_.AdapterRAM/1GB,1)}} | ConvertTo-Json -Compress`,
        8000);
      const rows = asArray(parsePsJson(out)).filter(Boolean);
      const first = rows[0] || {};
      const name = String(first.Name || first.name || 'GPU').slice(0, 80);
      const ramGB = toNum(first.ramGB ?? first.RamGB);
      state.gpu.data = {
        name, pct: null,
        memUsedMB: null, memTotalMB: ramGB !== null ? Math.round(ramGB * 1024) : null,
        tempC: null, source: 'cim-name-only',
      };
      state.gpu.status = 'partial';
      state.gpu.error = 'Utilization not exposed by this driver/API.';
      state.gpu.at = Date.now();
    } catch (e) {
      if (!state.gpu.data) {
        state.gpu.data = null;
        state.gpu.status = 'unavailable';
      } else {
        state.gpu.status = 'stale';
      }
      state.gpu.error = String((e && e.message) || e).slice(0, 160);
    }
  }

  async function collectDiskIo() {
    try {
      const out = await runPs(
        `$c = Get-Counter '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec','\\PhysicalDisk(_Total)\\Disk Write Bytes/sec' -ErrorAction Stop; $o=@{}; foreach($s in $c.CounterSamples){ if($s.Path -like '*Read*'){ $o.read=[math]::Round($s.CookedValue,0) } else { $o.write=[math]::Round($s.CookedValue,0) } }; $o | ConvertTo-Json -Compress`,
        8000);
      const v = parsePsJson(out) || {};
      state.diskIo.data = { readBps: toNum(v.read) ?? 0, writeBps: toNum(v.write) ?? 0 };
      state.diskIo.status = 'ok';
      state.diskIo.error = null;
      state.diskIo.at = Date.now();
    } catch (e) {
      state.diskIo.status = state.diskIo.data ? 'stale' : 'unavailable';
      state.diskIo.error = String((e && e.message) || e).slice(0, 160);
    }
  }

  async function collectFast() {
    try {
      const curr = snapshotCpuTimes();
      const now = Date.now();
      // First sample (or samples <750ms apart) cannot yield a stable
      // percentage — report null instead of a noisy spike.
      if (curr.length && prevCpu.length === curr.length && now - prevCpuAt >= 750) {
        const { total, cores } = cpuPctBetween(prevCpu, curr);
        state.fast.cpu = total;
        state.fast.cores = cores;
      } else if (!state.fast.cpu) {
        state.fast.cpu = null;
        state.fast.cores = [];
      }
      if (curr.length) { prevCpu = curr; prevCpuAt = now; }
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      state.fast.mem = {
        totalGB: gb(totalMem), freeGB: gb(freeMem), usedGB: gb(usedMem),
        pct: totalMem > 0 ? clampPct((usedMem / totalMem) * 100) : null,
      };
      try { state.fast.uptime = { seconds: Math.floor(os.uptime()) }; } catch { state.fast.uptime = null; }
      state.lastOk = Date.now();
      state.consecErrors = 0;
      state.lastError = null;
    } catch (e) {
      state.consecErrors++;
      state.lastError = String((e && e.message) || e).slice(0, 160);
    } finally {
      state.lastAttempt = Date.now();
    }
  }

  let collecting = false;
  async function tickCollect() {
    if (collecting) return; // never overlap ticks; skip instead of piling up powershell.exe
    collecting = true;
    try {
      tick++;
      await collectFast();
      // Sequential (not parallel): each powershell.exe cold-start costs
      // seconds on a loaded machine; staggering avoids CPU pile-ups.
      if (tick === 1 || tick % 15 === 1) await collectDrives();  // ~30s
      if (tick % 3 === 1) await collectProcs();                  // ~6s
      else if (tick % 3 === 2) await collectNet();               // ~6s
      if (tick === 2 || tick % 15 === 2) await collectGpu();     // ~30s
      if (tick % 6 === 3) await collectDiskIo().catch(() => {}); // ~12s, optional
    } finally {
      collecting = false;
    }
  }

  function topProcess() {
    if (!state.procs.data.length) return null;
    return state.procs.data[0];
  }

  function getSnapshot() {
    const mem = state.fast.mem;
    const sysDrive = state.drives.data.find(d => /^c:/i.test(d.name)) || state.drives.data[0] || null;
    const net = state.net.data;
    const okCount = [
      state.fast.cpu !== null, mem && mem.pct !== null,
      sysDrive && sysDrive.pct !== null,
      net && (net.totalBps !== null && net.totalBps !== undefined),
      state.gpu.data !== null, state.procs.data.length > 0,
    ].filter(Boolean).length;
    let status = 'connected';
    if (!state.lastOk) status = 'initializing';
    else if (okCount >= 5) status = 'connected';
    else if (okCount >= 2) status = 'partial';
    else if (okCount === 0) status = Date.now() - state.lastOk > 15000 ? 'error' : 'unavailable';
    else status = 'partial';
    return {
      ok: true,
      status,
      updatedAt: state.lastOk || null,
      updatedAtIso: state.lastOk ? new Date(state.lastOk).toISOString() : null,
      cpu: {
        pct: state.fast.cpu, cores: state.fast.cores,
        model: cpuModel, count: cpuCount, freqMHz: cpuFreqMHz,
        status: state.fast.cpu !== null ? 'ok' : (state.lastOk ? 'stale' : 'initializing'),
      },
      mem: mem ? { ...mem, status: mem.pct !== null ? 'ok' : 'unavailable' } : { status: 'unavailable' },
      drives: { list: state.drives.data, primary: sysDrive, io: state.diskIo.data, status: state.drives.status },
      net: net ? { ...net, status: state.net.status } : { status: state.net.status, error: state.net.error },
      gpu: state.gpu.data ? { ...state.gpu.data, status: state.gpu.status } : { status: state.gpu.status, error: state.gpu.error },
      procs: { list: state.procs.data.slice(0, 12), top: topProcess(), count: state.procs.data.length, status: state.procs.status },
      uptimeSeconds: state.fast.uptime ? state.fast.uptime.seconds : null,
      errors: { last: state.lastError, drives: state.drives.error, procs: state.procs.error, net: state.net.error, gpu: state.gpu.error, diskIo: state.diskIo.error },
    };
  }

  function describeForVoice(snap) {
    const parts = [];
    if (snap.cpu && typeof snap.cpu.pct === 'number') parts.push(`CPU ${snap.cpu.pct}%`);
    if (snap.mem && typeof snap.mem.pct === 'number') parts.push(`RAM ${snap.mem.pct}% (${snap.mem.usedGB} of ${snap.mem.totalGB} GB)`);
    if (snap.drives.primary) parts.push(`${snap.drives.primary.name} ${snap.drives.primary.freeGB} GB free of ${snap.drives.primary.totalGB} GB`);
    if (snap.gpu && typeof snap.gpu.pct === 'number') parts.push(`GPU ${snap.gpu.pct}%`);
    else if (snap.gpu && snap.gpu.name) parts.push(`GPU ${snap.gpu.name} (utilization unavailable)`);
    if (snap.procs.top) parts.push(`top app ${snap.procs.top.name} using ${snap.procs.top.ramMB} MB`);
    if (!parts.length) return 'The system monitor has no readings yet. It is still initializing.';
    return parts.join('; ') + '.';
  }

  function start() {
    if (started) return;
    started = true;
    tickCollect().catch(e => { try { log.error('[system-monitor] first tick failed:', e.message); } catch {} });
    timer = setInterval(() => { tickCollect().catch(() => {}); }, interval);
    if (timer.unref) timer.unref();
  }
  function stop() {
    started = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, getSnapshot, describeForVoice, isWindows: isWin };
}

module.exports = { createSystemMonitor };
