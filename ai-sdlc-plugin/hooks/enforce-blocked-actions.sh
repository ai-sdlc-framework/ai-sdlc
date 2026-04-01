#!/bin/bash
#
# AI-SDLC Action Enforcement Hook (PreToolUse)
#
# Delegates to the Node.js enforcement script which checks Bash commands
# against blockedActions from .ai-sdlc/agent-role.yaml.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/enforce-blocked-actions.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

exec node "$SCRIPT"
