/**
 * The execute-task host of the workflow engine (RFC-0056 phase 3), behind
 * `AI_SDLC_WORKFLOW_ENGINE=1`. It supplies what the engine does not own: the step
 * implementations (the same collaborators the Machine in `next-step/next-step.ts` calls),
 * the agent prompts, and the `next-step` reply protocol. With the flag off nothing here
 * runs; the Machine is untouched.
 *
 * @module workflow/execute-host
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultArtifactsDir, resolveProjectRoot } from '../routing/artifacts-dir.js';
import { parseDeveloperReturn } from '../steps/06-parse-dev-return.js';
import { formatFeedback } from '../steps/08-aggregate-verdicts.js';
import { DEFAULT_MAX_ITERATIONS } from '../steps/09-iterate.js';
import { ccrRefusalMessage, detectCcr, parseExecuteArg } from '../next-step/args.js';
import { runGhIssue } from '../next-step/gh-issue.js';
import { writeRunFile } from '../next-step/init.js';
import { decideResumeReview } from '../next-step/resume-decision.js';
import {
  buildSpawnDeveloper,
  buildSpawnReviewers,
  defaultNextStepDeps,
  exitCodeFor,
  extractJson,
  failRun,
  fixReportOrFail,
  readState,
  recordDeveloperResponseOf,
  recordRound,
  REPORT_SHAPE,
  rollbackStatus,
  writeState,
  type NextStepDeps,
  type NextStepInput,
  type NextStepOutput,
} from '../next-step/next-step.js';
import { bootstrapPromptFor } from '../next-step/review-prepare.js';
import {
  aggregateRound,
  parseReviewReports,
  type ReviewerReport,
} from '../next-step/review-finalize.js';
import { checkCancelSignal, updateSessionState } from '../next-step/session.js';
import { advanceStagedRound, STAGED_REPORT_SHAPE } from '../next-step/staged-round.js';
import type {
  Instruction,
  NextStepContext,
  NextStepState,
  StopInstruction,
} from '../next-step/types.js';
import {
  loadWorkflowFromBase,
  newRunState,
  WorkflowEngine,
  WorkflowRefusal,
  type EngineHost,
  type EngineNode,
  type LedgerEntry,
  type PreparedWorkflow,
  type ResultOutcome,
  type ShadowResult,
  type ShadowSpawn,
  type SpawnOutcome,
  type StepOutcome,
  type WorkflowRunState,
} from './engine.js';

/** `1` routes `next-step` through the engine; unset or anything else runs the Machine. */
export const WORKFLOW_ENGINE_FLAG = 'AI_SDLC_WORKFLOW_ENGINE';

export function workflowEngineEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[WORKFLOW_ENGINE_FLAG] === '1';
}

/** Impl ids the execute host implements: the 14 steps of the default document. */
export const EXECUTE_IMPLS: ReadonlySet<string> = new Set([
  'parent-upkeep',
  'validate-task',
  'compute-branch',
  'setup-worktree',
  'flip-status',
  'build-dev-prompt',
  'parse-dev-return',
  'build-review-prompts',
  'aggregate-verdicts',
  'iterate-review',
  'finalize-task',
  'push-and-pr',
  'sibling-prs',
  'cleanup-task',
]);

/** What `parent-upkeep` (the init bundle) already did when it returns. */
const INIT_COVERS = [
  'validate-task',
  'compute-branch',
  'setup-worktree',
  'flip-status',
  'build-dev-prompt',
];
/** What `finalize-task` (the ship bundle) already did when it returns. */
const SHIP_COVERS = ['push-and-pr', 'sibling-prs', 'cleanup-task'];

const LEDGER_FILE = 'workflow-comparison-ledger.jsonl';

