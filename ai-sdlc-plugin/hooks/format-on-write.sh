#!/bin/bash
#
# AI-SDLC format-on-write Hook (PostToolUse, Edit|Write) - AISDLC-938
# Runs the project's own Prettier on the file the tool just wrote. Fails open.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/format-on-write.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

exec node "$SCRIPT"
