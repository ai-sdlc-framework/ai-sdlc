#!/bin/bash
#
# AI-SDLC Context Budget Hook (Stop)
#
# Prints a one-line notice when the session is over its role's context or turn
# budget. Must never delay or fail a session: every error path exits 0.
#

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || exit 0
SCRIPT="$SCRIPT_DIR/context-budget.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

node "$SCRIPT" 2>/dev/null || true
exit 0
