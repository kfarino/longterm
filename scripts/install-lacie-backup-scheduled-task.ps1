param(
    [string]$TaskName = 'LongtermLacieBackup',
    # Evening default — drive more likely plugged in after work.
    [string]$Time = '20:00',
    [switch]$Uninstall,
    [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Daily mirror of Documents\Longterm + nikola plus restore secrets
# (~/.longterm, ~/.monarch-mcp, ~/.ssh, ~/.scrooge) → Lacie\Projects.
# Finds the disk by volume label "LaCie" (not a fixed drive letter). If the
# drive is unplugged, run-lacie-backup.ps1 exits 0 and logs a skip.

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
    throw 'Time must use HH:mm 24-hour format, for example 20:00.'
}

$scriptPath = Join-Path $PSScriptRoot 'run-lacie-backup.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing script at $scriptPath"
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskArgs = ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File {0}' -f (Quote-TaskArg $scriptPath))
$taskRun = ('{0} {1}' -f (Quote-TaskArg $powershell), $taskArgs)

if ($WhatIf) {
    Write-Host ('Would create daily scheduled task "{0}" at {1}' -f $TaskName, $Time)
    Write-Host ('Task command: {0}' -f $taskRun)
    Write-Host ('WorkingDirectory: {0}' -f $PSScriptRoot)
    exit 0
}

$parts = $Time.Split(':')
$trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour ([int]$parts[0]) -Minute ([int]$parts[1]) -Second 0)
$action = New-ScheduledTaskAction -Execute $powershell -Argument $taskArgs -WorkingDirectory $PSScriptRoot
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
# No -RunOnlyIfNetworkAvailable — this is a local disk copy.
# No -WakeToRun — not worth waking the PC just for a USB mirror.

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Daily robocopy for full Longterm restore: Documents\Longterm + nikola + ~/.longterm + ~/.monarch-mcp (+ .ssh/.scrooge). Skips if Lacie unplugged. Log: %USERPROFILE%\.longterm\logs\lacie-backup.log' `
    -Force | Out-Host

Write-Host ("Registered scheduled task '{0}' daily at {1}." -f $TaskName, $Time)
Write-Host ("WorkingDirectory: {0}" -f $PSScriptRoot)
Write-Host 'Log: %USERPROFILE%\.longterm\logs\lacie-backup.log'
Write-Host 'Manual run: powershell -File scripts\run-lacie-backup.ps1'
