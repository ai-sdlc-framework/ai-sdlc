/**
 * The `ai-sdlc-pipeline next-step` state machine (AISDLC-762).
 *
 * One call advances the run as far as it can without an LLM and returns ONE
 * instruction:
 *
 *   spawn-developer  hand `promptFile` to the `developer` agent
 *   spawn-reviewers  hand each prompt file to its reviewer agent, in one message
 *   done             PR exists (or the task is parked for a human)
 *   stop             cannot continue; `reason` is for the operator
 *
 * State lives in a JSON file between calls, so the model keeps no pipeline
 * state in its context. A happy-path run costs 3 `next-step` calls (start,
 * developer result, reviewer result), a worst-case run (two developer passes
 * plus a post-rebase re-review) 6, well inside the 15-call budget (AC-2).
 *
 * @module next-step/next-step
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildDeveloperPrompt } from '../steps/05-build-dev-prompt.js';
import { findTaskFile } from '../steps/01-validate.js';
import { patchFrontmatterStatus } from '../steps/04-flip-status.js';
import { cleanupTask } from '../steps/13-cleanup.js';
import { parseDeveloperReturn } from '../steps/06-parse-dev-return.js';
import { formatFeedback } from '../steps/08-aggregate-verdicts.js';
import { ccrRefusalMessage, detectCcr, parseExecuteArg } from './args.js';
import { runGhIssue, type GhIssueDeps, defaultGhIssueDeps } from './gh-issue.js';
import { initTask, writeRunFile, type InitFailure, type InitSuccess } from './init.js';
import { prepareReview, type ReviewPrepareResult } from './review-prepare.js';
import {
  aggregateRound,
  finalizeReview,
  parseReviewReports,
  type ReviewFinalizeResult,
  type ReviewerReport,
} from './review-finalize.js';
import { checkCancelSignal, updateSessionState } from './session.js';
import { preSignRebase, shipTask, type PreSignRebaseResult } from './ship.js';
import type {
  DoneInstruction,
  FixReportInstruction,
  Instruction,
  NextStepContext,
  NextStepState,
  SpawnDeveloperInstruction,
  SpawnReviewersInstruction,
  StopInstruction,
} from './types.js';

/** Replaceable collaborators; the defaults are the real steps. */
export interface NextStepDeps {
  initTask: (ctx: NextStepContext, taskId: string) => Promise<InitSuccess | InitFailure>;
  prepareReview: (
    ctx: NextStepContext,
    state: NextStepState,
    round: number,
  ) => Promise<ReviewPrepareResult>;
  finalizeReview: (
    ctx: NextStepContext,
    state: NextStepState,
    reports: ReviewerReport[],
  ) => Promise<ReviewFinalizeResult>;
  preSignRebase: (ctx: NextStepContext, state: NextStepState) => Promise<PreSignRebaseResult>;
  ship: (ctx: NextStepContext, state: NextStepState) => Promise<DoneInstruction | StopInstruction>;
  buildDeveloperPrompt: typeof buildDeveloperPrompt;
  ghIssue: GhIssueDeps;
}

export const defaultNextStepDeps: NextStepDeps = {
  initTask,
  prepareReview,
  finalizeReview,
  preSignRebase,
  ship: shipTask,
  buildDeveloperPrompt,
  ghIssue: defaultGhIssueDeps,
};

export interface NextStepInput {
  /** `$ARGUMENTS`: a backlog task id, `gh:<n>`, `#<n>` or `<n>`. */
  task: string;
  /** Raw text the model reports for the pending instruction (agent output). */
  result?: string;
}

export interface NextStepOutput {
  instruction: Instruction;
  /** Process exit code: 0 for work / done, 1 for stop. */
  exitCode: number;
}

const MAX_ITERATIONS = 2;
/** A fixable reviewer-report slip may be corrected this many times per run. */
const MAX_REPORT_RETRIES = 2;

const REPORT_SHAPE =
  '{"reviewers":[{"agent":"<agent name>","agentId":"<agentId the Agent tool returned>","approved":true|false,"findings":[{"severity":"critical|major|minor|suggestion","file":"","line":0,"message":""}],"summary":""}]}';

// ── state persistence ───────────────────────────────────────────────

export function readState(path: string): NextStepState | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as NextStepState;
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `unsupported next-step state schema in ${path}: ${String(parsed.schemaVersion)}`,
    );
  }
  return parsed;
}

export function writeState(path: string, state: NextStepState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(`${path}.tmp`, path);
}

function exitCodeFor(i: Instruction): number {
  return i.action === 'stop' ? 1 : 0;
}

