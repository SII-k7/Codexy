$ErrorActionPreference = 'Stop'

$taskName = 'Codexy Private PWA'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Write-Output 'Codexy private PWA startup task removed.'
Write-Output 'Tailscale Serve was left unchanged so unrelated routes are not removed.'
Write-Output 'If Codexy owns the only Serve route, remove it separately with: tailscale serve reset'
