'use strict';
// JARVIS Screen Vision — screen capture, local visual analysis, screenshot
// management.
//
// Design (and why):
// - Capture uses Windows GDI+ via PowerShell (CopyFromScreen). It runs only
//   when a request comes in — never a continuous capture loop.
// - Analysis uses the user's own local Ollama service and only models that
//   report the "vision" capability in Ollama's /api/tags. Nothing is uploaded
//   to a remote service. If no vision model is installed, the answer says so
//   instead of falling back to a cloud provider or inventing content.
// - Screenshots persist under %LOCALAPPDATA%\JARVIS\Screenshots by default
//   with timestamped, non-clobbering filenames.
// - Follow-up questions reuse the last captured image for a bounded window
//   (default 10 minutes) and then it is dropped from memory, so stale context
//   is never presented as the current screen.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const FOLLOW_UP_WINDOW_MS_DEFAULT = 10 * 60 * 1000;
const DIRECTORY = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'JARVIS');

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// ---- Pure helpers (unit-testable without Windows or a model) ----
function buildVisionRequestBody({ question, model, imageB64, options = {} }) {
  const text = String(question || '').trim();
  return {
    model: String(model || '').slice(0, 100),
    messages: [{ role: 'user', content: text || 'Describe this screenshot precisely.', images: [String(imageB64 || '')] }],
    stream: false,
    think: false,
    keep_alive: '30m',
    options: {
      num_ctx: Math.max(2048, Math.min(8192, toInt(options.numCtx, 4096))),
      num_predict: Math.max(64, Math.min(1024, toInt(options.maxTokens, 256)))
    }
  };
}

function pickVisionModel(models = [], preferred = '') {
  const capable = (models || []).filter(m => Array.isArray(m.capabilities) && m.capabilities.includes('vision'));
  if (!capable.length) return { ok: false, message: 'No locally installed Ollama model supports image analysis. Install a vision model (for example: ollama pull qwen3.5:4b), then press Refresh in AI Settings. JARVIS will not send screenshots to a cloud service.' };
  const wanted = String(preferred || '').trim();
  if (wanted) {
    const exact = capable.find(m => m.name === wanted || (m.name.endsWith(':latest') && m.name.slice(0, -7) === wanted));
    if (exact) return { ok: true, model: exact.name, visionModels: capable.map(m => m.name) };
    const notVision = (models || []).some(m => m.name === wanted || (m.name.endsWith(':latest') && m.name.slice(0, -7) === wanted));
    if (notVision) return { ok: false, message: `“${wanted}” is installed but cannot analyze images. Pick a vision-capable model (installed: ${capable.map(m => m.name).join(', ')}).` };
  }
  // Default to the smallest vision-capable model: on a CPU-only
  // computer a 4B model answers in tens of seconds while a 27B
  // model can thrash RAM and never finish. An explicit setting wins.
  const bySize = [...capable].sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0));
  return { ok: true, model: bySize[0].name, visionModels: capable.map(m => m.name) };
}

function screenshotFileName(now, target, existing = new Set()) {
  const d = new Date(now);
  const p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const cleanTarget = String(target || 'screen').replace(/[^a-z0-9-]/gi, '').slice(0, 16) || 'screen';
  let name = `jarvis-${cleanTarget}-${stamp}.png`;
  let counter = 1;
  while (existing.has(name.toLowerCase())) {
    counter += 1;
    name = `jarvis-${cleanTarget}-${stamp}-${counter}.png`;
    if (counter > 99) break;
  }
  return name;
}

// Windows env-var paths (%USERPROFILE%) plus ~ are expanded, without running
// any shell, so a user can paste common shortcut forms into settings.
function expandHomeJars(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  value = value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => process.env[name] || match);
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(2));
  return value.replace(/\\$/, '');
}

const CAPTURE_TARGETS = ['screen', 'desktop', 'window', 'display1', 'display2', 'display3'];
function normalizeTarget(value) {
  const raw = String(value || 'screen').toLowerCase().trim();
  if (/^monitor\d+$/.test(raw)) return `display${raw.slice(7)}`;
  if (/^display ?(\d)$/.test(raw)) return `display${raw.slice(-1)}`;
  return CAPTURE_TARGETS.includes(raw) ? raw : 'screen';
}

// ---- OCR fast path (Windows only) ----
// Uses Windows.Media.Ocr via PowerShell to extract text from a captured image.
// This is dramatically faster than sending to a vision model for text-only queries.
// Returns { ok, text, timings } or { ok: false } if OCR is unavailable.
function ocrScript(target) {
  return String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]
