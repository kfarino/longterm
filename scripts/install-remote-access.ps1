# Hanna's computer reaches this PC over Tailscale only.
# - Dashboard stays on 127.0.0.1:4200. Tailscale Serve publishes it to the
#   tailnet once this PC is logged into Tailscale. Never Funnel (public internet).
# - OpenSSH accepts her Cursor session as this Windows user, public-key only.
#   The firewall allows port 22 only on the Tailscale adapter.
# - LongtermDashboard starts the dashboard at logon without opening a browser.
#
# Re-run after moving the repo, after a Windows OpenSSH reset, or once Tailscale
# is signed in (the first run installs Tailscale; serve turns on after login).
# Requires an elevated PowerShell. -Uninstall stops SSH and removes the task
# and firewall rule. It does not uninstall Tailscale.
param(
  [string]$AllowUser = $env:USERNAME,
  [string]$TaskName = 'LongtermDashboard',
  [switch]$Uninstall,
  [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$FirewallRule = 'Longterm-SSH-Tailscale'
$SshdConfig = Join-Path $env:ProgramData 'ssh\sshd_config'
$MarkerBegin = '# BEGIN Longterm remote access'
$MarkerEnd = '# END Longterm remote access'

function Assert-Elevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell (it installs OpenSSH, Tailscale, and a firewall rule).'
  }
}

function Get-TailscaleExe {
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  $candidate = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  return $null
}

function Install-TailscaleClient {
  $existing = Get-TailscaleExe
  if ($existing) {
    Write-Host "Tailscale already installed at $existing"
    return $existing
  }
  if ($WhatIf) {
    Write-Host 'Would install Tailscale.Tailscale via winget'
    return $null
  }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw 'winget is required to install Tailscale.' }
  Write-Host 'Installing Tailscale...'
  & winget install -e --id Tailscale.Tailscale --accept-package-agreements --accept-source-agreements --disable-interactivity
  $installed = Get-TailscaleExe
  if (-not $installed) {
    throw "winget install Tailscale failed (exit $LASTEXITCODE)"
  }
  return $installed
}

function Ensure-TailscaleService {
  $deadline = (Get-Date).AddSeconds(30)
  $svc = $null
  do {
    $svc = Get-Service -Name Tailscale -ErrorAction SilentlyContinue
    if ($svc) { break }
    if ($WhatIf) { return $false }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  if (-not $svc) { return $false }
  if ($WhatIf) { return $true }
  if ($svc.StartType -ne 'Automatic') {
    Set-Service -Name Tailscale -StartupType Automatic
  }
  if ($svc.Status -ne 'Running') {
    Start-Service -Name Tailscale
  }
  return $true
}

function Test-TailscaleLoggedIn([string]$Exe) {
  if (-not $Exe) { return $false }
  $raw = & $Exe status --json 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) { return $false }
  try {
    $status = $raw | ConvertFrom-Json
  } catch {
    return $false
  }
  return $status.BackendState -eq 'Running'
}

function Enable-TailscaleServe([string]$Exe) {
  if (-not (Test-TailscaleLoggedIn $Exe)) {
    Write-Host 'Tailscale is installed but this PC is not signed in yet.'
    Write-Host 'Sign in from the Tailscale tray icon (same tailnet Hanna will join), then re-run this script.'
    return
  }
  if ($WhatIf) {
    Write-Host 'Would run: tailscale serve --bg http://127.0.0.1:4200'
    return
  }
  # Serve, never Funnel. Funnel would publish the dashboard on the public internet.
  & $Exe serve --bg http://127.0.0.1:4200
  if ($LASTEXITCODE -ne 0) {
    throw "tailscale serve failed (exit $LASTEXITCODE). The dashboard bind stays on 127.0.0.1."
  }
  Write-Host 'Tailscale Serve is forwarding the tailnet HTTPS address to http://127.0.0.1:4200'
  & $Exe serve status
}

