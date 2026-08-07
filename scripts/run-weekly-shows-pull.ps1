param(
    [switch]$SkipFindShows,
    [switch]$SkipVenuePull,
    [switch]$SkipMatch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Weekly shows refresh: Spotify artist dates + venue calendars + likeness rematch.
# Logs to ~/.longterm/logs/weekly-shows.log

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:USERPROFILE '.longterm\logs'
$logPath = Join-Path $logDir 'weekly-shows.log'
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
if ($null -eq $npmCmd) { throw 'npm not found on PATH' }

function Write-ShowsLog {
    param([string]$Message)
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    Add-Content -LiteralPath $logPath -Value $line
}

function Invoke-NpmScript {
    param([string]$ScriptName)
    Write-ShowsLog ("Starting npm run {0}" -f $ScriptName)
    Push-Location $repoRoot
    try {
        & $npmCmd.Source run $ScriptName
        if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
            throw ("npm run {0} exited with code {1}" -f $ScriptName, $LASTEXITCODE)
        }
        Write-ShowsLog ("OK npm run {0}" -f $ScriptName)
    } finally {
        Pop-Location
    }
}

Write-ShowsLog '=== Longterm weekly shows pull begin ==='
try {
    if (-not $SkipFindShows) { Invoke-NpmScript 'spotify:find-shows' }
    if (-not $SkipVenuePull) { Invoke-NpmScript 'shows:pull' }
    if (-not $SkipMatch) { Invoke-NpmScript 'spotify:match' }
    Write-ShowsLog '=== Longterm weekly shows pull success ==='
} catch {
    Write-ShowsLog ('=== Longterm weekly shows pull FAILED: {0} ===' -f $_.Exception.Message)
    exit 1
}
