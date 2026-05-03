/**
 * Dependency-graph data loader for the dashboard (AISDLC-167.4 / RFC-0014
 * Phase 4 §7.2).
 *
 * Wraps `buildCriticalPathDigest` from `@ai-sdlc/pipeline-cli/deps` so the
 * dashboard renders the same critical-path projection the Slack digest does
 * — one source of truth, two surfaces.
 *
 * Source-of-truth resolution (in order):
 *   1. Explicit `artifactsDir` opt — bypasses env + cwd resolution
 *   2. `DEPS_SNAPSHOT_DIR` env var — operator-specified absolute path to the
 *      `<artifactsDir>` parent (the loader appends `/_deps/` per
 *      `resolveSnapshotDir`'s convention)
 *   3. `<process.cwd()>/artifacts` — the conventional local snapshot path
 *      written by `cli-deps snapshot`
 *
 * Returns `null` when no snapshot exists so the page can render an empty-
 * state hint instead of a stack trace. Mirrors the AISDLC-162 dor-data
 * loader pattern.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCriticalPathDigest,
  enrichSnapshot,
  loadLatestSnapshot,
  selectCriticalPath,
  type EnrichedSnapshotRecord,
  type LoadedSnapshot,
} from '@ai-sdlc/pipeline-cli/deps';

export interface DepsDataResult {
  /** Resolved artifacts root used for the lookup (absolute path). */
  artifactsRoot: string;
  /** Absolute path to the snapshot file that was read. */
  snapshotPath: string;
  /** ISO timestamp embedded in the snapshot filename. */
  snapshotIsoTimestamp: string;
  /** Tag of the loaded snapshot. */
  snapshotTag: LoadedSnapshot['tag'];
  /** Total snapshot rows parsed (after malformed-line skips). */
  totalRecords: number;
  /** Malformed lines skipped — surfaced for forensic context. */
  skipped: number;
  /**
   * All enriched snapshot rows (open + completed) sorted by dispatch order.
   * The page renders the full set and highlights the top N visually rather
   * than truncating — graph topology is more useful than a pre-trimmed list.
   */
  enriched: EnrichedSnapshotRecord[];
  /**
   * The top-N items by `effectivePriority` (matches the Slack digest's
   * critical-path section). Used to highlight rows in the wide list.
   */
  criticalPath: EnrichedSnapshotRecord[];
}

export interface LoadDepsDataOpts {
  /**
   * Absolute path override; bypasses env + cwd resolution. Points at the
   * `<artifactsDir>` parent (the loader appends `/_deps/` internally).
   */
  artifactsDir?: string;
  /**
   * Project root for the live-graph join. Defaults to cwd. Must be the
   * workspace whose `backlog/` produced the snapshot — otherwise every row
   * surfaces a "missing from live graph" warning.
   */
  workDir?: string;
  /** Top-N for the highlighted critical path. Default 5. */
  limit?: number;
}

const DEFAULT_LIMIT = 5;

/**
 * Resolve the artifacts root. Pure function (no I/O) so tests can assert on
 * the resolution order without touching the filesystem.
 */
export function resolveArtifactsRoot(opts: { artifactsDir?: string } = {}): string {
  if (opts.artifactsDir) return opts.artifactsDir;
  const env = process.env.DEPS_SNAPSHOT_DIR;
  if (env && env.length > 0) return env;
  return join(process.cwd(), 'artifacts');
}

/**
 * Load + enrich the latest snapshot for the dashboard. Returns `null` when
 * no snapshot exists on disk OR the resolved `<artifactsRoot>/_deps/`
 * directory is missing — the page treats either as "no data yet" and renders
 * an operator hint pointing at `cli-deps snapshot`.
 *
 * The enrichment is "best-effort" per RFC-0014 §12 Q6: snapshot rows whose
 * `id` no longer resolves in the live graph are surfaced with `warnings`
 * instead of crashing the render.
 */
export function loadDepsData(opts: LoadDepsDataOpts = {}): DepsDataResult | null {
  const artifactsRoot = resolveArtifactsRoot(opts);
  if (!existsSync(artifactsRoot)) return null;

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const workDir = opts.workDir ?? process.cwd();

  const snapshot = loadLatestSnapshot({ workDir, artifactsDir: artifactsRoot });
  if (!snapshot) return null;

  const enriched = enrichSnapshot(snapshot.records, { workDir });
  // Sort the wide list by the dispatcher comparator so the table reads as
  // "what would be dispatched next, top to bottom". `selectCriticalPath`
  // applies the same ordering but also drops isolated leaves; for the wide
  // view we keep everything (open + completed) and let the operator scan.
  const sorted = [...enriched].sort((a, b) => {
    if (a.effectivePriority !== b.effectivePriority)
      return b.effectivePriority - a.effectivePriority;
    if (a.criticalPathLength !== b.criticalPathLength)
      return b.criticalPathLength - a.criticalPathLength;
    if (a.lastModified !== b.lastModified) return b.lastModified.localeCompare(a.lastModified);
    return a.id.localeCompare(b.id, 'en', { numeric: true });
  });

  // Compute the highlighted critical-path subset using the same selector the
  // Slack digest uses — guarantees the two surfaces never disagree about
  // "what's on the critical path".
  const criticalPath = selectCriticalPath(enriched, { limit });

  return {
    artifactsRoot,
    snapshotPath: snapshot.path,
    snapshotIsoTimestamp: snapshot.isoTimestamp,
    snapshotTag: snapshot.tag,
    totalRecords: snapshot.recordCount,
    skipped: snapshot.skipped,
    enriched: sorted,
    criticalPath,
  };
}

/**
 * Re-export for tests + future consumers that want to drive the same
 * pipeline directly without going through the artifacts-root resolver.
 */
export { buildCriticalPathDigest };
