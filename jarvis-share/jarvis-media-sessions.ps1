# JARVIS Windows media-session monitor + controller (GSMTC via WinRT).
#
# Stream mode (default): one JSON line per poll, forever.
#   S {"ok":true,"sessions":[{"appId":"chrome.exe","status":"Playing","title":"...","artist":"..."}]}
#   S {"ok":false,"message":"..."}                      when the API is unavailable
#
# Action mode: -Action play-pause|play|pause|next|previous|stop [-App <substring>]
#   R {"ok":true,"appId":"chrome.exe","status":"Paused","action":"play-pause"}
#   R {"ok":false,"message":"No media session is available."}
#
# This is what makes the media monitor independent of browser automation: GSMTC
# reports every app that registers a media session (Chrome, Edge, Spotify, media
# players), including apps JARVIS does not control.
#
# Note: PowerShell 5.1 has no AsTask overload for WinRT async calls, so every
# IAsyncOperation is awaited by polling its Status property instead.
param(
  [string]$Action = '',
  [string]$App = '',
  [int]$Interval = 2,
  [int]$Seconds = 0,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Write-Line([string]$text) {
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

function Await-Operation($operation, [int]$timeoutMs = 4000) {
  if ($null -eq $operation) { return $null }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($operation.Status -eq [Windows.Foundation.AsyncStatus]::Started -and $sw.ElapsedMilliseconds -lt $timeoutMs) {
    Start-Sleep -Milliseconds 15
  }
  if ($operation.Status -ne [Windows.Foundation.AsyncStatus]::Completed) { return $null }
  return $operation.GetResults()
}

function Get-SessionManager {
  $type = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $operation = $type::RequestAsync()
  return Await-Operation $operation
}

function Get-Sessions($manager) {
  $list = @()
  if ($null -eq $manager) { return $list }
  foreach ($session in $manager.GetSessions()) {
    $entry = [ordered]@{ appId = ''; status = 'Unknown'; title = ''; artist = '' }
    try { $entry.appId = [string]$session.SourceAppUserModelId } catch { }
    try {
      $info = $session.GetPlaybackInfo()
      if ($info) { $entry.status = [string]$info.PlaybackStatus }
    } catch { }
    try {
      $props = Await-Operation $session.TryGetMediaPropertiesAsync() 1500
      if ($props) {
        $entry.title = [string]$props.Title
        $entry.artist = [string]$props.Artist
      }
    } catch { }
    $list += [pscustomobject]$entry
  }
  return $list
}

function Select-Session($manager, [string]$preferred) {
  if ($null -eq $manager) { return $null }
  $sessions = @($manager.GetSessions())
  if ($preferred) {
    foreach ($session in $sessions) {
      if (([string]$session.SourceAppUserModelId) -like "*$preferred*") { return $session }
    }
  }
  foreach ($session in $sessions) {
    try { if ([string]$session.GetPlaybackInfo().PlaybackStatus -eq 'Playing') { return $session } } catch { }
  }
  if ($sessions.Count -gt 0) { return $sessions[0] }
  return $null
}

try {
  [void][Windows.Foundation.AsyncStatus]
  $manager = Get-SessionManager
}
catch {
  $message = $_.Exception.Message
  if ($Action) { Write-Line ("R " + (@{ ok = $false; message = "Windows media sessions are unavailable: $message" } | ConvertTo-Json -Compress)) }
  else { Write-Line ("S " + (@{ ok = $false; message = "Windows media sessions are unavailable: $message" } | ConvertTo-Json -Compress)) }
  exit 1
}

if ($Action) {
  $session = Select-Session $manager $App
  if ($null -eq $session) {
    Write-Line ("R " + (@{ ok = $false; message = 'No media session is available.' } | ConvertTo-Json -Compress))
    exit 0
  }
  $appId = [string]$session.SourceAppUserModelId
  $result = $null
  try {
    switch ($Action.ToLower()) {
      'play-pause' { $result = Await-Operation $session.TryTogglePlayPauseAsync() }
      'play' { $result = Await-Operation $session.TryPlayAsync() }
      'pause' { $result = Await-Operation $session.TryPauseAsync() }
      'next' { $result = Await-Operation $session.TrySkipNextAsync() }
      'previous' { $result = Await-Operation $session.TrySkipPreviousAsync() }
      'stop' { $result = Await-Operation $session.TryStopAsync() }
      default {
        Write-Line ("R " + (@{ ok = $false; message = "Unsupported media command: $Action" } | ConvertTo-Json -Compress))
        exit 0
      }
    }
  }
  catch {
    Write-Line ("R " + (@{ ok = $false; appId = $appId; message = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 0
  }
  $status = ''
  try { $status = [string]$session.GetPlaybackInfo().PlaybackStatus } catch { }
  $title = ''
  try { $title = [string](Await-Operation $session.TryGetMediaPropertiesAsync() 1500).Title } catch { }
  $payload = [ordered]@{ ok = [bool]$result; appId = $appId; action = $Action; status = $status; title = $title }
  if (-not $result) { $payload.message = "Windows did not accept the $Action command for $appId." }
  Write-Line ("R " + ($payload | ConvertTo-Json -Compress))
  exit 0
}

$started = Get-Date
while ($true) {
  if ($Seconds -gt 0 -and ((Get-Date) - $started).TotalSeconds -ge $Seconds) { break }
  $lines = @()
  try {
    $sessions = Get-Sessions $manager
    $playing = @($sessions | Where-Object { $_.status -eq 'Playing' })
    $payload = [ordered]@{
      ok = $true
      sessions = @($sessions)
      playing = @($playing)
      count = @($sessions).Count
    }
    $lines += ("S " + ($payload | ConvertTo-Json -Compress -Depth 5))
  }
  catch {
    $lines += ("S " + (@{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
  foreach ($line in $lines) { Write-Line $line }
  if ($Seconds -gt 0 -and ((Get-Date) - $started).TotalSeconds -ge $Seconds) { break }
  Start-Sleep -Milliseconds ([Math]::Max(250, $Interval * 1000))
}
