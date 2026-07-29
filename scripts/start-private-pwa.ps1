$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot '..')
)
$nodeCandidates = @(
  (Get-Command node.exe -ErrorAction SilentlyContinue).Source,
  'E:\vibe coding\node.exe'
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

if (-not $nodeCandidates) {
  throw 'Node.js was not found. Install Node.js or update start-private-pwa.ps1.'
}

$envFile = Join-Path $projectRoot '.env.local'
$serverFile = Join-Path $projectRoot 'relay\server.mjs'
if (-not (Test-Path -LiteralPath $envFile)) {
  throw 'Missing .env.local. Run npm run private:configure first.'
}
$webRootLine = Get-Content -LiteralPath $envFile |
  Where-Object { $_ -match '^CODEXY_WEB_ROOT=' } |
  Select-Object -Last 1
if (-not $webRootLine) {
  throw 'Missing CODEXY_WEB_ROOT in .env.local. Run npm run private:prepare first.'
}
$webRootValue = ($webRootLine -split '=', 2)[1].Trim()
$webRootPath = if ([System.IO.Path]::IsPathRooted($webRootValue)) {
  [System.IO.Path]::GetFullPath($webRootValue)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $projectRoot $webRootValue))
}
if (-not (Test-Path -LiteralPath (Join-Path $webRootPath 'index.html'))) {
  throw 'Missing production Web build. Run npm run private:build first.'
}

Set-Location -LiteralPath $projectRoot
& $nodeCandidates[0] "--env-file-if-exists=$envFile" $serverFile --host 127.0.0.1
