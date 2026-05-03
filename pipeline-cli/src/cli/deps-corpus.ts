/**
 * `cli-deps-corpus` — aggregate downloaded dependency-graph snapshot
 * artifacts + the operator override log into a dispatch-quality report
 * that drives the AISDLC-167.5 / RFC-0014 §11 Phase 5 promotion decision.
 *
 * Sister CLI to `cli-dor-corpus` (AISDLC-161). The two share aesthetic
 * conventions (find-files-recursively, recommendation envelope, JSON-or-
 * table output) but answer different questions:
 *
 *   - `cli-dor-corpus`   → "is the DoR rubric ready for `enforce` mode?"
 *                          (per-gate FP-rate against the calibration corpus)
 *   - `cli-deps-corpus`  → "is the dependency-graph composition layer
 *                          ready for default-on?" (dispatch agreement +
 *                          operator override rate against the snapshot
 *                          corpus + override log)
 *
 * Per RFC-0014 §11 Phase 5 acceptance criteria (corpus-driven, NOT
 * calendar-gated per maintainer directive 2026-05-01):
 *
 *   - Dispatch correctness > 95% AND
 *   - No operator override-rate spike vs PPA-only baseline
 *
 * Whichever comes first. Calendar duration is a side-effect, not a gate.
 *
 * Hybrid promotion model (mirrors AISDLC-161 / RFC-0011 §10):
 *   - `recommendation: 'safe-to-promote'`  → operator can flip the
 *     `AI_SDLC_DEPS_COMPOSITION` default OFF → ON (single PR, runbook
 *     in `docs/operations/deps-composition-promotion.md`).
 *   - `recommendation: 'continue-soak'`     → keep gathering data; the
 *     `reason` field names the failing metric.
 *   - `recommendation: 'insufficient-data'` → use the operator-override
 *     spot-check path described in the runbook (corpus too sparse for
 *     statistical confidence).
 *
 * **Signal sources:**
 *
 *   1. Snapshot artifacts — `$ARTIFACTS_DIR/_deps/snapshot.*.jsonl` (one
 *      JSONL per task per snapshot). The aggregator reconstructs the
 *      dispatch order under both modes (composition vs baseline) using
 *      ONLY snapshot-resident fields (`criticalPathLength`, `dependents`,
 *      `id`, `lastModified`). This is a **proxy** for the full
 *      `effectivePriority` ranking (which needs the per-task `priority:`
 *      from frontmatter — not in the snapshot). The proxy is conservative:
 *      a snapshot-mode disagreement implies a likely real-mode
 *      disagreement (chain depth dominates the composition sort), and
 *      snapshot-mode agreement implies real-mode is also likely to agree.
 *
 *   2. Operator override log — `$ARTIFACTS_DIR/_deps/overrides.jsonl`
 *      (one JSONL per dispatch where the operator picked something OTHER
 *      than the dispatcher's top-of-frontier). This is the **ground-truth**
 *      signal per RFC §11 Phase 5 ("no operator override-rate spike").
 *
 * **Why a proxy** (vs walking `backlog/` to get real priorities):
 *   - Snapshots are designed as a STABLE record consumers can diff over
 *     time. Walking the live `backlog/` tree at aggregate time would mix
 *     two epochs (snapshot epoch + walk epoch), poisoning the per-snapshot
 *     comparison.
 *   - The operator override rate is the math-rigorous signal anyway —
 *     dispatch agreement is a secondary "is the proxy noisy?" check.
 *
 * Usage:
 *   $ gh run download --pattern '*-deps-snapshots' --dir ./downloaded
 *   $ cli-deps-corpus aggregate ./downloaded
 *   $ cli-deps-corpus aggregate ./downloaded --overrides-file ./downloaded/overrides.jsonl --format table
 *
 * Output is JSON on stdout; `--format table` renders an ASCII summary
 * for eyeballing.
 *
 * @module cli/deps-corpus
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadOverrides, type OverrideEntry } from '../deps/override-log.js';
import type { SnapshotRecord } from '../deps/snapshot.js';

// Re-export so dashboards / tests can import the snapshot record + override
// shapes alongside the aggregator without a second import path.
export type { SnapshotRecord, OverrideEntry };

/**
 * Default minimum snapshot count for the `safe-to-promote` recommendation.
 * Below this, we return `insufficient-data` regardless of the agreement
 * rate (a 100% agreement over 3 snapshots is meaningless). 30 is the
 * operator default per the AISDLC-167.5 task brief; tunable via
 * `--min-snapshots`.
 */
