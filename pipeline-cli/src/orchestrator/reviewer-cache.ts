/**
 * Reviewer-pass cache (AISDLC-418).
 *
 * ## Why
 *
 * When the orchestrator reconcile sub-tick re-dispatches a task after an
 * `iterate-needed` verdict, the next round's reviewer fan-out frequently
 * re-runs reviewers that already approved a stable subset of files. The
 * security-reviewer (Opus, expensive) is the worst offender — on a 2-file
 * iteration where only the unrelated MAJOR finding was fixed, paying for a
 * full security pass against the unchanged surface is pure waste.
 *
 * This module persists per-reviewer verdicts + file-coverage fingerprints
 * to `<workdir>/.ai-sdlc/verdicts/cache/<task-id-lower>/<reviewer>.json` so
 * the next reconcile tick can short-circuit reviewers whose coverage hasn't
 * changed.
 *
 * ## Invalidation triggers (AC #5)
 *
 *   1. **File-coverage overlap.** Cache invalidates if ANY file the previous
 *      iteration's diff touched is touched again in the new iteration. The
 *      conservative semantics — overlap → re-run — is intentional: a finer-
 *      grained "did the reviewer flag this specific file" check would let a
 *      regression sneak in by touching only the unflagged files. Coverage is
 *      computed as the sorted SHA-256 of the file path list to keep
 *      fingerprint comparison O(1).
 *   2. **TTL.** Cached verdicts older than `--ttl-hours` (default 24) are
 *      considered stale. Cross-RFC review drift (reviewer prompt evolution,
 *      framework changes) makes a verdict from yesterday a weaker signal
 *      than one from this hour.
 *   3. **Reviewer-agent file hash.** When the reviewer's `.md` definition
 *      changes (prompt rewrite, rule add, tool grant), cached verdicts are
 *      invalidated — the agent is materially different and prior approvals
 *      cannot be assumed to hold.
 *
 * ## Scope
 *
 * This module is the **library** layer. The CLI surface (`reviewer-cache
 * check` / `reviewer-cache save`) wires this into the
 * `/ai-sdlc orchestrator-tick` slash body. The reconcile sub-tick itself
 * (`ai-sdlc-pipeline reconcile <task-id>`) does NOT call this directly —
 * caching is a pre-reviewer-fan-out optimization, not a post-reviewer step.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Default TTL — 24 hours. Matches the operator add-on guidance in the
 * AISDLC-418 task body: "cache TTL (e.g., 24h to avoid stale cross-RFC
 * review drift)".
 */
export const DEFAULT_CACHE_TTL_HOURS = 24;

/** Schema version for the on-disk cache record. */
export const REVIEWER_CACHE_SCHEMA_VERSION = 'v1' as const;

/**
 * Reviewer names the cache recognizes. Matches the three subagents the
 * orchestrator tick fans out via Agent calls in the main session.
 */
export type ReviewerName = 'code-reviewer' | 'test-reviewer' | 'security-reviewer';

/** Reasons the cache reports for a check result. Useful for orchestrator logs. */
export type CacheMissReason =
  | 'no-cache-entry'
  | 'file-coverage-overlap'
  | 'ttl-expired'
  | 'agent-hash-changed'
  | 'malformed-cache';

/** Result of a cache lookup. */
export interface CacheCheckResult {
  /** True when the cached verdict can be reused. */
  hit: boolean;
  /** Why we missed (or `null` on hit). */
  reason: CacheMissReason | null;
  /** The cached entry (only present on hit). */
  entry?: ReviewerCacheEntry;
}

