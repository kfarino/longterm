param(
    [switch]$DryRun,
    # Volume label on the removable disk (drive letter can change).
    [string]$VolumeLabel = 'LaCie',
    [string]$DestProjectsRelative = 'Projects',
    [string]$LongtermSource = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Longterm'),
    [string]$NikolaSource = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'nikola'),
    [string]$LongtermSecretsSource = (Join-Path $env:USERPROFILE '.longterm')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Mirror Documents projects + ~/.longterm onto the Lacie backup disk.
# Intentionally NOT git-based: Longterm's financial JSON, overrides, ledgers,
# and env files are gitignored / live outside the repo. robocopy copies those.
#
# Exit 0 when the drive is absent (scheduled task stays green; log notes skip).
# robocopy codes 0-7 are success; 8+ are failure.

$logDir = Join-Path $env:USERPROFILE '.longterm\logs'
$logPath = Join-Path $logDir 'lacie-backup.log'

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
        # /MIR deletes extras on dest (good for project trees). For ~/.longterm
        # use -Mirror:$false so excluded venv/logs on the disk are left alone
        # and a bad path can never wipe env files.
        [switch]$Mirror
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        Write-BackupLog ("SKIP {0}: source missing ({1})" -f $Name, $Source)
        return
    }

    if (-not (Test-Path -LiteralPath $Dest)) {
        New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    }

    # /E    — copy subdirs including empty
    # /MIR  — dest matches source (optional)
    # /FFT  — 2s timestamp fuzz (exFAT vs NTFS)
    # /R:2 /W:5 — short retries (USB can blip)
    # /XD   — skip rebuildable / huge dirs
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

# Rebuildable / huge — keep the backup lean and focused on irreplaceable files.
$projectExcludes = @(
    'node_modules',
    '.worktrees',
    'dist',
    'coverage',
    '__pycache__'
)
$secretsExcludes = @(
    'monarch-mcp-venv',
    'logs'
)

try {
    Invoke-RobocopyBackup -Name 'Longterm' -Source $LongtermSource `
        -Dest (Join-Path $destRoot 'Longterm') -ExcludeDirs $projectExcludes -Mirror
    Invoke-RobocopyBackup -Name 'nikola' -Source $NikolaSource `
        -Dest (Join-Path $destRoot 'nikola') -ExcludeDirs $projectExcludes -Mirror
    Invoke-RobocopyBackup -Name '.longterm' -Source $LongtermSecretsSource `
        -Dest (Join-Path $destRoot '.longterm') -ExcludeDirs $secretsExcludes
    Write-BackupLog 'DONE'
    exit 0
} catch {
    Write-BackupLog ("FAIL: {0}" -f $_.Exception.Message)
    exit 1
}
