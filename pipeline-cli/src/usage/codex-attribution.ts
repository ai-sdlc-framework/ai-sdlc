/**
 * Scope and task attribution for ingested Codex sessions (RFC-0050 A3).
 *
 * A session is `framework` scope when its working directory is inside a
 * repository that has an `.ai-sdlc/` directory. Every other session is `other`
 * scope: the ledger keeps tokens, model, timestamp and harness only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

export interface CodexAttribution {
  scope: 'framework' | 'other';
  repo?: string;
  taskId?: string;
}

const TASK_ID_RE = /\b([a-z][a-z0-9]*-\d+)\b/i;

/** Nearest ancestor of `cwd` (inclusive) that contains `.ai-sdlc/`. */
function findFrameworkRoot(cwd: string): string | undefined {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.ai-sdlc'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function taskFromWorktreePath(cwd: string): string | undefined {
  const parts = cwd.split(sep);
  const i = parts.lastIndexOf('.worktrees');
  const seg = i >= 0 ? parts[i + 1] : undefined;
  return seg && TASK_ID_RE.test(seg) ? TASK_ID_RE.exec(seg)![1].toUpperCase() : undefined;
}

function taskFromBranch(branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  const m = TASK_ID_RE.exec(branch);
  return m ? m[1].toUpperCase() : undefined;
}

function taskFromSentinel(root: string): string | undefined {
  try {
    const raw = readFileSync(join(root, '.active-task'), 'utf-8').trim();
    const m = TASK_ID_RE.exec(raw);
    return m ? m[1].toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Repository name: the directory that holds `.worktrees/`, else the root itself. */
function repoName(root: string, cwd: string): string {
  const parts = cwd.split(sep);
  const i = parts.lastIndexOf('.worktrees');
  if (i > 0) return parts[i - 1] || basename(root);
  return basename(root);
}

/**
 * Resolve attribution for a session. Task order: `.worktrees/<task-id>` path
 * segment, then the branch name, then the `.active-task` sentinel.
 */
export function attributeCodexSession(
  cwd: string | undefined,
  branch: string | undefined,
  cache: Map<string, CodexAttribution> = new Map(),
): CodexAttribution {
  if (!cwd) return { scope: 'other' };
  const key = `${cwd}\u0000${branch ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const root = findFrameworkRoot(cwd);
  let result: CodexAttribution;
  if (!root) {
    result = { scope: 'other' };
  } else {
    const taskId = taskFromWorktreePath(cwd) ?? taskFromBranch(branch) ?? taskFromSentinel(root);
    result = {
      scope: 'framework',
      repo: repoName(root, cwd),
      ...(taskId ? { taskId } : {}),
    };
  }
  cache.set(key, result);
  return result;
}
