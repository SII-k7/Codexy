$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot '..')
)
$launcherScript = Join-Path $PSScriptRoot 'start-controlled-codex.ps1'

if (-not (Test-Path -LiteralPath $launcherScript)) {
  throw "Missing launcher script: $launcherScript"
}

$realCodex = (Get-Command codex.cmd -ErrorAction Stop).Source
$targetDirectory = Split-Path -Parent $realCodex
$targetLauncher = Join-Path $targetDirectory 'codexy.cmd'
if (Test-Path -LiteralPath $targetLauncher) {
  $existing = Get-Content -LiteralPath $targetLauncher -Raw
  if ($existing -notlike '*Codexy launcher*') {
    throw "Refusing to overwrite an unrelated launcher: $targetLauncher"
  }
}

$launcherContent = @"
@echo off
rem Codexy launcher
set "CODEXY_CODEX_COMMAND=$realCodex"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$launcherScript" %*
"@
Set-Content -LiteralPath $targetLauncher -Value $launcherContent -Encoding Ascii

Write-Output 'Installed the Codexy Codex launcher.'
Write-Output "Launcher: $targetLauncher"
Write-Output 'Run: codexy'
Write-Output 'Each terminal that runs codexy becomes an independent phone-controllable track.'
