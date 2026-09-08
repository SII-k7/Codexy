#!/bin/sh
# The deployment account runs this one reviewed operation with sudo.
# Never changes Docker socket permissions, sudo rules, or other containers.
set -eu
if [ "$(id -u)" != 0 ]; then printf 'Run this installer with sudo.\n' >&2; exit 1; fi
deploy_dir=${1:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}
tailscale_bin=${CODEXY_TAILSCALE_BIN:-$(command -v tailscale || true)}
if [ -z "$tailscale_bin" ]; then tailscale_bin=/var/apps/tailscale/target/bin/tailscale; fi
tailscale_socket=${CODEXY_TAILSCALE_SOCKET:-}
if [ -z "$tailscale_socket" ] && [ "$tailscale_bin" = /var/apps/tailscale/target/bin/tailscale ]; then
  tailscale_socket=/vol1/@appdata/tailscale/tailscaled.sock
fi
run_tailscale() {
  if [ -n "$tailscale_socket" ]; then "$tailscale_bin" --socket="$tailscale_socket" "$@";
  else "$tailscale_bin" "$@"; fi
}
cd "$deploy_dir"
test -f release/hub/server.mjs
test -f data/config.json
test -f compose.yaml
test -x "$tailscale_bin"
docker compose version
docker compose -f compose.yaml config --quiet
# Refuse to replace a different container that happens to use our name.
if docker container inspect codexy-hub >/dev/null 2>&1; then
  existing_project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' codexy-hub)
  test "$existing_project" = codexy-hub || { printf 'Container name already belongs to another project.\n' >&2; exit 1; }
fi
run_tailscale serve status --json > serve-before.json
# Port 8443 must be unused or already point to this exact Codexy service.
python3 - <<'PY'
import json
cfg = json.load(open('serve-before.json')) or {}
for host, value in (cfg.get('Web') or {}).items():
    if host.endswith(':8443'):
        handlers = value.get('Handlers') or {}
        if handlers != {'/': {'Proxy': 'http://127.0.0.1:8797'}}:
            raise SystemExit('Existing Tailscale HTTPS 8443 route differs; stopping.')
tcp = (cfg.get('TCP') or {}).get('8443')
if tcp and tcp != {'HTTPS': True}:
    raise SystemExit('Existing TCP 8443 route differs; stopping.')
PY
docker compose -f compose.yaml up -d --build
attempt=0
until curl --fail --silent http://127.0.0.1:8797/healthz; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 15 ]; then printf '\nHub health check failed; inspect codexy-hub logs.\n' >&2; exit 1; fi
  sleep 2
done
run_tailscale serve --bg --https=8443 http://127.0.0.1:8797
run_tailscale serve status
printf '\nCodexy Hub installed. Existing NAS services were preserved.\n'
