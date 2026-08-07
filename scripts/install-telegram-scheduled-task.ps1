param(
    [string]$TaskName = 'LongtermTelegramPoll',
    [int]$IntervalMinutes = 0,
    [switch]$Legacy,
    [switch]$Uninstall,
    [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Sibling to install-scheduled-task.ps1 (the Monarch daily-pull installer).
#
# Default mode: telegram-bot-poll.mjs runs its own internal long-poll loop
# (see runPollLoop in that file) and exits every ~15 minutes to pick up code
# changes automatically. This task's -RepetitionInterval only controls how
# quickly a crash or a clean self-refresh gets noticed and relaunched — the
# actual message-check cadence is governed by the script's own loop, not by
# this task firing. -MultipleInstances IgnoreNew (below) is what makes this
# self-healing: while the loop process is alive, each tick is a no-op; the
# moment it exits, the next tick relaunches it.
#
# -Legacy mode restores the exact pre-2026-08-06 behavior: telegram-bot-poll.mjs
# runs with --once (a single short getUpdates call, then exit) on a 2-minute
# interval. Use this as an instant rollback if long-polling ever misbehaves
# (e.g. an unexpected Telegram rate limit) — no code change needed, just
# re-run this installer with -Legacy.

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

if ($IntervalMinutes -le 0) {
    # Long-poll mode only needs a fast enough tick to notice a crash/refresh
    # quickly; legacy mode's interval IS the actual poll cadence, so it keeps
    # its historical, more conservative default.
    $IntervalMinutes = if ($Legacy) { 2 } else { 1 }
}

$nodeExe = Resolve-Node
$taskArgs = if ($Legacy) { ('"{0}" --once' -f $scriptPath) } else { ('"{0}"' -f $scriptPath) }
$modeLabel = if ($Legacy) { 'legacy short-poll (--once)' } else { 'long-poll loop' }

if ($WhatIf) {
    Write-Host ('Would create scheduled task "{0}" - {1}, checked/relaunched every {2} minute(s)' -f $TaskName, $modeLabel, $IntervalMinutes)
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
    -Description "Runs the Longterm Telegram bot poller ($modeLabel)." -Force | Out-Host

Write-Host ("Registered scheduled task '{0}' - {1}, checked/relaunched every {2} minute(s)." -f $TaskName, $modeLabel, $IntervalMinutes)
