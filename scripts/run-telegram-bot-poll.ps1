# Wrapper so Task Scheduler can launch the Telegram poller without a flashing
# console window (node.exe as the task Action shows a window on every tick /
# long-poll iteration that writes to stderr).
param(
    [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) { throw 'Node.js is required to run the Telegram bot poller.' }

$scriptPath = Join-Path $PSScriptRoot 'telegram-bot-poll.mjs'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing script at $scriptPath"
}

$argsList = @($scriptPath)
if ($Once) { $argsList += '--once' }

& $node.Source @argsList
exit $LASTEXITCODE
