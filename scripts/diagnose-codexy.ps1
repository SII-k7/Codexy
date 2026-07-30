[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'

function Find-Command {
  param([string[]]$Names)

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      return $command
    }
  }
  return $null
}

function Get-CommandVersion {
  param(
    $Command,
    [string[]]$Arguments
  )

  if (-not $Command) {
    return 'not installed'
  }
  try {
    $value = & $Command.Source @Arguments 2>$null | Select-Object -First 1
    if ($value) {
      return [string]$value
    }
  } catch {
    return 'installed; version unavailable'
  }
  return 'installed; version unavailable'
}

function Get-PortStatus {
  param([int]$Port)

  try {
    $listeners = @(
      Get-NetTCPConnection `
        -State Listen `
        -LocalPort $Port `
        -ErrorAction Stop
    )
    if ($listeners.Count -eq 0) {
      return 'closed'
    }
    $owners = @(
      $listeners |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object {
          $process = Get-Process -Id $_ -ErrorAction SilentlyContinue
          if ($process) {
            "$($process.ProcessName) (PID $($_))"
          } else {
            "PID $($_)"
          }
        }
    )
    return "listening: $($owners -join ', ')"
  } catch {
    try {
      $activePorts = @(
        [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().
          GetActiveTcpListeners() |
          Where-Object { $_.Port -eq $Port }
      )
      if ($activePorts.Count -gt 0) {
        return 'listening'
      }
    } catch {
      return 'unknown'
    }
    return 'closed'
  }
}

function Test-CodexyHook {
  param($Hook)

  foreach ($propertyName in @('command', 'commandWindows')) {
    $property = $Hook.PSObject.Properties[$propertyName]
    if ($property -and [string]$property.Value -match '(?i)[\\/]\.codex[\\/]codexy-hooks[\\/]') {
      return $true
    }
  }
  return $false
}

$node = Find-Command -Names @('node.exe', 'node')
$codex = Find-Command -Names @('codex.cmd', 'codex.exe', 'codex')
$tailscale = Find-Command -Names @('tailscale.exe', 'tailscale')
if (-not $tailscale) {
  $defaultTailscale = 'C:\Program Files\Tailscale\tailscale.exe'
  if (Test-Path -LiteralPath $defaultTailscale -PathType Leaf) {
    $tailscale = Get-Item -LiteralPath $defaultTailscale
  }
}

$tailscaleService = Get-Service -Name 'Tailscale' -ErrorAction SilentlyContinue
$codexHome = Join-Path $env:USERPROFILE '.codex'
$hookDirectory = Join-Path $codexHome 'codexy-hooks'
$hookMarker = Join-Path $hookDirectory '.codexy-managed.json'
$globalHooksPath = Join-Path $codexHome 'hooks.json'
$relayLogPath = Join-Path $codexHome 'codexy\relay.log'
$hookLogPath = Join-Path $codexHome 'codexy\hook.log'
$hookEntryCount = 0
$hookConfigStatus = 'not installed'
if (Test-Path -LiteralPath $globalHooksPath -PathType Leaf) {
  try {
    $hookConfig = Get-Content -LiteralPath $globalHooksPath -Raw | ConvertFrom-Json
    foreach ($event in @($hookConfig.hooks.PSObject.Properties)) {
      foreach ($group in @($event.Value)) {
        foreach ($hook in @($group.hooks)) {
          if (Test-CodexyHook -Hook $hook) {
            $hookEntryCount++
          }
        }
      }
    }
    $hookConfigStatus = if ($hookEntryCount -gt 0) {
      "$hookEntryCount Codexy entries merged"
    } else {
      'file present; no Codexy entries'
    }
  } catch {
    $hookConfigStatus = 'hooks.json is invalid JSON'
  }
}

$realCodexPath = if ($codex) { $codex.Source } else { $null }
$expectedLauncher = if ($realCodexPath) {
  Join-Path (Split-Path -Parent $realCodexPath) 'codexy.cmd'
} else {
  $null
}
$launcherStatus = 'not installed'
if ($expectedLauncher -and (Test-Path -LiteralPath $expectedLauncher -PathType Leaf)) {
  $launcherBody = Get-Content -LiteralPath $expectedLauncher -Raw -ErrorAction SilentlyContinue
  $launcherStatus = if ($launcherBody -like '*Codexy launcher*') {
    "installed: $expectedLauncher"
  } else {
    "name collision (not managed by Codexy): $expectedLauncher"
  }
}

$runtimeStatus = if (
  (Test-Path -LiteralPath $hookDirectory -PathType Container) -and
  (Test-Path -LiteralPath $hookMarker -PathType Leaf)
) {
  "installed: $hookDirectory"
} elseif (Test-Path -LiteralPath $hookDirectory -PathType Container) {
  "directory present without Codexy marker: $hookDirectory"
} else {
  'not installed'
}

Write-Output 'Codexy read-only diagnostics'
Write-Output '============================'
Write-Output "Node       : $(Get-CommandVersion -Command $node -Arguments @('--version'))"
Write-Output "Node path  : $(if ($node) { $node.Source } else { '-' })"
Write-Output "Codex CLI  : $(Get-CommandVersion -Command $codex -Arguments @('--version'))"
Write-Output "Codex path : $(if ($codex) { $codex.Source } else { '-' })"
Write-Output "Tailscale  : $(if ($tailscale) { $tailscale.Source } else { 'not installed' })"
Write-Output "TS service : $(if ($tailscaleService) { $tailscaleService.Status } else { 'not installed' })"
Write-Output "Port 8797  : $(Get-PortStatus -Port 8797) (Codexy Relay/PWA)"
Write-Output "Port 4510  : $(Get-PortStatus -Port 4510) (localhost Codex App Server)"
Write-Output "Hook files : $runtimeStatus"
Write-Output "Hook config: $hookConfigStatus"
Write-Output "Launcher   : $launcherStatus"
Write-Output "Relay log  : $(if (Test-Path -LiteralPath $relayLogPath) { $relayLogPath } else { 'not created yet' })"
Write-Output "Hook log   : $(if (Test-Path -LiteralPath $hookLogPath) { $hookLogPath } else { 'not created yet' })"
Write-Output ''
Write-Output 'This command made no changes.'
