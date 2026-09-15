/**
 * `cli-reviews` — reviewer marginal-value analysis CLI (AISDLC-616).
 *
 * Reads the append-only reviews ledger (`.ai-sdlc/reviews/*.jsonl`, written
 * by `cli-attestation emit-leaf`) and reports, per reviewer role, the
 * metrics that answer the motivating question: **does running 3 reviewers
 * catch materially more blocking defects than 1 would?**
 *
 * Subcommands:
 *   analyze [--repo-root ...] [--json]  — compute + print the analysis
 *
 * `--repo-root` may be repeated to aggregate a ledger corpus across multiple
 * checkouts (e.g. this repo + a sibling dogfood repo) — see
 * `docs/operations/attestation-runbook.md` (or the relevant runbook section)
 * for the multi-repo workflow.
 *
 * @module cli/reviews
 */

import { resolve } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadAllReviewLedgers, type ReviewLedgerRecord } from '../attestation/reviews-ledger.js';
import { analyzeReviewLedger, formatReviewAnalysis } from '../attestation/reviews-analysis.js';

function emitText(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/**
 * Load and concatenate ledger records from every `--repo-root` given
 * (defaulting to `process.cwd()` when none are passed).
 */
export function loadCorpus(repoRoots: string[]): ReviewLedgerRecord[] {
  const roots = repoRoots.length > 0 ? repoRoots : [process.cwd()];
  const records: ReviewLedgerRecord[] = [];
  for (const root of roots) {
    records.push(...loadAllReviewLedgers(resolve(root)));
  }
  return records;
}

export function buildReviewsCli(argv: string[]): ReturnType<typeof yargs> {
  return yargs(argv)
    .scriptName('cli-reviews')
    .usage('Usage: $0 <command> [options]')
    .strict()
    .command(
      'analyze',
      'Analyze the append-only reviews ledger and report per-role block rate, ' +
        'sole-blocker rate, cross-reviewer finding overlap, and McNemar-style ' +
        'discordant-pair counts (AISDLC-616).',
      (y: Argv) =>
        y
          .option('repo-root', {
            type: 'array',
            string: true,
            default: [] as string[],
            describe:
              'Absolute path to a repo root containing .ai-sdlc/reviews/. Repeatable to ' +
              'aggregate a corpus across multiple checkouts. Defaults to process.cwd().',
          })
          .option('json', {
            type: 'boolean',
            default: false,
            describe: 'Emit JSON instead of a human-readable table.',
          }),
      (args) => {
        const repoRoots = (args['repo-root'] as string[] | undefined) ?? [];
        const records = loadCorpus(repoRoots);
        const result = analyzeReviewLedger(records);

        if (args['json']) {
          emitJson(result);
        } else {
          emitText(formatReviewAnalysis(result));
        }
      },
    )
    .demandCommand(1, 'Specify a subcommand (e.g. analyze)')
    .help()
    .alias('h', 'help')
    .version(false);
}

/** Entry point for the bin shim. */
export async function runReviewsCli(): Promise<void> {
  await buildReviewsCli(hideBin(process.argv)).parseAsync();
}
