/**
 * Frontier dispatch-readiness rubric (AISDLC-451).
 *
 * The DoR rubric checks task SHAPE (references, ACs, free of TBD/XXX). The
 * dependency-graph + upstream-OQ gate check UPSTREAM readiness (deps + RFC
 * lifecycle/OQ status). Neither check answers the operator's most basic
 * triage question: **is dispatching this task right now actually a sensible
 * use of subscription minutes?**
 *
 * The 2026-05-27 session crystallised the gap: `cli-deps frontier`
 * returned 14 "ready" tasks; on inspection 1 was already shipped (the work
 * landed on main but the task file remained in `backlog/tasks/`), 1 had a
 * prior PR that closed without merging, plus a couple of session-list
 * items that referenced backlog IDs that had never been filed as task
 * files. ~15 minutes burned triaging instead of dispatching.
 *
 * This module computes a single `dispatchReadiness` verdict per task ID by
 * running four independent checks in declarative-priority order. The
 * verdict feeds into:
 *
 *   - `cli-deps frontier --check-dispatch-readiness` — annotates each
 *     frontier entry so the operator sees the verdict before they pick a
 *     task to dispatch.
 *   - `/ai-sdlc orchestrator-tick` Step 5 (fill-to-cap) — skips
 *     non-`ready` candidates and surfaces them as Decision Catalog
 *     candidates on the next tick.
 *
 * ## Verdict precedence
 *
 * Computed top-to-bottom; first match wins. Stable across runs so the
 * downstream Decision Catalog gets idempotent records.
 *
 *   1. `missing-id`        — no backlog file exists for the task ID
 *   2. `blocked`           — task file carries a `blocked.reason` (reuses
 *                            the upstream-OQ gate's parser for parity)
 *   3. `stale-shipped`     — a merged commit on `origin/main` carries
 *                            `(AISDLC-N)` in its subject AND no in-flight
 *                            PR is referencing the same ID; the work has
 *                            shipped and the task file is just lingering
 *   4. `closed-prior-pr`   — `gh pr list --search "AISDLC-N" --state closed`
 *                            returns at least one PR with no merged-at
 *                            timestamp (closed without merge). Indicates
 *                            a prior attempt that the operator should
 *                            triage rather than blindly retry
 *   5. `ready`             — none of the above; safe to dispatch
 *
 * ## Side-effect surface
 *
 * Pure with respect to the filesystem. Calls `git log` + `gh pr list` via
 * injected commands (`gitLogCmd` + `ghPrListCmd`) — production callers
 * use the default child_process spawns; tests inject hermetic stubs so
 * the module is unit-testable without a real repo / GH token.
 *
 * @module dor/dispatch-readiness
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractBlockedReason } from './upstream-oq-gate.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Possible dispatch-readiness verdicts. Stable string union — used as a
 * map key in downstream consumers (the table renderer + Step 5 admission
 * filter) so adding a new variant is an API change.
 */
export type DispatchReadiness =
  | 'ready'
  | 'stale-shipped'
  | 'closed-prior-pr'
  | 'blocked'
  | 'missing-id';

/**
 * Per-task verdict with the supporting evidence. Evidence shape is
 * verdict-specific:
 *   - `stale-shipped`     → list of merged commit SHAs that carry the ID
 *   - `closed-prior-pr`   → list of closed PR numbers (non-merged)
 *   - `blocked`           → operator's reason text
 *   - `missing-id`        → empty (the absence IS the evidence)
 *   - `ready`             → empty
 */
export interface DispatchReadinessVerdict {
  /** Task ID, normalized to the canonical UPPER-CASE form (e.g. `AISDLC-451`). */
  taskId: string;
  /** Verdict — see {@link DispatchReadiness}. */
  readiness: DispatchReadiness;
  /** Short human-readable explanation suitable for trace lines + event payloads. */
  reason: string;
  /** Verdict-specific evidence (see field doc). Empty when verdict is `ready`. */
  evidence: DispatchReadinessEvidence;
}

export interface DispatchReadinessEvidence {
  /** Populated when verdict is `stale-shipped`. Commit SHAs (short form). */
  staleShippedCommits?: string[];
  /** Populated when verdict is `closed-prior-pr`. PR numbers (without `#`). */
  closedPrNumbers?: number[];
  /** Populated when verdict is `blocked`. The operator's reason text. */
  blockedReason?: string;
}

