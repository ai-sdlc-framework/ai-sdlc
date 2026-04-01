#!/bin/bash
#
# AI-SDLC Session Start Hook
#
# Loads agent-role.yaml and injects governance context into the session.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/session-start.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

exec node "$SCRIPT"