const DEFAULT_MIN_SNAPSHOTS = 30;

/**
 * Default dispatch-correctness floor per RFC-0014 §11 Phase 5
 * ("dispatch correctness > 95%"). Tunable via `--correctness-threshold`.
 */
const DEFAULT_CORRECTNESS_THRESHOLD = 0.95;

/**
 * Default operator override-rate ceiling. RFC §11 Phase 5 calls for "no
 * operator override-rate spike vs PPA-only baseline" — we operationalise
 * "no spike" as "override rate < 10%" by default (a higher rate means
 * the operator is routinely picking something other than the
 * dispatcher's top, which means the composition isn't matching operator
 * intuition — and `default-on` would just shift that friction onto every
 * dispatch). Tunable via `--override-threshold`.
 */
const DEFAULT_OVERRIDE_THRESHOLD = 0.1;

export type Recommendation = 'insufficient-data' | 'safe-to-promote' | 'continue-soak';

export interface PerSnapshotComparison {
  /** Absolute path of the snapshot file (or basename when too long). */
  path: string;
  /** ISO timestamp embedded in the snapshot filename. */
  isoTimestamp: string;
  /** Number of records in the snapshot. */
  recordCount: number;
  /** Top pick under PPA-only baseline (id-ASC sort). Empty when snapshot has no records. */
  baselineTopId: string;
  /** Top pick under composition-mode sort (CPL DESC → recency DESC → id ASC). */
  compositionTopId: string;
  /** True when both modes agree on the top pick. */
  agree: boolean;
}

export interface OverrideStats {
  /** Total override entries in the join scope. */
  total: number;
  /**
   * Override entries scoped to the corpus's snapshot set (matched by
   * `snapshotPath` against the corpus's snapshot paths). When zero, the
   * override-rate metric falls back to `total / snapshotCount`.
   */
  matchedToCorpus: number;
  /**
   * Override rate vs snapshot count. `matchedToCorpus / snapshotCount`
   * when matchedToCorpus > 0; else `total / snapshotCount`. When
   * `snapshotCount == 0` the rate is 0.
   */
  rate: number;
  /**
   * Distinct operator-picked ids — useful forensic context (an operator
   * picking the same alternate task 50 times in a row is a different
   * problem than 50 different operators each picking once).
   */
  distinctPickedIds: number;
}

export interface AggregateReport {
  /** Total snapshots in the corpus (post-skip). */
  snapshotCount: number;
  /** Number of snapshot files we attempted to read. */
  filesRead: number;
  /** Number of snapshot files we couldn't parse (forensic). */
  skippedFiles: number;
  /** Number of malformed JSONL lines skipped across all files. */
  skippedLines: number;
  /** Per-snapshot agreement rate (composition top-pick == baseline top-pick). */
  dispatchAgreementRate: number;
  /** Operator override stats (joined from `overrides.jsonl`). */
  overrides: OverrideStats;
  /** Operator-facing recommendation. Drives the AISDLC-167.5 promotion decision. */
  recommendation: Recommendation;
  /** Human-readable rationale for the recommendation (operator log line). */
  reason: string;
}

export interface CorpusReport {
  perSnapshot: PerSnapshotComparison[];
  aggregate: AggregateReport;
}

export interface AggregateOpts {
  /** Below this snapshotCount, recommendation is forced to `insufficient-data`. */
  minSnapshots?: number;
  /** Dispatch-correctness floor for `safe-to-promote`. */
  correctnessThreshold?: number;
  /** Operator override-rate ceiling for `safe-to-promote`. */
  overrideThreshold?: number;
  /**
   * Override entries to join against the snapshot corpus. When omitted
   * the aggregator skips the override join (and the recommendation can
   * still gate on `dispatchAgreementRate`).
   */
  overrides?: OverrideEntry[];
}

