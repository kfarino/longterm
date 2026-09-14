# Wrapper so Task Scheduler can launch the Telegram poller without a flashing
# console window. -WindowStyle Hidden on this host is not enough — see
# hidden-node.ps1.
param(
    [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'hidden-node.ps1')

$scriptPath = Join-Path $PSScriptRoot 'telegram-bot-poll.mjs'
$extra = @()
if ($Once) { $extra += '--once' }
exit (Invoke-HiddenNode -ScriptPath $scriptPath -ArgumentList $extra)
