param(
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Runs both Monarch pulls back-to-back. This project only has two daily jobs
# (net worth, budget tracking), so a single Scheduled Task running this
# script once a day is enough — no heartbeat/dispatcher needed.

$networthScript = Join-Path $PSScriptRoot 'networth-pull.ps1'
$budgetScript = Join-Path $PSScriptRoot 'budget-tracking-pull.ps1'

function Invoke-DailyPullStep {
    param(
        [string]$Name,
        [string]$ScriptPath
    )

    if (-not (Test-Path -LiteralPath $ScriptPath)) {
        throw "Missing script for '$Name' at $ScriptPath"
    }

    $args = @()
    if ($DryRun) { $args += '-DryRun' }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @args
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$Name failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
}

Invoke-DailyPullStep -Name 'net worth pull' -ScriptPath $networthScript
Invoke-DailyPullStep -Name 'budget tracking pull' -ScriptPath $budgetScript