/**
 * Recursively walk a directory and return every snapshot file. The
 * `gh run download` layout drops one subdirectory per workflow artifact,
 * so a single `--input ./downloaded` resolves to N JSONL files without
 * the operator having to glob manually.
 *
 * Single-file inputs are also supported — a path that is itself a JSONL
 * file is returned as a single-element array.
 *
 * Naming filter: `snapshot.*.jsonl` matches the canonical writer's
 * filenames; loose `*.jsonl` is also accepted to keep the contract
 * permissive (an operator might rename when downloading).
 */
export function findSnapshotFiles(rootPath: string): string[] {
  const out: string[] = [];
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let s;
    try {
      s = statSync(current);
    } catch {
      continue;
    }
    if (s.isFile()) {
      // Filter by the snapshot naming convention so we don't accidentally
      // ingest the override log if the operator drops it in the same dir.
      if (current.endsWith('.jsonl') && !current.endsWith('overrides.jsonl')) out.push(current);
      continue;
    }
    if (!s.isDirectory()) continue;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const e of entries) stack.push(join(current, e));
  }
  return out.sort();
}

/**
 * Validate that an arbitrary parsed JSONL line is shape-compatible with
 * `SnapshotRecord`. Structural duck-typing on the fields the aggregator
 * actually consumes — extra fields are fine, missing fields aren't.
 *
 * Mirrors the pattern in `cli-dor-corpus#isValidEntry` so the two
 * aggregators have parallel skip-vs-poison semantics.
 */
export function isValidSnapshotRecord(raw: unknown): raw is SnapshotRecord {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id.length === 0) return false;
  if (!Array.isArray(e.dependencies)) return false;
  if (!e.dependencies.every((d) => typeof d === 'string')) return false;
  if (!Array.isArray(e.dependents)) return false;
  if (!e.dependents.every((d) => typeof d === 'string')) return false;
  if (typeof e.criticalPathLength !== 'number') return false;
  if (typeof e.depth !== 'number') return false;
  if (typeof e.lastModified !== 'string') return false;
  return true;
}

export interface LoadedSnapshot {
  path: string;
  records: SnapshotRecord[];
  isoTimestamp: string;
}

/**
 * Load + parse every snapshot file from a list. Malformed lines are
 * silently skipped (counted), files that fail to parse entirely are
 * reported via `skippedFiles`. The result is `(snapshots, skippedLines,
 * skippedFiles)` so the aggregator can surface forensic context.
 */
export function loadSnapshotCorpus(files: string[]): {
  snapshots: LoadedSnapshot[];
  skippedFiles: number;
  skippedLines: number;
} {
  const snapshots: LoadedSnapshot[] = [];
  let skippedFiles = 0;
  let skippedLines = 0;

  for (const f of files) {
    let raw: string;
    try {
      raw = readFileSync(f, 'utf8');
    } catch {
      skippedFiles += 1;
      continue;
    }

    const records: SnapshotRecord[] = [];
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      // Empty file — count as a skipped file (no signal). The CLI doesn't
      // distinguish empty-file from unreadable-file in operator output;
      // both surface as "the corpus had a file we couldn't use."
      skippedFiles += 1;
      continue;
    }
    let allMalformed = true;
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skippedLines += 1;
        continue;
      }
      if (!isValidSnapshotRecord(parsed)) {
        skippedLines += 1;
        continue;
      }
      records.push(parsed);
      allMalformed = false;
    }
    if (allMalformed) {
      skippedFiles += 1;
      continue;
    }

    snapshots.push({
      path: f,
      records,
      isoTimestamp: extractIsoTimestamp(f),
    });
  }

  // Sort by embedded timestamp ascending so the per-snapshot rows render
  // in calendar order — easier for an operator to scan a regression.
  snapshots.sort((a, b) => a.isoTimestamp.localeCompare(b.isoTimestamp));
  return { snapshots, skippedFiles, skippedLines };
}

