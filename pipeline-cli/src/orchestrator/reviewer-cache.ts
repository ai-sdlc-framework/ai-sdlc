/**
 * Reviewer-pass cache (AISDLC-418, iter-2 redesign).
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
 * This module persists per-reviewer verdicts + per-file content fingerprints
 * to `<workdir>/.ai-sdlc/verdicts/cache/<task-id-lower>/<reviewer>.json` so
 * the next reconcile tick can short-circuit reviewers whose coverage hasn't
 * changed.
 *
 * ## Iter-2 trust-chain redesign
 *
 * The iter-1 cache had two critical vulnerabilities + two majors:
 *
 *  - **CRITICAL #1**: cache integrity self-certified — the cache file stored
 *    `agentFileHash` and was compared on read against a fresh hash of the
 *    same reviewer .md. An attacker who could write the cache file just
 *    wrote a matching hash and forged an approval.
 *    → Fix: bind every cache entry to the dev commit SHA at save time
 *    (`cachedAtHeadSha`). On read, callers pass the CURRENT HEAD SHA;
 *    branches advancing past the saved SHA invalidate ALL entries. This is
 *    how the rest of the v6 trust chain works (Merkle subject.digest.sha1
 *    ↔ HEAD binding).
 *
 *  - **CRITICAL #2**: disjoint-files reuse — iter-1 returned HIT when the
 *    current diff was disjoint from the cached coverage. A cached approval
 *    on [a.ts, b.ts] would apply to a brand-new [c.ts, d.ts] diff the
 *    reviewer never saw.
 *    → Fix: invert the semantics. HIT only when every current file is a
 *    subset of the cached files AND the per-file blob SHA matches. Two
 *    iterations touching the same file paths but with different content
 *    correctly MISS.
 *
 *  - **MAJOR #3**: cache HIT skipped transcript persistence, so v6
 *    `emit-leaf` had no leaf for the cached reviewer and the Merkle root
 *    rejected the iteration.
 *    → Fix: persist the reviewer transcript alongside the cache JSON
 *    (`<reviewer>.transcript.jsonl`). HIT callers copy it back into the
 *    worktree's `.ai-sdlc/transcripts/<task>/` dir and emit-leaf as normal,
 *    preserving the v6 Merkle chain.
 *
 *  - **MAJOR #4**: save was gated on the aggregate success branch, so
 *    iterate-needed runs left the cache empty.
 *    → Fix: callers MUST invoke `saveReviewerCache` after every individual
 *    reviewer Agent completes when `approved === true`, regardless of the
 *    aggregate verdict. Documented in the slash command body and enforced
 *    by the orchestrator-tick prose.
 *
 * ## Invalidation triggers (post-iter-2)
 *
 *   1. **HEAD-SHA binding** — cache stored at SHA-X invalidates the moment
 *      the branch advances to SHA-Y. Strongest defense against silent reuse
 *      across iterations + against forged cache files (an attacker would
 *      need to know the current HEAD AND have write access to the cache
 *      file; the HEAD changes every commit so the window is tight).
 *   2. **Subset + blob-SHA file coverage** — `currentFiles ⊆ cachedFiles`
 *      where each current file's git blob SHA matches the cached blob SHA.
 *      Files added since the cache → MISS. Files re-touched with new
 *      content → MISS. Files unchanged + in the cached set → HIT.
 *   3. **TTL** — cached verdicts older than `--ttl-hours` (default 24) are
 *      stale. Cross-RFC review drift (reviewer prompt evolution, framework
 *      changes) makes a verdict from yesterday a weaker signal than one
 *      from this hour.
 *   4. **Reviewer-agent file hash** — when the reviewer's `.md` definition
 *      changes (prompt rewrite, rule add, tool grant), the cache invalidates.
 *      Defense-in-depth: HEAD-SHA binding already catches "different commit"
 *      but a reviewer .md edit can land in a different repo path entirely.
 *
 * ## Scope
 *
 * This module is the **library** layer. The CLI surface (`reviewer-cache
 * check` / `reviewer-cache save`) wires this into the
 * `/ai-sdlc orchestrator-tick` slash body. The reconcile sub-tick itself
 * (`ai-sdlc-pipeline reconcile <task-id>`) does NOT call this directly —
 * caching is a pre-reviewer-fan-out optimization, not a post-reviewer step.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/**
 * Default TTL — 24 hours. Matches the operator add-on guidance in the
 * AISDLC-418 task body: "cache TTL (e.g., 24h to avoid stale cross-RFC
 * review drift)".
 */
export const DEFAULT_CACHE_TTL_HOURS = 24;

