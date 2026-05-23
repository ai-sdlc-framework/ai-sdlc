/**
 * Weekly calibration digest — RFC-0016 Phase 6 (AISDLC-284).
 *
 * Generates a per-class calibration summary suitable for TUI display and
 * Slack surfacing. Corpus-driven (NOT calendar-gated): call this from any
 * surface that wants a human-readable snapshot of estimate accuracy.
 *
 * ## What the digest reports per class
 *
 *  - `n`                — total calibration records for this class.
 *  - `meanBucketMiss`   — positive = overestimate bias.
 *  - `medianBucketMiss` — robust to outliers.
 *  - `oneBucketMissRate` — fraction of records with |bucketMiss| ≤ 1
 *                          (acceptable noise per §4.2).
 *  - `threeBucketMissRate` — fraction with |bucketMiss| ≥ 3 (systemic
 *                             mismodelling per §4.2).
 *  - `stageACoverageRate` — fraction of estimate log rows that were
 *                            resolved by Stage A alone (no Stage B
 *                            invocation). The key Phase 6 metric per §13.
 *  - `promotionReady`   — whether this class meets the Phase 6 promotion
 *                         criteria (§13 Phase 6 acceptance): 95%+ 1-bucket
 *                         misses AND <5% 3-bucket misses across ≥50
 *                         estimates AND Stage-A-coverage >70%.
 *  - `digestCalibrationState` — 3-state Q6 token: `uncalibrated` /
 *                               `warming` / `calibrated` (per §7.3).
 *
 * ## Stage-A-coverage
 *
 * Stage-A-coverage is computed from `_estimates/log.jsonl` (not from the
 * calibration records): it is the fraction of rows where
 * `stageB.invoked === false` (or `stageB` is absent — Phase 1/2 rows
 * pre-date Stage B). This answers "what % of estimates was Stage A
 * sufficient for?" — the key metric Phase 6 tracks per §13.
 *
 * ## Name disambiguation
 *
 * The `DigestCalibrationState` type in this module is the digest-local
 * 3-state enum. Phase 5's `bias.ts` exports `CalibrationState` with the
 * same values — they are intentionally kept separate to avoid circular
 * import churn; `digest.ts` is the Phase 6 aggregate surface that does NOT
 * re-import from `bias.ts` to avoid cycles.
 *
 * @module estimation/digest
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BUCKET_INDEX, BUCKETS, type TaskClass, TASK_CLASSES } from './types.js';
import type { CalibrationRecord } from './calibration-writer.js';
import type { EstimateLogRecord } from './log-writer.js';

// ── Calibration state token (Q6 §7.3) ────────────────────────────────────

/**
 * 3-state calibration enum used inside the digest module.
 *
 * Named `DigestCalibrationState` to avoid colliding with Phase 5's
 * `CalibrationState` export from `bias.ts` (same values, different module
 * scope).
 */
export type DigestCalibrationState = 'uncalibrated' | 'warming' | 'calibrated';

/**
 * Compute the Q6 calibration state for `n` records in the class.
 *
 *  - `uncalibrated` — n = 0
 *  - `warming`      — 1 ≤ n < 5
 *  - `calibrated`   — n ≥ 5
 */
export function digestCalibrationState(n: number): DigestCalibrationState {
  if (n === 0) return 'uncalibrated';
  if (n < 5) return 'warming';
  return 'calibrated';
}

/**
 * Format the Q6 state token string for CLI / Slack / TUI surfaces.
 *
 * Examples:
 *  - `(uncalibrated)`
 *  - `(warming, n=3)`
 *  - `(calibrated, n=23, bias=+15%)`
 *  - `(calibrated, n=23, bias=+15%; high-variance)`
 */
export function formatCalibrationStateToken(opts: {
  state: DigestCalibrationState;
  n: number;
  meanMiss?: number;
  highVariance?: boolean;
}): string {
  const { state, n, meanMiss, highVariance } = opts;
  let token: string;
  switch (state) {
    case 'uncalibrated':
      token = 'uncalibrated';
      break;
    case 'warming':
      token = `warming, n=${n}`;
      break;
    case 'calibrated': {
      const biasStr =
        meanMiss !== undefined
          ? `bias=${meanMiss >= 0 ? '+' : ''}${Math.round(meanMiss * 100)}%`
          : '';
      token = [`calibrated, n=${n}`, biasStr].filter(Boolean).join(', ');
      break;
    }
  }
  if (highVariance) {
    token += '; high-variance';
  }
  return `(${token})`;
}

// ── Digest types ─────────────────────────────────────────────────────────