/**
 * Derive the dispatcher's top pick under both modes from a single
 * snapshot's records. Returns ids only — the comparison is "did both
 * modes agree on the FIRST task to dispatch?" not "did the rest of the
 * ranking match" (the operator only ever dispatches the top pick on a
 * given tick).
 *
 * **Caveat — proxy semantics**: snapshots don't carry the per-task
 * `priority:` field, so we can't reconstruct full `effectivePriority`
 * here. We approximate composition mode using the snapshot-resident
 * structural signal (`criticalPathLength`) + the same secondary tiebreaks
 * the real dispatcher uses (`lastModified DESC → id ASC`). This is
 * conservative: a real composition mode that incorporates priority would
 * produce AT MOST the same agreement rate (priority can only further
 * reorder ties), so a `safe-to-promote` recommendation here implies
 * safe-to-promote in the real dispatcher.
 *
 * Empty-snapshot semantics: returns empty strings for both top-pick ids
 * + `agree: true` (vacuously — no work to disagree on).
 */
export function compareTopPicks(records: SnapshotRecord[]): {
  baselineTopId: string;
  compositionTopId: string;
  agree: boolean;
} {
  if (records.length === 0) {
    return { baselineTopId: '', compositionTopId: '', agree: true };
  }

  // Approximate "frontier" as records whose `dependencies` field is
  // empty — i.e. no remaining upstream work in this snapshot. This is a
  // structural proxy that doesn't require status info: a record listed
  // as having dependencies still carries those refs in the snapshot
  // (`buildDependencyGraph` doesn't strip completed-deps from open
  // tasks); so empty-deps is the closest readily-available signal for
  // "ready to dispatch right now."
  const ready = records.filter((r) => r.dependencies.length === 0);
  const candidates = ready.length > 0 ? ready : records;

  // Baseline: id-ASC (matches `frontier()`'s native order).
  const baseline = candidates
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

  // Composition (proxy): criticalPathLength DESC → lastModified DESC →
  // id ASC. Mirrors `compareForDispatch` in `dispatch.ts` minus the
  // priority signal which isn't in the snapshot.
  const composition = candidates.slice().sort((a, b) => {
    if (a.criticalPathLength !== b.criticalPathLength) {
      return b.criticalPathLength - a.criticalPathLength;
    }
    if (a.lastModified !== b.lastModified) {
      return b.lastModified.localeCompare(a.lastModified);
    }
    return a.id.localeCompare(b.id, 'en', { numeric: true });
  });

  const baselineTopId = baseline[0]!.id;
  const compositionTopId = composition[0]!.id;
  return {
    baselineTopId,
    compositionTopId,
    agree: baselineTopId === compositionTopId,
  };
}

/**
 * Compute the dispatch-quality + override-rate report from a corpus of
 * snapshots and an optional override log.
 *
 * Pure function — no I/O — so tests can pass synthetic snapshot arrays
 * and snapshot the output. The CLI front-end is a thin shell around
 * `loadSnapshotCorpus()` + `loadOverrides()` + this function + a renderer.
 *
 * Recommendation gating:
 *   - `snapshotCount < minSnapshots`           → 'insufficient-data'
 *   - `dispatchAgreementRate < correctnessThreshold` → 'continue-soak'
 *   - `overrides.rate >= overrideThreshold`     → 'continue-soak'
 *   - else                                      → 'safe-to-promote'
 *
 * The reason string is shaped so an operator can paste it into the
 * promotion PR body unchanged.
 */
