/**
 * `cli-usage` — operator CLI for the machine-level usage ledger.
 *
 * `ingest` reads Claude Code transcripts and appends one record per model call
 * to the ledger. It prints counts only, never any transcript content.
 *
 * @module cli/usage
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  DEFAULT_MAX_SECONDS,
  ingestClaudeTranscripts,
  type IngestResult,
} from '../usage/ingest-claude.js';

export function renderIngestResult(result: IngestResult): string {
  if (result.disabled === 'remote-sandbox') {
    return 'Usage ingestion is not available in a remote sandbox; nothing was read.\n';
  }
  if (result.disabled === 'switched-off') {
    return 'Usage ingestion is switched off (AI_SDLC_USAGE_INGEST); nothing was read.\n';
  }
  const lines = [
    `Files scanned:   ${result.filesScanned}`,
    `Calls written:   ${result.callsWritten}`,
    `Repeats skipped: ${result.repeatsSkipped}`,
    `Errors:          ${result.errors}`,
    `Limit events:    ${result.limitEvents}`,
  ];
  if (result.otherScopeSkipped > 0) {
    lines.push(`Other-scope skipped: ${result.otherScopeSkipped}`);
  }
  if (result.timedOut) lines.push('Stopped at the time limit; the next run continues.');
  return `${lines.join('\n')}\n`;
}

export function buildUsageCli(argv: string[] = hideBin(process.argv)): Argv {
  return yargs(argv)
    .scriptName('cli-usage')
    .usage('Usage: $0 <command> [options]')
    .command(
      'ingest',
      'Read Claude Code transcripts and append their model calls to the usage ledger.',
      (y) =>
        y
          .option('backfill', {
            describe: 'Ignore stored cursors and read every transcript from the start.',
            type: 'boolean',
            default: false,
          })
          .option('projects-dir', {
            describe: "Transcript projects directory. Defaults to the harness's standard location.",
            type: 'string',
          })
          .option('max-seconds', {
            describe: 'Stop starting new work after this many seconds.',
            type: 'number',
            default: DEFAULT_MAX_SECONDS,
          })
          .option('json', {
            describe: 'Print the result as JSON.',
            type: 'boolean',
            default: false,
          }),
      async (args) => {
        const result = await ingestClaudeTranscripts({
          backfill: args.backfill,
          ...(typeof args['projects-dir'] === 'string'
            ? { projectsDir: args['projects-dir'] }
            : {}),
          maxSeconds: args['max-seconds'],
        });
        process.stdout.write(
          args.json ? `${JSON.stringify(result)}\n` : renderIngestResult(result),
        );
      },
    )
    .demandCommand(1, 'Specify a command, for example: ingest')
    .strict()
    .help();
}

export async function runUsageCli(): Promise<void> {
  await buildUsageCli().parseAsync();
}
