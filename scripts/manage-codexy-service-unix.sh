#!/bin/sh
set -eu

action=${1:-status}
codex_home=${CODEX_HOME:-"$HOME/.codex"}
runtime_directory="$codex_home/codexy"

case $(uname -s) in
  Linux)
    case $action in
      start|stop|restart|status)
        exec systemctl --user "$action" codexy.service
        ;;
      logs)
        exec journalctl --user -u codexy.service -n 100 -f
        ;;
      *)
        printf '%s\n' 'Usage: codexy service {start|stop|restart|status}' >&2
        exit 2
        ;;
    esac
    ;;
  Darwin)
    label=com.codexy.relay
    domain_file="$runtime_directory/service-domain"
    if [ -r "$domain_file" ]; then
      IFS= read -r domain < "$domain_file"
    else
      domain="gui/$(id -u)"
    fi
    service="$domain/$label"
    plist="$HOME/Library/LaunchAgents/$label.plist"
    case $action in
      start)
        if ! launchctl print "$service" >/dev/null 2>&1; then
          launchctl bootstrap "$domain" "$plist"
        fi
        exec launchctl kickstart "$service"
        ;;
      stop)
        exec launchctl bootout "$service"
        ;;
      restart)
        exec launchctl kickstart -k "$service"
        ;;
      status)
        exec launchctl print "$service"
        ;;
      logs)
        touch "$runtime_directory/relay.stdout.log" \
          "$runtime_directory/relay.stderr.log"
        exec tail -n 100 -f \
          "$runtime_directory/relay.stdout.log" \
          "$runtime_directory/relay.stderr.log"
        ;;
      *)
        printf '%s\n' 'Usage: codexy service {start|stop|restart|status}' >&2
        exit 2
        ;;
    esac
    ;;
  *)
    printf '%s\n' 'Unsupported operating system.' >&2
    exit 1
    ;;
esac
