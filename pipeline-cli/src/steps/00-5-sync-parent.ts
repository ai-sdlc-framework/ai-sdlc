/**
 * Step 0.5 — Auto-sync untracked parent task files before dispatch.
 *
 * Mirrors `ai-sdlc-plugin/commands/execute.md` Step 0.5. Scans the parent
 * (orchestrator) repo's working tree for untracked files matching
 * `backlog/{tasks,completed}/<prefix>-N*.md`. For each genuinely-new file
 * (not already on `origin/main`), files it through the `cli-file task` path
 * (AISDLC-860: ASCII, duplicate-id, backlog-drift and DoR checks, then a
 * `ai-sdlc/file-<id>` branch and PR); any refusal returns a `blocked` verdict. DOES NOT BLOCK — logs the sync PR URL and returns so main dispatch
 * proceeds in parallel with the sync PR's CI + auto-merge.
 *
 * This is the backstop safety net for Pattern C: AISDLC-216 routes MCP
 * tool writes into the correct worktree so most untracked files won't
 * appear. Step 0.5 catches the residual cases (external tooling, operator-
 * pasted files, etc.).
 *
 * ## Path-mismatch reconciliation (AISDLC-222)
 *
 * A stale local copy at `backlog/tasks/aisdlc-N - X.md` whose canonical
 * version has been completed and now lives at `backlog/completed/aisdlc-N -
 * X.md` on origin/main returns `false` from a naive exact-path `isFileOnOriginMain`
 * check — so Step 0.5 would open a sync PR for it, duplicating the file.
 *
 * The fix: for every untracked backlog task file, probe the ALTERNATE directory
 * on origin/main (tasks → completed, completed → tasks). When the basename is
 * found under the alternate path, the local file is a stale duplicate and is
 * skipped with a `[step-0.5]` log line. Opt-in auto-delete via
 * `AI_SDLC_STEP_0_5_AUTO_RECONCILE=1`.
 *
 * ## Prune stale parent debris (AISDLC-446)
 *
 * `pruneStaleParentDebris()` is a complementary step that runs AFTER
 * `syncParentUntrackedFiles`. It scans for untracked `backlog/tasks/<prefix>-N*.md`
 * files whose same-ID counterpart already exists in `origin/main:backlog/completed/`.
 * When the content matches (no diff), the stale tasks/ file is deleted silently
 * except for one log line. When content differs (operator has local edits), a
 * warning is logged and the file is preserved.
 *
 * ## Contract
 *
 * - `ok: true` + `syncedFiles: []` → parent is clean, no action taken.
 * - `ok: true` + `syncedFiles: [...]` + `prUrl` → sync PR opened; files
 *    now on origin; Step 0 self-heal on the next run will clean them up.
 * - `ok: true` + `skippedReason` → all untracked task files were already
 *    on `origin/main` (exact or path-mismatched); nothing to sync.
 * - `ok: false` + `reason` → non-backlog untracked files detected; operator
 *    must resolve before dispatch can proceed.
 *
 * @module steps/00-5-sync-parent
 */

import { unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import {
  defaultDeps as defaultFileDeps,
  fileTask,
  taskIdOf,
  validateTaskFile,
  type FileDeps,
  type ValidatedTask,
} from '../cli/file.js';

// ── AISDLC-609: task-id-prefix-agnostic resolution ──────────────────────────
//
// Historically this module hardcoded the `aisdlc-` task-id prefix used by
// THIS repo. A consumer repo configured with a different prefix (e.g. `LT-`)
// had its untracked stub task files silently ignored or mishandled by Step
// 0.5's sync + prune passes.
//
// Resolution order:
//   1. `backlog/config.yml`'s `task_prefix:` field (the same source Backlog.md
//      itself uses to mint task ids) — escaped and used verbatim.
//   2. A prefix-agnostic fallback shape (`<anything>-<digits>`) when no
//      explicit prefix is configured, so ANY adopter prefix is handled
//      without requiring config.
//
// `aisdlc-` behavior for this repo is preserved byte-for-byte: this repo's
// `backlog/config.yml` sets `task_prefix: 'AISDLC'`, so the derived pattern
// is `aisdlc-\d` — identical to the previous hardcoded regex.

/** Escapes a string for safe interpolation into a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads the configured task-id prefix from `backlog/config.yml`'s
 * `task_prefix:` field. Returns the lowercased prefix, or `null` when the
 * config file is absent or the field is not set — callers fall back to a
 * prefix-agnostic pattern in that case.
 */
export function readConfiguredTaskPrefix(workDir: string): string | null {
  try {
    const configPath = join(workDir, 'backlog', 'config.yml');
    if (!existsSync(configPath)) return null;
    const content = readFileSync(configPath, 'utf8');
    const match = content.match(/^\s*task_prefix\s*:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/m);
    if (!match) return null;
    return match[1].toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Returns the task-id-shape pattern source (no anchors, no capture group
 * around the id itself) to interpolate into the backlog-file regexes below:
 * either the escaped configured prefix, or a prefix-agnostic
 * `[a-z0-9][a-z0-9._]*` shape that matches any adopter prefix.
 */
function resolveTaskIdPrefixSource(workDir: string): string {
  const prefix = readConfiguredTaskPrefix(workDir);
  return prefix ? escapeRegExp(prefix) : '[a-z0-9][a-z0-9._]*';
}

/**
 * Pattern matching backlog task files: `backlog/tasks/<prefix>-N*.md` or
 * `backlog/completed/<prefix>-N*.md`, where `<prefix>` is derived per-repo
 * via `resolveTaskIdPrefixSource` (AISDLC-609).
 */
const DECISION_EVENTS_PREFIX = '.ai-sdlc/_decisions/events/';

function backlogTaskRegex(workDir: string): RegExp {
  return new RegExp(`^backlog/(tasks|completed)/${resolveTaskIdPrefixSource(workDir)}-\\d`, 'i');
}

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
  /** Injectable cli-file dependencies (AISDLC-860). */
  fileDeps?: FileDeps;
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
  /**
   * AISDLC-222 — path-mismatched files skipped (stale local copies whose
   * canonical version is in the alternate backlog directory on origin/main).
   * Populated only when path-mismatch files were detected.
   */
  pathMismatchedFiles?: string[];
  /** AISDLC-860: set to 'blocked' when the cli-file checks refused one or more files. */
  verdict?: 'blocked';
  refused?: Array<{ file: string; reason: string }>;
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
 * AISDLC-222 — Path-mismatch detection.
 *
 * Given a local `relativePath` such as `backlog/tasks/aisdlc-N - X.md`,
 * probes the ALTERNATE backlog directory on origin/main (e.g.
 * `backlog/completed/aisdlc-N - X.md`).
 *
 * Returns `{ found: true, canonicalPath }` when the basename exists under
 * the alternate directory on origin/main — indicating the local file is a
 * stale copy of a file that has already been moved on origin.
 *
 * Returns `{ found: false }` when no alternate-directory match is found.
 */
export async function findPathMismatchOnOrigin(
  relativePath: string,
  workDir: string,
  runner: Runner,
): Promise<{ found: true; canonicalPath: string } | { found: false }> {
  // Extract the directory segment (tasks or completed) and filename
  const match = relativePath.match(/^backlog\/(tasks|completed)\/(.+)$/i);
  if (!match) return { found: false };

  const [, localDirRaw, filename] = match;
  // The regex above is case-insensitive, so localDirRaw could be "Tasks" /
  // "Completed" on case-insensitive filesystems. Normalize before the equality
  // check (was a code-reviewer minor: the regex was /i but the comparison was
  // case-sensitive, so a `backlog/Tasks/...` path would route to the wrong altDir).
  const localDir = localDirRaw.toLowerCase();
  const altDir = localDir === 'tasks' ? 'completed' : 'tasks';
  const altPath = `backlog/${altDir}/${filename}`;

  const r = await runner('git', ['ls-tree', 'origin/main', '--name-only', altPath], {
    cwd: workDir,
    allowFailure: true,
  });
  if (r.code !== 0) return { found: false };
  if (r.stdout.trim().length === 0) return { found: false };
  return { found: true, canonicalPath: altPath };
}

/**
 * AISDLC-222 — Probes ALL backlog directories (tasks + completed) on
 * origin/main for the given file's basename. Returns `true` if the file
 * is present under ANY backlog directory on origin/main (exact path OR
 * alternate path), along with the found canonical path.
 */
export async function isFileOnOriginMainInAnyDir(
  relativePath: string,
  workDir: string,
  runner: Runner,
): Promise<{ onOrigin: boolean; exactMatch: boolean; canonicalPath: string | null }> {
  // 1. Exact path check
  const exact = await isFileOnOriginMain(relativePath, workDir, runner);
  if (exact) return { onOrigin: true, exactMatch: true, canonicalPath: relativePath };

  // 2. Alternate directory check (path-mismatch)
  const mismatch = await findPathMismatchOnOrigin(relativePath, workDir, runner);
  if (mismatch.found) {
    return { onOrigin: true, exactMatch: false, canonicalPath: mismatch.canonicalPath };
  }

  return { onOrigin: false, exactMatch: false, canonicalPath: null };
}

/**
 * AISDLC-874 — delete untracked decision-event files whose content is
 * byte-identical to the same path on `origin/main` (they would otherwise block
 * the fast-forward once the record lands). A differing file is never deleted;
 * it stays untracked and the caller still tolerates it. Tracked files are never
 * touched: the input is the untracked list only. Returns the removed paths.
 */
export async function removeUntrackedIdenticalToMain(
  untracked: string[],
  workDir: string,
  runner: Runner,
): Promise<string[]> {
  const removed: string[] = [];
  for (const f of untracked.filter((u) => u.startsWith(DECISION_EVENTS_PREFIX))) {
    const main = await runner('git', ['rev-parse', '--verify', '-q', `origin/main:${f}`], {
      cwd: workDir,
      allowFailure: true,
    });
    if (main.code !== 0 || main.stdout.trim() === '') continue;
    const local = await runner('git', ['hash-object', '--', f], {
      cwd: workDir,
      allowFailure: true,
    });
    if (local.code !== 0 || !existsSync(join(workDir, f))) continue;
    if (local.stdout.trim() !== main.stdout.trim()) {
      console.warn(`[step-0.5] untracked ${f} differs from origin/main; left in place`);
      continue;
    }
    unlinkSync(join(workDir, f));
    console.log(`[step-0.5] removed untracked ${f} (identical to origin/main)`);
    removed.push(f);
  }
  return removed;
}

/**
 * Core Step 0.5 implementation.
 *
 * 1. Lists all untracked files in `workDir`.
 * 2. Partitions them into backlog task files vs. everything else.
 * 3. If non-backlog untracked files exist → returns `ok: false` with an
 *    operator-attention message.
 * 4. For each backlog file, checks if it's already on `origin/main` (exact
 *    path OR alternate backlog directory — AISDLC-222 path-mismatch detection).
 *    Path-mismatched files are skipped with a log line and optionally deleted
 *    when `AI_SDLC_STEP_0_5_AUTO_RECONCILE=1` is set.
 * 5. Genuinely-new files → creates a temp sync worktree, copies files,
 *    commits, pushes, opens a docs-only PR, returns `ok: true` + prUrl.
 * 6. All files already on origin → returns `ok: true` + `skippedReason`.
 * 7. No untracked files → returns `ok: true` + empty `syncedFiles`.
 */
export async function syncParentUntrackedFiles(opts: SyncParentOptions): Promise<SyncParentResult> {
  const runner = opts.runner ?? defaultRunner;
  const workDir = opts.workDir;
  const autoReconcile = process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'] === '1';

  // 1. List untracked files
  let untracked = await listUntrackedFiles(workDir, runner);

  // AISDLC-874: untracked decision events byte-identical to origin/main would
  // block a fast-forward; delete those (only those) before anything else.
  const removed = await removeUntrackedIdenticalToMain(untracked, workDir, runner);
  if (removed.length > 0) untracked = untracked.filter((f) => !removed.includes(f));

  if (untracked.length === 0) {
    return { ok: true, syncedFiles: [] };
  }

  // 2. Partition (AISDLC-609: prefix derived per-repo, not hardcoded aisdlc-)
  const backlogTaskRe = backlogTaskRegex(workDir);
  const backlogFiles = untracked.filter((f) => backlogTaskRe.test(f));
  // AISDLC-825: decision events filed from task worktrees land in the parent
  // catalog untracked until a fast-forward brings them; tolerate them.
  const otherFiles = untracked.filter(
    (f) => !backlogTaskRe.test(f) && !f.startsWith(DECISION_EVENTS_PREFIX),
  );

  // 3. Non-backlog untracked files → operator attention required
  if (otherFiles.length > 0) {
    // AISDLC-609: name the ACTUAL resolved pattern/prefix in the message, not
    // a generic placeholder. Before this fix, a repo whose configured prefix
    // wasn't recognized would have its real task files land in `otherFiles`
    // and the refusal would misleadingly call them "non-backlog" without any
    // indication of what pattern was expected — leaving the operator unable
    // to tell whether their files were truly foreign or a prefix-resolution
    // bug. Surfacing the resolved prefix source makes that failure mode
    // self-diagnosing instead of silent/misleading.
    const configuredPrefix = readConfiguredTaskPrefix(workDir);
    const patternDesc = configuredPrefix
      ? `backlog/{tasks,completed}/${configuredPrefix}-N*.md (prefix "${configuredPrefix}" read from backlog/config.yml's task_prefix)`
      : `backlog/{tasks,completed}/<prefix>-N*.md (no task_prefix configured in backlog/config.yml — using the prefix-agnostic fallback shape: any lowercase-alphanumeric prefix followed by "-" and digits)`;
    return {
      ok: false,
      reason:
        `Step 0.5: non-backlog untracked files detected in parent — manual cleanup required ` +
        `before dispatch can proceed.\n\nFiles:\n${otherFiles.map((f) => `  ${f}`).join('\n')}\n\n` +
        `These do not match the recognized backlog task file pattern: ${patternDesc}. ` +
        `If these ARE your project's task files, check backlog/config.yml's task_prefix — otherwise ` +
        `clean them up manually (e.g. git clean -f <file>) and re-run.`,
      syncedFiles: [],
    };
  }

  // 4. All untracked files are backlog task files. Check which are genuinely new.
  // AISDLC-222: also probe the alternate backlog directory to catch path-mismatched
  // stale local copies.
  const newFiles: string[] = [];
  const alreadyOnOrigin: string[] = [];
  const pathMismatchedFiles: string[] = [];

  // Security minor (AISDLC-222 review): filenames come from `git ls-files` and
  // a contributor could in principle commit a file whose name contains ANSI
  // escape sequences (`\x1b[...`) or other control characters. Interpolating
  // those raw into `console.log` lets them manipulate the operator's terminal.
  // `safeForLog` strips C0/C1 control chars before interpolation. Used for any
  // filename echoed from this step's logs.
  const safeForLog = (s: string): string =>
    // eslint-disable-next-line no-control-regex
    s.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');

  for (const file of backlogFiles) {
    const check = await isFileOnOriginMainInAnyDir(file, workDir, runner);
    if (check.onOrigin && check.exactMatch) {
      alreadyOnOrigin.push(file);
    } else if (check.onOrigin && !check.exactMatch) {
      // Path-mismatch: local file exists at a different path than origin's canonical location.
      // Skip syncing — would duplicate the file. Log for operator visibility.
      const canonicalPath = check.canonicalPath!;
      const safeFile = safeForLog(file);
      const safeBase = safeForLog(basename(file));
      const safeCanonical = safeForLog(canonicalPath);
      console.log(
        `[step-0.5] ${safeBase}: stale local copy at ${safeFile}; canonical version on origin at ${safeCanonical} — skipping sync`,
      );
      pathMismatchedFiles.push(file);

      // AISDLC-222 opt-in: auto-delete stale local copy when env var is set
      if (autoReconcile) {
        const absPath = join(workDir, file);
        try {
          // Prefer git rm for tracked files; fall back to unlinkSync for untracked
          const gitRmResult = await runner('git', ['rm', '--force', '--', file], {
            cwd: workDir,
            allowFailure: true,
          });
          if (gitRmResult.code !== 0) {
            // File is untracked — remove directly
            if (existsSync(absPath)) {
              unlinkSync(absPath);
            }
          }
          console.log(
            `[step-0.5] ${safeBase}: auto-reconcile: deleted stale local copy at ${safeFile}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[step-0.5] ${safeBase}: auto-reconcile: failed to delete ${safeFile}: ${safeForLog(msg)}`,
          );
        }
      }
    } else {
      newFiles.push(file);
    }
  }

  const totalSkipped = alreadyOnOrigin.length + pathMismatchedFiles.length;

  if (newFiles.length === 0) {
    const skipParts: string[] = [];
    if (alreadyOnOrigin.length > 0) {
      skipParts.push(
        `${alreadyOnOrigin.length} file(s) already on origin/main at exact path (${alreadyOnOrigin.join(', ')})`,
      );
    }
    if (pathMismatchedFiles.length > 0) {
      skipParts.push(
        `${pathMismatchedFiles.length} path-mismatched file(s) skipped (stale local copies — see [step-0.5] log lines above)`,
      );
    }
    return {
      ok: true,
      syncedFiles: [],
      skippedReason:
        `All ${totalSkipped} untracked backlog task file(s) skipped — nothing to sync. ` +
        skipParts.join('; '),
      ...(pathMismatchedFiles.length > 0 ? { pathMismatchedFiles } : {}),
    };
  }

  // 5. Genuinely new files — create a sync worktree, commit, push, open PR.
  // AISDLC-860: file every new task through the `cli-file task` path (ASCII, duplicate id
  // on origin/main, backlog-drift, DoR). Validate ALL first so a refusal creates no branch or PR.
  const fileDeps = opts.fileDeps ?? defaultFileDeps;
  // AISDLC-950: a leftover source copy whose filing branch already exists is skipped, never re-filed.
  const toFile: string[] = [];
  const onExistingBranch: string[] = [];
  for (const file of newFiles) {
    let branch: string | null = null;
    try {
      branch = `ai-sdlc/file-${taskIdOf(join(workDir, file)).toLowerCase()}`;
    } catch {
      // no derivable id: validation below reports it
    }
    if (branch) {
      const found = await runner(
        'git',
        ['branch', '--all', '--list', branch, `remotes/origin/${branch}`],
        { cwd: workDir, allowFailure: true },
      );
      if (found.code === 0 && found.stdout.trim() !== '') {
        console.log(
          `[step-0.5] ${safeForLog(basename(file))}: filing branch ${branch} already exists — skipping (the branch holds this file)`,
        );
        onExistingBranch.push(file);
        continue;
      }
    }
    toFile.push(file);
  }
  if (toFile.length === 0) {
    return {
      ok: true,
      syncedFiles: [],
      skippedReason: `All untracked backlog task file(s) skipped — filing branch already exists for ${onExistingBranch.length} file(s)`,
      ...(pathMismatchedFiles.length > 0 ? { pathMismatchedFiles } : {}),
    };
  }
  newFiles.splice(0, newFiles.length, ...toFile);
  const refused: Array<{ file: string; reason: string }> = [];
  const validated = new Map<string, ValidatedTask>();
  for (const file of newFiles) {
    try {
      validated.set(file, validateTaskFile(workDir, file, fileDeps));
    } catch (err) {
      refused.push({ file, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  if (refused.length > 0) {
    return {
      ok: false,
      verdict: 'blocked',
      refused,
      reason:
        `Step 0.5: blocked, ${refused.length} untracked task file(s) refused by the cli-file checks ` +
        `(nothing was filed):\n${refused.map((r) => `  ${safeForLog(r.file)}: ${safeForLog(r.reason)}`).join('\n')}`,
      syncedFiles: [],
    };
  }

  const prUrls: string[] = [];
  for (const file of newFiles) {
    const task = validated.get(file)!;
    const branch = `ai-sdlc/file-${task.id.toLowerCase()}`;
    const existing = await runner(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url'],
      { cwd: workDir, allowFailure: true },
    );
    try {
      const open: unknown = JSON.parse(existing.stdout.trim() || '[]');
      if (Array.isArray(open) && open.length > 0) {
        const pr = open[0] as { number: number; url: string };
        console.log(`[step-0.5] reusing open filing PR #${pr.number} (${branch})`);
        prUrls.push(pr.url);
        continue;
      }
    } catch {
      // fall through to filing
    }
    try {
      const r = fileTask(workDir, file, { pr: true, validated: task }, fileDeps);
      if (r.prUrl) prUrls.push(r.prUrl);
    } catch (err) {
      return {
        ok: false,
        reason: `Step 0.5: filing ${safeForLog(file)} failed: ${safeForLog(err instanceof Error ? err.message : String(err))}`,
        syncedFiles: [],
      };
    }
  }

  return {
    ok: true,
    syncedFiles: newFiles,
    prUrl: prUrls[prUrls.length - 1],
    ...(pathMismatchedFiles.length > 0 ? { pathMismatchedFiles } : {}),
  };
}

// ── AISDLC-446: Prune stale parent debris ─────────────────────────────────────

/**
 * Options for `pruneStaleParentDebris`.
 */
export interface PruneStaleParentDebrisOptions {
  /**
   * Absolute path to the parent (orchestrator) repo root.
   */
  workDir: string;
  /**
   * Optional runner — defaults to `defaultRunner`.
   */
  runner?: Runner;
}

/**
 * Per-file decision recorded by `pruneStaleParentDebris`.
 */
export type PruneDecision =
  | { file: string; action: 'deleted' }
  | { file: string; action: 'skipped-content-differs' }
  | { file: string; action: 'no-counterpart' };

/**
 * Result shape returned by `pruneStaleParentDebris`.
 */
export interface PruneStaleParentDebrisResult {
  /** True even when nothing was pruned — false only on internal error. */
  ok: boolean;
  /** Optional error message when ok === false. */
  reason?: string;
  /** Files deleted (matched + content identical). */
  pruned: string[];
  /** Files skipped because content differed from the completed/ version. */
  skippedContentDiffers: string[];
  /** Files skipped because no completed/ counterpart exists on origin/main. */
  noCounterpart: string[];
}

/**
 * Extract the task ID from a backlog filename.
 *
 * Given `backlog/tasks/aisdlc-446 - some-slug.md`, returns `aisdlc-446`
 * (lowercased); given `backlog/tasks/lt-592 - x.md`, returns `lt-592`. Returns
 * `null` when the filename doesn't match the `backlog/{tasks,completed}/<prefix>-N`
 * shape. AISDLC-609: intentionally PREFIX-AGNOSTIC (any `<prefix>-<digit>`), not
 * tied to the configured task_prefix — pairing a tasks/ file to its completed/
 * counterpart compares IDs extracted the SAME way on both sides, so it is
 * correct for any prefix, and the prune delete is additionally content-guarded.
 */
export function extractTaskId(relativePath: string): string | null {
  // Match backlog/tasks/ or backlog/completed/ prefix + a <prefix>-N task id
  // (prefix-agnostic; see JSDoc above for why this need not consult config).
  const match = relativePath.match(/^backlog\/(?:tasks|completed)\/([a-z0-9][a-z0-9._]*-\d+)\b/i);
  if (!match) return null;
  return match[1].toLowerCase();
}

/**
 * Find an untracked `backlog/tasks/<prefix>-N*.md` file's counterpart in
 * `origin/main:backlog/completed/` by task ID (not by exact filename, since
 * the slug might differ). Returns the completed/ path on origin/main when
 * found, or null when not found.
 *
 * Uses `git ls-tree origin/main backlog/completed/` to list completed files
 * and filters by task ID prefix.
 */
export async function findCompletedCounterpartOnOrigin(
  taskId: string,
  workDir: string,
  runner: Runner,
): Promise<string | null> {
  // List all files under backlog/completed/ on origin/main
  const r = await runner('git', ['ls-tree', 'origin/main', '--name-only', 'backlog/completed/'], {
    cwd: workDir,
    allowFailure: true,
  });
  if (r.code !== 0 || !r.stdout.trim()) return null;

  const files = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Find a file whose task-ID prefix matches (case-insensitive)
  const idLower = taskId.toLowerCase();
  const match = files.find((f) => {
    const fileId = extractTaskId(f);
    return fileId?.toLowerCase() === idLower;
  });

  return match ?? null;
}

/**
 * Read the content of a file from `origin/main` via `git show`.
 * Returns the content string on success, or null on failure.
 */
export async function readOriginMainFile(
  relativePath: string,
  workDir: string,
  runner: Runner,
): Promise<string | null> {
  const r = await runner('git', ['show', `origin/main:${relativePath}`], {
    cwd: workDir,
    allowFailure: true,
  });
  if (r.code !== 0) return null;
  return r.stdout;
}

/**
 * AISDLC-446 — Prune stale parent debris.
 *
 * Scans the parent's working tree for untracked `backlog/tasks/<prefix>-N*.md`
 * files. For each:
 *
 * 1. If a same-ID file exists in `origin/main:backlog/completed/` AND content
 *    matches → delete the stale tasks/ file (one log line per deletion).
 * 2. If a same-ID file exists BUT content differs → log a warning, skip
 *    (operator may have local edits worth preserving).
 * 3. If no same-ID file exists in completed/ on origin → leave alone
 *    (genuine new task; the existing sync-to-main path handles it).
 *
 * Idempotent: re-running when nothing matches produces no output.
 */
export async function pruneStaleParentDebris(
  opts: PruneStaleParentDebrisOptions,
): Promise<PruneStaleParentDebrisResult> {
  const runner = opts.runner ?? defaultRunner;
  const workDir = opts.workDir;

  // Safe terminal-output sanitiser — strips C0/C1 control chars.
  // eslint-disable-next-line no-control-regex
  const safeForLog = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');

  // List all untracked files
  const untracked = await listUntrackedFiles(workDir, runner);

  // Keep only backlog/tasks/ files matching the aisdlc-N pattern
  const taskFiles = untracked.filter(
    (f) => backlogTaskRegex(workDir).test(f) && f.startsWith('backlog/tasks/'),
  );

  const pruned: string[] = [];
  const skippedContentDiffers: string[] = [];
  const noCounterpart: string[] = [];

  for (const file of taskFiles) {
    const taskId = extractTaskId(file);
    if (!taskId) {
      // Safety: shouldn't happen given the regex above, but skip gracefully
      noCounterpart.push(file);
      continue;
    }

    // Check for counterpart in origin/main:backlog/completed/
    const counterpartPath = await findCompletedCounterpartOnOrigin(taskId, workDir, runner);

    if (!counterpartPath) {
      // AC #5: no counterpart — leave alone
      noCounterpart.push(file);
      continue;
    }

    // AC #3/#4: counterpart found — compare content
    const originContent = await readOriginMainFile(counterpartPath, workDir, runner);

    // Read the local file content
    let localContent: string | null;
    const absPath = join(workDir, file);
    try {
      localContent = readFileSync(absPath, 'utf8');
    } catch {
      // Can't read local file — skip
      console.warn(
        `[prune-stale-debris] ${safeForLog(basename(file))}: could not read local file — skipping`,
      );
      skippedContentDiffers.push(file);
      continue;
    }

    if (originContent === null) {
      // Can't read origin content — skip conservatively
      console.warn(
        `[prune-stale-debris] ${safeForLog(basename(file))}: could not read origin content for ${safeForLog(counterpartPath)} — skipping`,
      );
      skippedContentDiffers.push(file);
      continue;
    }

    if (localContent !== originContent) {
      // AC #4: content differs — warn and skip
      console.warn(
        `[prune-stale-debris] ${safeForLog(basename(file))}: content differs from origin completed/ version (${safeForLog(counterpartPath)}) — skipping (operator may have local edits)`,
      );
      skippedContentDiffers.push(file);
      continue;
    }

    // AC #3: content matches — safe to delete
    try {
      unlinkSync(absPath);
      console.log(
        `[prune-stale-debris] ${safeForLog(file)}: pruned (matched completed/ version at ${safeForLog(counterpartPath)})`,
      );
      pruned.push(file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[prune-stale-debris] ${safeForLog(file)}: failed to delete — ${safeForLog(msg)}`,
      );
      skippedContentDiffers.push(file);
    }
  }

  return { ok: true, pruned, skippedContentDiffers, noCounterpart };
}
