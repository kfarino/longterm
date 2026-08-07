param(
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Wrapper for the durable Oura pull, mirroring budget-tracking-pull.ps1 so
# run-daily-pull.ps1 can invoke every step the same way. Owner ids come from
# goals.json; owners without a token file under ~/.longterm are skipped.

$NodeScript = Join-Path $PSScriptRoot 'oura-pull.mjs'

function Resolve-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        throw 'Node.js is required to run the Oura pull.'
    }
    return $node.Source
}

if (-not (Test-Path -LiteralPath $NodeScript)) {
    throw "Missing Node puller at $NodeScript"
}

$nodeExe = Resolve-Node
$nodeArgs = @($NodeScript, '--all')

if ($DryRun) {
    $nodeArgs += '--dry-run'
}

$nodeOutput = & $nodeExe @nodeArgs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$nodeOutput | ForEach-Object { Write-Host $_ }