$target=$env:JARVIS_CAPTURE_TARGET
$file=$env:JARVIS_CAPTURE_FILE
# Determine capture bounds (same logic as captureScript)
if($target -eq 'window'){
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public struct JRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class JWinCap {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out JRect r);
}
'@
  $h=[JWinCap]::GetForegroundWindow()
  if($h -eq [IntPtr]::Zero){ @{ok=$false; message='No foreground window found.'} | ConvertTo-Json -Compress; exit }
  $r=New-Object JRect; [void][JWinCap]::GetWindowRect($h,[ref]$r)
  $x=$r.Left; $y=$r.Top; $w=$r.Right-$r.Left; $hgt=$r.Bottom-$r.Top
} else {
  if($target -eq 'desktop'){
    $vs=[System.Windows.Forms.SystemInformation]::VirtualScreen
    $x=$vs.X; $y=$vs.Y; $w=$vs.Width; $hgt=$vs.Height
  } elseif($target -like 'display*'){
    $all=[System.Windows.Forms.Screen]::AllScreens
    $n=[int]($target -replace 'display','') - 1
    if($n -lt 0 -or $n -ge $all.Count){ @{ok=$false; message='Display not found.'} | ConvertTo-Json -Compress; exit }
    $b=$all[$n].Bounds; $x=$b.X; $y=$b.Y; $w=$b.Width; $hgt=$b.Height
  } else {
    $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $x=$b.X; $y=$b.Y; $w=$b.Width; $hgt=$b.Height
  }
}
if($w -le 0 -or $hgt -le 0){ @{ok=$false; message='Empty capture area.'} | ConvertTo-Json -Compress; exit }
$bmp=New-Object System.Drawing.Bitmap $w,$hgt
try {
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  try { $g.CopyFromScreen($x,$y,0,0,$bmp.Size) } finally { $g.Dispose() }
  # OCR works best at native resolution; no downscaling
  $bmp.Save($file,[System.Drawing.Imaging.ImageFormat]::Png)
} finally { $bmp.Dispose() }
# Load image for OCR
$stream=[System.IO.File]::OpenRead($file)
try {
  $decoder=[Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream.AsRuntimeStream()).GetResults()
  $bitmap=$decoder.GetSoftwareBitmapAsync().GetResults()
} finally { $stream.Dispose() }
# Run OCR
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if($null -eq $engine){
  $langs=[Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
  if($langs.Count -eq 0){ @{ok=$false; message='No OCR languages installed.'} | ConvertTo-Json -Compress; exit }
  $engine=[Windows.Media.Ocr.OcrEngine]::CreateFromLanguage($langs[0])
}
$result=$engine.RecognizeAsync($bitmap).GetResults()
$text=$result.Text
if([string]::IsNullOrWhiteSpace($text)){
  @{ok=$true; text=''; confidence=0; message='No text detected on screen.'} | ConvertTo-Json -Compress
} else {
  $lines=@($result.Lines | ForEach-Object { $_.Text })
  $conf=0; $n=0
  foreach($line in $result.Lines){ if($line.Words){ foreach($w in $line.Words){ $conf += $w.Confidence; $n++ } } }
  $avgConf=if($n -gt 0){[Math]::Round($conf/$n,2)}else{0}
  @{ok=$true; text=$text; lines=$lines; confidence=$avgConf; message='OCR completed successfully.'} | ConvertTo-Json -Compress
}
`;
}

// Detect if a question is primarily text-focused (good candidate for OCR fast path)
function isTextFocusedQuery(question) {
  const q = String(question || '').toLowerCase().trim();
  if (!q) return false;
  const textPatterns = [
    /\bwhat.*text/i, /\bread.*(text|label|error|message|title)/i, /\bwhat.*(says|written|displayed)/i,
    /\btranscribe/i, /\bwhat.*(word|words|letter|letters)/i, /\bspell/i,
    /\berror.*(message|text|code)/i, /\bwarning.*(message|text)/i, /\bpop.?up/i,
    /\bnotification.*text/i, /\bsubject.*line/i, /\bheading/i, /\btitle.*bar/i,
    /\bwhat.*type/i, /\bwhat.*entered/i, /\bselected.*text/i, /\bcopy.*text/i,
    /\bwhere.*cursor/i, /\bwhat.*click/i, /\bwhat.*button/i, /\bwhich.*(tab|menu|option)/i,
    /\bfile.*name/i, /\bfolder.*name/i, /\bwindow.*title/i, /\bpage.*title/i,
    /\bwhat.*shown/i, /\bwhat.*visible/i, /\bdisplay.*text/i, /\bshow.*text/i,
    /\bcount.*(word|line|char)/i, /\bnumber.*(show|display)/i, /\bprice/i,
    /\bemail.*(subject|from|to)/i, /\burl/i, /\bip.*address/i, /\bversion.*number/i,
    /\bcpu.*usage/i, /\bram.*usage/i, /\bmemory.*usage/i, /\bwhat.*model/i,
    /\bwho.*(sent|wrote|from)/i, /\bwhen.*(time|date)/i, /\bwhat.*time/i,
    /\bwhat.*date/i, /\bwhat.*day/i, /\btop.*text/i, /\bbottom.*text/i,
  ];
  return textPatterns.some(p => p.test(q));
}

// ---- Capture (Windows only) ----
function captureScript(target) {
  return String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$target=$env:JARVIS_CAPTURE_TARGET
$file=$env:JARVIS_CAPTURE_FILE
$self=$false
$source='screen'
$title=''; $procName=''
if($target -eq 'window'){
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public struct JRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class JWinCap {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out JRect r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
  $h=[JWinCap]::GetForegroundWindow()
  if($h -eq [IntPtr]::Zero){ @{ok=$false; message='I could not find a foreground window to capture.'} | ConvertTo-Json -Compress; exit }
  $r=New-Object JRect
  [void][JWinCap]::GetWindowRect($h,[ref]$r)
  [uint32]$pid=0; [void][JWinCap]::GetWindowThreadProcessId($h,[ref]$pid)
  $p=Get-Process -Id $pid -ErrorAction SilentlyContinue
  $procName=[string]$p.ProcessName
  $sb=New-Object System.Text.StringBuilder 512; [void][JWinCap]::GetWindowText($h,$sb,$sb.Capacity); $title=$sb.ToString()
  if($procName -ieq 'JARVIS' -or $procName -ieq $env:JARVIS_SELF_NAME){ @{ok=$false; self=$true; message='JARVIS itself is the foreground window, so there is nothing else to look at. Select another window and ask again.'} | ConvertTo-Json -Compress; exit }
  $x=$r.Left; $y=$r.Top; $w=$r.Right-$r.Left; $hgt=$r.Bottom-$r.Top; $source='window'
} else {
  if($target -eq 'desktop'){
    $vs=[System.Windows.Forms.SystemInformation]::VirtualScreen
    $x=$vs.X; $y=$vs.Y; $w=$vs.Width; $hgt=$vs.Height; $source='desktop'
  } elseif($target -like 'display*'){
    $all=[System.Windows.Forms.Screen]::AllScreens
    $n=[int]($target -replace 'display','') - 1
    if($n -lt 0 -or $n -ge $all.Count){ @{ok=$false; message="I could not find display $($n+1). This computer has $($all.Count) display(s)."} | ConvertTo-Json -Compress; exit }
    $b=$all[$n].Bounds; $x=$b.X; $y=$b.Y; $w=$b.Width; $hgt=$b.Height; $source=$all[$n].DeviceName.TrimStart('\\','.')
  } else {
    $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $x=$b.X; $y=$b.Y; $w=$b.Width; $hgt=$b.Height; $source='screen'
  }
}
if($w -le 0 -or $hgt -le 0){ @{ok=$false; message='That window or display reports an empty capture area (it may be minimized).'} | ConvertTo-Json -Compress; exit }
if($w*$hgt -gt 12000*8000){ @{ok=$false; message='That capture area is too large to process.'} | ConvertTo-Json -Compress; exit }
$bmp=New-Object System.Drawing.Bitmap $w,$hgt
try {
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  try { $g.CopyFromScreen($x,$y,0,0,$bmp.Size) } finally { $g.Dispose() }
  # Downscale large captures so the local vision model can process
  # them quickly on CPU while keeping on-screen text readable.
  $scale=[Math]::Min(1.0, 1280.0/[Math]::Max($w,$hgt))
  if($scale -lt 0.999){
    $nw=[Math]::Max(1,[int][Math]::Round($w*$scale)); $nh=[Math]::Max(1,[int][Math]::Round($hgt*$scale))
    $small=New-Object System.Drawing.Bitmap $nw,$nh
    try {
      $g2=[System.Drawing.Graphics]::FromImage($small)
      $g2.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      try { $g2.DrawImage($bmp,0,0,$nw,$nh) } finally { $g2.Dispose() }
    } finally { $bmp.Dispose(); $bmp=$small }
  }
  $finalW=$bmp.Width; $finalH=$bmp.Height
  $bmp.Save($file,[System.Drawing.Imaging.ImageFormat]::Png)
} finally { $bmp.Dispose() }
@{ok=$true; x=$x; y=$y; w=$finalW; h=$finalH; source=$source; process=$procName; title=$title; monitors=[System.Windows.Forms.Screen]::AllScreens.Count} | ConvertTo-Json -Compress
`;
}

