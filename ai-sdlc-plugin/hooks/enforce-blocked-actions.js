/**
 * AI-SDLC Action Enforcement Hook (PreToolUse)
 *
 * Enforces governance from .ai-sdlc/agent-role.yaml across three tool families:
 *
 * 1. **Bash** — checks `tool_input.command` against `blockedActions` patterns.
 * 2. **Write / Edit** — checks `tool_input.file_path` against `blockedPaths` globs
 *    (relative to project root). Paths outside the project root are denied unless
 *    they fall under `permittedExternalPaths` declared in the active task's
 *    frontmatter (active task = `AI_SDLC_ACTIVE_TASK_ID` env var).
 *
 * Returns a deny decision when a tool call matches a guarded pattern.
 * Fail-safe: allows everything on any error — never block a session because
 * the policy file couldn't be parsed.
 */

const { readFileSync, existsSync, readdirSync } = require('fs');
const { join, resolve, isAbsolute, relative, sep } = require('path');
const { execSync } = require('child_process');

// ── Read stdin (tool input JSON from Claude Code) ────────────────────

let input;
try {
  const raw = readFileSync('/dev/stdin', 'utf-8');
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const toolName = input?.tool_name;
const toolInput = input?.tool_input || {};

// ── Find project root and load agent-role.yaml ───────────────────────

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

let blockedActions = [];
let blockedPaths = [];
try {
  const yaml = readFileSync(agentRolePath, 'utf-8');
  blockedActions = parseListField(yaml, 'blockedActions');
  blockedPaths = parseListField(yaml, 'blockedPaths');
} catch {
  process.exit(0);
}

// ── Dispatch by tool ─────────────────────────────────────────────────

if (toolName === 'Bash' || (!toolName && toolInput.command)) {
  enforceBash(toolInput.command);
} else if (toolName === 'Write' || toolName === 'Edit') {
  enforceWriteEdit(toolInput.file_path);
}

process.exit(0);

// ── Bash enforcement (unchanged behavior) ────────────────────────────

function enforceBash(command) {
  if (!command || typeof command !== 'string' || !command.trim()) return;
  if (blockedActions.length === 0) return;

  const trimmed = command.trim();
  for (const pattern of blockedActions) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped.replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexStr}$`, 'i');
    if (regex.test(trimmed)) {
      deny(`command matches blockedAction pattern '${pattern}'`);
    }
  }
}

// ── Write/Edit enforcement (new behavior) ────────────────────────────

function enforceWriteEdit(filePath) {
  if (!filePath || typeof filePath !== 'string') return;

  // Always work with absolute paths so both relative tool inputs and
  // already-absolute ones get the same treatment.
  const absPath = isAbsolute(filePath) ? resolve(filePath) : resolve(projectDir, filePath);

  const projectAbs = resolve(projectDir);
  const insideProject = absPath === projectAbs || absPath.startsWith(projectAbs + sep);

  if (insideProject) {
    // Path is inside the project root — check against blockedPaths globs.
    // Relative path uses POSIX separators because globs do.
    const relPath = relative(projectAbs, absPath).split(sep).join('/');
    for (const glob of blockedPaths) {
      if (matchGlob(glob, relPath)) {
        deny(
          `path '${relPath}' matches blocked path '${glob}'. ` +
            `Configuration files under blockedPaths are out of scope for agent edits.`,
        );
      }
    }
    return;
  }

  // Path is OUTSIDE the project root — only allowed if the active task's
  // permittedExternalPaths covers it.
  const allowed = loadPermittedExternalPaths(projectAbs);
  for (const ext of allowed) {
    const extAbs = resolve(projectAbs, ext);
    if (absPath === extAbs || absPath.startsWith(extAbs + sep)) {
      return; // explicit allow
    }
  }

  // No allowlist match — deny with a clear, actionable reason.
  if (allowed.length === 0) {
    deny(
      `path '${absPath}' is outside the project root. ` +
        `To permit cross-repo writes for this task, add 'permittedExternalPaths' to ` +
        `the task frontmatter and set AI_SDLC_ACTIVE_TASK_ID before invoking the agent.`,
    );
  } else {
    deny(
      `path '${absPath}' is outside the project root and not under the active ` +
        `task's permittedExternalPaths (${allowed.join(', ')}).`,
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function deny(reason) {
  const result = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Blocked by AI-SDLC governance policy: ${reason}`,
    },
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
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

/**
 * Read the active task ID. Prefers the sentinel file `.worktrees/.active-task`
 * (written by `/ai-sdlc execute`); falls back to `AI_SDLC_ACTIVE_TASK_ID` env
 * var so the hook stays testable from a normal shell.
 */
function readActiveTaskId(projectAbs) {
  const sentinelPath = join(projectAbs, '.worktrees', '.active-task');
  if (existsSync(sentinelPath)) {
    try {
      const id = readFileSync(sentinelPath, 'utf-8').trim();
      if (id) return id;
    } catch {
      // fall through to env var
    }
  }
  return process.env.AI_SDLC_ACTIVE_TASK_ID || null;
}

/**
 * Convert a glob like `.ai-sdlc/**` or `.github/workflows/*.yml` to a regex.
 * - `**` matches any sequence including `/`
 * - `*` matches any sequence except `/`
 * - other characters are matched literally
 */
function matchGlob(glob, path) {
  const regexStr = glob
    .split('')
    .map((char, i, arr) => {
      if (char === '*' && arr[i + 1] === '*') return '__DOUBLESTAR__';
      if (char === '*' && arr[i - 1] === '*') return '';
      if (char === '*') return '[^/]*';
      if (/[.+?^${}()|[\]\\]/.test(char)) return '\\' + char;
      return char;
    })
    .join('')
    .replace(/__DOUBLESTAR__/g, '.*');

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(path);
}

/**
 * Load permittedExternalPaths from the active task's frontmatter.
 *
 * Active task is identified by reading `.worktrees/.active-task` (a sentinel
 * file written by `/ai-sdlc execute` at start, deleted at end). The env-var
 * approach (AI_SDLC_ACTIVE_TASK_ID) does not work mid-session — the hook runs
 * in a fresh subprocess of the Claude Code parent, which can't have its env
 * mutated from a slash command. The env var is still honored as a fallback so
 * users can invoke the hook in tests / external tooling.
 *
 * Returns [] when no active task, no matching task file, or no frontmatter field.
 */
function loadPermittedExternalPaths(projectAbs) {
  const taskId = readActiveTaskId(projectAbs);
  if (!taskId) return [];

  const tasksDir = join(projectAbs, 'backlog', 'tasks');
  if (!existsSync(tasksDir)) return [];

  let entries;
  try {
    entries = readdirSync(tasksDir);
  } catch {
    return [];
  }

  // Task files are named `<id-lower> - <slug>.md` (e.g. `aisdlc-68 - foo.md`).
  // Match case-insensitively on the id prefix to be tolerant.
  const idLower = taskId.toLowerCase();
  const taskFile = entries.find((f) => f.toLowerCase().startsWith(idLower + ' '));
  if (!taskFile) return [];

  let content;
  try {
    content = readFileSync(join(tasksDir, taskFile), 'utf-8');
  } catch {
    return [];
  }

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];

  return parseListField(fmMatch[1], 'permittedExternalPaths');
}
