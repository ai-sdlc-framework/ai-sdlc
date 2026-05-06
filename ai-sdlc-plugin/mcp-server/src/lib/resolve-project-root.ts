/**
 * Project-root discovery for the plugin's MCP server (AISDLC-99, AISDLC-216).
 *
 * The plugin's `plugin.json` sets `AI_SDLC_PROJECT_ROOT=${CLAUDE_PLUGIN_DATA}`
 * which resolves to `~/.claude/plugins/data/<source>-<plugin-name>/` — a
 * write-available data directory that has nothing to do with the project the
 * user is actually working in. So tools that operate on `<project>/backlog/`
 * (e.g. `task_edit`, `task_complete`) silently target the wrong filesystem
 * location and either fail to find tasks or, worse, edit the plugin's data
 * directory instead of the project.
 *
 * Resolution order:
 *
 * 1. `AI_SDLC_PROJECT_ROOT` env var — but only if it points at a directory
 *    that contains a `backlog/` subdirectory. (The plugin's default value
 *    fails this check, so we transparently fall through to step 2.)
 * 2. `CLAUDE_PROJECT_DIR` env var — set by Claude Code when a session is
 *    bound to a project. Same `backlog/` validity check.
 * 3. Walk up from `process.cwd()` looking for the nearest ancestor directory
 *    that contains a `backlog/` subdirectory.
 * 4. **Pattern C check** (AISDLC-216): if the resolved root has a `.worktrees/`
 *    directory with at least one worktree subdir, it is a Pattern C parent
 *    (non-bare repo with isolated worktrees). In that case:
 *    a. Look up the active task via `AI_SDLC_ACTIVE_TASK_ID` env var.
 *    b. Fall back to reading `<root>/.active-task` file.
 *    c. If a task ID is found, re-root into `<root>/.worktrees/<task-id-lower>/`.
 *    d. If no task signal is present, refuse with a helpful error so writes
 *       do not accumulate untracked debris in the parent's working tree.
 * 5. If none of the above produce a usable root, throw a clear error so the
 *    caller can surface a useful message instead of operating on a wrong
 *    path.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface ResolveProjectRootOptions {
  /** Env mapping; defaults to `process.env`. Injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Starting cwd; defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
}

const ERROR_MESSAGE =
  'AI-SDLC: could not resolve project root. ' +
  'Set AI_SDLC_PROJECT_ROOT or run from a directory inside a project with a backlog/ subdirectory.';

export const PATTERN_C_ERROR_MESSAGE =
  'AI-SDLC: Pattern C detected — parent working tree is read-only. ' +
  'Set AI_SDLC_ACTIVE_TASK_ID env (e.g. export AI_SDLC_ACTIVE_TASK_ID=AISDLC-216) ' +
  'or ensure /ai-sdlc execute has written a per-worktree .active-task sentinel ' +
  '(at .worktrees/<task-id>/.active-task) before launching Claude Code.';

/**
 * Returns true when `dir` is an existing directory that contains a
 * `backlog/` subdirectory (also itself a directory). Any I/O error is
 * treated as "not a project root" — we never throw from the validity check.
 */
