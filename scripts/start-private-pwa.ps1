$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot '..')
)
$envFile = Join-Path $projectRoot '.env.local'
$logDirectory = Join-Path $env:USERPROFILE '.codex\codexy'
$logPath = Join-Path $logDirectory 'relay.log'
$previousLogPath = Join-Path $logDirectory 'relay.log.1'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
if (
  (Test-Path -LiteralPath $logPath -PathType Leaf) -and
  (Get-Item -LiteralPath $logPath).Length -gt 5MB
) {
  Move-Item `
    -LiteralPath $logPath `
    -Destination $previousLogPath `
    -Force
}
trap {
  $detail = ($_ | Out-String).Trim()
  Add-Content `
    -LiteralPath $logPath `
    -Value "[$([DateTime]::UtcNow.ToString('o'))] startup_failed: $detail"
  exit 1
}

if (-not (Test-Path -LiteralPath $envFile)) {
  throw 'Missing .env.local. Run npm run private:configure first.'
}
$nodeCommandLine = Get-Content -LiteralPath $envFile |
  Where-Object { $_ -match '^CODEXY_NODE_COMMAND=' } |
  Select-Object -Last 1
$configuredNode = if ($nodeCommandLine) {
  (($nodeCommandLine -split '=', 2)[1].Trim() -replace '^"(.*)"$', '$1')
} else {
  $null
}
$nodeCandidates = @(
  $configuredNode,
  (Get-Command node.exe -ErrorAction SilentlyContinue).Source
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

if (-not $nodeCandidates) {
  throw 'Node.js was not found. Install Node.js or update start-private-pwa.ps1.'
}

$serverFile = Join-Path $projectRoot 'relay\server.mjs'
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
# Windows PowerShell turns native stderr into terminating ErrorRecords under
# ErrorActionPreference=Stop. Redirect at the process boundary instead so a
# recoverable Relay/App Server diagnostic cannot terminate the entire service.
$stderrPath = Join-Path $logDirectory 'relay-stderr.log'
$relayProcess = Start-Process `
  -FilePath $nodeCandidates[0] `
  -ArgumentList @("`"--env-file-if-exists=$envFile`"", "`"$serverFile`"", '--host', '127.0.0.1') `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logPath `
  -RedirectStandardError $stderrPath `
  -PassThru
# Retain the native handle before waiting: Windows PowerShell otherwise may
# return a null ExitCode after the process exits, hiding a real service failure.
$null = $relayProcess.Handle
$relayProcess.WaitForExit()
exit $relayProcess.ExitCode
