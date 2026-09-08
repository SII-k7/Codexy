#!/bin/sh
# Read-only deployment preflight. Run after logging into the NAS; no secrets,
# existing container environment variables, or private files are printed.
set -eu
printf 'Architecture: '
uname -m
printf 'Current account: '
id -un
printf '\nDocker server\n'
docker version --format '{{.Server.Version}}' 2>/dev/null || true
printf '\nCompose\n'
docker compose version 2>/dev/null || true
printf '\nStorage mounts\n'
df -h -x tmpfs -x devtmpfs -x overlay
printf '\nExisting container names and port bindings\n'
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true
printf '\nTailscale version and existing Serve routes\n'
if command -v tailscale >/dev/null 2>&1; then
  tailscale version
  tailscale serve status 2>/dev/null || true
fi
printf '\nCandidate service ports\n'
if command -v ss >/dev/null 2>&1; then
  ss -ltn | awk 'NR == 1 || $4 ~ /:(8797|8798|443)$/'
fi
