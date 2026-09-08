$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot '..')
)
$launcherScript = Join-Path $PSScriptRoot 'start-controlled-codex.ps1'
$pairingScript = Join-Path $projectRoot 'relay\claim-pairing.mjs'
$diagnosticScript = Join-Path $PSScriptRoot 'diagnose-codexy.ps1'

foreach ($requiredScript in @(
  $launcherScript,
  $pairingScript,
  $diagnosticScript
)) {
  if (-not (Test-Path -LiteralPath $requiredScript -PathType Leaf)) {
    throw "Missing launcher dependency: $requiredScript"
  }
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
exit /b %ERRORLEVEL%
"@
Set-Content -LiteralPath $targetLauncher -Value $launcherContent -Encoding Ascii

Write-Output 'Installed the Codexy Codex launcher.'
Write-Output "Launcher: $targetLauncher"
Write-Output 'Run: codexy'
Write-Output 'Pair the six-digit phone code with: codexy pair 123456'
Write-Output 'Check the installation with: codexy doctor'
Write-Output 'Each terminal that runs codexy becomes an independent phone-controllable track.'
