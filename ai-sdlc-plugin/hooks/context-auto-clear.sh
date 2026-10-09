#!/bin/bash
#
# AI-SDLC Context Auto-Clear Hook (Stop, AISDLC-766)
#
# After each turn of a hierarchy session, clear the session when its context is over
# the role threshold. Must never delay or fail a session: every error path exits 0.
#

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || exit 0
SCRIPT="$SCRIPT_DIR/context-auto-clear.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

node "$SCRIPT" >/dev/null 2>&1 || true
exit 0
