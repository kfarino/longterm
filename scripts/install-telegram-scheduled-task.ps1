param(
    [string]$TaskName = 'LongtermTelegramPoll',
    [int]$IntervalMinutes = 2,
    [switch]$Uninstall,
    [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Sibling to install-scheduled-task.ps1 (the Monarch daily-pull installer) —
# same registration pattern, but repeating every few minutes instead of once
# daily, since Telegram replies should feel near-instant rather than
# next-day. Runs telegram-bot-poll.mjs directly via node.exe (no separate
# .ps1 wrapper needed — the Node script is already self-contained).

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$TaskName' (if it existed)."
    exit 0
}

function Resolve-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        throw 'Node.js is required to run the Telegram bot poller.'
    }
    return $node.Source
}

$scriptPath = Join-Path $PSScriptRoot 'telegram-bot-poll.mjs'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing script at $scriptPath"
}

$nodeExe = Resolve-Node
$taskArgs = ('"{0}"' -f $scriptPath)

if ($WhatIf) {
    Write-Host ('Would create scheduled task "{0}" running every {1} minute(s)' -f $TaskName, $IntervalMinutes)
    Write-Host ('Task command: {0} {1}' -f $nodeExe, $taskArgs)
    exit 0
}

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument $taskArgs
# [TimeSpan]::MaxValue overflows Task Scheduler's XML duration format
# (P99999999DT23H59M59S is out of range) — 10 years is effectively
# "indefinitely" for this purpose and stays within a valid duration.
$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Now) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Polls the Longterm Telegram bot for new group messages and acts on them.' -Force | Out-Host

Write-Host ("Registered scheduled task '{0}' (every {1} minute(s))." -f $TaskName, $IntervalMinutes)
