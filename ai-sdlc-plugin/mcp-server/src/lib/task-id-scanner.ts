/**
 * Worktree-aware backlog task ID allocator — scanner (AISDLC-559).
 *
 * Duplicate backlog IDs keep getting created across sibling worktrees:
 * `task_create`'s only collision check (`findExistingTaskFile`, in
 * `../tools/task-create.ts`) looks at ONE project dir's `backlog/tasks` +
 * `backlog/completed`. It cannot see sibling worktrees or unmerged branches.
 *
 * This module unions THREE sources of "claimed" IDs:
 *
 * 1. **All git refs** — `git log --all --diff-filter=A --name-only
 *    --pretty=format: -- 'backlog/tasks/*' 'backlog/completed/*'`. One
 *    process, ~0.4s measured on this repo (vs. 11s for per-ref `git
 *    ls-tree` across 707 refs, 17s for tree-dedup). Covers local branches,
 *    remote-tracking branches (= open PRs pushed from any machine), and
 *    tags. Because we filter on `--diff-filter=A` (added) rather than the
 *    current tree state, an ID that was added and later renamed/deleted on
 *    some branch is STILL reported as claimed — it must never be reused.
 * 2. **Sibling worktree filesystems** — `<parent>/.worktrees/<id>/backlog/
 *    {tasks,completed}`, read directly off disk. This is the ONLY source
 *    that sees *uncommitted* task files, which is what makes
 *    claim-by-creation (see `task-id-lock.ts`) actually close the race.
 * 3. **The current working tree's** `backlog/tasks` + `backlog/completed`.
 *
 * IDs are parsed with `<prefix>-(\d+)` case-insensitively. Hierarchical
 * sub-IDs (e.g. `aisdlc-100.5`) collapse to their major number (100) — a
 * sub-ID must never mask a major ID's claim.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export type TaskIdSourceName = 'git-refs' | 'sibling-worktrees' | 'current-worktree';

/** One place an ID was found claimed, with enough detail to explain itself. */
export interface ClaimSource {
  source: TaskIdSourceName;
  /** Ref/path/worktree detail — e.g. a file path, or a git log line. */
  detail: string;
}

/** Per-source scan outcome, so callers can tell "scanned 0 found" from "not scanned". */
export interface SourceReport {
  source: TaskIdSourceName;
  scanned: boolean;
  /** Count of distinct major IDs this source contributed. */
  idsFound: number;
  /** Present when `scanned` is false, or to add non-fatal context. */
  detail?: string;
}

export interface FreshnessInfo {
  /** Absolute path to the FETCH_HEAD file consulted, if any. */
  fetchHeadPath?: string;
  /** Milliseconds since the last `git fetch`, if determinable. */
  ageMs?: number;
  /** True when age is unknown OR exceeds the staleness threshold. A skipped
   * freshness check must never look like a passed one — default to stale. */
  stale: boolean;
  /** True when this scan call itself performed a fetch (opt-in only). */
  fetched: boolean;
}

export interface TaskIdScanResult {
  /** Major ID number -> every place it was found claimed. Drives ALLOCATION. */
  claimed: Map<number, ClaimSource[]>;
  /**
   * Normalised exact id (`aisdlc-100.5`) -> every place it was found claimed.
   * Drives COLLISION REFUSAL — see the note in `scanClaimedTaskIds`.
   */
  claimedExact: Map<string, ClaimSource[]>;
  sourceReports: SourceReport[];
  freshness: FreshnessInfo;
}

export interface ScanTaskIdsOptions {
  /** Current worktree root (contains `backlog/`). */
  projectDir: string;
  /** Task ID prefix, e.g. "AISDLC". Defaults to "AISDLC". */
  prefix?: string;
  /** cwd to run git commands from. Defaults to `projectDir`. */
  gitCwd?: string;
  /** Freshness threshold in ms. Defaults to 15 minutes. */
  staleFetchThresholdMs?: number;
  /** Opt-in: run `git fetch origin` before scanning. Never implied. */
  fetch?: boolean;
}