/**
 * Schema version for the on-disk cache record.
 *
 *   v1 — iter-1 (AISDLC-418 round 1). Disjoint-files reuse + path-only
 *        coverage + self-certified agent hash. **Deprecated**: any v1 entry
 *        encountered on read is treated as malformed-cache (a security
 *        downgrade attack would otherwise be possible by an attacker who
 *        rolled the schemaVersion back).
 *   v2 — iter-2 (this file). Subset semantics + per-file blob SHAs +
 *        HEAD-SHA binding + sibling transcript persistence.
 */
export const REVIEWER_CACHE_SCHEMA_VERSION = 'v2' as const;

/**
 * Reviewer names the cache recognizes. Matches the three subagents the
 * orchestrator tick fans out via Agent calls in the main session.
 */
export type ReviewerName = 'code-reviewer' | 'test-reviewer' | 'security-reviewer';

/** Reasons the cache reports for a check result. Useful for orchestrator logs. */
export type CacheMissReason =
  | 'no-cache-entry'
  | 'not-subset-of-cached-files'
  | 'blob-sha-mismatch'
  | 'head-sha-mismatch'
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
  /**
   * Path the persisted reviewer transcript can be restored from (only set
   * on hit). The caller's responsibility to copy it into the worktree's
   * `.ai-sdlc/transcripts/<task>/<reviewer>.jsonl` so the v6 emit-leaf
   * step finds it. Empty string when no transcript was persisted at save
   * time (legacy entries; cache hits without transcripts cannot satisfy
   * v6 mode and MUST re-run the reviewer).
   */
  transcriptPath?: string;
}

/** Per-file entry inside the on-disk cache witness. */
export interface CacheFileEntry {
  /** Workdir-relative path. */
  path: string;
  /** Git blob SHA (`git ls-tree HEAD -- <path> -> object` or equivalent). */
  blobSha: string;
}

