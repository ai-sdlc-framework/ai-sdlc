/**
 * CLI subcommand router for @ai-sdlc/pipeline-cli.
 *
 * RFC-0012 §4.3 third exposure: every step function is also a CLI subcommand
 * so Tier 1 (slash command body) can call it from a Bash invocation. Output
 * is JSON on stdout — Tier 1 prose parses it to drive subsequent steps.
 *
 * Subcommands map 1:1 to step functions:
 *   sweep-worktrees       — Step 0
 *   validate-task         — Step 1
 *   compute-branch        — Step 2
 *   setup-worktree        — Step 3
 *   begin-task            — Step 4
 *   build-dev-prompt      — Step 5
 *   parse-dev-return      — Step 6
 *   build-review-prompts  — Step 7
 *   aggregate-verdicts    — Step 8
 *   iterate-review-loop   — Step 9 (advanced; primary use is Tier 2)
 *   finalize-task         — Step 10
 *   push-and-pr           — Step 11
 *   sibling-prs           — Step 12
 *   cleanup-task          — Step 13
 *
 * All commands return JSON on stdout. Errors return non-zero exit + JSON on stderr.
 *
 * @module cli/index
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { aggregateVerdicts } from '../steps/08-aggregate-verdicts.js';
import { evaluateIssue, type IssueInput } from '../dor/index.js';
import { runStageACorpus } from '../dor/corpus.js';
import { readFileSync } from 'node:fs';
import { beginTask } from '../steps/04-flip-status.js';
import { buildDeveloperPrompt } from '../steps/05-build-dev-prompt.js';
import { buildReviewPrompts } from '../steps/07-build-review-prompts.js';
import { cleanupTask } from '../steps/13-cleanup.js';
import { computeBranchName } from '../steps/02-compute-branch.js';
import { finalizeTask } from '../steps/10-finalize.js';
import { parseDeveloperReturn } from '../steps/06-parse-dev-return.js';
import { pushAndPr } from '../steps/11-push-and-pr.js';
import { setupWorktree } from '../steps/03-setup-worktree.js';
import { siblingPrs } from '../steps/12-sibling-prs.js';
import { sweepMergedWorktrees } from '../steps/00-sweep.js';
import { validateTask } from '../steps/01-validate.js';
import type { AggregatedVerdict, DeveloperReturn, ReviewerVerdict } from '../types.js';

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function fail(reason: string, code = 1): never {
  process.stderr.write(JSON.stringify({ ok: false, reason }, null, 2) + '\n');
  process.exit(code);
}

/**
 * Parse a CLI option containing JSON, routing any SyntaxError through `fail()`
 * so the caller (Tier 1 prose) gets a parseable `{ok: false, reason}` envelope
 * instead of a raw stack trace from `JSON.parse`.
 */
function parseJsonOption<T>(raw: unknown, optionName: string): T {
  try {
    return JSON.parse(String(raw)) as T;
  } catch (err) {
    fail(`failed to parse --${optionName} JSON: ${(err as Error).message}`);
  }
}

/**
 * Build the yargs program. Exported so tests can drive the parser without
 * going through `process.argv`.
 */
