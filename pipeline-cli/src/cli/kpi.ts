/**
 * `cli-kpi` router (AISDLC-877). `pr-throughput` fetches `gh pr list --state
 * all` (cached per UTC day in `.ai-sdlc/kpi/`), computes the throughput
 * report and refreshes the "PR throughput" section of the KPI page.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { now } from '../clock.js';
import {
  computeThroughput,
  refreshPage,
  summaryLine,
  type PrRecord,
} from '../kpi/pr-throughput.js';

export const KPI_PAGE = 'docs/operations/kpi.md';

function fetchPrs(cacheFile: string): PrRecord[] {
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8')) as PrRecord[];
  const out = execFileSync(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'all',
      '--limit',
      '5000',
      '--json',
      'headRefName,createdAt,mergedAt,closedAt',
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, out);
  return JSON.parse(out) as PrRecord[];
}

export async function runKpiCli(argv: string[] = hideBin(process.argv)): Promise<void> {
  await yargs(argv)
    .scriptName('cli-kpi')
    .command(
      'pr-throughput',
      'PR opened vs landed per day, task/record split, task merge latency',
      (y) =>
        y
          .option('since', { type: 'string', describe: 'first UTC day (YYYY-MM-DD)' })
          .option('days', { type: 'number', default: 4, describe: 'window length in days' })
          .option('json', { type: 'boolean', default: false })
          .option('write', {
            type: 'boolean',
            default: true,
            describe: 'refresh the KPI page (--no-write skips)',
          })
          .option('dir', { type: 'string', default: process.cwd() }),
      (args) => {
        const today = now().toISOString().slice(0, 10);
        const from =
          args.since ??
          new Date(Date.parse(today) - (args.days - 1) * 86_400_000).toISOString().slice(0, 10);
        const prs = fetchPrs(join(args.dir, '.ai-sdlc', 'kpi', `pr-list-${today}.json`));
        const report = computeThroughput(prs, from, today);
        if (args.write) {
          const page = join(args.dir, KPI_PAGE);
          const current = existsSync(page) ? readFileSync(page, 'utf8') : '# KPIs\n';
          mkdirSync(dirname(page), { recursive: true });
          writeFileSync(page, refreshPage(current, report));
        }
        process.stdout.write(
          args.json ? JSON.stringify(report, null, 2) + '\n' : summaryLine(report) + '\n',
        );
      },
    )
    .demandCommand(1)
    .strict()
    .help()
    .parseAsync();
}
