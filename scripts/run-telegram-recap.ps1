# Hidden wrapper for LongtermTelegramRecap (Sun+Thu). Same node.exe console
# flash as the other Telegram tasks if launched as the Action directly.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'hidden-node.ps1')

$scriptPath = Join-Path $PSScriptRoot 'telegram-bot-recap.mjs'
exit (Invoke-HiddenNode -ScriptPath $scriptPath)
