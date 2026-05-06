/**
 * Step 0.5 — Auto-sync untracked parent task files before dispatch.
 *
 * Mirrors `ai-sdlc-plugin/commands/execute.md` Step 0.5. Scans the parent
 * (orchestrator) repo's working tree for untracked files matching
 * `backlog/{tasks,completed}/aisdlc-N*.md`. For each genuinely-new file
 * (not already on `origin/main`), creates a sync worktree on a generated
 * branch, copies the files there, commits, pushes, and opens a docs-only
 * PR. DOES NOT BLOCK — logs the sync PR URL and returns so main dispatch
 * proceeds in parallel with the sync PR's CI + auto-merge.
 *
 * This is the backstop safety net for Pattern C: AISDLC-216 routes MCP
 * tool writes into the correct worktree so most untracked files won't
 * appear. Step 0.5 catches the residual cases (external tooling, operator-
 * pasted files, etc.).
 *
 * ## Contract
 *
 * - `ok: true` + `syncedFiles: []` → parent is clean, no action taken.
 * - `ok: true` + `syncedFiles: [...]` + `prUrl` → sync PR opened; files
 *    now on origin; Step 0 self-heal on the next run will clean them up.
 * - `ok: true` + `skippedReason` → all untracked task files were already
 *    on `origin/main`; nothing to sync.
 * - `ok: false` + `reason` → non-backlog untracked files detected; operator
 *    must resolve before dispatch can proceed.
 *
 * @module steps/00-5-sync-parent
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultRunner, type Runner } from '../runtime/exec.js';

// Pattern matching backlog task files: backlog/tasks/aisdlc-N*.md
// or backlog/completed/aisdlc-N*.md
const BACKLOG_TASK_RE = /^backlog\/(tasks|completed)\/aisdlc-\d/i;

export interface SyncParentOptions {
  /**
   * Absolute path to the parent (orchestrator) repo root — the directory
   * that contains `.worktrees/`, `backlog/`, etc. Passed explicitly so the
   * step is pure and testable without touching `process.cwd()`.
   */
  workDir: string;
  /**
   * Optional runner — defaults to `defaultRunner` (live `child_process.execFile`).
   * Tests inject a `FakeRunner` to script git/gh side-effects.
   */
  runner?: Runner;
}

export interface SyncParentResult {
  ok: boolean;
  /** Reason for a non-ok result (non-backlog untracked files detected). */
  reason?: string;
  /** Files successfully synced to origin via the sync PR. */
  syncedFiles: string[];
  /** URL of the opened sync PR (populated only when syncedFiles is non-empty). */
  prUrl?: string;
  /**
   * Set when all untracked task files were already on origin/main (no-op sync).
   * Does not indicate an error.
   */
  skippedReason?: string;
}

/**
 * Returns the list of untracked files in `workDir` relative to the repo root,
 * using `git ls-files --others --exclude-standard`. Throws on git error.
 */
