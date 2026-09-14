# Shared by install-*-scheduled-task.ps1. Task action that never shows a console:
# wscript.exe (no console subsystem) runs run-hidden.vbs, which starts the real
# command with window style 0. Hidden PowerShell + node.exe is not enough —
# node is a console app and still allocates a window.

function Get-HiddenTaskLaunch {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Execute,
        [string]$Argument = ''
    )
    $vbsPath = Join-Path $PSScriptRoot 'run-hidden.vbs'
    if (-not (Test-Path -LiteralPath $vbsPath)) {
        throw "Missing hidden launcher at $vbsPath"
    }
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $taskArgs = if ($Argument) {
        ('//nologo //B "{0}" "{1}" {2}' -f $vbsPath, $Execute, $Argument)
    } else {
        ('//nologo //B "{0}" "{1}"' -f $vbsPath, $Execute)
    }
    return @{
        Execute  = $wscript
        Argument = $taskArgs
    }
}
