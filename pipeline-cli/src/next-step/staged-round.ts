/**
 * staged-round: the `reviewerSet: staged` review (RFC-0052) inside the next-step machine.
 *
 * The staged review is a pipeline whose two model calls (planner, synthesizer) sit around
 * code-run phases (`cli-staged-review prepare | plan | execute | synth-prompt | finalize`).
 * Each model call is one `spawn-reviewers` instruction with one agent, so the machine
 * needs no new action:
 *
 *   stage `plan`        spawn review-planner        -> plan, execute, synth-prompt
 *   stage `synthesize`  spawn review-synthesizer    -> finalize, emit the staged leaves
 *   stage `security`    spawn security-reviewer     -> the normal finalize path
 *
 * The standalone security reviewer runs LAST. It is Write-capable and reads the untrusted
 * diff, so nothing the staged phases wrote may be read after it ran: the verdict is held in
 * the state file and every staged leaf is emitted before it is spawned.
 *
 * Fail closed: any phase that answers `ok: false`, an unreadable report that cannot be
 * fixed by re-sending it, or a transcript that cannot be persisted returns `fallback`, and
 * the machine runs the existing three-reviewer set instead. The reasons are in the dispatch
 * record (`cli-staged-review status`).
 *
 * @module next-step/staged-round
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveModel } from '../routing/resolve-model.js';
import { taskClassOf } from '../routing/task-class.js';
import type { ReviewerVerdict } from '../types.js';
import { writeRunFile } from './init.js';
import { resolveAgentIdFromMarkers, type ReviewerReport } from './review-finalize.js';
import type {
  NextStepContext,
  NextStepState,
  ReviewRoundState,
  SpawnedReviewer,
  StagedModelAgent,
} from './types.js';

/** Shape of the report the model sends for a staged stage. */
export const STAGED_REPORT_SHAPE =
  '{"reviewers":[{"agent":"<review-planner|review-synthesizer>","agentId":"<agentId the Agent tool returned>","outputFile":"<file holding the agent\'s final message, written verbatim>"}]}';

export type StagedAdvance =
  | { kind: 'spawn'; review: ReviewRoundState }
  /** The staged review cannot review this change; run the existing set. */
  | { kind: 'fallback'; reason: string }
  /** Unrecoverable (a corrupt run); stop the pipeline. */
  | { kind: 'abort'; reason: string }
  /** The report is unusable but nothing was done yet: ask for a corrected one. */
  | { kind: 'fix'; reason: string };

interface CliJson {
  ok?: boolean;
  reason?: string;
  rejections?: Array<{ reason?: string }>;
  seal?: string;
  status?: string;
  retryNote?: string;
  plannerPromptPath?: string;
  promptPath?: string;
  baselineProbes?: number;
  reviewerVerdict?: ReviewerVerdict;
  leaves?: Array<{
    stage: string;
    reviewer: string;
    transcriptPath: string;
    verdictPath: string;
    harness: string;
    model: string;
  }>;
  dropped?: number;
}

function rejectionsOf(r: CliJson): string {
  return JSON.stringify((r.rejections ?? []).map((x) => x.reason ?? 'unknown'));
}

/** Run one `cli-staged-review` phase; null when it did not print one JSON object. */
async function stagedCli(
  ctx: NextStepContext,
  state: NextStepState,
  artifactsDir: string,
  phase: string,
  extra: string[],
): Promise<CliJson | null> {
  const r = await ctx.runner(
    'node',
    [
      join(ctx.cliBinDir, 'cli-staged-review.mjs'),
      phase,
      '--task-id',
      state.taskId,
      '--work-dir',
      state.worktreePath,
      '--artifacts-dir',
      artifactsDir,
      ...extra,
    ],
    { cwd: ctx.workDir, allowFailure: true },
  );
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as CliJson;
  } catch {
    return null;
  }
}

