param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$Id,
  [Parameter(Mandatory=$true)][ValidateSet('alarm','reminder','event')][string]$Kind,
  [Parameter(Mandatory=$true)][int]$Port,
  [string]$Repeat='none'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System
[System.Windows.Forms.Application]::EnableVisualStyles()

function Show-Notice {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = if ($Kind -eq 'alarm') { 'JARVIS Alarm' } else { 'JARVIS Reminder' }
  $form.StartPosition = 'CenterScreen'
  $form.TopMost = $true
  $form.Size = New-Object System.Drawing.Size(430,190)
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.BackColor = [System.Drawing.Color]::FromArgb(7,22,34)
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Title
  $label.ForeColor = [System.Drawing.Color]::FromArgb(190,242,255)
  $label.Font = New-Object System.Drawing.Font('Segoe UI',14,[System.Drawing.FontStyle]::Regular)
  $label.Location = New-Object System.Drawing.Point(20,22)
  $label.Size = New-Object System.Drawing.Size(370,62)
  $form.Controls.Add($label)
  $snooze = New-Object System.Windows.Forms.Button
  $snooze.Text = 'Snooze 10 minutes'
  $snooze.Location = New-Object System.Drawing.Point(35,105)
  $snooze.Size = New-Object System.Drawing.Size(170,34)
  $snooze.Add_Click({
    try {
      $body = @{action='snooze-alarm';id=$Id} | ConvertTo-Json -Compress
      $result = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/planner" -ContentType 'application/json' -Body $body -TimeoutSec 5
      if ($result.ok) { $form.Tag = 'dismiss'; $form.Close() } else { [void][System.Windows.Forms.MessageBox]::Show([string]$result.message,'JARVIS') }
    } catch { [void][System.Windows.Forms.MessageBox]::Show('JARVIS could not schedule a snooze. Please dismiss this alarm and set a new one.','JARVIS') }
  })
  $form.Controls.Add($snooze)
  $dismiss = New-Object System.Windows.Forms.Button
  $dismiss.Text = 'Dismiss'
  $dismiss.Location = New-Object System.Drawing.Point(220,105)
  $dismiss.Size = New-Object System.Drawing.Size(150,34)
  $dismiss.Add_Click({ $form.Tag = 'dismiss'; $form.Close() })
  $form.Controls.Add($dismiss)
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 1300
  $timer.Add_Tick({
    [System.Media.SystemSounds]::Exclamation.Play()
    try {
      $control = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/planner/alarm-command?id=$Id" -TimeoutSec 1
      if ($control.command -in @('snooze','dismiss')) { $form.Tag = [string]$control.command; $form.Close() }
    } catch {}
  })
  $timer.Start()
  [System.Media.SystemSounds]::Exclamation.Play()
  [void]$form.ShowDialog()
  $timer.Stop(); $timer.Dispose()
  return [string]$form.Tag
}

if ($Kind -eq 'alarm') { try { $body = @{action='alarm-trigger';id=$Id}|ConvertTo-Json -Compress; Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/planner" -ContentType 'application/json' -Body $body -TimeoutSec 2 | Out-Null } catch {} }
$choice = Show-Notice

try {
  $plannerAction = if ($Kind -eq 'alarm') { 'dismiss-alarm' } else { 'dismiss-reminder' }
  $body = @{ action = $plannerAction; id = $Id } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/planner" -ContentType 'application/json' -Body $body -TimeoutSec 3 | Out-Null
} catch {}
if (($Kind -eq 'alarm' -and $Repeat -eq 'none') -or $Kind -ne 'alarm') {
  Unregister-ScheduledTask -TaskName "JARVIS-$Kind-$Id" -Confirm:$false -ErrorAction SilentlyContinue
}
