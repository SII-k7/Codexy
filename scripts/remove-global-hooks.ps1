[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

if ($DryRun -and $Apply) {
  throw 'Choose either -DryRun or -Apply, not both.'
}

$isDryRun = -not $Apply
$codexHome = Join-Path $env:USERPROFILE '.codex'
$targetDirectory = Join-Path $codexHome 'codexy-hooks'
$globalHooksPath = Join-Path $codexHome 'hooks.json'
$markerPath = Join-Path $targetDirectory '.codexy-managed.json'

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

function Remove-CodexyEntries {
  param($Config)

  if (-not $Config.hooks) {
    return 0
  }

  $removedCount = 0
  $eventNames = @($Config.hooks.PSObject.Properties | ForEach-Object { $_.Name })
  foreach ($eventName in $eventNames) {
    $retainedGroups = @()
    foreach ($group in @($Config.hooks.$eventName)) {
      $retainedHooks = @()
      foreach ($hook in @($group.hooks)) {
        if (Test-CodexyHook -Hook $hook) {
          $removedCount++
        } else {
          $retainedHooks += $hook
        }
      }

      if ($retainedHooks.Count -gt 0) {
        $group.hooks = @($retainedHooks)
        $retainedGroups += $group
      }
    }

    if ($retainedGroups.Count -gt 0) {
      $Config.hooks.$eventName = @($retainedGroups)
    } else {
      $Config.hooks.PSObject.Properties.Remove($eventName)
    }
  }
  return $removedCount
}

$configExists = Test-Path -LiteralPath $globalHooksPath -PathType Leaf
$targetExists = Test-Path -LiteralPath $targetDirectory -PathType Container
$managedTarget = Test-Path -LiteralPath $markerPath -PathType Leaf
$removedCount = 0
$config = $null

if ($configExists) {
  try {
    $config = Get-Content -LiteralPath $globalHooksPath -Raw | ConvertFrom-Json
  } catch {
    throw "Cannot safely edit invalid JSON at $globalHooksPath. Nothing was removed."
  }
  $removedCount = Remove-CodexyEntries -Config $config
}

Write-Output 'Codexy global hook removal'
Write-Output "  Mode:             $(if ($isDryRun) { 'DRY RUN' } else { 'APPLY' })"
Write-Output "  Global hook file: $globalHooksPath"
Write-Output "  Codexy hook entries to remove: $removedCount"
Write-Output "  Managed runtime directory: $(if ($managedTarget) { $targetDirectory } elseif ($targetExists) { 'present but missing Codexy marker; it will be preserved' } else { 'not installed' })"
Write-Output '  Non-Codexy hooks, acx, and Tailscale routes are not changed.'

if ($isDryRun) {
  Write-Output 'No hook files or configuration were changed.'
  exit 0
}

if ($configExists -and $removedCount -gt 0) {
  $eventCount = @($config.hooks.PSObject.Properties).Count
  $description = [string]$config.description
  if ($eventCount -eq 0 -and $description -eq 'Codexy privacy-minimized global Codex hooks.') {
    Remove-Item -LiteralPath $globalHooksPath -Force
  } else {
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText(
      $globalHooksPath,
      ($config | ConvertTo-Json -Depth 30),
      $utf8WithoutBom
    )
  }
}

if ($managedTarget) {
  $resolvedCodexHome = [System.IO.Path]::GetFullPath($codexHome).TrimEnd('\')
  $resolvedTarget = [System.IO.Path]::GetFullPath($targetDirectory).TrimEnd('\')
  $expectedTarget = Join-Path $resolvedCodexHome 'codexy-hooks'
  if ($resolvedTarget -cne $expectedTarget) {
    throw "Refusing to remove an unexpected directory: $resolvedTarget"
  }
  Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
}

Write-Output 'Removed only Codexy-owned global hook entries and managed runtime files.'
