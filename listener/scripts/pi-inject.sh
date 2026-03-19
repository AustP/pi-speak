#!/usr/bin/env bash
set -euo pipefail

if [ -n "${TMPDIR:-}" ]; then
  SOCKET_PATH="${TMPDIR%/}/pi-session-inject.sock"
else
  SOCKET_PATH="/tmp/pi-session-inject.sock"
fi

if [ "$#" -gt 0 ]; then
  TEXT="$*"
else
  TEXT="$(cat)"
fi

if [ -z "${TEXT//[[:space:]]/}" ]; then
  exit 0
fi

if [ ! -S "$SOCKET_PATH" ]; then
  echo "pi inject socket not found at $SOCKET_PATH" >&2
  exit 1
fi

printf '%s\n' "$TEXT" | nc -U "$SOCKET_PATH" >/dev/null