function hasBacklogDir(dir: string): boolean {
  try {
    if (!existsSync(dir)) return false;
    if (!statSync(dir).isDirectory()) return false;
    const backlog = resolve(dir, 'backlog');
    if (!existsSync(backlog)) return false;
    return statSync(backlog).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk up from `start` (inclusive) looking for the nearest ancestor that
 * passes `hasBacklogDir`. Returns the absolute path when found, otherwise
 * `undefined`. Stops at the filesystem root.
 */
function walkUpForBacklog(start: string): string | undefined {
  let current = isAbsolute(start) ? start : resolve(start);
  // Bounded by the filesystem root: dirname('/') === '/' on POSIX and
  // 'C:\\' on Windows, so the loop terminates.
  while (true) {
    if (hasBacklogDir(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Detect whether `root` is a Pattern C parent repo.
 *
 * A Pattern C parent has a `.worktrees/` directory that contains at least one
 * subdirectory (i.e. at least one worktree has been checked out). Any I/O
 * error is treated as "not Pattern C".
 */
export function isPatternCParent(root: string): boolean {
  try {
    const worktreesDir = resolve(root, '.worktrees');
    if (!existsSync(worktreesDir)) return false;
    if (!statSync(worktreesDir).isDirectory()) return false;
    const entries = readdirSync(worktreesDir, { withFileTypes: true });
    return entries.some((e) => e.isDirectory());
  } catch {
    return false;
  }
}

/**
 * Given a Pattern C parent `root` and an optional env mapping, determine
 * the active task ID (lower-cased) to use for worktree routing.
 *
 * Lookup order:
 * 1. `AI_SDLC_ACTIVE_TASK_ID` env var
 * 2. Per-worktree `.active-task` sentinel — scans `<root>/.worktrees/<id>/.active-task`
 *    (matches `pipeline-cli/src/steps/04-flip-status.ts` write location and the
 *    `findWorktreeSentinel` pattern used by enforce-blocked-actions.js +
 *    pipeline-cli/src/orchestrator/in-flight.ts). If multiple sentinels exist
 *    (multi-task parallel runs), returns the most-recently-modified one.
 *
 * Returns the lower-cased task ID on success, or `undefined` when no signal
 * is present.
 */
export function resolveActiveTaskId(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // 1. Env var takes precedence.
  const envTaskId = env.AI_SDLC_ACTIVE_TASK_ID;
  if (envTaskId && envTaskId.trim()) {
    return envTaskId.trim().toLowerCase();
  }

  // 2. Per-worktree .active-task sentinels.
  const worktreesDir = resolve(root, '.worktrees');
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(worktreesDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let bestTaskId: string | undefined;
  let bestMtime = -Infinity;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sentinel = resolve(worktreesDir, entry.name, '.active-task');
    try {
      const stat = statSync(sentinel);
      if (!stat.isFile()) continue;
      const contents = readFileSync(sentinel, 'utf-8').trim();
      if (!contents) continue;
      const mtime = stat.mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        bestTaskId = contents.toLowerCase();
      }
    } catch {
      // skip unreadable / missing sentinel
    }
  }
  return bestTaskId;
}

/**
 * Resolve the project root the plugin's MCP tools should operate against.
 *
 * Includes Pattern C detection (AISDLC-216): when the resolved candidate root
 * is a Pattern C parent (has `.worktrees/` subdirs), we re-root into the
 * active worktree instead of the parent. If no active-task signal is present,
 * we throw the Pattern C error so callers surface a helpful refusal instead
 * of writing to the parent's read-only working tree.
 *
 * @throws Error with the canonical "could not resolve project root" message
 * when no valid root is found, or the Pattern C error message when Pattern C
 * is detected but no active-task signal is set.
 * Callers should let this propagate so the MCP tool returns it as
 * `isError: true` content.
 */
export function resolveProjectRoot(opts: ResolveProjectRootOptions = {}): string {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const envProjectRoot = env.AI_SDLC_PROJECT_ROOT;
  if (envProjectRoot && hasBacklogDir(envProjectRoot)) {
    return applyPatternCIfNeeded(resolve(envProjectRoot), env);
  }

  const claudeProjectDir = env.CLAUDE_PROJECT_DIR;
  if (claudeProjectDir && hasBacklogDir(claudeProjectDir)) {
    return applyPatternCIfNeeded(resolve(claudeProjectDir), env);
  }

  const fromCwd = walkUpForBacklog(cwd);
  if (fromCwd) return applyPatternCIfNeeded(fromCwd, env);

  throw new Error(ERROR_MESSAGE);
}

/**
 * Given a candidate project root, apply Pattern C re-routing if needed.
 *
 * - If `root` is NOT a Pattern C parent, return it unchanged.
 * - If it IS a Pattern C parent AND an active-task signal is present, return
 *   the worktree root `<root>/.worktrees/<task-id-lower>/` (validated to have
 *   a `backlog/` dir, else fall through with a warning to parent root).
 * - If it IS a Pattern C parent AND NO active-task signal is present, throw
 *   the Pattern C error.
 *
 * This is exported so tests can drive it directly.
 */
export function applyPatternCIfNeeded(root: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isPatternCParent(root)) return root;

  const taskId = resolveActiveTaskId(root, env);
  if (!taskId) {
    throw new Error(PATTERN_C_ERROR_MESSAGE);
  }

  const worktreeRoot = resolve(root, '.worktrees', taskId);
  if (hasBacklogDir(worktreeRoot)) {
    return worktreeRoot;
  }

  // Worktree exists in .active-task/AI_SDLC_ACTIVE_TASK_ID but its backlog/
  // hasn't been created yet (or it's the wrong ID). Throw with a clear message
  // rather than silently falling back to the parent root.
  throw new Error(
    `AI-SDLC: Pattern C active task '${taskId}' found but worktree at ` +
      `${worktreeRoot} does not contain a backlog/ directory. ` +
      `Ensure the worktree is fully initialised or update AI_SDLC_ACTIVE_TASK_ID.`,
  );
}

export const PROJECT_ROOT_ERROR_MESSAGE = ERROR_MESSAGE;