export function aggregateDispatchCorpus(
  snapshots: LoadedSnapshot[],
  opts: AggregateOpts = {},
  meta: { skippedFiles?: number; skippedLines?: number; filesRead?: number } = {},
): CorpusReport {
  const minSnapshots = opts.minSnapshots ?? DEFAULT_MIN_SNAPSHOTS;
  const correctnessThreshold = opts.correctnessThreshold ?? DEFAULT_CORRECTNESS_THRESHOLD;
  const overrideThreshold = opts.overrideThreshold ?? DEFAULT_OVERRIDE_THRESHOLD;

  const perSnapshot: PerSnapshotComparison[] = snapshots.map((s) => {
    const cmp = compareTopPicks(s.records);
    return {
      path: s.path,
      isoTimestamp: s.isoTimestamp,
      recordCount: s.records.length,
      baselineTopId: cmp.baselineTopId,
      compositionTopId: cmp.compositionTopId,
      agree: cmp.agree,
    };
  });

  const snapshotCount = perSnapshot.length;
  const agreed = perSnapshot.filter((p) => p.agree).length;
  const dispatchAgreementRate = snapshotCount === 0 ? 0 : agreed / snapshotCount;

  const overrideEntries = opts.overrides ?? [];
  const corpusPaths = new Set(snapshots.map((s) => s.path));
  const matchedToCorpus = overrideEntries.filter((o) => corpusPaths.has(o.snapshotPath)).length;
  const distinctPickedIds = new Set(overrideEntries.map((o) => o.operatorPickedId)).size;
  const overrideRate =
    snapshotCount === 0
      ? 0
      : matchedToCorpus > 0
        ? matchedToCorpus / snapshotCount
        : overrideEntries.length / snapshotCount;
  const overrides: OverrideStats = {
    total: overrideEntries.length,
    matchedToCorpus,
    rate: overrideRate,
    distinctPickedIds,
  };

  let recommendation: Recommendation;
  let reason: string;
  if (snapshotCount < minSnapshots) {
    recommendation = 'insufficient-data';
    reason = `snapshotCount=${snapshotCount} below minSnapshots=${minSnapshots} — operator may use the spot-check promotion path (see docs/operations/deps-composition-promotion.md)`;
  } else if (dispatchAgreementRate < correctnessThreshold) {
    recommendation = 'continue-soak';
    reason = `dispatchAgreementRate=${(dispatchAgreementRate * 100).toFixed(1)}% below correctnessThreshold=${(correctnessThreshold * 100).toFixed(1)}% — composition diverges from baseline more than expected`;
  } else if (overrides.rate >= overrideThreshold) {
    recommendation = 'continue-soak';
    reason = `operator override rate=${(overrides.rate * 100).toFixed(1)}% exceeds threshold=${(overrideThreshold * 100).toFixed(1)}% — operators are routinely picking past the dispatcher's top`;
  } else {
    recommendation = 'safe-to-promote';
    reason = `snapshotCount=${snapshotCount} ≥ ${minSnapshots}, dispatchAgreementRate=${(dispatchAgreementRate * 100).toFixed(1)}% ≥ ${(correctnessThreshold * 100).toFixed(1)}%, override rate=${(overrides.rate * 100).toFixed(1)}% < ${(overrideThreshold * 100).toFixed(1)}% — flip AI_SDLC_DEPS_COMPOSITION default OFF → ON`;
  }

  return {
    perSnapshot,
    aggregate: {
      snapshotCount,
      filesRead: meta.filesRead ?? snapshots.length,
      skippedFiles: meta.skippedFiles ?? 0,
      skippedLines: meta.skippedLines ?? 0,
      dispatchAgreementRate,
      overrides,
      recommendation,
      reason,
    },
  };
}

/**
 * Pull the ISO-style timestamp back out of a snapshot filename. Mirrors
 * the helper in `snapshot.ts`. Returns the basename on parse failure so
 * the per-snapshot row still has a stable identifier.
 */
function extractIsoTimestamp(file: string): string {
  const base = file.split('/').pop() ?? file;
  const stripped = base.replace(/^snapshot\./, '').replace(/\.[a-z-]+\.jsonl$/, '');
  return stripped.length > 0 ? stripped : base;
}

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

/**
 * Render an ASCII table for the per-snapshot breakdown — same conventions
 * as `cli-dor-corpus` so the operator's eye doesn't have to retrain.
 */
function renderTable(report: CorpusReport): string {
  const headers = ['snapshot', 'records', 'baseline-top', 'composition-top', 'agree'];
  const rows = report.perSnapshot.map((p) => [
    p.isoTimestamp,
    String(p.recordCount),
    p.baselineTopId || '(empty)',
    p.compositionTopId || '(empty)',
    p.agree ? 'yes' : 'NO',
  ]);
  if (rows.length === 0) rows.push(['(none)', '0', '-', '-', '-']);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const tbl = [fmt(headers), sep, ...rows.map(fmt)].join('\n');
  const a = report.aggregate;
  const summary =
    `\nCorpus: snapshots=${a.snapshotCount}  files=${a.filesRead}  skippedFiles=${a.skippedFiles}  skippedLines=${a.skippedLines}` +
    `\nDispatch agreement: ${(a.dispatchAgreementRate * 100).toFixed(1)}%` +
    `\nOperator overrides: total=${a.overrides.total}  matchedToCorpus=${a.overrides.matchedToCorpus}  rate=${(a.overrides.rate * 100).toFixed(1)}%  distinctPickedIds=${a.overrides.distinctPickedIds}` +
    `\nRecommendation: ${a.recommendation}` +
    `\nReason: ${a.reason}\n`;
  return tbl + '\n' + summary;
}

