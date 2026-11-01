@echo off
cd /d "%~dp0"
start "" "https://fish.audio/app/api-keys"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Configure-Fish-Voice.ps1"
if errorlevel 1 pause