function Install-OpenSshServer {
  $svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
  if ($svc) {
    Write-Host 'OpenSSH Server is already installed.'
    return
  }
  if ($WhatIf) {
    Write-Host 'Would install OpenSSH.Server capability'
    return
  }
  Write-Host 'Installing OpenSSH Server...'
  $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
  if ($cap.State -ne 'Installed') {
    Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
  }
}

function Set-SshdHardened {
  if ($WhatIf) {
    Write-Host "Would harden $SshdConfig for public-key only, user $AllowUser"
    return
  }
  if (-not (Test-Path -LiteralPath $SshdConfig)) {
    throw "Missing $SshdConfig"
  }
  $text = Get-Content -Raw -LiteralPath $SshdConfig
  $text = [regex]::Replace($text, '(?m)^([ \t]*Match Group administrators[ \t]*)$', '# $1')
  $text = [regex]::Replace($text, '(?m)^([ \t]*AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys[ \t]*)$', '# $1')
  $block = @"
$MarkerBegin
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
AllowUsers $AllowUser
$MarkerEnd
"@
  $pattern = '(?s)' + [regex]::Escape($MarkerBegin) + '.*?' + [regex]::Escape($MarkerEnd) + '\r?\n?'
  if ([regex]::IsMatch($text, $pattern)) {
    $text = [regex]::Replace($text, $pattern, ($block + "`r`n"))
  } else {
    $text = $text.TrimEnd() + "`r`n`r`n" + $block + "`r`n"
  }
  Set-Content -LiteralPath $SshdConfig -Value $text -Encoding ascii

  $sshd = Join-Path $env:SystemRoot 'System32\OpenSSH\sshd.exe'
  & $sshd -t
  if ($LASTEXITCODE -ne 0) {
    throw "sshd rejected $SshdConfig (exit $LASTEXITCODE). Not restarting sshd."
  }

  New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell `
    -Value (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
    -PropertyType String -Force | Out-Null

  Set-Service -Name sshd -StartupType Automatic
  Restart-Service -Name sshd -Force
  Write-Host "sshd is running, public-key only, AllowUsers $AllowUser"
}

function Ensure-AuthorizedKeysFile {
  $profile = (Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -and (Split-Path $_.LocalPath -Leaf) -eq $AllowUser } | Select-Object -First 1).LocalPath
  if (-not $profile) { $profile = Join-Path $env:SystemDrive "Users\$AllowUser" }
  $sshDir = Join-Path $profile '.ssh'
  $keys = Join-Path $sshDir 'authorized_keys'
  if ($WhatIf) {
    Write-Host "Would ensure $keys"
    return $keys
  }
  New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
  if (-not (Test-Path -LiteralPath $keys)) {
    New-Item -ItemType File -Path $keys | Out-Null
  }
  icacls $sshDir /inheritance:r /grant:r "${AllowUser}:(OI)(CI)F" /grant:r 'SYSTEM:(OI)(CI)F' | Out-Null
  icacls $sshDir /remove 'BUILTIN\Administrators' 'BUILTIN\Users' 'Everyone' 'NT AUTHORITY\Authenticated Users' | Out-Null
  icacls $keys /inheritance:r /grant:r "${AllowUser}:F" /grant:r 'SYSTEM:F' | Out-Null
  icacls $keys /remove 'BUILTIN\Administrators' 'BUILTIN\Users' 'Everyone' 'NT AUTHORITY\Authenticated Users' | Out-Null
  return $keys
}

function Disable-WideOpenSshRules {
  if ($WhatIf) { return }
  Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne $FirewallRule -and $_.Name -ne 'Longterm-SSH-Block' -and ($_.DisplayName -like 'OpenSSH*' -or $_.Name -like 'OpenSSH*') } |
    ForEach-Object { Disable-NetFirewallRule -Name $_.Name }
}

function Set-Port22BlockedUntilReady {
  if ($WhatIf) { return }
  $block = Get-NetFirewallRule -Name 'Longterm-SSH-Block' -ErrorAction SilentlyContinue
  if (-not $block) {
    # Block beats allow. Holds port 22 shut until the Tailscale-only rule is in place,
    # including the moment Windows turns on its wide OpenSSH rule.
    New-NetFirewallRule -Name 'Longterm-SSH-Block' -DisplayName 'Longterm SSH blocked until Tailscale' `
      -Enabled True -Direction Inbound -Action Block -Protocol TCP -LocalPort 22 -Profile Any | Out-Null
  }
  Disable-WideOpenSshRules
}

