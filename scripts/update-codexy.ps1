[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Apply,
  [switch]$SkipNpmInstall,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'

if ($DryRun -and $Apply) {
  throw 'Choose either -DryRun or -Apply, not both.'
}

$isDryRun = -not $Apply
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$envPath = Join-Path $projectRoot '.env.local'
$envBackupPath = Join-Path $projectRoot '.env.update-backup.local'
$hookInstaller = Join-Path $PSScriptRoot 'install-global-hooks.ps1'
$launcherInstaller = Join-Path $PSScriptRoot 'install-codex-launcher.ps1'
$taskName = 'Codexy Private PWA'
$npm = Get-Command npm.cmd -ErrorAction Stop
$codex = Get-Command codex.cmd -ErrorAction Stop
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$taskWasRunning = $task -and $task.State -eq 'Running'

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Action
  )

  Write-Output ''
  Write-Output "==> $Label"
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

Write-Output 'Codexy safe update'
Write-Output '=================='
Write-Output "Mode: $(if ($isDryRun) { 'DRY RUN' } else { 'APPLY' })"
Write-Output "Project: $projectRoot"
Write-Output "Startup task: $(if ($task) { $task.State } else { 'not installed' })"
Write-Output ''
Write-Output 'The update will:'
if ($SkipNpmInstall) {
  Write-Output '  1. Keep the existing node_modules.'
} else {
  Write-Output '  1. Install the exact dependencies from package-lock.json.'
}
Write-Output '  2. Build and verify a new immutable private PWA.'
Write-Output '  3. Refresh only Codexy-owned hooks and the codexy launcher.'
Write-Output '  4. Restart the existing Codexy startup task when it was running.'
Write-Output '  5. Restore the previous PWA configuration if the update fails.'

if ($isDryRun) {
  Write-Output ''
  Write-Output 'No files, hooks, tasks, or services were changed.'
  Write-Output 'To apply: npm.cmd run update:apply'
  exit 0
}

if (-not $Yes) {
  $answer = Read-Host 'Type UPDATE CODEXY to continue'
  if ($answer -cne 'UPDATE CODEXY') {
    Write-Output 'Cancelled. Nothing was changed.'
    exit 2
  }
}

if (Test-Path -LiteralPath $envBackupPath) {
  Remove-Item -LiteralPath $envBackupPath -Force
}
if (Test-Path -LiteralPath $envPath -PathType Leaf) {
  Copy-Item -LiteralPath $envPath -Destination $envBackupPath -Force
}

try {
  if ($taskWasRunning) {
    Write-Output ''
    Write-Output '==> Stop the current Codexy background task'
    Stop-ScheduledTask -TaskName $taskName
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 250
      $currentTask = Get-ScheduledTask -TaskName $taskName
    } while (
      $currentTask.State -eq 'Running' -and
      [DateTime]::UtcNow -lt $deadline
    )
    if ($currentTask.State -eq 'Running') {
      throw 'The Codexy background task did not stop within 15 seconds.'
    }
  }

  Push-Location -LiteralPath $projectRoot
  try {
    if (-not $SkipNpmInstall) {
      Invoke-Checked -Label 'Install locked dependencies' -Action {
        & $npm.Source ci
      }
    }

    $previousCodexCommand = $env:CODEXY_CODEX_COMMAND
    try {
      $env:CODEXY_CODEX_COMMAND = $codex.Source
      Invoke-Checked -Label 'Build and verify the private PWA' -Action {
        & $npm.Source run private:prepare
      }
    } finally {
      if ($null -eq $previousCodexCommand) {
        Remove-Item Env:CODEXY_CODEX_COMMAND -ErrorAction SilentlyContinue
      } else {
        $env:CODEXY_CODEX_COMMAND = $previousCodexCommand
      }
    }

    Write-Output ''
    Write-Output '==> Refresh Codexy hooks'
    & $hookInstaller -Apply

    Write-Output ''
    Write-Output '==> Refresh the codexy launcher'
    & $launcherInstaller
  } finally {
    Pop-Location
  }

  if ($taskWasRunning) {
    Write-Output ''
    Write-Output '==> Restart the Codexy background task'
    Start-ScheduledTask -TaskName $taskName
  }

  if (Test-Path -LiteralPath $envBackupPath) {
    Remove-Item -LiteralPath $envBackupPath -Force
  }
  Write-Output ''
  Write-Output 'Codexy update complete.'
  Write-Output 'Run codexy doctor, then refresh Codexy on iPhone.'
} catch {
  $updateError = $_
  Write-Warning 'Codexy update failed; restoring the previous PWA configuration.'
  if (Test-Path -LiteralPath $envBackupPath -PathType Leaf) {
    Copy-Item -LiteralPath $envBackupPath -Destination $envPath -Force
  }
  if ($taskWasRunning) {
    try {
      Start-ScheduledTask -TaskName $taskName
    } catch {
      Write-Warning 'The previous startup task could not be restarted automatically.'
    }
  }
  throw $updateError
}
