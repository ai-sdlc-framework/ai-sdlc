/**
 * `cli-classify-pr` subcommand router (AISDLC-141).
 *
 * Wraps the deterministic ruleset from `../classifier/index.ts` so the slash
 * command body Step 7 + the `analyze` job in `.github/workflows/ai-sdlc-review.yml`
 * can decide which subset of the 3 reviewers to spawn. Pre-AISDLC-141 every
 * push triggered the full 3-reviewer fan-out — strict regression vs. the
 * RFC-0010 §12 design and (post-AISDLC-140) strictly worse cost-wise now that
 * the attestation shortcut is gone.
 *
 * Subcommands:
 *  - `classify`              — emit a ClassifierDecision for a PR diff
 *
 * Inputs (one of `--diff-file` | `--numstat-file` | `--paths-file` is required):
 *   --diff-file <path>       — unified-diff file (output of `git diff base...head`)
 *   --numstat-file <path>    — `git diff --numstat` file (added/removed totals)
 *   --paths-file <path>      — newline-separated path list (cheapest input)
 *   --issue-id <id>          — optional, used for the calibration-log entry
 *   --artifacts-dir <dir>    — optional, when set we append a calibration entry to
 *                              `<artifacts-dir>/_classifier/calibration.jsonl` (AC-5)
 *
 * Output: ClassifierDecision JSON on stdout. Exit 0 on success.
 *
 * Failure modes (AC-4 fall-open semantics):
 *   - If the input file can't be read we emit `decideFromInvocationFailure()`
 *     (ALL_REVIEWERS) on stdout and exit 0 — the caller (Step 7 / analyze job)
 *     should still proceed with the full fan-out, NOT abort. Logging the error
 *     goes to stderr.
 *
 * @module cli/classify-pr
 */

import { readFileSync } from 'node:fs';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  appendCalibrationEntry,
  decideFromInvocationFailure,
  decideFromRulesetOutput,
  defaultRulesetDecision,
  parseNumstat,
  parsePathsFile,
  parseUnifiedDiff,
  type CalibrationLogEntry,
  type ClassifierDecision,
  type DiffSummary,
} from '../classifier/classifier.js';

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function warn(message: string): void {
  process.stderr.write(`[cli-classify-pr] ${message}\n`);
}

/**
 * Read a DiffSummary from one of the supported input flags. Returns null when
 * none was provided AND the caller didn't pass `--allow-empty` (defensive
 * default — silent empty input would always pick the empty-diff branch).
 */
function readDiffSummary(argv: Record<string, unknown>): DiffSummary | null {
  const diffFile = argv['diff-file'] as string | undefined;
  const numstatFile = argv['numstat-file'] as string | undefined;
  const pathsFile = argv['paths-file'] as string | undefined;

  let provided = 0;
  if (diffFile) provided++;
  if (numstatFile) provided++;
  if (pathsFile) provided++;

  if (provided === 0) {
    if (argv['allow-empty']) {
      return { filesChanged: 0, paths: [], linesAdded: 0, linesRemoved: 0 };
    }
    return null;
  }
  if (provided > 1) {
    warn('exactly one of --diff-file | --numstat-file | --paths-file may be set');
    return null;
  }

  try {
    if (diffFile) return parseUnifiedDiff(readFileSync(diffFile, 'utf8'));
    if (numstatFile) return parseNumstat(readFileSync(numstatFile, 'utf8'));
    if (pathsFile) return parsePathsFile(readFileSync(pathsFile, 'utf8'));
  } catch (err) {
    warn(`failed to read input file: ${(err as Error).message}`);
    return null;
  }
  return null;
}

/**
 * Build the cli-classify-pr yargs program. Exported so tests can drive the
 * parser without going through process.argv.
 */
export function buildClassifyPrCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-classify-pr')
    .usage('Usage: $0 classify [--diff-file PATH | --numstat-file PATH | --paths-file PATH]')
    .command(
      ['classify', '$0'],
      'Classify a PR diff and emit the ClassifierDecision (RFC-0010 §12).',
      (y) =>
        y
          .option('diff-file', {
            type: 'string',
            describe: 'Path to a unified-diff file (output of `git diff base...head`).',
          })
          .option('numstat-file', {
            type: 'string',
            describe: 'Path to a `git diff --numstat` file.',
          })
          .option('paths-file', {
            type: 'string',
            describe:
              'Path to a file with one changed-file path per line (output of `git diff --name-only`).',
          })
          .option('allow-empty', {
            type: 'boolean',
            default: false,
            describe:
              'When set + no input file given, pretend the PR is empty (returns 0 reviewers). Defaults false to fail loudly on misconfiguration.',
          })
          .option('issue-id', {
            type: 'string',
            default: '',
            describe: 'Optional issue/task ID, written to the calibration log entry.',
          })
          .option('artifacts-dir', {
            type: 'string',
            describe:
              'When set, append a calibration log entry to <artifacts-dir>/_classifier/calibration.jsonl.',
          })
          .option('skip-calibration', {
            type: 'boolean',
            default: false,
            describe:
              'Suppress the calibration log write even when --artifacts-dir is provided. Used by tests.',
          }),
      async (argv) => {
        const summary = readDiffSummary(argv as unknown as Record<string, unknown>);
        let decision: ClassifierDecision;
        if (summary === null) {
          // Couldn't read input — fall open per AC-4. The caller (Step 7 /
          // analyze job) will spawn ALL 3 reviewers, never less.
          decision = decideFromInvocationFailure();
        } else {
          decision = decideFromRulesetOutput(defaultRulesetDecision(summary));
        }

        // AC-5: calibration log entry. Only written when --artifacts-dir is
        // explicitly provided so tests/CI can opt in without polluting random
        // directories.
        const artifactsDir = argv['artifacts-dir'] as string | undefined;
        const skipCalibration = argv['skip-calibration'] as boolean;
        if (artifactsDir && !skipCalibration) {
          const entry: CalibrationLogEntry = {
            timestamp: new Date().toISOString(),
            issueId: String(argv['issue-id'] ?? ''),
            diffStats: summary ?? { filesChanged: 0, paths: [], linesAdded: 0, linesRemoved: 0 },
            classifierOutput: decision.rawOutput,
            fellOpen: decision.fellOpen,
            fellOpenReason: decision.fellOpenReason,
            humanOverrideAfterMerge: null,
          };
          try {
            await appendCalibrationEntry(artifactsDir, entry);
          } catch (err) {
            // Calibration write failure must NOT block the decision. Log
            // and continue — the reviewer fan-out is the load-bearing path.
            warn(`failed to write calibration entry: ${(err as Error).message}`);
          }
        }

        emit(decision);
      },
    )
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

/**
 * Run the cli-classify-pr CLI. Used by the bin shim and integration tests.
 */
export async function runClassifyPrCli(): Promise<void> {
  await buildClassifyPrCli().parseAsync();
}
