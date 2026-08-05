param(
    [switch]$DryRun,
    [int]$MaxAttempts = 3,
    [int]$RetryDelaySeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Runs both Monarch pulls back-to-back. Retries on transient network/API
# failures and appends a log under ~/.longterm/logs so a Scheduled Task
# failure is diagnosable without Task Scheduler history.

$networthScript = Join-Path $PSScriptRoot 'networth-pull.ps1'
$budgetScript = Join-Path $PSScriptRoot 'budget-tracking-pull.ps1'
$logDir = Join-Path $env:USERPROFILE '.longterm\logs'
$logPath = Join-Path $logDir 'daily-pull.log'

function Write-PullLog {
    param([string]$Message)
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    Add-Content -LiteralPath $logPath -Value $line
}

function Invoke-DailyPullStep {
    param(
        [string]$Name,
        [string]$ScriptPath
    )

    if (-not (Test-Path -LiteralPath $ScriptPath)) {
        throw "Missing script for '$Name' at $ScriptPath"
    }

    $attempt = 0
    while ($true) {
        $attempt += 1
        Write-PullLog ("Starting {0} (attempt {1}/{2})" -f $Name, $attempt, $MaxAttempts)
        try {
            $args = @()
            if ($DryRun) { $args += '-DryRun' }
            & $ScriptPath @args
            if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
                throw ("{0} exited with code {1}" -f $Name, $LASTEXITCODE)
            }
            Write-PullLog ("OK {0}" -f $Name)
            return
        } catch {
            Write-PullLog ("FAIL {0}: {1}" -f $Name, $_.Exception.Message)
            if ($attempt -ge $MaxAttempts) { throw }
            Write-PullLog ("Retrying in {0}s..." -f $RetryDelaySeconds)
            Start-Sleep -Seconds $RetryDelaySeconds
        }
    }
}

Write-PullLog '=== Longterm daily pull begin ==='
try {
    Invoke-DailyPullStep -Name 'net worth pull' -ScriptPath $networthScript
    Invoke-DailyPullStep -Name 'budget tracking pull' -ScriptPath $budgetScript
    Write-PullLog '=== Longterm daily pull success ==='
} catch {
    Write-PullLog ('=== Longterm daily pull FAILED: {0} ===' -f $_.Exception.Message)
    exit 1
}
