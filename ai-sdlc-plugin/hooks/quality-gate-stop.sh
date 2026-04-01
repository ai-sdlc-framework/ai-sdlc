#!/bin/bash
#
# AI-SDLC Quality Gate Stop Hook
#
# Verifies that pre-commit checks were run before the session ends.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/quality-gate-stop.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

exec node "$SCRIPT"