function displaysScript() {
  return String.raw`
Add-Type -AssemblyName System.Windows.Forms
$all=[System.Windows.Forms.Screen]::AllScreens
@($all | ForEach-Object { [pscustomobject]@{ device=$_.DeviceName; primary=$_.Primary; x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height } }) | ConvertTo-Json -Compress
`;
}

// ---- Module factory ----
// ---- Webcam vision helpers (pure, unit-testable) ----
const CAMERA_MODES = Object.freeze({
  identify: { label: 'General object identification', prompt: 'Identify the visible object(s): category, approximate shape, visible color, and apparent material only when the surface clearly suggests it. Quote visible label text only when it is legible.' },
  explain: { label: 'Explain how it works', prompt: 'Explain how the visible object likely works and what it is used for, based on its visible parts, and say plainly when the exact model cannot be determined from the image.' },
  readtext: { label: 'Read visible text', prompt: 'Read and transcribe any clearly visible text, labels, or markings in the frame. If text is too small, blurry, or angled, say exactly that instead of guessing characters.' },
  compare: { label: 'Compare objects', prompt: 'Compare the visible objects: types, shapes, colors, visible components, and likely everyday uses. Base the comparison only on visible differences.' },
  scene: { label: 'Describe the scene', prompt: 'Describe the overall scene in the frame: objects present, their arrangement, and what is happening, clearly.' }
});

function validateCameraImage(imageB64) {
  if (!imageB64 || typeof imageB64 !== 'string') return { ok: false, message: 'No camera frame was captured. Connect the camera and try again.' };
  const base64 = String(imageB64).replace(/^data:image\/[a-z+]+;base64,/i, '').trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return { ok: false, message: 'That camera frame was unreadable (not a valid image).' };
  if (base64.length < 500) return { ok: false, message: 'That camera frame is blank or too small to analyze. Check the preview.' };
  if (base64.length > 6 * 1024 * 1024) return { ok: false, message: 'That camera frame is too large to process.' };
  return { ok: true, imageB64: base64 };
}

