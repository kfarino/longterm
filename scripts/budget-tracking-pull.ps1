param(
    [string]$OutputPath = (Join-Path $PSScriptRoot '..\data\budget_tracking.json'),
    [string]$GoalsPath = (Join-Path $PSScriptRoot '..\data\goals.json'),
    [string]$EnvFile = (Join-Path $env:USERPROFILE '.longterm\monarch.env'),
    [string]$McpServerExe = (Join-Path $env:USERPROFILE '.longterm\monarch-mcp-venv\Scripts\python.exe'),
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$NodeScript = Join-Path $PSScriptRoot 'budget-tracking-pull.mjs'

function Resolve-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        throw 'Node.js is required to run the budget-tracking Monarch pull.'
    }
    return $node.Source
}

if (-not (Test-Path -LiteralPath $NodeScript)) {
    throw "Missing Node puller at $NodeScript"
}

$nodeExe = Resolve-Node
$nodeArgs = @($NodeScript, '--output-path', $OutputPath, '--goals-path', $GoalsPath, '--monarch-env-file', $EnvFile, '--mcp-server-exe', $McpServerExe)

if ($DryRun) {
    $nodeArgs += '--dry-run'
}

$nodeOutput = & $nodeExe @nodeArgs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$nodeOutput | ForEach-Object { Write-Host $_ }
