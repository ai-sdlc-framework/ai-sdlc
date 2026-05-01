/**
 * Tier 2 composite entry point — `executePipeline()`.
 *
 * RFC-0012 §7.1. Drives Steps 0-13 in order using the injected
 * `SubagentSpawner` for the LLM dispatch boundaries (Step 5b, Step 7b).
 *
 * Tier 1 (slash command body) does NOT call this function — it interleaves
 * CLI subcommands with main-session Agent tool calls. This composite is for
 * unattended programmatic use: CLI invocation, GitHub Actions, webhooks,
 * cron, and the existing `pnpm watch` flow once Phase 5 (AISDLC-100.5)
 * migrates `dogfood/src/watch.ts` to call it.
 *
 * @module execute-pipeline
 */

import {
  aggregateVerdicts,
  beginTask,
  buildDeveloperPrompt,
  buildReviewPrompts,
  cleanupTask,
  computeBranchName,
  coerceReviewerVerdict,
  finalizeTask,
  iterateReviewLoop,
  parseDeveloperReturn,
  pushAndPr,
  setupWorktree,
  siblingPrs,
  sweepMergedWorktrees,
  validateTask,
} from './steps/index.js';
import {
  DEFAULT_LOGGER,
  type AggregatedVerdict,
  type DeveloperReturn,
  type PipelineOptions,
  type PipelineOutcome,
  type PipelineResult,
  type ReviewerType,
  type ReviewerVerdict,
} from './types.js';

const REVIEWER_TYPES: ReviewerType[] = ['code-reviewer', 'test-reviewer', 'security-reviewer'];

