/**
 * `cli-quality-corpus` — aggregate the framework-quality capture corpus.
 * RFC-0025 Phase 1 substrate / AISDLC-302 (salvaged from PR #481).
 * Updated for Phase 3 (AISDLC-304): multi-window recurrence + MTTR label.
 *
 * Sister CLI to `cli-orchestrator-corpus`, `cli-deps-corpus`, and
 * `cli-dor-corpus`. Reads `$ARTIFACTS_DIR/_quality/captures.jsonl`
 * and computes the RFC-0025 §8 self-improvement metrics:
 *
 *   - Reliability trend (week-over-week framework-bug captures per run)
 *   - MTTR per subclass (first capture → fix done date; OQ-8 — clock from
 *     first capture, output labeled "MTTR (from first capture)")
 *   - Recurrence rate (7d / 30d / 90d simultaneous windows; OQ-3)
 *   - Coverage rate (fraction of captures classified vs. ambiguous)
 *
 * Usage:
 *   $ cli-quality-corpus aggregate
 *   $ cli-quality-corpus aggregate --artifacts-dir ./my-artifacts
 *   $ cli-quality-corpus aggregate --format table
 *   $ cli-quality-corpus aggregate --work-dir /path/to/repo
 *   $ cli-quality-corpus aggregate --recurrence-windows 7d,30d,90d
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
  formatRecurrenceEntry,
} from '../tui/analytics/quality-metrics.js';
import { formatReliabilityTrend } from '../tui/analytics/metrics.js';
import {
  classifyClosedUnmerged,
  fetchClosedUnmergedPrs,
  type ClosedUnmergedReport,
  type ListedClosedPr,
} from '../kpi/closed-unmerged.js';
import { spawnSync } from 'node:child_process';

// ── Report shape ──────────────────────────────────────────────────────

export interface QualityCorpusReport {
  /** RFC-0025 §8 primary signal: reliability trend (this week vs last). */
  reliabilityTrend: ReliabilityTrend;
  /** §8 self-improvement metrics derived from the full corpus. */
  metrics: QualityMetrics;
  /** AISDLC-831: PRs closed unmerged in the window (waste; target zero). Absent when GitHub is unreadable. */
  'prs-closed-unmerged'?: ClosedUnmergedReport;
  /** ISO-8601 timestamp of the report generation. */
  generatedAt: string;
}

// ── Pure computation ──────────────────────────────────────────────────

export interface AggregateQualityCorpusOpts {
  artifactsDir?: string;
  workDir?: string;
  now?: () => Date;
  /**
   * Recurrence windows to compute (OQ-3 — multi-window simultaneous).
   *
   * Each entry is a duration string matching `\d+d` (e.g. `'7d'`, `'30d'`,
   * `'90d'`). When omitted, auto-loaded from
   * `.ai-sdlc/quality-monitoring.yaml` (defaults: `['7d', '30d', '90d']`).
   */
  recurrenceWindows?: string[];
  /** Config file path override for quality-monitoring.yaml. */
  qualityMonitoringConfigPath?: string;
  /** PRs from `gh pr list --state all`; omit when GitHub could not be read. */
  prs?: readonly ListedClosedPr[];
  /** Window for `prs-closed-unmerged` in days (default 7). */
  closedUnmergedDays?: number;
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
    recurrenceWindows: opts.recurrenceWindows,
    qualityMonitoringConfigPath: opts.qualityMonitoringConfigPath,
  });

  const days = opts.closedUnmergedDays ?? 7;
  const closedUnmerged = opts.prs
    ? classifyClosedUnmerged(opts.prs, new Date(now().getTime() - days * 86_400_000))
    : undefined;

  return {
    reliabilityTrend,
    metrics,
    ...(closedUnmerged ? { 'prs-closed-unmerged': closedUnmerged } : {}),
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

  const cu = report['prs-closed-unmerged'];
  if (cu) {
    lines.push(
      `PRs closed unmerged since ${cu.since} (target: 0)`,
      `  Total: ${cu.total}  (re-filed ${cu.byCause['re-filed']}, superseded ${cu.byCause.superseded}, withdrawn ${cu.byCause.withdrawn}, unknown ${cu.byCause.unknown})`,
      ...cu.prs.map((p) => `  #${p.number} ${p.taskId || '-'} ${p.cause}`),
      ``,
    );
  }

  // MTTR table — labeled "MTTR (from first capture)" per OQ-8
  if (metrics.mttr.length > 0) {
    lines.push(`${metrics.mttrLabel} — per subclass`);
    lines.push(`${'─'.repeat(metrics.mttrLabel.length + 18)}`);
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
        : `${metrics.mttrLabel} — MEAN: — (no remediations yet)`;
    lines.push(`  ${meanLabel}`);
    // v2 MTTD substrate note
    if (!metrics.mttdV2.enabled) {
      lines.push(
        `  [v2 MTTD (from first occurrence) disabled — ships when first-occurrence inference is reliable]`,
      );
    }
    lines.push('');
  } else {
    lines.push(`${metrics.mttrLabel}: no framework-bug captures yet`);
    lines.push('');
  }

  // Multi-window recurrence table (OQ-3)
  if (metrics.recurrenceByWindow.length > 0) {
    const windowLabels = metrics.recurrenceByWindow.map((r) => r.window).join(' / ');
    lines.push(`Recurrence Rate — simultaneous windows: ${windowLabels} (OQ-3)`);
    lines.push(`${'─'.repeat(54 + windowLabels.length)}`);
    for (const byWindow of metrics.recurrenceByWindow) {
      if (byWindow.entries.length === 0) {
        lines.push(`  [${byWindow.window}] no completed framework-bug tasks`);
      } else {
        for (const entry of byWindow.entries) {
          lines.push(`  ${formatRecurrenceEntry(entry, byWindow.window)}`);
        }
      }
    }
    lines.push('');
  } else {
    lines.push('Recurrence rate: no recurrence windows configured');
    lines.push('');
  }

  return lines.join('\n');
}

// ── CLI builder ────────────────────────────────────────────────────────

/**
 * Parse a comma-separated recurrence windows string into an array.
 * e.g. '7d,30d,90d' → ['7d', '30d', '90d'].
 */
function parseRecurrenceWindowsArg(arg: string): string[] {
  return arg
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

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
          .option('recurrence-windows', {
            type: 'string',
            default: '',
            describe:
              'Comma-separated recurrence windows (OQ-3 multi-window). ' +
              "e.g. '7d,30d,90d'. When empty, auto-loaded from " +
              "`.ai-sdlc/quality-monitoring.yaml` (defaults: '7d,30d,90d').",
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'json' as const,
            describe:
              "Output format. 'json' emits a JSON envelope; 'table' renders an ASCII summary.",
          }),
      async (argv) => {
        const windowsArg = argv['recurrence-windows'] as string;
        const recurrenceWindows = windowsArg ? parseRecurrenceWindowsArg(windowsArg) : undefined;

        const prs = fetchClosedUnmergedPrs((file, args, o) => {
          const r = spawnSync(file, [...args], { cwd: o?.cwd, encoding: 'utf8' });
          return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
        }, process.cwd());
        const report = aggregateQualityCorpus({
          prs,
          artifactsDir: argv['artifacts-dir'] as string | undefined,
          workDir: argv['work-dir'] as string | undefined,
          recurrenceWindows,
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
