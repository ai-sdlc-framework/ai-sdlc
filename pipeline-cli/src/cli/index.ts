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
import { executeCommand } from './execute.js';
import { aggregateVerdicts } from '../steps/08-aggregate-verdicts.js';
import { evaluateIssue, type IssueInput } from '../dor/index.js';
import { runStageACorpus } from '../dor/corpus.js';
import { refineBacklogTask } from '../dor/ingress-claude.js';
import { decideStaleness } from '../dor/staleness.js';
import { loadDorConfig } from '../dor/dor-config.js';
import { appendCalibrationEntry } from '../dor/calibration-log.js';
import {
  renderClarificationComment,
  renderAdmitComment,
  renderPrTasksComment,
  type PrTaskVerdict,
  type RenderCommentOpts,
} from '../dor/comment-loop.js';
import { computePrViolations } from '../dor/pr-violations.js';
import type { RefinementVerdict } from '../dor/types.js';
import {
  checkReviewerCache,
  DEFAULT_CACHE_TTL_HOURS,
  saveReviewerCache,
  type ReviewerName as CacheReviewerName,
} from '../orchestrator/reviewer-cache.js';
import { runReconcile, type RunReconcileOptions } from '../orchestrator/reconcile.js';
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
      // AISDLC-182 — umbrella execute subcommand. Registered FIRST so it
      // appears at the top of `--help` (yargs lists subcommands in
      // registration order). Composes Steps 0-13 via `executePipeline()`.
      .command(executeCommand())
      // AISDLC-418 — reconcile sub-tick (orchestrator-tick Steps 3.3-3.8).
      // Single bash call that wraps salvage transcripts + emit leaves +
      // sign attestation + force-push chore + flip draft→ready + arm
      // auto-merge + clean verdict. Reviewer fan-out remains in the
      // slash command body (Agent is only available there); reconcile is
      // invoked AFTER the slash body has written the aggregated reviewer
      // verdicts to `.ai-sdlc/verdicts/<task-id-lower>.json`.
      .command(
        'reconcile <task-id>',
        'AISDLC-418 — reconcile sub-tick (Steps 3.3-3.8): salvage transcripts, emit leaves, sign attestation, force-push, flip draft→ready, arm auto-merge.',
        (y) =>
          y
            .positional('task-id', { type: 'string', demandOption: true })
            .option('worktree-path', {
              type: 'string',
              describe:
                'Override the worktree path (defaults to <work-dir>/.worktrees/<task-id-lower>).',
            })
            .option('board-dir', {
              type: 'string',
              describe:
                'Override the Dispatch Board dir (defaults to <work-dir>/.ai-sdlc/dispatch).',
            })
            .option('reviewer-agent-ids', {
              type: 'string',
              describe:
                'JSON map of {reviewer-name: agent-id} for /private/tmp transcript salvage (AC #3). Reviewer agent IDs are returned by the slash command body when it fires the parallel Agent calls.',
            })
            .option('skip-push', { type: 'boolean', default: false })
            .option('skip-flip-ready', { type: 'boolean', default: false })
            .option('skip-arm-auto-merge', { type: 'boolean', default: false })
            .option('schema-version', {
              type: 'string',
              choices: ['v5', 'v6'] as const,
              describe: 'Override the attestation schema version (default: v6 per AISDLC-409).',
            })
            .option('reviewer-model', {
              type: 'string',
              describe:
                "Override the model passed to `cli-attestation emit-leaf` (default: 'claude-sonnet-4-6').",
            })
            .option('harness', {
              type: 'string',
              describe: "Override the harness label (default: 'claude-code').",
            }),
        async (argv) => {
          const opts: RunReconcileOptions = {
            workDir: argv['work-dir'] as string,
            taskId: argv['task-id'] as string,
            skipPush: argv['skip-push'] as boolean,
            skipFlipReady: argv['skip-flip-ready'] as boolean,
            skipArmAutoMerge: argv['skip-arm-auto-merge'] as boolean,
          };
          if (argv['worktree-path']) opts.worktreePath = argv['worktree-path'] as string;
          if (argv['board-dir']) opts.boardDir = argv['board-dir'] as string;
          if (argv['schema-version']) {
            opts.schemaVersion = argv['schema-version'] as 'v5' | 'v6';
          }
          if (argv['reviewer-model']) opts.reviewerModel = argv['reviewer-model'] as string;
          if (argv['harness']) opts.harness = argv['harness'] as string;
          if (argv['reviewer-agent-ids']) {
            opts.reviewerAgentIds = parseJsonOption(
              argv['reviewer-agent-ids'],
              'reviewer-agent-ids',
            );
          }
          const result = runReconcile(opts);
          emit(result);
          if (result.outcome === 'failed') process.exit(1);
        },
      )
      // AISDLC-418 — reviewer-pass cache. Two subcommands:
      //   reviewer-cache check <task-id> --reviewer <name> --files <json>
      //   reviewer-cache save  <task-id> --reviewer <name> --files <json> --verdict <json>
      // The slash body's iterate-needed branch invokes `check` before
      // firing each reviewer Agent; cache HIT → reuse the prior verdict.
      // `save` is invoked after every reviewer Agent completes.
      .command(
        'reviewer-cache <action> <task-id>',
        'AISDLC-418 — reviewer-pass cache: check (probe for a reusable verdict) or save (persist this iteration).',
        (y) =>
          y
            .positional('action', {
              type: 'string',
              choices: ['check', 'save'] as const,
              demandOption: true,
            })
            .positional('task-id', { type: 'string', demandOption: true })
            .option('reviewer', { type: 'string', demandOption: true })
            .option('files', {
              type: 'string',
              demandOption: true,
              describe:
                "JSON array of file paths in this iteration's diff (paths relative to workdir).",
            })
            .option('agent-file', {
              type: 'string',
              describe:
                "Path to the reviewer's .md agent definition. Defaults to ai-sdlc-plugin/agents/<reviewer>.md inside --work-dir.",
            })
            .option('ttl-hours', { type: 'number', default: DEFAULT_CACHE_TTL_HOURS })
            .option('verdict', {
              type: 'string',
              describe:
                "(save only) JSON object of the reviewer verdict, OR '@<path>' to read it from disk.",
            })
            .option('verdict-path', {
              type: 'string',
              describe:
                '(save only) Path-on-disk to record alongside the cached verdict (workdir-relative).',
            }),
        async (argv) => {
          const action = String(argv.action) as 'check' | 'save';
          const taskId = String(argv['task-id']);
          const reviewer = String(argv.reviewer) as CacheReviewerName;
          const workDir = argv['work-dir'] as string;
          const files = parseJsonOption<string[]>(argv.files, 'files');
          const agentFile =
            (argv['agent-file'] as string | undefined) ??
            `${workDir}/ai-sdlc-plugin/agents/${reviewer}.md`;
          if (action === 'check') {
            const result = checkReviewerCache({
              workDir,
              taskId,
              reviewer,
              currentFiles: files,
              agentFilePath: agentFile,
              ttlHours: argv['ttl-hours'] as number,
            });
            emit(result);
            return;
          }
          // save
          const verdictRaw = argv.verdict as string | undefined;
          if (!verdictRaw) fail('--verdict is required for reviewer-cache save');
          let verdictObj: Record<string, unknown>;
          if (verdictRaw.startsWith('@')) {
            try {
              verdictObj = JSON.parse(readFileSync(verdictRaw.slice(1), 'utf8')) as Record<
                string,
                unknown
              >;
            } catch (err) {
              fail(`failed to read --verdict file: ${(err as Error).message}`);
            }
          } else {
            verdictObj = parseJsonOption<Record<string, unknown>>(verdictRaw, 'verdict');
          }
          const verdictPath =
            (argv['verdict-path'] as string | undefined) ??
            (verdictRaw.startsWith('@') ? verdictRaw.slice(1) : '');
          const saveOpts: Parameters<typeof saveReviewerCache>[0] = {
            workDir,
            taskId,
            reviewer,
            files,
            agentFilePath: agentFile,
            verdict: verdictObj as Parameters<typeof saveReviewerCache>[0]['verdict'],
          };
          if (verdictPath) saveOpts.verdictPath = verdictPath;
          const target = saveReviewerCache(saveOpts);
          emit({ ok: true, path: target });
        },
      )
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
          // AISDLC-161: persist a calibration entry on EVERY evaluation so the
          // GitHub Action ingress (`dor-ingress.yml`) accumulates a corpus the
          // FP-rate aggregator can chew on. Pre-AISDLC-161, only the
          // `dor-refine-task` (backlog) path wrote calibration; the
          // `dor-evaluate` (GitHub issues + PR-tasks) path silently produced
          // ZERO calibration data. The workflow is responsible for setting
          // ARTIFACTS_DIR to a path that survives the job (then uploads
          // `<ARTIFACTS_DIR>/_dor/calibration.jsonl` as a workflow artifact).
          // Wrapped in try/catch so a calibration log failure never poisons
          // the verdict — the verdict is the user-facing contract; the log
          // is observability infrastructure.
          try {
            appendCalibrationEntry({
              issue: { id: input.id, source: input.source, title: input.title, body },
              // StageAVerdict is a structural superset of RefinementVerdict
              // (same fields + `durationMs` extra); rubricVersion is `'v1'`
              // by construction in evaluate.ts. The cast launders the
              // wider StageAVerdict.rubricVersion typing for the calibration
              // log writer.
              verdict: verdict as unknown as RefinementVerdict,
              outcome: verdict.overallVerdict,
              ...(input.authorIdentity ? { author: input.authorIdentity } : {}),
            });
          } catch (err) {
            process.stderr.write(
              `[ai-sdlc/dor] calibration log append failed (non-fatal): ${(err as Error).message}\n`,
            );
          }
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
      // RFC-0011 Phase 3 (AISDLC-115.4) — Claude Code subagent ingress shim.
      .command(
        'dor-refine-task <task-id>',
        'RFC-0011 Phase 3 — run the DoR gate against a backlog task and write the calibration log entry. Stage A only (hermetic) — Stage B is layered in by the slash command body via subagent dispatch.',
        (y) =>
          y
            .positional('task-id', { type: 'string', demandOption: true })
            .option('hermetic', { type: 'boolean', default: true }),
        async (argv) => {
          const result = await refineBacklogTask(String(argv['task-id']), {
            workDir: argv['work-dir'] as string,
            evaluateOpts: { hermetic: argv.hermetic as boolean },
          });
          emit(result);
          if (result.shouldRefuseExecution) process.exit(2);
        },
      )
      // RFC-0011 Phase 3 — staleness decider for the cron sweeper.
      .command(
        'dor-staleness-decide',
        'RFC-0011 Phase 3 — decide warn/close action for a needs-clarification candidate.',
        (y) =>
          y
            .option('issue-id', { type: 'string', demandOption: true })
            .option('last-activity-at', {
              type: 'string',
              demandOption: true,
              describe: 'ISO-8601 timestamp of the last author activity.',
            })
            .option('warned-at', { type: 'string' })
            .option('now', { type: 'string' }),
        (argv) => {
          const config = loadDorConfig({ workDir: argv['work-dir'] as string }).staleness;
          const decision = decideStaleness(
            {
              issueId: String(argv['issue-id']),
              lastAuthorActivityAt: String(argv['last-activity-at']),
              warnedAt: argv['warned-at'] as string | undefined,
            },
            {
              now: argv.now ? new Date(String(argv.now)) : undefined,
              config,
            },
          );
          emit(decision);
        },
      )
      // RFC-0011 Phase 3 — render the DoR comment from a verdict file.
      // Single source of truth for comment composition: GitHub Action shim,
      // Claude Code subagent shim, and any future Slack/Forge shim all call
      // this so the `redactSecrets()` pass in `comment-loop.ts` runs against
      // every render path. Avoids re-implementing the renderer inline in
      // `actions/github-script` (which previously bypassed redaction and
      // could leak `gate-3` finding text containing extracted URLs / paths
      // verbatim into the public comment).
      .command(
        'dor-render-comment',
        'RFC-0011 Phase 3 — render a DoR clarification or admit comment from a verdict JSON.',
        (y) =>
          y
            .option('verdict-file', {
              type: 'string',
              demandOption: true,
              describe:
                "Path to a verdict JSON file (or '-' to read from stdin). Shape: RefinementVerdict.",
            })
            .option('channel', {
              type: 'string',
              choices: ['author', 'dedicated-slack', 'dedicated-github'] as const,
              default: 'author' as const,
              describe: 'Channel marker scope — drives the HTML idempotency marker.',
            })
            .option('rubric-url', {
              type: 'string',
              describe: 'Override for the rubric docs URL surfaced in the comment header.',
            })
            .option('mode', {
              type: 'string',
              choices: ['auto', 'clarification', 'admit'] as const,
              default: 'auto' as const,
              describe: "Force a specific renderer. 'auto' picks based on verdict.overallVerdict.",
            }),
        async (argv) => {
          const file = String(argv['verdict-file']);
          const raw = file === '-' ? await readStdin() : readFileSync(file, 'utf8');
          let verdict: RefinementVerdict;
          try {
            verdict = JSON.parse(raw) as RefinementVerdict;
          } catch (err) {
            fail(`failed to parse verdict JSON from ${file}: ${(err as Error).message}`);
          }
          const opts: RenderCommentOpts = {
            channel: argv.channel as RenderCommentOpts['channel'],
          };
          if (argv['rubric-url']) opts.rubricUrl = String(argv['rubric-url']);
          const mode = String(argv.mode) as 'auto' | 'clarification' | 'admit';
          const useAdmit =
            mode === 'admit' || (mode === 'auto' && verdict.overallVerdict === 'admit');
          const body = useAdmit
            ? renderAdmitComment(verdict, opts)
            : renderClarificationComment(verdict, opts);
          // Plain markdown on stdout — callers feed it directly into the
          // GitHub API body field. NOT JSON-wrapped because the GH Action
          // step captures stdout into an env var and posts it verbatim.
          process.stdout.write(body);
        },
      )
      // RFC-0011 Phase 3 — render the PR-tasks summary comment from a JSONL
      // of per-task verdicts. Same redaction guarantee as `dor-render-comment`:
      // every `gate.finding` is passed through `redactSecrets()` so a leaked
      // token in a task body cannot reflect into the public PR comment.
      .command(
        'dor-render-pr-summary',
        'RFC-0011 Phase 3 — render the PR-tasks summary comment from a JSONL verdict file.',
        (y) =>
          y
            .option('verdicts-file', {
              type: 'string',
              demandOption: true,
              describe: "Path to a JSONL file (or '-' for stdin). One PrTaskVerdict per line.",
            })
            .option('channel', {
              type: 'string',
              choices: ['author', 'dedicated-slack', 'dedicated-github'] as const,
              default: 'author' as const,
            }),
        async (argv) => {
          const file = String(argv['verdicts-file']);
          const raw = file === '-' ? await readStdin() : readFileSync(file, 'utf8');
          const lines = raw.split('\n').filter((l) => l.trim().length > 0);
          let verdicts: PrTaskVerdict[];
          try {
            verdicts = lines.map((l) => JSON.parse(l) as PrTaskVerdict);
          } catch (err) {
            fail(`failed to parse verdicts JSONL ${file}: ${(err as Error).message}`);
          }
          const body = renderPrTasksComment(verdicts, {
            channel: argv.channel as RenderCommentOpts['channel'],
          });
          process.stdout.write(body);
        },
      )
      // RFC-0011 / AISDLC-379 — workflow gate oracle for the DoR ingress
      // workflow. Consumes the SAME JSONL `dor-render-pr-summary` reads,
      // returns a JSON envelope `{has_violations, blocking[], overridden[]}`
      // so the GitHub Action can decide whether to fail the status check.
      // Centralising the `blocked.reason` override semantics here keeps the
      // workflow gate in lockstep with `refineBacklogTask()` (the
      // `/ai-sdlc execute` ingress shim) — the bug AISDLC-379 fixed was that
      // the workflow had NO such oracle and silently passed the check on
      // every PR regardless of how many violations were posted.
      .command(
        'dor-pr-has-violations',
        'AISDLC-379 — compute whether any PR-task verdict is blocking (needs-clarification without blocked.reason override).',
        (y) =>
          y
            .option('verdicts-file', {
              type: 'string',
              demandOption: true,
              describe: "Path to a JSONL file (or '-' for stdin). One PrTaskVerdict per line.",
            })
            .option('fail-on-violations', {
              type: 'boolean',
              default: false,
              describe:
                'When true, exit non-zero if has_violations=true. Defaults false so callers can capture the JSON and decide.',
            }),
        async (argv) => {
          const file = String(argv['verdicts-file']);
          const raw = file === '-' ? await readStdin() : readFileSync(file, 'utf8');
          const lines = raw.split('\n').filter((l) => l.trim().length > 0);
          let verdicts: PrTaskVerdict[];
          try {
            verdicts = lines.map((l) => JSON.parse(l) as PrTaskVerdict);
          } catch (err) {
            fail(`failed to parse verdicts JSONL ${file}: ${(err as Error).message}`);
          }
          const result = computePrViolations(verdicts, {
            workDir: argv['work-dir'] as string,
          });
          emit({
            has_violations: result.hasViolations,
            blocking: result.blocking.map((d) => ({
              file: d.file,
              taskId: d.taskId,
              overallVerdict: d.overallVerdict,
            })),
            overridden: result.overridden.map((d) => ({
              file: d.file,
              taskId: d.taskId,
              blockedReason: d.blockedReason,
            })),
            decisions: result.decisions.map((d) => ({
              file: d.file,
              taskId: d.taskId,
              overallVerdict: d.overallVerdict,
              hasBlockedReason: d.hasBlockedReason,
              blocking: d.blocking,
            })),
          });
          if (result.hasViolations && argv['fail-on-violations']) {
            process.exit(1);
          }
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