export async function executePipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const logger = opts.logger ?? DEFAULT_LOGGER;
  if (!opts.spawner) {
    throw new Error(
      'executePipeline requires opts.spawner — pick ShellClaudePSpawner (subscription), ' +
        'ClaudeCodeSDKSpawner (API key), or MockSpawner (tests). ' +
        'See RFC-0012 §8.',
    );
  }

  // Step 0
  logger.progress('00-sweep', 'sweeping merged worktrees');
  const sweep = await sweepMergedWorktrees({ workDir: opts.workDir, runner: opts.runner });
  if (sweep.swept.length > 0) {
    logger.info(`[ai-sdlc-progress] 00-sweep: removed ${sweep.swept.length} merged worktree(s)`);
  }

  // Step 1
  logger.progress('01-validate', `validating ${opts.taskId}`);
  const validation = await validateTask({ taskId: opts.taskId, workDir: opts.workDir });
  if (!validation.ok || !validation.task) {
    return abort(opts, '', '', null, validation.reason ?? 'validation failed');
  }
  const task = validation.task;

  // Step 2
  logger.progress('02-compute-branch', 'computing branch name');
  const branch = await computeBranchName({ taskId: opts.taskId, task, workDir: opts.workDir });

  // Step 3
  logger.progress('03-setup-worktree', `creating worktree at ${branch.worktreePath}`);
  await setupWorktree({
    taskId: opts.taskId,
    branch: branch.branch,
    worktreePath: branch.worktreePath,
    workDir: opts.workDir,
    runner: opts.runner,
  });

  // Step 4
  logger.progress('04-flip-status', 'flipping status to In Progress + writing sentinel');
  await beginTask({
    taskId: opts.taskId,
    worktreePath: branch.worktreePath,
    workDir: opts.workDir,
  });

  // Wrap Steps 5-13 in a try/finally so Step 13 always cleans up the sentinel.
  let outcome: PipelineResult['outcome'] = 'aborted';
  let prUrl: string | null = null;
  let siblingPrUrls: string[] = [];
  let iterationsTotal = 0;
  let finalAggregated: AggregatedVerdict | null = null;
  let aborted: string | null = null;

  try {
    // Step 5 — build developer prompt
    logger.progress('05-build-dev-prompt', `iteration 1`);
    const { prompt: devPrompt } = await buildDeveloperPrompt({
      taskId: opts.taskId,
      task,
      branch: branch.branch,
      worktreePath: branch.worktreePath,
      iteration: 1,
    });

    // Step 5b — spawn developer (LLM)
    const devSpawn = await opts.spawner.spawn({
      type: 'developer',
      prompt: devPrompt,
      cwd: branch.worktreePath,
    });

    // Step 6 — parse developer return
    const parsedDev = await parseDeveloperReturn({
      developerReturn: devSpawn.parsed ?? devSpawn.output,
    });
    if (!parsedDev.ok || !parsedDev.developer) {
      aborted = parsedDev.reason ?? 'developer subagent failed';
      outcome = 'developer-failed';
      return abort(opts, branch.branch, branch.worktreePath, null, aborted, 'developer-failed');
    }
    const initialDev: DeveloperReturn = parsedDev.developer;

    // Step 7 — build 3 review prompts
    const reviewBuild = await buildReviewPrompts({
      taskId: opts.taskId,
      task,
      branch: branch.branch,
      worktreePath: branch.worktreePath,
      workDir: opts.workDir,
      runner: opts.runner,
    });

    // Step 7b — spawn 3 reviewers in parallel
    const reviewerResults = await opts.spawner.spawnParallel(
      reviewBuild.prompts.map((p) => ({
        type: p.reviewer,
        prompt: p.prompt,
        cwd: branch.worktreePath,
      })),
    );
    const initialVerdicts: ReviewerVerdict[] = reviewerResults.map((r, i) =>
      coerceReviewerVerdict(REVIEWER_TYPES[i], r),
    );

    // Step 8 — aggregate
    const initialVerdict = await aggregateVerdicts({
      verdicts: initialVerdicts,
      harnessNote: reviewBuild.harnessNote,
    });

    // Step 9 — iteration loop
    const loop = await iterateReviewLoop({
      taskId: opts.taskId,
      worktreePath: branch.worktreePath,
      task,
      branch: branch.branch,
      initialDeveloperReturn: initialDev,
      initialVerdict,
      maxIterations: opts.maxReviewIterations ?? 2,
      spawner: opts.spawner,
      onIteration: opts.onProgress,
    });
    iterationsTotal = loop.iterations;
    finalAggregated = loop.finalVerdict;

    // Step 10 — finalize (skipped when needs-human-attention)
    await finalizeTask({
      taskId: opts.taskId,
      workDir: opts.workDir,
      worktreePath: branch.worktreePath,
      task,
      developerReturn: loop.finalDeveloperReturn,
      verdict: loop.finalVerdict,
      iterations: loop.iterations,
      runner: opts.runner,
      skipCommit: opts.skipFinalizeCommit,
    });

    // Step 11 — push + open PR
    const push = await pushAndPr({
      taskId: opts.taskId,
      workDir: opts.workDir,
      worktreePath: branch.worktreePath,
      branch: branch.branch,
      task,
      developerReturn: loop.finalDeveloperReturn,
      verdict: loop.finalVerdict,
      needsHumanAttention: loop.needsHumanAttention,
      runner: opts.runner,
    });
    if (!push.pushed) {
      // outcome already defaults to 'aborted'; just record the reason.
      aborted = push.reason ?? 'push failed';
    } else if (!push.prUrl) {
      aborted = push.reason ?? 'PR creation failed';
    } else {
      prUrl = push.prUrl;
      outcome = loop.needsHumanAttention ? 'needs-human-attention' : 'approved';
    }

    // Step 12 — sibling PRs (only if main PR opened)
    if (prUrl) {
      const sibs = await siblingPrs({
        taskId: opts.taskId,
        workDir: opts.workDir,
        task,
        developerReturn: loop.finalDeveloperReturn,
        mainPrUrl: prUrl,
        runner: opts.runner,
      });
      siblingPrUrls = sibs.prs.map((p) => p.prUrl).filter((u): u is string => !!u);
    }
  } finally {
    // Step 13 — always cleanup
    await cleanupTask({ taskId: opts.taskId, worktreePath: branch.worktreePath });
  }

  return {
    taskId: opts.taskId,
    branch: branch.branch,
    worktreePath: branch.worktreePath,
    outcome,
    prUrl,
    siblingPrUrls,
    iterations: iterationsTotal,
    finalVerdict: finalAggregated,
    notes: aborted ?? undefined,
  };
}

function abort(
  opts: PipelineOptions,
  branch: string,
  worktreePath: string,
  finalVerdict: AggregatedVerdict | null,
  reason: string,
  outcome: PipelineOutcome = 'aborted',
): PipelineResult {
  return {
    taskId: opts.taskId,
    branch,
    worktreePath,
    outcome,
    prUrl: null,
    siblingPrUrls: [],
    iterations: 0,
    finalVerdict,
    notes: reason,
  };
}