function resumeCommand(ctx: NextStepContext, taskId: string): string {
  return (
    `node ${ctx.cliBinDir}/ai-sdlc-pipeline.mjs next-step --task ${taskId} ` +
    `--state ${ctx.statePath} --result -`
  );
}

// ── the machine ─────────────────────────────────────────────────────

export async function nextStep(
  ctx: NextStepContext,
  input: NextStepInput,
  overrides: Partial<NextStepDeps> = {},
): Promise<NextStepOutput> {
  const deps: NextStepDeps = { ...defaultNextStepDeps, ...overrides };
  const machine = new Machine(ctx, deps);
  const instruction = await machine.run(input);
  return { instruction, exitCode: exitCodeFor(instruction) };
}

class Machine {
  private state: NextStepState | null = null;

  constructor(
    private readonly ctx: NextStepContext,
    private readonly deps: NextStepDeps,
  ) {}

  async run(input: NextStepInput): Promise<Instruction> {
    try {
      return await this.runInner(input);
    } catch (err) {
      // A throw after the task began must still drop the sentinel and revert status.
      const state = this.state;
      if (state === null || state.phase === 'aborted' || state.phase === 'done') throw err;
      const reason = err instanceof Error ? err.message : String(err);
      await this.rollbackStatus(state);
      return this.fail(state, 'aborted', reason);
    }
  }

  private async runInner(input: NextStepInput): Promise<Instruction> {
    const existing = readState(this.ctx.statePath);
    if (existing === null) return this.start(input.task);

    this.state = existing;
    const s = existing;
    s.calls += 1;
    const argTaskId = input.task.trim().toLowerCase();
    if (argTaskId !== s.taskIdLower && argTaskId !== s.taskId.toLowerCase()) {
      return this.fail(
        s,
        'aborted',
        `state file ${this.ctx.statePath} belongs to ${s.taskId}, not '${input.task}'`,
        { persist: false },
      );
    }
    if ((s.phase === 'done' || s.phase === 'aborted') && s.result) return s.result;

    if (input.result === undefined || input.result.trim() === '') {
      // Nothing to act on: re-emit the pending instruction (idempotent re-call).
      if (s.pending) return s.pending;
      return this.fail(s, 'aborted', `next-step called with no result while ${s.phase}`);
    }
    if (s.phase === 'awaiting-developer') return this.onDeveloper(s, input.result);
    if (s.phase === 'awaiting-reviewers') return this.onReviewers(s, input.result);
    return this.fail(s, 'aborted', `unexpected phase ${s.phase}`);
  }

  // ── start ─────────────────────────────────────────────────────────

  private async start(rawArg: string): Promise<Instruction> {
    const { ctx, deps } = this;
    const ccr = detectCcr({ env: ctx.env, homeDir: ctx.homeDir, exists: ctx.exists });
    if (ccr !== null) return this.early(rawArg, ccrRefusalMessage(ccr));
    const arg = parseExecuteArg(rawArg);
    if (!arg.ok) return this.early(rawArg, arg.reason);
    if (arg.form === 'gh-issue') return runGhIssue(ctx, arg.issueNumber, deps.ghIssue);

    ctx.logger.progress('step-1', `detected ARG_FORM=backlog-task (${arg.taskId})`);
    const init = await deps.initTask(ctx, arg.taskId);
    if (!init.ok) return this.early(arg.taskId, init.reason);

    const state: NextStepState = {
      schemaVersion: 1,
      taskId: arg.taskId,
      taskIdLower: arg.taskId.toLowerCase(),
      sourceKind: 'backlog',
      phase: 'awaiting-developer',
      workDir: ctx.workDir,
      branch: init.branch,
      worktreePath: init.worktreePath,
      task: init.task,
      fromStatus: init.fromStatus,
      iteration: 1,
      maxIterations: MAX_ITERATIONS,
      developer: null,
      review: null,
      verdict: null,
      postRebaseReviewed: false,
      needsHumanAttention: false,
      classifierLine: '',
      reviewRound: 0,
      calls: 1,
    };
    this.state = state;
    await updateSessionState(ctx, state.taskIdLower, '01-validated');
    if (checkCancelSignal(ctx, state.taskIdLower, state.taskId)) {
      return this.fail(
        state,
        'aborted',
        'cancelled by operator signal at step boundary (AISDLC-481)',
      );
    }
    return this.spawnDeveloper(state, init.promptFile, init.model);
  }

  /** A failure before any state exists: nothing to persist, nothing to roll back. */
  private early(taskId: string, reason: string): StopInstruction {
    return { action: 'stop', taskId, outcome: 'aborted', reason, prUrl: null, notes: reason };
  }

