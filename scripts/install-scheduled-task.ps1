param(
    [string]$TaskName = 'LongtermDailyPull',
    [string]$Time = '03:00',
    [switch]$Uninstall,
    [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Quote-TaskArg {
    param([string]$Value)
    return ('"{0}"' -f ($Value -replace '"', '""'))
}

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$TaskName' (if it existed)."
    exit 0
}

if ($Time -notmatch '^\d{2}:\d{2}$') {
    throw 'Time must use HH:mm 24-hour format, for example 03:00.'
}

$scriptPath = Join-Path $PSScriptRoot 'run-daily-pull.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing script at $scriptPath"
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskArgs = ('-NoProfile -ExecutionPolicy Bypass -File {0}' -f (Quote-TaskArg $scriptPath))
$taskRun = ('{0} {1}' -f (Quote-TaskArg $powershell), $taskArgs)

if ($WhatIf) {
    Write-Host ('Would create daily scheduled task "{0}" at {1}' -f $TaskName, $Time)
    Write-Host ('Task command: {0}' -f $taskRun)
    exit 0
}

$parts = $Time.Split(':')
$trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour ([int]$parts[0]) -Minute ([int]$parts[1]) -Second 0)
$action = New-ScheduledTaskAction -Execute $powershell -Argument $taskArgs
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Daily Monarch pull for the Longterm financial dashboard (net worth + budget tracking).' -Force | Out-Host
