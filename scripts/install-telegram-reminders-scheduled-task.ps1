param(
    [string]$TaskName = 'LongtermTelegramReminders',
    [string]$At = '08:00',
    [int]$IntervalMinutes = 5,
    [switch]$Uninstall,
    [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Sibling to install-telegram-recap-scheduled-task.ps1, but a short repeating
# trigger instead of weekly ones.
#
# This used to be a single daily trigger at 08:00, which was correct while
# reminders were day-level only. Reminders can now carry a time of day
# (2026-08-28), and a job that runs once a morning cannot deliver a 6am
# reminder at 6am -- it would fire at 8am while the bot's confirmation said
# 6:00am. So the task ticks every few minutes and telegram-bot-reminders.mjs
# decides what is actually due; a tick with nothing due exits immediately
# without touching Telegram.
#
# -At keeps its meaning for reminders with NO time of their own: it is passed
# through as --default-time, so a day-level reminder still goes out as one
# morning nudge rather than at whatever minute the machine first woke up.

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

if ($IntervalMinutes -lt 1) {
    throw 'IntervalMinutes must be at least 1.'
}

$nodeExe = Resolve-Node
# Validated the same way the old daily trigger validated it, even though the
# value is now passed to the script rather than used as the trigger time.
$atTime = [datetime]::ParseExact($At, 'HH:mm', $null)
$defaultTime = $atTime.ToString('HH:mm')
$taskArgs = ('"{0}" --default-time {1}' -f $scriptPath, $defaultTime)

if ($WhatIf) {
    Write-Host ('Would create scheduled task "{0}" running every {1} minute(s); day-level reminders go out at {2}' -f $TaskName, $IntervalMinutes, $defaultTime)
    Write-Host ('Task command: {0} {1}' -f $nodeExe, $taskArgs)
    exit 0
}

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument $taskArgs
# Start from today's midnight so the repetition covers the whole day, and give
# it a long duration rather than a day -- a one-day duration silently stops
# repeating after 24h if the machine never re-triggers the start.
$startAt = (Get-Date).Date
$trigger = New-ScheduledTaskTrigger -Once -At $startAt `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Sends any due one-off reminders (day-level or at their own time of day) as one grouped Telegram message.' -Force | Out-Host

Write-Host ("Registered scheduled task '{0}' (every {1} minute(s); day-level reminders at {2})." -f $TaskName, $IntervalMinutes, $defaultTime)