/**
 * Configuration for {@link checkDispatchReadiness}. All command runners
 * are injected to keep the module hermetic for unit testing.
 */
export interface CheckDispatchReadinessOpts {
  /** Project root — used to resolve `backlog/tasks/` + `backlog/completed/`. */
  workDir: string;
  /**
   * Optional override of the git-log runner. Receives the task ID (e.g.
   * `AISDLC-451`) and returns the raw `git log --grep=...` output. Default
   * production runner spawns `git log --grep="(AISDLC-N)" --since="<cutoff>"
   * --oneline origin/main`. Tests inject a stub returning fixed strings.
   *
   * Returning an empty string OR throwing is treated as "no matches" — the
   * checker is degrade-open by design.
   */
  gitLogCmd?: (taskId: string) => string;
  /**
   * Optional override of the `gh pr list` runner. Receives the task ID and
   * returns the raw JSON output (an array of `{number, state, mergedAt}`
   * objects). Default production runner spawns
   * `gh pr list --search "<id> in:title" --state closed --json number,state,mergedAt --limit 10`.
   * Tests inject a stub returning fixed JSON.
   *
   * Returning `null`, an empty string, an error, or any malformed JSON is
   * treated as "no closed PRs" — the checker is degrade-open by design.
   */
  ghPrListCmd?: (taskId: string) => string | null;
  /**
   * How far back to scan `git log` for stale-shipped commits. Defaults to
   * `'90 days ago'` — covers the slowest dogfood iteration cadence
   * without re-scanning the entire repo history on every tick. Operators
   * can crank the lookback if they suspect a very old task is stale.
   */
  staleShippedLookback?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the dispatch-readiness verdict for a single task ID.
 *
 * Runs the four checks in precedence order. Returns the first matching
 * verdict; falls through to `ready` when all four checks are negative.
 *
 * Designed to be called per-tick per-task by the orchestrator's Step 5
 * admission filter. The two external calls (`git log`, `gh pr list`) are
 * the dominant cost — both are ~100-300ms in practice and cached by
 * higher-level callers (the cli-deps frontier renderer batches the
 * `gh pr list` calls when annotating N entries).
 */
export function checkDispatchReadiness(
  taskId: string,
  opts: CheckDispatchReadinessOpts,
): DispatchReadinessVerdict {
  const canonicalId = canonicaliseTaskId(taskId);

  // 1. missing-id — no backlog file at all. We check both tasks/ and
  //    completed/ because a task in completed/ is "shipped, file moved";
  //    a task in NEITHER is a fictitious ID that the session referenced
  //    without ever filing.
  const taskFilePath = findTaskFile(canonicalId, opts.workDir);
  if (!taskFilePath) {
    return {
      taskId: canonicalId,
      readiness: 'missing-id',
      reason: `no backlog file found under backlog/tasks/ or backlog/completed/ for ${canonicalId}`,
      evidence: {},
    };
  }

  // 2. blocked — operator explicitly held this task. Reuse the upstream-OQ
  //    gate's parser so the two surfaces stay in lock-step on what
  //    "blocked" means.
  const blockedReason = extractBlockedReasonFromFile(taskFilePath);
  if (blockedReason) {
    return {
      taskId: canonicalId,
      readiness: 'blocked',
      reason: `task carries blocked.reason: ${blockedReason}`,
      evidence: { blockedReason },
    };
  }

  // 3. stale-shipped — search `git log` for a merged commit subject that
  //    references the task ID. Only fires when the task file is in
  //    backlog/tasks/ (still open), so a task already in completed/ never
  //    triggers this branch (it's already correctly closed).
  const taskInOpenDir = taskFilePath.includes(`${join('backlog', 'tasks')}`);
  if (taskInOpenDir) {
    const staleShippedCommits = findShippedCommits(canonicalId, opts);
    if (staleShippedCommits.length > 0) {
      return {
        taskId: canonicalId,
        readiness: 'stale-shipped',
        reason:
          `task file is in backlog/tasks/ but ${staleShippedCommits.length} merged commit(s) ` +
          `on origin/main reference ${canonicalId}: ${staleShippedCommits.slice(0, 3).join(', ')}`,
        evidence: { staleShippedCommits },
      };
    }
  }

  // 4. closed-prior-pr — `gh pr list --search "AISDLC-N in:title" --state closed`
  //    returns ANY PR whose `mergedAt` is null (closed without merge).
  //    Distinct from stale-shipped (which catches MERGED commits) — a
  //    closed-without-merge PR signals a prior attempt that hit a blocker,
  //    not just a renamed branch.
  const closedPrNumbers = findClosedPriorPRs(canonicalId, opts);
  if (closedPrNumbers.length > 0) {
    return {
      taskId: canonicalId,
      readiness: 'closed-prior-pr',
      reason:
        `${closedPrNumbers.length} prior PR(s) for ${canonicalId} closed without merging: ` +
        `#${closedPrNumbers.slice(0, 3).join(', #')}`,
      evidence: { closedPrNumbers },
    };
  }

  // 5. ready — nothing flagged.
  return {
    taskId: canonicalId,
    readiness: 'ready',
    reason: 'no triage signal detected — safe to dispatch',
    evidence: {},
  };
}

/**
 * Batch helper — runs {@link checkDispatchReadiness} over an iterable of
 * task IDs. Returns a Map keyed by canonical (UPPER-CASE) task ID so
 * downstream consumers (the cli-deps frontier renderer + Step 5
 * admission filter) can look up verdicts without re-canonicalising.
 *
 * The default `ghPrListCmd` is identical across all calls, so callers may
 * pass a memoised cmd (Map-backed) to avoid re-spawning gh for the same
 * task ID across consecutive ticks. The module does not memoise
 * internally — call-site control over caching is more flexible than a
 * baked-in policy.
 */
export function checkDispatchReadinessBatch(
  taskIds: readonly string[],
  opts: CheckDispatchReadinessOpts,
): Map<string, DispatchReadinessVerdict> {
  const out = new Map<string, DispatchReadinessVerdict>();
  for (const id of taskIds) {
    const v = checkDispatchReadiness(id, opts);
    out.set(v.taskId, v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers (exported for hermetic unit tests)
// ---------------------------------------------------------------------------

/**
 * Locate the task file on disk in either `backlog/tasks/` (open) or
 * `backlog/completed/`. Returns the absolute path or `null` when absent.
 *
 * Matches files whose filename STARTS WITH the lowercased task ID (e.g.
 * `aisdlc-451 - Frontier-triage-rubric.md`) — same convention the rest
 * of the pipeline uses (see `pipeline-cli/src/steps/01-validate.ts`).
 */
export function findTaskFile(taskId: string, workDir: string): string | null {
  const idLower = taskId.toLowerCase();
  for (const dir of ['backlog/tasks', 'backlog/completed']) {
    const candidate = join(workDir, dir);
    if (!existsSync(candidate)) continue;
    let entries: string[];
    try {
      entries = readdirSync(candidate);
    } catch {
      continue;
    }
    const hit = entries.find((f) => f.toLowerCase().startsWith(`${idLower} `) && f.endsWith('.md'));
    if (hit) return join(candidate, hit);
  }
  return null;
}

/**
 * Read the task file and parse the `blocked.reason` field via the
 * upstream-OQ gate's shared parser. Returns `null` when the file is
 * unreadable or the field is absent.
 */
export function extractBlockedReasonFromFile(taskFilePath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(taskFilePath, 'utf8');
  } catch {
    return null;
  }
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  return extractBlockedReason(fmMatch[1] ?? '');
}

/**
 * Run `git log` to find merged commits whose subject carries
 * `(AISDLC-N)`. Returns an array of short SHAs (first 8 chars).
 *
 * Degrade-open: any error returns `[]`. The downstream check then falls
 * through to the `ready` verdict — we'd rather under-trigger than emit
 * a false `stale-shipped` and abort the operator's dispatch.
 */
export function findShippedCommits(taskId: string, opts: CheckDispatchReadinessOpts): string[] {
  const cmd = opts.gitLogCmd ?? defaultGitLogCmd(opts);
  let raw: string;
  try {
    raw = cmd(taskId);
  } catch {
    return [];
  }
  if (!raw) return [];
  const shas: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // `git log --oneline` format: `<short-sha> <subject>`. Take the first
    // token as the SHA; reject lines that don't start with a hex SHA so
    // we don't index into wrapper output (warnings, mocked status lines).
    const shaMatch = trimmed.match(/^([0-9a-f]{7,40})\b/i);
    if (shaMatch) shas.push(shaMatch[1]);
  }
  return shas;
}

/**
 * Run `gh pr list --state closed --search "<id> in:title"` and parse the
 * JSON response. Returns the numbers of PRs whose `mergedAt` is `null`
 * (closed without merging).
 *
 * Degrade-open: any error / malformed JSON returns `[]`.
 *
 * IMPORTANT: this is `in:title` matching, NOT `in:body`. The `(AISDLC-N)`
 * suffix in PR titles is a hard convention from `/ai-sdlc execute`; body
 * mentions are unreliable (every PR description mentions adjacent task
 * IDs in context).
 */
export function findClosedPriorPRs(taskId: string, opts: CheckDispatchReadinessOpts): number[] {
  const cmd = opts.ghPrListCmd ?? defaultGhPrListCmd();
  let raw: string | null;
  try {
    raw = cmd(taskId);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const closed: number[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const number = typeof e.number === 'number' ? e.number : NaN;
    if (!Number.isFinite(number)) continue;
    // A PR is "closed without merging" when state is CLOSED and mergedAt is null.
    // gh returns mergedAt as ISO string when merged, null otherwise.
    const mergedAt = e.mergedAt;
    if (mergedAt === null || mergedAt === undefined) {
      closed.push(number);
    }
  }
  return closed;
}

/** Normalise a task ID to the canonical `PREFIX-NNN` (UPPER-CASE) form. */
export function canonicaliseTaskId(taskId: string): string {
  // Match a `LETTERS-DIGITS` (or with sub-id `.DIGITS`) tail anywhere in the input.
  const match = taskId.match(/([A-Za-z]+)-(\d+(?:\.\d+)?)/);
  if (!match) return taskId.toUpperCase();
  return `${match[1].toUpperCase()}-${match[2]}`;
}

// ---------------------------------------------------------------------------
// Default command runners (production)
// ---------------------------------------------------------------------------

function defaultGitLogCmd(opts: CheckDispatchReadinessOpts): (taskId: string) => string {
  const since = opts.staleShippedLookback ?? '90 days ago';
  return (taskId) => {
    // We search on origin/main so a stale local branch doesn't false-positive
    // (the operator might have a wip commit referencing the task on a branch
    // that never landed).
    //
    // Subject-line-only strategy (round 2): the previous version matched
    // any commit whose `subject OR body` contained `(AISDLC-N)`. That false-
    // positived on docs / OQ-walkthrough / cross-reference commits whose
    // bodies legitimately mention adjacent task IDs in prose. We now:
    //
    //   1. Use `git log --format=%H %s` (SHA + subject only) without
    //      `--grep` — so the subject filtering happens in our own code
    //      against the literal substring `(AISDLC-N)`.
    //   2. Bound the scan window with `--since` to keep wall-clock low
    //      even on long histories.
    //   3. Return only the matching lines (in the same `<sha> <subject>`
    //      shape `findShippedCommits` already parses).
    //
    // This eliminates the false-positive class without giving up the
    // conventional-commit ship-detector — feature PRs land as
    // `feat(scope): subject (AISDLC-N)` and clear the subject filter
    // unambiguously.
    const needle = `(${taskId})`;
    try {
      const raw = execFileSync(
        'git',
        ['-C', opts.workDir, 'log', '--format=%h %s', '--since', since, 'origin/main'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      // Filter to subject-line matches only. The commit body is excluded
      // by `--format=%h %s` (no `%b`), so this is a pure substring scan.
      const matched: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.includes(needle)) matched.push(line);
      }
      return matched.join('\n');
    } catch {
      return '';
    }
  };
}

function defaultGhPrListCmd(): (taskId: string) => string | null {
  return (taskId) => {
    try {
      return execFileSync(
        'gh',
        [
          'pr',
          'list',
          '--search',
          `${taskId} in:title`,
          '--state',
          'closed',
          '--json',
          'number,state,mergedAt',
          '--limit',
          '10',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      return null;
    }
  };
}