function Set-SshFirewallTailscaleOnly {
  if ($WhatIf) {
    Write-Host "Would allow TCP 22 on the Tailscale adapter only ($FirewallRule) and disable the wide OpenSSH rules"
    return
  }
  $adapter = Get-NetAdapter -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'Tailscale' -or $_.InterfaceDescription -like '*Tailscale*' } |
    Select-Object -First 1
  if (-not $adapter) {
    Write-Host 'Tailscale adapter is not up yet, so port 22 stays closed.'
    Write-Host 'Sign in to Tailscale, then re-run this script to open SSH on that adapter only.'
    Set-Port22BlockedUntilReady
    return
  }
  $existing = Get-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue
  if ($existing) { Remove-NetFirewallRule -Name $FirewallRule }
  New-NetFirewallRule -Name $FirewallRule -DisplayName 'Longterm SSH (Tailscale only)' `
    -Enabled True -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 `
    -InterfaceAlias $adapter.Name -Profile Any | Out-Null
  Remove-NetFirewallRule -Name 'Longterm-SSH-Block' -ErrorAction SilentlyContinue
  Disable-WideOpenSshRules
  Write-Host "Firewall: TCP 22 allowed on '$($adapter.Name)' only."
}

function Install-DashboardLogonTask {
  . (Join-Path $PSScriptRoot 'hidden-task-action.ps1')
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $desk = Join-Path $PSScriptRoot 'launch-desk.ps1'
  $arg = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -ServeOnly' -f $desk
  $launch = Get-HiddenTaskLaunch -Execute $ps -Argument $arg
  if ($WhatIf) {
    Write-Host "Would register logon task $TaskName : $($launch.Execute) $($launch.Argument)"
    return
  }
  $action = New-ScheduledTaskAction -Execute $launch.Execute -Argument $launch.Argument
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $AllowUser
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId $AllowUser -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Starts Family Planner on 127.0.0.1:4200 at logon. Does not open a browser.' -Force | Out-Null
  Write-Host "Registered logon task '$TaskName'."
  Start-ScheduledTask -TaskName $TaskName
}

function Uninstall-RemoteAccess {
  Assert-Elevated
  if ($WhatIf) {
    Write-Host "Would remove firewall rule $FirewallRule, disable sshd, unregister $TaskName, and turn off Tailscale Serve."
    return
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -Name 'Longterm-SSH-Block' -ErrorAction SilentlyContinue
  $svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
  if ($svc) {
    Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue
    Set-Service -Name sshd -StartupType Disabled
  }
  $ts = Get-TailscaleExe
  if ($ts -and (Test-TailscaleLoggedIn $ts)) {
    & $ts serve reset
  }
  Write-Host "Removed $TaskName and the Tailscale SSH rule, and disabled sshd."
  Write-Host 'Tailscale itself is still installed.'
}

if ($Uninstall) {
  Uninstall-RemoteAccess
  exit 0
}

Assert-Elevated
Set-Port22BlockedUntilReady
$ts = Install-TailscaleClient
Ensure-TailscaleService | Out-Null
Install-OpenSshServer
Set-Port22BlockedUntilReady
Set-SshdHardened
$keys = Ensure-AuthorizedKeysFile
Set-SshFirewallTailscaleOnly
Install-DashboardLogonTask
Enable-TailscaleServe $ts

Write-Host ''
Write-Host 'Next: Hanna generates a key on her computer and you add the public line here:'
Write-Host "  $keys"
Write-Host 'One line, starting with ssh-ed25519. She keeps the private key on her computer.'
Write-Host 'Her Cursor Remote SSH host is this PC''s Tailscale name, user' $AllowUser
