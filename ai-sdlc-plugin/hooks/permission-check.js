/**
 * AI-SDLC Permission Check Hook (PermissionRequest)
 *
 * Provides a hard deny at the permission layer for blocked actions.
 * This complements the PreToolUse enforcement hook — while that hook
 * blocks commands after they're submitted, this hook denies the
 * permission request before the tool is even invoked.
 *
 * Returns permissionDecision: 'deny' for commands matching blockedActions.
 */

const { readFileSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');

// ── Read stdin ───────────────────────────────────────────────────────

let input;
try {
  const raw = readFileSync('/dev/stdin', 'utf-8');
  input = JSON.parse(raw);
} catch {
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
  process.exit(0);
}

if (!blockedActions || blockedActions.length === 0) {
  process.exit(0);
}

// ── Check command against blocked actions ─────────────────────────

const trimmed = command.trim();

for (const pattern of blockedActions) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '.*');
  const regex = new RegExp(`^${regexStr}$`, 'i');

  if (regex.test(trimmed)) {
    const result = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        permissionDecision: 'deny',
        permissionDecisionReason: `Blocked by AI-SDLC governance: '${pattern}'`,
      },
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  }
}

process.exit(0);

// ── Simple YAML parser ───────────────────────────────────────────

function parseBlockedActions(yaml) {
  const lines = yaml.split('\n');
  const actions = [];
  let inSection = false;

  for (const line of lines) {
    if (/^\s*blockedActions:\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^[a-zA-Z]/.test(line)) break;
      if (/^\s*$/.test(line)) continue;
      const match = line.match(/^\s+-\s+['"]?(.+?)['"]?\s*$/);
      if (match) actions.push(match[1]);
    }
  }

  return actions;
}
