param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CodexArgs
)

$ErrorActionPreference = 'Stop'

$launcherArgs = @($CodexArgs)
$projectRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot '..')
)

if ($launcherArgs.Count -gt 0) {
  switch ($launcherArgs[0]) {
    'pair' {
      if ($launcherArgs.Count -ne 2) {
        [Console]::Error.WriteLine(
          'Usage: codexy pair <six-digit-code>'
        )
        exit 2
      }

      $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
      if (-not $nodeCommand) {
        $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
      }
      if (-not $nodeCommand) {
        throw 'Node.js is required to pair Codexy.'
      }

      $pairingScript = Join-Path $projectRoot 'relay\claim-pairing.mjs'
      if (-not (Test-Path -LiteralPath $pairingScript -PathType Leaf)) {
        throw "Codexy pairing command is missing: $pairingScript"
      }

      & $nodeCommand.Source $pairingScript $launcherArgs[1]
      exit $LASTEXITCODE
    }
    'doctor' {
      if ($launcherArgs.Count -ne 1) {
        [Console]::Error.WriteLine('Usage: codexy doctor')
        exit 2
      }

      $diagnosticScript = Join-Path $PSScriptRoot 'diagnose-codexy.ps1'
      if (-not (Test-Path -LiteralPath $diagnosticScript -PathType Leaf)) {
        throw "Codexy diagnostic command is missing: $diagnosticScript"
      }

      & $diagnosticScript
      exit 0
    }
  }
}

$appServerUrl = if ($env:CODEXY_CODEX_APP_SERVER_URL) {
  $env:CODEXY_CODEX_APP_SERVER_URL
} elseif ($env:ATTENTION_CODEX_APP_SERVER_URL) {
  $env:ATTENTION_CODEX_APP_SERVER_URL
} else {
  'ws://127.0.0.1:4510'
}

$codexCommand = if ($env:CODEXY_CODEX_COMMAND) {
  (Get-Item -LiteralPath $env:CODEXY_CODEX_COMMAND -ErrorAction Stop).FullName
} elseif ($env:ATTENTION_CODEX_COMMAND) {
  (Get-Item -LiteralPath $env:ATTENTION_CODEX_COMMAND -ErrorAction Stop).FullName
} else {
  (Get-Command codex.cmd -ErrorAction Stop).Source
}

& $codexCommand --remote $appServerUrl @launcherArgs
exit $LASTEXITCODE
