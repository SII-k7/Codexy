[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Apply,
  [switch]$InstallStartup,
  [switch]$SkipNpmInstall,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'

if ($DryRun -and $Apply) {
  throw 'Choose either -DryRun or -Apply, not both.'
}

# Safe by default: omitting -Apply never changes the project or user profile.
$isDryRun = -not $Apply
$projectRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot '..')
)
$packageJson = Join-Path $projectRoot 'package.json'
$packageLock = Join-Path $projectRoot 'package-lock.json'
$hookInstaller = Join-Path $PSScriptRoot 'install-global-hooks.ps1'
$launcherInstaller = Join-Path $PSScriptRoot 'install-codex-launcher.ps1'
$startupInstaller = Join-Path $PSScriptRoot 'install-private-pwa-task.ps1'

function Find-Command {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Names
  )

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      return $command
    }
  }
  return $null
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
}

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

Write-Output 'Codexy desktop setup'
Write-Output '===================='
Write-Output ''
if ($isDryRun) {
  Write-Output 'Mode: DRY RUN (default). No files, hooks, launchers, tasks, or routes will change.'
} else {
  Write-Output 'Mode: APPLY. The changes listed below will be made after confirmation.'
}
Write-Output ''
Write-Output 'Scope'
Write-Output "  Project: $projectRoot"
if (-not $SkipNpmInstall) {
  Write-Output '  1. Run npm ci inside this project.'
} else {
  Write-Output '  1. Keep the existing node_modules (-SkipNpmInstall).'
}
Write-Output '  2. Reuse npm run private:prepare to create .env.local and the private PWA build.'
Write-Output '  3. Copy Codexy hook runtime files to ~/.codex/codexy-hooks.'
Write-Output '  4. Merge only Codexy-owned entries into ~/.codex/hooks.json.'
Write-Output '  5. Reuse install-codex-launcher.ps1 to install codexy.cmd beside codex.cmd.'
if ($InstallStartup) {
  Write-Output '  6. Add the Codexy startup task and an independent Tailscale HTTPS :8443 route to localhost:8797.'
} else {
  Write-Output '  6. Do not create a startup task or change Tailscale Serve.'
}
Write-Output ''
Write-Output 'Explicitly out of scope'
Write-Output '  - No acx file, command, hook directory, state, or configuration is touched.'
Write-Output '  - Existing non-Codexy hooks are preserved.'
Write-Output '  - Codex App Server remains localhost-only on port 4510.'
Write-Output '  - Relay remains localhost-only on port 8797; Tailscale HTTPS is optional.'
Write-Output '  - Existing Tailscale HTTPS root routes are preserved; Codexy uses :8443.'

foreach ($requiredFile in @(
  $packageJson,
  $hookInstaller,
  $launcherInstaller,
  (Join-Path $PSScriptRoot 'configure-private-pwa.mjs')
)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Required Codexy file is missing: $requiredFile"
  }
}
if (-not $SkipNpmInstall -and -not (Test-Path -LiteralPath $packageLock -PathType Leaf)) {
  throw "npm ci requires the lock file: $packageLock"
}
if (
  $InstallStartup -and
  -not (Test-Path -LiteralPath $startupInstaller -PathType Leaf)
) {
  throw "Optional startup installer is missing: $startupInstaller"
}

$node = Find-Command -Names @('node.exe', 'node')
$npm = Find-Command -Names @('npm.cmd', 'npm')
$codex = Find-Command -Names @('codex.cmd')
$tailscale = Find-Command -Names @('tailscale.exe', 'tailscale')
if (-not $tailscale) {
  $defaultTailscale = 'C:\Program Files\Tailscale\tailscale.exe'
  if (Test-Path -LiteralPath $defaultTailscale -PathType Leaf) {
    $tailscale = Get-Item -LiteralPath $defaultTailscale
  }
}

Write-Output ''
Write-Output 'Environment'
Write-Output "  PowerShell: $($PSVersionTable.PSVersion)"
Write-Output "  Node:       $(if ($node) { $node.Source } else { 'MISSING' })"
Write-Output "  npm:        $(if ($npm) { $npm.Source } else { 'MISSING' })"
Write-Output "  Codex:      $(if ($codex) { $codex.Source } else { 'MISSING' })"
Write-Output "  Tailscale:  $(if ($tailscale) { $tailscale.Source } else { 'not found (only required with -InstallStartup)' })"

if (-not $node) {
  throw 'Node.js is required. Install a current Node.js LTS release, then run setup again.'
}
if (-not $npm) {
  throw 'npm is required. Repair the Node.js installation, then run setup again.'
}
if (-not $codex) {
  throw 'codex.cmd is required by the Windows launcher. Install Codex CLI and sign in before running setup.'
}
if ($InstallStartup -and -not $tailscale) {
  throw 'Tailscale is required with -InstallStartup. Install it and sign in on this PC first.'
}
if ($InstallStartup -and $Apply -and -not (Test-IsAdministrator)) {
  throw 'Run PowerShell as Administrator when combining -Apply with -InstallStartup.'
}

if ($isDryRun) {
  Write-Output ''
  & $hookInstaller -DryRun
  Write-Output ''
  Write-Output 'Dry run complete. Review the scope above.'
  Write-Output 'To perform it: .\scripts\setup-codexy.ps1 -Apply'
  Write-Output 'Optional startup/Tailscale: run as Administrator with -Apply -InstallStartup'
  exit 0
}

if (-not $Yes) {
  Write-Output ''
  $answer = Read-Host 'Type INSTALL CODEXY to continue'
  if ($answer -cne 'INSTALL CODEXY') {
    Write-Output 'Cancelled. Nothing was installed by this confirmation step.'
    exit 2
  }
}

Push-Location -LiteralPath $projectRoot
try {
  if (-not $SkipNpmInstall) {
    Invoke-Checked -Label 'Install locked Node dependencies' -Action {
      & $npm.Source ci
    }
  }

  Invoke-Checked -Label 'Prepare the private Codexy PWA' -Action {
    & $npm.Source run private:prepare
  }

  Write-Output ''
  Write-Output '==> Install privacy-minimized global Codex hooks'
  & $hookInstaller -Apply

  Write-Output ''
  Write-Output '==> Install the codexy launcher'
  & $launcherInstaller

  if ($InstallStartup) {
    Write-Output ''
    Write-Output '==> Install the optional startup task and Tailscale route'
    & $startupInstaller
  }
} finally {
  Pop-Location
}

Write-Output ''
Write-Output 'Codexy desktop setup is complete.'
Write-Output 'Next: run .\scripts\diagnose-codexy.ps1, then open the printed HTTPS URL on iPhone.'
Write-Output 'Start each phone-controllable Codex session with: codexy'
