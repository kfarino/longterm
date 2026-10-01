# Recreate the pin-ready Family Planner shortcut (repo copy + Desktop).
$ErrorActionPreference = "Stop"

$Scripts = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $Scripts "..")).Path
$Vbs = Join-Path $Scripts "launch-desk.vbs"
$Ico = Join-Path $Scripts "family-planner.ico"
$RepoLnk = Join-Path $Scripts "family-planner.lnk"
$DesktopLnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Family Planner.lnk"

foreach ($need in @($Vbs, $Ico)) {
  if (-not (Test-Path $need)) { throw "Missing $need" }
}

function Write-PlannerShortcut([string]$Path) {
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($Path)
  $s.TargetPath = Join-Path $env:SystemRoot "System32\wscript.exe"
  $s.Arguments = "`"$Vbs`""
  $s.WorkingDirectory = $RepoRoot
  $s.WindowStyle = 7
  $s.IconLocation = "$Ico,0"
  $s.Description = "Open the Family Planner (start it if needed)"
  $s.Save()
}

Write-PlannerShortcut $RepoLnk
Write-PlannerShortcut $DesktopLnk
Write-Output "Wrote $RepoLnk"
Write-Output "Wrote $DesktopLnk"
