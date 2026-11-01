#Requires -Version 5.1
# Send-To-Discord.ps1
# Zip this share folder and send it through a Discord webhook.
# The webhook URL is NEVER stored in a file. You paste it each time,
# or set it for this session only:  $env:JARVIS_SHARE_WEBHOOK_URL = "..."

$ErrorActionPreference = "Stop"

# 1. Get the webhook URL (paste it, don't save it in code)
$Webhook = $env:JARVIS_SHARE_WEBHOOK_URL
if ([string]::IsNullOrWhiteSpace($Webhook)) {
  $Webhook = Read-Host "Paste your Discord webhook URL (input hidden, nothing is saved)"
}
if ([string]::IsNullOrWhiteSpace($Webhook) -or $Webhook -notlike "https://discord.com/api/webhooks/*") {
  Write-Output "Cancelled: that does not look like a Discord webhook URL."
  exit 1
}

# 2. Zip this folder (script runs from inside jarvis-share)
$ShareDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ZipPath = Join-Path $env:TEMP "jarvis-share.zip"
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path (Join-Path $ShareDir "*") -DestinationPath $ZipPath -Force
$SizeMB = [math]::Round((Get-Item $ZipPath).Length / 1MB, 2)
Write-Output ("Zipped: {0} ({1} MB)" -f $ZipPath, $SizeMB)

# 3. Safety check: the zip must not contain your real .env
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
$Names = @($Zip.Entries | Select-Object -ExpandProperty FullName)
$Zip.Dispose()
$Bad = @($Names | Where-Object { $_ -eq ".env" -or $_ -like "offline-asr/models/*" -or $_ -like "*.bin" })
if ($Bad.Count -gt 0) {
  Write-Output "STOPPED: zip contains private files, not sending:"
  $Bad | ForEach-Object { Write-Output ("  " + $_) }
  exit 1
}
Write-Output "Safety check passed: no .env or model binaries in the zip."

# 4. Send it
curl.exe -F ("file=@""" + $ZipPath + """") -F "content=JARVIS share package (see README-TH.md / README.md inside)" $Webhook
Write-Output ""
Write-Output "Done. If Discord shows the upload, your friend can unzip it and follow README-TH.md."
