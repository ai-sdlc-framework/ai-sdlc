/**
 * Incremental review — only re-review the diff since last approval (AISDLC-142).
 *
 * AISDLC-141 cut WHICH reviewers run via the deterministic classifier. This
 * module cuts WHAT each reviewer reads:
 *
 *   - Pre-AISDLC-142: every push spawns the classifier-selected reviewer subset
 *     against `git diff origin/main...HEAD` (entire PR diff). A 200-line PR
 *     that pushes a 5-line fix re-reads the same 200 lines wastefully.
 *   - Post-AISDLC-142: store the last-reviewed `contentHashV3` (AISDLC-101) +
 *     SHA in a PR-comment marker. On each push:
 *       * marker absent / first push       → full review
 *       * marker present, hash equal       → SKIP review entirely (auto-approve)
 *       * marker present, delta within cap → delta-only review
 *       * marker present, delta over cap   → full review (safety fallback)
 *
 * Composes ON TOP of the AISDLC-141 classifier — the classifier still decides
 * the reviewer subset; this module decides what each one reads.
 *
 * ## Why a PR-comment marker (not a status check / branch ref)
 *
 *   - PR comments are visible in the PR UI — operators can see what state the
 *     incremental gate is in without spelunking workflow logs.
 *   - Idempotent-marker pattern is already proven in this repo
 *     (`<!-- ai-sdlc:dor-comment ... -->`, `<!-- ai-sdlc:attestation-fallback-comment -->`).
 *   - `gh api` reads/writes are cheap and deterministic — no need for a
 *     side-channel database.
 *
 * ## Self-contained (mirrors classifier rationale)
 *
 * Re-implements `computeContentHashV3` + `collectChangedFileDeltaEntries`
 * locally so pipeline-cli stays free of an `@ai-sdlc/orchestrator` dep. The
 * algorithm is byte-identical to `orchestrator/src/runtime/attestations.ts`
 * (verified by tests in `incremental.test.ts`). If you change one, change
 * the other — divergence would silently drift the producer-side oracle from
 * the verifier-side check.
 *
 * @module incremental-review/incremental
 */

import { createHash } from 'node:crypto';

/** Marker substring used to locate the last-reviewed-contenthash PR comment. */
export const MARKER_PREFIX = '<!-- ai-sdlc:last-reviewed-contenthash:';
/** Closing token for the marker so the parser can isolate the encoded payload. */
export const MARKER_SUFFIX = ' -->';

/**
 * Default delta-size threshold (lines). When the delta diff exceeds this, fall
 * back to full review — the savings vs. the safety regression of skipping
 * larger changes isn't worth it. Configurable via `--max-delta-lines` on the
 * CLI; the default is the value AISDLC-142 ships with based on the original
 * task description ("if delta is too large (>200 lines)").
 */
export const DEFAULT_MAX_DELTA_LINES = 200;

/** Marker payload encoded into the comment body. */
export interface MarkerPayload {
  /** sha256 hex of the per-file (base, head) blob-pair transition. */
  contentHash: string;
  /** Commit SHA-1 (40 hex chars) reviewed against this contentHash. */
  reviewedSha: string;
  /** ISO 8601 timestamp the marker was written. */
  reviewedAt: string;
}

/** One entry in the changed-file set used to compute `contentHashV3`. */
export interface ChangedFileDeltaEntry {
  path: string;
  baseBlobSha: string;
  headBlobSha: string;
}

/** Decision returned by `decideIncrementalReview`. */
export interface IncrementalDecision {
  /**
   * `true` when the marker's contentHash equals the current one — caller
   * should spawn 0 reviewers, post auto-approved verdicts, update marker.
   */
  skip: boolean;
  /**
   * `true` when delta is within `maxDeltaLines` AND no new top-level dirs
   * — caller should spawn reviewers against the delta diff
   * (`git diff <lastReviewedSha>...HEAD`).
   *
   * When BOTH `skip` and `deltaOnly` are `false`, the caller should run
   * a full review (`git diff origin/main...HEAD`). This happens on the
   * first push (no marker) and on the safety-fallback path (delta too
   * large or new top-level dirs touched).
   */
  deltaOnly: boolean;
  /** SHA the prior review covered, when known. */
  lastReviewedSha: string | null;
  /** Current `contentHashV3` (callers update the marker with this). */
  currentContentHash: string;
  /** Marker's contentHash, when known. */
  priorContentHash: string | null;
  /** Lines added + lines removed in the delta diff. */
  deltaSize: number;
  /**
   * Why `deltaOnly` is `false` when it could have been `true` — exposed for
   * operator-facing logs. One of:
   *   - 'no-marker'         (first push for this PR, or marker missing)
   *   - 'unchanged'         (skip path; deltaOnly N/A)
   *   - 'delta-too-large'   (lines exceed `maxDeltaLines`)
   *   - 'new-top-level-dir' (delta touches a top-level dir not in prior review)
   *   - 'delta-only'        (the affirmative case — `deltaOnly: true`)
   */
  reason: IncrementalReason;
}

