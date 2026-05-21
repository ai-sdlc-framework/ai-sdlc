/**
 * `cli-attestation` — RFC-0042 Phase 1 attestation CLI.
 *
 * Operator and slash-command-body surfaces for the proof-of-execution
 * attestation workflow:
 *   - inspecting reviewer-subagent transcript files (Phase 1.1 / 383.1)
 *   - computing Merkle roots and inclusion proofs over the committed
 *     leaf index (Phase 1.2 / 383.2)
 *
 * Subcommands:
 *   transcripts list [<task-id>]  — list captured transcripts with metadata
 *   merkle-root                   — print current Merkle root + leaf count
 *   merkle-proof <index>          — print inclusion proof for a leaf by index
 *
 * Output is plain text by default; pass `--json` for machine-readable JSON
 * on the merkle-* subcommands; transcripts list accepts `--json` for the same.
 *
 * @module cli/attestation
 */

import { join, resolve } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { computeMerkleRoot, hashLeaf, loadLeaves, verifyInclusion } from '../attestation/merkle.js';
import { formatTranscriptTable, listTranscripts } from '../attestation/transcript-capture.js';

// ── Repo root resolution ──────────────────────────────────────────────────────

/**
 * Resolve the repo root from `--repo-root`, `REPO_ROOT` env, or `process.cwd()`.
 * The leaves file and transcripts dir are always relative to the repo root.
 */
function resolveRepoRoot(cwd?: string): string {
  return resolve(cwd ?? process.env['REPO_ROOT'] ?? process.cwd());
}

// ── Output helpers ────────────────────────────────────────────────────────────

function emitText(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

// ── CLI builder ───────────────────────────────────────────────────────────────

export function buildAttestationCli(argv: string[]): ReturnType<typeof yargs> {
  return (
    yargs(argv)
      .scriptName('cli-attestation')
      .usage('Usage: $0 <command> [options]')
      .option('repo-root', {
        type: 'string',
        describe:
          'Absolute path to the repo root. Defaults to REPO_ROOT env or process.cwd(). ' +
          'Transcripts are under <repo-root>/.ai-sdlc/transcripts/ and leaves under ' +
          '<repo-root>/.ai-sdlc/transcript-leaves.jsonl.',
      })
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
      // ── merkle-root ─────────────────────────────────────────────────────────────
      .command(
        'merkle-root',
        'Print the current Merkle root and leaf count from .ai-sdlc/transcript-leaves.jsonl.',
        (y: Argv) =>
          y.option('json', {
            type: 'boolean',
            default: false,
            describe: 'Emit JSON instead of plain text.',
          }),
        (args) => {
          const repoRoot = resolveRepoRoot(args['repo-root'] as string | undefined);
          const leaves = loadLeaves(repoRoot);
          const { root } = computeMerkleRoot(leaves);

          if (args['json']) {
            emitJson({
              root: root || null,
              leafCount: leaves.length,
              leavesFile: join(repoRoot, '.ai-sdlc/transcript-leaves.jsonl'),
            });
          } else {
            if (leaves.length === 0) {
              emitText('leaf count: 0\nroot: (no leaves)\n');
            } else {
              emitText(`leaf count: ${leaves.length}\nroot: ${root}\n`);
            }
          }
        },
      )
      // ── merkle-proof ────────────────────────────────────────────────────────────
      .command(
        'merkle-proof <index>',
        'Print the Merkle inclusion proof for a leaf by its 0-based array position.',
        (y: Argv) =>
          y
            .positional('index', {
              type: 'number',
              demandOption: true,
              describe:
                'Array position in the JSONL file (0-based line number, skipping invalid lines).',
            })
            .option('verify', {
              type: 'boolean',
              default: false,
              describe: 'Also verify the proof and print the result.',
            })
            .option('json', {
              type: 'boolean',
              default: false,
              describe: 'Emit JSON instead of plain text.',
            }),
        (args) => {
          const repoRoot = resolveRepoRoot(args['repo-root'] as string | undefined);
          const leaves = loadLeaves(repoRoot);

          if (leaves.length === 0) {
            process.stderr.write('[cli-attestation] no leaves found in transcript-leaves.jsonl\n');
            process.exit(1);
          }

          const idx = Number(args['index']);
          if (!Number.isInteger(idx) || idx < 0 || idx >= leaves.length) {
            process.stderr.write(
              `[cli-attestation] index ${idx} out of range (0–${leaves.length - 1})\n`,
            );
            process.exit(1);
          }

          const { root, proofs } = computeMerkleRoot(leaves);
          const proof = proofs[idx];
          const leaf = leaves[idx];
          const leafHash = hashLeaf(leaf);

          let verified: boolean | undefined;
          if (args['verify']) {
            verified = verifyInclusion(leafHash, proof, root, idx);
          }

          if (args['json']) {
            emitJson({
              leafIndex: idx,
              leafHash,
              root,
              proof,
              ...(verified !== undefined ? { verified } : {}),
            });
          } else {
            emitText(`leaf index: ${idx}`);
            emitText(`leaf hash:  ${leafHash}`);
            emitText(`root:       ${root}`);
            emitText(`proof (${proof.length} hashes):`);
            if (proof.length === 0) {
              emitText('  (empty — single-leaf tree: leaf IS the root)');
            } else {
              proof.forEach((h, i) => emitText(`  [${i}] ${h}`));
            }
            if (verified !== undefined) {
              emitText(`verified:   ${verified ? 'OK' : 'FAIL'}`);
            }
          }
        },
      )
      .demandCommand(1, 'Specify a subcommand (e.g. transcripts list, merkle-root, merkle-proof)')
      .help()
      .alias('h', 'help')
      .version(false)
  );
}

/** Entry point for the bin shim. */
export async function runAttestationCli(): Promise<void> {
  await buildAttestationCli(hideBin(process.argv)).parseAsync();
}