  // ── developer ─────────────────────────────────────────────────────

  private async spawnDeveloper(
    state: NextStepState,
    promptFile: string,
    model?: string,
  ): Promise<SpawnDeveloperInstruction> {
    await updateSessionState(this.ctx, state.taskIdLower, '05-dev-running');
    const instruction: SpawnDeveloperInstruction = {
      action: 'spawn-developer',
      taskId: state.taskId,
      agent: 'developer',
      iteration: state.iteration,
      promptFile,
      cwd: state.worktreePath,
      ...(model ? { model } : {}),
      reply: resumeCommand(this.ctx, state.taskId),
    };
    state.phase = 'awaiting-developer';
    state.pending = instruction;
    this.save(state);
    return instruction;
  }

  private async onDeveloper(state: NextStepState, text: string): Promise<Instruction> {
    const { ctx } = this;
    delete state.pending;
    await updateSessionState(ctx, state.taskIdLower, '06-dev-done');
    if (checkCancelSignal(ctx, state.taskIdLower, state.taskId)) {
      return this.fail(
        state,
        'aborted',
        'cancelled by operator signal at step boundary (AISDLC-481)',
      );
    }
    const parsed = await parseDeveloperReturn({ developerReturn: extractJson(text) });
    if (!parsed.ok || !parsed.developer) {
      await this.rollbackStatus(state);
      const reason = parsed.reason ?? 'developer subagent failed';
      return this.fail(
        state,
        parsed.contractViolation ? 'developer-json-contract-violated' : 'developer-failed',
        `${reason}. Worktree preserved at ${state.worktreePath}. To clean up: /ai-sdlc cleanup ${state.taskId}`,
        { developer: parsed.developer ?? null },
      );
    }
    state.developer = parsed.developer;
    return this.review(state);
  }

  /** Revert the task to its pre-dispatch status; the worktree stays for inspection. */
  private async rollbackStatus(state: NextStepState): Promise<void> {
    try {
      const file = findTaskFile(state.taskId, state.worktreePath);
      if (!file) return;
      const raw = readFileSync(file, 'utf8');
      writeFileSync(file, patchFrontmatterStatus(raw, state.fromStatus), 'utf8');
    } catch (err) {
      this.ctx.logger.warn(
        `could not revert ${state.taskId} to ${state.fromStatus}: ${(err as Error).message}`,
      );
    }
  }

  // ── review ────────────────────────────────────────────────────────

  private async review(state: NextStepState): Promise<Instruction> {
    const { ctx, deps } = this;
    state.reviewRound += 1;
    const prep = await deps.prepareReview(ctx, state, state.reviewRound);
    if (prep.kind === 'abort') return this.fail(state, 'aborted', prep.reason);
    state.review = prep.review;
    state.classifierLine = prep.classifierLine;
    if (prep.kind === 'nothing-to-spawn') {
      state.verdict = await aggregateRound(prep.verdicts, prep.review.harnessNote);
      return this.afterVerdict(state);
    }
    await updateSessionState(ctx, state.taskIdLower, '07-reviewers-running');
    const instruction: SpawnReviewersInstruction = {
      action: 'spawn-reviewers',
      taskId: state.taskId,
      round: prep.review.round,
      reviewers: prep.review.spawned.map((r) => ({
        agent: r.agent,
        promptFile: r.promptFile,
        ...(r.model ? { model: r.model } : {}),
      })),
      replyShape: REPORT_SHAPE,
      reply: resumeCommand(ctx, state.taskId),
    };
    state.phase = 'awaiting-reviewers';
    state.pending = instruction;
    this.save(state);
    return instruction;
  }

  private async onReviewers(state: NextStepState, text: string): Promise<Instruction> {
    const { ctx, deps } = this;
    let reports: ReviewerReport[];
    try {
      reports = parseReviewReports(extractJson(text));
    } catch (err) {
      return this.fixReport(state, `reviewer result is not valid JSON (${(err as Error).message})`);
    }
    const fin = await deps.finalizeReview(ctx, state, reports);
    if (!fin.ok) {
      return fin.recoverable
        ? this.fixReport(state, fin.reason)
        : this.fail(state, 'aborted', fin.reason);
    }
    delete state.pending;
    delete state.reportRetries;
    for (const w of fin.warnings) ctx.logger.warn(w);
    state.verdict = fin.verdict;
    await updateSessionState(ctx, state.taskIdLower, '07c-leaves-emitted');
    if (checkCancelSignal(ctx, state.taskIdLower, state.taskId)) {
      return this.fail(
        state,
        'aborted',
        'cancelled by operator signal at step boundary (AISDLC-481)',
      );
    }
    return this.afterVerdict(state);
  }