function createScreenVision(options = {}) {
  const root = options.root || __dirname;
  const fetchImpl = options.fetch || ((...args) => fetch(...args));
  const runPowerShellImpl = options.runPowerShell || runLocalCapture;
  const ollamaUrl = String(options.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const settingsPath = path.join(DIRECTORY, 'screen-vision-settings.json');
  const followUpWindowMs = Math.max(30000, Number(options.followUpWindowMs) || FOLLOW_UP_WINDOW_MS_DEFAULT);
  const log = options.log || console;

  const defaults = {
    enabled: true,
    visionModel: '',
    followUpWindowMinutes: 10,
    screenshotDir: path.join(DIRECTORY, 'Screenshots')
  };

  function loadSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return { ...defaults, ...raw };
    } catch { return { ...defaults }; }
  }
  function saveSettings(next) {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), 'utf8');
    } catch (error) { log.error('[JARVIS screen settings]', error.message); }
  }

  let settings = loadSettings();
  let lastAnalysis = null; // { imageB64, model, question, answer, at, target }
  let captureBusy = false;
  let modelsCache = null;
  let modelsCacheAt = 0;
  const MODELS_CACHE_TTL = 30000; // 30 seconds — avoid fetching /api/tags on every request

  function status() {
    const visionModels = pickVisionModel(modelsCache || [], settings.visionModel).visionModels || [];
    return {
      ok: true,
      enabled: Boolean(settings.enabled),
      visionModel: settings.visionModel || '',
      visionModels,
      screenshotDir: resolveScreenshotDir(),
      followUpWindowMinutes: Math.max(1, Math.min(60, toInt(settings.followUpWindowMinutes, 10))),
      hasFreshContext: Boolean(lastAnalysis && Date.now() - lastAnalysis.at < followUpWindowMs),
      platform: process.platform
    };
  }

  function resolveScreenshotDir() {
    const dir = expandHomeJars(settings.screenshotDir || defaults.screenshotDir);
    return dir || defaults.screenshotDir;
  }
  function setSettings(patch = {}) {
    if (typeof patch.enabled === 'boolean') settings.enabled = patch.enabled;
    if (typeof patch.visionModel === 'string') settings.visionModel = patch.visionModel.slice(0, 100);
    if (patch.followUpWindowMinutes != null) settings.followUpWindowMinutes = Math.max(1, Math.min(60, toInt(patch.followUpWindowMinutes, 10)));
    if (typeof patch.screenshotDir === 'string' && patch.screenshotDir.trim()) {
      const dir = expandHomeJars(patch.screenshotDir);
      // Only absolute Windows paths (drive or UNC) are accepted so a
      // relative value can never silently redirect screenshots.
      if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(dir)) {
        settings.screenshotDir = dir;
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      } else return { ok: false, status: status(), message: 'Enter an absolute folder path (for example C:\\Users\\you\\Pictures\\JARVIS).' };
    }
    saveSettings(settings);
    return { ok: true, status: status(), message: 'Screen settings saved.' };
  }

  async function runCapture(target) {
    if (process.platform !== 'win32') return { ok: false, message: 'Screen capture is only available on Windows.' };
    if (captureBusy) return { ok: false, message: 'I am already processing a capture. One moment, Sir.' };
    captureBusy = true;
    const file = path.join(os.tmpdir(), `jarvis-capture-${process.pid}-${Date.now()}.png`);
    try {
      const json = await runPowerShellImpl(captureScript(target), {
        JARVIS_CAPTURE_TARGET: target,
        JARVIS_CAPTURE_FILE: file,
        JARVIS_SELF_NAME: 'jarvis'
      }, 15000);
      let meta = {};
      try { meta = JSON.parse(String(json || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}'); } catch { meta = { ok: false, message: 'The screen capture returned unreadable data.' }; }
      if (!meta.ok) return meta;
      const buffer = await fs.promises.readFile(file);
      if (!buffer || buffer.length < 200) return { ok: false, message: 'The screen capture produced no image. Check Windows graphics drivers or display settings.' };
      return { ok: true, buffer, ...meta };
    } catch (error) {
      return { ok: false, message: `Screen capture failed: ${error.killed ? 'it took too long' : String(error.message || error).slice(0, 160)}` };
    } finally {
      captureBusy = false;
      fs.promises.unlink(file).catch(() => {});
    }
  }

  // OCR fast path: capture + OCR without invoking the vision model.
  // Much faster for text-only queries (read text, error messages, etc.).
  async function runOcrCapture(target) {
    if (process.platform !== 'win32') return { ok: false, message: 'Screen capture is only available on Windows.' };
    if (captureBusy) return { ok: false, message: 'I am already processing a capture. One moment, Sir.' };
    captureBusy = true;
    const file = path.join(os.tmpdir(), `jarvis-ocr-${process.pid}-${Date.now()}.png`);
    try {
      const json = await runPowerShellImpl(ocrScript(target), {
        JARVIS_CAPTURE_TARGET: target,
        JARVIS_CAPTURE_FILE: file,
        JARVIS_SELF_NAME: 'jarvis'
      }, 20000);
      let meta = {};
      try { meta = JSON.parse(String(json || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}'); } catch { meta = { ok: false, message: 'OCR returned unreadable data.' }; }
      if (!meta.ok) return meta;
      return { ok: true, text: meta.text || '', lines: meta.lines || [], confidence: meta.confidence || 0, source: meta.source || target, timings: { captureMs: 0 } };
    } catch (error) {
      return { ok: false, message: `OCR failed: ${error.killed ? 'it took too long' : String(error.message || error).slice(0, 160)}` };
    } finally {
      captureBusy = false;
      fs.promises.unlink(file).catch(() => {});
    }
  }

  async function listDisplays() {
    if (process.platform !== 'win32') return { ok: false, message: 'Windows is required to list displays.' };
    try {
      const json = await runPowerShellImpl(displaysScript(), {}, 8000);
      let displays = JSON.parse(String(json || '').trim() || '[]');
      if (displays && !Array.isArray(displays)) displays = [displays];
      return { ok: true, count: displays.length, displays };
    } catch (error) { return { ok: false, message: `Could not list displays: ${String(error.message).slice(0, 160)}` }; }
  }

  async function fetchTags() {
    const now = Date.now();
    if (modelsCache && (now - modelsCacheAt) < MODELS_CACHE_TTL) return modelsCache;
    const response = await fetchImpl(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
    const data = await response.json();
    modelsCache = Array.isArray(data.models) ? data.models : [];
    modelsCacheAt = now;
    return modelsCache;
  }

  async function chooseVisionModel() {
    let models;
    try { models = await fetchTags(); }
    catch (error) { return { ok: false, message: `Ollama is not reachable (${String(error.message).slice(0, 120)}). Start it, then ask again.` }; }
    return pickVisionModel(models, settings.visionModel);
  }

  // Request one honest analysis pass on the given image.
  async function analyzeImage({ question, imageB64, model, targetHint = {}, followUpLabel = '' }) {
    const prompt = [
      'You are JARVIS analyzing a screenshot of the user\'s screen.',
      targetHint.source ? `Capture target: ${targetHint.source}${targetHint.process ? ` (window: ${targetHint.process})` : ''}${targetHint.title ? ` — title: ${targetHint.title}` : ''}.` : '',
      `${followUpLabel}Answer the user's question using only what is clearly visible.`,
      'Quote visible text exactly when asked to read it. If the image is too small, low-detail, unreadable, or lacks information to answer, say that plainly instead of guessing.',
      'Never invent text, buttons, numbers, dialog contents, or people. Keep the answer concise (two to six sentences).',
      'If the question asks what to click next, identify the control you mean as precisely as the image allows and say so when two options look similar.',
      `User question: ${question || 'What is on this screen?'}`
    ].filter(Boolean).join(' ');
    const body = buildVisionRequestBody({ question: prompt, model, imageB64 });
    let response;
    try {
      response = await fetchImpl(`${ollamaUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // 3 minutes bounds the wait: a cold model load plus a
        // CPU-only 4B vision pass measures well under 2 minutes.
        // If the model is still running after that, the answer
        // below tells the user why instead of hanging forever.
        signal: AbortSignal.timeout(180000)
      });
    } catch (error) {
      if (error?.name === 'AbortError' || /abort/i.test(String(error.message || ''))) {
        throw new Error('The local vision model did not answer within 3 minutes. It may still be loading into memory, another Ollama request may be running (Ollama processes one request at a time), or the selected model may be too large for this CPU-only computer. Choose a smaller vision model in AI Settings, or ask again once Ollama has warmed up.');
      }
      throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(String(data.error || `Ollama returned HTTP ${response.status}.`).slice(0, 300));
    const answer = String(data.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!answer) throw new Error('The vision model returned an empty answer. Try again or choose another vision model.');
    return answer;
  }

  function expireLastAnalysis() {
    if (lastAnalysis && Date.now() - lastAnalysis.at > followUpWindowMs) lastAnalysis = null;
  }

  async function describe({ question = '', target = 'screen', saveTemporary = true } = {}) {
    const startedAt = Date.now();
    const requestId = `scr-${process.pid}-${startedAt}`;
    const timings = { requestId };
    if (!settings.enabled) return { ok: false, message: 'Screen analysis is turned off. Enable it in the Screen Vision settings card or say "Jarvis, enable screen vision".' };
    const allowedQuestion = String(question || '').trim().slice(0, 800);
    expireLastAnalysis();
    // OCR fast path: for text-focused queries, skip the vision model entirely.
    if (isTextFocusedQuery(allowedQuestion)) {
      const tOcr = Date.now();
      const ocrResult = await runOcrCapture(normalizeTarget(target));
      timings.ocrMs = Date.now() - tOcr;
      timings.totalMs = Date.now() - startedAt;
      timings.fastPath = 'ocr';
      if (ocrResult.ok) {
        const ocrAnswer = ocrResult.text
          ? `The screen shows: "${ocrResult.text}"`
          : 'I could not detect any readable text on the screen, Sir.';
        console.log(`[JARVIS screen] ${requestId} OCR ${timings.ocrMs}ms total=${timings.totalMs}ms`);
        return {
          ok: true, response: ocrAnswer, model: 'ocr',
          target: normalizeTarget(target), source: ocrResult.source,
          capturedAt: new Date().toISOString(),
          temporary: saveTemporary ? 'temporary capture (not saved)' : '',
          timings
        };
      }
      // OCR failed — fall through to vision model
      console.log(`[JARVIS screen] ${requestId} OCR failed after ${timings.ocrMs}ms, falling back to vision model`);
    }
    const tModel = Date.now();
    const modelChoice = await chooseVisionModel();
    timings.modelSelectMs = Date.now() - tModel;
    if (!modelChoice.ok) return modelChoice;
    const tCapture = Date.now();
    const capture = await runCapture(normalizeTarget(target));
    timings.captureMs = Date.now() - tCapture;
    if (!capture.ok) return capture;
    const imageB64 = capture.buffer.toString('base64');
    timings.imageBytes = capture.buffer.length;
    timings.imageMB = Number((capture.buffer.length / 1024 / 1024).toFixed(1));
    try {
      const tInfer = Date.now();
      const answer = await analyzeImage({
        question: allowedQuestion,
        imageB64,
        model: modelChoice.model,
        targetHint: { source: capture.source, process: capture.process, title: capture.title }
      });
      timings.inferenceMs = Date.now() - tInfer;
      timings.totalMs = Date.now() - startedAt;
      lastAnalysis = { imageB64, model: modelChoice.model, question: allowedQuestion, answer, at: Date.now(), target: normalizeTarget(target), width: capture.w, height: capture.h };
      console.log(`[JARVIS screen] ${requestId} model=${modelChoice.model} ${capture.w}x${capture.h} img=${timings.imageMB}MB modelSelect=${timings.modelSelectMs}ms capture=${timings.captureMs}ms inference=${timings.inferenceMs}ms total=${timings.totalMs}ms`);
      return {
        ok: true, response: answer, model: modelChoice.model,
        target: lastAnalysis.target, width: capture.w, height: capture.h,
        source: capture.source, process: capture.process || '', title: capture.title || '',
        capturedAt: new Date(lastAnalysis.at).toISOString(),
        temporary: saveTemporary ? 'temporary capture (not saved)' : '',
        timings
      };
    } catch (error) {
      timings.totalMs = Date.now() - startedAt;
      console.error(`[JARVIS screen] ${requestId} FAILED model=${modelChoice.model} after ${timings.totalMs}ms (capture=${timings.captureMs}ms): ${String(error.message).slice(0, 200)}`);
      return { ok: false, message: `Visual analysis failed: ${String(error.message).slice(0, 220)}`, timings };
    }
  }

  async function followUp({ question = '' } = {}) {
    if (!settings.enabled) return { ok: false, message: 'Screen analysis is turned off.' };
    expireLastAnalysis();
    const asked = String(question || '').trim().slice(0, 800);
    if (!lastAnalysis) return { ok: false, stale: true, message: 'I do not have a fresh screen capture to look at. Ask me again about the screen (for example, "Jarvis, what is on my screen?") and I will take a new one.' };
    try {
      const answer = await analyzeImage({
        question: asked || 'Follow-up question about this screenshot: answer from what is visible.',
        imageB64: lastAnalysis.imageB64,
        model: lastAnalysis.model,
        followUpLabel: 'This is a follow-up question about a screenshot taken a moment ago — its content may have changed on the real screen. '
      });
      lastAnalysis.answer = answer;
      lastAnalysis.at = Date.now(); // refresh the bounded context on use
      return { ok: true, response: answer, model: lastAnalysis.model, target: lastAnalysis.target, followUp: true, capturedAt: new Date(lastAnalysis.at).toISOString() };
    } catch (error) {
      return { ok: false, message: `Follow-up analysis failed: ${String(error.message).slice(0, 220)}` };
    }
  }

  async function screenshotDirPrepare() {
    const dir = resolveScreenshotDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (error) { return { ok: false, dir, message: `The screenshot folder could not be created: ${String(error.message).slice(0, 160)}` }; }
    if (fs.statSync(dir).isDirectory() === false) return { ok: false, dir, message: `${dir} exists but is not a folder.` };
    try { fs.accessSync(dir, fs.constants.W_OK); } catch { return { ok: false, dir, message: `${dir} is not writable by your account.` }; }
    return { ok: true, dir };
  }

  async function saveScreenshot({ target = 'screen' } = {}) {
    const prepared = await screenshotDirPrepare();
    if (!prepared.ok) return prepared;
    const capture = await runCapture(normalizeTarget(target));
    if (!capture.ok) return capture;
    const dir = prepared.dir;
    const existing = new Set(fs.readdirSync(dir).map(name => name.toLowerCase()));
    const name = screenshotFileName(Date.now(), capture.source || target, existing);
    const file = path.join(dir, name);
    try { fs.writeFileSync(file, capture.buffer, { flag: 'wx' }); }
    catch (error) { return { ok: false, message: `Could not save the screenshot: ${String(error.message).slice(0, 180)}` }; }
    return { ok: true, name, path: file, target: capture.source || target, width: capture.w, height: capture.h, sizeBytes: capture.buffer.length, capturedAt: new Date().toISOString(), message: `Screenshot saved as ${file}` };
  }

  async function listScreenshots({ withinDays = 30, limit = 20 } = {}) {
    const dir = resolveScreenshotDir();
    if (!fs.existsSync(dir)) return { ok: true, dir, screenshots: [], message: 'The screenshot folder does not exist yet.' };
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.png')); } catch (error) { return { ok: false, message: `Could not read the screenshot folder: ${String(error.message).slice(0, 160)}` }; }
    const cutoff = Date.now() - Math.max(1, Math.min(365, toInt(withinDays, 30))) * 86400000;
    const rows = [];
    for (const name of names) {
      const file = path.join(dir, name);
      let stat = null;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat || !stat.isFile() || stat.mtimeMs < cutoff) continue;
      rows.push({ name, path: file, modified: stat.mtime.toISOString(), sizeMB: Number((stat.size / (1024 * 1024)).toFixed(2)) });
    }
    rows.sort((a, b) => (a.modified < b.modified ? 1 : -1));
    return { ok: true, dir, screenshots: rows.slice(0, Math.max(1, toInt(limit, 20))) };
  }

  // Names are validated as plain file names so a lookup can never escape the
  // screenshot directory.
  function resolveScreenshotByName(name) {
    const clean = path.basename(String(name || '').trim());
    const safe = clean.replace(/[<>:"|?*]/g, '');
    if (!safe || /[\\/]|\.\./.test(name || '')) return null;
    const file = path.join(resolveScreenshotDir(), safe.endsWith('.png') ? safe : `${safe}.png`);
    return fs.existsSync(file) ? file : null;
  }

  // Open a folder (or file) in Windows File Explorer and prove it worked.
  // Reuse/activate an existing Explorer window for the folder when one is
  // already open, so repeated clicks never pile up duplicate windows. Any
  // launch failure is reported instead of claimed as success.
  function explorerScript() {
    return String.raw`
$ErrorActionPreference='Stop'
$dir=$env:JARVIS_OPEN_DIR
$mode=$env:JARVIS_OPEN_MODE
if([string]::IsNullOrWhiteSpace($dir)){ @{ok=$false; message='No folder path was provided.'} | ConvertTo-Json -Compress; exit }
if($mode -eq 'folder' -and -not (Test-Path -LiteralPath $dir -PathType Container)){ @{ok=$false; message="The folder does not exist: $dir"} | ConvertTo-Json -Compress; exit }
if($mode -eq 'file' -and -not (Test-Path -LiteralPath $dir -PathType Leaf)){ @{ok=$false; message="That file is no longer there: $dir"} | ConvertTo-Json -Compress; exit }
if($mode -eq 'folder'){
  $want='file:///'+$dir.Replace('\','/').TrimEnd('/')
  try{
    $shell=New-Object -ComObject Shell.Application
    foreach($w in $shell.Windows()){
      try{
        $u=[uri]::UnescapeDataString([string]$w.LocationURL)
        if($u -ne '' -and $u.TrimEnd('/') -ieq $want){
          try{
            Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class JExpFG { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'
            [void][JExpFG]::ShowWindow([IntPtr]$w.HWND,9); [void][JExpFG]::SetForegroundWindow([IntPtr]$w.HWND)
          }catch{}
          @{ok=$true; reused=$true; dir=$dir} | ConvertTo-Json -Compress; exit
        }
      }catch{}
    }
  }catch{}
}
Start-Process -FilePath explorer.exe -ArgumentList ('"'+$dir+'"')
@{ok=$true; reused=$false; dir=$dir} | ConvertTo-Json -Compress
`;
  }

  async function openInExplorer(target, mode) {
    try {
      const out = await runPowerShellImpl(explorerScript(), { JARVIS_OPEN_DIR: target, JARVIS_OPEN_MODE: mode }, 15000);
      const last = String(out || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}';
      let parsed = null;
      try { parsed = JSON.parse(last); } catch {}
      if (parsed && parsed.ok) return parsed;
      return { ok: false, dir: target, message: (parsed && parsed.message) || 'Windows Explorer did not confirm the folder.' };
    } catch (error) {
      return { ok: false, dir: target, message: `Windows Explorer could not open that location: ${String((error && error.message) || error).slice(0, 160)}` };
    }
  }

  async function openScreenshotFolder() {
    const prepared = await screenshotDirPrepare();
    if (!prepared.ok) return prepared;
    const opened = await openInExplorer(prepared.dir, 'folder');
    if (!opened.ok) return opened;
    return { ok: true, dir: prepared.dir, reused: Boolean(opened.reused), message: opened.reused ? `The screenshot folder is already open: ${prepared.dir}` : `Opened the screenshot folder ${prepared.dir}` };
  }

  async function openScreenshot({ name = '', latest = false } = {}) {
    const prepared = await screenshotDirPrepare();
    if (!prepared.ok) return prepared;
    let file = null;
    if (latest) {
      const list = await listScreenshots({ limit: 1 });
      file = list.screenshots?.[0]?.path || null;
    } else file = resolveScreenshotByName(name);
    if (!file) return { ok: false, message: latest ? 'You have no saved screenshots yet, Sir.' : `I could not find a screenshot named ${name}. Say "show recent screenshots" first.` };
    const opened = await openInExplorer(file, 'file');
    if (!opened.ok) return { ok: false, message: opened.message };
    return { ok: true, path: file, message: `Opened ${path.basename(file)}` };
  }

  // Deletion is reversible: the image is moved into the folder's .trash with
  // a timestamp instead of being unlinked, so "restore" stays possible.
  async function deleteScreenshot({ name = '', confirmed = false } = {}) {
    const file = resolveScreenshotByName(name);
    if (!file) return { ok: false, message: `I could not find a screenshot named ${name}.` };
    if (confirmed !== true) return { ok: false, needsConfirmation: true, name: path.basename(file), message: `Delete ${path.basename(file)}? Confirm to move it to the screenshot trash.` };
    const trash = path.join(resolveScreenshotDir(), '.trash', new Date().toISOString().replace(/[:.]/g, '-'));
    try {
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(file, path.join(trash, path.basename(file)));
    } catch (error) { return { ok: false, message: `Could not delete ${path.basename(file)}: ${String(error.message).slice(0, 160)}` }; }
    return { ok: true, name: path.basename(file), message: `${path.basename(file)} moved to the screenshot trash.` };
  }

  async function analyzeSavedScreenshot({ name = '', question = '' } = {}) {
    const file = resolveScreenshotByName(name);
    if (!file) return { ok: false, message: `I could not find a screenshot named ${name}. Say "show recent screenshots" first.` };
    if (!settings.enabled) return { ok: false, message: 'Screen analysis is turned off.' };
    const modelChoice = await chooseVisionModel();
    if (!modelChoice.ok) return modelChoice;
    const buffer = await fs.promises.readFile(file);
    if (buffer.length > 12 * 1024 * 1024) return { ok: false, message: 'That screenshot is too large to analyze.' };
    try {
      const answer = await analyzeImage({ question, imageB64: buffer.toString('base64'), model: modelChoice.model, targetHint: { source: path.basename(file) } });
      return { ok: true, response: answer, model: modelChoice.model, name: path.basename(file) };
    } catch (error) {
      return { ok: false, message: `Analysis of ${path.basename(file)} failed: ${String(error.message).slice(0, 200)}` };
    }
  }

  function runLocalCapture(script, env, timeout) {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout, maxBuffer: 1024 * 1024, env: { ...process.env, ...env } }).then(r => r.stdout);
  }

  let lastCamera = null; // { imageB64, at, question, answer, model }
  let cameraBusy = false;

  return {
    status, setSettings,
    describe, followUp,
    listDisplays,
    saveScreenshot, listScreenshots, openScreenshot, openScreenshotFolder, deleteScreenshot,
    analyzeSavedScreenshot,
    // Webcam vision members
  // The browser (JARVIS app window) owns camera capture: getUserMedia gives
  // the live preview and frames through the normal Windows permission flow.
  // The server only receives explicit, single frames for analysis — never a
  // stream — and reuses the same local vision-model pipeline as screen
  // vision. A restart never resumes the camera because the server never
  // starts it; the purely local stream lives only in the app window.

  cameraStatus() {
    return {
      ok: true,
      enabled: Boolean(settings.enabled),
      hasFreshContext: Boolean(lastCamera && Date.now() - lastCamera.at < followUpWindowMs),
      validModes: Object.keys(CAMERA_MODES),
      note: 'Frames are captured on demand in the app window and analyzed locally.'
    };
  },

  clearCameraContext() {
    lastCamera = null;
    return { ok: true, message: 'Camera visual context cleared.' };
  },

  async cameraAnalyze({ imageB64, question = '', mode = 'identify' } = {}) {
    if (!settings.enabled) return { ok: false, message: 'Screen analysis is disabled in settings; camera analysis uses the same local vision pipeline and needs it enabled.' };
    const check = validateCameraImage(imageB64);
    if (!check.ok) return check;
    if (cameraBusy) return { ok: false, message: 'I am still analyzing the previous camera frame. One moment, Sir.' };
    cameraBusy = true;
    const startedAt = Date.now();
    const requestId = `cam-${process.pid}-${startedAt}`;
    const timings = { requestId };
    try {
      const tModel = Date.now();
      const modelChoice = await chooseVisionModel();
      timings.modelSelectMs = Date.now() - tModel;
      if (!modelChoice.ok) return modelChoice;
      const wantedMode = CAMERA_MODES[mode] ? mode : 'identify';
      const asked = String(question || '').trim().slice(0, 800);
      const prompt = [
        'You are JARVIS looking at one frame from the user\'s webcam. An object is usually held at typical desk distance.',
        CAMERA_MODES[wantedMode].prompt,
        asked ? `User question: ${asked}` : '',
        'Answer using only what is clearly visible in this frame. Distinguish clearly between what you can identify and what you are inferring.',
        'Never invent brand names, model numbers, materials you cannot see, hidden internals, or exact prices. If the object is blurry, too far, cut off, or poorly lit, say exactly what would make the frame analyzable (move closer, center it, improve lighting) instead of guessing.',
        'Keep the answer concise (two to five sentences) and natural, as a spoken assistant reply.'
      ].filter(Boolean).join(' ');
      const tInfer = Date.now();
      const answer = await analyzeImage({ question: prompt, imageB64: check.imageB64, model: modelChoice.model, targetHint: { source: 'webcam frame' } });
      timings.inferenceMs = Date.now() - tInfer;
      timings.totalMs = Date.now() - startedAt;
      lastCamera = { imageB64: check.imageB64, at: Date.now(), question: asked, answer, model: modelChoice.model, mode: wantedMode };
      console.log(`[JARVIS camera] ${requestId} model=${modelChoice.model} modelSelect=${timings.modelSelectMs}ms inference=${timings.inferenceMs}ms total=${timings.totalMs}ms`);
      return { ok: true, response: answer, model: modelChoice.model, mode: wantedMode, capturedAt: new Date(lastCamera.at).toISOString(), followUpSupported: true, timings };
    } catch (error) {
      timings.totalMs = Date.now() - startedAt;
      console.error(`[JARVIS camera] ${requestId} FAILED after ${timings.totalMs}ms: ${String(error.message).slice(0, 200)}`);
      return { ok: false, message: `Camera analysis failed: ${String(error.message).slice(0, 220)}`, timings };
    } finally { cameraBusy = false; }
  },

  async cameraFollowUp({ question = '' } = {}) {
    if (!settings.enabled) return { ok: false, message: 'Screen analysis is disabled.' };
    if (lastCamera && Date.now() - lastCamera.at > followUpWindowMs) lastCamera = null;
    const asked = String(question || '').trim().slice(0, 800);
    if (!lastCamera) return { ok: false, stale: true, message: 'I do not have a fresh camera view to answer from. Say "Jarvis, what is this?" and I will take a new frame.' };
    if (cameraBusy) return { ok: false, message: 'I am still analyzing a frame. One moment, Sir.' };
    cameraBusy = true;
    try {
      const prompt = [
        'This is a follow-up question about a frame captured from the user\'s webcam a moment ago. The real scene may have changed; answer about THIS frame.',
        `User follow-up: ${asked || 'Tell me more about what is in this frame.'}`
      ].join(' ');
      const answer = await analyzeImage({ question: prompt, imageB64: lastCamera.imageB64, model: lastCamera.model, targetHint: { source: 'webcam frame (follow-up)' } });
      lastCamera.answer = answer; lastCamera.at = Date.now(); // fresh bounded context
      return { ok: true, response: answer, model: lastCamera.model, followUp: true, capturedAt: new Date(lastCamera.at).toISOString() };
    } catch (error) {
      return { ok: false, message: `Follow-up analysis failed: ${String(error.message).slice(0, 220)}` };
    } finally { cameraBusy = false; }
  },

  async cameraSaveFrame({ imageB64 } = {}) {
    const check = validateCameraImage(imageB64);
    if (!check.ok) return check;
    const dir = path.join(resolveScreenshotDir(), 'Camera');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (error) { return { ok: false, message: `Could not create the camera-captures folder: ${String(error.message).slice(0, 160)}` }; }
    const existing = new Set(fs.readdirSync(dir).map(n => n.toLowerCase()));
    const name = screenshotFileName(Date.now(), 'camera', existing);
    let buffer;
    try { buffer = Buffer.from(String(check.imageB64), 'base64'); } catch { return { ok: false, message: 'That frame was unreadable.' }; }
    const file = path.join(dir, name);
    try { fs.writeFileSync(file, buffer, { flag: 'wx' }); } catch (error) { return { ok: false, message: `Could not save the frame: ${String(error.message).slice(0, 160)}` }; }
    return { ok: true, name, path: file, sizeKB: Math.round(buffer.length / 1024), message: `Frame saved as ${path.join(dir, name)}` };
  },

  // exported for tests
    _internal: { pickVisionModel, buildVisionRequestBody, screenshotFileName, normalizeTarget, expandHomeJars, resolveScreenshotByName, validateCameraImage, CAMERA_MODES, isTextFocusedQuery, extractStructuredResponse: typeof extractStructuredResponse !== 'undefined' ? extractStructuredResponse : undefined }
  };
}

module.exports = { createScreenVision, pickVisionModel, buildVisionRequestBody, screenshotFileName, normalizeTarget, expandHomeJars, validateCameraImage, CAMERA_MODES, FOLLOW_UP_WINDOW_MS_DEFAULT, isTextFocusedQuery };
