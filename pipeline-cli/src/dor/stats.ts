/**
 * DoR calibration log aggregation (RFC-0011 §5.5 + §8 + Phase 5).
 *
 * Reads the JSONL calibration log written by `appendCalibrationEntry()`
 * and produces per-author / per-gate breakdowns for the operator CLI
 * (`cli-dor-stats`) and the weekly Slack digest.
 *
 * Aggregation is intentionally pure — file I/O happens in `loadEntries()`,
 * the `aggregateByAuthor()` / `aggregateByGate()` helpers operate on the
 * already-parsed entry array so tests can assert bucket counts without
 * touching the filesystem.
 *
 * Per-gate aggregation is NOT mutually exclusive: an entry with
 * failedGates [2, 5] increments BOTH the gate-2 AND gate-5 buckets. This
 * matches the way operators read the digest — "which gates are failing
 * most often?" — rather than the way verdicts are grouped — "which gate
 * was the deciding one?".
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolveCalibrationLogPath, type CalibrationEntry } from './calibration-log.js';

/**
 * Per-bucket counts. `nc` = needs-clarification (the verdict bucket);
 * `override` = a maintainer-applied override row (RFC §7.4). The three
 * are mutually exclusive at the per-entry level — an entry contributes
 * to exactly ONE of `admit` / `nc` / `override` based on its `outcome`
 * field (or `overallVerdict` when `outcome` is the empty string for
 * live runs).
 */
export interface StatsBucket {
  admit: number;
  nc: number;
  override: number;
  total: number;
}

export interface AggregateOpts {
  /** Only include entries with `ts >= since` (ISO-8601 string). */
  since?: string;
  /** Only include entries with `ts <= until` (ISO-8601 string). */
  until?: string;
}

/**
 * Read the calibration log file and parse each line as a CalibrationEntry.
 * Malformed lines are silently skipped (the log is append-only and may
 * include partial writes from killed processes; one bad line should not
 * sink the whole digest).
 *
 * Returns an empty array when the file doesn't exist — a fresh project
 * with no DoR runs yet should produce a zero-state digest, not throw.
 */
export function loadEntries(filePath?: string): CalibrationEntry[] {
  const path = filePath ?? resolveCalibrationLogPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const out: CalibrationEntry[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as CalibrationEntry);
    } catch {
      // Skip malformed lines — append-only log can have partial writes
      // from killed processes. The digest reports on what parsed.
      continue;
    }
  }
  return out;
}

/**
 * Filter entries by a `[since, until]` ISO-8601 window. Both bounds are
 * inclusive and optional. Used by both the CLI and the Slack digest.
 */
export function filterByWindow(
  entries: CalibrationEntry[],
  opts: AggregateOpts = {},
): CalibrationEntry[] {
  const since = opts.since ? Date.parse(opts.since) : Number.NEGATIVE_INFINITY;
  const until = opts.until ? Date.parse(opts.until) : Number.POSITIVE_INFINITY;
  return entries.filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= since && t <= until;
  });
}

function emptyBucket(): StatsBucket {
  return { admit: 0, nc: 0, override: 0, total: 0 };
}

/**
 * Increment a bucket based on an entry's outcome. Override rows count
 * separately from the verdict rows — an override that flips a
 * needs-clarification verdict into a ship-decision is logged as
 * `outcome: 'override'`, NOT as a second `admit` row.
 *
 * For live verdict rows where `outcome` is the empty string (the typical
 * case), we fall back to `overallVerdict` so the bucket is still
 * meaningful.
 */
function tally(bucket: StatsBucket, entry: CalibrationEntry): void {
  bucket.total += 1;
  if (entry.outcome === 'override') {
    bucket.override += 1;
    return;
  }
  const verdict = entry.outcome === '' ? entry.overallVerdict : entry.outcome;
  if (verdict === 'admit') bucket.admit += 1;
  else if (verdict === 'needs-clarification') bucket.nc += 1;
}

export interface GroupedStats {
  /** Group key → bucket counts. `(unknown)` is used for missing author. */
  groups: Record<string, StatsBucket>;
  /** Total across all groups (for global pass-rate calculations). */
  totals: StatsBucket;
}

/**
 * Group entries by `author`. Entries without an author land in the
 * `(unknown)` bucket so operators can see how much coverage is missing.
 */
export function aggregateByAuthor(entries: CalibrationEntry[]): GroupedStats {
  const groups: Record<string, StatsBucket> = {};
  const totals = emptyBucket();
  for (const e of entries) {
    const key = e.author && e.author.trim().length > 0 ? e.author : '(unknown)';
    if (!groups[key]) groups[key] = emptyBucket();
    tally(groups[key]!, e);
    tally(totals, e);
  }
  return { groups, totals };
}

/**
 * Group entries by failed gate ID. An entry with failedGates [2, 5]
 * contributes to BOTH gate-2 and gate-5 buckets — gates are not mutually
 * exclusive at the per-issue level. Entries with no failed gates (clean
 * admits) land in the `(none)` bucket so the operator can see the
 * pass-through baseline.
 */
export function aggregateByGate(entries: CalibrationEntry[]): GroupedStats {
  const groups: Record<string, StatsBucket> = {};
  const totals = emptyBucket();
  for (const e of entries) {
    if (e.failedGates.length === 0) {
      const key = '(none)';
      if (!groups[key]) groups[key] = emptyBucket();
      tally(groups[key]!, e);
    } else {
      for (const gateId of e.failedGates) {
        const key = `gate-${gateId}`;
        if (!groups[key]) groups[key] = emptyBucket();
        tally(groups[key]!, e);
      }
    }
    tally(totals, e);
  }
  return { groups, totals };
}

/**
 * Compute the pass rate (admit / (admit + nc)) — overrides intentionally
 * excluded so the rate reflects the rubric's behavior, not the
 * maintainer's escape-hatch usage. Returns 0 when there are no
 * verdict-bearing rows (degenerate empty-window case).
 */
export function passRate(b: StatsBucket): number {
  const denom = b.admit + b.nc;
  return denom === 0 ? 0 : b.admit / denom;
}

/**
 * Override rate (override / total) — share of all calibration entries
 * that are maintainer overrides. Phase 7 soak watches this to decide
 * when warn-only → enforce promotion is safe.
 */
export function overrideRate(b: StatsBucket): number {
  return b.total === 0 ? 0 : b.override / b.total;
}
