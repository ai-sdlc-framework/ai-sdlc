/**
 * RFC-0014 Phase 5 — operator dispatch override log.
 *
 * Captures the moments when an operator dispatches a task that ISN'T the
 * dispatcher's top pick — the calibration signal that drives the
 * promotion decision in `docs/operations/deps-composition-promotion.md`.
 *
 * Mirror of `dor/calibration-log.ts` semantically: append-only JSONL,
 * one line per override event, written under
 * `$ARTIFACTS_DIR/_deps/overrides.jsonl`. The `cli-deps-corpus aggregate`
 * tool joins this log with the snapshot corpus to compute
 * `operatorOverrideRate` per RFC-0014 §11 Phase 5 acceptance criteria.
 *
 * **Why a separate file** (vs reusing the snapshot artifact): snapshots
 * record the GRAPH at a point in time (one file per pipeline tick);
 * overrides record OPERATOR DECISIONS over time (one event per dispatch
 * where the human disagreed with the machine). Different cardinality,
 * different lifecycle, different consumers — so different file.
 *
 * **Why not reuse `_dor/calibration.jsonl`**: the DoR calibration log is
 * about gate-level rubric correctness (did the rubric ask the right
 * questions?); the deps overrides log is about dispatcher correctness
 * (did the comparator pick the right next task?). Conflating them would
 * pollute both metrics' aggregators and force a schema union in
 * `cli-dor-corpus` that doesn't help anyone.
 *
 * Pure-function append + load helpers — the CLI surface lives in
 * `cli/deps.ts` (`cli-deps log-override`) and the aggregator lives in
 * `cli/deps-corpus.ts`.
 *
 * @module deps/override-log
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * One JSONL row per operator-dispatch-override event. Schema-versioned
 * via `schemaVersion` so future revisions can extend without breaking
 * the aggregator's permissive parser.
 */
export interface OverrideEntry {
  /** Schema version for forward-compat. v1 is the AISDLC-167.5 shape. */
  schemaVersion: 1;
  /** ISO-8601 timestamp when the override was logged. */
  ts: string;
  /**
   * Path of the snapshot artifact the operator was looking at when they
   * made the override decision. Empty string when the operator dispatched
   * outside a snapshot context (the aggregator skips those for
   * snapshot-vs-override join math but still counts them in the raw total).
   */
  snapshotPath: string;
  /**
   * The id the dispatcher's top-of-frontier pick had (per the active
   * sort mode — composition or baseline). Empty when the snapshot was
   * empty (no frontier).
   */
  dispatcherTopId: string;
  /** The id the operator actually picked. Required. */
  operatorPickedId: string;
  /**
   * Snapshot of the dispatcher's ranking at decision time. Each entry is
   * `{ id, position }` (position is 1-indexed: 1 = top pick). Capped at
   * the first 10 entries to keep the JSONL line tight; the full ranking
   * is rebuildable from the snapshot artifact at `snapshotPath`.
   */
  ranking: Array<{ id: string; position: number }>;
  /** Optional free-text rationale from the operator. */
  reason?: string;
  /**
   * Optional sort mode label — `'composition'` or `'baseline'`. Lets the
   * aggregator distinguish "operator overrode the COMPOSITION dispatcher"
   * from "operator overrode the BASELINE dispatcher" when an override is
   * logged from each path. Defaults to `'composition'` (the path Phase 5
   * is measuring) when absent.
   */
  mode?: 'composition' | 'baseline';
}

export interface AppendOverrideOpts {
  /**
   * Base artifacts directory. Falls back to `process.env.ARTIFACTS_DIR`
   * and finally `./artifacts`. The override log lands at
   * `<artifactsDir>/_deps/overrides.jsonl`.
   */
  artifactsDir?: string;
  /** Override the on-disk file path entirely. Used by tests. */
  filePath?: string;
  /** Override the timestamp. Used by tests for determinism. */
  now?: () => Date;
}

