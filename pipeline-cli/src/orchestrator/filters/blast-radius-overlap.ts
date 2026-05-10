/**
 * Filter — Blast-radius overlap detection (AISDLC-231).
 *
 * Prevents the orchestrator from dispatching a task whose file-level
 * blast-radius overlaps with the blast-radius of a task that is already
 * in-flight. Without this filter, N tasks that all touch the same shared
 * file (e.g. `shared/types.ts`, an enum companion map, a registry) can all
 * admit in parallel when `cli-orchestrator tick --max-concurrent N` runs.
 * Each agent's worktree is rebased onto `origin/main` at agent-launch time;
 * as earlier agents land, later agents are working against an increasingly
 * stale main. When a stale agent's commit lands it re-derives work that's
 * already on origin — massive merge conflicts follow.
 *
 * ## Blast-radius file set
 *
 * A task's "file blast-radius" is the set of source files it is expected to
 * touch, derived from the task frontmatter's `references:` array. Entries
 * that refer to directories (trailing `/`) are retained as-is for prefix
 * comparison; file entries are normalised to their canonical path. When
 * `references:` is absent or empty the filter admits the candidate
 * unconditionally (degrade-open: assume no overlap if we can't determine
 * the file set).
 *
 * v1 derives the set from frontmatter references rather than the RFC-0014
 * corpus-backed calibration because the corpus-calibrated phase is not yet
 * shipped. A later task (AISDLC-232's Phase 5 companion) will wire the
 * corpus output as a richer source; the filter interface is designed to
 * accept injected compute functions so the upgrade is a one-line swap.
 *
 * ## In-flight task set
 *
 * The set of in-flight tasks is detected via the same two signals as
 * AISDLC-227's AlreadyInFlight filter:
 *
 * (a) **Open PRs** — `gh pr list --head ai-sdlc/<task-id-lower>-* --state open`
 *     returns ≥1 entry. Task IDs are extracted from matching branch names.
 *
 * (b) **Active-worktree sentinels** — `.worktrees/<dir>/.active-task` files
 *     on disk. Each file contains the canonical task ID for the session
 *     owning that worktree.
 *
 * Both signals are best-effort: `gh` errors and filesystem errors are
 * silently swallowed so transient infra failures never block dispatch.
 *
 * ## Ordering in the chain
 *
 * Runs AFTER `AlreadyInFlight` and BEFORE `DependencyReadiness`.
 *
 * Rationale: `AlreadyInFlight` catches the case where the SAME task is
 * already dispatched; there's no point computing blast-radius overlap when
 * the candidate would be rejected for that reason anyway. `DependencyReadiness`
 * runs after blast-radius because dependency failures are more informative
 * than blast-radius deferral — if a task is both dep-blocked AND overlapping,
 * we want the dep-blocked event so the operator sees the root cause.
 *
 * Chain order: OrphanParent → AlreadyInFlight → BlastRadiusOverlap →
 *   DependencyReadiness → Dispatchability → DorReadiness →
 *   ExternalDependencies → Blocked.
 *
 * ## Operator overrides
 *
 * `AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS=1` — skip the filter entirely for
 *   all tasks in this tick (global escape hatch).
 *
 * `AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK=<task-id>` — skip the filter
 *   only for the named task (per-task escape). Useful when the operator
 *   KNOWS two tasks touch the same file in non-conflicting sections and
 *   does not want to over-serialize.
 *
 * Both bypass mechanisms log a single warning per suppressed candidate so
 * operators can grep stdout for accidental bypass leakage.
 *
 * @module orchestrator/filters/blast-radius-overlap
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FilterResult } from './types.js';

// ── Public types ──────────────────────────────────────────────────────────────

/** Structured detail carried in the `OrchestratorBlockedByBlastRadiusOverlap` event. */
export interface BlastRadiusOverlapDetail {
  kind: 'blast-radius-overlap';
  /** The in-flight task whose blast-radius overlaps with the candidate. */
  inFlightTaskId: string;
  /**
   * Up to 3 overlapping file paths (truncated when the intersection is
   * large). Carries the same `…` suffix pattern used by the DoR
   * blast-radius callout renderer for consistency.
   */
  overlap: string[];
  /**
   * Total number of overlapping files. May exceed `overlap.length` when
   * the intersection was truncated to 3 entries.
   */
  overlapCount: number;
}

