/**
 * `cli-dor-stats` subcommand router (RFC-0011 Phase 5).
 *
 * Surfaces calibration log aggregations to operators + the Slack digest
 * cron path. The aggregation lives in `src/dor/stats.ts`; this module
 * is the thin yargs front-end + table/JSON renderer + markdown dump
 * facade for `--render-markdown`.
 *
 * Flags:
 *   --log <path>          calibration log file (default resolveCalibrationLogPath())
 *   --since <ISO-date>    inclusive lower bound (default: 7 days ago)
 *   --until <ISO-date>    inclusive upper bound (default: now)
 *   --by-author           group by `author` field
 *   --by-gate             group by failed gate IDs
 *   --format json|table   default table
 *   --render-markdown     emit the weekly digest as a markdown dashboard dump
 *
 * Either `--by-author`, `--by-gate`, OR `--render-markdown` must be
 * specified; otherwise we exit with a usage error so we don't accidentally
 * dump every entry.
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  aggregateByAuthor,
  aggregateByGate,
  filterByWindow,
  loadEntries,
  overrideRate,
  passRate,
  type GroupedStats,
  type StatsBucket,
} from '../dor/stats.js';
import { renderMarkdownDigest } from '../dor/slack-digest.js';

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

function fail(reason: string, code = 1): never {
  process.stderr.write(JSON.stringify({ ok: false, reason }, null, 2) + '\n');
  process.exit(code);
}

/**
 * Render an ASCII table — same pattern as cli-deps. Three+ columns,
 * right-padded to the widest cell per column. Avoids a third-party
 * table dependency.
 */
function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const out: string[] = [fmt(headers), sep];
  for (const r of rows) out.push(fmt(r));
  return out.join('\n') + '\n';
}

/**
 * Default `--since` = 7 days ago, ISO-8601. Computed at command parse
 * time so two consecutive invocations of the CLI in the same minute
 * produce the same window (the operator running the CLI manually rarely
 * cares about millisecond drift between invocations).
 */
function defaultSince(): string {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

function bucketRow(label: string, b: StatsBucket): string[] {
  const pct = (passRate(b) * 100).toFixed(1);
  return [label, String(b.admit), String(b.nc), String(b.override), String(b.total), `${pct}%`];
}

function renderGroupedTable(grouped: GroupedStats, groupLabel: string): string {
  const headers = [groupLabel, 'admit', 'nc', 'override', 'total', 'pass-rate'];
  // Sort group keys for stable output. `(none)` and `(unknown)` always
  // sink to the bottom so the actually-interesting rows appear first.
  const keys = Object.keys(grouped.groups).sort((a, b) => {
    const aSpecial = a.startsWith('(');
    const bSpecial = b.startsWith('(');
    if (aSpecial && !bSpecial) return 1;
    if (!aSpecial && bSpecial) return -1;
    return a.localeCompare(b);
  });
  const rows = keys.map((k) => bucketRow(k, grouped.groups[k]!));
  rows.push(bucketRow('TOTAL', grouped.totals));
  const overall = `Overall pass rate: ${(passRate(grouped.totals) * 100).toFixed(1)}% · override rate: ${(overrideRate(grouped.totals) * 100).toFixed(1)}%\n`;
  return renderTable(headers, rows) + '\n' + overall;
}

export function buildDorStatsCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-dor-stats')
    .usage('Usage: $0 [options]')
    .option('log', {
      type: 'string',
      describe: 'Calibration log file path. Defaults to $ARTIFACTS_DIR/_dor/calibration.jsonl.',
    })
    .option('since', {
      type: 'string',
      describe: 'Inclusive lower bound (ISO-8601). Default: 7 days ago.',
      default: defaultSince(),
    })
    .option('until', {
      type: 'string',
      describe: 'Inclusive upper bound (ISO-8601). Default: now.',
    })
    .option('by-author', {
      type: 'boolean',
      default: false,
      describe: 'Group entries by `author` field.',
    })
    .option('by-gate', {
      type: 'boolean',
      default: false,
      describe: 'Group entries by failed gate IDs (entry can contribute to multiple buckets).',
    })
    .option('format', {
      type: 'string',
      choices: ['json', 'table'] as const,
      default: 'table' as const,
    })
    .option('render-markdown', {
      type: 'boolean',
      default: false,
      describe:
        'Emit the weekly digest as a markdown table dump (suitable for a dashboard commit).',
    })
    .command(
      '$0',
      'Aggregate calibration log entries by author and/or gate.',
      (y) => y,
      async (argv) => {
        const logPath = (argv.log as string | undefined) ?? undefined;
        const since = String(argv.since);
        const until = (argv.until as string | undefined) ?? undefined;
        const byAuthor = argv['by-author'] as boolean;
        const byGate = argv['by-gate'] as boolean;
        const format = String(argv.format) as 'json' | 'table';
        const renderMarkdown = argv['render-markdown'] as boolean;

        if (!byAuthor && !byGate && !renderMarkdown) {
          fail('At least one of --by-author, --by-gate, or --render-markdown is required.');
        }

        if (renderMarkdown) {
          // Dashboard renderer (AC #5). Routes through buildDigestAggregate
          // so Slack + dashboard cannot drift.
          const md = renderMarkdownDigest({
            ...(logPath !== undefined ? { logPath } : {}),
          });
          emitText(md);
          return;
        }

        const all = loadEntries(logPath);
        const filterOpts: { since?: string; until?: string } = { since };
        if (until !== undefined) filterOpts.until = until;
        const windowed = filterByWindow(all, filterOpts);

        const result: {
          window: { since: string; until?: string };
          totalEntries: number;
          byAuthor?: GroupedStats;
          byGate?: GroupedStats;
        } = {
          window: until ? { since, until } : { since },
          totalEntries: windowed.length,
        };
        if (byAuthor) result.byAuthor = aggregateByAuthor(windowed);
        if (byGate) result.byGate = aggregateByGate(windowed);

        if (format === 'json') {
          emit(result);
          return;
        }

        // Table format.
        const parts: string[] = [];
        parts.push(`Window: ${since}${until ? ` → ${until}` : ' → now'}`);
        parts.push(`Entries in window: ${windowed.length}\n`);
        if (result.byAuthor) {
          parts.push('=== By author ===');
          parts.push(renderGroupedTable(result.byAuthor, 'author'));
        }
        if (result.byGate) {
          parts.push('=== By gate ===');
          parts.push(renderGroupedTable(result.byGate, 'gate'));
        }
        emitText(parts.join('\n'));
      },
    )
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

export async function runDorStatsCli(): Promise<void> {
  await buildDorStatsCli().parseAsync();
}
