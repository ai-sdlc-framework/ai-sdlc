#!/bin/bash
#
# AI-SDLC SubagentStart Hook
#
# Injects governance context into spawned subagents (developer, reviewers, etc.).
# SessionStart does NOT fire for subagents (verified in claude-code source:
# runAgent.ts:532-543 calls executeSubagentStartHooks, not processSessionStartHooks),
# so this hook is the only place governance context reaches a subagent.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/subagent-start.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

exec node "$SCRIPT"
