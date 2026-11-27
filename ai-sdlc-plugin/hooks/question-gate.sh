#!/bin/bash
#
# AI-SDLC operator-question gate (PreToolUse, AskUserQuestion; AISDLC-1443).
#
# Delegates to the Node.js script. Kill switch: AI_SDLC_QUESTION_GATE=off.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/question-gate.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

exec node "$SCRIPT"
