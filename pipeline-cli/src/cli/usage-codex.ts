/**
 * `cli-usage-codex` — ingest Codex session files into the usage ledger.
 *
 * Usage: cli-usage-codex ingest [--backfill] [--sessions-dir <path>] [--json]
 *
 * Failures are reported in the summary, never as a crash: ingestion must not
 * disturb the session that triggered it.
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { ingestCodexSessions, type CodexIngestResult } from '../usage/codex-ingester.js';

export function formatCodexIngestSummary(r: CodexIngestResult): string {
  return [
    `Codex sessions scanned: ${r.filesScanned}`,
    `Calls written: ${r.written}`,
    `Repeats skipped: ${r.skipped}`,
    `Invalid records: ${r.invalid}`,
    `Limit observations: ${r.limitEvents}`,
    `Errors: ${r.errors}`,
  ].join('\n');
}

export async function runUsageCodexCli(argv: string[] = hideBin(process.argv)): Promise<void> {
  await yargs(argv)
    .scriptName('cli-usage-codex')
    .command(
      'ingest',
      'Ingest Codex session token usage into the usage ledger',
      (y) =>
        y
          .option('backfill', {
            type: 'boolean',
            default: false,
            describe: 'Ignore stored cursors and re-read every session file',
          })
          .option('sessions-dir', {
            type: 'string',
            describe:
              'Codex sessions directory (default: $CODEX_HOME/sessions or ~/.codex/sessions)',
          })
          .option('json', {
            type: 'boolean',
            default: false,
            describe: 'Print the summary as JSON',
          }),
      (args) => {
        const result = ingestCodexSessions({
          backfill: args.backfill,
          sessionsDir: args.sessionsDir,
        });
        process.stdout.write(
          `${args.json ? JSON.stringify(result) : formatCodexIngestSummary(result)}\n`,
        );
      },
    )
    .demandCommand(1)
    .strict()
    .help()
    .parseAsync();
}
