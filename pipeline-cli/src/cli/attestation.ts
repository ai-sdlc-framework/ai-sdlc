/**
 * `cli-attestation` — RFC-0042 Phase 1-3 attestation CLI.
 *
 * Operator and slash-command-body surfaces for the proof-of-execution
 * attestation workflow:
 *   - inspecting reviewer-subagent transcript files (Phase 1.1 / 383.1)
 *   - computing Merkle roots and inclusion proofs over the committed
 *     leaf index (Phase 1.2 / 383.2)
 *   - emitting transcript leaves after each reviewer run (Phase 3 / 383.8)
 *
 * Subcommands:
 *   transcripts list [<task-id>]  — list captured transcripts with metadata
 *   merkle-root                   — print current Merkle root + leaf count
 *   merkle-proof <index>          — print inclusion proof for a leaf by index
 *   emit-leaf                     — append a transcript leaf for one reviewer run
 *
 * Output is plain text by default; pass `--json` for machine-readable JSON
 * on the merkle-* subcommands; transcripts list accepts `--json` for the same.
 *
 * @module cli/attestation
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  appendLeaf,
  computeMerkleRoot,
  generateNonce,
  hashLeaf,
  loadLeaves,
  type TranscriptLeaf,
  verifyInclusion,
} from '../attestation/merkle.js';
import {
  formatV6Envelope,
  resolveSigningKeyPath,
  signAndWriteV6Envelope,
  type AttestationEnvelopeV6,
} from '../attestation/sign-v6.js';
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
            verified = verifyInclusion(leafHash, proof, root, idx, leaves.length);
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
      // ── sign-v6 ─────────────────────────────────────────────────────────────────
      .command(
        'sign-v6',
        'Build and sign a v6 attestation envelope (RFC-0042 Phase 2). ' +
          'Reads leaves from .ai-sdlc/transcript-leaves.jsonl, selects the PR subset ' +
          'by --task-id, signs the Merkle root, and writes .ai-sdlc/attestations/<head-sha>.v6.dsse.json.',
        (y: Argv) =>
          y
            .option('task-id', {
              type: 'string',
              demandOption: true,
              describe:
                'Task ID to select which transcript leaves belong to this PR (e.g. AISDLC-383.3).',
            })
            .option('head-sha', {
              type: 'string',
              demandOption: true,
              describe: 'Git commit SHA (40 hex chars) to bind the envelope to.',
            })
            .option('key-path', {
              type: 'string',
              describe:
                'Path to the operator ed25519 private key PEM. ' +
                'Defaults to AISDLC_SIGNING_KEY_PATH env or ~/.ai-sdlc/signing-key.pem.',
            }),
        (args) => {
          const repoRoot = resolveRepoRoot(args['repo-root'] as string | undefined);
          const taskId = args['task-id'] as string;
          const headSha = args['head-sha'] as string;
          const keyPathArg = args['key-path'] as string | undefined;

          // Resolve signing key path: CLI arg > env var > default.
          const keyPath = keyPathArg ?? resolveSigningKeyPath();
          if (!keyPath) {
            process.stderr.write(
              '[cli-attestation] sign-v6: no signing key found. ' +
                'Set AISDLC_SIGNING_KEY_PATH, --key-path, or run /ai-sdlc init-signing-key.\n',
            );
            process.exit(1);
          }
          if (!existsSync(keyPath)) {
            process.stderr.write(`[cli-attestation] sign-v6: key file not found: ${keyPath}\n`);
            process.exit(1);
          }
          const privateKeyPem = readFileSync(keyPath, 'utf8');

          // Build signer identity (informational).
          const identity =
            process.env['GIT_AUTHOR_EMAIL'] ||
            process.env['EMAIL'] ||
            `${userInfo().username}@local`;
          const machine = hostname();
          const signerIdentity = `${identity}:${machine}`;

          let outPath: string;
          try {
            outPath = signAndWriteV6Envelope({
              repoRoot,
              headSha,
              taskId,
              privateKeyPem,
              signerIdentity,
            });
          } catch (err) {
            process.stderr.write(`[cli-attestation] sign-v6: ${(err as Error).message}\n`);
            process.exit(1);
          }

          emitText(outPath);
        },
      )
      // ── inspect-v6 ──────────────────────────────────────────────────────────────
      .command(
        'inspect-v6 <envelope>',
        'Pretty-print a v6 attestation envelope from file. ' +
          'Pass --json to get machine-readable output.',
        (y: Argv) =>
          y
            .positional('envelope', {
              type: 'string',
              demandOption: true,
              describe: 'Absolute or relative path to a .v6.dsse.json envelope file.',
            })
            .option('json', {
              type: 'boolean',
              default: false,
              describe: 'Emit the envelope as raw JSON instead of human-readable format.',
            }),
        (args) => {
          const envelopePath = resolve(args['envelope'] as string);

          if (!existsSync(envelopePath)) {
            process.stderr.write(`[cli-attestation] inspect-v6: file not found: ${envelopePath}\n`);
            process.exit(1);
          }

          let envelope: AttestationEnvelopeV6;
          try {
            envelope = JSON.parse(readFileSync(envelopePath, 'utf8')) as AttestationEnvelopeV6;
          } catch (err) {
            process.stderr.write(
              `[cli-attestation] inspect-v6: failed to parse envelope: ${(err as Error).message}\n`,
            );
            process.exit(1);
          }

          if (envelope.schemaVersion !== 'v6') {
            process.stderr.write(
              `[cli-attestation] inspect-v6: not a v6 envelope (schemaVersion='${envelope.schemaVersion}')\n`,
            );
            process.exit(1);
          }

          if (args['json']) {
            emitJson(envelope);
          } else {
            emitText(formatV6Envelope(envelope));
          }
        },
      )
      // ── emit-leaf ───────────────────────────────────────────────────────────────
      .command(
        'emit-leaf',
        'Append a transcript leaf to .ai-sdlc/transcript-leaves.jsonl after a reviewer run. ' +
          'Idempotent: skips if a leaf with the same (taskId, reviewerName, transcriptHash) already exists. ' +
          'Required before v6 signing (RFC-0042 Phase 3 / AISDLC-383.8).',
        (y: Argv) =>
          y
            .option('task-id', {
              type: 'string',
              demandOption: true,
              describe: 'Task ID, e.g. AISDLC-383.8.',
            })
            .option('reviewer', {
              type: 'string',
              demandOption: true,
              describe:
                'Reviewer name: code-reviewer | test-reviewer | security-reviewer | ' +
                'code-reviewer-codex | test-reviewer-codex.',
            })
            .option('transcript-path', {
              type: 'string',
              demandOption: true,
              describe:
                'Absolute path to the reviewer transcript JSONL file whose SHA-256 is hashed into the leaf.',
            })
            .option('verdict-path', {
              type: 'string',
              demandOption: true,
              describe:
                'Absolute path to the verdict JSON file (shape: { approved, findings: { critical, major, minor, suggestion } }).',
            })
            .option('head-sha', {
              type: 'string',
              demandOption: true,
              describe: '40-char hex git commit SHA of the PR head. Used to generate the nonce.',
            })
            .option('harness', {
              type: 'string',
              demandOption: true,
              describe: 'Harness: claude-code | codex.',
            })
            .option('model', {
              type: 'string',
              demandOption: true,
              describe: 'LLM model identifier, e.g. claude-sonnet-4-6.',
            }),
        (args) => {
          const repoRoot = resolveRepoRoot(args['repo-root'] as string | undefined);
          const taskId = args['task-id'] as string;
          const reviewerName = args['reviewer'] as string;
          const transcriptPath = resolve(args['transcript-path'] as string);
          const verdictPath = resolve(args['verdict-path'] as string);
          const headSha = args['head-sha'] as string;
          const harness = args['harness'] as string;
          const model = args['model'] as string;

          // Validate transcript file exists.
          if (!existsSync(transcriptPath)) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: transcript file not found: ${transcriptPath}\n`,
            );
            process.exit(1);
          }

          // Validate verdict file exists.
          if (!existsSync(verdictPath)) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: verdict file not found: ${verdictPath}\n`,
            );
            process.exit(1);
          }

          // Compute SHA-256 of the transcript file.
          const transcriptContent = readFileSync(transcriptPath);
          const transcriptHash = createHash('sha256').update(transcriptContent).digest('hex');

          // Parse verdict JSON.
          let verdict: {
            approved?: boolean;
            verdictApproved?: boolean;
            findings?: { critical?: number; major?: number; minor?: number; suggestion?: number };
          };
          try {
            verdict = JSON.parse(readFileSync(verdictPath, 'utf8')) as typeof verdict;
          } catch (err) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: failed to parse verdict file: ${(err as Error).message}\n`,
            );
            process.exit(1);
          }

          // Extract verdictApproved (supports both `approved` and `verdictApproved` keys for
          // compatibility with the slash-command-body verdicts format which uses `approved`).
          const verdictApproved = Boolean(verdict.verdictApproved ?? verdict.approved ?? false);

          const findings = {
            critical: verdict.findings?.critical ?? 0,
            major: verdict.findings?.major ?? 0,
            minor: verdict.findings?.minor ?? 0,
            suggestion: verdict.findings?.suggestion ?? 0,
          };

          // Idempotency check: skip if a leaf with this (taskId, reviewerName, transcriptHash) triple exists.
          const existingLeaves = loadLeaves(repoRoot);
          const alreadyEmitted = existingLeaves.some(
            (l) =>
              l.taskId === taskId &&
              l.reviewerName === reviewerName &&
              l.transcriptHash === transcriptHash,
          );

          if (alreadyEmitted) {
            emitText(
              `[cli-attestation] emit-leaf: leaf already exists for (${taskId}, ${reviewerName}, ${transcriptHash.slice(0, 8)}...) — skipping (idempotent)`,
            );
            return;
          }

          // Determine next leafIndex (sequential across ALL leaves in the file, not just this task).
          const leafIndex = existingLeaves.length;

          // Generate nonce bound to this PR's head SHA (replay-resistance per RFC-0042 §Nonce binding).
          const nonce = generateNonce(headSha);

          const signedAt = new Date().toISOString();

          const leaf: TranscriptLeaf = {
            leafIndex,
            taskId,
            reviewerName,
            transcriptHash,
            nonce,
            harness,
            model,
            verdictApproved,
            findings,
            signedAt,
          };

          // Append atomically via write-to-tmp + renameSync.
          // Concurrent callers on different reviewer subagents are expected to be
          // sequential in the slash command body (reviewers complete, THEN emit-leaf
          // is called per-reviewer) so the TOCTOU window is minimal. On the rare
          // case of a true race, the last writer wins and the index-mismatch warning
          // in loadLeaves() will surface it on the next run. A follow-up advisory
          // lock can be added when parallel emission is required (tracked as a
          // known limitation in the AISDLC-383.8 PR body).
          appendLeaf(leaf, repoRoot);

          emitText(
            `[cli-attestation] emit-leaf: leaf #${leafIndex} appended ` +
              `(taskId=${taskId}, reviewer=${reviewerName}, ` +
              `transcriptHash=${transcriptHash.slice(0, 8)}..., approved=${verdictApproved})`,
          );
        },
      )
      .demandCommand(
        1,
        'Specify a subcommand (e.g. transcripts list, merkle-root, merkle-proof, sign-v6, inspect-v6, emit-leaf)',
      )
      .help()
      .alias('h', 'help')
      .version(false)
  );
}

/** Entry point for the bin shim. */
export async function runAttestationCli(): Promise<void> {
  await buildAttestationCli(hideBin(process.argv)).parseAsync();
}
