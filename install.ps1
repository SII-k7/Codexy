[CmdletBinding()]
param(
  [switch]$NoStartup,
  [switch]$SkipNpmInstall
)

$ErrorActionPreference = 'Stop'
$repositoryUrl = if ($env:CODEXY_REPOSITORY_URL) {
  $env:CODEXY_REPOSITORY_URL
} else {
  'https://github.com/SII-k7/Codexy.git'
}
$repositoryRef = if ($env:CODEXY_REF) { $env:CODEXY_REF } else { 'main' }
$defaultInstallDirectory = Join-Path $env:LOCALAPPDATA 'Codexy\source'
$installDirectory = if ($env:CODEXY_INSTALL_DIR) {
  [System.IO.Path]::GetFullPath($env:CODEXY_INSTALL_DIR)
} else {
  [System.IO.Path]::GetFullPath($defaultInstallDirectory)
}

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [switch]$Capture
  )

  if ($Capture) {
    $result = & $script:git.Source @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
    return ($result | Out-String).Trim()
  }
  & $script:git.Source @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
}

function Find-Tailscale {
  $command = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command
  }
  $defaultPath = 'C:\Program Files\Tailscale\tailscale.exe'
  if (Test-Path -LiteralPath $defaultPath -PathType Leaf) {
    return Get-Item -LiteralPath $defaultPath
  }
  return $null
}

$localSource = $null
if (
  $PSScriptRoot -and
  (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'package.json')) -and
  (Test-Path -LiteralPath (
    Join-Path $PSScriptRoot 'scripts\setup-codexy.ps1'
  ))
) {
  $localSource = [System.IO.Path]::GetFullPath($PSScriptRoot)
}

if ($localSource) {
  $sourceDirectory = $localSource
} else {
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) {
    $git = Get-Command git -ErrorAction SilentlyContinue
  }
  if (-not $git) {
    throw 'Git is required. Install Git for Windows, then run this command again.'
  }

  if (Test-Path -LiteralPath $installDirectory) {
    $gitDirectory = Join-Path $installDirectory '.git'
    if (-not (Test-Path -LiteralPath $gitDirectory -PathType Container)) {
      throw "Codexy refuses to replace an unrelated path: $installDirectory"
    }
    $origin = Invoke-Git `
      -Arguments @('-C', $installDirectory, 'remote', 'get-url', 'origin') `
      -Capture
    $acceptedOrigins = @(
      $repositoryUrl,
      'https://github.com/SII-k7/Codexy',
      'https://github.com/SII-k7/Codexy.git',
      'git@github.com:SII-k7/Codexy.git'
    )
    if ($origin -notin $acceptedOrigins) {
      throw "Codexy refuses to update a checkout from another origin: $origin"
    }
    $dirty = Invoke-Git `
      -Arguments @(
        '-C',
        $installDirectory,
        'status',
        '--porcelain',
        '--untracked-files=no'
      ) `
      -Capture
    if ($dirty) {
      throw 'Codexy update stopped because its managed checkout has local changes.'
    }
    Invoke-Git -Arguments @(
      '-C',
      $installDirectory,
      'fetch',
      '--depth',
      '1',
      'origin',
      $repositoryRef
    )
    $currentBranch = & $git.Source `
      -C $installDirectory symbolic-ref --short HEAD 2>$null
    if ($currentBranch -eq $repositoryRef) {
      Invoke-Git -Arguments @(
        '-C',
        $installDirectory,
        'merge',
        '--ff-only',
        'FETCH_HEAD'
      )
    } else {
      Invoke-Git -Arguments @(
        '-C',
        $installDirectory,
        'checkout',
        '-B',
        $repositoryRef,
        'FETCH_HEAD'
      )
    }
  } else {
    New-Item `
      -ItemType Directory `
      -Path (Split-Path -Parent $installDirectory) `
      -Force | Out-Null
    Invoke-Git -Arguments @(
      'clone',
      '--depth',
      '1',
      '--branch',
      $repositoryRef,
      $repositoryUrl,
      $installDirectory
    )
  }
  $sourceDirectory = $installDirectory
}

$setupScript = Join-Path $sourceDirectory 'scripts\setup-codexy.ps1'
if (-not (Test-Path -LiteralPath $setupScript -PathType Leaf)) {
  throw "Codexy setup script is missing: $setupScript"
}

$setupArguments = @(
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  "`"$setupScript`"",
  '-Apply',
  '-Yes'
)
if ($SkipNpmInstall) {
  $setupArguments += '-SkipNpmInstall'
}

if (-not $NoStartup) {
  $tailscale = Find-Tailscale
  if (-not $tailscale) {
    throw @'
Tailscale is required for the default one-command Windows setup.
Install Tailscale, sign in on this PC, then run the Codexy command again.
Use -NoStartup only for advanced local-only installation.
'@
  }
  & $tailscale.Source status *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'Tailscale is installed but not connected. Sign in, then run setup again.'
  }
  $setupArguments += '-InstallStartup'
}

if (-not $NoStartup -and -not (Test-IsAdministrator)) {
  Write-Output 'Windows will show one UAC confirmation to install background startup.'
  $process = Start-Process `
    -FilePath 'powershell.exe' `
    -Verb RunAs `
    -Wait `
    -PassThru `
    -ArgumentList $setupArguments
  if ($process.ExitCode -ne 0) {
    throw "Elevated Codexy setup failed with exit code $($process.ExitCode)."
  }
} else {
  & powershell.exe @setupArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Codexy setup failed with exit code $LASTEXITCODE."
  }
}

Write-Output ''
Write-Output 'Codexy is ready.'
Write-Output 'Pair the six-digit phone code with: codexy pair 123456'
Write-Output 'Check the installation with: codexy doctor'
Write-Output 'Start a phone-controllable Codex session with: codexy'
