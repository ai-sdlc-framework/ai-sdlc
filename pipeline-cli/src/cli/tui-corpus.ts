/**
 * `cli-tui-corpus` — aggregate downloaded operator-TUI artifacts
 * (`_tui/events.jsonl`, `_operator/interactions.jsonl`,
 * `_operator/decisions.jsonl`, `_captures/*`) into a soak report and
 * promotion-recommendation envelope (RFC-0023 §13 Phase 7 / AISDLC-178.7).
 *
 * Sister CLI to `cli-deps-corpus`, `cli-orchestrator-corpus`, and
 * `cli-dor-corpus`. The four share aesthetic conventions
 * (find-files-recursively, recommendation envelope, JSON-or-table
 * output, three-state recommendation) but answer different questions —
 * see `pipeline-cli/src/tui/corpus/aggregate.ts` for the full contract.
 *
 * Usage:
 *   $ cli-tui-corpus aggregate ./artifacts
 *   $ cli-tui-corpus aggregate ./artifacts --format table
 *   $ cli-tui-corpus aggregate ./artifacts --min-sessions 14
 *
 * Output is JSON on stdout; `--format table` renders a human-readable
 * summary mirroring the sister CLIs.
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  aggregateTuiCorpus,
  findCorpusFiles,
  loadCorpus,
  type CorpusReport,
} from '../tui/corpus/aggregate.js';

const DEFAULT_MIN_SESSIONS = 7;
const DEFAULT_MIN_DAYS_WITH_USAGE = 7;
const DEFAULT_MIN_DISTINCT_PANES = 2;

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

/**
 * Render an ASCII summary — same conventions as `cli-orchestrator-corpus`
 * so the operator's eye doesn't have to retrain. Top section is the
 * gate-driving metrics (sessions / daysWithUsage / distinctPanes /
 * tuiCrashedCount); middle section is soft signals (decision trend,
 * pane-open distribution, captures); bottom is the recommendation +
 * reason.
 */
function renderTable(report: CorpusReport): string {
  const out: string[] = [];
  out.push('TUI soak corpus — operator-throughput aggregate (RFC-0023 §13 Phase 7)');
  out.push('');
  out.push(
    `Window: ${report.windowStart ?? '(empty)'} → ${report.windowEnd ?? '(empty)'}` +
      `  Files: ${report.filesRead}  Skipped: ${report.skippedFiles}f / ${report.skippedLines}L`,
  );
  out.push('');
  out.push('Promotion gates:');
  out.push(
    `  sessions=${report.sessions}  daysWithUsage=${report.daysWithUsage}` +
      `  distinctPanes=${report.distinctPanes}  tuiCrashedCount=${report.tuiCrashedCount}`,
  );
  out.push('');
  out.push('Pane-open distribution:');
  const paneRows = Object.entries(report.paneOpenDistribution).sort(([, a], [, b]) => b - a);
  if (paneRows.length === 0) out.push('  (no pane-opened events)');
  else for (const [pane, n] of paneRows) out.push(`  ${pane}: ${n}`);
  out.push('');
  out.push('Decision trend (time-to-decision over the soak window):');
  const t = report.decisionTrend;
  out.push(
    `  decisions=${report.decisionsResolved}` +
      `  firstHalfMedianMs=${t.firstHalfMedianMs}  secondHalfMedianMs=${t.secondHalfMedianMs}` +
      `  deltaMs=${t.deltaMs} (${t.deltaMs < 0 ? 'faster' : t.deltaMs > 0 ? 'slower' : 'flat'})`,
  );
  out.push('');
  out.push(
    `Captures filed during soak: ${report.capturesFiled}` +
      (report.skippedCaptures > 0 ? ` (skipped ${report.skippedCaptures} unparseable)` : ''),
  );
  out.push('');
  out.push(`Recommendation: ${report.recommendation}`);
  out.push(`Reason: ${report.reason}`);
  return out.join('\n') + '\n';
}

export function buildTuiCorpusCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-tui-corpus')
    .usage('Usage: $0 <command> [options]')
    .command(
      'aggregate <input>',
      'Aggregate downloaded operator-TUI artifacts (_tui/events.jsonl, _operator/interactions.jsonl, _operator/decisions.jsonl, _captures/) into a soak report and promotion-recommendation envelope.',
      (y) =>
        y
          .positional('input', {
            type: 'string',
            demandOption: true,
            describe:
              'Path to a directory holding the corpus artifacts (recurses into subdirs); typically a workspace $ARTIFACTS_DIR or a `gh run download` root.',
          })
          .option('min-sessions', {
            type: 'number',
            default: DEFAULT_MIN_SESSIONS,
            describe:
              'Minimum session count for safe-to-promote (RFC-0023 §13 Phase 7: ≥7 — at least one session per dogfood day).',
          })
          .option('min-days-with-usage', {
            type: 'number',
            default: DEFAULT_MIN_DAYS_WITH_USAGE,
            describe:
              'Minimum distinct UTC dates with TUI usage (RFC-0023 §13 acceptance #4: ≥7 calendar days).',
          })
          .option('min-distinct-panes', {
            type: 'number',
            default: DEFAULT_MIN_DISTINCT_PANES,
            describe:
              'Minimum distinct panes opened across the corpus (default 2 — operator must mode-switch beyond overview).',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'json' as const,
          }),
      async (argv) => {
        const input = String(argv.input);
        const found = findCorpusFiles(input);
        const corpus = loadCorpus(found);
        const report = aggregateTuiCorpus(corpus, {
          minSessions: argv['min-sessions'] as number,
          minDaysWithUsage: argv['min-days-with-usage'] as number,
          minDistinctPanes: argv['min-distinct-panes'] as number,
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

export async function runTuiCorpusCli(): Promise<void> {
  await buildTuiCorpusCli().parseAsync();
}
