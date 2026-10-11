#!/bin/bash
#
# AI-SDLC Context Warning Hook (Stop, AISDLC-728)
#
# Warns once when the session context passes the upper threshold. Never fails a session.
#

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || exit 0
SCRIPT="$SCRIPT_DIR/context-warn.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

node "$SCRIPT" 2>/dev/null || true
exit 0
