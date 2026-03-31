#!/bin/bash
#
# AI-SDLC Action Enforcement Hook
#
# Pre-tool hook that reads blockedActions from .ai-sdlc/agent-role.yaml
# and blocks matching Bash commands. Works for both local Claude Code
# CLI users and CI runners.
#
# Install: Add to .claude/settings.json under hooks.PreToolUse
#

set -euo pipefail

# Read tool input from stdin
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Nothing to check if no command
if [ -z "$COMMAND" ]; then
  exit 0
fi

# Find project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
AGENT_ROLE_FILE="$PROJECT_DIR/.ai-sdlc/agent-role.yaml"

# If no agent-role.yaml, allow everything
if [ ! -f "$AGENT_ROLE_FILE" ]; then
  exit 0
fi

# Extract blockedActions from YAML (simple parser — no YAML library needed)
# Looks for lines after "blockedActions:" that start with "- "
IN_BLOCKED=false
while IFS= read -r line; do
  # Detect start of blockedActions section
  if echo "$line" | grep -q "blockedActions:"; then
    IN_BLOCKED=true
    continue
  fi

  # Detect end of section (line that doesn't start with spaces/dash)
  if $IN_BLOCKED; then
    if echo "$line" | grep -qE "^[a-zA-Z]"; then
      break
    fi

    # Extract pattern from "- 'pattern'" or "- \"pattern\"" or "- pattern"
    PATTERN=$(echo "$line" | sed -n "s/^[[:space:]]*-[[:space:]]*['\"]\\{0,1\\}\(.*\\)['\"]\\{0,1\\}$/\\1/p" | sed "s/['\"]$//" )

    if [ -n "$PATTERN" ]; then
      # Convert glob pattern to grep regex: replace * with .*
      REGEX=$(echo "$PATTERN" | sed 's/\*/\.\*/g')

      # Check if command matches
      if echo "$COMMAND" | grep -qiE "^${REGEX}$"; then
        # Block the command
        jq -n \
          --arg reason "Blocked by AI-SDLC governance policy: command matches blockedAction pattern '$PATTERN'" \
          '{
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: $reason
            }
          }'
        exit 0
      fi
    fi
  fi
done < "$AGENT_ROLE_FILE"

# Allow if no patterns matched
exit 0
