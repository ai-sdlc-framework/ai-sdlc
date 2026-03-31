#!/bin/bash
#
# AI-SDLC Action Enforcement Hook
#
# Delegates to the Node.js enforcement script which reuses the
# tested checkAction() function from @ai-sdlc/orchestrator.
# This shell wrapper exists because Claude Code hooks require
# a shell command entry point.
#

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
SCRIPT="$PROJECT_DIR/.claude/hooks/enforce-blocked-actions.js"

if [ ! -f "$SCRIPT" ]; then
  # Script not found — allow (don't block if hook is misconfigured)
  exit 0
fi

# Pipe stdin (tool input JSON) to the Node.js script
exec node "$SCRIPT"
