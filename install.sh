#!/bin/sh
# Codexy bootstrap installer for Ubuntu and macOS.
set -eu

repository_url=${CODEXY_REPOSITORY_URL:-https://github.com/SII-k7/Codexy.git}
repository_ref=${CODEXY_REF:-main}
requested_update=0

if [ "${1:-}" = "--update" ]; then
  requested_update=1
  shift
fi

script_directory=
case $0 in
  */*)
    candidate_directory=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)
    if [ -f "$candidate_directory/package.json" ] &&
      [ -f "$candidate_directory/scripts/setup-codexy-unix.sh" ]; then
      script_directory=$candidate_directory
    fi
    ;;
esac

if [ -n "${CODEXY_SOURCE_DIR:-}" ]; then
  source_directory=$CODEXY_SOURCE_DIR
elif [ -n "$script_directory" ]; then
  source_directory=$script_directory
else
  case $(uname -s) in
    Darwin)
      default_data_home="$HOME/Library/Application Support/Codexy"
      ;;
    Linux)
      default_data_home="${XDG_DATA_HOME:-$HOME/.local/share}/codexy"
      ;;
    *)
      printf '%s\n' 'Codexy supports this installer on Ubuntu and macOS only.' >&2
      exit 1
      ;;
  esac
  source_directory=${CODEXY_INSTALL_DIR:-"$default_data_home/source"}
fi

if [ -n "$script_directory" ] && [ "$source_directory" = "$script_directory" ]; then
  if [ "$requested_update" -eq 1 ]; then
    if ! command -v git >/dev/null 2>&1; then
      printf '%s\n' 'Git is required to update Codexy.' >&2
      exit 1
    fi
    if [ -n "$(git -C "$source_directory" status --porcelain --untracked-files=no)" ]; then
      printf '%s\n' 'Codexy update stopped because the source checkout has local changes.' >&2
      exit 1
    fi
    git -C "$source_directory" pull --ff-only
  fi
else
  if ! command -v git >/dev/null 2>&1; then
    printf '%s\n' 'Git is required. Install Git, then run this command again.' >&2
    exit 1
  fi
  if [ -e "$source_directory" ]; then
    if [ ! -d "$source_directory/.git" ]; then
      printf 'Codexy refuses to replace an unrelated path: %s\n' \
        "$source_directory" >&2
      exit 1
    fi
    origin_url=$(git -C "$source_directory" remote get-url origin 2>/dev/null || true)
    case $origin_url in
      "$repository_url"|https://github.com/SII-k7/Codexy|git@github.com:SII-k7/Codexy.git)
        ;;
      *)
        printf 'Codexy refuses to update a checkout from another origin: %s\n' \
          "${origin_url:--}" >&2
        exit 1
        ;;
    esac
    if [ -n "$(git -C "$source_directory" status --porcelain --untracked-files=no)" ]; then
      printf '%s\n' 'Codexy update stopped because its managed checkout has local changes.' >&2
      exit 1
    fi
    git -C "$source_directory" fetch --depth 1 origin "$repository_ref"
    current_branch=$(git -C "$source_directory" symbolic-ref --short HEAD 2>/dev/null || true)
    if [ "$current_branch" = "$repository_ref" ]; then
      git -C "$source_directory" merge --ff-only FETCH_HEAD
    else
      git -C "$source_directory" checkout -B "$repository_ref" FETCH_HEAD
    fi
  else
    mkdir -p "$(dirname -- "$source_directory")"
    git clone --depth 1 --branch "$repository_ref" \
      "$repository_url" "$source_directory"
  fi
fi

if [ ! -f "$source_directory/scripts/setup-codexy-unix.sh" ]; then
  printf 'Codexy installer is missing from %s\n' "$source_directory" >&2
  exit 1
fi

exec /bin/sh "$source_directory/scripts/setup-codexy-unix.sh" \
  --apply --yes "$@"
