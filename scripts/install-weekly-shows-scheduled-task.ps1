param(
    [string]$TaskName = 'LongtermWeeklyShowsPull',
    [string]$At = '10:00',
    [ValidateSet('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')]
    [string]$DayOfWeek = 'Sunday',
    [switch]$Uninstall,
    [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Weekly venue + Spotify show research + likeness rematch.
# Default: Sunday 10:00 (after Telegram recap at 09:00).

function Quote-TaskArg {
    param([string]$Value)
    return ('"{0}"' -f ($Value -replace '"', '""'))
}

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$TaskName' (if it existed)."
    exit 0
}

if ($At -notmatch '^\d{2}:\d{2}$') {
    throw 'At must use HH:mm 24-hour format, for example 10:00.'
}

$scriptPath = Join-Path $PSScriptRoot 'run-weekly-shows-pull.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing script at $scriptPath"
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskArgs = ('-NoProfile -ExecutionPolicy Bypass -File {0}' -f (Quote-TaskArg $scriptPath))
$atTime = [datetime]::ParseExact($At, 'HH:mm', $null)

if ($WhatIf) {
    Write-Host ('Would create weekly scheduled task "{0}" on {1} at {2}' -f $TaskName, $DayOfWeek, $At)
    Write-Host ('Task command: {0} {1}' -f $powershell, $taskArgs)
    Write-Host ('WorkingDirectory: {0}' -f $PSScriptRoot)
    exit 0
}

$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At $atTime
$action = New-ScheduledTaskAction -Execute $powershell -Argument $taskArgs -WorkingDirectory $PSScriptRoot
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -WakeToRun `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RunOnlyIfNetworkAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Weekly Longterm shows refresh (spotify:find-shows + shows:pull + spotify:match). Log: %USERPROFILE%\.longterm\logs\weekly-shows.log' `
    -Force | Out-Host

Write-Host ("Registered scheduled task '{0}' ({1} at {2})." -f $TaskName, $DayOfWeek, $At)
Write-Host 'Log: %USERPROFILE%\.longterm\logs\weekly-shows.log'