export async function listUntrackedFiles(workDir: string, runner: Runner): Promise<string[]> {
  const r = await runner('git', ['ls-files', '--others', '--exclude-standard', '--full-name'], {
    cwd: workDir,
    allowFailure: true,
  });
  if (r.code !== 0) {
    // Not a fatal error — possibly not a git repo; return empty
    return [];
  }
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Returns true if `relativePath` is already present in `origin/main`'s
 * tree (i.e. `git ls-tree origin/main <path>` returns a non-empty result).
 */
export async function isFileOnOriginMain(
  relativePath: string,
  workDir: string,
  runner: Runner,
): Promise<boolean> {
  const r = await runner('git', ['ls-tree', 'origin/main', '--name-only', relativePath], {
    cwd: workDir,
    allowFailure: true,
  });
  if (r.code !== 0) return false;
  return r.stdout.trim().length > 0;
}

/**
 * Returns a short sha-like suffix for branch names: the first 8 chars of
 * the git hash of HEAD. Falls back to a timestamp if git call fails.
 */
async function shortSha(workDir: string, runner: Runner): Promise<string> {
  const r = await runner('git', ['rev-parse', '--short=8', 'HEAD'], {
    cwd: workDir,
    allowFailure: true,
  });
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  return Date.now().toString(36).slice(-8);
}

/**
 * Core Step 0.5 implementation.
 *
 * 1. Lists all untracked files in `workDir`.
 * 2. Partitions them into backlog task files vs. everything else.
 * 3. If non-backlog untracked files exist → returns `ok: false` with an
 *    operator-attention message.
 * 4. For each backlog file, checks if it's already on `origin/main`.
 * 5. Genuinely-new files → creates a temp sync worktree, copies files,
 *    commits, pushes, opens a docs-only PR, returns `ok: true` + prUrl.
 * 6. All files already on origin → returns `ok: true` + `skippedReason`.
 * 7. No untracked files → returns `ok: true` + empty `syncedFiles`.
 */
export async function syncParentUntrackedFiles(opts: SyncParentOptions): Promise<SyncParentResult> {
  const runner = opts.runner ?? defaultRunner;
  const workDir = opts.workDir;

  // 1. List untracked files
  const untracked = await listUntrackedFiles(workDir, runner);

  if (untracked.length === 0) {
    return { ok: true, syncedFiles: [] };
  }

  // 2. Partition
  const backlogFiles = untracked.filter((f) => BACKLOG_TASK_RE.test(f));
  const otherFiles = untracked.filter((f) => !BACKLOG_TASK_RE.test(f));

  // 3. Non-backlog untracked files → operator attention required
  if (otherFiles.length > 0) {
    return {
      ok: false,
      reason:
        `Step 0.5: non-backlog untracked files detected in parent — manual cleanup required ` +
        `before dispatch can proceed.\n\nFiles:\n${otherFiles.map((f) => `  ${f}`).join('\n')}\n\n` +
        `These are not backlog task files (pattern: backlog/{tasks,completed}/aisdlc-N*.md). ` +
        `Clean them up manually (e.g. git clean -f <file>) and re-run.`,
      syncedFiles: [],
    };
  }

  // 4. All untracked files are backlog task files. Check which are genuinely new.
  const newFiles: string[] = [];
  const alreadyOnOrigin: string[] = [];

  for (const file of backlogFiles) {
    const onOrigin = await isFileOnOriginMain(file, workDir, runner);
    if (onOrigin) {
      alreadyOnOrigin.push(file);
    } else {
      newFiles.push(file);
    }
  }

  if (newFiles.length === 0) {
    return {
      ok: true,
      syncedFiles: [],
      skippedReason:
        `All ${backlogFiles.length} untracked backlog task file(s) are already on origin/main ` +
        `(${alreadyOnOrigin.join(', ')}) — skipping sync.`,
    };
  }

  // 5. Genuinely new files — create a sync worktree, commit, push, open PR.
  const sha = await shortSha(workDir, runner);
  const syncBranch = `chore/sync-tasks-${sha}`;

  // Reserve a unique temp path. mkdtempSync creates the directory atomically
  // (race-safe), but `git worktree add` requires the destination to NOT exist
  // — it creates the directory itself. Remove the empty dir immediately so the
  // path is reserved (no other process will collide on it within the same
  // tmpdir tick) but absent on disk when worktree add runs.
  const syncWorktreePath = mkdtempSync(join(tmpdir(), 'ai-sdlc-sync-parent-'));
  rmSync(syncWorktreePath, { recursive: true, force: true });
  try {
    // Create the worktree on origin/main
    const addResult = await runner(
      'git',
      ['worktree', 'add', syncWorktreePath, '-b', syncBranch, 'origin/main'],
      { cwd: workDir, allowFailure: true },
    );
    if (addResult.code !== 0) {
      return {
        ok: false,
        reason: `Step 0.5: failed to create sync worktree: ${addResult.stderr.trim() || addResult.stdout.trim()}`,
        syncedFiles: [],
      };
    }

    // Copy each new file into the sync worktree, preserving directory structure.
    for (const relPath of newFiles) {
      const srcAbs = join(workDir, relPath);
      const dstAbs = join(syncWorktreePath, relPath);
      mkdirSync(dirname(dstAbs), { recursive: true });
      copyFileSync(srcAbs, dstAbs);
    }

    // Stage all copied files
    const stageResult = await runner('git', ['add', '--', ...newFiles], {
      cwd: syncWorktreePath,
      allowFailure: true,
    });
    if (stageResult.code !== 0) {
      return {
        ok: false,
        reason: `Step 0.5: failed to stage files in sync worktree: ${stageResult.stderr.trim()}`,
        syncedFiles: [],
      };
    }

    // Commit
    const commitMsg =
      `chore: sync ${newFiles.length} untracked task file${newFiles.length === 1 ? '' : 's'} (AISDLC-217)\n\n` +
      `Auto-synced by Step 0.5 (backstop for Pattern C untracked-file drift).\n\n` +
      `Files:\n${newFiles.map((f) => `- ${f}`).join('\n')}\n\n` +
      `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`;

    const commitResult = await runner('git', ['commit', '-m', commitMsg], {
      cwd: syncWorktreePath,
      allowFailure: true,
    });
    if (commitResult.code !== 0) {
      return {
        ok: false,
        reason: `Step 0.5: failed to commit in sync worktree: ${commitResult.stderr.trim()}`,
        syncedFiles: [],
      };
    }

    // Push
    const pushResult = await runner('git', ['push', '-u', 'origin', syncBranch], {
      cwd: syncWorktreePath,
      allowFailure: true,
    });
    if (pushResult.code !== 0) {
      return {
        ok: false,
        reason: `Step 0.5: failed to push sync branch: ${pushResult.stderr.trim() || pushResult.stdout.trim()}`,
        syncedFiles: newFiles,
      };
    }

    // Open PR
    const prTitle = `chore: sync ${newFiles.length} untracked task file${newFiles.length === 1 ? '' : 's'}`;
    const prBody =
      `Auto-opened by Step 0.5 — backstop for Pattern C untracked-file drift (AISDLC-217).\n\n` +
      `## Files\n${newFiles.map((f) => `- \`${f}\``).join('\n')}\n\n` +
      `This is a docs-only PR (\`backlog/tasks/\` and \`backlog/completed/\` are under ` +
      `\`paths-ignore\` for attestation workflows) and will auto-merge once CI passes.\n\n` +
      `> Source: AISDLC-216 (Pattern-C MCP routing) is the upstream fix; Step 0.5 is the ` +
      `backstop for cases #216 misses.`;

    const prResult = await runner(
      'gh',
      [
        'pr',
        'create',
        '--title',
        prTitle,
        '--body',
        prBody,
        '--base',
        'main',
        '--head',
        syncBranch,
      ],
      { cwd: syncWorktreePath, allowFailure: true },
    );
    if (prResult.code !== 0) {
      return {
        ok: false,
        reason: `Step 0.5: files pushed but gh pr create failed: ${prResult.stderr.trim() || prResult.stdout.trim()}`,
        syncedFiles: newFiles,
      };
    }

    const prUrl = prResult.stdout.trim().split('\n').pop()?.trim();

    return {
      ok: true,
      syncedFiles: newFiles,
      prUrl,
    };
  } finally {
    // Always clean up the temp sync worktree. Best-effort — don't throw on failure.
    try {
      await runner('git', ['worktree', 'remove', '--force', syncWorktreePath], {
        cwd: workDir,
        allowFailure: true,
      });
    } catch {
      // ignore
    }
    try {
      rmSync(syncWorktreePath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
