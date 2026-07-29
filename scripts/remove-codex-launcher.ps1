$ErrorActionPreference = 'Stop'

$realCodex = (Get-Command codex.cmd -ErrorAction Stop).Source
$targetLauncher = Join-Path (Split-Path -Parent $realCodex) 'codexy.cmd'
if (Test-Path -LiteralPath $targetLauncher) {
  $existing = Get-Content -LiteralPath $targetLauncher -Raw
  if ($existing -like '*Codexy launcher*') {
    Remove-Item -LiteralPath $targetLauncher -Force
  } else {
    throw "Refusing to remove an unrelated launcher: $targetLauncher"
  }
}

Write-Output 'Removed the Codexy launcher.'