function modelFor(
  ctx: NextStepContext,
  state: NextStepState,
  role: StagedModelAgent,
  round: number,
  artifactsDir: string,
): { model?: string; leafModel: string } {
  const routed = resolveModel({
    role,
    taskClass: taskClassOf(state.task.rawBody),
    taskId: state.taskId,
    sourceKind: 'backlog',
    iteration: round,
    workDir: ctx.workDir,
    artifactsDir,
  });
  return {
    ...(routed.model && routed.arm !== 'default' ? { model: routed.model } : {}),
    leafModel: routed.model || 'unrouted',
  };
}

export interface StartStagedOpts {
  round: number;
  artifactsDir: string;
  baseReview: ReviewRoundState;
  /** The security reviewer entry the round ends with; null means it cannot run, so no staged run. */
  security: SpawnedReviewer | null;
  /** The delta diff for an incremental delta-only round. */
  diffFile?: string;
  nonce: string;
}

/**
 * Start the staged round: `prepare`, then ask for the planner. Returns null when the staged
 * review cannot review this change (the caller falls back to the existing set).
 */
export async function startStagedRound(
  ctx: NextStepContext,
  state: NextStepState,
  opts: StartStagedOpts,
): Promise<ReviewRoundState | null> {
  if (opts.security === null) {
    ctx.logger.warn('staged review: no security reviewer prompt; using the three-reviewer set');
    return null;
  }
  const prep = await stagedCli(ctx, state, opts.artifactsDir, 'prepare', [
    '--source-kind',
    'backlog',
    ...(opts.diffFile ? ['--diff-file', opts.diffFile] : []),
  ]);
  if (prep === null || prep.ok !== true || !prep.plannerPromptPath || !prep.seal) {
    ctx.logger.warn(
      `staged review: cannot review this change (${prep?.reason ?? 'invocation-failed'}); ` +
        `the three-reviewer set handles it. Rejections: ${prep ? rejectionsOf(prep) : '[]'}`,
    );
    return null;
  }
  ctx.logger.progress(
    'step-7a-staged',
    `prepared (baseline probes: ${prep.baselineProbes ?? '?'})`,
  );
  const planner = modelFor(ctx, state, 'review-planner', opts.round, opts.artifactsDir);
  const synth = modelFor(ctx, state, 'review-synthesizer', opts.round, opts.artifactsDir);
  const entry: SpawnedReviewer = {
    reviewer: 'review-planner',
    agent: 'review-planner',
    harness: 'claude-code',
    leafModel: planner.leafModel,
    ...(planner.model ? { model: planner.model } : {}),
    promptFile: prep.plannerPromptPath,
  };
  return {
    ...opts.baseReview,
    spawned: [entry],
    nonce: opts.nonce,
    staged: {
      stage: 'plan',
      seal: prep.seal,
      plannerAttempt: 1,
      plannerPromptFile: prep.plannerPromptPath,
      plannerModel: planner.leafModel,
      synthModel: synth.leafModel,
      security: opts.security,
    },
  };
}

function reportFor(reports: ReviewerReport[], agent: string): ReviewerReport | undefined {
  return reports.find((r) => r.agent === agent || r.agent === agent.replace(/^review-/, ''));
}

/** The agent's final message: inline `output`, else the file the model wrote it to. */
function outputOf(ctx: NextStepContext, report: ReviewerReport, name: string): string | null {
  if (typeof report.output === 'string' && report.output.trim() !== '') {
    return writeRunFile(ctx, name, report.output);
  }
  if (typeof report.outputFile === 'string' && ctx.exists(report.outputFile)) {
    return report.outputFile;
  }
  return null;
}

/** Persist one staged agent's harness transcript (coordinator side, AISDLC-599). */
async function persistStageTranscript(
  ctx: NextStepContext,
  state: NextStepState,
  agent: StagedModelAgent,
  agentId: string,
): Promise<boolean> {
  // A clean stub, never the agent's own message: `emit-leaf` reads a verdict file, and the
  // plan leaf carries none by construction (the synthesize leaf's verdict comes from finalize).
  const stub = writeRunFile(
    ctx,
    `verdict-${agent}.json`,
    JSON.stringify({ approved: false, findings: [], summary: `${agent} stage transcript` }),
  );
  const r = await ctx.runner(
    'bash',
    [
      join(ctx.pluginScriptsDir, 'persist-reviewer-artifacts.sh'),
      '--worktree',
      state.worktreePath,
      '--task-id',
      state.taskId,
      '--reviewer',
      agent,
      '--agent-id',
      agentId,
      '--verdict-file',
      stub,
    ],
    { cwd: ctx.workDir, allowFailure: true },
  );
  return r.code === 0;
}

