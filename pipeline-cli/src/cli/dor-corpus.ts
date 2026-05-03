/**
 * `cli-dor-corpus` — aggregate downloaded DoR calibration JSONL files into
 * a per-gate false-positive / override report (AISDLC-161, RFC-0011 §5.5
 * + §8.4).
 *
 * Sister CLI to `cli-dor-stats` (which targets the live local
 * `$ARTIFACTS_DIR/_dor/calibration.jsonl`). This CLI is the post-CI
 * aggregator: the operator runs `gh run download` against the workflow
 * artifacts produced by `dor-ingress.yml` (AISDLC-161 Part 1), collects N
 * `calibration.jsonl` files into a directory, and pipes them through this
 * tool to compute the corpus-driven exit criterion for AISDLC-115.8 AC #5
 * (false-positive rate < 10% per gate).
 *
 * Why a separate CLI vs extending `cli-dor-stats`:
 *   - `cli-dor-stats` semantically operates on ONE local log file (the
 *     conventional `$ARTIFACTS_DIR/_dor/calibration.jsonl`).
 *   - This CLI semantically operates on N downloaded artifacts, each named
 *     `dor-calibration-issue-NNN-A/calibration.jsonl` (or `pr-NNN-A`), and
 *     produces a corpus-shaped recommendation envelope keyed off
 *     `recommendation` (used by the operator + AISDLC-115.9 dispatcher).
 *   - Mixing the two contracts in one CLI invited confusion ("which path
 *     am I on?") at the exact moment the operator needs clarity.
 *
 * Hybrid promotion model (RFC-0011 §10 + maintainer directive 2026-05-01):
 *   - `recommendation: 'safe-to-enforce'` → operator dispatches AISDLC-115.9
 *     to flip `evaluationMode: warn-only → enforce`.
 *   - `recommendation: 'continue-soak'` → keep gathering data.
 *   - `recommendation: 'insufficient-data'` → operator may use the
 *     manual-override path (spot-check recent dor-ingress runs in the
 *     Actions UI; manually decide). Both paths land at the same
 *     `evaluationMode: enforce` end-state. See
 *     `docs/operations/dor-promotion.md`.
 *
 * Usage:
 *   $ gh run download --pattern 'dor-calibration-*' --dir ./downloaded
 *   $ cli-dor-corpus aggregate ./downloaded
 *   $ cli-dor-corpus aggregate ./downloaded --min-samples 100 --fp-threshold 0.10
 *
 * Output is JSON on stdout; `--format table` renders an ASCII table for
 * eyeballing.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { CalibrationEntry } from '../dor/calibration-log.js';

// Re-export so consumers (e.g. AISDLC-162 dashboard) can import the
// CalibrationEntry shape alongside the aggregator without a second
// import path. The aggregator's full surface — pure functions + this
// type — is the dashboard's contract.
export type { CalibrationEntry };

/**
 * Default minimum sample count for the `safe-to-enforce` recommendation.
 * Below this, we return `insufficient-data` regardless of the FP rate
 * (a 100% pass-through over 3 samples is meaningless). 50 is the operator
 * default per the AISDLC-161 task brief; tunable via `--min-samples`.
 */
const DEFAULT_MIN_SAMPLES = 50;

/**
 * Default FP-rate threshold per gate (10% per AISDLC-115.8 AC #5). A gate
 * with a higher rate gates the `safe-to-enforce` recommendation; the
 * aggregate reports the worst-offender gate so the operator knows where
 * the next round of rubric tuning should land.
 */
const DEFAULT_FP_THRESHOLD = 0.1;

/**
 * Default override-rate plateau threshold. RFC-0011 Phase 7 exit criterion
 * mentions "override-rate plateau" — operationalised here as "override
 * rate < 5%" across the corpus. A high override rate means maintainers
 * are routinely punching past the rubric, which means the rubric is too
 * strict (or the wrong gates are blocking) and `enforce` mode would just
 * shift the friction onto every author. 5% is a reasonable starting point;
 * tune via `--override-threshold`.
 */
const DEFAULT_OVERRIDE_THRESHOLD = 0.05;

