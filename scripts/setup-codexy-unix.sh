#!/bin/sh
# Safe, user-local Codexy setup for Ubuntu and macOS.
set -eu

apply=0
assume_yes=0
install_service=1
skip_npm_install=0
enable_linger=1
configure_tailscale=0

while [ "$#" -gt 0 ]; do
  case $1 in
    --apply)
      apply=1
      ;;
    --yes)
      assume_yes=1
      ;;
    --no-service)
      install_service=0
      ;;
    --skip-npm-install)
      skip_npm_install=1
      ;;
    --no-linger)
      enable_linger=0
      ;;
    --tailscale)
      configure_tailscale=1
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ./scripts/setup-codexy-unix.sh [options]

  --apply             Perform the installation (default is a dry run)
  --yes               Do not ask for interactive confirmation
  --no-service        Do not register a background service
  --skip-npm-install  Reuse the existing node_modules
  --no-linger         Do not try to keep the Linux user service after logout
  --tailscale          Add a private Tailscale HTTPS :8443 route
EOF
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$script_directory/.." && pwd)
codex_home=${CODEX_HOME:-"$HOME/.codex"}
current_user=${USER:-$(id -un)}
runtime_directory="$codex_home/codexy"
hook_source="$script_directory/global-codex-hooks"
hook_manager="$script_directory/manage-global-hooks.mjs"

for required_file in \
  "$project_root/relay/claim-pairing.mjs" \
  "$script_directory/diagnose-codexy-unix.mjs"
do
  if [ ! -f "$required_file" ]; then
    printf 'Missing launcher dependency: %s\n' "$required_file" >&2
    exit 1
  fi
done

command_path() {
  command -v "$1" 2>/dev/null || true
}

require_command() {
  required_name=$1
  required_path=$(command_path "$required_name")
  if [ -z "$required_path" ]; then
    printf 'Missing required command: %s\n' "$required_name" >&2
    exit 1
  fi
  printf '%s\n' "$required_path"
}

write_managed_file() {
  target_path=$1
  temporary_path="${target_path}.codexy-$$.tmp"
  umask 077
  cat > "$temporary_path"
  chmod 700 "$temporary_path"
  mv "$temporary_path" "$target_path"
}

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

os_name=$(uname -s)
case $os_name in
  Darwin)
    platform=macos
    ;;
  Linux)
    platform=linux
    if [ -r /etc/os-release ]; then
      # shellcheck disable=SC1091
      . /etc/os-release
      case ${ID:-} in
        ubuntu|debian)
          ;;
        *)
          case " ${ID_LIKE:-} " in
            *" ubuntu "*|*" debian "*)
              ;;
            *)
              printf '%s\n' \
                'This Linux installer is currently supported on Ubuntu/Debian systems.' >&2
              exit 1
              ;;
          esac
          ;;
      esac
    fi
    ;;
  *)
    printf '%s\n' 'This installer supports Ubuntu and macOS only.' >&2
    exit 1
    ;;
esac

node_command=$(require_command node)
npm_command=$(require_command npm)
codex_command=$(require_command codex)
node_path=$("$node_command" -p 'process.execPath')
if ! "$node_path" -e '
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  const atLeast = (requiredMinor, requiredPatch) =>
    minor > requiredMinor ||
    (minor === requiredMinor && patch >= requiredPatch);
  const supported =
    (major === 20 && atLeast(19, 4)) ||
    (major === 22 && atLeast(13, 0)) ||
    (major === 24 && atLeast(3, 0)) ||
    major >= 25;
  process.exit(supported ? 0 : 1);
'; then
  printf 'A current Node.js LTS release is required; found %s.\n' \
    "$("$node_path" --version)" >&2
  exit 1
fi
if ! "$codex_command" --version >/dev/null 2>&1; then
  printf '%s\n' 'Codex CLI is installed but could not be started.' >&2
  exit 1
fi

launcher_directory="$HOME/.local/bin"
launcher_path="$launcher_directory/codexy"
runner_path="$launcher_directory/codexy-relay"
install_record="$runtime_directory/install.json"
if [ -e "$launcher_path" ] &&
  ! grep -q '^# Codexy managed launcher$' "$launcher_path" 2>/dev/null; then
  printf 'Refusing to overwrite an unrelated launcher: %s\n' \
    "$launcher_path" >&2
  exit 1
