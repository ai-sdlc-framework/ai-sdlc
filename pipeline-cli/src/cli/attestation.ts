/**
 * `cli-attestation` — RFC-0042 Phase 1 attestation CLI.
 *
 * Provides operator surfaces for inspecting and managing transcript files
 * captured by reviewer subagents.
 *
 * Subcommands:
 *   transcripts list [<task-id>]  — list captured transcripts with metadata
 *
 * @module cli/attestation
 */

import { resolve } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { formatTranscriptTable, listTranscripts } from '../attestation/transcript-capture.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve the repo root from a given cwd. Falls back to process.cwd(). */
function resolveRepoRoot(cwd?: string): string {
  return resolve(cwd ?? process.env['REPO_ROOT'] ?? process.cwd());
}

// ── CLI builder ───────────────────────────────────────────────────────────────

export function buildAttestationCli(argv: string[]): ReturnType<typeof yargs> {
  return yargs(argv)
    .scriptName('cli-attestation')
    .usage('Usage: $0 <command> [options]')
    .strict()
    .command(
      'transcripts',
      'Manage reviewer transcript files (RFC-0042 Phase 1)',
      (yargs: Argv) => {
        yargs.command(
          'list [task-id]',
          'List captured transcripts with event count and byte size',
          (yargs: Argv) => {
            yargs.positional('task-id', {
              type: 'string',
              description:
                'Filter to a specific task ID (e.g. aisdlc-383.1). Omit to list all tasks.',
              demandOption: false,
            });
            yargs.option('repo-root', {
              type: 'string',
              description: 'Override the repository root (defaults to REPO_ROOT env or cwd)',
              demandOption: false,
            });
            yargs.option('json', {
              type: 'boolean',
              description: 'Emit JSON array instead of human-readable table',
              default: false,
            });
          },
          (args) => {
            const taskId = args['task-id'] as string | undefined;
            const repoRoot = resolveRepoRoot(args['repo-root'] as string | undefined);
            const jsonOutput = args['json'] as boolean;

            const infos = listTranscripts(repoRoot, taskId);

            if (jsonOutput) {
              process.stdout.write(JSON.stringify(infos, null, 2) + '\n');
              return;
            }

            const header =
              taskId != null ? `Transcripts for task: ${taskId}` : 'All captured transcripts';

            process.stdout.write(`\n${header}\n`);
            process.stdout.write('(from ' + repoRoot + '/.ai-sdlc/transcripts/)\n\n');
            process.stdout.write(formatTranscriptTable(infos) + '\n\n');

            if (infos.length > 0) {
              const totalEvents = infos.reduce((sum, i) => sum + i.eventCount, 0);
              const totalBytes = infos.reduce((sum, i) => sum + i.byteSize, 0);
              const malformed = infos.filter((i) => !i.isWellFormed).length;
              process.stdout.write(
                `Summary: ${infos.length} file(s), ${totalEvents} event(s), ${totalBytes} bytes` +
                  (malformed > 0 ? `, ${malformed} malformed file(s)` : '') +
                  '\n',
              );
            }
          },
        );
        yargs.demandCommand(1, 'Specify a transcripts subcommand (e.g. list)');
      },
    )
    .demandCommand(1, 'Specify a subcommand (e.g. transcripts list)')
    .help()
    .alias('h', 'help')
    .version(false);
}

/** Entry point for the bin shim. */
export async function runAttestationCli(): Promise<void> {
  buildAttestationCli(hideBin(process.argv)).parse();
}