/** Per-class digest row. */
export interface ClassDigestRow {
  taskClass: TaskClass;
  n: number;
  meanBucketMiss: number;
  medianBucketMiss: number;
  /** Fraction of records with |bucketMiss| ≤ 1 (0-1). */
  oneBucketMissRate: number;
  /** Fraction of records with |bucketMiss| ≥ 3 (0-1). */
  threeBucketMissRate: number;
  /** Fraction of estimate log rows with Stage B NOT invoked (0-1). */
  stageACoverageRate: number;
  /** Total estimate log rows for this class (denominator for stageACoverageRate). */
  logRows: number;
  digestCalibrationState: DigestCalibrationState;
  /**
   * Whether this class meets the Phase 6 promotion criteria:
   *  - oneBucketMissRate ≥ 0.95
   *  - threeBucketMissRate < 0.05
   *  - n ≥ 50
   *  - stageACoverageRate > 0.70
   */
  promotionReady: boolean;
}

export interface CalibrationDigest {
  generatedAt: string;
  classes: ClassDigestRow[];
  /**
   * Overall Stage-A-coverage across all classes (fraction of all log
   * rows where Stage B was NOT invoked).
   */
  overallStageACoverageRate: number;
  /** Total calibration records across all classes. */
  totalCalibrationRecords: number;
  /** Count of classes that meet the promotion criteria. */
  promotionReadyCount: number;
}

