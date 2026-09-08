#!/bin/sh
set -eu

codex_home=${CODEX_HOME:-"$HOME/.codex"}
runtime_directory=${CODEXY_HOOK_RUNTIME_DIR:-"$codex_home/codexy-hooks"}
node_path_file="$runtime_directory/node-path"

if [ ! -r "$node_path_file" ]; then
  printf '%s\n' 'codexy prompt hook skipped: missing Node.js path' >&2
  exit 0
fi

IFS= read -r node_path < "$node_path_file"
if [ ! -x "$node_path" ]; then
  printf '%s\n' 'codexy prompt hook skipped: Node.js is unavailable' >&2
  exit 0
fi

exec "$node_path" "$runtime_directory/capture_prompt.mjs"
