/**
 * AI-SDLC Action Enforcement Hook (Node.js)
 *
 * Reads blockedActions from .ai-sdlc/agent-role.yaml and checks
 * the incoming Bash command against them using the same checkAction()
 * logic from @ai-sdlc/orchestrator.
 *
 * Invoked by the shell wrapper enforce-blocked-actions.sh.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ── Read stdin (tool input JSON from Claude Code) ────────────────

let input;
try {
  const raw = readFileSync('/dev/stdin', 'utf-8');
  input = JSON.parse(raw);
} catch {
  // Invalid input — allow (don't block on hook errors)
  process.exit(0);
}

const command = input?.tool_input?.command;
if (!command || typeof command !== 'string' || !command.trim()) {
  process.exit(0);
}

// ── Find project root and load agent-role.yaml ───────────────────

const projectDir =
  process.env.CLAUDE_PROJECT_DIR ||
  (() => {
    try {
      return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    } catch {
      return process.cwd();
    }
  })();

const agentRolePath = join(projectDir, '.ai-sdlc', 'agent-role.yaml');

let blockedActions;
try {
  const yaml = readFileSync(agentRolePath, 'utf-8');
  blockedActions = parseBlockedActions(yaml);
} catch {
  // No config or can't read — allow everything
  process.exit(0);
}

if (!blockedActions || blockedActions.length === 0) {
  process.exit(0);
}

// ── Check command against blocked actions ─────────────────────────
// Replicates checkAction() logic from orchestrator/src/action-enforcement.ts

const trimmed = command.trim();

for (const pattern of blockedActions) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '.*');
  const regex = new RegExp(`^${regexStr}$`, 'i');

  if (regex.test(trimmed)) {
    // Output deny decision as JSON to stdout
    const result = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Blocked by AI-SDLC governance policy: command matches blockedAction pattern '${pattern}'`,
      },
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  }
}

// Allow — no output needed
process.exit(0);

// ── Simple YAML parser for blockedActions ─────────────────────────
// Only extracts the blockedActions array — no full YAML library needed.

function parseBlockedActions(yaml) {
  const lines = yaml.split('\n');
  const actions = [];
  let inSection = false;

  for (const line of lines) {
    // Detect blockedActions: section
    if (/^\s*blockedActions:\s*$/.test(line)) {
      inSection = true;
      continue;
    }

    if (inSection) {
      // End of section: non-indented non-empty line that's not a list item
      if (/^[a-zA-Z]/.test(line)) break;
      if (/^\s*$/.test(line)) continue;

      // Extract list items: "  - 'pattern'" or "  - pattern"
      const match = line.match(/^\s+-\s+['"]?(.+?)['"]?\s*$/);
      if (match) {
        actions.push(match[1]);
      }
    }
  }

  return actions;
}