function agentIdOf(state: NextStepState, report: ReviewerReport, agent: string): string | null {
  return report.agentId ?? resolveAgentIdFromMarkers(state.worktreePath, agent);
}

/**
 * Advance the staged round by one model call. `reports` is what the model reported for the
 * agent the last instruction asked for.
 */
export async function advanceStagedRound(
  ctx: NextStepContext,
  state: NextStepState,
  reports: ReviewerReport[],
  artifactsDir: string,
): Promise<StagedAdvance> {
  const review = state.review;
  const staged = review?.staged;
  if (!review || !staged)
    return { kind: 'abort', reason: 'staged review: no staged round in state' };

  if (staged.stage === 'plan') {
    const report = reportFor(reports, 'review-planner');
    const out = report
      ? outputOf(ctx, report, `staged-planner-${staged.plannerAttempt}.txt`)
      : null;
    if (!report || out === null) {
      return {
        kind: 'fix',
        reason:
          'staged review: report review-planner with its agentId and the outputFile holding its final message',
      };
    }
    const id = agentIdOf(state, report, 'review-planner');
    if (!id) {
      return {
        kind: 'fix',
        reason:
          'staged review: no harness agent id for review-planner; report the agentId the Agent tool returned',
      };
    }
    const plan = await stagedCli(ctx, state, artifactsDir, 'plan', [
      '--planner-output',
      out,
      '--seal',
      staged.seal,
      '--attempt',
      String(staged.plannerAttempt),
    ]);
    if (plan === null || plan.ok === false) {
      return { kind: 'fallback', reason: plan?.reason ?? 'plan-failed' };
    }
    if (plan.status === 'retry' && staged.plannerAttempt === 1) {
      const retryFile = writeRunFile(
        ctx,
        'staged-planner-retry.md',
        `${readFileSync(staged.plannerPromptFile, 'utf8')}\n\n${plan.retryNote ?? ''}\n`,
      );
      const entry: SpawnedReviewer = { ...review.spawned[0], promptFile: retryFile };
      return {
        kind: 'spawn',
        review: {
          ...review,
          spawned: [entry],
          staged: { ...staged, plannerAttempt: 2 },
        },
      };
    }
    if (plan.status !== 'planned' || !plan.seal) {
      return { kind: 'fallback', reason: 'plan-not-accepted' };
    }
    if (!(await persistStageTranscript(ctx, state, 'review-planner', id))) {
      return { kind: 'fallback', reason: 'planner-transcript-not-persisted' };
    }
    const exec = await stagedCli(ctx, state, artifactsDir, 'execute', ['--seal', plan.seal]);
    if (exec === null || exec.ok === false || !exec.seal) {
      return { kind: 'fallback', reason: exec?.reason ?? 'execute-failed' };
    }
    const sp = await stagedCli(ctx, state, artifactsDir, 'synth-prompt', ['--seal', exec.seal]);
    if (sp === null || sp.ok === false || !sp.promptPath) {
      return { kind: 'fallback', reason: sp?.reason ?? 'synth-prompt-failed' };
    }
    const synth = modelFor(ctx, state, 'review-synthesizer', review.round, artifactsDir);
    const entry: SpawnedReviewer = {
      reviewer: 'review-synthesizer',
      agent: 'review-synthesizer',
      harness: 'claude-code',
      leafModel: staged.synthModel,
      ...(synth.model ? { model: synth.model } : {}),
      promptFile: sp.promptPath,
    };
    return {
      kind: 'spawn',
      review: {
        ...review,
        spawned: [entry],
        staged: { ...staged, stage: 'synthesize', seal: exec.seal },
      },
    };
  }

  if (staged.stage === 'synthesize') {
    const report = reportFor(reports, 'review-synthesizer');
    const out = report ? outputOf(ctx, report, 'staged-synth.txt') : null;
    if (!report || out === null) {
      return {
        kind: 'fix',
        reason:
          'staged review: report review-synthesizer with its agentId and the outputFile holding its final message',
      };
    }
    const id = agentIdOf(state, report, 'review-synthesizer');
    if (!id) {
      return {
        kind: 'fix',
        reason:
          'staged review: no harness agent id for review-synthesizer; report the agentId the Agent tool returned',
      };
    }
    if (!(await persistStageTranscript(ctx, state, 'review-synthesizer', id))) {
      return { kind: 'fallback', reason: 'synthesizer-transcript-not-persisted' };
    }
    const fin = await stagedCli(ctx, state, artifactsDir, 'finalize', [
      '--seal',
      staged.seal,
      '--synthesizer-output',
      out,
      '--planner-model',
      staged.plannerModel,
      '--synthesizer-model',
      staged.synthModel,
    ]);
    if (fin === null || fin.ok !== true || !fin.reviewerVerdict) {
      ctx.logger.warn(
        `staged review: no verdict (${fin?.reason ?? 'invocation-failed'}); ` +
          `the three-reviewer set handles this change. Rejections: ${fin ? rejectionsOf(fin) : '[]'}`,
      );
      return { kind: 'fallback', reason: fin?.reason ?? 'finalize-failed' };
    }

    // Every staged leaf is emitted NOW, before the security reviewer is spawned.
    let synthLeafOk = true;
    for (const leaf of fin.leaves ?? []) {
      let ok = ctx.exists(leaf.transcriptPath) && ctx.exists(leaf.verdictPath);
      if (!ok) {
        ctx.logger.warn(
          `staged review: missing transcript or verdict for the ${leaf.stage} leaf (${leaf.transcriptPath}); skipping it`,
        );
      } else {
        const emit = await ctx.runner(
          'node',
          [
            join(ctx.cliBinDir, 'cli-attestation.mjs'),
            'emit-leaf',
            '--repo-root',
            state.worktreePath,
            '--task-id',
            state.taskId,
            '--reviewer',
            leaf.reviewer,
            '--stage',
            leaf.stage,
            '--transcript-path',
            leaf.transcriptPath,
            '--verdict-path',
            leaf.verdictPath,
            '--head-sha',
            review.headSha,
            '--harness',
            leaf.harness,
            '--model',
            leaf.model,
            '--nonce',
            review.nonce,
            '--iteration',
            String(state.iteration),
          ],
          { cwd: ctx.workDir, allowFailure: true },
        );
        ok = emit.code === 0;
        if (!ok) {
          ctx.logger.warn(
            `staged review: emit-leaf for the ${leaf.stage} leaf exited non-zero (${emit.stderr.trim()}); the v6-default sign step will block`,
          );
        }
      }
      if (!ok && leaf.stage === 'synthesize') synthLeafOk = false;
    }
    let verdict: ReviewerVerdict = fin.reviewerVerdict;
    if (!synthLeafOk) {
      // A verdict with no attestation evidence must not approve.
      verdict = {
        ...verdict,
        approved: false,
        findings: [
          ...verdict.findings,
          {
            severity: 'major',
            message:
              'The staged review synthesize leaf could not be emitted, so its verdict has no attestation evidence; re-run the review.',
          },
        ],
      };
    }
    ctx.logger.progress(
      'step-7a-staged',
      `one verdict (approved=${verdict.approved}, dropped findings: ${fin.dropped ?? 0}); staged leaves emitted`,
    );
    return {
      kind: 'spawn',
      review: {
        ...review,
        spawned: [staged.security],
        staged: { ...staged, stage: 'security', verdict },
      },
    };
  }

  return { kind: 'abort', reason: `staged review: unexpected stage ${staged.stage}` };
}
