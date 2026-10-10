/**
 * AI-SDLC Telemetry Collection Hook (PostToolUse)
 *
 * Appends a single JSONL line per tool call to ~/.claude/usage-data/tool-sequences.jsonl.
 * This data feeds the workflow pattern detection engine.
 *
 * Must be fast (single fs.appendFileSync) and never fail (all errors swallowed).
 *
 * Also returns a one-line notice when a planner or operator-dispatch session reads a
 * very large tool result (lib/large-output-notice.js, AISDLC-651.5).
 */

const { readFileSync, appendFileSync, mkdirSync, existsSync } = require('fs');
const { join, extname } = require('path');
const { homedir } = require('os');
const budgetLib = require('./lib/developer-turn-budget.js');

// ── Read stdin ───────────────────────────────────────────────────────

let input;
try {
  const raw = readFileSync('/dev/stdin', 'utf-8');
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const toolName = input?.tool_name;
const toolInput = input?.tool_input || {};
const sessionId = input?.session_id;

if (!toolName || !sessionId) {
  process.exit(0);
}

// ── Canonicalize the action ──────────────────────────────────────────

function canonicalize(tool, input) {
  switch (tool) {
    case 'Bash': {
      const cmd = (input.command || '').trim();
      const lastCmd = cmd.includes('&&') ? cmd.split('&&').pop().trim() : cmd;
      const tokens = lastCmd.split(/\s+/).slice(0, 3);
      return tokens.join(' ').slice(0, 60);
    }
    case 'Read':
      return `read:${extname(input.file_path || '') || 'file'}`;
    case 'Edit':
      return `edit:${extname(input.file_path || '') || 'file'}`;
    case 'Write':
      return `write:${extname(input.file_path || '') || 'file'}`;
    case 'Grep':
      return `grep:${(input.pattern || '').slice(0, 30)}`;
    case 'Glob':
      return `glob:${(input.pattern || '').slice(0, 30)}`;
    case 'Agent':
      return `agent:${(input.description || '').slice(0, 30)}`;
    case 'TaskCreate':
      return 'task:create';
    case 'TaskUpdate':
      return 'task:update';
    default:
      return tool.toLowerCase();
  }
}

const action = canonicalize(toolName, toolInput);

// ── Build JSONL line ─────────────────────────────────────────────────

const projectDir =
  process.env.CLAUDE_PROJECT_DIR ||
  (() => {
    try {
      return require('child_process')
        .execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' })
        .trim();
    } catch {
      return process.cwd();
    }
  })();

const entry = {
  ts: new Date().toISOString(),
  sid: sessionId,
  tool: toolName,
  action: action,
  project: projectDir,
};

// ── Developer turn budget (AISDLC-651.3) ─────────────────────────────

/** Count developer subagent calls; returns a notice string or null. Never throws. */
function developerTurnNotice() {
  try {
    if (!budgetLib.isDeveloperAgent(input?.agent_type) || !input?.agent_id) return null;
    const usageDir = process.env.AI_SDLC_USAGE_DIR || join(homedir(), '.ai-sdlc', 'usage');
    const cwd = input?.cwd || process.cwd();
    const count = budgetLib.bumpCount(join(usageDir, 'developer-turn-state'), input.agent_id);
    const cfg = budgetLib.resolveTurnBudget(cwd);
    budgetLib.recordTurns(usageDir, {
      ts: entry.ts,
      agentId: input.agent_id,
      sessionId: sessionId,
      taskId: budgetLib.resolveTaskId(cwd, process.env),
      turns: count,
      budget: cfg.budget,
    });
    return budgetLib.turnNotice(count, cfg);
  } catch {
    return null;
  }
}

const turnNotice = developerTurnNotice();
if (turnNotice) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: turnNotice },
    }) + '\n',
  );
}

// ── Append to JSONL file ─────────────────────────────────────────────

try {
  const outputDir = join(homedir(), '.claude', 'usage-data');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  const outputPath = join(outputDir, 'tool-sequences.jsonl');
  appendFileSync(outputPath, JSON.stringify(entry) + '\n', 'utf-8');
} catch {
  // Never fail — telemetry is best-effort
}

// ── Large-output notice (main-session roles only; never blocks) ─────

try {
  const { largeOutputNotice } = require('./lib/large-output-notice');
  const notice = largeOutputNotice(input);
  if (notice) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notice },
      }) + '\n',
    );
  }
} catch {
  // Never fail
}

process.exit(0);
