# Hidden wrapper for LongtermTelegramReminders (ticks every few minutes).
# Launching node.exe as the task Action flashes a console on every tick.
param(
    [string]$DefaultTime = '08:00'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'hidden-node.ps1')

$scriptPath = Join-Path $PSScriptRoot 'telegram-bot-reminders.mjs'
exit (Invoke-HiddenNode -ScriptPath $scriptPath -ArgumentList @('--default-time', $DefaultTime))
