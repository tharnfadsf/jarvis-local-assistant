# Run as Administrator: right-click > Run with PowerShell as Admin
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) { Write-Error "Right-click > Run as Administrator"; pause; exit 1 }

powercfg /h off
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power" -Name "HiberbootEnabled" -Value 0 -Force
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl" -Name "CrashDumpEnabled" -Value 3 -Force
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl" -Name "AutoReboot" -Value 0 -Force
New-Item -Path C:\Windows\Minidump -ItemType Directory -Force | Out-Null

sfc /scannow
DISM /Online /Cleanup-Image /RestoreHealth
chkdsk C: /scan
pnputil /scan-devices

Write-Host "Done. Now: Device Manager > Storage controllers > Intel SATA > Update driver > Search automatically, same for Realtek LAN. Reboot."
pause