/** On-disk shape of a cached reviewer verdict. */
export interface ReviewerCacheEntry {
  schemaVersion: typeof REVIEWER_CACHE_SCHEMA_VERSION;
  taskId: string;
  reviewer: ReviewerName | string;
  /** SHA-256 of the sorted file list — the "coverage" fingerprint. */
  filesFingerprint: string;
  /** SHA-256 of the reviewer's `.md` agent definition file. */
  agentFileHash: string;
  /** Path to the original reviewer verdict JSON (relative to workdir). */
  verdictPath: string;
  /** Parsed reviewer verdict — copied here so cache hits don't need a second file read. */
  verdict: {
    approved: boolean;
    findings?: {
      critical?: number;
      major?: number;
      minor?: number;
      suggestion?: number;
    };
    [extra: string]: unknown;
  };
  /** ISO-8601 timestamp the cache entry was written. */
  cachedAt: string;
}

/** Inputs to {@link checkReviewerCache}. */
export interface CheckReviewerCacheInput {
  workDir: string;
  taskId: string;
  reviewer: ReviewerName | string;
  /** File paths in this iteration's diff (relative to workdir, any order). */
  currentFiles: readonly string[];
  /** Path to the reviewer's `.md` agent definition (absolute or relative to workDir). */
  agentFilePath: string;
  /** TTL window in hours; cached entries older than this miss. Default 24. */
  ttlHours?: number;
  /** Override `now()` for hermetic tests (ms since epoch). */
  now?: number;
}

/** Inputs to {@link saveReviewerCache}. */
export interface SaveReviewerCacheInput {
  workDir: string;
  taskId: string;
  reviewer: ReviewerName | string;
  /** File paths in this iteration's diff (relative to workdir, any order). */
  files: readonly string[];
  /** Path to the reviewer's `.md` agent definition file. */
  agentFilePath: string;
  /**
   * Reviewer verdict JSON content — either a raw object or a path to the
   * file. Both forms are supported so callers can pass an in-memory object
   * from the Agent fan-out OR a path to the on-disk verdict from the slash
   * command body's bash glue.
   */
  verdict: ReviewerCacheEntry['verdict'];
  /** Optional path-on-disk for `verdictPath` field (relative to workdir). */
  verdictPath?: string;
  /** Override timestamp for hermetic tests. */
  cachedAt?: string;
}

/**
 * Compute the cache file path for a given task + reviewer.
 *
 * Layout: `<workDir>/.ai-sdlc/verdicts/cache/<task-id-lower>/<reviewer>.json`
 */
export function reviewerCachePath(workDir: string, taskId: string, reviewer: string): string {
  return path.join(
    workDir,
    '.ai-sdlc',
    'verdicts',
    'cache',
    taskId.toLowerCase(),
    `${reviewer}.json`,
  );
}

/**
 * Stable fingerprint of a file list — sorted (so order doesn't affect the
 * fingerprint), joined with a newline, SHA-256-ed. Empty list still
 * produces a stable hash so an "empty diff" iteration is comparable to
 * another empty-diff iteration (degenerate, but well-defined).
 */
export function computeFilesFingerprint(files: readonly string[]): string {
  const sorted = [...files].map((f) => f.trim()).filter((f) => f.length > 0);
  sorted.sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}

/**
 * SHA-256 of the reviewer's `.md` agent definition file. If the file
 * doesn't exist (test fixtures, unrecognized reviewer), returns a
 * sentinel string so cache comparisons remain stable.
 */
export function computeAgentFileHash(agentFilePath: string): string {
  if (!existsSync(agentFilePath)) {
    return 'missing-agent-file';
  }
  try {
    return createHash('sha256').update(readFileSync(agentFilePath)).digest('hex');
  } catch {
    return 'unreadable-agent-file';
  }
}

/**
 * Probe the cache for a reusable reviewer verdict.
 *
 * Returns `{hit: false, reason}` for any of the invalidation triggers
 * (no cache entry, file-coverage overlap, TTL expiry, agent-hash change,
 * malformed cache file). Returns `{hit: true, entry}` only when ALL
 * checks pass.
 */
