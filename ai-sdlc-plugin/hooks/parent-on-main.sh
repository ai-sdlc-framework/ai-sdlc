#!/bin/bash
#
# AI-SDLC parent-on-main hook (SessionStart + PreToolUse), AISDLC-764.
# Delegates to parent-on-main.js.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/parent-on-main.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

exec node "$SCRIPT"
