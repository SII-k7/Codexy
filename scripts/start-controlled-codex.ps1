param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CodexArgs
)

$ErrorActionPreference = 'Stop'

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

& $codexCommand --remote $appServerUrl @CodexArgs
exit $LASTEXITCODE