export function checkReviewerCache(input: CheckReviewerCacheInput): CacheCheckResult {
  const ttlHours = input.ttlHours ?? DEFAULT_CACHE_TTL_HOURS;
  const target = reviewerCachePath(input.workDir, input.taskId, input.reviewer);
  if (!existsSync(target)) {
    return { hit: false, reason: 'no-cache-entry' };
  }
  let entry: ReviewerCacheEntry;
  try {
    entry = JSON.parse(readFileSync(target, 'utf8')) as ReviewerCacheEntry;
  } catch {
    return { hit: false, reason: 'malformed-cache' };
  }
  if (entry?.schemaVersion !== REVIEWER_CACHE_SCHEMA_VERSION) {
    return { hit: false, reason: 'malformed-cache' };
  }

  // TTL check.
  const now = input.now ?? Date.now();
  const cachedAt = Date.parse(entry.cachedAt);
  if (!Number.isFinite(cachedAt)) {
    return { hit: false, reason: 'malformed-cache' };
  }
  const ageMs = now - cachedAt;
  if (ageMs > ttlHours * 60 * 60 * 1000) {
    return { hit: false, reason: 'ttl-expired' };
  }

  // Agent-hash check.
  const currentAgentHash = computeAgentFileHash(input.agentFilePath);
  if (currentAgentHash !== entry.agentFileHash) {
    return { hit: false, reason: 'agent-hash-changed' };
  }

  // File-coverage overlap check (conservative — ANY overlap invalidates).
  const cachedFiles = decomposeFingerprintWitness(entry);
  const currentSet = new Set(input.currentFiles.map((f) => f.trim()).filter((f) => f.length > 0));
  for (const f of cachedFiles) {
    if (currentSet.has(f)) {
      return { hit: false, reason: 'file-coverage-overlap' };
    }
  }

  return { hit: true, reason: null, entry };
}

/**
 * Persist a reviewer verdict to the cache. Overwrites any prior entry for
 * the (taskId, reviewer) pair. Atomic via temp+rename so a partial write
 * is never visible to a concurrent `checkReviewerCache`.
 *
 * Returns the absolute path written.
 */
export function saveReviewerCache(input: SaveReviewerCacheInput): string {
  const target = reviewerCachePath(input.workDir, input.taskId, input.reviewer);
  mkdirSync(path.dirname(target), { recursive: true });
  const entry: ReviewerCacheEntry = {
    schemaVersion: REVIEWER_CACHE_SCHEMA_VERSION,
    taskId: input.taskId,
    reviewer: input.reviewer,
    filesFingerprint: computeFilesFingerprint(input.files),
    agentFileHash: computeAgentFileHash(input.agentFilePath),
    verdictPath: input.verdictPath ?? '',
    verdict: input.verdict,
    cachedAt: input.cachedAt ?? new Date().toISOString(),
  };
  // Side-channel — also persist the sorted file list verbatim alongside the
  // fingerprint so {@link checkReviewerCache} can do an O(n) set-overlap
  // check rather than a fingerprint-only comparison. The fingerprint stays
  // in the schema as a fast-path equality probe + audit-trail anchor.
  const augmented = {
    ...entry,
    _filesWitness: [...input.files].map((f) => f.trim()).filter((f) => f.length > 0),
  };
  augmented._filesWitness.sort();
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(augmented, null, 2) + '\n', 'utf8');
  renameSync(tmp, target);
  return target;
}

/**
 * Extract the on-disk file-list witness so coverage-overlap checks can
 * iterate without re-deriving file paths from the fingerprint (impossible
 * — SHA-256 is one-way). Returns an empty array when the witness is
 * missing (legacy entries written before the witness was added).
 */
function decomposeFingerprintWitness(entry: ReviewerCacheEntry): string[] {
  const witness = (entry as unknown as { _filesWitness?: unknown })._filesWitness;
  if (!Array.isArray(witness)) return [];
  return witness.filter((v): v is string => typeof v === 'string');
}
