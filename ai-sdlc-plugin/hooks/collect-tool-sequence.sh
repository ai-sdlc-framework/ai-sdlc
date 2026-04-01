#!/bin/bash
#
# AI-SDLC Telemetry Collection Hook (PostToolUse)
#
# Captures every tool call to a JSONL file for workflow pattern detection.
# Runs after each tool execution — must be fast and never fail.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/collect-tool-sequence.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

exec node "$SCRIPT"
