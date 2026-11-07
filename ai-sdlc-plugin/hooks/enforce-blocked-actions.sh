#!/bin/bash
#
# AI-SDLC Action Enforcement Hook (PreToolUse)
#
# Delegates to the Node.js enforcement script which checks Bash commands
# against blockedActions from .ai-sdlc/agent-role.yaml.
#
# AISDLC-731: the enforcement script is NEVER taken from a task worktree, whose files an
# untrusted run may have edited. Resolution order (first existing wins):
#   1. $CLAUDE_PLUGIN_ROOT/hooks/enforce-blocked-actions.js   (installed plugin root)
#   2. <main checkout>/ai-sdlc-plugin/hooks/enforce-blocked-actions.js
#      (main checkout = parent of `git rev-parse --git-common-dir`, so a session rooted
#      in a worktree resolves to the main checkout, not the worktree)
#   3. this script's own directory (a plain checkout that is its own main checkout)
# `.claude/settings.json` resolves the main checkout the same way before invoking this
# wrapper, so a modified worktree copy of the wrapper is not executed either.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT=""

if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/hooks/enforce-blocked-actions.js" ]; then
  SCRIPT="$CLAUDE_PLUGIN_ROOT/hooks/enforce-blocked-actions.js"
else
  COMMON="$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -n "$COMMON" ]; then
    MAIN="$(dirname "$COMMON")"
    if [ -f "$MAIN/ai-sdlc-plugin/hooks/enforce-blocked-actions.js" ]; then
      SCRIPT="$MAIN/ai-sdlc-plugin/hooks/enforce-blocked-actions.js"
    fi
  fi
fi

if [ -z "$SCRIPT" ]; then
  SCRIPT="$SCRIPT_DIR/enforce-blocked-actions.js"
fi

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

exec node "$SCRIPT"