fi
if [ -e "$runner_path" ] &&
  ! grep -q '^# Codexy managed Relay runner$' "$runner_path" 2>/dev/null; then
  printf 'Refusing to overwrite an unrelated Relay runner: %s\n' \
    "$runner_path" >&2
  exit 1
fi
if [ "$install_service" -eq 1 ]; then
  if [ "$platform" = linux ]; then
    require_command systemctl >/dev/null
    if ! systemctl --user show-environment >/dev/null 2>&1; then
      printf '%s\n' \
        'The systemd user session is unavailable. Log in through a normal SSH session, then run setup again.' >&2
      printf '%s\n' \
        'Advanced fallback: rerun with --no-service and start ~/.local/bin/codexy-relay manually.' >&2
      exit 1
    fi
    existing_service="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/codexy.service"
    if [ -e "$existing_service" ] &&
      ! grep -q '^Description=Codexy private Relay' "$existing_service" 2>/dev/null; then
      printf 'Refusing to overwrite an unrelated service: %s\n' \
        "$existing_service" >&2
      exit 1
    fi
  else
    require_command launchctl >/dev/null
    existing_service="$HOME/Library/LaunchAgents/com.codexy.relay.plist"
    if [ -e "$existing_service" ] &&
      ! grep -q '<string>com.codexy.relay</string>' "$existing_service" 2>/dev/null; then
      printf 'Refusing to overwrite an unrelated LaunchAgent: %s\n' \
        "$existing_service" >&2
      exit 1
    fi
  fi
fi

printf '%s\n' 'Codexy setup for Ubuntu/macOS'
printf '%s\n' '=============================='
printf 'Mode:       %s\n' "$(if [ "$apply" -eq 1 ]; then printf APPLY; else printf 'DRY RUN'; fi)"
printf 'Platform:   %s\n' "$platform"
printf 'Project:    %s\n' "$project_root"
printf 'Node:       %s (%s)\n' "$node_path" "$("$node_path" --version)"
printf 'Codex CLI:  %s\n' "$codex_command"
printf 'Hooks:      %s\n' "$codex_home/hooks.json"
printf 'Launcher:   %s\n' "$launcher_path"
printf 'Relay:      http://127.0.0.1:8797 (loopback only)\n'
if [ "$install_service" -eq 1 ]; then
  printf 'Background: %s\n' \
    "$(if [ "$platform" = linux ]; then printf 'systemd user service'; else printf 'macOS LaunchAgent'; fi)"
else
  printf '%s\n' 'Background: disabled by --no-service'
fi
if [ "$configure_tailscale" -eq 1 ]; then
  if [ "$install_service" -ne 1 ]; then
    printf '%s\n' '--tailscale cannot be combined with --no-service.' >&2
    exit 2
  fi
  tailscale_command=$(require_command tailscale)
  if ! "$tailscale_command" status >/dev/null 2>&1; then
    printf '%s\n' \
      'Tailscale is installed but not connected. Sign in, then run setup again.' >&2
    exit 1
  fi
  tailscale_https_port=${CODEXY_TAILSCALE_HTTPS_PORT:-8443}
  case $tailscale_https_port in
    ''|*[!0-9]*)
      printf '%s\n' 'CODEXY_TAILSCALE_HTTPS_PORT must be a number.' >&2
      exit 1
      ;;
  esac
  if [ "$tailscale_https_port" -lt 1 ] ||
    [ "$tailscale_https_port" -gt 65535 ]; then
    printf '%s\n' 'CODEXY_TAILSCALE_HTTPS_PORT must be between 1 and 65535.' >&2
    exit 1
  fi
  printf 'Tailscale:   private HTTPS :%s -> localhost:8797\n' \
    "$tailscale_https_port"
fi
printf '\n%s\n' 'The installer will preserve non-Codexy hooks and will not expose a public port.'

if [ "$apply" -ne 1 ]; then
  printf '\n%s\n' 'Dry run complete. Nothing was changed.'
  printf '%s\n' 'Apply with: ./scripts/setup-codexy-unix.sh --apply'
  exit 0
fi

if [ "$assume_yes" -ne 1 ]; then
  printf '\n%s' 'Type INSTALL CODEXY to continue: '
  if [ -r /dev/tty ]; then
    IFS= read -r confirmation < /dev/tty
  else
    IFS= read -r confirmation
  fi
  if [ "$confirmation" != 'INSTALL CODEXY' ]; then
    printf '%s\n' 'Cancelled. Nothing was installed.'
    exit 2
  fi
fi

