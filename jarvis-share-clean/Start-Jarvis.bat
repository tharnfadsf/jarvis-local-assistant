@echo off
cd /d "%~dp0"
REM Replace any running copy: the single-instance mutex means a plain relaunch
REM keeps the previous server, serving stale app.js/server.js.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop-jarvis.ps1"
start "" "%~dp0JARVIS.exe"
