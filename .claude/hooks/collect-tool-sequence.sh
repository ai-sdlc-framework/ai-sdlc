#!/bin/bash
#
# AI-SDLC Telemetry Collection Hook (PostToolUse)
#
# Captures every tool call to a JSONL file for workflow pattern detection.
# Runs after each tool execution — must be fast and never fail.
#

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
SCRIPT="$PROJECT_DIR/.claude/hooks/collect-tool-sequence.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

exec node "$SCRIPT"
