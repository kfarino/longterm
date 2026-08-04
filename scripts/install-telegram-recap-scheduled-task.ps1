param(
    [string]$TaskName = 'LongtermTelegramRecap',
    [string]$At = '09:00',
    [switch]$Uninstall,
    [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Sibling to install-telegram-scheduled-task.ps1 (the 2-minute interactive
# poller) but a separate task on a totally different schedule — Sunday and
# Thursday mornings only, running telegram-bot-recap.mjs instead of the
# poller. Two weekly triggers on the same task, not two tasks, since it's one
# script either way.

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$TaskName' (if it existed)."
    exit 0
}

function Resolve-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        throw 'Node.js is required to run the Telegram recap script.'
    }
    return $node.Source
}

$scriptPath = Join-Path $PSScriptRoot 'telegram-bot-recap.mjs'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing script at $scriptPath"
}

$nodeExe = Resolve-Node
$taskArgs = ('"{0}"' -f $scriptPath)
$atTime = [datetime]::ParseExact($At, 'HH:mm', $null)

if ($WhatIf) {
    Write-Host ('Would create scheduled task "{0}" running Sun+Thu at {1}' -f $TaskName, $At)
    Write-Host ('Task command: {0} {1}' -f $nodeExe, $taskArgs)
    exit 0
}

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument $taskArgs
$trigger = @(
    New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At $atTime
    New-ScheduledTaskTrigger -Weekly -DaysOfWeek Thursday -At $atTime
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Sends a dynamically-composed weekly recap to the Longterm Telegram group, Sun+Thu mornings.' -Force | Out-Host

Write-Host ("Registered scheduled task '{0}' (Sun+Thu at {1})." -f $TaskName, $At)
