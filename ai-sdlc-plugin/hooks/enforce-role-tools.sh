#!/bin/bash
#
# AI-SDLC Role Tool Enforcement Hook (PreToolUse)
#
# Delegates to the Node.js script that refuses tool calls the session's
# RFC-0051 role may not make (governance.roles.<role>.blockedTools).
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/enforce-role-tools.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

exec node "$SCRIPT"