if [ "$skip_npm_install" -ne 1 ]; then
  printf '\n%s\n' '==> Installing locked Node dependencies'
  (
    cd "$project_root"
    "$npm_command" ci --no-audit --no-fund
  )
fi

printf '\n%s\n' '==> Building the private Codexy PWA'
(
  cd "$project_root"
  CODEXY_CODEX_COMMAND="$codex_command" \
    "$npm_command" run private:prepare
)

printf '\n%s\n' '==> Installing privacy-minimized global Codex hooks'
"$node_path" "$hook_manager" install \
  --source-dir "$hook_source" \
  --codex-home "$codex_home" \
  --node "$node_path"

mkdir -p "$runtime_directory"
chmod 700 "$runtime_directory"
if [ ! -d "$launcher_directory" ]; then
  mkdir -p "$launcher_directory"
  chmod 700 "$launcher_directory"
fi

quoted_project_root=$(shell_quote "$project_root")
quoted_node_path=$(shell_quote "$node_path")
quoted_codex_command=$(shell_quote "$codex_command")
quoted_codex_home=$(shell_quote "$codex_home")
quoted_service_manager=$(shell_quote "$script_directory/manage-codexy-service-unix.sh")
quoted_diagnose=$(shell_quote "$script_directory/diagnose-codexy-unix.mjs")
quoted_uninstall=$(shell_quote "$script_directory/uninstall-codexy-unix.sh")
quoted_installer=$(shell_quote "$project_root/install.sh")

write_managed_file "$launcher_path" <<EOF
#!/bin/sh
# Codexy managed launcher
set -eu
project_root=$quoted_project_root
node_path=$quoted_node_path
codex_command=$quoted_codex_command
service_manager=$quoted_service_manager
export CODEX_HOME=$quoted_codex_home

case "\${1:-}" in
  pair)
    shift
    if [ "\$#" -ne 1 ]; then
      printf '%s\n' 'Usage: codexy pair <six-digit-code>' >&2
      exit 2
    fi
    exec "\$node_path" "\$project_root/relay/claim-pairing.mjs" "\$1"
    ;;
  doctor)
    shift
    if [ "\$#" -ne 0 ]; then
      printf '%s\n' 'Usage: codexy doctor' >&2
      exit 2
    fi
    exec "\$node_path" $quoted_diagnose "\$@"
    ;;
  service)
    shift
    exec /bin/sh "\$service_manager" "\${1:-status}"
    ;;
  logs)
    shift
    exec /bin/sh "\$service_manager" logs
    ;;
  update)
    shift
    exec /bin/sh $quoted_installer --update "\$@"
    ;;
  uninstall)
    shift
    exec /bin/sh $quoted_uninstall --apply "\$@"
    ;;
esac

exec "\$codex_command" --remote \
  "\${CODEXY_CODEX_APP_SERVER_URL:-ws://127.0.0.1:4510}" "\$@"
EOF

if ! printf '%s' ":$PATH:" | grep -F ":$launcher_directory:" >/dev/null 2>&1; then
  if [ "$platform" = macos ]; then
    profile_path="$HOME/.zprofile"
  else
    profile_path="$HOME/.profile"
  fi
  if ! grep -F '# Codexy user commands' "$profile_path" >/dev/null 2>&1; then
    {
      printf '\n%s\n' '# Codexy user commands'
      printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"'
    } >> "$profile_path"
  fi
fi

quoted_env_file=$(shell_quote "$project_root/.env.local")
quoted_server_file=$(shell_quote "$project_root/relay/server.mjs")
write_managed_file "$runner_path" <<EOF
#!/bin/sh
# Codexy managed Relay runner
set -eu
export CODEX_HOME=$quoted_codex_home
cd $quoted_project_root
exec $quoted_node_path --env-file=$quoted_env_file \
  $quoted_server_file --host 127.0.0.1
EOF