/**
 * Resolve the override log file path: explicit override > `<artifactsDir>/_deps/overrides.jsonl`
 * > `$ARTIFACTS_DIR/_deps/overrides.jsonl` > `./artifacts/_deps/overrides.jsonl`.
 *
 * Mirrors `resolveSnapshotDir` in `snapshot.ts` so the override log lives
 * next to the snapshot files the aggregator joins it against.
 */
export function resolveOverrideLogPath(opts: AppendOverrideOpts = {}): string {
  if (opts.filePath) return opts.filePath;
  const base = opts.artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts');
  return join(base, '_deps', 'overrides.jsonl');
}

/**
 * Append one override entry to the log. Creates the parent directory if
 * needed (mirror of `appendCalibrationEntry`'s tolerance for first writes).
 *
 * The `ranking` array is capped at 10 entries on write so a giant frontier
 * doesn't produce a multi-kilobyte JSONL line; the full ranking is
 * rebuildable from the snapshot artifact at `snapshotPath`.
 *
 * Returns the entry that was actually written so callers can audit /
 * surface to stdout without having to re-read the file.
 */
export function appendOverrideEntry(
  input: Omit<OverrideEntry, 'ts' | 'schemaVersion'> & {
    ts?: string;
    schemaVersion?: 1;
  },
  opts: AppendOverrideOpts = {},
): OverrideEntry {
  const path = resolveOverrideLogPath(opts);
  mkdirSync(dirname(path), { recursive: true });

  const ts = input.ts ?? (opts.now ?? (() => new Date()))().toISOString();
  const ranking = input.ranking.slice(0, 10);

  const entry: OverrideEntry = {
    schemaVersion: 1,
    ts,
    snapshotPath: input.snapshotPath ?? '',
    dispatcherTopId: input.dispatcherTopId ?? '',
    operatorPickedId: input.operatorPickedId,
    ranking,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
  };

  appendFileSync(path, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
  return entry;
}

export interface LoadOverridesResult {
  entries: OverrideEntry[];
  /** Number of malformed lines skipped (forensic / observability). */
  skipped: number;
}

/**
 * Validate that an arbitrary parsed JSONL line is shape-compatible with
 * `OverrideEntry`. Defensive — an artifact downloaded from a stranger's
 * CI run could in principle contain anything, and we'd rather skip a
 * malformed line than poison the override-rate math.
 *
 * Tolerates missing optional fields (`reason`, `mode`) and unknown extra
 * fields (forward-compat with future schema versions).
 */
export function isValidOverrideEntry(raw: unknown): raw is OverrideEntry {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  if (e.schemaVersion !== 1) return false;
  if (typeof e.ts !== 'string') return false;
  if (typeof e.snapshotPath !== 'string') return false;
  if (typeof e.dispatcherTopId !== 'string') return false;
  if (typeof e.operatorPickedId !== 'string' || e.operatorPickedId.length === 0) return false;
  if (!Array.isArray(e.ranking)) return false;
  for (const r of e.ranking) {
    if (!r || typeof r !== 'object') return false;
    const rr = r as Record<string, unknown>;
    if (typeof rr.id !== 'string') return false;
    if (typeof rr.position !== 'number') return false;
  }
  return true;
}

/**
 * Read the override log from disk. Tolerant of missing files (returns
 * empty array) and malformed lines (counted in `skipped`).
 *
 * The CLI front-end and the aggregator both use this — there's no other
 * caller, so the contract is "give me everything that's been logged so
 * far, in order, with malformed entries silently skipped."
 */
export function loadOverrides(opts: AppendOverrideOpts = {}): LoadOverridesResult {
  const path = resolveOverrideLogPath(opts);
  if (!existsSync(path)) return { entries: [], skipped: 0 };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Unreadable — surface as zero entries + zero skipped (the operator
    // can re-run with `--file` to diagnose). We don't throw because
    // surfaced-as-empty is the same operational outcome the aggregator
    // already handles (insufficient-data recommendation).
    return { entries: [], skipped: 0 };
  }

  const entries: OverrideEntry[] = [];
  let skipped = 0;
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (!isValidOverrideEntry(parsed)) {
      skipped += 1;
      continue;
    }
    entries.push(parsed);
  }
  return { entries, skipped };
}
