#!/bin/sh
set -eu

apply=0
assume_yes=0
purge_state=0
while [ "$#" -gt 0 ]; do
  case $1 in
    --apply)
      apply=1
      ;;
    --yes)
      assume_yes=1
      ;;
    --purge-state)
      purge_state=1
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
codex_home=${CODEX_HOME:-"$HOME/.codex"}
runtime_directory="$codex_home/codexy"
install_record="$runtime_directory/install.json"
node_path_file="$codex_home/codexy-hooks/node-path"
runner_path="$HOME/.local/bin/codexy-relay"
launcher_path=

if [ -r "$install_record" ]; then
  node_for_record=$(command -v node 2>/dev/null || true)
  if [ -n "$node_for_record" ]; then
    launcher_path=$("$node_for_record" -e \
      "try{process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).launcherPath||'')}catch{}" \
      "$install_record")
  fi
fi

printf '%s\n' 'Codexy safe uninstall'
printf '%s\n' '====================='
printf 'Mode: %s\n' "$(if [ "$apply" -eq 1 ]; then printf APPLY; else printf 'DRY RUN'; fi)"
printf '%s\n' 'Will remove the Codexy background service, launcher, and only Codexy-owned hooks.'
if [ "$purge_state" -eq 1 ]; then
  printf '%s\n' 'Relay pairing state and logs will also be removed.'
else
  printf 'Relay pairing state and logs will be preserved at %s.\n' "$runtime_directory"
fi

if [ "$apply" -ne 1 ]; then
  printf '%s\n' 'Nothing was changed. Apply with: codexy uninstall --yes'
  exit 0
fi
if [ "$assume_yes" -ne 1 ]; then
  printf '%s' 'Type UNINSTALL CODEXY to continue: '
  if [ -r /dev/tty ]; then
    IFS= read -r confirmation < /dev/tty
  else
    IFS= read -r confirmation
  fi
  if [ "$confirmation" != 'UNINSTALL CODEXY' ]; then
    printf '%s\n' 'Cancelled.'
    exit 2
  fi
fi

case $(uname -s) in
  Linux)
    systemctl --user disable --now codexy.service >/dev/null 2>&1 || true
    service_path="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/codexy.service"
    [ ! -f "$service_path" ] || rm -f "$service_path"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    ;;
  Darwin)
    domain_file="$runtime_directory/service-domain"
    if [ -r "$domain_file" ]; then
      IFS= read -r service_domain < "$domain_file"
    else
      service_domain="gui/$(id -u)"
    fi
    launchctl bootout "$service_domain/com.codexy.relay" >/dev/null 2>&1 || true
    rm -f "$HOME/Library/LaunchAgents/com.codexy.relay.plist"
    ;;
esac

if [ -n "$launcher_path" ] && [ -f "$launcher_path" ]; then
  if grep -q '^# Codexy managed launcher$' "$launcher_path"; then
    rm -f "$launcher_path"
  else
    printf 'Preserved unrelated launcher: %s\n' "$launcher_path" >&2
  fi
fi
if [ -f "$runner_path" ]; then
  if grep -q '^# Codexy managed Relay runner$' "$runner_path"; then
    rm -f "$runner_path"
  else
    printf 'Preserved unrelated Relay runner: %s\n' "$runner_path" >&2
  fi
fi

if [ -r "$node_path_file" ]; then
  IFS= read -r node_path < "$node_path_file"
else
  node_path=$(command -v node 2>/dev/null || true)
fi
if [ -n "$node_path" ]; then
  "$node_path" "$script_directory/manage-global-hooks.mjs" remove \
    --codex-home "$codex_home"
else
  printf '%s\n' 'Node.js is missing; Codexy hook entries were not removed.' >&2
fi

if [ "$purge_state" -eq 1 ] && [ -d "$runtime_directory" ]; then
  expected_runtime="$codex_home/codexy"
  if [ "$runtime_directory" != "$expected_runtime" ]; then
    printf 'Refusing to remove unexpected runtime path: %s\n' \
      "$runtime_directory" >&2
    exit 1
  fi
  rm -rf "$runtime_directory"
else
  rm -f "$runtime_directory/service-domain" \
    "$runtime_directory/install.json"
fi

printf '%s\n' 'Codexy was removed. The original Codex CLI was not changed.'
