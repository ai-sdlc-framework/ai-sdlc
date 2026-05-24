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
const { join, resolve, isAbsolute, relative, sep, dirname } = require('path');
const { execSync } = require('child_process');

// ── Read stdin (tool input JSON from Claude Code) ────────────────────

let input;
try {
  const raw = readFileSync('/dev/stdin', 'utf-8');
  input = JSON.parse(raw);
} catch (e) {
  process.stderr.write(`[hook-diag] stdin parse failed: ${e && e.message ? e.message : String(e)}\n`);
  process.exit(0);
}

const toolName = input?.tool_name;
const toolInput = input?.tool_input || {};
const toolCwd = typeof input?.cwd === 'string' ? input.cwd : null;

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
} catch (e) {
  process.stderr.write(
    `[hook-diag] agent-role.yaml read failed: path=${agentRolePath} projectDir=${projectDir} cwd=${process.cwd()} err=${e && e.message ? e.message : String(e)}\n`,
  );
  process.exit(0);
}
process.stderr.write(
  `[hook-diag] reached dispatch: tool=${toolName} cwd-in=${toolCwd} projectDir=${projectDir} active-task-env=${process.env.AI_SDLC_ACTIVE_TASK_ID || '<unset>'}\n`,
);

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
  // permittedExternalPaths covers it. The hook resolves "which task is
  // active" by walking up from the tool's cwd (the developer subagent's
  // worktree) to find a per-worktree `.active-task` sentinel; if none
  // is found it falls back to the legacy project-level sentinel.
  //
  // We use cwd here rather than the file_path because external writes
  // sit OUTSIDE `.worktrees/<id>/`, so file_path can never contain a
  // worktree ancestor. The cwd of the subagent always does.
  const allowed = loadPermittedExternalPaths(projectAbs, toolCwd || process.cwd());
  process.stderr.write(
    `[hook-diag] enforceWriteEdit: absPath=${absPath} projectAbs=${projectAbs} insideProject=${insideProject} allowed=${JSON.stringify(allowed)}\n`,
  );
  for (const ext of allowed) {
    const extAbs = resolve(projectAbs, ext);
    if (absPath === extAbs || absPath.startsWith(extAbs + sep)) {
      process.stderr.write(`[hook-diag] explicit allow: matched ${ext} → ${extAbs}\n`);
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
 * Read the active task ID. Resolution order (AISDLC-81):
 *   1. Per-worktree sentinel: walk `searchFrom` up looking for an ancestor
 *      `<projectRoot>/.worktrees/<id>/` and read its `.active-task`. This
 *      lets parallel `/ai-sdlc execute` runs each have their own active
 *      task without racing on a project-level file.
 *   2. Project-level sentinel `<projectRoot>/.worktrees/.active-task`
 *      (legacy fallback, retained for one release for non-execute callers
 *      and old runs that still write the project-level path).
 *      DEPRECATED: drop in v0.9.0+. Per-worktree sentinels are the only
 *      supported location once existing worktrees on the legacy layout
 *      have rolled over.
 *   3. `AI_SDLC_ACTIVE_TASK_ID` env var so the hook stays testable from
 *      a normal shell / external tooling.
 *
 * Returns the task ID string or `null` if no source is set.
 */
function readActiveTaskId(projectAbs, searchFrom) {
  // 1. Per-worktree sentinel from the tool's cwd (or file_path's dir).
  const perWorktree = findWorktreeSentinel(projectAbs, searchFrom);
  if (perWorktree) {
    try {
      const id = readFileSync(perWorktree, 'utf-8').trim();
      if (id) return id;
    } catch {
      // fall through to project-level sentinel
    }
  }

  // 2. Project-level sentinel (DEPRECATED — remove in v0.9.0+).
  const projectSentinel = join(projectAbs, '.worktrees', '.active-task');
  if (existsSync(projectSentinel)) {
    try {
      const id = readFileSync(projectSentinel, 'utf-8').trim();
      if (id) return id;
    } catch {
      // fall through to env var
    }
  }

  // 3. Env var fallback.
  return process.env.AI_SDLC_ACTIVE_TASK_ID || null;
}

/**
 * Walk `startFrom` up the directory tree looking for a path of the form
 * `<projectAbs>/.worktrees/<id>/`. When found, return the absolute path
 * to that worktree's `.active-task` sentinel (whether or not it exists
 * — the caller checks). Returns `null` when no `.worktrees/<id>/`
 * ancestor exists at or under projectAbs.
 *
 * Notes:
 * - Search is bounded: stops as soon as we reach `projectAbs` or the
 *   filesystem root, whichever comes first.
 * - The matched ancestor must be a DIRECT child of `<projectAbs>/.worktrees/`
 *   (i.e. exactly one path component below `.worktrees/`). Nested
 *   directories like `.worktrees/<id>/sub/` correctly resolve UP to
 *   `<projectAbs>/.worktrees/<id>/`.
 */
function findWorktreeSentinel(projectAbs, startFrom) {
  if (!startFrom) return null;
  const start = isAbsolute(startFrom) ? resolve(startFrom) : resolve(projectAbs, startFrom);

  const worktreesRoot = join(projectAbs, '.worktrees');

  // The candidate worktree must live inside <projectAbs>/.worktrees/.
  // If start is not under that, no per-worktree sentinel is reachable.
  if (start !== worktreesRoot && !start.startsWith(worktreesRoot + sep)) {
    return null;
  }

  let current = start;
  // Walk up until the parent of current === worktreesRoot. That makes
  // current === `<projectAbs>/.worktrees/<id>/`.
  while (true) {
    if (dirname(current) === worktreesRoot) {
      // current is `.worktrees/<id>/`
      return join(current, '.active-task');
    }
    const parent = dirname(current);
    if (parent === current) return null; // hit fs root
    if (parent === worktreesRoot) {
      // Already handled above, defensive.
      return join(current, '.active-task');
    }
    if (!parent.startsWith(worktreesRoot + sep) && parent !== worktreesRoot) {
      return null;
    }
    current = parent;
  }
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
 * Active task is identified by `readActiveTaskId`, which prefers a
 * per-worktree sentinel `<projectRoot>/.worktrees/<id>/.active-task`
 * (resolved by walking up from the tool's cwd) and falls back to a
 * project-level `<projectRoot>/.worktrees/.active-task` (legacy, kept
 * for one release per AISDLC-81) and finally to the env var
 * `AI_SDLC_ACTIVE_TASK_ID` for tests / external tooling.
 *
 * The per-worktree sentinel is what enables parallel `/ai-sdlc execute`
 * runs to share a project root without racing each other's allowlist.
 *
 * Returns [] when no active task, no matching task file, or no frontmatter field.
 */
function loadPermittedExternalPaths(projectAbs, searchFrom) {
  const taskId = readActiveTaskId(projectAbs, searchFrom);
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
