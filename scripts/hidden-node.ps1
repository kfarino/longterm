# Shared by scheduled-task wrappers. Starts node.exe with no console window.
#
# powershell.exe -WindowStyle Hidden is not enough: node.exe is a console
# subsystem binary and still allocates a visible window. Task Scheduler
# launching node.exe directly does the same. CreateNoWindow +
# UseShellExecute=$false is the combination that stays invisible.
# Do not redirect stdout/stderr here — a long-running process (the Telegram
# poller) can deadlock if those pipes fill. Scripts already log to
# ~/.longterm/logs/.

function Invoke-HiddenNode {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [string[]]$ArgumentList = @()
    )

    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) { throw 'Node.js is required.' }
    if (-not (Test-Path -LiteralPath $ScriptPath)) {
        throw "Missing script at $ScriptPath"
    }

    function Quote-Arg([string]$Value) {
        if ($Value -notmatch '[\s"]') { return $Value }
        return ('"{0}"' -f ($Value -replace '"', '\"'))
    }

    $parts = @(Quote-Arg $ScriptPath)
    foreach ($arg in $ArgumentList) { $parts += Quote-Arg $arg }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node.Source
    $psi.Arguments = ($parts -join ' ')
    $psi.WorkingDirectory = Split-Path -Parent $ScriptPath
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $proc.WaitForExit()
    return $proc.ExitCode
}
