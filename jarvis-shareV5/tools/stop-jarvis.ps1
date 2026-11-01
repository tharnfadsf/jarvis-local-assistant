# Stop the JARVIS host that owns THIS folder, plus its node bridge.
#
# Why this exists: JARVIS.exe takes a single-instance mutex. Starting it while
# an older copy is still running just exits, leaving the OLD node server (and
# its OLD app.js) serving the window — so a "restart" silently changes nothing.
# Start-Jarvis.bat calls this first so a relaunch always loads the current code.
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'JARVIS.exe'
$portFile = Join-Path $env:LOCALAPPDATA 'JARVIS\bridge-port.txt'
$stopped = @()

$hosts = @(Get-CimInstance Win32_Process -Filter "Name='JARVIS.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Trim() -ieq $exe })

foreach ($h in $hosts) {
  $children = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ParentProcessId -eq $h.ProcessId -and $_.Name -in @('node.exe', 'powershell.exe') })
  foreach ($c in $children) {
    try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop; $stopped += "bridge $($c.ProcessId)" } catch { }
  }
  try {
    Stop-Process -Id $h.ProcessId -Force -ErrorAction Stop
    $stopped += "host $($h.ProcessId)"
  } catch {
    Write-Output "Could not stop JARVIS host $($h.ProcessId): $($_.Exception.Message)"
  }
}

# The bridge exits when its parent host dies, but give it a moment and then
# clear anything still holding the recorded bridge port (that port is the
# bridge by definition, so this can never hit an unrelated server).
Start-Sleep -Milliseconds 1500
if (Test-Path $portFile) {
  $port = (Get-Content $portFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
  if ($port -match '^\d{2,5}$') {
    foreach ($conn in @(Get-NetTCPConnection -State Listen -LocalPort ([int]$port) -ErrorAction SilentlyContinue)) {
      if ($conn.OwningProcess -and $conn.OwningProcess -ne $PID) {
        try { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop; $stopped += "bridge on port $port ($($conn.OwningProcess))" } catch { }
      }
    }
  }
}

if ($stopped.Count) { Write-Output ("Stopped previous JARVIS: " + ($stopped -join ', ') + ".") }
else { Write-Output 'No running JARVIS instance found for this folder.' }
