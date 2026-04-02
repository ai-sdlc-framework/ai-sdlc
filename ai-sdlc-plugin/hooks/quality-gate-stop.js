/**
 * AI-SDLC Quality Gate Stop Hook
 *
 * When the agent is about to stop, checks whether pre-commit verification
 * commands were run during this session by scanning the telemetry JSONL.
 *
 * If code was modified but verification steps are missing, outputs a
 * blocking error (exit code 2) that wakes the model to complete them.
 *
 * Fail-safe: exits 0 on any error (don't block on hook failures).
 */

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

// ── Read stdin ───────────────────────────────────────────────────────

let input;
try {
  const raw = readFileSync('/dev/stdin', 'utf-8');
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const sessionId = input?.session_id;
if (!sessionId) {
  process.exit(0);
}

// ── Read telemetry for this session ──────────────────────────────────

const jsonlPath = join(homedir(), '.claude', 'usage-data', 'tool-sequences.jsonl');
if (!existsSync(jsonlPath)) {
  process.exit(0);
}

let lines;
try {
  lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n');
} catch {
  process.exit(0);
}

// Filter to current session
const sessionEvents = [];
for (const line of lines) {
  try {
    const entry = JSON.parse(line);
    if (entry.sid === sessionId) {
      sessionEvents.push(entry);
    }
  } catch {
    // skip malformed lines
  }
}

if (sessionEvents.length === 0) {
  process.exit(0);
}

// ── Check if source code was modified ────────────────────────────────
// Only trigger for source files — skip config/docs edits (JSON, YAML, MD, etc.)
// Telemetry actions are canonicalized as "edit:.ts", "write:.json", etc.

const CONFIG_ONLY_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.md', '.mdx', '.txt', '.rst', '.html', '.css', '.svg',
  '.sh', '.bash', '.zsh',
  '.lock', '.log',
  'file', // fallback when no extension detected
]);

const codeModifyingActions = sessionEvents.filter((e) => {
  if (e.tool === 'Edit' || e.tool === 'Write') {
    // Action format: "edit:.ts" or "write:.json" — extract the extension
    const ext = e.action.replace(/^(edit|write):/, '');
    return !CONFIG_ONLY_EXTENSIONS.has(ext);
  }
  if (e.tool === 'Bash' && /git (add|commit)/.test(e.action)) {
    return true;
  }
  return false;
});

if (codeModifyingActions.length === 0) {
  // No source code changes — no verification needed
  process.exit(0);
}

// ── Check for verification commands ──────────────────────────────────

const bashActions = sessionEvents.filter((e) => e.tool === 'Bash').map((e) => e.action);

const checks = {
  build: bashActions.some((a) => /pnpm (build|tsc)|npm run build/.test(a)),
  test: bashActions.some((a) => /pnpm test|npm test|vitest|jest/.test(a)),
  lint: bashActions.some((a) => /pnpm lint|npm run lint|eslint/.test(a)),
};

const missing = [];
if (!checks.build) missing.push('`pnpm build` (TypeScript compilation)');
if (!checks.test) missing.push('`pnpm test` (test suite)');
if (!checks.lint) missing.push('`pnpm lint` (linter)');

if (missing.length === 0) {
  // All verification steps completed
  process.exit(0);
}

// ── Output blocking error ────────────────────────────────────────────
// Exit code 2 = blocking error — stderr shown to the model

const message = `AI-SDLC Quality Gate: Code was modified but the following verification steps were not run:\n${missing.map((m) => `  - ${m}`).join('\n')}\n\nPlease run these checks and fix any failures before stopping.`;

process.stderr.write(message);
process.exit(2);
