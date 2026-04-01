/**
 * AI-SDLC Session Start Hook
 *
 * Reads .ai-sdlc/agent-role.yaml from the project directory and returns
 * governance context as additionalContext, which Claude Code injects
 * into the model's session context.
 *
 * Fail-safe: exits silently on any error.
 */

const { readFileSync, existsSync } = require('fs');
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

// ── Parse agent role fields ──────────────────────────────────────────

const role = extractField(yaml, 'role') || 'agent';
const goal = extractField(yaml, 'goal') || '';
const maxFiles = extractField(yaml, 'maxFilesPerChange') || '15';
const requireTests = extractField(yaml, 'requireTests') || 'true';
const blockedActions = parseListField(yaml, 'blockedActions');
const blockedPaths = parseListField(yaml, 'blockedPaths');

// ── Load review policy if present ────────────────────────────────────

let reviewPolicySummary = '';
const reviewPolicyPath = join(projectDir, '.ai-sdlc', 'review-policy.md');
if (existsSync(reviewPolicyPath)) {
  reviewPolicySummary =
    '\nReview policy is active at .ai-sdlc/review-policy.md — consult it before reviewing code.';
}

// ── Build governance context ─────────────────────────────────────────

let context = `## AI-SDLC Governance Active

**Role:** ${role}
**Goal:** ${goal}

### Constraints
- Maximum files per change: ${maxFiles}
- Tests required: ${requireTests}`;

if (blockedPaths.length > 0) {
  context += `\n- Blocked paths: ${blockedPaths.join(', ')}`;
}

context += `

### Blocked Actions (NEVER execute these)
${blockedActions.map((a) => `- \`${a}\``).join('\n')}

### Pre-Commit Checklist
Before EVERY commit, run these and fix any failures:
1. \`pnpm build\` — TypeScript compilation
2. \`pnpm test\` — All tests must pass
3. \`pnpm lint\` — No lint errors
4. \`pnpm format:check\` — Run \`pnpm format\` to fix

**NEVER merge PRs. Only humans merge.**
**NEVER close issues or PRs.**
**NEVER force push.**${reviewPolicySummary}`;

// ── Output ───────────────────────────────────────────────────────────

const result = {
  hookSpecificOutput: {
    additionalContext: context,
  },
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(0);

// ── Helpers ──────────────────────────────────────────────────────────

function extractField(yaml, field) {
  const match = yaml.match(new RegExp(`^\\s*${field}:\\s*(.+)$`, 'm'));
  if (!match) return null;
  return match[1]
    .replace(/^['">-]+\s*/, '')
    .replace(/['"]$/, '')
    .trim();
}

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