export interface GenerateDigestOpts {
  artifactsDir?: string;
  now?: () => Date;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Generate the weekly calibration digest. Reads from:
 *  - `_estimates/calibration-YYYY-MM.jsonl` files (calibration records)
 *  - `_estimates/log.jsonl` (Stage-A-coverage denominator)
 *
 * Returns a structured `CalibrationDigest` suitable for JSON output,
 * TUI rendering, or Slack formatting.
 */
export function generateDigest(opts: GenerateDigestOpts = {}): CalibrationDigest {
  const artifactsDir = resolveArtifactsDir(opts.artifactsDir);
  const now = opts.now ?? ((): Date => new Date());
  const generatedAt = now().toISOString();

  const logRows = readLogRows(artifactsDir);

  const classes: ClassDigestRow[] = [];
  let totalCalibrationRecords = 0;

  for (const taskClass of TASK_CLASSES) {
    if (taskClass === 'uncategorized') continue;
    const records = readCalibrationRecordsForClass(artifactsDir, taskClass);
    const classLogRows = logRows.filter((r) => r.class === taskClass);
    const row = buildClassRow(taskClass, records, classLogRows);
    classes.push(row);
    totalCalibrationRecords += records.length;
  }

  // Overall Stage-A-coverage across all non-uncategorized classes.
  const allLogRows = logRows.filter((r) => r.class !== 'uncategorized');
  const stageBNotInvoked = allLogRows.filter((r) => !r.stageB?.invoked).length;
  const overallStageACoverageRate =
    allLogRows.length > 0 ? stageBNotInvoked / allLogRows.length : 0;

  const promotionReadyCount = classes.filter((c) => c.promotionReady).length;

  return {
    generatedAt,
    classes,
    overallStageACoverageRate,
    totalCalibrationRecords,
    promotionReadyCount,
  };
}

/**
 * Format the digest as a human-readable text summary (for TUI / Slack).
 */
export function formatDigestText(digest: CalibrationDigest): string {
  const lines: string[] = [];
  lines.push(`Estimation Calibration Digest — ${digest.generatedAt.slice(0, 10)}`);
  lines.push('='.repeat(55));
  lines.push('');

  for (const row of digest.classes) {
    const stateToken = formatCalibrationStateToken({
      state: row.digestCalibrationState,
      n: row.n,
      meanMiss: row.n > 0 ? row.meanBucketMiss : undefined,
    });
    lines.push(`Class: ${row.taskClass}  ${stateToken}`);
    if (row.n === 0) {
      lines.push('  No calibration data yet.');
    } else {
      const meanSign = row.meanBucketMiss >= 0 ? '+' : '';
      lines.push(`  Records:       ${row.n}`);
      lines.push(`  Mean miss:     ${meanSign}${row.meanBucketMiss.toFixed(2)} buckets`);
      lines.push(
        `  Median miss:   ${row.medianBucketMiss >= 0 ? '+' : ''}${row.medianBucketMiss} buckets`,
      );
      lines.push(`  ≤1-bucket %:   ${pct(row.oneBucketMissRate)}  (target: ≥95%)`);
      lines.push(`  ≥3-bucket %:   ${pct(row.threeBucketMissRate)}  (target: <5%)`);
    }
    lines.push(
      `  Stage-A cov.:  ${pct(row.stageACoverageRate)} of ${row.logRows} estimates  (target: >70%)`,
    );
    lines.push(`  Promote ready: ${row.promotionReady ? 'YES' : 'no'}`);
    lines.push('');
  }

  lines.push('-'.repeat(55));
  lines.push(`Overall Stage-A coverage: ${pct(digest.overallStageACoverageRate)}`);
  lines.push(`Total calibration records: ${digest.totalCalibrationRecords}`);
  lines.push(`Promotion-ready classes: ${digest.promotionReadyCount} / ${digest.classes.length}`);

  return lines.join('\n') + '\n';
}

// ── Internals ─────────────────────────────────────────────────────────────

function resolveArtifactsDir(explicit: string | undefined): string {
  return explicit ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts');
}

function buildClassRow(
  taskClass: TaskClass,
  records: CalibrationRecord[],
  classLogRows: EstimateLogRecord[],
): ClassDigestRow {
  const n = records.length;
  const state = digestCalibrationState(n);

  let meanBucketMiss = 0;
  let medianBucketMiss = 0;
  let oneBucketMissRate = 0;
  let threeBucketMissRate = 0;

  if (n > 0) {
    meanBucketMiss = records.reduce((s, r) => s + r.bucketMiss, 0) / n;
    const sorted = [...records].map((r) => r.bucketMiss).sort((a, b) => a - b);
    medianBucketMiss = sorted[Math.floor(sorted.length / 2)]!;
    oneBucketMissRate = records.filter((r) => Math.abs(r.bucketMiss) <= 1).length / n;
    threeBucketMissRate = records.filter((r) => Math.abs(r.bucketMiss) >= 3).length / n;
  }

  const logRowCount = classLogRows.length;
  const stageBNotInvoked = classLogRows.filter((r) => !r.stageB?.invoked).length;
  const stageACoverageRate = logRowCount > 0 ? stageBNotInvoked / logRowCount : 0;

  const promotionReady =
    n >= 50 && oneBucketMissRate >= 0.95 && threeBucketMissRate < 0.05 && stageACoverageRate > 0.7;

  return {
    taskClass,
    n,
    meanBucketMiss,
    medianBucketMiss,
    oneBucketMissRate,
    threeBucketMissRate,
    stageACoverageRate,
    logRows: logRowCount,
    digestCalibrationState: state,
    promotionReady,
  };
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function readCalibrationRecordsForClass(
  artifactsDir: string,
  taskClass: TaskClass,
): CalibrationRecord[] {
  const estimatesDir = join(artifactsDir, '_estimates');
  if (!existsSync(estimatesDir)) return [];
  let files: string[];
  try {
    files = readdirSync(estimatesDir)
      .filter((f) => /^calibration-\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .map((f) => join(estimatesDir, f));
  } catch {
    return [];
  }
  const records: CalibrationRecord[] = [];
  for (const filePath of files) {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as CalibrationRecord;
        if (
          r &&
          typeof r === 'object' &&
          r.class === taskClass &&
          typeof r.bucketMiss === 'number'
        ) {
          records.push(r);
        }
      } catch {
        // skip malformed
      }
    }
  }
  return records;
}

function readLogRows(artifactsDir: string): EstimateLogRecord[] {
  const logPath = join(artifactsDir, '_estimates', 'log.jsonl');
  if (!existsSync(logPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  const rows: EstimateLogRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as EstimateLogRecord;
      if (r && typeof r === 'object' && typeof r.taskId === 'string') {
        rows.push(r);
      }
    } catch {
      // skip malformed
    }
  }
  return rows;
}

// ── Stage-A-coverage standalone query ────────────────────────────────────

export interface StageACoverageResult {
  /** Fraction of estimate log rows where Stage B was NOT invoked (0-1). */
  coverageRate: number;
  /** Total estimate log rows counted. */
  totalLogRows: number;
  /** Count of rows where Stage B was NOT invoked. */
  stageAOnlyRows: number;
}

/**
 * Query Stage-A-coverage for a specific class or for all classes.
 *
 * Stage-A-coverage = fraction of log rows where the Stage A result was
 * sufficient (no Stage B invocation). Per §13 Phase 6, this must
 * exceed 70% for promotion readiness.
 */
export function queryStageACoverage(opts: {
  taskClass?: TaskClass;
  artifactsDir?: string;
}): StageACoverageResult {
  const artifactsDir = resolveArtifactsDir(opts.artifactsDir);
  const allRows = readLogRows(artifactsDir);
  const filtered = opts.taskClass
    ? allRows.filter((r) => r.class === opts.taskClass)
    : allRows.filter((r) => r.class !== 'uncategorized');

  const stageAOnlyRows = filtered.filter((r) => !r.stageB?.invoked).length;
  const totalLogRows = filtered.length;
  const coverageRate = totalLogRows > 0 ? stageAOnlyRows / totalLogRows : 0;

  return { coverageRate, totalLogRows, stageAOnlyRows };
}

// ── Median helper (exported for tests) ───────────────────────────────────

export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Map a bucket label to a numeric index for median computation.
 * Reexported from types to avoid double-import in digest consumers.
 */
export { BUCKET_INDEX, BUCKETS };
