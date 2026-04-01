/**
 * AI-SDLC Telemetry Collection Hook (PostToolUse)
 *
 * Appends a single JSONL line per tool call to ~/.claude/usage-data/tool-sequences.jsonl.
 * This data feeds the workflow pattern detection engine.
 *
 * Must be fast (single fs.appendFileSync) and never fail (all errors swallowed).
 */

const { readFileSync, appendFileSync, mkdirSync, existsSync } = require('fs');
const { join, extname } = require('path');
const { homedir } = require('os');

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

process.exit(0);
