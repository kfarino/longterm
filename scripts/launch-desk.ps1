# Start Family Planner if needed, then open it in the default browser.
# Invoked hidden by launch-desk.vbs (taskbar / Desktop shortcut).
$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Port = 4200
if ($env:PORT -match '^\d+$') { $Port = [int]$env:PORT }
$Base = "http://127.0.0.1:$Port"

function Show-Fail([string]$Message) {
  (New-Object -ComObject WScript.Shell).Popup($Message, 10, "Family Planner", 16) | Out-Null
}

function Test-DeskHttp {
  foreach ($path in @("/dashboard_v5.html", "/")) {
    try {
      $req = [System.Net.WebRequest]::Create($Base + $path)
      $req.Method = "GET"
      $req.Timeout = 2000
      $req.ReadWriteTimeout = 2000
      $req.Proxy = $null
      $resp = $req.GetResponse()
      try {
        $code = [int]$resp.StatusCode
        if ($code -ge 200 -and $code -lt 500) { return $true }
      } finally {
        $resp.Close()
      }
    } catch {
      # down or not the planner
    }
  }
  return $false
}

function Test-PortListening {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
      $iar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
      $ok = $iar.AsyncWaitHandle.WaitOne(400, $false)
      if (-not $ok) { return $false }
      $client.EndConnect($iar)
      return $client.Connected
    } finally {
      $client.Close()
    }
  } catch {
    return $false
  }
}

function Wait-DeskHttp([int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    if (Test-DeskHttp) { return $true }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  foreach ($candidate in @(
      (Join-Path ${env:ProgramFiles} "nodejs\node.exe"),
      (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
    )) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return $null
}

if (Test-DeskHttp) {
  Start-Process $Base
  exit 0
}

# Something already bound to the port: wait for it; never kill or steal 4200.
if (Test-PortListening) {
  if (Wait-DeskHttp 8) {
    Start-Process $Base
    exit 0
  }
  Show-Fail "Port $Port is in use but Family Planner did not respond at $Base/. Not starting a second Node process."
  exit 1
}

$node = Find-Node
if (-not $node) {
  Show-Fail "Node.js was not found. Install Node, then try again."
  exit 1
}

$server = Join-Path $RepoRoot "scripts\dashboard-server.mjs"
if (-not (Test-Path $server)) {
  Show-Fail "Could not find scripts/dashboard-server.mjs in $RepoRoot"
  exit 1
}

$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $node
$info.Arguments = "`"$server`""
$info.WorkingDirectory = $RepoRoot
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$info.EnvironmentVariables["PORT"] = "$Port"
$proc = [System.Diagnostics.Process]::Start($info)
if (-not $proc) {
  Show-Fail "Failed to start Node (dashboard-server.mjs) for Family Planner."
  exit 1
}
$proc.Dispose()

if (-not (Wait-DeskHttp 8)) {
  Show-Fail "Family Planner did not respond at $Base/ after starting Node. Check that port $Port is free and dashboard-server.mjs can start."
  exit 1
}

Start-Process $Base
exit 0
