/**
 * AI-SDLC SubagentStart Hook
 *
 * Reads .ai-sdlc/agent-role.yaml from the project directory and emits
 * governance context as additionalContext, which Claude Code injects into
 * the spawned subagent's session.
 *
 * Why this exists separately from session-start.js: SessionStart hooks do NOT
 * fire for subagents (verified in claude-code source: runAgent.ts:532-543
 * dispatches executeSubagentStartHooks instead of processSessionStartHooks).
 * Without this hook the developer subagent and reviewers would run with no
 * governance context at all.
 *
 * Fail-safe: exits silently on any error.
 */

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');

// ── Read stdin ───────────────────────────────────────────────────────

try {
  readFileSync('/dev/stdin', 'utf-8');
} catch {
  process.exit(0);
}

// ── Find project root ────────────────────────────────────────────────

const projectDir =
  process.env.CLAUDE_PROJECT_DIR ||
  (() => {
    try {
      return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    } catch {
      return process.cwd();
    }
  })();

// ── Load agent-role.yaml ─────────────────────────────────────────────

const agentRolePath = join(projectDir, '.ai-sdlc', 'agent-role.yaml');
if (!existsSync(agentRolePath)) {
  process.exit(0);
}

let yaml;
try {
  yaml = readFileSync(agentRolePath, 'utf-8');
} catch {
  process.exit(0);
}

const blockedActions = parseListField(yaml, 'blockedActions');
const blockedPaths = parseListField(yaml, 'blockedPaths');

// ── Build subagent governance context ────────────────────────────────
//
// Subagents get a TIGHTER prompt than the main session — they don't drive
// the lifecycle (no pre-commit checklist, no PR creation), they just do their
// stage. The hard rules are the same.

let context = `## AI-SDLC Governance (subagent context)

You are running as a Claude Code subagent. The orchestrating command will
gate your output (reviews, PR creation). Stay focused on your assigned task.

### Hard rules — NEVER violate
- **Never merge PRs** (\`gh pr merge\`)
- **Never force-push** (\`git push --force\`/\`-f\`)
- **Never close PRs or issues** (\`gh pr close\`, \`gh issue close\`)
- **Never delete branches** (\`git branch -D\`/\`-d\`)
- **Never run destructive git** (\`git reset --hard\`, \`git checkout -- .\`, \`git restore .\`)`;

if (blockedPaths.length > 0) {
  context += `\n\n### Blocked paths (PreToolUse hook enforces — no edits)
${blockedPaths.map((p) => `- \`${p}\``).join('\n')}`;
}

if (blockedActions.length > 0) {
  context += `\n\n### Blocked Bash actions (PreToolUse hook enforces — no execution)
${blockedActions.map((a) => `- \`${a}\``).join('\n')}`;
}

context += `\n\n### Cross-repo writes
If you have \`AI_SDLC_ACTIVE_TASK_ID\` set, the active task's \`permittedExternalPaths\`
in its frontmatter allowlists writes to sibling repos. The PreToolUse hook honors
this — writes outside your cwd that aren't in the allowlist will be denied.`;

// ── Output ───────────────────────────────────────────────────────────

const result = {
  hookSpecificOutput: {
    additionalContext: context,
  },
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(0);

// ── Helpers ──────────────────────────────────────────────────────────

function parseListField(yaml, field) {
  const lines = yaml.split('\n');
  const items = [];
  let inSection = false;

  for (const line of lines) {
    if (new RegExp(`^\\s*${field}:\\s*$`).test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^[a-zA-Z]/.test(line)) break;
      if (/^\s*$/.test(line)) continue;
      const match = line.match(/^\s+-\s+['"]?(.+?)['"]?\s*$/);
      if (match) items.push(match[1]);
    }
  }

  return items;
}
