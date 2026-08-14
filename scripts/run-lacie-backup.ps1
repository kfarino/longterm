param(
    [switch]$DryRun,
    # Volume label on the removable disk (drive letter can change).
    [string]$VolumeLabel = 'LaCie',
    [string]$DestProjectsRelative = 'Projects',
    [string]$LongtermSource = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Longterm'),
    [string]$NikolaSource = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'nikola')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Mirror everything needed to run Longterm + nikola after a machine loss:
#   Documents\Longterm  (incl. gitignored finance JSON)
#   Documents\nikola
#   ~/.longterm         (*.env — Monarch/Telegram/Calendar/Oura/Spotify/Ticketmaster)
#   ~/.monarch-mcp      (Monarch MCP session.pickle)
#   ~/.ssh              (keys if present)
#   ~/.scrooge          (legacy leftover; cheap to keep if it exists)
#
# Intentionally NOT git-based. Rebuildable junk is skipped (venv, logs,
# node_modules). Huge IDE/cache trees (.claude/.cursor/.local/.cache) are
# NOT required to run Longterm and stay off the backup.
#
# Exit 0 when the drive is absent (scheduled task stays green; log notes skip).
# robocopy codes 0-7 are success; 8+ are failure.
#
# Restore sketch (new PC, Lacie plugged in as e.g. F:):
#   1. Copy F:\Projects\Longterm → Documents\Longterm
#   2. Copy F:\Projects\.longterm → %USERPROFILE%\.longterm
#   3. Copy F:\Projects\.monarch-mcp → %USERPROFILE%\.monarch-mcp
#   4. Recreate venv: python -m venv %USERPROFILE%\.longterm\monarch-mcp-venv
#      then pip install monarch-mcp-jamiew==0.4.0
#   5. npm install / npm run build in Longterm; re-run install-*-scheduled-task.ps1

$logDir = Join-Path $env:USERPROFILE '.longterm\logs'
$logPath = Join-Path $logDir 'lacie-backup.log'
$homeRoot = $env:USERPROFILE

function Write-BackupLog {
    param([string]$Message)
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    Add-Content -LiteralPath $logPath -Value $line
}

function Resolve-LacieProjectsRoot {
    param([string]$Label, [string]$Relative)
    $vol = Get-Volume -ErrorAction SilentlyContinue |
        Where-Object { $_.FileSystemLabel -eq $Label -and $_.DriveLetter } |
        Select-Object -First 1
    if (-not $vol) { return $null }
    return ('{0}:\{1}' -f $vol.DriveLetter, $Relative.TrimStart('\'))
}

function Invoke-RobocopyBackup {
    param(
        [string]$Name,
        [string]$Source,
        [string]$Dest,
        [string[]]$ExcludeDirs = @(),
        # /MIR for project trees. Home secret folders use -Mirror:$false so
        # excluded dirs (venv/logs) on the disk are never purged by accident.
        [switch]$Mirror
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        Write-BackupLog ("SKIP {0}: source missing ({1})" -f $Name, $Source)
        return
    }

    if (-not (Test-Path -LiteralPath $Dest)) {
        New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    }

    $mode = if ($Mirror) { '/MIR' } else { '/E' }
    $robocopyArgs = @(
        $Source, $Dest,
        $mode, '/FFT', '/R:2', '/W:5',
        '/NFL', '/NDL', '/NP', '/NJH', '/NJS'
    )
    if ($ExcludeDirs.Count -gt 0) {
        $robocopyArgs += '/XD'
        $robocopyArgs += $ExcludeDirs
    }
    if ($DryRun) {
        $robocopyArgs += '/L'
    }

    Write-BackupLog ("START {0}: {1} -> {2}" -f $Name, $Source, $Dest)
    & robocopy.exe @robocopyArgs | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) {
        throw ("robocopy {0} failed with exit code {1}" -f $Name, $code)
    }
    Write-BackupLog ("OK {0} (robocopy exit {1})" -f $Name, $code)
}

$destRoot = Resolve-LacieProjectsRoot -Label $VolumeLabel -Relative $DestProjectsRelative
if (-not $destRoot) {
    Write-BackupLog ("SKIP: volume '{0}' not mounted (nothing to do)." -f $VolumeLabel)
    exit 0
}
if (-not (Test-Path -LiteralPath $destRoot)) {
    New-Item -ItemType Directory -Path $destRoot -Force | Out-Null
}

Write-BackupLog ("Backup root: {0}" -f $destRoot)

$projectExcludes = @(
    'node_modules',
    '.worktrees',
    'dist',
    'coverage',
    '__pycache__'
)
# Rebuildable — env files + session are what matter for restore.
$longtermHomeExcludes = @(
    'monarch-mcp-venv',
    'logs',
    'history-purge-2026-08-06'
)

# Home folders required (or cheap insurance) for a full Longterm restore.
$homeFolders = @(
    '.longterm',
    '.monarch-mcp',
    '.ssh',
    '.scrooge'
)

try {
    Invoke-RobocopyBackup -Name 'Longterm' -Source $LongtermSource `
        -Dest (Join-Path $destRoot 'Longterm') -ExcludeDirs $projectExcludes -Mirror
    Invoke-RobocopyBackup -Name 'nikola' -Source $NikolaSource `
        -Dest (Join-Path $destRoot 'nikola') -ExcludeDirs $projectExcludes -Mirror

    foreach ($name in $homeFolders) {
        $source = Join-Path $homeRoot $name
        $excludes = @()
        if ($name -eq '.longterm') { $excludes = $longtermHomeExcludes }
        Invoke-RobocopyBackup -Name $name -Source $source `
            -Dest (Join-Path $destRoot $name) -ExcludeDirs $excludes
    }

    Write-BackupLog 'DONE'
    exit 0
} catch {
    Write-BackupLog ("FAIL: {0}" -f $_.Exception.Message)
    exit 1
}