export function buildCli(): Argv {
  const cwdDefault = (): string => process.cwd();

  return (
    yargs(hideBin(process.argv))
      .scriptName('ai-sdlc-pipeline')
      .usage('Usage: $0 <command> [options]')
      .option('work-dir', {
        alias: 'w',
        describe: 'Project root (defaults to cwd).',
        type: 'string',
        default: cwdDefault(),
      })
      // Step 0
      .command(
        'sweep-worktrees',
        'Step 0 — sweep merged worktrees from .worktrees/',
        (y) => y,
        async (argv) => {
          const result = await sweepMergedWorktrees({ workDir: argv['work-dir'] as string });
          emit(result);
        },
      )
      // Step 1
      .command(
        'validate-task <task-id>',
        'Step 1 — validate the backlog task is ready for execution',
        (y) =>
          y.positional('task-id', {
            describe: 'Backlog task ID (e.g. AISDLC-100.1)',
            type: 'string',
            demandOption: true,
          }),
        async (argv) => {
          const result = await validateTask({
            taskId: argv['task-id'] as string,
            workDir: argv['work-dir'] as string,
          });
          emit(result);
        },
      )
      // Step 2
      .command(
        'compute-branch <task-id>',
        'Step 2 — compute branch name + worktree path',
        (y) => y.positional('task-id', { type: 'string', demandOption: true }),
        async (argv) => {
          const v = await validateTask({
            taskId: argv['task-id'] as string,
            workDir: argv['work-dir'] as string,
          });
          if (!v.ok || !v.task) fail(v.reason ?? 'validation failed');
          const result = await computeBranchName({
            taskId: argv['task-id'] as string,
            task: v.task,
            workDir: argv['work-dir'] as string,
          });
          emit(result);
        },
      )
      // Step 3
      .command(
        'setup-worktree <task-id>',
        'Step 3 — setup the per-task git worktree',
        (y) =>
          y
            .positional('task-id', { type: 'string', demandOption: true })
            .option('skip-fetch', { type: 'boolean', default: false }),
        async (argv) => {
          const v = await validateTask({
            taskId: argv['task-id'] as string,
            workDir: argv['work-dir'] as string,
          });
          if (!v.ok || !v.task) fail(v.reason ?? 'validation failed');
          const branch = await computeBranchName({
            taskId: argv['task-id'] as string,
            task: v.task,
            workDir: argv['work-dir'] as string,
          });
          const result = await setupWorktree({
            taskId: argv['task-id'] as string,
            branch: branch.branch,
            worktreePath: branch.worktreePath,
            workDir: argv['work-dir'] as string,
            skipFetch: argv['skip-fetch'] as boolean,
          });
          emit({ ...branch, ...result });
        },
      )
      // Step 4
      .command(
        'begin-task <task-id>',
        'Step 4 — flip status to In Progress + write .active-task sentinel',
        (y) =>
          y
            .positional('task-id', { type: 'string', demandOption: true })
            .option('worktree-path', { type: 'string' }),
        async (argv) => {
          const v = await validateTask({
            taskId: argv['task-id'] as string,
            workDir: argv['work-dir'] as string,
          });
          if (!v.ok || !v.task) fail(v.reason ?? 'validation failed');
          const branch = await computeBranchName({
            taskId: argv['task-id'] as string,
            task: v.task,
            workDir: argv['work-dir'] as string,
          });
          const worktreePath = (argv['worktree-path'] as string | undefined) ?? branch.worktreePath;
          const result = await beginTask({
            taskId: argv['task-id'] as string,
            worktreePath,
            workDir: argv['work-dir'] as string,
          });
          emit(result);
        },
      )
      // Step 5
      .command(
        'build-dev-prompt <task-id>',
        'Step 5 — render the developer subagent prompt',
        (y) =>
          y
            .positional('task-id', { type: 'string', demandOption: true })
            .option('iteration', { type: 'number', default: 1 })
            .option('feedback', {
              type: 'string',
              describe: 'Reviewer feedback for iteration > 1',
            }),
        async (argv) => {
          const v = await validateTask({
            taskId: argv['task-id'] as string,
            workDir: argv['work-dir'] as string,
          });
          if (!v.ok || !v.task) fail(v.reason ?? 'validation failed');
          const branch = await computeBranchName({
            taskId: argv['task-id'] as string,
            task: v.task,
            workDir: argv['work-dir'] as string,
          });
          const result = await buildDeveloperPrompt({
            taskId: argv['task-id'] as string,
            task: v.task,
            branch: branch.branch,
            worktreePath: branch.worktreePath,
            iteration: argv.iteration as number,
            reviewerFeedback: argv.feedback as string | undefined,
          });
          // Don't echo the entire TaskSpec back — the prompt is what callers want.
          emit({ prompt: result.prompt, branch: branch.branch, worktreePath: branch.worktreePath });
        },
      )
      // Step 6
      .command(
        'parse-dev-return',
        'Step 6 — parse + validate the developer subagent return JSON',
        (y) =>
          y.option('return', {
            type: 'string',
            describe: "Developer's JSON return (or '-' to read from stdin)",
            demandOption: true,
          }),
        async (argv) => {
          let payload = String(argv.return);
          if (payload === '-') payload = await readStdin();
          const result = await parseDeveloperReturn({ developerReturn: payload });
          emit(result);
          if (!result.ok) process.exit(1);
        },
      )
      // Step 7
      .command(
        'build-review-prompts <task-id>',
        'Step 7 — build 3 reviewer prompts (code/test/security)',
        (y) =>
          y
            .positional('task-id', { type: 'string', demandOption: true })
            .option('worktree-path', { type: 'string' }),
        async (argv) => {
          const v = await validateTask({
            taskId: argv['task-id'] as string,
            workDir: argv['work-dir'] as string,
          });
          if (!v.ok || !v.task) fail(v.reason ?? 'validation failed');
          const branch = await computeBranchName({
            taskId: argv['task-id'] as string,
            task: v.task,
            workDir: argv['work-dir'] as string,
          });
          const worktreePath = (argv['worktree-path'] as string | undefined) ?? branch.worktreePath;
          const result = await buildReviewPrompts({
            taskId: argv['task-id'] as string,
            task: v.task,
            branch: branch.branch,
            worktreePath,
            workDir: argv['work-dir'] as string,
          });
          emit(result);
        },
      )
      // Step 8
      .command(
        'aggregate-verdicts',
        'Step 8 — aggregate the 3 reviewer verdicts',
        (y) =>
          y
            .option('verdicts', {
              type: 'string',
              demandOption: true,
              describe: "Reviewer verdict array as JSON (or '-' for stdin)",
            })
            .option('harness-note', { type: 'string', default: '' }),
        async (argv) => {
          let payload = String(argv.verdicts);
          if (payload === '-') payload = await readStdin();
          let verdicts: ReviewerVerdict[];
          try {
            verdicts = JSON.parse(payload);
          } catch (err) {
            fail(`failed to parse --verdicts JSON: ${(err as Error).message}`);
          }
          const result = await aggregateVerdicts({
            verdicts,
            harnessNote: argv['harness-note'] as string,
          });
          emit(result);
        },
      )
      // Step 10
      .command(
        'finalize-task <task-id>',
        'Step 10 — flip Done, move file to completed/, sign attestation, chore commit',
        (y) =>
          y
            .positional('task-id', { type: 'string', demandOption: true })
            .option('developer-return', { type: 'string', demandOption: true })
            .option('verdict', { type: 'string', demandOption: true })
            .option('iterations', { type: 'number', default: 1 })
            .option('worktree-path', { type: 'string' })
            .option('skip-commit', { type: 'boolean', default: false }),
        async (argv) => {
          const v = await validateTask({
            taskId: argv['task-id'] as string,
            workDir: argv['work-dir'] as string,
          });
          if (!v.ok || !v.task) fail(v.reason ?? 'validation failed');
          const branch = await computeBranchName({
            taskId: argv['task-id'] as string,
            task: v.task,
            workDir: argv['work-dir'] as string,
          });
          const worktreePath = (argv['worktree-path'] as string | undefined) ?? branch.worktreePath;
          const result = await finalizeTask({
            taskId: argv['task-id'] as string,
            workDir: argv['work-dir'] as string,
            worktreePath,
            task: v.task,
            developerReturn: parseJsonOption<DeveloperReturn>(
              argv['developer-return'],
              'developer-return',
            ),
            verdict: parseJsonOption<AggregatedVerdict>(argv.verdict, 'verdict'),
            iterations: argv.iterations as number,
            skipCommit: argv['skip-commit'] as boolean,
          });
          emit(result);
        },
      )
      // Step 11
      .command(
        'push-and-pr <task-id>',
        'Step 11 — push branch and open the PR',
        (y) =>
          y
            .positional('task-id', { type: 'string', demandOption: true })
            .option('developer-return', { type: 'string', demandOption: true })
            .option('verdict', { type: 'string', demandOption: true })
            .option('worktree-path', { type: 'string' })
            .option('needs-human-attention', { type: 'boolean', default: false }),
        async (argv) => {
          const v = await validateTask({
            taskId: argv['task-id'] as string,
            workDir: argv['work-dir'] as string,
          });
          if (!v.ok || !v.task) fail(v.reason ?? 'validation failed');
          const branch = await computeBranchName({
            taskId: argv['task-id'] as string,
            task: v.task,
            workDir: argv['work-dir'] as string,
          });
          const worktreePath = (argv['worktree-path'] as string | undefined) ?? branch.worktreePath;
          const result = await pushAndPr({
            taskId: argv['task-id'] as string,
            workDir: argv['work-dir'] as string,
            worktreePath,
            branch: branch.branch,
            task: v.task,
            developerReturn: parseJsonOption<DeveloperReturn>(
              argv['developer-return'],
              'developer-return',
            ),
            verdict: parseJsonOption<AggregatedVerdict>(argv.verdict, 'verdict'),
            needsHumanAttention: argv['needs-human-attention'] as boolean,
          });
          emit(result);
        },
      )
      // Step 12
      .command(
        'sibling-prs <task-id>',
        'Step 12 — open sibling PRs for cross-repo writes',
        (y) =>
          y
            .positional('task-id', { type: 'string', demandOption: true })
            .option('developer-return', { type: 'string', demandOption: true })
            .option('main-pr-url', { type: 'string', demandOption: true }),
        async (argv) => {
          const v = await validateTask({
            taskId: argv['task-id'] as string,
            workDir: argv['work-dir'] as string,
          });
          if (!v.ok || !v.task) fail(v.reason ?? 'validation failed');
          const result = await siblingPrs({
            taskId: argv['task-id'] as string,
            workDir: argv['work-dir'] as string,
            task: v.task,
            developerReturn: parseJsonOption<DeveloperReturn>(
              argv['developer-return'],
              'developer-return',
            ),
            mainPrUrl: argv['main-pr-url'] as string,
          });
          emit(result);
        },
      )
      // Step 13
      .command(
        'cleanup-task <task-id>',
        'Step 13 — remove the per-worktree .active-task sentinel',
        (y) =>
          y
            .positional('task-id', { type: 'string', demandOption: true })
            .option('worktree-path', { type: 'string' }),
        async (argv) => {
          let worktreePath = argv['worktree-path'] as string | undefined;
          if (!worktreePath) {
            // Best-effort derivation: <work-dir>/.worktrees/<task-id-lower>
            const taskId = String(argv['task-id']).toLowerCase();
            worktreePath = `${argv['work-dir']}/.worktrees/${taskId}`;
          }
          const result = await cleanupTask({ taskId: argv['task-id'] as string, worktreePath });
          emit(result);
        },
      )
      // RFC-0011 Phase 2a — Definition-of-Ready Stage A.
      .command(
        'dor-evaluate <issue-id>',
        'RFC-0011 Phase 2a — evaluate a single issue against Stage A (deterministic gates only).',
        (y) =>
          y
            .positional('issue-id', { type: 'string', demandOption: true })
            .option('body-file', {
              type: 'string',
              describe:
                'Path to a markdown file containing the issue body. Defaults to reading from stdin.',
            })
            .option('title', { type: 'string', default: '' })
            .option('source', {
              type: 'string',
              choices: ['github', 'backlog', 'forge', 'slack'] as const,
              default: 'backlog' as const,
            })
            .option('hermetic', {
              type: 'boolean',
              default: false,
              describe: 'Hermetic mode — only the file-existence resolver runs (no gh / fetch).',
            }),
        async (argv) => {
          const bodyFile = argv['body-file'] as string | undefined;
          const body = bodyFile ? readFileSync(bodyFile, 'utf8') : await readStdin();
          const input: IssueInput = {
            source: argv.source as IssueInput['source'],
            id: String(argv['issue-id']),
            title: String(argv.title || argv['issue-id']),
            body,
            workDir: argv['work-dir'] as string,
          };
          const verdict = await evaluateIssue(input, { hermetic: argv.hermetic as boolean });
          emit(verdict);
          if (verdict.overallVerdict === 'needs-clarification') process.exit(2);
        },
      )
      .command(
        'dor-corpus [corpus-root]',
        'RFC-0011 Phase 2a — run the Stage A regression suite against the corpus directory.',
        (y) =>
          y
            .positional('corpus-root', {
              type: 'string',
              default: 'spec/dor-corpus',
              describe: 'Path to the corpus directory (relative to --work-dir).',
            })
            .option('hermetic', { type: 'boolean', default: true })
            .option('quiet', {
              type: 'boolean',
              default: false,
              describe: 'Suppress per-failure detail; only print the summary report.',
            }),
        async (argv) => {
          const root = String(argv['corpus-root']);
          const absRoot = root.startsWith('/') ? root : `${argv['work-dir']}/${root}`;
          const report = await runStageACorpus(absRoot, {
            evaluatorOpts: { hermetic: argv.hermetic as boolean },
          });
          emit(report);
          if (report.failed > 0) process.exit(1);
        },
      )
      .demandCommand(1, 'A subcommand is required. Run with --help for the list.')
      .strict()
      .help()
      .alias('h', 'help')
      .version(false)
  );
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Run the CLI. Used by both the bin shim and integration tests.
 */
export async function runCli(): Promise<void> {
  await buildCli().parseAsync();
}