function taskNumber(taskId: string): number {
  const m = taskId.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

function countFindings(report: ReviewerReport): Record<string, number> {
  const out: Record<string, number> = { critical: 0, major: 0, minor: 0, suggestion: 0 };
  for (const f of report.findings ?? []) out[f.severity] = (out[f.severity] ?? 0) + 1;
  return out;
}

class ExecuteHost implements EngineHost {
  readonly knownImpls = EXECUTE_IMPLS;
  state: NextStepState | null = null;
  run!: WorkflowRunState;
  prepared!: PreparedWorkflow;
  /** Developer envelope text between `develop` returning and `parse` running (same call). */
  private devText = '';

  constructor(
    readonly ctx: NextStepContext,
    readonly deps: NextStepDeps,
    public taskArg: string,
  ) {}

  now(): Date {
    return this.ctx.now();
  }

  taskId(): string {
    return this.state?.taskId ?? this.taskArg;
  }

  sampleKey(): { source: 'pr' | 'task'; value: number } {
    const pr = Number(this.ctx.env.AI_SDLC_PR_NUMBER);
    if (Number.isInteger(pr) && pr > 0) return { source: 'pr', value: pr };
    return { source: 'task', value: taskNumber(this.taskId()) };
  }

  persist(): void {
    if (this.state) writeState(this.ctx.statePath, this.state);
  }

  appendLedger(entry: LedgerEntry): void {
    const file = join(this.ctx.filesDir, LEDGER_FILE);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  }

  onLoopExhausted(): void {
    // Iteration cap reached: open the PR anyway, flagged for a human.
    if (this.state) this.state.needsHumanAttention = true;
  }

  private get s(): NextStepState {
    if (!this.state) throw new Error('workflow host: no run state yet');
    return this.state;
  }

  private early(taskId: string, reason: string): StepOutcome {
    return {
      kind: 'halt',
      instruction: {
        action: 'stop',
        taskId,
        outcome: 'aborted',
        reason,
        prUrl: null,
        notes: reason,
      },
    };
  }

  private cancelled(state: NextStepState): boolean {
    return checkCancelSignal(this.ctx, state.taskIdLower, state.taskId);
  }

  private cancelHalt(state: NextStepState): Promise<StepOutcome> {
    return failRun(
      this.ctx,
      state,
      'aborted',
      'cancelled by operator signal at step boundary (AISDLC-481)',
    ).then((instruction) => ({ kind: 'halt', instruction }));
  }

  // ── steps ─────────────────────────────────────────────────────────

  async runStep(nodeId: string, node: EngineNode, run: WorkflowRunState): Promise<StepOutcome> {
    switch (node.impl) {
      case 'parent-upkeep':
        return this.init(run);
      case 'parse-dev-return':
        return this.parse();
      case 'build-review-prompts':
        return this.plan(run);
      case 'aggregate-verdicts':
        return {
          kind: 'ok',
          output: { decision: this.s.verdict?.decision ?? 'CHANGES_REQUESTED' },
        };
      case 'iterate-review':
        return this.iterate(run);
      case 'finalize-task':
        return this.finalize();
      default:
        // Steps an init or ship bundle covers never reach here; an uncovered one is a document bug.
        throw new WorkflowRefusal(
          'unknown-impl',
          `node '${nodeId}' impl '${node.impl}' has no handler`,
        );
    }
  }

  /** Steps 0-5 in one call (the Machine's `start`), then the resume-unchanged shortcut. */
  private async init(run: WorkflowRunState): Promise<StepOutcome> {
    const { ctx, deps } = this;
    ctx.logger.progress('step-1', `detected ARG_FORM=backlog-task (${this.taskArg})`);
    const init = await deps.initTask(ctx, this.taskArg);
    if (!init.ok) return this.early(this.taskArg, init.reason);

    const loop = this.prepared.edges.find((e) => e.loop);
    const state: NextStepState = {
      schemaVersion: 1,
      taskId: this.taskArg,
      taskIdLower: this.taskArg.toLowerCase(),
      sourceKind: 'backlog',
      phase: 'awaiting-developer',
      workDir: ctx.workDir,
      branch: init.branch,
      worktreePath: init.worktreePath,
      task: init.task,
      fromStatus: init.fromStatus,
      iteration: 1,
      maxIterations: loop?.loop?.max ?? DEFAULT_MAX_ITERATIONS,
      developer: null,
      review: null,
      verdict: null,
      postRebaseReviewed: false,
      needsHumanAttention: false,
      classifierLine: '',
      reviewRound: 0,
      calls: 1,
      workflow: run,
    };
    this.state = state;
    run.scratch.devPrompt = { file: init.promptFile, ...(init.model ? { model: init.model } : {}) };
    await updateSessionState(ctx, state.taskIdLower, '01-validated');
    if (this.cancelled(state)) return this.cancelHalt(state);
    if (init.resumed) {
      // AISDLC-947: an unchanged patch id needs no developer and no reviewer.
      const decision = await decideResumeReview(ctx, init.worktreePath);
      state.resumeReview = decision;
      ctx.logger.info(`[resume] ${decision.note}`);
      if (decision.branch === 'unchanged') {
        const head = await ctx.runner('git', ['rev-parse', 'HEAD'], {
          cwd: init.worktreePath,
          allowFailure: true,
        });
        state.developer = {
          summary: 'Resume: patch id unchanged since the last attestation; no developer run.',
          filesChanged: [],
          commitSha: head.code === 0 ? head.stdout.trim() : null,
          verifications: { build: 'skipped', test: 'skipped', lint: 'skipped', format: 'skipped' },
          acceptanceCriteriaMet: [],
          notes: decision.note,
        };
        return { kind: 'ok', covers: [...INIT_COVERS, 'develop', 'parse-dev-return'] };
      }
    }
    return { kind: 'ok', covers: INIT_COVERS };
  }

  private async parse(): Promise<StepOutcome> {
    const state = this.s;
    const parsed = await parseDeveloperReturn({ developerReturn: extractJson(this.devText) });
    if (parsed.parked) {
      // AISDLC-651.3: a parked task is not a failure; keep the status, worktree and WIP commit.
      return {
        kind: 'halt',
        instruction: await failRun(
          this.ctx,
          state,
          'developer-parked',
          `${parsed.reason ?? 'developer parked the task'}. Worktree preserved at ${state.worktreePath}; return the task to the board or operator with these notes.`,
          { developer: parsed.developer ?? null },
        ),
      };
    }
    if (!parsed.ok || !parsed.developer) {
      await rollbackStatus(this.ctx, state);
      const reason = parsed.reason ?? 'developer subagent failed';
      return {
        kind: 'halt',
        instruction: await failRun(
          this.ctx,
          state,
          parsed.contractViolation ? 'developer-json-contract-violated' : 'developer-failed',
          `${reason}. Worktree preserved at ${state.worktreePath}. To clean up: /ai-sdlc cleanup ${state.taskId}`,
          { developer: parsed.developer ?? null },
        ),
      };
    }
    state.developer = parsed.developer;
    recordDeveloperResponseOf(state);
    return { kind: 'ok' };
  }

  /** Step 7: the Machine's `review()` up to the point where reviewers are spawned. */
  private async plan(run: WorkflowRunState): Promise<StepOutcome> {
    const { ctx, deps } = this;
    const state = this.s;
    state.reviewRound += 1;
    const noStaged = run.scratch.noStaged === true;
    delete run.scratch.noStaged;
    const prep = await deps.prepareReview(
      ctx,
      state,
      state.reviewRound,
      noStaged ? { noStaged } : {},
    );
    if (prep.kind === 'abort') {
      return { kind: 'halt', instruction: await failRun(ctx, state, 'aborted', prep.reason) };
    }
    state.review = prep.review;
    state.classifierLine = prep.classifierLine;
    if (prep.kind === 'nothing-to-spawn') {
      state.verdict = await aggregateRound(prep.verdicts, prep.review.harnessNote);
      run.scratch.nothingToSpawn = true;
      return { kind: 'ok', output: { reviewers: [] } };
    }
    run.scratch.nothingToSpawn = false;
    await updateSessionState(ctx, state.taskIdLower, '07-reviewers-running');
    return { kind: 'ok', output: { reviewers: prep.review.spawned.map((r) => r.agent) } };
  }

  /** Step 9: the next developer prompt; the loop edge then re-enters `develop`. */
  private async iterate(run: WorkflowRunState): Promise<StepOutcome> {
    const { ctx, deps } = this;
    const state = this.s;
    state.iteration += 1;
    state.postRebaseReviewed = false;
    const built = await deps.buildDeveloperPrompt({
      taskId: state.taskId,
      task: state.task,
      branch: state.branch,
      worktreePath: state.worktreePath,
      iteration: state.iteration,
      reviewerFeedback: formatFeedback(state.verdict!.verdicts),
      sourceKind: 'backlog',
    });
    const file = writeRunFile(ctx, `developer-prompt-${state.iteration}.md`, built.prompt);
    run.scratch.devPrompt = {
      file,
      ...(built.model && built.modelArm !== 'default' ? { model: built.model } : {}),
    };
    return { kind: 'ok' };
  }

  /** Step 8 APPROVED path, 10.5 and 10-13: lease, pre-sign rebase, signing hand-off, ship. */
  private async finalize(): Promise<StepOutcome> {
    const { ctx, deps } = this;
    const state = this.s;
    if (!state.needsHumanAttention) {
      const lease = deps.leasePreflight(ctx, state);
      if (lease.status === 'refused') {
        if (lease.blocking) {
          return { kind: 'halt', instruction: await failRun(ctx, state, 'aborted', lease.message) };
        }
        ctx.logger.warn(lease.message);
      }
      if (!state.postRebaseReviewed) {
        const rebase = await deps.preSignRebase(ctx, state);
        if (rebase.kind === 'failed') {
          return { kind: 'halt', instruction: await failRun(ctx, state, 'aborted', rebase.reason) };
        }
        if (rebase.kind === 'changed') {
          // The rebase moved content inside our files: the approval no longer binds.
          state.postRebaseReviewed = true;
          ctx.logger.progress(
            'step-10.5',
            `rebased; contentHash changed (${rebase.before} -> ${rebase.after}); re-running reviewers (1 round)`,
          );
          return {
            kind: 'invalidate',
            nodes: ['plan', 'review', 'aggregate'],
            detail: 'post-rebase re-review',
          };
        }
      }
      await updateSessionState(ctx, state.taskIdLower, '10-signing');
    }
    const result = await deps.ship(ctx, state);
    state.phase = result.action === 'done' ? 'done' : 'aborted';
    state.result = result;
    delete state.pending;
    this.persist();
    if (result.action === 'stop') return { kind: 'halt', instruction: result };
    return { kind: 'ok', covers: SHIP_COVERS };
  }

  // ── agents ────────────────────────────────────────────────────────

  async spawn(
    nodeId: string,
    node: EngineNode | undefined,
    shadows: ShadowSpawn[],
    run: WorkflowRunState,
  ): Promise<SpawnOutcome> {
    const { ctx } = this;
    const state = this.s;
    if (node?.kind === 'agent' && node.role === 'developer') {
      const dev = run.scratch.devPrompt as { file: string; model?: string };
      await updateSessionState(ctx, state.taskIdLower, '05-dev-running');
      const instruction = buildSpawnDeveloper(ctx, state, dev.file, dev.model);
      state.phase = 'awaiting-developer';
      state.pending = instruction;
      return { kind: 'spawn', instruction };
    }
    if (node?.kind === 'fanout' && run.scratch.nothingToSpawn === true && shadows.length === 0) {
      return { kind: 'none', detail: 'review plan spawned no reviewer' };
    }
    if (node && node.kind !== 'fanout') {
      throw new WorkflowRefusal(
        'unknown-impl',
        `agent node '${nodeId}' role '${node.role}' has no host`,
      );
    }
    const review = state.review;
    if (!review) throw new Error('workflow host: review spawn without a review plan');
    const base = buildSpawnReviewers(ctx, state, review);
    const reviewers = run.scratch.nothingToSpawn === true && node ? [] : [...base.reviewers];
    for (const sh of shadows) {
      const file = writeRunFile(
        ctx,
        `shadow-${sh.role}-r${review.round}.md`,
        `Role: ${sh.role} (non-gating shadow review, RFC-0056 OQ-1).\nTask: ${state.taskId}\nWorktree: ${state.worktreePath}\n` +
          `Review the diff on the branch against the task acceptance criteria and reply with the reviewer JSON.\n` +
          `Your verdict is recorded in the comparison ledger and never gates the run.\n`,
      );
      reviewers.push({
        agent: sh.role,
        promptFile: file,
        bootstrapPrompt: bootstrapPromptFor(file),
      });
    }
    const instruction = { ...base, reviewers };
    state.review = review;
    state.phase = 'awaiting-reviewers';
    state.pending = instruction;
    return { kind: 'spawn', instruction };
  }

  async onResult(
    nodeId: string | undefined,
    node: EngineNode | undefined,
    text: string,
    shadows: ShadowSpawn[],
  ): Promise<ResultOutcome> {
    const { ctx } = this;
    const state = this.s;
    if (node?.kind === 'agent') {
      delete state.pending;
      await updateSessionState(ctx, state.taskIdLower, '06-dev-done');
      if (this.cancelled(state)) {
        return {
          kind: 'halt',
          instruction: await failRun(
            ctx,
            state,
            'aborted',
            'cancelled by operator signal at step boundary (AISDLC-481)',
          ),
        };
      }
      this.devText = text;
      return { kind: 'ok' };
    }
    return this.onReviewers(state, text, shadows, nodeId);
  }

  private fixReplyShape(state: NextStepState): string {
    return state.review?.staged && state.review.staged.stage !== 'security'
      ? STAGED_REPORT_SHAPE
      : REPORT_SHAPE;
  }

  private async onReviewers(
    state: NextStepState,
    text: string,
    shadows: ShadowSpawn[],
    nodeId: string | undefined,
  ): Promise<ResultOutcome> {
    const { ctx, deps } = this;
    let all: ReviewerReport[];
    try {
      all = parseReviewReports(extractJson(text));
    } catch (err) {
      return this.corrected(
        state,
        `reviewer result is not valid JSON (${(err as Error).message})`,
        this.fixReplyShape(state),
      );
    }
    // A non-gating node's report is set aside: it never reaches a join or `aggregate`.
    const shadowRoles = new Set(shadows.map((s) => s.role));
    const setAside = all.filter((r) => shadowRoles.has(r.agent));
    const reports = all.filter((r) => !shadowRoles.has(r.agent));
    const shadowResults: ShadowResult[] = shadows.flatMap((sh) => {
      const r = setAside.find((x) => x.agent === sh.role);
      return r
        ? [
            {
              nodeId: sh.nodeId,
              role: sh.role,
              approved: r.approved,
              findings: countFindings(r),
              ...(r.summary ? { summary: r.summary } : {}),
            },
          ]
        : [{ nodeId: sh.nodeId, role: sh.role }];
    });
    if (nodeId === undefined) {
      delete state.pending;
      return { kind: 'ok', shadows: shadowResults };
    }

    if (state.review?.staged && state.review.staged.stage !== 'security') {
      const artifactsDir =
        ctx.env.ARTIFACTS_DIR || defaultArtifactsDir(resolveProjectRoot(state.worktreePath));
      const next = await advanceStagedRound(ctx, state, reports, artifactsDir);
      if (next.kind === 'fix') return this.corrected(state, next.reason, STAGED_REPORT_SHAPE);
      if (next.kind === 'abort') {
        return { kind: 'halt', instruction: await failRun(ctx, state, 'aborted', next.reason) };
      }
      delete state.reportRetries;
      if (next.kind === 'fallback') {
        ctx.logger.warn(
          `staged review fell back to the three-reviewer set (${next.reason}); see cli-staged-review status`,
        );
        delete state.pending;
        this.run.scratch.noStaged = true;
        return { kind: 'invalidate', nodes: ['plan', 'review'], detail: 'staged fallback' };
      }
      state.review = next.review;
      state.phase = 'awaiting-reviewers';
      const instruction = buildSpawnReviewers(ctx, state, next.review);
      state.pending = instruction;
      return { kind: 'respawn', instruction, shadows: shadowResults };
    }

    const fin = await deps.finalizeReview(ctx, state, reports);
    if (!fin.ok) {
      return fin.recoverable
        ? this.corrected(state, fin.reason, this.fixReplyShape(state))
        : { kind: 'halt', instruction: await failRun(ctx, state, 'aborted', fin.reason) };
    }
    delete state.pending;
    delete state.reportRetries;
    for (const w of fin.warnings) ctx.logger.warn(w);
    state.verdict = fin.verdict;
    recordRound(state);
    await updateSessionState(ctx, state.taskIdLower, '07c-leaves-emitted');
    if (this.cancelled(state)) {
      return {
        kind: 'halt',
        instruction: await failRun(
          ctx,
          state,
          'aborted',
          'cancelled by operator signal at step boundary (AISDLC-481)',
        ),
      };
    }
    return { kind: 'ok', shadows: shadowResults };
  }

  /** An unusable report: ask for a corrected one (twice at most), or stop. */
  private async corrected(
    state: NextStepState,
    reason: string,
    replyShape: string,
  ): Promise<ResultOutcome> {
    const next = await fixReportOrFail(this.ctx, state, reason, replyShape);
    return next.action === 'fix-report'
      ? { kind: 'respawn', instruction: next }
      : { kind: 'halt', instruction: next };
  }
}

// ── entry point ─────────────────────────────────────────────────────

const BASE_REF_ENV = 'AI_SDLC_WORKFLOW_BASE_REF';

/**
 * `next-step` through the engine. Same inputs, same instruction protocol and the same
 * exit codes as `nextStep()`; the golden replay test holds the two in step.
 */
export async function workflowNextStep(
  ctx: NextStepContext,
  input: NextStepInput,
  overrides: Partial<NextStepDeps> = {},
): Promise<NextStepOutput> {
  const deps: NextStepDeps = { ...defaultNextStepDeps, ...overrides };
  // Child processes (the pre-push hook that signs) read the run's digest from this state file.
  ctx.env.AI_SDLC_WORKFLOW_STATE = ctx.statePath;
  const instruction = await runEngine(ctx, deps, input);
  return { instruction, exitCode: exitCodeFor(instruction) };
}

async function runEngine(
  ctx: NextStepContext,
  deps: NextStepDeps,
  input: NextStepInput,
): Promise<Instruction> {
  const existing = readState(ctx.statePath);
  const host = new ExecuteHost(ctx, deps, existing?.taskId ?? input.task.trim());
  try {
    return existing === null ? await start(host, input) : await resumeRun(host, existing, input);
  } catch (err) {
    const state = host.state;
    if (err instanceof WorkflowRefusal && state === null) return stop(input.task, err.message);
    // A throw after the task began must still drop the sentinel and revert status.
    if (state === null || state.phase === 'aborted' || state.phase === 'done') throw err;
    const reason = err instanceof Error ? err.message : String(err);
    await rollbackStatus(ctx, state);
    return failRun(ctx, state, 'aborted', reason);
  }
}

function stop(taskId: string, reason: string): StopInstruction {
  return { action: 'stop', taskId, outcome: 'aborted', reason, prUrl: null, notes: reason };
}

async function load(
  host: ExecuteHost,
  baseRef: string,
  expect?: { path: string; sha256: string; baseSha: string },
): Promise<PreparedWorkflow> {
  return loadWorkflowFromBase({
    runner: host.ctx.runner,
    workDir: host.ctx.workDir,
    baseRef,
    knownImpls: host.knownImpls,
    ...(expect ? { expect } : {}),
  });
}

async function start(host: ExecuteHost, input: NextStepInput): Promise<Instruction> {
  const { ctx, deps } = host;
  const ccr = detectCcr({ env: ctx.env, homeDir: ctx.homeDir, exists: ctx.exists });
  if (ccr !== null) return stop(input.task, ccrRefusalMessage(ccr));
  const arg = parseExecuteArg(input.task);
  if (!arg.ok) return stop(input.task, arg.reason);
  if (arg.form === 'gh-issue') return runGhIssue(ctx, arg.issueNumber, deps.ghIssue);

  host.taskArg = arg.taskId;
  host.prepared = await load(host, ctx.env[BASE_REF_ENV] || 'origin/main');
  host.run = newRunState(host.prepared);
  const engine = new WorkflowEngine(host.prepared, host, host.run);
  return finish(host, await engine.advance());
}

async function resumeRun(
  host: ExecuteHost,
  s: NextStepState,
  input: NextStepInput,
): Promise<Instruction> {
  const { ctx } = host;
  host.state = s;
  s.calls += 1;
  const argTaskId = input.task.trim().toLowerCase();
  if (argTaskId !== s.taskIdLower && argTaskId !== s.taskId.toLowerCase()) {
    return failRun(
      ctx,
      s,
      'aborted',
      `state file ${ctx.statePath} belongs to ${s.taskId}, not '${input.task}'`,
      { persist: false },
    );
  }
  if ((s.phase === 'done' || s.phase === 'aborted') && s.result) return s.result;
  if (input.result === undefined || input.result.trim() === '') {
    // Nothing to act on: re-emit the pending instruction (idempotent re-call).
    if (s.pending) return s.pending;
    return failRun(ctx, s, 'aborted', `next-step called with no result while ${s.phase}`);
  }
  if (s.phase !== 'awaiting-developer' && s.phase !== 'awaiting-reviewers') {
    return failRun(ctx, s, 'aborted', `unexpected phase ${s.phase}`);
  }
  const wf = s.workflow;
  if (!wf) {
    return failRun(
      ctx,
      s,
      'aborted',
      `state file ${ctx.statePath} was written by the Machine, not the workflow engine; ` +
        `unset ${WORKFLOW_ENGINE_FLAG} to finish this run, or start a fresh one (--fresh)`,
    );
  }
  host.run = wf;
  host.prepared = await load(host, wf.baseSha, {
    path: wf.path,
    sha256: wf.sha256,
    baseSha: wf.baseSha,
  });
  const engine = new WorkflowEngine(host.prepared, host, wf);
  return finish(host, await engine.resume(input.result));
}

/** The graph ended (`null`): the ship step stored the result. Anything else is an engine bug. */
async function finish(host: ExecuteHost, out: Instruction | null): Promise<Instruction> {
  if (out !== null) {
    // A terminal stop from a step already persisted its own state; spawns persisted via the engine.
    host.persist();
    return out;
  }
  const state = host.state;
  if (state?.result) {
    host.persist();
    return state.result;
  }
  if (state) return failRun(host.ctx, state, 'aborted', 'workflow ended without a result');
  return stop(host.taskId(), 'workflow ended before the task was initialised');
}

/** Test seam: read the comparison ledger a run wrote. */
export function readLedger(ctx: NextStepContext): LedgerEntry[] {
  try {
    return readFileSync(join(ctx.filesDir, LEDGER_FILE), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEntry);
  } catch {
    return [];
  }
}
