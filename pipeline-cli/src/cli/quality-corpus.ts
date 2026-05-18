/**
 * `cli-quality-corpus` — aggregate the framework-quality capture corpus.
 * RFC-0025 Phase 1 substrate / AISDLC-302 (salvaged from PR #481).
 *
 * Sister CLI to `cli-orchestrator-corpus`, `cli-deps-corpus`, and
 * `cli-dor-corpus`. Reads `$ARTIFACTS_DIR/_quality/captures.jsonl`
 * and computes the RFC-0025 §8 self-improvement metrics:
 *
 *   - Reliability trend (week-over-week framework-bug captures per run)
 *   - MTTR per subclass (first capture → fix done date; OQ-8 aligned)
 *   - Recurrence rate (fixed bugs that recurred within the window; OQ-3 placeholder)
 *   - Coverage rate (fraction of captures classified vs. ambiguous)
 *
 * This is the aggregate CLI the `quality-reader.ts` always referenced as
 * "eventual" — it reads the same `captures.jsonl` that
 * `readReliabilityTrend()` produces, then computes the full §8 metric set.
 *
 * Usage:
 *   $ cli-quality-corpus aggregate
 *   $ cli-quality-corpus aggregate --artifacts-dir ./my-artifacts
 *   $ cli-quality-corpus aggregate --format table
 *   $ cli-quality-corpus aggregate --work-dir /path/to/repo
 *
 * Output is JSON on stdout; `--format table` renders an ASCII summary.
 *
 * @module cli/quality-corpus
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import { readReliabilityTrend, type ReliabilityTrend } from '../tui/analytics/quality-reader.js';
import {
  computeQualityMetrics,
  type QualityMetrics,
  formatMttr,
  formatCoverageRate,
} from '../tui/analytics/quality-metrics.js';
import { formatReliabilityTrend } from '../tui/analytics/metrics.js';

// ── Report shape ──────────────────────────────────────────────────────

export interface QualityCorpusReport {
  /** RFC-0025 §8 primary signal: reliability trend (this week vs last). */
  reliabilityTrend: ReliabilityTrend;
  /** §8 self-improvement metrics derived from the full corpus. */
  metrics: QualityMetrics;
  /** ISO-8601 timestamp of the report generation. */
  generatedAt: string;
}

// ── Pure computation ──────────────────────────────────────────────────

export interface AggregateQualityCorpusOpts {
  artifactsDir?: string;
  workDir?: string;
  now?: () => Date;
  recurrenceWindowDays?: number;
}

/**
 * Compute the full quality corpus report.
 * Pure: no CLI I/O — tests can drive this directly.
 */
export function aggregateQualityCorpus(opts: AggregateQualityCorpusOpts = {}): QualityCorpusReport {
  const now = opts.now ?? ((): Date => new Date());

  const reliabilityTrend = readReliabilityTrend({
    artifactsDir: opts.artifactsDir,
    now,
  });

  const metrics = computeQualityMetrics({
    artifactsDir: opts.artifactsDir,
    workDir: opts.workDir,
    now,
    recurrenceWindowDays: opts.recurrenceWindowDays,
  });

  return {
    reliabilityTrend,
    metrics,
    generatedAt: now().toISOString(),
  };
}

// ── Renderers ──────────────────────────────────────────────────────────

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

function renderTable(report: QualityCorpusReport): string {
  const { reliabilityTrend, metrics } = report;

  const lines: string[] = [
    `Framework Quality Corpus Report — RFC-0025 §8 Self-Improvement Metrics`,
    `Generated: ${report.generatedAt}`,
    ``,
    `Reliability Trend`,
    `-----------------`,
    `  ${formatReliabilityTrend(reliabilityTrend)}`,
    ``,
    `Captures`,
    `--------`,
    `  Total:          ${metrics.totalCaptures}`,
    `  Framework bugs: ${metrics.frameworkBugCaptures}`,
    `  Ambiguous:      ${metrics.ambiguousCaptures}`,
    `  Coverage rate:  ${formatCoverageRate(metrics.coverageRate)}`,
    ``,
  ];

  // MTTR table
  if (metrics.mttr.length > 0) {
    lines.push(`MTTR (Mean Time to Remediation — clock starts at first capture per OQ-8)`);
    lines.push(`----------------------------------------------------------------------`);
    for (const entry of metrics.mttr) {
      lines.push(`  ${formatMttr(entry)}`);
    }
    const meanLabel =
      metrics.meanMttrMs !== null
        ? formatMttr({
            subclass: 'MEAN',
            firstCaptureAt: '',
            remediatedAt: '',
            mttrMs: metrics.meanMttrMs,
          })
        : 'MEAN: — (no remediations yet)';
    lines.push(`  ${meanLabel}`);
    lines.push('');
  } else {
    lines.push('MTTR: no framework-bug captures yet');
    lines.push('');
  }

  // Recurrence table
  if (metrics.recurrence.length > 0) {
    lines.push(`Recurrence Rate (within ${30} days of fix — OQ-3 placeholder window)`);
    lines.push(`-------------------------------------------------------------------`);
    for (const entry of metrics.recurrence) {
      lines.push(
        `  ${entry.subclass}: ${entry.recurrences}/${entry.fixes} fixes recurred (${(entry.recurrenceRate * 100).toFixed(1)}%)`,
      );
    }
    lines.push('');
  } else {
    lines.push('Recurrence rate: no completed framework-bug tasks found');
    lines.push('');
  }

  return lines.join('\n');
}

// ── CLI builder ────────────────────────────────────────────────────────

export function buildQualityCorpusCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-quality-corpus')
    .usage('Usage: $0 <command> [options]')
    .command(
      'aggregate',
      'Aggregate the framework-quality capture corpus into RFC-0025 §8 self-improvement metrics.',
      (y) =>
        y
          .option('artifacts-dir', {
            type: 'string',
            describe:
              'Override the $ARTIFACTS_DIR path. Defaults to the ARTIFACTS_DIR env var or `./_artifacts`.',
          })
          .option('work-dir', {
            type: 'string',
            describe:
              'Project root for backlog/ walk (MTTR + recurrence computation). Defaults to cwd.',
          })
          .option('recurrence-window-days', {
            type: 'number',
            default: 30,
            describe:
              'Recurrence-detection window in days (OQ-3 placeholder default: 30). Phase 3 (AISDLC-304) will add multi-window support.',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'json' as const,
            describe:
              "Output format. 'json' emits a JSON envelope; 'table' renders an ASCII summary.",
          }),
      async (argv) => {
        const report = aggregateQualityCorpus({
          artifactsDir: argv['artifacts-dir'] as string | undefined,
          workDir: argv['work-dir'] as string | undefined,
          recurrenceWindowDays: argv['recurrence-window-days'] as number,
        });
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

export async function runQualityCorpusCli(): Promise<void> {
  await buildQualityCorpusCli().parseAsync();
}
