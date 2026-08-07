param(
    [string]$Owner = 'kevin',
    [switch]$AllOwners,
    [switch]$SkipPull,
    [switch]$SkipProfile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Monthly Spotify taste refresh + deep profile rebuild.
# Default: kevin. Use -AllOwners to pull/profile every owner with a taste file.
# Logs to ~/.longterm/logs/monthly-spotify-profile.log

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:USERPROFILE '.longterm\logs'
$logPath = Join-Path $logDir 'monthly-spotify-profile.log'
$tasteDir = Join-Path $repoRoot 'data\spotify'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCmd) { throw 'Node.js not found on PATH' }
$nodeExe = $nodeCmd.Source

function Write-ProfileLog {
    param([string]$Message)
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    Add-Content -LiteralPath $logPath -Value $line
}

function Get-OwnerIds {
    if ($AllOwners) {
        $ids = @()
        if (Test-Path -LiteralPath $tasteDir) {
            Get-ChildItem -LiteralPath $tasteDir -Filter '*-taste.json' | ForEach-Object {
                if ($_.BaseName -match '^(.*)-taste$') { $ids += $Matches[1] }
            }
        }
        if ($ids.Count -eq 0) { return @('kevin') }
        return $ids
    }
    return @($Owner)
}

function Invoke-NodeScript {
    param(
        [string]$RelPath,
        [string[]]$ScriptArgs
    )
    $scriptPath = Join-Path $repoRoot $RelPath
    if (-not (Test-Path -LiteralPath $scriptPath)) {
        throw "Missing $scriptPath"
    }
    Write-ProfileLog ("Starting node {0} {1}" -f $RelPath, ($ScriptArgs -join ' '))
    Push-Location $repoRoot
    try {
        & $nodeExe $scriptPath @ScriptArgs
        if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
            throw ("{0} exited with code {1}" -f $RelPath, $LASTEXITCODE)
        }
        Write-ProfileLog ("OK {0}" -f $RelPath)
    } finally {
        Pop-Location
    }
}

Write-ProfileLog '=== Longterm monthly Spotify profile begin ==='
try {
    $owners = Get-OwnerIds
    Write-ProfileLog ('Owners: {0}' -f ($owners -join ', '))
    foreach ($id in $owners) {
        if (-not $SkipPull) {
            Invoke-NodeScript 'scripts/spotify-pull.mjs' @('--owner', $id)
        }
        if (-not $SkipProfile) {
            Invoke-NodeScript 'scripts/spotify-taste-profile.mjs' @('--owner', $id)
        }
    }
    Write-ProfileLog '=== Longterm monthly Spotify profile success ==='
} catch {
    Write-ProfileLog ('=== Longterm monthly Spotify profile FAILED: {0} ===' -f $_.Exception.Message)
    exit 1
}
