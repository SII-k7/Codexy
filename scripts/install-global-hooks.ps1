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
$sourceDirectory = Join-Path $PSScriptRoot 'global-codex-hooks'
$codexHome = Join-Path $env:USERPROFILE '.codex'
$targetDirectory = Join-Path $codexHome 'codexy-hooks'
$globalHooksPath = Join-Path $codexHome 'hooks.json'
$sourceHooksPath = Join-Path $sourceDirectory 'hooks.json'
$managedFiles = @(
  'capture_prompt.cmd',
  'capture_prompt.py',
  'notify_mobile.cmd',
  'notify_mobile.py',
  'hooks.json',
  'README.md'
)

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

foreach ($fileName in $managedFiles) {
  $sourceFile = Join-Path $sourceDirectory $fileName
  if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
    throw "Missing reviewed Codexy hook file: $sourceFile"
  }
}

$sourceConfig = Get-Content -LiteralPath $sourceHooksPath -Raw | ConvertFrom-Json
if (-not $sourceConfig.hooks) {
  throw "Invalid Codexy hook definition: $sourceHooksPath"
}

$createdConfig = -not (Test-Path -LiteralPath $globalHooksPath -PathType Leaf)
if ($createdConfig) {
  $targetConfig = [pscustomobject][ordered]@{
    description = 'Codexy privacy-minimized global Codex hooks.'
    hooks = [pscustomobject]@{}
  }
} else {
  try {
    $targetConfig = Get-Content -LiteralPath $globalHooksPath -Raw | ConvertFrom-Json
  } catch {
    throw "Cannot safely merge invalid JSON at $globalHooksPath. Fix it manually; it was not changed."
  }
  if (-not $targetConfig.hooks) {
    $targetConfig | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
  }
}

$replacedCount = Remove-CodexyEntries -Config $targetConfig
$addedCount = 0
foreach ($sourceEvent in @($sourceConfig.hooks.PSObject.Properties)) {
  $eventName = $sourceEvent.Name
  $existingGroups = @()
  if ($targetConfig.hooks.PSObject.Properties[$eventName]) {
    $existingGroups = @($targetConfig.hooks.$eventName)
  }
  $newGroups = @($sourceEvent.Value)
  $addedCount += @(
    $newGroups | ForEach-Object { @($_.hooks).Count }
  ) | Measure-Object -Sum | Select-Object -ExpandProperty Sum

  if ($targetConfig.hooks.PSObject.Properties[$eventName]) {
    $targetConfig.hooks.$eventName = @($existingGroups + $newGroups)
  } else {
    $targetConfig.hooks | Add-Member `
      -NotePropertyName $eventName `
      -NotePropertyValue @($newGroups)
  }
}

Write-Output 'Codexy global hook installation'
Write-Output "  Mode:             $(if ($isDryRun) { 'DRY RUN' } else { 'APPLY' })"
Write-Output "  Runtime target:   $targetDirectory"
Write-Output "  Global hook file: $globalHooksPath"
Write-Output "  Existing Codexy entries to replace: $replacedCount"
Write-Output "  Reviewed Codexy entries to install: $addedCount"
Write-Output '  Non-Codexy entries are preserved.'

if ($isDryRun) {
  Write-Output 'No hook files or configuration were changed.'
  exit 0
}

New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
foreach ($fileName in $managedFiles) {
  Copy-Item `
    -LiteralPath (Join-Path $sourceDirectory $fileName) `
    -Destination (Join-Path $targetDirectory $fileName) `
    -Force
}

$marker = [pscustomobject][ordered]@{
  managedBy = 'Codexy'
  installedAtUtc = [DateTime]::UtcNow.ToString('o')
  source = [System.IO.Path]::GetFullPath($sourceDirectory)
}
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
  (Join-Path $targetDirectory '.codexy-managed.json'),
  ($marker | ConvertTo-Json -Depth 5),
  $utf8WithoutBom
)

New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
[System.IO.File]::WriteAllText(
  $globalHooksPath,
  ($targetConfig | ConvertTo-Json -Depth 30),
  $utf8WithoutBom
)

Write-Output 'Installed Codexy hook runtime files and merged Codexy entries.'
Write-Output 'Review and trust the new commands in Codex with /hooks.'