export interface CheckBlastRadiusOverlapOpts {
  /** Candidate task ID. */
  taskId: string;
  /**
   * Absolute path to the repo root. Used to:
   *   - resolve the `.worktrees/` path for sentinel scan (in-flight signal b).
   *   - find the task file for the candidate's `references:` frontmatter.
   *   - find the task file for each in-flight task's `references:` frontmatter.
   * Defaults to `process.cwd()` when unset.
   */
  repoRoot?: string;
  /**
   * Absolute path to the backlog directory. Defaults to `<repoRoot>/backlog`.
   * Overridden by tests that materialise fixture task files in a tmpdir.
   */
  backlogDir?: string;
  /**
   * Injectable `gh pr list` runner — replaces the real `gh` call for
   * listing open PRs. Receives the glob pattern; returns an array of
   * `{number, headRefName}` objects. Tests inject a stub; production
   * leaves this undefined and the filter invokes `gh pr list` directly.
   */
  listOpenPRs?: (headPattern: string) => { number: number; headRefName: string }[];
  /**
   * Injectable blast-radius file-set computer. Given a task ID and the
   * repoRoot, returns the set of file paths (or directory prefix paths
   * ending in `/`) that the task is expected to touch.
   *
   * When undefined the filter uses the default implementation:
   * reads the task file from `<backlogDir>/**` and extracts `references:`.
   */
  computeBlastRadiusFiles?: (taskId: string, repoRoot: string) => string[];
}

// ── Env-override helpers ──────────────────────────────────────────────────────

/**
 * `AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS=1` (or truthy) — skip the filter
 * entirely for all candidates in this tick.
 */
