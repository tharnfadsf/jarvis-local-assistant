$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ErrorView = 'CategoryView'

trap {
    Write-Error "Fatal: $_"
    exit 1
}

function Resolve-Cwd {
    if ($PSScriptRoot) { return $PSScriptRoot }
    $h = Get-Item -Path '.'
    if ($null -ne $h) { if ($h.PSIsContainer) { return $h.FullName } }
    $c = Get-Location
    if ($null -ne $c) { return $c.Path }
    throw 'Cannot resolve current directory.'
}

$cwd = (Resolve-Cwd).TrimEnd('\')
$testPattern = if ($args.Count -gt 0) { $args[0] } else { '*.test.js' }
$root = $cwd
Write-Host "root=$root pattern=$testPattern"

$testFiles = Get-ChildItem -Path $root -Filter $testPattern -File -Recurse |
    Where-Object { $_.FullName -notmatch '\\\\node_modules\\\\' } |
    Sort-Object Name |
    ForEach-Object { $_.FullName }

if ($testFiles.Count -eq 0) {
    Write-Error "No test files matched: $testPattern"
    exit 1
}

Write-Host "files=`"$($testFiles.Count)`" "

$child = Start-Process -FilePath 'node' `
    -ArgumentList '--test', ($testFiles -join ' '), '--test-reporter=./jest-reporter.js' `
    -NoNewWindow -PassThru -Wait -RedirectStandardError "$root\node-stderr.tmp" `
    -WorkingDirectory $root -ErrorAction Stop

$p = if ($child -and $child.HasExited) { $child.ExitCode } else { -2 }
if (Test-Path "$root\node-stderr.tmp") {
    Get-Content "$root\node-stderr.tmp" | ForEach-Object { Write-Host $_ }
    Remove-Item "$root\node-stderr.tmp" -Force -ErrorAction SilentlyContinue
}
exit $p
