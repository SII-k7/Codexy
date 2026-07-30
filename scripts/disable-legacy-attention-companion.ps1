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
$globalHooksPath = Join-Path $codexHome 'hooks.json'
$legacyRuntimeDirectory = Join-Path $codexHome 'attention-companion-hooks'
$legacyTaskName = 'Attention Companion Private PWA'

function Test-LegacyAttentionHook {
  param($Hook)

  foreach ($propertyName in @('command', 'commandWindows')) {
    $property = $Hook.PSObject.Properties[$propertyName]
    if (
      $property -and
      [string]$property.Value -match
        '(?i)[\\/]\.codex[\\/]attention-companion-hooks[\\/]'
    ) {
      return $true
    }
  }
  return $false
}

function Remove-LegacyAttentionEntries {
  param($Config)

  if (-not $Config.hooks) {
    return 0
  }

  $removedCount = 0
  $eventNames = @(
    $Config.hooks.PSObject.Properties | ForEach-Object { $_.Name }
  )
  foreach ($eventName in $eventNames) {
    $retainedGroups = @()
    foreach ($group in @($Config.hooks.$eventName)) {
      $retainedHooks = @()
      foreach ($hook in @($group.hooks)) {
        if (Test-LegacyAttentionHook -Hook $hook) {
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
$config = $null
$removedCount = 0
if ($configExists) {
  try {
    $config = Get-Content -LiteralPath $globalHooksPath -Raw |
      ConvertFrom-Json
  } catch {
    throw "Cannot safely edit invalid JSON at $globalHooksPath. Nothing was changed."
  }
  $removedCount = Remove-LegacyAttentionEntries -Config $config
}

Write-Output 'Legacy Attention Companion shutdown'
Write-Output "  Mode:                    $(if ($isDryRun) { 'DRY RUN' } else { 'APPLY' })"
Write-Output "  Legacy hooks to disable: $removedCount"
Write-Output "  Startup task:            $legacyTaskName"
Write-Output "  Runtime files preserved: $legacyRuntimeDirectory"
Write-Output '  Codexy hooks and project files are preserved.'

if ($isDryRun) {
  Write-Output 'No configuration or process was changed.'
  exit 0
}

if ($configExists -and $removedCount -gt 0) {
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText(
    $globalHooksPath,
    ($config | ConvertTo-Json -Depth 30),
    $utf8WithoutBom
  )
}

$legacyTask = Get-ScheduledTask `
  -TaskName $legacyTaskName `
  -ErrorAction SilentlyContinue
if ($legacyTask) {
  Stop-ScheduledTask `
    -TaskName $legacyTaskName `
    -ErrorAction SilentlyContinue
  Disable-ScheduledTask -TaskName $legacyTaskName | Out-Null
}

Write-Output 'Disabled legacy hooks and stopped the legacy startup task.'