/** On-disk shape of a cached reviewer verdict. */
export interface ReviewerCacheEntry {
  schemaVersion: typeof REVIEWER_CACHE_SCHEMA_VERSION;
  taskId: string;
  reviewer: ReviewerName | string;
  /**
   * Per-file coverage witness — workdir-relative path + git blob SHA so the
   * read side can verify content equality (not just path equality). Sorted
   * by `path` for deterministic comparison.
   */
  files: CacheFileEntry[];
  /**
   * SHA-256 of the full {files} array — fast-path equality probe and audit
   * anchor. Derived from `files`; redundant for safety, not for security.
   */
  filesFingerprint: string;
  /** SHA-256 of the reviewer's `.md` agent definition file. */
  agentFileHash: string;
  /**
   * Dev commit SHA at the moment of cache write. The cache MISSES on any
   * read where the caller's `headSha` differs. This is the iter-2
   * trust-chain anchor — see module docstring CRITICAL #1.
   */
  cachedAtHeadSha: string;
  /** Path to the original reviewer verdict JSON (relative to workdir). */
  verdictPath: string;
  /** Path to the persisted reviewer transcript (relative to workdir, or empty). */
  transcriptPath: string;
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
  /**
   * Per-file coverage of the CURRENT iteration's diff. Each entry MUST
   * include the git blob SHA so the read side can detect content drift
   * (same path, new content → MISS).
   */
  currentFiles: readonly CacheFileEntry[];
  /** Path to the reviewer's `.md` agent definition (absolute or relative to workDir). */
  agentFilePath: string;
  /**
   * Current dev HEAD commit SHA. Required for HEAD-SHA invalidation
   * (iter-2 CRITICAL #1). MISS if it differs from `cachedAtHeadSha`.
   */
  headSha: string;
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
  /** Per-file coverage of this iteration (path + blob SHA, in any order). */
  files: readonly CacheFileEntry[];
  /** Path to the reviewer's `.md` agent definition file. */
  agentFilePath: string;
  /** Dev commit SHA at save time (iter-2 trust anchor). */
  headSha: string;
  /**
   * Reviewer verdict JSON content — either a raw object or a path to the
   * file. Both forms are supported so callers can pass an in-memory object
   * from the Agent fan-out OR a path to the on-disk verdict from the slash
   * command body's bash glue.
   */
  verdict: ReviewerCacheEntry['verdict'];
  /** Optional path-on-disk for `verdictPath` field (relative to workdir). */
  verdictPath?: string;
  /**
   * Optional path to the reviewer's transcript JSONL. When provided, the
   * file is copied alongside the cache entry so HIT consumers can restore
   * it into the worktree and `emit-leaf` it for v6 trust-chain continuity.
   */
  transcriptPath?: string;
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
 * Compute the sibling transcript path (lives next to the cache JSON so
 * `cleanupTaskCache` can remove the pair as one unit).
 */
export function reviewerCacheTranscriptPath(
  workDir: string,
  taskId: string,
  reviewer: string,
): string {
  return path.join(
    workDir,
    '.ai-sdlc',
    'verdicts',
    'cache',
    taskId.toLowerCase(),
    `${reviewer}.transcript.jsonl`,
  );
}

/**
 * Stable fingerprint of a per-file coverage list — sorted by `path`, then
 * each `{path, blobSha}` joined with a newline, SHA-256-ed. Two file lists
 * with the same paths but different blobs produce different fingerprints
 * (per iter-2 CRITICAL #2 fix).
 */
export function computeFilesFingerprint(files: readonly CacheFileEntry[]): string {
  const normalized = normalizeFileEntries(files);
  const lines = normalized.map((f) => `${f.path} ${f.blobSha}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Normalize a per-file entry list — trim whitespace, drop empties, sort by
 * `path`, lowercase blob SHAs. Returns a fresh array so callers can pass
 * `readonly` inputs without aliasing concerns.
 */
export function normalizeFileEntries(files: readonly CacheFileEntry[]): CacheFileEntry[] {
  return [...files]
    .map((f) => ({ path: (f.path ?? '').trim(), blobSha: (f.blobSha ?? '').trim().toLowerCase() }))
    .filter((f) => f.path.length > 0 && f.blobSha.length > 0)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
 * Resolve the git blob SHA for a single workdir-relative path at the
 * current HEAD via `git ls-tree -r --object-only HEAD -- <path>`. Returns
 * '' if the file isn't tracked (uncommitted) — callers MUST treat empty
 * as "not yet representable in the cache" and skip saving until the
 * relevant commit lands.
 *
 * The output of `git ls-tree -r --object-only HEAD -- <path>` is a single
 * line with the blob SHA when the path matches; empty otherwise. The
 * `-r` flag handles paths inside subdirectories.
 */
export function resolveBlobShaForPath(workDir: string, relativePath: string): string {
  if (!relativePath || relativePath.includes('..')) return '';
  const result = spawnSync('git', ['ls-tree', '-r', '--object-only', 'HEAD', '--', relativePath], {
    cwd: workDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) return '';
  const line = (result.stdout || '').trim().split('\n')[0] ?? '';
  return /^[0-9a-f]{40}$/.test(line) ? line : '';
}

/**
 * Convenience: resolve blob SHAs for a list of paths in one shot. Drops
 * paths that don't resolve (uncommitted, deleted). Use this in the slash
 * command body when building the cache input from `git diff --name-only
 * origin/main...HEAD`.
 */
export function resolveBlobShasForPaths(
  workDir: string,
  paths: readonly string[],
): CacheFileEntry[] {
  const out: CacheFileEntry[] = [];
  for (const p of paths) {
    const blobSha = resolveBlobShaForPath(workDir, p);
    if (blobSha) out.push({ path: p, blobSha });
  }
  return out;
}

/**
 * Probe the cache for a reusable reviewer verdict.
 *
 * Returns `{hit: false, reason}` for any of the invalidation triggers
 * (no cache entry, HEAD SHA mismatch, file-coverage not a subset of
 * cached, per-file blob SHA mismatch, TTL expiry, agent-hash change,
 * malformed cache file, schema downgrade attempt). Returns
 * `{hit: true, entry, transcriptPath}` only when ALL checks pass.
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
  // Schema downgrade protection — iter-1 entries (v1) must NOT satisfy iter-2
  // semantics. An attacker who could write an old-shape cache file would
  // otherwise bypass the new trust-chain checks.
  if (entry?.schemaVersion !== REVIEWER_CACHE_SCHEMA_VERSION) {
    return { hit: false, reason: 'malformed-cache' };
  }

  // HEAD-SHA binding (iter-2 CRITICAL #1) — strongest defense first so
  // forged or stale cache files exit fast.
  if (!input.headSha || !entry.cachedAtHeadSha || entry.cachedAtHeadSha !== input.headSha) {
    return { hit: false, reason: 'head-sha-mismatch' };
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

  // Iter-2 CRITICAL #2 — subset semantics + per-file blob SHA equality.
  // HIT requires: every file in the current iteration's diff is a member
  // of the cached coverage AND has the same blob SHA. A new file (not in
  // the cached set) → MISS. A re-touched file (same path, new content) →
  // MISS via blob-sha-mismatch.
  if (!Array.isArray(entry.files) || entry.files.length === 0) {
    return { hit: false, reason: 'malformed-cache' };
  }
  const cachedByPath = new Map<string, string>();
  for (const f of entry.files) {
    if (typeof f?.path === 'string' && typeof f?.blobSha === 'string') {
      cachedByPath.set(f.path, f.blobSha.toLowerCase());
    }
  }
  const currentNormalized = normalizeFileEntries(input.currentFiles);
  // Empty current diff is a degenerate case — treat as MISS (no signal to
  // verify against). Avoids the "no files changed → trivially subset" bug.
  if (currentNormalized.length === 0) {
    return { hit: false, reason: 'not-subset-of-cached-files' };
  }
  for (const f of currentNormalized) {
    const cachedBlob = cachedByPath.get(f.path);
    if (cachedBlob === undefined) {
      return { hit: false, reason: 'not-subset-of-cached-files' };
    }
    if (cachedBlob !== f.blobSha) {
      return { hit: false, reason: 'blob-sha-mismatch' };
    }
  }

  // All checks pass — return HIT with the sibling transcript path so the
  // caller can restore it for v6 emit-leaf continuity (iter-2 MAJOR #3).
  const transcriptPath = entry.transcriptPath ? path.join(input.workDir, entry.transcriptPath) : '';
  const siblingTranscript = reviewerCacheTranscriptPath(
    input.workDir,
    input.taskId,
    input.reviewer,
  );
  const effectiveTranscript = existsSync(siblingTranscript) ? siblingTranscript : transcriptPath;
  return {
    hit: true,
    reason: null,
    entry,
    transcriptPath: effectiveTranscript,
  };
}

/**
 * Persist a reviewer verdict to the cache. Overwrites any prior entry for
 * the (taskId, reviewer) pair. Atomic via temp+rename so a partial write
 * is never visible to a concurrent `checkReviewerCache`.
 *
 * When `transcriptPath` is provided AND the file exists, it is copied to
 * the sibling `<reviewer>.transcript.jsonl` next to the cache JSON, so
 * cache HITs can re-emit a v6 leaf without losing Merkle-chain continuity
 * (iter-2 MAJOR #3).
 *
 * Returns the absolute path of the cache JSON written.
 */
export function saveReviewerCache(input: SaveReviewerCacheInput): string {
  if (!input.headSha || !/^[0-9a-f]{7,64}$/.test(input.headSha)) {
    throw new Error(
      `saveReviewerCache: invalid headSha '${input.headSha}' (expected 7-64 hex chars; iter-2 trust anchor MUST be set)`,
    );
  }
  const target = reviewerCachePath(input.workDir, input.taskId, input.reviewer);
  mkdirSync(path.dirname(target), { recursive: true });
  const normalizedFiles = normalizeFileEntries(input.files);
  // Persist the transcript sibling first so any reader who races against
  // the cache-file rename sees an empty cache (handled as no-entry) OR
  // a fully-formed cache+transcript pair, never a half-state.
  let persistedTranscriptRel = '';
  if (input.transcriptPath && existsSync(input.transcriptPath)) {
    const siblingTranscript = reviewerCacheTranscriptPath(
      input.workDir,
      input.taskId,
      input.reviewer,
    );
    try {
      copyFileSync(input.transcriptPath, siblingTranscript);
      persistedTranscriptRel = path.relative(input.workDir, siblingTranscript);
    } catch {
      // Transcript copy is best-effort — a missing transcript on HIT
      // forces the caller to re-run the reviewer (graceful degradation).
      persistedTranscriptRel = '';
    }
  }
  const entry: ReviewerCacheEntry = {
    schemaVersion: REVIEWER_CACHE_SCHEMA_VERSION,
    taskId: input.taskId,
    reviewer: input.reviewer,
    files: normalizedFiles,
    filesFingerprint: computeFilesFingerprint(normalizedFiles),
    agentFileHash: computeAgentFileHash(input.agentFilePath),
    cachedAtHeadSha: input.headSha,
    verdictPath: input.verdictPath ?? '',
    transcriptPath: persistedTranscriptRel,
    verdict: input.verdict,
    cachedAt: input.cachedAt ?? new Date().toISOString(),
  };
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  renameSync(tmp, target);
  return target;
}

/**
 * Convenience for callers in the slash command body / reconcile flow:
 * restore a HIT'd transcript into the worktree's
 * `.ai-sdlc/transcripts/<task-id-lower>/<reviewer>.jsonl` so the
 * subsequent `cli-attestation emit-leaf` invocation sees it. Returns the
 * destination path written, or '' on failure / no source.
 */
export function restoreCachedTranscriptToWorktree(
  workDir: string,
  taskId: string,
  reviewer: string,
  worktreePath: string,
  cachedTranscriptPath: string,
): string {
  if (!cachedTranscriptPath || !existsSync(cachedTranscriptPath)) return '';
  const destDir = path.join(worktreePath, '.ai-sdlc', 'transcripts', taskId.toLowerCase());
  const dest = path.join(destDir, `${reviewer}.jsonl`);
  try {
    mkdirSync(destDir, { recursive: true });
    copyFileSync(cachedTranscriptPath, dest);
    return dest;
  } catch {
    return '';
  }
}
