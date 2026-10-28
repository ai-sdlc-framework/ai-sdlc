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
 *   compare [--bar] [--json]            — staged (shadow) vs gating reviewers, per case
 *
 * `--repo-root` may be repeated to aggregate a ledger corpus across multiple
 * checkouts (e.g. this repo + a sibling dogfood repo) — see
 * `docs/operations/attestation-runbook.md` (or the relevant runbook section)
 * for the multi-repo workflow.
 *
 * @module cli/reviews
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadAllReviewLedgers, type ReviewLedgerRecord } from '../attestation/reviews-ledger.js';
import {
  corpusToJsonl,
  gitDiffInputResolver,
  isSafeRef,
  ledgerToReviewerSetCorpus,
} from '../judgment/reviewer-set-corpus.js';
import {
  formatRoundReport,
  loadAllRoundRecords,
  summarizeRounds,
} from '../incremental-review/review-rounds.js';
import { analyzeReviewLedger, formatReviewAnalysis } from '../attestation/reviews-analysis.js';
import { compareStagedToGating, formatComparison } from '../attestation/reviews-compare.js';
import { writeEvent, type OrchestratorEvent } from '../orchestrator/events.js';

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

/** Records one orchestrator event; a no-op unless the orchestrator events stream is enabled. */
export type ReviewsEventEmitter = (event: {
  type: OrchestratorEvent['type'];
  taskId?: string;
  [k: string]: unknown;
}) => void;

const defaultEmitter: ReviewsEventEmitter = (event) => writeEvent({ ...event, ts: '' });

export function buildReviewsCli(
  argv: string[],
  deps: { emit?: ReviewsEventEmitter } = {},
): ReturnType<typeof yargs> {
  const emit = deps.emit ?? defaultEmitter;
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
    .command(
      'compare',
      'RFC-0052: compare the staged review set (shadow, gating: false) with the gating reviewers ' +
        'per case: staged-only, standalone-only and agreed findings, a separate security ' +
        'section, and flagged cases (a blocking finding only one side raised) listed first. ' +
        'Each flagged case emits ReviewComparisonFlagged. --bar reports the relax-bar status.',
      (y: Argv) =>
        y
          .option('repo-root', {
            type: 'array',
            string: true,
            default: [] as string[],
            describe: 'Repo root holding .ai-sdlc/reviews/. Repeatable. Defaults to cwd.',
          })
          .option('bar', {
            type: 'boolean',
            default: false,
            describe: 'Report compared PRs and act-band precision against 50 PRs and 0.95.',
          })
          .option('events', {
            type: 'boolean',
            default: true,
            describe: 'Emit ReviewComparisonFlagged per flagged case (--no-events to skip).',
          })
          .option('json', { type: 'boolean', default: false }),
      (args) => {
        const report = compareStagedToGating(
          loadCorpus((args['repo-root'] as string[] | undefined) ?? []),
        );
        if (args['events']) {
          for (const c of report.cases.filter((x) => x.flagged)) {
            emit({
              type: 'ReviewComparisonFlagged',
              taskId: c.taskId,
              commitSha: c.commitSha,
              iteration: c.iteration,
              stagedOnlyBlocking: c.stagedOnlyBlocking,
              standaloneOnlyBlocking: c.standaloneOnlyBlocking,
            });
          }
        }
        if (args['json']) emitJson(report);
        else emitText(formatComparison(report, { bar: args['bar'] as boolean }));
      },
    )
    .command(
      'rounds',
      'AISDLC-725: report the share of 2nd+ review rounds that ran as delta reviews and the ' +
        'average tokens per round by round number, from the per-task local review state.',
      (y: Argv) =>
        y
          .option('repo-root', {
            type: 'array',
            string: true,
            default: [] as string[],
            describe: 'Repo root (its .worktrees/* are scanned too). Defaults to cwd.',
          })
          .option('json', { type: 'boolean', default: false }),
      (args) => {
        const roots = (args['repo-root'] as string[] | undefined) ?? [];
        const records = (roots.length > 0 ? roots : [process.cwd()]).flatMap((r) =>
          loadAllRoundRecords(resolve(r)),
        );
        const report = summarizeRounds(records);
        if (args['json']) emitJson(report);
        else emitText(formatRoundReport(report));
      },
    )
    .command(
      'reviewer-set-corpus',
      'Convert the ledger to a labelled JSONL corpus for ' +
        '`cli-judgment eval review.reviewer-set`. A PR is labelled as disagreeing with a ' +
        'merged-set selection when a code or test reviewer recorded a critical or major ' +
        'first-pass finding.',
      (y: Argv) =>
        y
          .option('repo-root', {
            type: 'string',
            describe: 'Repo root holding .ai-sdlc/reviews/ and the commits. Defaults to cwd.',
          })
          .option('base-ref', {
            type: 'string',
            default: 'origin/main',
            describe: 'Ref the recorded commits are diffed against.',
          })
          .option('out', {
            type: 'string',
            describe: 'Write the JSONL here instead of stdout.',
          }),
      (args) => {
        const baseRef = args['base-ref'] as string;
        if (!isSafeRef(baseRef)) {
          process.stderr.write(`invalid --base-ref '${baseRef}': must not start with '-'\n`);
          process.exitCode = 2;
          return;
        }
        const root = resolve((args['repo-root'] as string | undefined) ?? process.cwd());
        const { items, skipped } = ledgerToReviewerSetCorpus(
          loadCorpus([root]),
          gitDiffInputResolver(root, baseRef),
        );
        const text = corpusToJsonl(items);
        const out = args['out'] as string | undefined;
        if (out) writeFileSync(resolve(out), text);
        else process.stdout.write(text);
        process.stderr.write(`${items.length} PRs written, ${skipped.length} skipped\n`);
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
