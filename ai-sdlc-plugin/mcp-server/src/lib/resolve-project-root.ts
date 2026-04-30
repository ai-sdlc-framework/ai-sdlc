/**
 * Project-root discovery for the plugin's MCP server (AISDLC-99).
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
 * 4. If none of the above produce a usable root, throw a clear error so the
 *    caller can surface a useful message instead of operating on a wrong
 *    path.
 */

import { existsSync, statSync } from 'node:fs';
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
 * Resolve the project root the plugin's MCP tools should operate against.
 *
 * @throws Error with the canonical "could not resolve project root" message
 * when no valid root is found. Callers should let this propagate so the MCP
 * tool returns it as `isError: true` content.
 */
export function resolveProjectRoot(opts: ResolveProjectRootOptions = {}): string {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const envProjectRoot = env.AI_SDLC_PROJECT_ROOT;
  if (envProjectRoot && hasBacklogDir(envProjectRoot)) {
    return resolve(envProjectRoot);
  }

  const claudeProjectDir = env.CLAUDE_PROJECT_DIR;
  if (claudeProjectDir && hasBacklogDir(claudeProjectDir)) {
    return resolve(claudeProjectDir);
  }

  const fromCwd = walkUpForBacklog(cwd);
  if (fromCwd) return fromCwd;

  throw new Error(ERROR_MESSAGE);
}

export const PROJECT_ROOT_ERROR_MESSAGE = ERROR_MESSAGE;
