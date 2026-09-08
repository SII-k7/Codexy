# Codexy Codex hooks

This is the reviewed, Codex-only hook bundle for Codexy. Install these
runtime files under:

- Windows: `%USERPROFILE%\.codex\codexy-hooks`
- Ubuntu/macOS: `${CODEX_HOME:-$HOME/.codex}/codexy-hooks`

- `capture_prompt.cmd`
- `capture_prompt.mjs`
- `capture_prompt.sh`
- `hook_common.mjs`
- `notify_mobile.cmd`
- `notify_mobile.mjs`
- `notify_mobile.sh`
- `hooks.json` (the hook definitions to review and merge into Codex)

The hook commands in `hooks.json` use the current user profile or home
directory; they do not contain a developer machine path or a path back to
this repository. Unix setup records the absolute Node.js executable in the
managed runtime so hooks also work when systemd or launchd has a minimal PATH.

## What leaves the PC

- `PermissionRequest`, `Stop`, and `SessionEnd` send a small Codex lifecycle
  payload with a hashed `session_ref`.
- `UserPromptSubmit` sends at most the latest ten prompts retained by the
  Relay. Before sending, the hook replaces fenced code, paths, links, email
  addresses, and suspected secrets.

Prompt text is never included in a push notification. Assistant messages,
transcripts, tool inputs, tool outputs, and shell history are not read. The
hooks use Codexy's required Node.js runtime; Python is not required.

## Isolated defaults

Codexy defaults to:

- Relay endpoints on `http://127.0.0.1:8797`;
- state at `~/.codex/codexy/relay-state.json`;
- hook logs at `~/.codex/codexy/hook.log`.

`CODEXY_*` variables take priority. Explicit legacy `ATTENTION_*` variables
remain accepted for migration, but no Codexy default points to the old app.
Useful overrides are:

- `CODEXY_RELAY_URL`
- `CODEXY_PROMPT_RELAY_URL`
- `CODEXY_RELAY_TOKEN`
- `CODEXY_RELAY_STATE_FILE`
- `CODEXY_PROJECT_ALIAS`
- `CODEXY_NODE`
- `CODEXY_HOOK_LOG`

The installed commands always return success, so notification or Relay
failures cannot block Codex. Review new or changed hooks through `/hooks`
before enabling them.