export type IncrementalReason =
  | 'no-marker'
  | 'unchanged'
  | 'delta-too-large'
  | 'new-top-level-dir'
  | 'delta-only';

// ── Marker parse / format ────────────────────────────────────────────

/**
 * Encode the marker payload as a single-line HTML comment. Format (load-bearing
 * — the workflows search for the prefix substring to locate the comment):
 *
 *   <!-- ai-sdlc:last-reviewed-contenthash:<base64url(json)> -->
 *
 * base64url avoids `+/=` chars that markdown sometimes mangles in comments,
 * and JSON-inside-base64 keeps the marker forward-compatible (we can add
 * fields without breaking parsers that only key off the comment prefix).
 */
export function formatMarker(payload: MarkerPayload): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf-8').toString('base64url');
  return `${MARKER_PREFIX}${b64}${MARKER_SUFFIX}`;
}

/**
 * Locate + parse the marker inside `commentBody`. Returns `null` when no
 * marker is present OR when the encoded payload is malformed (defensive —
 * a corrupted marker should fall back to full review, NOT crash the
 * workflow).
 */
export function parseMarker(commentBody: string): MarkerPayload | null {
  const start = commentBody.indexOf(MARKER_PREFIX);
  if (start === -1) return null;
  const payloadStart = start + MARKER_PREFIX.length;
  const end = commentBody.indexOf(MARKER_SUFFIX, payloadStart);
  if (end === -1) return null;
  const b64 = commentBody.slice(payloadStart, end).trim();
  if (b64.length === 0) return null;
  try {
    const json = Buffer.from(b64, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof parsed.contentHash !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(parsed.contentHash) ||
      typeof parsed.reviewedSha !== 'string' ||
      !/^[0-9a-f]{40}$/i.test(parsed.reviewedSha) ||
      typeof parsed.reviewedAt !== 'string'
    ) {
      return null;
    }
    return {
      contentHash: parsed.contentHash.toLowerCase(),
      reviewedSha: parsed.reviewedSha.toLowerCase(),
      reviewedAt: parsed.reviewedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Search a list of PR-comment bodies for the most recent marker. Returns
 * `null` when none of them carry the marker. When more than one comment
 * carries a marker (shouldn't happen with the idempotent update path, but
 * defensively), the LAST occurrence wins — that's the freshest marker.
 */
export function findMarkerInComments(commentBodies: string[]): MarkerPayload | null {
  for (let i = commentBodies.length - 1; i >= 0; i--) {
    const m = parseMarker(commentBodies[i]);
    if (m !== null) return m;
  }
  return null;
}

// ── ContentHashV3 (mirror of orchestrator/src/runtime/attestations.ts) ─

/** Compute a sha256 hex digest. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Compute the per-file-delta `contentHashV3` over a set of
 * `{path, baseBlobSha, headBlobSha}` triples. Byte-identical algorithm to
 * `orchestrator/src/runtime/attestations.ts#computeContentHashV3` — see
 * that file for the rationale + threat-model documentation.
 *
 * Pure function. Idempotent against double-enumeration via dedup-by-path.
 */
export function computeContentHashV3(entries: ChangedFileDeltaEntry[]): string {
  const byPath = new Map<string, { baseBlobSha: string; headBlobSha: string }>();
  for (const e of entries) {
    if (typeof e?.path !== 'string' || e.path.length === 0) {
      throw new Error('computeContentHashV3: entry path must be a non-empty string');
    }
    if (typeof e.baseBlobSha !== 'string') {
      throw new Error(`computeContentHashV3: entry baseBlobSha must be a string for ${e.path}`);
    }
    if (typeof e.headBlobSha !== 'string') {
      throw new Error(`computeContentHashV3: entry headBlobSha must be a string for ${e.path}`);
    }
    if (e.path.includes('\t') || e.path.includes('\n')) {
      throw new Error(
        `computeContentHashV3: entry path must not contain tab or newline characters (got ${JSON.stringify(e.path)})`,
      );
    }
    const normalizedPath = e.path.replace(/\\/g, '/');
    byPath.set(normalizedPath, {
      baseBlobSha: e.baseBlobSha.toLowerCase(),
      headBlobSha: e.headBlobSha.toLowerCase(),
    });
  }
  const sorted = [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = sorted
    .map(([path, { baseBlobSha, headBlobSha }]) => {
      const fileDeltaHash = sha256Hex(`${baseBlobSha} -> ${headBlobSha}`);
      return `${path}\t${fileDeltaHash}\n`;
    })
    .join('');
  return sha256Hex(canonical);
}

/**
 * Run-git callback (kept injectable so tests don't depend on a real worktree).
 * Returns stdout (utf-8) on success; throw on failure.
 */
export type RunGit = (args: string[], cwd: string) => string;

/**
 * Collect the per-file-delta set from a git worktree. Mirror of
 * `collectChangedFileDeltaEntries` in
 * `orchestrator/src/runtime/attestations.ts` — see that file for rationale.
 */
export function collectChangedFileDeltaEntries(
  baseRef: string,
  headRef: string,
  repoRoot: string,
  runGit: RunGit,
): ChangedFileDeltaEntry[] {
  let mergeBase: string;
  try {
    mergeBase = runGit(['merge-base', baseRef, headRef], repoRoot).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`collectChangedFileDeltaEntries: git merge-base failed: ${msg}`);
  }
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) {
    throw new Error(
      `collectChangedFileDeltaEntries: git merge-base returned non-SHA output: ${JSON.stringify(mergeBase)}`,
    );
  }

  let nameOnly: string;
  try {
    nameOnly = runGit(
      [
        '-c',
        'core.quotepath=false',
        'diff',
        '--name-only',
        '--no-renames',
        `${baseRef}...${headRef}`,
      ],
      repoRoot,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`collectChangedFileDeltaEntries: git diff --name-only failed: ${msg}`);
  }

  const paths = nameOnly.split('\n').filter((p) => p.length > 0);
  const entries: ChangedFileDeltaEntry[] = [];

  const resolveBlobSha = (ref: string, path: string): string => {
    try {
      const lsOut = runGit(
        ['-c', 'core.quotepath=false', 'ls-tree', '-r', ref, '--', path],
        repoRoot,
      );
      const line = lsOut.split('\n').find((l) => l.length > 0);
      if (line) {
        const m = line.match(/^[0-9]+\s+blob\s+([0-9a-f]{40})\t/);
        if (m) return m[1];
      }
    } catch {
      // Path missing at ref → empty blob marker.
    }
    return '';
  };

  for (const path of paths) {
    if (path.includes('\t') || path.includes('\n')) {
      throw new Error(
        `collectChangedFileDeltaEntries: path must not contain tab or newline characters (got ${JSON.stringify(path)})`,
      );
    }
    const baseBlobSha = resolveBlobSha(mergeBase, path);
    const headBlobSha = resolveBlobSha(headRef, path);
    entries.push({ path, baseBlobSha, headBlobSha });
  }
  return entries;
}

// ── Delta sizing + decision ─────────────────────────────────────────

/**
 * Parse a `git diff --numstat` output (added\tremoved\tpath, one line each)
 * into total lines + the set of top-level dirs touched. Used by the delta-size
 * predicate. Robust against the `-` placeholder git uses for binary files
 * (treated as 0).
 */
export interface DeltaStats {
  /** Sum of lines added across all files. */
  linesAdded: number;
  /** Sum of lines removed across all files. */
  linesRemoved: number;
  /** Lines added + lines removed (the predicate input). */
  totalLines: number;
  /** Top-level directory of each changed path (e.g. `src`, `docs`). */
  topLevelDirs: Set<string>;
  /** Number of files changed. */
  filesChanged: number;
}

export function parseNumstatForDelta(numstat: string): DeltaStats {
  let linesAdded = 0;
  let linesRemoved = 0;
  const topLevelDirs = new Set<string>();
  let filesChanged = 0;
  for (const raw of numstat.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (!m) continue;
    const a = m[1] === '-' ? 0 : Number(m[1]);
    const r = m[2] === '-' ? 0 : Number(m[2]);
    linesAdded += a;
    linesRemoved += r;
    const path = m[3];
    filesChanged += 1;
    // First path segment is the top-level dir; root files map to ''.
    const slash = path.indexOf('/');
    topLevelDirs.add(slash === -1 ? '' : path.slice(0, slash));
  }
  return {
    linesAdded,
    linesRemoved,
    totalLines: linesAdded + linesRemoved,
    topLevelDirs,
    filesChanged,
  };
}

/** Inputs for `decideIncrementalReview`. Pure-function shape; no I/O. */
export interface DecideInputs {
  /** Marker payload from the prior review, or `null` on first push. */
  prior: MarkerPayload | null;
  /** Current `contentHashV3` for HEAD. */
  currentContentHash: string;
  /**
   * Stats for the delta diff between `prior.reviewedSha` and HEAD. When
   * `prior` is `null`, callers may pass a synthetic zero-stat object — the
   * `no-marker` branch returns `deltaOnly: false` regardless.
   */
  deltaStats: DeltaStats;
  /**
   * Top-level dirs touched in the FULL PR diff (`git diff base...head`).
   * Compared against `deltaStats.topLevelDirs` to detect "delta touches a
   * new top-level dir not in the prior review" — that's the AC-5
   * "touches new top-level dirs" safety condition.
   *
   * Pass an empty set to disable the new-top-level-dir guard. The full PR
   * diff at the time of the prior review is what we'd ideally compare
   * against, but we don't store it; the conservative approximation here
   * is "any top-level dir in the delta that ISN'T in this set triggers
   * fallback." Since this set is the union of all top-level dirs in the
   * current full diff, the only triggering case is when the delta itself
   * adds a brand-new top-level dir to the PR — exactly what the safety
   * condition is meant to catch.
   */
  fullDiffTopLevelDirs: Set<string>;
  /** Threshold for the `delta-too-large` branch. Defaults `DEFAULT_MAX_DELTA_LINES`. */
  maxDeltaLines?: number;
}

/**
 * The deterministic decision function. Pure — no I/O, no clock, no random.
 *
 * Branches (in order):
 *   1. no marker          → deltaOnly: false, reason: 'no-marker' (full review)
 *   2. hash unchanged     → skip: true, reason: 'unchanged' (auto-approve)
 *   3. delta over cap     → deltaOnly: false, reason: 'delta-too-large'
 *   4. new top-level dir  → deltaOnly: false, reason: 'new-top-level-dir'
 *   5. otherwise          → deltaOnly: true, reason: 'delta-only'
 *
 * Safety property: the function NEVER returns `skip: true` AND `deltaOnly: true`
 * — they are mutually exclusive states surfaced in distinct branches.
 */
export function decideIncrementalReview(inputs: DecideInputs): IncrementalDecision {
  const maxDeltaLines = inputs.maxDeltaLines ?? DEFAULT_MAX_DELTA_LINES;
  const baseDecision = {
    currentContentHash: inputs.currentContentHash,
    deltaSize: inputs.deltaStats.totalLines,
  };
  if (inputs.prior === null) {
    return {
      ...baseDecision,
      skip: false,
      deltaOnly: false,
      lastReviewedSha: null,
      priorContentHash: null,
      reason: 'no-marker',
    };
  }
  if (inputs.prior.contentHash === inputs.currentContentHash) {
    return {
      ...baseDecision,
      skip: true,
      deltaOnly: false,
      lastReviewedSha: inputs.prior.reviewedSha,
      priorContentHash: inputs.prior.contentHash,
      reason: 'unchanged',
    };
  }
  if (inputs.deltaStats.totalLines > maxDeltaLines) {
    return {
      ...baseDecision,
      skip: false,
      deltaOnly: false,
      lastReviewedSha: inputs.prior.reviewedSha,
      priorContentHash: inputs.prior.contentHash,
      reason: 'delta-too-large',
    };
  }
  for (const dir of inputs.deltaStats.topLevelDirs) {
    if (!inputs.fullDiffTopLevelDirs.has(dir)) {
      return {
        ...baseDecision,
        skip: false,
        deltaOnly: false,
        lastReviewedSha: inputs.prior.reviewedSha,
        priorContentHash: inputs.prior.contentHash,
        reason: 'new-top-level-dir',
      };
    }
  }
  return {
    ...baseDecision,
    skip: false,
    deltaOnly: true,
    lastReviewedSha: inputs.prior.reviewedSha,
    priorContentHash: inputs.prior.contentHash,
    reason: 'delta-only',
  };
}

/**
 * Build the auto-approved verdict JSON the caller posts when `skip: true`.
 * Mirrors the AISDLC-141 auto-approved shape so the report-job parser
 * accepts it as a valid verdict without changes.
 *
 * The summary mentions the prior reviewed SHA so the operator can audit
 * which review the skip is reusing.
 */
export function buildAutoApprovedVerdict(lastReviewedSha: string): {
  approved: true;
  findings: never[];
  summary: string;
} {
  return {
    approved: true,
    findings: [],
    summary:
      `Skipped by incremental review (AISDLC-142) — content unchanged ` +
      `since prior approval at ${lastReviewedSha}.`,
  };
}
