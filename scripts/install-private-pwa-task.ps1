$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdministrator = $principal.IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdministrator) {
  throw 'Open PowerShell as Administrator, then run npm.cmd run private:install-startup again.'
}

$projectRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot '..')
)
$startScript = Join-Path $PSScriptRoot 'start-private-pwa.ps1'
$taskName = 'Codexy Private PWA'
$tailscaleHttpsPort = 8443
$powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $tailscale) {
  $defaultTailscale = 'C:\Program Files\Tailscale\tailscale.exe'
  if (Test-Path -LiteralPath $defaultTailscale) {
    $tailscale = Get-Item -LiteralPath $defaultTailscale
  }
}
if (-not $tailscale) {
  throw 'Tailscale was not found. Install it and sign in on this PC first.'
}

$action = New-ScheduledTaskAction `
  -Execute $powerShell `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Runs the private Codexy PWA and Relay on localhost.' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
& $tailscale.Source serve --bg "--https=$tailscaleHttpsPort" 8797
if ($LASTEXITCODE -ne 0) {
  throw "Tailscale Serve failed with exit code $LASTEXITCODE."
}
& $tailscale.Source serve status

Write-Output ''
Write-Output 'Codexy private PWA startup task installed.'
Write-Output "Codexy uses the independent HTTPS port $tailscaleHttpsPort so an existing root route is preserved."
Write-Output "Open the HTTPS .ts.net URL with :$tailscaleHttpsPort on iPhone Safari."
