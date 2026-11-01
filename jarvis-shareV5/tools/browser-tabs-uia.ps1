# Browser tab access for JARVIS through Windows UI Automation.
#
# Chrome and Edge refuse remote debugging on the user's normal profile, so CDP
# can only ever see the separate JARVIS-controlled window. The user's own
# browser tabs are still real tabs, and Chrome/Edge expose each one to UI
# Automation. This script is the read/close/activate bridge for those windows:
# it never starts a browser and never sends keystrokes, it invokes the tab's own
# Close button (or selects the tab) and then reports what actually changed.
param(
  [Parameter(Mandatory = $true)][string]$RequestFile,
  [Parameter(Mandatory = $true)][string]$ResultFile
)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -Name JarvisUia -Namespace Jarvis -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'
} catch {
  [System.IO.File]::WriteAllText($ResultFile, '{"ok":false,"error":"UIA unavailable"}', (New-Object System.Text.UTF8Encoding($false)))
  exit 0
}

$req = $null
try { $req = Get-Content -Raw -Encoding UTF8 $RequestFile | ConvertFrom-Json } catch { $req = $null }
$action = if ($req -and $req.action) { [string]$req.action } else { 'list' }

$BROWSERS = @('chrome', 'msedge', 'brave', 'vivaldi', 'opera', 'opera_gx', 'firefox', 'librewolf', 'thorium')
# Chrome appends live status to a tab's accessible name ("YouTube Music -
# Memory usage - 208 MB"). The page title is everything before that suffix.
$STATUS_SUFFIX = '\s+-\s+(?:Memory usage|Audio playing|Muted|Pinned|Capturing)\b.*$'

function Clean-TabTitle([string]$title) {
  $clean = [regex]::Replace([string]$title, $STATUS_SUFFIX, '')
  $clean = [regex]::Replace($clean, '\s+-\s+(?:Google Chrome|Microsoft Edge|Microsoft\u200b Edge|Brave|Vivaldi|Mozilla Firefox)\s*$', '')
  return $clean.Trim()
}

function Get-BrowserProcesses {
  $found = @()
  foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
    if ($p.MainWindowHandle -eq 0) { continue }
    if ($BROWSERS -notcontains $p.ProcessName.ToLower()) { continue }
    $found += $p
  }
  return $found
}

# The JARVIS-controlled window is driven over CDP; listing it here as well
# would show every tab twice.
function Test-ControlledProcess([int]$procId) {
  try {
    $row = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    if ($row -and $row.CommandLine -and $row.CommandLine -match '--remote-debugging-port') { return $true }
  } catch { }
  return $false
}

function Get-WindowElement([int]$procId) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$procId)
  return @($root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond))
}

function Get-TabItems($window) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
  return @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond))
}

function Describe-Window($window, [string]$processName) {
  $tabs = @()
  $items = @(Get-TabItems $window)
  for ($i = 0; $i -lt $items.Count; $i++) {
    $item = $items[$i]
    $selected = $false
    try {
      $pattern = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      if ($pattern) { $selected = [bool]$pattern.Current.IsSelected }
    } catch { }
    $tabs += [pscustomobject][ordered]@{
      index    = $i
      title    = (Clean-TabTitle $item.Current.Name)
      rawTitle = [string]$item.Current.Name
      selected = $selected
    }
  }
  return [pscustomobject][ordered]@{
    pid     = [int]$window.Current.ProcessId
    process = $processName
    title   = [string]$window.Current.Name
    tabs    = $tabs
  }
}

function Get-CloseButton($tabItem) {
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $child = $walker.GetFirstChild($tabItem)
  while ($child) {
    try {
      if ($child.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $child.Current.Name -match '^Close') { return $child }
    } catch { }
    $child = $walker.GetNextSibling($child)
  }
  return $null
}

$result = [ordered]@{ ok = $false; closed = @(); failed = @(); activated = @(); windows = @(); error = '' }
try {
  $processes = @(Get-BrowserProcesses)
  $wantedPid = if ($req -and $req.pid) { [int]$req.pid } else { 0 }
  $wantedNames = @()
  if ($req -and $req.names) { $wantedNames = @($req.names | ForEach-Object { [string]$_ }) }

  foreach ($proc in $processes) {
    if (Test-ControlledProcess $proc.Id) { continue }
    foreach ($window in (Get-WindowElement $proc.Id)) {
      try {
        if (-not $window.Current.Name) { continue }
        if ($window.Current.Name -match '^J\.A\.R\.V\.I\.S') { continue }
        $described = Describe-Window $window $proc.ProcessName
        if ($described.tabs.Count -eq 0) { continue }
        if ($action -eq 'list') { $result.windows += $described; continue }
        if ($wantedPid -ne 0 -and $wantedPid -ne $proc.Id) { continue }

        foreach ($name in $wantedNames) {
          $target = @($described.tabs | Where-Object { $_.rawTitle -eq $name }) | Select-Object -First 1
          if (-not $target) { $target = @($described.tabs | Where-Object { $_.title -eq (Clean-TabTitle $name) }) | Select-Object -First 1 }
          if (-not $target) { continue }
          $item = @(Get-TabItems $window)[$target.index]
          if ($action -eq 'activate') {
            try {
              $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
              # Selecting a tab in a background window is not switching to it:
              # bring that window forward too, then confirm the tab is selected.
              try { [void][Jarvis.JarvisUia]::SetForegroundWindow([IntPtr][long]$window.Current.NativeWindowHandle) } catch { }
              Start-Sleep -Milliseconds 220
              $check = @(Get-TabItems $window)[$target.index]
              $nowSelected = $false
              try { $nowSelected = [bool]$check.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } catch { }
              if ($nowSelected) { $result.activated += $target.title } else { $result.failed += $target.title }
            } catch { $result.failed += $target.title }
            continue
          }
          # Close: the tab's own Close button is exact and needs no keyboard
          # focus, so a mistyped name can never close the wrong tab.
          $closedThis = $false
          try {
            $button = Get-CloseButton $item
            if ($button) { $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $closedThis = $true }
          } catch { }
          if ($closedThis) { $result.closed += $target.title } else { $result.failed += $target.title }
          Start-Sleep -Milliseconds 220
          $described = Describe-Window $window $proc.ProcessName
          if ($described.tabs.Count -eq 0) { break }
        }
        if ($described.tabs.Count -gt 0) { $result.windows += $described }
      } catch { }
    }
  }

  # Verification: a name is only reported closed when it is no longer present
  # in the live window it belonged to.
  if ($action -eq 'close') {
    $still = @()
    foreach ($win in $result.windows) { foreach ($tab in $win.tabs) { $still += $tab.title } }
    $reallyClosed = @()
    foreach ($name in @($result.closed)) {
      $clean = Clean-TabTitle $name
      $left = @($still | Where-Object { $_ -eq $clean }).Count
      $claimed = @($result.closed | Where-Object { (Clean-TabTitle $_) -eq $clean }).Count
      if ($left -lt $claimed) { $reallyClosed += $name } else { $result.failed += $name }
    }
    $result.closed = $reallyClosed
  }
  $result.ok = ($result.failed.Count -eq 0)
} catch {
  $result.error = [string]$_.Exception.Message
}

$json = $result | ConvertTo-Json -Depth 8 -Compress
[System.IO.File]::WriteAllText($ResultFile, $json, (New-Object System.Text.UTF8Encoding($false)))
