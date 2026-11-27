#!/usr/bin/env bash
# AISDLC-1398: start the plugin MCP server once its runtime dependencies exist.
#
# Claude Code starts the MCP server in parallel with the SessionStart hook. On a
# fresh install the hook is still running install-runtime-deps.sh, so a direct
# `node .../plugin-mcp-server/dist/bin.js` fails and Claude Code caches the
# failure. This launcher (like `npx -y`) closes that race:
#
#   1. bin.js present and no install running -> exec the server at once.
#   2. install running (lock held by a live pid) -> wait for it to finish.
#   3. nothing running and modules missing -> run install-runtime-deps.sh
#      (which takes the same lock), then exec the server.
#   4. past the bound (AI_SDLC_MCP_LAUNCH_TIMEOUT seconds, default 300) ->
#      exit 1 with the reason on stderr.
#
# stdout is the MCP stdio channel: every message and the install's own output
# go to stderr.
#
# Usage: mcp-server-launcher.sh [server args...]   (plugin dir from CLAUDE_PLUGIN_ROOT,
# else the parent of this script's directory)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${CLAUDE_PLUGIN_ROOT:-$(dirname "$SCRIPT_DIR")}"
SERVER_BIN="$PLUGIN_DIR/node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js"
LOCK_FILE="$PLUGIN_DIR/.ai-sdlc-install.lock"
INSTALLER="$SCRIPT_DIR/install-runtime-deps.sh"
BOUND="${AI_SDLC_MCP_LAUNCH_TIMEOUT:-300}"

say() { echo "mcp-server-launcher.sh: $*" >&2; }

# True when another installer holds the lock with a live pid. A lock whose
# holder is dead is not "held": install-runtime-deps.sh removes it as stale.
lock_held() {
  [ -e "$LOCK_FILE" ] || return 1
  local holder
  if [ -d "$LOCK_FILE" ]; then
    holder="$(cat "$LOCK_FILE/pid" 2>/dev/null || true)"
  else
    holder="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  fi
  # A lock file without a pid yet is being written right now: treat as held.
  [ -z "$holder" ] && return 0
  kill -0 "$holder" 2>/dev/null
}

start_server() {
  exec node "$SERVER_BIN" "$@"
}

if [ -f "$SERVER_BIN" ] && ! lock_held; then
  start_server "$@"
fi

if lock_held; then
  say "runtime dependency install in progress ($LOCK_FILE), waiting up to ${BOUND}s"
  while lock_held; do
    if [ "$SECONDS" -ge "$BOUND" ]; then
      say "gave up after ${BOUND}s waiting for the runtime dependency install ($LOCK_FILE) to finish; the MCP server was not started"
      exit 1
    fi
    sleep 0.2
  done
  if [ -f "$SERVER_BIN" ]; then
    start_server "$@"
  fi
fi

remaining=$((BOUND - SECONDS))
if [ "$remaining" -le 0 ]; then
  say "gave up after ${BOUND}s: $SERVER_BIN is missing and no time is left to install it"
  exit 1
fi

say "$SERVER_BIN missing and no install running; installing runtime dependencies"
# Job control gives the install its own process group, so the bound below can
# stop npm too, not only the installer shell.
set -m
AI_SDLC_INSTALL_LOCK_TIMEOUT="$remaining" bash "$INSTALLER" "$PLUGIN_DIR" >&2 &
install_pid=$!
set +m
while kill -0 "$install_pid" 2>/dev/null; do
  if [ "$SECONDS" -ge "$BOUND" ]; then
    kill -- "-$install_pid" 2>/dev/null || kill "$install_pid" 2>/dev/null || true
    say "gave up after ${BOUND}s: the runtime dependency install did not finish; the MCP server was not started"
    exit 1
  fi
  sleep 0.2
done
install_status=0
wait "$install_pid" || install_status=$?

if [ ! -f "$SERVER_BIN" ]; then
  say "runtime dependency install exited $install_status and $SERVER_BIN is still missing; the MCP server was not started (rerun: bash $INSTALLER $PLUGIN_DIR)"
  exit 1
fi
start_server "$@"
