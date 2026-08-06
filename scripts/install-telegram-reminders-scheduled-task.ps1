param(
    [string]$TaskName = 'LongtermTelegramReminders',
    [string]$At = '08:00',
    [switch]$Uninstall,
    [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Sibling to install-telegram-recap-scheduled-task.ps1, but a single daily
# trigger instead of two weekly ones -- reminders are day-level, checked once
# each morning, not tied to a Sun/Thu cadence.

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$TaskName' (if it existed)."
    exit 0
}

function Resolve-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        throw 'Node.js is required to run the Telegram reminders script.'
    }
    return $node.Source
}

$scriptPath = Join-Path $PSScriptRoot 'telegram-bot-reminders.mjs'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing script at $scriptPath"
}

$nodeExe = Resolve-Node
$taskArgs = ('"{0}"' -f $scriptPath)
$atTime = [datetime]::ParseExact($At, 'HH:mm', $null)

if ($WhatIf) {
    Write-Host ('Would create scheduled task "{0}" running daily at {1}' -f $TaskName, $At)
    Write-Host ('Task command: {0} {1}' -f $nodeExe, $taskArgs)
    exit 0
}

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument $taskArgs
$trigger = New-ScheduledTaskTrigger -Daily -At $atTime
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Sends any due one-off reminders as one grouped Telegram message, daily.' -Force | Out-Host

Write-Host ("Registered scheduled task '{0}' (daily at {1})." -f $TaskName, $At)