export const DEFAULT_TASK_ID_PREFIX = 'AISDLC';
export const DEFAULT_STALE_FETCH_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Resolve the parent repo root of a Pattern C worktree (`<parent>/.worktrees/<id>/`).
 * Returns `undefined` when `projectDir` is not itself a `.worktrees/<id>` child
 * (plain, non-Pattern-C project) — callers should fall back to `projectDir`.
 */
export function resolveParentRepoRoot(projectDir: string): string | undefined {
  const abs = resolve(projectDir);
  const parentDir = dirname(abs);
  if (basename(parentDir) !== '.worktrees') return undefined;
  return dirname(parentDir);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildIdRegex(prefix: string): RegExp {
  return new RegExp(`${escapeRegExp(prefix)}-(\\d+)`, 'i');
}

/** Matches the FULL id including any hierarchical sub-parts (100, 100.5, 100.5.2). */
function buildExactIdRegex(prefix: string): RegExp {
  return new RegExp(`${escapeRegExp(prefix)}-(\\d+(?:\\.\\d+)*)`, 'i');
}

/** Normalised exact id (e.g. `aisdlc-100.5`), or `undefined`. */
export function extractExactId(text: string, exactRegex: RegExp): string | undefined {
  const match = exactRegex.exec(text);
  return match ? match[0].toLowerCase() : undefined;
}

/** Extract the major ID number from a filename/path/log line, or `undefined`. */
export function extractMajorId(text: string, idRegex: RegExp): number | undefined {
  const match = idRegex.exec(text);
  if (!match) return undefined;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

function scanGitRefs(
  gitCwd: string,
  idRegex: RegExp,
  addClaim: (major: number, source: TaskIdSourceName, detail: string) => void,
): SourceReport {
  try {
    const out = execFileSync(
      'git',
      [
        'log',
        '--all',
        '--diff-filter=A',
        '--name-only',
        '--pretty=format:',
        '--',
        'backlog/tasks/*',
        'backlog/completed/*',
      ],
      // stdio[2] explicitly piped (not inherited): "not a git repository" and
      // similar expected failures (non-Pattern-C dirs, hermetic test fixtures
      // without a .git) are handled below via try/catch and must not leak to
      // the parent process' stderr — execFileSync's default otherwise
      // inherits stderr regardless of the overall 'pipe' default.
      {
        cwd: gitCwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // AISDLC-559 review: Node's default maxBuffer is 1 MiB. This repo's
        // output is already ~200 KB and the design targets full-history clones
        // with 700+ refs. On overflow execFileSync THROWS, the catch below sets
        // scanned:false, and git-refs — the only source covering unmerged and
        // remote branches — silently drops out. That is precisely the
        // duplicate-ID condition this module exists to prevent, so give it
        // headroom and a timeout rather than letting it degrade with scale.
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    const seen = new Set<number>();
    for (const rawLine of out.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const major = extractMajorId(line, idRegex);
      if (major === undefined) continue;
      addClaim(major, 'git-refs', line);
      seen.add(major);
    }
    return { source: 'git-refs', scanned: true, idsFound: seen.size };
  } catch (err) {
    const message = (err as Error).message ?? '';
    // Round-2 review: the two reviewers split on whether task_create should get
    // an `allowUnscannedSources` escape hatch. Neither is quite right — the
    // real question is WHY the scan failed.
    //
    // There is exactly ONE vacuous case: no repository exists anywhere up the
    // tree, so there are no refs for an id to hide on and the scan is complete
    // rather than degraded. Treating it as a failure would make task_create
    // unusable in a plain directory with no override.
    //
    // The parenthetical is load-bearing. Git emits BOTH:
    //   "not a git repository (or any of the parent directories): .git"  ← vacuous
    //   "not a git repository: /nonexistent/place"                       ← BROKEN gitdir
    // The second is a degraded repo whose refs we genuinely cannot see, so
    // matching on the bare phrase would fail open on exactly the dangerous case.
    // (A fresh repo with zero commits needs no special case — git log exits 0.)
    //
    // Every other failure — corrupt .git, ENOBUFS from an oversized log, a
    // timeout — keeps failing closed.
    if (/not a git repository \(or any of the parent directories\)/i.test(message)) {
      return {
        source: 'git-refs',
        scanned: true,
        idsFound: 0,
        detail: 'no refs exist yet (fresh or non-git directory) — nothing could be claimed',
      };
    }
    return { source: 'git-refs', scanned: false, idsFound: 0, detail: message };
  }
}

function scanBucketDir(
  bucketDir: string,
  idRegex: RegExp,
  source: TaskIdSourceName,
  addClaim: (major: number, source: TaskIdSourceName, detail: string) => void,
  seen: Set<number>,
): void {
  if (!existsSync(bucketDir)) return;
  for (const file of readdirSync(bucketDir)) {
    const major = extractMajorId(file, idRegex);
    if (major === undefined) continue;
    addClaim(major, source, join(bucketDir, file));
    seen.add(major);
  }
}

function scanSiblingWorktrees(
  projectDir: string,
  idRegex: RegExp,
  addClaim: (major: number, source: TaskIdSourceName, detail: string) => void,
): SourceReport {
  const parentRoot = resolveParentRepoRoot(projectDir);
  if (!parentRoot) {
    return {
      source: 'sibling-worktrees',
      scanned: false,
      idsFound: 0,
      detail: 'not a Pattern C worktree layout (no .worktrees/ parent found)',
    };
  }
  const worktreesDir = join(parentRoot, '.worktrees');
  const seen = new Set<number>();
  try {
    const entries = readdirSync(worktreesDir, { withFileTypes: true });
    const selfAbs = resolve(projectDir);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const worktreeRoot = join(worktreesDir, entry.name);
      if (resolve(worktreeRoot) === selfAbs) continue; // current worktree — source 3 handles it
      scanBucketDir(
        join(worktreeRoot, 'backlog', 'tasks'),
        idRegex,
        'sibling-worktrees',
        addClaim,
        seen,
      );
      scanBucketDir(
        join(worktreeRoot, 'backlog', 'completed'),
        idRegex,
        'sibling-worktrees',
        addClaim,
        seen,
      );
    }
    return { source: 'sibling-worktrees', scanned: true, idsFound: seen.size };
  } catch (err) {
    return {
      source: 'sibling-worktrees',
      scanned: false,
      idsFound: 0,
      detail: (err as Error).message,
    };
  }
}

function scanCurrentWorktree(
  projectDir: string,
  idRegex: RegExp,
  addClaim: (major: number, source: TaskIdSourceName, detail: string) => void,
): SourceReport {
  const seen = new Set<number>();
  try {
    scanBucketDir(
      join(projectDir, 'backlog', 'tasks'),
      idRegex,
      'current-worktree',
      addClaim,
      seen,
    );
    scanBucketDir(
      join(projectDir, 'backlog', 'completed'),
      idRegex,
      'current-worktree',
      addClaim,
      seen,
    );
    return { source: 'current-worktree', scanned: true, idsFound: seen.size };
  } catch (err) {
    return {
      source: 'current-worktree',
      scanned: false,
      idsFound: 0,
      detail: (err as Error).message,
    };
  }
}

function computeFreshness(
  gitCwd: string,
  staleThresholdMs: number,
  fetched: boolean,
): FreshnessInfo {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const commonDirAbs = resolve(gitCwd, commonDir);
    const fetchHeadPath = join(commonDirAbs, 'FETCH_HEAD');
    if (!existsSync(fetchHeadPath)) {
      return { stale: true, fetched, fetchHeadPath };
    }
    const mtimeMs = statSync(fetchHeadPath).mtimeMs;
    const ageMs = Date.now() - mtimeMs;
    return { fetchHeadPath, ageMs, stale: ageMs > staleThresholdMs, fetched };
  } catch {
    // A skipped/failed freshness check must never look like a passed one.
    return { stale: true, fetched };
  }
}

/**
 * Scan all 3 sources and return the unioned claimed-ID set with provenance,
 * per-source scan reports, and remote-tracking-ref freshness.
 */
export function scanClaimedTaskIds(opts: ScanTaskIdsOptions): TaskIdScanResult {
  const prefix = opts.prefix ?? DEFAULT_TASK_ID_PREFIX;
  const gitCwd = opts.gitCwd ?? opts.projectDir;
  const idRegex = buildIdRegex(prefix);

  const claimed = new Map<number, ClaimSource[]>();
  // AISDLC-559 review (CRITICAL): allocation and collision are DIFFERENT
  // questions. Allocating a new major must reserve on the major number, but
  // refusing a duplicate must compare the EXACT id — otherwise a legitimate
  // new sub-ID like AISDLC-100.6 is rejected merely because the epic
  // AISDLC-100 or a sibling AISDLC-100.5 exists, which breaks the
  // RFC-walkthrough phase-task pattern this repo uses routinely.
  const claimedExact = new Map<string, ClaimSource[]>();
  const exactIdRegex = buildExactIdRegex(prefix);
  const addClaim = (major: number, source: TaskIdSourceName, detail: string): void => {
    const arr = claimed.get(major) ?? [];
    arr.push({ source, detail });
    claimed.set(major, arr);

    // Extract from the BASENAME, never the full path. `detail` is often an
    // absolute path, and a containing directory can itself carry an id —
    // a worktree at `.worktrees/aisdlc-234/` or a tmpdir named
    // `aisdlc-234-fixture-XXXX` would otherwise claim 234 for every file
    // beneath it, and mask the file's own id.
    const exact = extractExactId(basename(detail), exactIdRegex);
    if (exact) {
      const exactArr = claimedExact.get(exact) ?? [];
      exactArr.push({ source, detail });
      claimedExact.set(exact, exactArr);
    }
  };

  let fetched = false;
  if (opts.fetch) {
    try {
      // Bounded: an unbounded fetch inside a caller's lock window is what let
      // the stale-takeover produce two simultaneous lock holders.
      execFileSync('git', ['fetch', 'origin'], {
        cwd: gitCwd,
        stdio: 'ignore',
        timeout: 60_000,
      });
      fetched = true;
    } catch {
      // Fetch failure is non-fatal — freshness will correctly report stale.
    }
  }

  const sourceReports: SourceReport[] = [
    scanGitRefs(gitCwd, idRegex, addClaim),
    scanSiblingWorktrees(opts.projectDir, idRegex, addClaim),
    scanCurrentWorktree(opts.projectDir, idRegex, addClaim),
  ];

  const freshness = computeFreshness(
    gitCwd,
    opts.staleFetchThresholdMs ?? DEFAULT_STALE_FETCH_THRESHOLD_MS,
    fetched,
  );

  return { claimed, claimedExact, sourceReports, freshness };
}

/**
 * Sources that MUST have scanned for an allocation/creation decision to be
 * trustworthy. `git-refs` is the only source covering unmerged and remote
 * branches, so proceeding without it is exactly the duplicate-ID condition
 * this module exists to prevent.
 */
export const REQUIRED_SCAN_SOURCES: readonly TaskIdSourceName[] = ['git-refs'];

/**
 * Refresh remote-tracking refs. Exposed separately so callers can fetch
 * BEFORE taking the allocation lock — a slow fetch inside the critical section
 * can outrun the stale threshold and let a second caller steal the lock.
 * Returns true when the fetch succeeded.
 */
export function prefetchOrigin(gitCwd: string): boolean {
  try {
    execFileSync('git', ['fetch', 'origin'], { cwd: gitCwd, stdio: 'ignore', timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

/** Required sources that failed to scan. Empty means safe to proceed. */
export function findUnscannedRequiredSources(reports: readonly SourceReport[]): SourceReport[] {
  return reports.filter((r) => REQUIRED_SCAN_SOURCES.includes(r.source) && !r.scanned);
}

/**
 * Given a claimed-ID set (major numbers), return the next `count` contiguous
 * free IDs immediately after the current maximum. This deliberately never
 * backfills gaps — a gap means an ID was claimed and later renamed/deleted,
 * and per the git-refs source semantics it must never be reused.
 */
export function computeNextFreeBlock(
  claimed: ReadonlySet<number> | ReadonlyMap<number, unknown>,
  count: number,
): number[] {
  const claimedSet = claimed instanceof Map ? new Set(claimed.keys()) : claimed;
  const max = claimedSet.size > 0 ? Math.max(...claimedSet) : 0;
  const result: number[] = [];
  for (let i = 1; i <= count; i++) {
    result.push(max + i);
  }
  return result;
}