export type Recommendation = 'insufficient-data' | 'safe-to-enforce' | 'continue-soak';

export interface PerGateStats {
  gate: number;
  /** Total entries where this gate appeared in `failedGates`. */
  n: number;
  /** Override count among those entries (rubric said fail, maintainer said ship). */
  overrides: number;
  /** False-positive rate per gate: overrides / n. 0 when n=0. */
  fpRate: number;
  /** Override rate per gate (currently identical to fpRate, but kept separate so future heuristics can diverge). */
  overrideRate: number;
}

export interface AggregateReport {
  /** Total calibration entries in the corpus (post-skip). */
  n: number;
  /** Mean FP rate weighted across all gates with non-zero n. 0 when no gates have data. */
  meanFpRate: number;
  /** Aggregate override rate: overrides / n. */
  overrideRate: number;
  /** Worst-offender gate by FP rate (null when no gate has data). */
  worstGate: { gate: number; fpRate: number } | null;
  /** Operator-facing recommendation. Drives the AISDLC-115.9 promotion decision. */
  recommendation: Recommendation;
  /** Human-readable rationale for the recommendation (operator log line). */
  reason: string;
  /** Number of malformed JSONL lines skipped (forensic / observability). */
  skipped: number;
  /** Number of input files read. */
  filesRead: number;
}

export interface CorpusReport {
  perGate: PerGateStats[];
  aggregate: AggregateReport;
}

export interface AggregateOpts {
  /** Below this n, recommendation is forced to `insufficient-data`. */
  minSamples?: number;
  /** Per-gate FP rate ceiling for `safe-to-enforce`. */
  fpThreshold?: number;
  /** Aggregate override rate ceiling for `safe-to-enforce`. */
  overrideThreshold?: number;
}

/**
 * Recursively walk a directory and return every file whose basename ends
 * in `calibration.jsonl`. The `gh run download` layout drops one
 * subdirectory per workflow artifact, so a single `--input ./downloaded`
 * resolves to N JSONL files without the operator having to glob manually.
 *
 * Single-file inputs are also supported — a path that is itself a JSONL
 * file is returned as a single-element array.
 */