export function isGlobalBypassEnabled(): boolean {
  const raw = process.env.AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * `AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK=<task-id>` — skip the filter
 * for the named task only. Comparison is case-insensitive.
 */
export function isPerTaskBypassEnabled(taskId: string): boolean {
  const raw = process.env.AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK;
  if (!raw) return false;
  return raw.trim().toLowerCase() === taskId.toLowerCase();
}

// ── Filter ────────────────────────────────────────────────────────────────────

/**
 * Check whether the candidate task's blast-radius (file set) overlaps with
 * any in-flight task's blast-radius.
 *
 * Returns `{ filter: 'BlastRadiusOverlap', passed: false, reason, detail }`
 * on the first in-flight overlap found; returns `{ ..., passed: true }` when
 * no overlap is detected (or the candidate has an empty blast-radius, or a
 * bypass env var is set).
 *
 * Synchronous — all I/O is synchronous (execSync for gh, existsSync/readdirSync
 * for sentinels, readFileSync for task files). The filter chain is called
 * inside a synchronous loop in the tick; keeping it sync avoids wrapping the
 * whole chain in async.
 */
export function checkBlastRadiusOverlap(opts: CheckBlastRadiusOverlapOpts): FilterResult {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const backlogDir = opts.backlogDir ?? join(repoRoot, 'backlog');
  const computeFn = opts.computeBlastRadiusFiles ?? defaultComputeBlastRadiusFiles;

  // Global env bypass — skip the filter for ALL tasks.
  if (isGlobalBypassEnabled()) {
    return {
      filter: 'BlastRadiusOverlap',
      passed: true,
      reason: 'AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS is set — skipped',
    };
  }

  // Per-task env bypass — skip for this specific task.
  if (isPerTaskBypassEnabled(opts.taskId)) {
    return {
      filter: 'BlastRadiusOverlap',
      passed: true,
      reason: `AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK=${opts.taskId} — skipped`,
    };
  }

  // Compute candidate's blast-radius file set.
  let candidateFiles: string[];
  try {
    candidateFiles = computeFn(opts.taskId, backlogDir);
  } catch {
    // Can't compute — degrade open (admit the candidate).
    return { filter: 'BlastRadiusOverlap', passed: true };
  }

  // Degrade open: if the candidate has no declared files, admit it.
  if (candidateFiles.length === 0) {
    return {
      filter: 'BlastRadiusOverlap',
      passed: true,
      reason: 'no blast-radius files declared — admitted (degrade-open)',
    };
  }

  // Collect in-flight task IDs from both signals.
  const inFlightIds = collectInFlightTaskIds(repoRoot, opts.listOpenPRs);

  // For each in-flight task, check for blast-radius overlap.
  for (const inFlightId of inFlightIds) {
    // Skip self (shouldn't appear here, but defensive).
    if (inFlightId.toLowerCase() === opts.taskId.toLowerCase()) continue;

    let inFlightFiles: string[];
    try {
      inFlightFiles = computeFn(inFlightId, backlogDir);
    } catch {
      // Can't compute for in-flight task — skip this comparison
      // (conservative: don't block on unknown blast-radius).
      continue;
    }

    if (inFlightFiles.length === 0) continue;

    const overlap = intersectFileSets(candidateFiles, inFlightFiles);
    if (overlap.length > 0) {
      const displayOverlap = overlap.slice(0, 3);
      const detail: BlastRadiusOverlapDetail = {
        kind: 'blast-radius-overlap',
        inFlightTaskId: inFlightId,
        overlap: displayOverlap,
        overlapCount: overlap.length,
      };
      const overlapStr =
        displayOverlap.join(', ') + (overlap.length > 3 ? `… (+${overlap.length - 3} more)` : '');
      return {
        filter: 'BlastRadiusOverlap',
        passed: false,
        reason: `blast-radius overlap with in-flight ${inFlightId}: ${overlapStr}`,
        detail,
      };
    }
  }

  return { filter: 'BlastRadiusOverlap', passed: true };
}

// ── In-flight detection ───────────────────────────────────────────────────────

/**
 * Collect the set of in-flight task IDs from both detection signals:
 *
 * (a) Open PRs with `ai-sdlc/<task-id-lower>-*` head ref pattern.
 * (b) Active-worktree `.active-task` sentinels under `<repoRoot>/.worktrees/`.
 *
 * Both signals are best-effort; errors are silently swallowed.
 */
function collectInFlightTaskIds(
  repoRoot: string,
  listOpenPRs?: (headPattern: string) => { number: number; headRefName: string }[],
): string[] {
  const ids = new Set<string>();

  // Signal (a): open PRs with ai-sdlc/* branch pattern.
  try {
    const prs = listOpenPRs ? listOpenPRs('ai-sdlc/*') : runGhPRListAll();
    for (const pr of prs) {
      const taskId = extractTaskIdFromBranch(pr.headRefName);
      if (taskId) ids.add(taskId.toUpperCase());
    }
  } catch {
    // gh not available or network error — skip signal (a).
  }

  // Signal (b): active-worktree sentinels.
  try {
    const worktreesRoot = join(repoRoot, '.worktrees');
    if (existsSync(worktreesRoot)) {
      let dirs: string[];
      try {
        dirs = readdirSync(worktreesRoot);
      } catch {
        dirs = [];
      }
      for (const dir of dirs) {
        const sentinelPath = join(worktreesRoot, dir, '.active-task');
        if (!existsSync(sentinelPath)) continue;
        try {
          const content = readFileSync(sentinelPath, 'utf8').trim();
          if (content) ids.add(content.toUpperCase());
        } catch {
          // Sentinel vanished between existsSync + readFileSync — skip.
        }
      }
    }
  } catch {
    // Filesystem error — skip signal (b).
  }

  return [...ids];
}

/**
 * Run `gh pr list --head ai-sdlc/* --state open --json number,headRefName`
 * and return the matching entries. Throws on non-zero exit.
 */
function runGhPRListAll(): { number: number; headRefName: string }[] {
  const stdout = execSync(`gh pr list --head "ai-sdlc/*" --state open --json number,headRefName`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  if (!stdout || stdout === '[]') return [];
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (e): e is { number: number; headRefName: string } =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as { number?: unknown }).number === 'number' &&
      typeof (e as { headRefName?: unknown }).headRefName === 'string',
  );
}

/**
 * Extract a task ID from an `ai-sdlc/<task-id-lower>-<desc>` branch name.
 * Returns null when the branch doesn't match the expected pattern.
 *
 * Pattern: `ai-sdlc/aisdlc-NNN-<anything>` → `AISDLC-NNN`
 * Also handles: `ai-sdlc/aisdlc-NNN.M-<anything>` → `AISDLC-NNN.M`
 */
