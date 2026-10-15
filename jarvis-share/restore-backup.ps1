#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Restore JARVIS source files from the local broken-freeze backup directory.

.DESCRIPTION
    Only use this script if current source files are missing or you want to
    roll back to the _broken_backup_20261012T190938 snapshot.

    The backup was created from:
        C:\Users\flowi\Documents\Codex\2026-10-11\i-w\outputs\jarvis

    This script does NOT touch git and does NOT copy any .env file. It only
    restores ordinary source files from the local backup tree.

    Usage:
        .\restore-backup.ps1                              # restore everything below
        .\restore-backup.ps1 -RestoreList server.js app.js screen-vision.js

.PARAMETER RestoreList
    Optional list of file names (relative to project root) to restore. If
    omitted, restores every file known to exist in the backup.
#>
[CmdletBinding()]
param(
    [string[]]
    $RestoreList = @(
        'server.js',
        'app.js',
        'jarvis-core.js',
        'screen-vision.js',
        'situation.js',
        'music-orb.js',
        'media-monitor.js',
        'discord.js',
        'mail.js',
        'computer-tools.js',
        'browser-tabs.js',
        'youtube-discovery.js',
        'system-monitor.js',
        'Create-WinAppRuntime.ps1',
        'Configure-Fish-Voice.ps1',
        'Start-Jarvis.bat',
        'manifest.json',
        'package.json',
        'test-chat.js',
        'tests/jest-reporter.js',
        'tests/media-monitor.test.js',
        'tests/music-orb-audio.test.js',
        'tests/screen-vision-snapshot.test.js',
        'tests/run-tests.ps1',
        'tests/run-tests.cmd',
        'alarm.ps1',
        'jarvis-audio-loopback.ps1',
        'jarvis-media-sessions.ps1',
        'planner-data.json',
        'README.txt',
        'debug-app6.js',
        'debug-app.js'
    )
)

$ErrorActionPreference = 'Stop'

# The backup lives alongside the project root inside the same tree.
$backupName = '_broken_backup_20261012T190938'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backupRoot = Join-Path $projectRoot $backupName

Write-Host "Project root : $projectRoot" -ForegroundColor Cyan
Write-Host "Backup root  : $backupRoot" -ForegroundColor Cyan
Write-Host "Restore list : $($RestoreList.Count) file(s)" -ForegroundColor Cyan

foreach ($name in $RestoreList) {
    $src = Join-Path $backupRoot $name
    $dst = Join-Path $projectRoot $name

    Write-Host "[RESTORE] $name" -NoNewline

    if (-not (Test-Path $src)) {
        Write-Warning " no such file in backup -> skipping '$name'."
        continue
    }

    $parent = Split-Path $dst -Parent
    if ($parent -and $parent -ne '.' -and $parent -ne $projectRoot) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    Copy-Item -Path $src -Destination $dst -Force
    Write-Host " restored from $backupName" -ForegroundColor DarkGreen
}

Write-Host "`nRestore complete."