  /**
   * The report was unusable but nothing irreversible happened: ask for a corrected
   * report (twice at most) instead of burning the reviewer fan-out.
   */
  private async fixReport(state: NextStepState, reason: string): Promise<Instruction> {
    const retries = state.reportRetries ?? 0;
    if (retries >= MAX_REPORT_RETRIES) {
      return this.fail(state, 'aborted', `${reason} (after ${retries} corrected reports)`);
    }
    state.reportRetries = retries + 1;
    const instruction: FixReportInstruction = {
      action: 'fix-report',
      taskId: state.taskId,
      round: state.review?.round ?? 0,
      reason,
      replyShape: REPORT_SHAPE,
      reply: resumeCommand(this.ctx, state.taskId),
    };
    state.pending = instruction;
    this.save(state);
    return instruction;
  }

  /** Gate decision (Step 8) then Step 9 iteration or Step 10.5 + ship. */
  private async afterVerdict(state: NextStepState): Promise<Instruction> {
    const { ctx, deps } = this;
    const verdict = state.verdict!;
    if (verdict.decision === 'APPROVED') {
      if (!state.postRebaseReviewed) {
        const rebase = await deps.preSignRebase(ctx, state);
        if (rebase.kind === 'failed') return this.fail(state, 'aborted', rebase.reason);
        if (rebase.kind === 'changed') {
          // The rebase moved content inside our files: the approval no longer binds.
          state.postRebaseReviewed = true;
          ctx.logger.progress(
            'step-10.5',
            `rebased; contentHash changed (${rebase.before} -> ${rebase.after}); re-running reviewers (1 round)`,
          );
          return this.review(state);
        }
      }
      await updateSessionState(ctx, state.taskIdLower, '10-signing');
      return this.finish(state, false);
    }

    if (state.iteration < state.maxIterations) {
      state.iteration += 1;
      state.postRebaseReviewed = false;
      const built = await deps.buildDeveloperPrompt({
        taskId: state.taskId,
        task: state.task,
        branch: state.branch,
        worktreePath: state.worktreePath,
        iteration: state.iteration,
        reviewerFeedback: formatFeedback(verdict.verdicts),
        sourceKind: 'backlog',
      });
      const file = writeRunFile(ctx, `developer-prompt-${state.iteration}.md`, built.prompt);
      return this.spawnDeveloper(
        state,
        file,
        built.model && built.modelArm !== 'default' ? built.model : undefined,
      );
    }
    // Iteration cap reached: open the PR anyway, flagged for a human.
    state.needsHumanAttention = true;
    return this.finish(state, true);
  }

  // ── terminal states ───────────────────────────────────────────────

  private async finish(state: NextStepState, needsHuman: boolean): Promise<Instruction> {
    state.needsHumanAttention = needsHuman;
    const result = await this.deps.ship(this.ctx, state);
    state.phase = result.action === 'done' ? 'done' : 'aborted';
    state.result = result;
    delete state.pending;
    this.save(state);
    return result;
  }

  private async fail(
    state: NextStepState,
    outcome: StopInstruction['outcome'],
    reason: string,
    opts: { persist?: boolean; developer?: NextStepState['developer'] } = {},
  ): Promise<StopInstruction> {
    const stop: StopInstruction = {
      action: 'stop',
      taskId: state.taskId,
      outcome,
      reason,
      branch: state.branch,
      worktreePath: state.worktreePath,
      prUrl: null,
      developer: opts.developer ?? state.developer,
      notes: reason,
    };
    if (opts.persist !== false) {
      // The implicit try/finally of Step 4: the sentinel never outlives the run.
      try {
        await cleanupTask({ taskId: state.taskId, worktreePath: state.worktreePath });
      } catch (err) {
        this.ctx.logger.warn(`sentinel cleanup failed (non-fatal): ${(err as Error).message}`);
      }
      state.phase = 'aborted';
      state.result = stop;
      delete state.pending;
      this.save(state);
    }
    return stop;
  }

  private save(state: NextStepState): void {
    writeState(this.ctx.statePath, state);
  }
}

/**
 * Pull the JSON object out of an agent's final message. Agents sometimes wrap
 * the envelope in prose or a code fence; take the outermost `{...}` / `[...]`.
 * Text that holds no JSON is returned unchanged so the caller reports it.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // fall through to extraction
  }
  const open = trimmed.search(/[{[]/);
  if (open === -1) return trimmed;
  const closer = trimmed[open] === '{' ? '}' : ']';
  const close = trimmed.lastIndexOf(closer);
  return close > open ? trimmed.slice(open, close + 1) : trimmed;
}
