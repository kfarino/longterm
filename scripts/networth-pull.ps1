param(
    [string]$OutputPath = (Join-Path $PSScriptRoot '..\data\accounts.json'),
    [string]$EnvFile = '',
    [string]$McpServerExe = '',
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$longtermHome = Join-Path $env:USERPROFILE '.longterm'
if (-not $EnvFile) {
    $preferred = Join-Path $longtermHome 'monarch.env'
    $legacy = Join-Path $env:USERPROFILE '.scrooge\monarch.env'
    if (Test-Path -LiteralPath $preferred) { $EnvFile = $preferred }
    elseif (Test-Path -LiteralPath $legacy) { $EnvFile = $legacy }
    else { $EnvFile = $preferred }
}
if (-not $McpServerExe) {
    $McpServerExe = Join-Path $longtermHome 'monarch-mcp-venv\Scripts\monarch-mcp-jamiew.exe'
}

$NodeScript = Join-Path $PSScriptRoot 'networth-pull.mjs'

function Resolve-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        throw 'Node.js is required to run the net-worth Monarch pull.'
    }
    return $node.Source
}

if (-not (Test-Path -LiteralPath $NodeScript)) {
    throw "Missing Node puller at $NodeScript"
}

$nodeExe = Resolve-Node
$nodeArgs = @($NodeScript, '--output-path', $OutputPath, '--monarch-env-file', $EnvFile, '--mcp-server-exe', $McpServerExe)

if ($DryRun) {
    $nodeArgs += '--dry-run'
}

$nodeOutput = & $nodeExe @nodeArgs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$nodeOutput | ForEach-Object { Write-Host $_ }