export function findCalibrationFiles(rootPath: string): string[] {
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
      if (current.endsWith('.jsonl') || current.endsWith('.json')) out.push(current);
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
 * `CalibrationEntry`. We're defensive here — an artifact downloaded from
 * a stranger's PR run could in principle contain anything, and we'd
 * rather skip a malformed line than poison the FP-rate math.
 *
 * The check is structural (duck-typing on the fields we ACTUALLY consume)
 * rather than schema-equality with `CalibrationEntry` — extra fields are
 * fine, missing fields aren't. This deliberately tolerates schema drift
 * (a future calibration entry that adds new fields still aggregates;
 * a future drop of a field we use, like `failedGates`, surfaces loudly
 * via the `skipped` counter).
 */
export function isValidEntry(raw: unknown): raw is CalibrationEntry {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  if (typeof e.ts !== 'string') return false;
  if (typeof e.issueId !== 'string') return false;
  if (!Array.isArray(e.failedGates)) return false;
  if (!e.failedGates.every((g) => typeof g === 'number')) return false;
  // outcome is the empty string for live runs and one of the union members
  // for ground-truth rows. Allow either.
  if (typeof e.outcome !== 'string') return false;
  if (e.overallVerdict !== 'admit' && e.overallVerdict !== 'needs-clarification') return false;
  return true;
}

/**
 * Load + parse all entries from a list of JSONL files. Malformed lines
 * are silently skipped (counted), files that fail to read are skipped
 * (counted), and the result is the entry array + the skip counter so
 * the aggregator can surface forensic context to the operator.
 *
 * Mirrors `loadEntries()` in `dor/stats.ts` semantically — we duplicate
 * here because that function reads ONE file from a known path; this one
 * fans out across N files from the corpus root and tallies skips
 * separately for the operator-facing report.
 */
export function loadCorpus(files: string[]): { entries: CalibrationEntry[]; skipped: number } {
  const entries: CalibrationEntry[] = [];
  let skipped = 0;
  for (const f of files) {
    let raw: string;
    try {
      raw = readFileSync(f, 'utf8');
    } catch {
      // Unreadable file — count it as one skip and move on. Surfacing the
      // exact error path here would couple us to readFileSync's error
      // shape; the operator can rerun with `--input <single-file>` to
      // diagnose if needed.
      skipped += 1;
      continue;
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      if (!isValidEntry(parsed)) {
        skipped += 1;
        continue;
      }
      entries.push(parsed);
    }
  }
  return { entries, skipped };
}

/**
 * Compute the per-gate + aggregate report from a corpus of entries.
 *
 * Pure function — no I/O — so tests can pass synthetic entry arrays and
 * snapshot the output. The CLI front-end is a thin shell around
 * `loadCorpus()` + this function + a renderer.
 *
 * False-positive math (per maintainer directive + AISDLC-115.8 AC #5):
 *
 *   For each gate G in 1..7, count:
 *     n_G       = entries where G ∈ failedGates
 *     overrides_G = entries where G ∈ failedGates AND outcome === 'override'
 *
 *     fpRate_G = overrides_G / n_G
 *
 *   The aggregate's meanFpRate is the mean across gates with n_G > 0
 *   (gates with no data don't drag the mean toward 0). worstGate
 *   surfaces the per-gate maximum so the operator can target rubric
 *   tuning at the highest-FP gate next round.
 *
 *   Recommendation:
 *     - n < minSamples           → 'insufficient-data'
 *     - any gate's fpRate >= fpThreshold OR aggregate override-rate
 *       >= overrideThreshold     → 'continue-soak'
 *     - else                     → 'safe-to-enforce'
 */
export function aggregateCorpus(
  entries: CalibrationEntry[],
  opts: AggregateOpts = {},
  meta: { skipped?: number; filesRead?: number } = {},
): CorpusReport {
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
  const fpThreshold = opts.fpThreshold ?? DEFAULT_FP_THRESHOLD;
  const overrideThreshold = opts.overrideThreshold ?? DEFAULT_OVERRIDE_THRESHOLD;

  // Per-gate tallies — keyed by gateId. Iterating gates 1..7 explicitly
  // would skip gates added in future rubric versions; we discover gates
  // from the data instead.
  const gateMap = new Map<number, { n: number; overrides: number }>();
  let totalOverrides = 0;
  for (const e of entries) {
    if (e.outcome === 'override') totalOverrides += 1;
    for (const g of e.failedGates) {
      const cur = gateMap.get(g) ?? { n: 0, overrides: 0 };
      cur.n += 1;
      if (e.outcome === 'override') cur.overrides += 1;
      gateMap.set(g, cur);
    }
  }

  const perGate: PerGateStats[] = Array.from(gateMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([gate, t]) => ({
      gate,
      n: t.n,
      overrides: t.overrides,
      fpRate: t.n === 0 ? 0 : t.overrides / t.n,
      overrideRate: t.n === 0 ? 0 : t.overrides / t.n,
    }));

  const gatesWithData = perGate.filter((g) => g.n > 0);
  const meanFpRate =
    gatesWithData.length === 0
      ? 0
      : gatesWithData.reduce((s, g) => s + g.fpRate, 0) / gatesWithData.length;
  const worstGate =
    gatesWithData.length === 0
      ? null
      : gatesWithData.reduce(
          (w, g) => (g.fpRate > w.fpRate ? { gate: g.gate, fpRate: g.fpRate } : w),
          {
            gate: gatesWithData[0]!.gate,
            fpRate: gatesWithData[0]!.fpRate,
          },
        );

  const overrideRate = entries.length === 0 ? 0 : totalOverrides / entries.length;

  let recommendation: Recommendation;
  let reason: string;
  if (entries.length < minSamples) {
    recommendation = 'insufficient-data';
    reason = `n=${entries.length} below minSamples=${minSamples} — operator may use the manual-override promotion path (see docs/operations/dor-promotion.md)`;
  } else if (worstGate && worstGate.fpRate >= fpThreshold) {
    recommendation = 'continue-soak';
    reason = `gate-${worstGate.gate} fpRate=${(worstGate.fpRate * 100).toFixed(1)}% exceeds threshold=${(fpThreshold * 100).toFixed(1)}%`;
  } else if (overrideRate >= overrideThreshold) {
    recommendation = 'continue-soak';
    reason = `aggregate override rate=${(overrideRate * 100).toFixed(1)}% exceeds threshold=${(overrideThreshold * 100).toFixed(1)}% — maintainers are punching past the rubric routinely`;
  } else {
    recommendation = 'safe-to-enforce';
    reason = `n=${entries.length} ≥ ${minSamples}, all gates fpRate < ${(fpThreshold * 100).toFixed(1)}%, aggregate override rate=${(overrideRate * 100).toFixed(1)}% < ${(overrideThreshold * 100).toFixed(1)}% — dispatch AISDLC-115.9`;
  }

  return {
    perGate,
    aggregate: {
      n: entries.length,
      meanFpRate,
      overrideRate,
      worstGate,
      recommendation,
      reason,
      skipped: meta.skipped ?? 0,
      filesRead: meta.filesRead ?? 0,
    },
  };
}

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

/**
 * Render an ASCII table for the per-gate breakdown — same conventions as
 * `cli-dor-stats` so the operator's eye doesn't have to retrain when
 * switching CLIs.
 */
function renderTable(report: CorpusReport): string {
  const headers = ['gate', 'n', 'overrides', 'fp-rate'];
  const rows = report.perGate.map((g) => [
    `gate-${g.gate}`,
    String(g.n),
    String(g.overrides),
    `${(g.fpRate * 100).toFixed(1)}%`,
  ]);
  if (rows.length === 0) rows.push(['(none)', '0', '0', '0.0%']);
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
    `\nCorpus: n=${a.n}  files=${a.filesRead}  skipped=${a.skipped}` +
    `\nMean FP rate: ${(a.meanFpRate * 100).toFixed(1)}%` +
    `\nAggregate override rate: ${(a.overrideRate * 100).toFixed(1)}%` +
    (a.worstGate
      ? `\nWorst gate: gate-${a.worstGate.gate} (${(a.worstGate.fpRate * 100).toFixed(1)}%)`
      : '\nWorst gate: (none — no gates fired)') +
    `\nRecommendation: ${a.recommendation}` +
    `\nReason: ${a.reason}\n`;
  return tbl + '\n' + summary;
}

export function buildDorCorpusCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-dor-corpus')
    .usage('Usage: $0 <command> [options]')
    .command(
      'aggregate <input>',
      'Aggregate one or more downloaded calibration JSONL files into a per-gate FP-rate report.',
      (y) =>
        y
          .positional('input', {
            type: 'string',
            demandOption: true,
            describe:
              'Path to a directory of downloaded artifacts (recurses into subdirs) or a single calibration.jsonl file.',
          })
          .option('min-samples', {
            type: 'number',
            default: DEFAULT_MIN_SAMPLES,
            describe:
              'Minimum corpus size for a `safe-to-enforce` recommendation. Below this, recommendation is `insufficient-data`.',
          })
          .option('fp-threshold', {
            type: 'number',
            default: DEFAULT_FP_THRESHOLD,
            describe:
              'Per-gate FP rate ceiling. Any gate above this gates `safe-to-enforce` (recommendation becomes `continue-soak`).',
          })
          .option('override-threshold', {
            type: 'number',
            default: DEFAULT_OVERRIDE_THRESHOLD,
            describe:
              'Aggregate override-rate ceiling. Above this, recommendation becomes `continue-soak` (maintainers are punching past the rubric routinely).',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'json' as const,
          }),
      async (argv) => {
        const input = String(argv.input);
        const files = findCalibrationFiles(input);
        const { entries, skipped } = loadCorpus(files);
        const report = aggregateCorpus(
          entries,
          {
            minSamples: argv['min-samples'] as number,
            fpThreshold: argv['fp-threshold'] as number,
            overrideThreshold: argv['override-threshold'] as number,
          },
          { skipped, filesRead: files.length },
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

export async function runDorCorpusCli(): Promise<void> {
  await buildDorCorpusCli().parseAsync();
}
