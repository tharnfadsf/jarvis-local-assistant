$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $projectDir '.env'
$examplePath = Join-Path $projectDir '.env.example'

if (-not (Test-Path -LiteralPath $envPath)) {
    Copy-Item -LiteralPath $examplePath -Destination $envPath
}

$secureKey = Read-Host 'Enter your NEW Fish Audio API key (input is hidden)' -AsSecureString
$keyPointer = [IntPtr]::Zero
try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    if ([string]::IsNullOrWhiteSpace($apiKey) -or -not $apiKey.StartsWith('sk-fish-')) {
        throw 'That does not look like a Fish Audio API key. No configuration was changed.'
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in [System.IO.File]::ReadAllLines($envPath)) {
        if ($line -match '^\s*FISH_API_KEY=') { $lines.Add('FISH_API_KEY=' + $apiKey) }
        else { $lines.Add($line) }
    }
    if (-not ($lines | Where-Object { $_ -match '^FISH_API_KEY=' })) { $lines.Insert(0, 'FISH_API_KEY=' + $apiKey) }
    [System.IO.File]::WriteAllText($envPath, ($lines -join "`r`n") + "`r`n", [System.Text.UTF8Encoding]::new($false))
    Write-Host 'Fish Audio key saved to the local .env file. The key was not displayed.' -ForegroundColor Green
    Write-Host 'Refresh JARVIS to check the selected Fish voice.'
}
finally {
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    if ($secureKey) { $secureKey.Dispose() }
    Remove-Variable apiKey -ErrorAction SilentlyContinue
}