export function buildDepsCorpusCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-deps-corpus')
    .usage('Usage: $0 <command> [options]')
    .command(
      'aggregate <input>',
      'Aggregate one or more downloaded snapshot JSONL files (+ optional override log) into a dispatch-quality + recommendation envelope.',
      (y) =>
        y
          .positional('input', {
            type: 'string',
            demandOption: true,
            describe:
              'Path to a directory of downloaded snapshot artifacts (recurses into subdirs) or a single snapshot.*.jsonl file.',
          })
          .option('overrides-file', {
            type: 'string',
            describe:
              'Path to an overrides.jsonl file to join against the snapshot corpus. Defaults to <input>/overrides.jsonl when present.',
          })
          .option('min-snapshots', {
            type: 'number',
            default: DEFAULT_MIN_SNAPSHOTS,
            describe:
              'Minimum corpus size for a `safe-to-promote` recommendation. Below this, recommendation is `insufficient-data`.',
          })
          .option('correctness-threshold', {
            type: 'number',
            default: DEFAULT_CORRECTNESS_THRESHOLD,
            describe:
              'Dispatch-agreement-rate floor. Below this, recommendation is `continue-soak`. Default 0.95 (RFC-0014 §11 Phase 5).',
          })
          .option('override-threshold', {
            type: 'number',
            default: DEFAULT_OVERRIDE_THRESHOLD,
            describe:
              'Operator override-rate ceiling. Above this, recommendation is `continue-soak` (operators are routinely picking past the dispatcher).',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'json' as const,
          }),
      async (argv) => {
        const input = String(argv.input);
        const files = findSnapshotFiles(input);
        const { snapshots, skippedFiles, skippedLines } = loadSnapshotCorpus(files);

        // Load overrides — explicit --overrides-file wins; else look for
        // `overrides.jsonl` inside the input dir (sibling-of-snapshots
        // convention from `_deps/`).
        const overridesFile = argv['overrides-file'] as string | undefined;
        let overrides: OverrideEntry[] = [];
        if (overridesFile) {
          overrides = loadOverrides({ filePath: overridesFile }).entries;
        } else {
          // Auto-detect: look for a literal `overrides.jsonl` under input
          // (any depth). The aggregator silently uses none when missing.
          const found = findOverrideFile(input);
          if (found) overrides = loadOverrides({ filePath: found }).entries;
        }

        const report = aggregateDispatchCorpus(
          snapshots,
          {
            minSnapshots: argv['min-snapshots'] as number,
            correctnessThreshold: argv['correctness-threshold'] as number,
            overrideThreshold: argv['override-threshold'] as number,
            overrides,
          },
          { skippedFiles, skippedLines, filesRead: files.length },
        );
        if (String(argv.format) === 'table') emitText(renderTable(report));
        else emit(report);
      },
    )
    .demandCommand(
      1,
      'A subcommand is required (currently: aggregate). Run with --help for the list.',
    )
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

/**
 * Recursively look for `overrides.jsonl` under `rootPath`. Returns the
 * first match (sorted lexically so nested artifact dirs resolve
 * deterministically) or `null` when not found.
 */
function findOverrideFile(rootPath: string): string | null {
  const stack: string[] = [rootPath];
  const found: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let s;
    try {
      s = statSync(current);
    } catch {
      continue;
    }
    if (s.isFile()) {
      if (current.endsWith('overrides.jsonl')) found.push(current);
      continue;
    }
    if (!s.isDirectory()) continue;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const e of entries) stack.push(join(current, e));
  }
  found.sort();
  return found[0] ?? null;
}

export async function runDepsCorpusCli(): Promise<void> {
  await buildDepsCorpusCli().parseAsync();
}