function extractTaskIdFromBranch(branch: string): string | null {
  // Match ai-sdlc/<taskIdLower>-... where taskId is aisdlc-NNN or aisdlc-NNN.M
  const m = branch.match(/^ai-sdlc\/(aisdlc-\d+(?:\.\d+)*)/i);
  if (!m) return null;
  // Normalize to uppercase canonical form: aisdlc-231 → AISDLC-231
  return m[1].toUpperCase().replace(/^AISDLC-/, 'AISDLC-');
}

// ── Blast-radius file-set computation ────────────────────────────────────────

/**
 * Default blast-radius file-set computation.
 *
 * Reads the task file from `<backlogDir>/**` (searching both `tasks/` and
 * `completed/` subdirs) and extracts the `references:` YAML list. Each
 * entry in `references:` represents a file or directory path the task is
 * expected to touch. Directory entries (ending in `/`) are retained as-is
 * for prefix-based overlap comparison.
 *
 * Returns an empty array when:
 * - The task file cannot be found.
 * - The frontmatter cannot be parsed.
 * - `references:` is absent or empty.
 *
 * This is intentionally simple (degrade-open on parse errors) because the
 * filter must NEVER block dispatch on infra errors.
 */
export function defaultComputeBlastRadiusFiles(taskId: string, backlogDir: string): string[] {
  const taskIdLower = taskId.toLowerCase();
  // Search both tasks/ and completed/ for the task file.
  const searchDirs = [join(backlogDir, 'tasks'), join(backlogDir, 'completed')];
  let raw: string | null = null;
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Match files that contain the task ID (case-insensitive).
      // File names follow the pattern: `<id> - <title>.md` (ASCII).
      if (
        entry.toLowerCase().startsWith(taskIdLower + ' ') ||
        entry.toLowerCase().startsWith(taskIdLower + '-') ||
        entry.toLowerCase() === taskIdLower + '.md'
      ) {
        const filePath = join(dir, entry);
        try {
          raw = readFileSync(filePath, 'utf8');
          break;
        } catch {
          // File vanished between readdir + readFile — continue.
        }
      }
    }
    if (raw !== null) break;
  }

  if (raw === null) return [];

  // Extract frontmatter YAML block.
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const frontmatter = fmMatch[1];

  // Parse `references:` list — simplified YAML list parser for the
  // one specific field we need. Handles both compact and block list forms:
  //   references: [a, b]
  //   references:
  //     - a
  //     - b
  return parseReferencesFromFrontmatter(frontmatter);
}

/**
 * Extract the `references:` list from a YAML frontmatter string.
 * Returns an empty array when the field is absent or empty.
 */
function parseReferencesFromFrontmatter(frontmatter: string): string[] {
  const lines = frontmatter.split('\n');
  const refs: string[] = [];
  let inRefs = false;

  for (const line of lines) {
    if (/^references:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    // Compact form: references: [a, b, c]
    const compactMatch = line.match(/^references:\s*\[(.+)\]/);
    if (compactMatch) {
      const items = compactMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
      refs.push(...items.filter(Boolean));
      break;
    }
    if (inRefs) {
      if (/^[a-z_]/.test(line)) break; // new top-level key
      const listItemMatch = line.match(/^\s+-\s+(.+)$/);
      if (listItemMatch) {
        const ref = listItemMatch[1].trim().replace(/^['"]|['"]$/g, '');
        if (ref) refs.push(ref);
      }
    }
  }

  return refs;
}

// ── File-set intersection ─────────────────────────────────────────────────────

/**
 * Compute the intersection of two file-path sets.
 *
 * Exact string match for file entries. For directory entries (ending in `/`),
 * checks whether the other set contains any path that starts with the
 * directory prefix.
 *
 * Returns the matching paths from the `a` set (candidate's perspective).
 */
export function intersectFileSets(a: string[], b: string[]): string[] {
  const overlap: string[] = [];
  const bSet = new Set(b);
  for (const aPath of a) {
    if (aPath.endsWith('/')) {
      // Directory prefix: check if any entry in b starts with this prefix.
      const hasMatch = b.some((bPath) => bPath.startsWith(aPath) || bPath === aPath.slice(0, -1));
      if (hasMatch) overlap.push(aPath);
    } else if (bSet.has(aPath)) {
      overlap.push(aPath);
    } else {
      // Check if any b entry is a directory prefix that covers aPath.
      const coveredByDir = b.some((bPath) => bPath.endsWith('/') && aPath.startsWith(bPath));
      if (coveredByDir) overlap.push(aPath);
    }
  }
  return overlap;
}
