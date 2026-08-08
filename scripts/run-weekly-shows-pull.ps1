param(
    [switch]$SkipFindShows,
    [switch]$SkipVenuePull,
    [switch]$SkipLiveNation,
    [switch]$SkipMatch,
    [switch]$SkipShowNotify
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
    # Isolated the same way the spotify:notify-shows step below already is:
    # a missing Ticketmaster API key (expected until Kevin registers one) or
    # an API outage must never fail spotify:find-shows/shows:pull, which
    # already ran successfully, or block spotify:match from running on
    # whatever the cache already has.
    if (-not $SkipLiveNation) {
        try {
            Invoke-NpmScript 'livenation:pull'
        } catch {
            Write-ShowsLog ('WARN livenation:pull failed (continuing): {0}' -f $_.Exception.Message)
        }
    }
    if (-not $SkipMatch) { Invoke-NpmScript 'spotify:match' }
    # Isolated from the three steps above, same containment rule
    # run-daily-pull.ps1 already uses for its own Oura step: resolving
    # artists to Spotify links and sending the Telegram message is a
    # nice-to-have that must never mark the whole weekly pull as failed —
    # that failure belongs to this step alone, not to
    # spotify:find-shows/shows:pull/spotify:match, which the dashboard
    # already depends on and which succeed independently of it. (This step
    # replaced the auto-playlist step on 2026-08-08 — see claude.md and
    # docs/superpowers/specs/2026-08-08-spotify-shows-telegram-design.md.)
    if (-not $SkipShowNotify) {
        try {
            Invoke-NpmScript 'spotify:notify-shows'
        } catch {
            Write-ShowsLog ('WARN spotify:notify-shows failed (continuing): {0}' -f $_.Exception.Message)
        }
    }
    Write-ShowsLog '=== Longterm weekly shows pull success ==='
} catch {
    Write-ShowsLog ('=== Longterm weekly shows pull FAILED: {0} ===' -f $_.Exception.Message)
    exit 1
}