"$node_path" - "$install_record" "$project_root" "$launcher_path" "$platform" <<'NODE'
const [path, projectRoot, launcherPath, platform] = process.argv.slice(2);
const { writeFileSync } = require('node:fs');
writeFileSync(
  path,
  `${JSON.stringify({
    managedBy: 'Codexy',
    installedAtUtc: new Date().toISOString(),
    projectRoot,
    launcherPath,
    platform,
  }, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o600 },
);
NODE

if [ "$install_service" -eq 1 ]; then
  printf '\n%s\n' '==> Registering the Codexy background service'
  if [ "$platform" = linux ]; then
    service_directory="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    service_path="$service_directory/codexy.service"
    mkdir -p "$service_directory"
    cat > "$service_path" <<'EOF'
[Unit]
Description=Codexy private Relay and Codex App Server
After=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/bin/codexy-relay
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
    chmod 600 "$service_path"
    systemctl --user daemon-reload
    systemctl --user enable codexy.service
    systemctl --user restart codexy.service

    if [ "$enable_linger" -eq 1 ] && command -v loginctl >/dev/null 2>&1; then
      linger_state=$(loginctl show-user "$current_user" -p Linger --value 2>/dev/null || true)
      if [ "$linger_state" != yes ]; then
        if loginctl enable-linger "$current_user" >/dev/null 2>&1; then
          :
        elif command -v sudo >/dev/null 2>&1 && [ -r /dev/tty ]; then
          printf '%s\n' \
            'One sudo confirmation keeps Codexy running after the SSH session closes.'
          sudo loginctl enable-linger "$current_user" < /dev/tty
        else
          printf '%s\n' \
            "Warning: run 'sudo loginctl enable-linger $current_user' to keep Codexy online after logout." >&2
        fi
      fi
    fi
  else
    launch_agents="$HOME/Library/LaunchAgents"
    plist_path="$launch_agents/com.codexy.relay.plist"
    log_directory="$runtime_directory"
    mkdir -p "$launch_agents"
    escaped_runner=$(printf '%s' "$runner_path" | sed \
      -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
    escaped_stdout=$(printf '%s' "$log_directory/relay.stdout.log" | sed \
      -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
    escaped_stderr=$(printf '%s' "$log_directory/relay.stderr.log" | sed \
      -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
    cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.codexy.relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>$escaped_runner</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$escaped_stdout</string>
  <key>StandardErrorPath</key>
  <string>$escaped_stderr</string>
</dict>
</plist>
EOF
    chmod 600 "$plist_path"
    service_domain="gui/$(id -u)"
    launchctl bootout "$service_domain/com.codexy.relay" >/dev/null 2>&1 || true
    if ! launchctl bootstrap "$service_domain" "$plist_path"; then
      service_domain="user/$(id -u)"
      launchctl bootout "$service_domain/com.codexy.relay" >/dev/null 2>&1 || true
      launchctl bootstrap "$service_domain" "$plist_path"
    fi
    printf '%s\n' "$service_domain" > "$runtime_directory/service-domain"
    chmod 600 "$runtime_directory/service-domain"
    launchctl kickstart -k "$service_domain/com.codexy.relay"
  fi
fi

if [ "$install_service" -eq 1 ]; then
  printf '\n%s\n' '==> Verifying the local Relay'
  relay_ready=0
  attempt=0
  while [ "$attempt" -lt 12 ]; do
    if "$node_path" -e \
      "fetch('http://127.0.0.1:8797/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
      relay_ready=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  if [ "$relay_ready" -ne 1 ]; then
    printf '%s\n' \
      "Codexy was installed, but the Relay health check failed. Run '$launcher_path doctor'." >&2
    exit 1
  fi
fi

if [ "$configure_tailscale" -eq 1 ]; then
  printf '\n%s\n' '==> Adding the private Tailscale HTTPS route'
  "$tailscale_command" serve --bg "--https=$tailscale_https_port" 8797
  "$tailscale_command" serve status
fi

printf '\n%s\n' 'Codexy installation is complete.'
printf 'Launcher: %s\n' "$launcher_path"
printf '%s\n' 'Start a controllable CLI session in any project with: codexy'
printf '%s\n' 'Pair the six-digit phone code with: codexy pair 123456'
printf '%s\n' 'Check the installation with: codexy doctor'
if [ "$configure_tailscale" -eq 1 ]; then
  printf 'Open the .ts.net HTTPS address above with :%s on iPhone Safari.\n' \
    "$tailscale_https_port"
fi
printf '\n%s\n' 'For a server without Tailscale, keep port 8797 private and use an SSH tunnel from a Tailscale-enabled computer:'
printf '%s\n' '  ssh -N -L 127.0.0.1:8798:127.0.0.1:8797 user@server'
printf '%s\n' 'Then expose only that local tunnel on the gateway computer with Tailscale Serve.'
if ! printf '%s' ":$PATH:" | grep -F ":$launcher_directory:" >/dev/null 2>&1; then
  printf '\nRun this once in the current terminal, or open a new terminal:\n'
  printf '  export PATH="%s:$PATH"\n' "$launcher_directory"
fi
