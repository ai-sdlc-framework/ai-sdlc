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
  parseDeveloperReturnWithRetry,
  pushAndPr,
  setupWorktree,
  siblingPrs,
  sweepMergedWorktrees,
  validateTask,
} from './steps/index.js';
import { existsSync } from 'node:fs';
import { defaultRunner } from './runtime/exec.js';
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

  // AISDLC-200 — Wrap Steps 3-13 (NOT just 5-13) in a try/finally so that
  // any throw from Step 4 (status flip + sentinel write) AFTER Step 3
  // succeeded triggers Step 13 sentinel cleanup + best-effort worktree
  // removal. Previously the cleanup boundary started AFTER Step 4, so a
  // Step 4 throw orphaned the worktree + propagated as an exception
  // (rather than a structured `PipelineResult`), and the CLI wrapper
  // never reached its `ROLLBACK_OUTCOMES` membership check.
  //
  // Tracking flag: only attempt worktree removal when Step 3 actually
  // created it. Without this, a Step 3 throw would re-enter the runner
  // for a `git worktree remove` against a path that doesn't exist.
  let outcome: PipelineResult['outcome'] = 'aborted';
  let prUrl: string | null = null;
  let siblingPrUrls: string[] = [];
  let iterationsTotal = 0;
  let finalAggregated: AggregatedVerdict | null = null;
  let aborted: string | null = null;
  let worktreeCreated = false;
  // AISDLC-200 — `setupCompleted` flips true once Steps 3-4 BOTH succeed.
  // The best-effort worktree removal in the `finally` only fires when this
  // flag is FALSE — i.e. the gap this fix targets (Step 4 throws after
  // Step 3 succeeded). For post-setup failures (dev-failed, push-failed,
  // etc.) the worktree stays on disk so the wrapper's `rollbackDispatch()`
  // can still inspect the branch for commits beyond origin/main and
  // quarantine them before tearing down. Without this guard, the finally
  // would wipe the branch ref out from under rollback's quarantine probe
  // and any developer commits would be silently lost.
  let setupCompleted = false;
  const cleanupWarnings: string[] = [];

  try {
    // Step 3
    logger.progress('03-setup-worktree', `creating worktree at ${branch.worktreePath}`);
    await setupWorktree({
      taskId: opts.taskId,
      branch: branch.branch,
      worktreePath: branch.worktreePath,
      workDir: opts.workDir,
      runner: opts.runner,
      // AISDLC-224 — propagate autonomousMode so Step 3 can self-heal
      // stale branches in the orchestrator path (default false → manual path
      // unchanged).
      autonomousMode: opts.autonomousMode,
      // AISDLC-241 — thread the mutex options through so the orchestrator's
      // `buildDefaultDispatch` can activate the in-process (and optionally
      // cross-process file-based) lock across concurrent ticks. When undefined
      // (manual `/ai-sdlc execute` path), `setupWorktree` falls through to
      // `withWorktreeMutex`'s no-op default (no lock applied — backward-compatible).
      mutexOpts: opts.mutexOpts,
      // AISDLC-224 — forward the auto-cleanup event to the orchestrator's
      // events bus when supplied. setupWorktree synthesizes a `ts` field;
      // the loop-side handler stamps `runId`/`tick` before writing.
      // Without this thread, the event is silently dropped on every real
      // orchestrator run (code-reviewer #377 finding 2).
      emitEvent: opts.onWorktreeAutoCleaned
        ? (event) => {
            if (event.type === 'WorktreeAutoCleaned') {
              // OrchestratorEvent is a flat interface (not a discriminated
              // union), so the discriminant check above doesn't narrow
              // field types. Cast to access the WorktreeAutoCleaned-specific
              // fields. The runtime check on `event.type` ensures these
              // fields are actually present.
              const e = event as unknown as {
                taskId: string;
                branch: string;
                reason: string;
                hadOpenPR: boolean;
                hadUncommittedChanges: boolean;
              };
              opts.onWorktreeAutoCleaned!({
                type: 'WorktreeAutoCleaned',
                taskId: e.taskId,
                branch: e.branch,
                reason: e.reason,
                hadOpenPR: e.hadOpenPR,
                hadUncommittedChanges: e.hadUncommittedChanges,
              });
            }
          }
        : undefined,
    });
    worktreeCreated = true;

    // Step 4 — AISDLC-199: beginTask now patches the worktree-local copy of
    // the task file (the fresh Step 3 checkout from origin/main) rather than
    // the operator's parent checkout. `workDir` is still passed as a fallback
    // for the standalone CLI invocation path; in the umbrella `executePipeline()`
    // flow the worktree always wins. This keeps the parent's working tree
    // clean per the orchestrator-repo-layout contract — see
    // `pipeline-cli/src/steps/04-flip-status.ts` for the full rationale and
    // the regression test in `execute-pipeline.test.ts` ('Step 4 lifecycle
    // edits land on worktree, not parent') for the proof.
    logger.progress('04-flip-status', 'flipping status to In Progress + writing sentinel');
    await beginTask({
      taskId: opts.taskId,
      worktreePath: branch.worktreePath,
      workDir: opts.workDir,
    });
    setupCompleted = true;

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

    // Step 6 — parse developer return (AISDLC-176: retry once on JSON
    // contract violation before failing the dispatch).
    const parsedDev = await parseDeveloperReturnWithRetry({
      initialResult: devSpawn,
      cwd: branch.worktreePath,
      spawner: opts.spawner,
      onRetrySuccess: ({ initialOutputPreview, retryOutputPreview, durationMs }): void => {
        logger.warn(
          `[ai-sdlc] developer subagent re-emitted JSON envelope on retry ` +
            `(durationMs=${durationMs}, initial output preview: ` +
            `${JSON.stringify(initialOutputPreview.slice(0, 200))})`,
        );
        logger.progress(
          'developer-contract-retry',
          `task=${opts.taskId} recovered after one prose-then-JSON retry`,
        );
        // Forward to the orchestrator events bus when wired (Phase 4
        // events.jsonl). Tier 1 / standalone Tier 2 callers leave this
        // unset and the retry just shows up in the logger output above.
        opts.onDeveloperContractRetry?.({
          taskId: opts.taskId,
          initialOutputPreview,
          retryOutputPreview,
          durationMs,
          // AISDLC-196 — initial-dispatch (Step 5b/6) path. The
          // iteration loop's wire-up emits `phase: 'iteration'` with
          // the actual iteration number so operators can split the
          // recovery-frequency story by code path.
          phase: 'initial',
        });
      },
    });
    if (!parsedDev.ok || !parsedDev.developer) {
      aborted = parsedDev.reason ?? 'developer subagent failed';
      // AISDLC-176 — distinguish "envelope contract violated" (the dev
      // returned non-JSON prose AND failed the retry) from "developer
      // reported failure inside a valid envelope" (commitSha:null,
      // verifications.X:failed, missing keys). The orchestrator + future
      // playbook handlers route these two failure modes differently.
      const failOutcome: PipelineOutcome = parsedDev.contractViolation
        ? 'developer-json-contract-violated'
        : 'developer-failed';
      outcome = failOutcome;
      return abort(opts, branch.branch, branch.worktreePath, null, aborted, failOutcome);
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
    // AISDLC-184 — pass the same `onDeveloperContractRetry` hook the
    // initial Step 5b/6 dispatch above uses so iteration-path retries
    // (dev returns prose on iteration N>1, retry helper recovers) emit
    // the same `DeveloperContractRetry` event. Without this the
    // events.jsonl stream undercounts drift on the iteration path.
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
      ...(opts.onDeveloperContractRetry
        ? { onDeveloperContractRetry: opts.onDeveloperContractRetry }
        : {}),
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
      if (push.rebaseConflict) {
        // AISDLC-232 — late-rebase hit semantic conflicts. Surface as a
        // dedicated outcome so the orchestrator tick can continue to the next
        // task without rolling back the dev's commits (the branch is intact
        // and the rebase was cleanly aborted). Operator resolves via
        // `/ai-sdlc rebase <pr>` or manual rebase.
        outcome = 'rebase-conflict';
        aborted =
          `rebase-conflict: ${push.rebaseConflict.reason}` +
          (push.rebaseConflict.files.length > 0
            ? `; conflicting files: ${push.rebaseConflict.files.join(', ')}`
            : '');
      } else {
        // Regular push failure (non-fast-forward, network, etc.)
        // outcome already defaults to 'aborted'; just record the reason.
        aborted = push.reason ?? 'push failed';
      }
    } else if (!push.prUrl) {
      aborted = push.reason ?? 'PR creation failed';
    } else {
      prUrl = push.prUrl;
      outcome = loop.needsHumanAttention ? 'needs-human-attention' : 'approved';
    }

    // Bug 2 (AISDLC-354) — auto-promote to ready + arm auto-merge when verdict is APPROVED.
    // Both calls swallow non-zero exits: PR may already be ready, queue may already be armed.
    if (outcome === 'approved' && prUrl) {
      const runner = opts.runner ?? defaultRunner;
      const prNumMatch = prUrl.match(/\/pull\/(\d+)/);
      const prNum = prNumMatch ? parseInt(prNumMatch[1], 10) : null;
      if (prNum !== null) {
        const readyResult = await runner('gh', ['pr', 'ready', String(prNum)], {
          cwd: opts.workDir,
          allowFailure: true,
        });
        if (readyResult.code !== 0) {
          logger.warn(
            `[ai-sdlc] Step 11 auto-promote: gh pr ready exited non-zero (non-fatal): ` +
              `${readyResult.stderr.trim() || readyResult.stdout.trim() || 'unknown error'}`,
          );
        }
        const mergeResult = await runner('gh', ['pr', 'merge', String(prNum), '--auto'], {
          cwd: opts.workDir,
          allowFailure: true,
        });
        if (mergeResult.code !== 0) {
          logger.warn(
            `[ai-sdlc] Step 11 auto-promote: gh pr merge --auto exited non-zero (non-fatal): ` +
              `${mergeResult.stderr.trim() || mergeResult.stdout.trim() || 'unknown error'}`,
          );
        }
      }
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
  } catch (err) {
    // AISDLC-200 — Convert any post-Step-2 throw into a structured
    // `PipelineResult` so the CLI wrapper (`runExecuteCommand`) reaches
    // its `ROLLBACK_OUTCOMES` membership check and dispatches
    // `rollbackDispatch()` with the resolved branch/worktree. The
    // pre-existing failure path was Step 4 (`beginTask`) throwing on a
    // missing task file or a frontmatter-patch surprise — that threw all
    // the way past the wrapper's `try/catch`, surfaced as
    // `executePipeline threw: ...`, and skipped both Step 13 cleanup AND
    // rollback. Now the throw is captured here, the structured envelope
    // is returned with `outcome: 'aborted'` (which IS in
    // `ROLLBACK_OUTCOMES`), and the wrapper rollback runs as designed.
    //
    // Original error reason is preserved verbatim in `notes` so operators
    // see the same diagnostic they would have on the legacy throw path.
    aborted = err instanceof Error ? err.message : String(err);
    outcome = 'aborted';
  } finally {
    // Step 13 — always cleanup the per-worktree sentinel. Safe even when
    // the sentinel doesn't exist (`cleanupTask` checks first).
    try {
      await cleanupTask({ taskId: opts.taskId, worktreePath: branch.worktreePath });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      cleanupWarnings.push(`sentinel cleanup failed: ${reason}`);
      logger.warn(`[ai-sdlc] Step 13 sentinel cleanup failed (non-fatal): ${reason}`);
    }

    // AISDLC-200 — Best-effort worktree removal when:
    //   1. Step 3 created the worktree (`worktreeCreated === true`), AND
    //   2. Setup never completed (`setupCompleted === false`) — i.e.
    //      Step 4 threw AFTER Step 3 succeeded.
    // For post-setup failures (developer-failed, push-failed,
    // needs-human-attention, etc.) the worktree intentionally stays on
    // disk: the wrapper's `rollbackDispatch()` needs the branch ref to
    // probe for commits beyond `origin/main` and quarantine them before
    // tearing down (`git worktree remove --force` would also delete the
    // branch ref). Pre-cleaning the worktree here would silently strand
    // any developer commits the dev produced before the failure.
    //
    // For the Step-4-throw scenario this fix targets, the branch is
    // EMPTY (Step 4 hasn't even flipped status yet, so the dev never
    // ran), so removing the worktree here is safe AND covers callers of
    // the bare `executePipeline()` library function that don't wire
    // `rollbackDispatch()` themselves. Idempotent: rollback sees
    // `existsSync(worktreePath) === false` and counts it as success.
    if (worktreeCreated && !setupCompleted && existsSync(branch.worktreePath)) {
      const runner = opts.runner ?? defaultRunner;
      try {
        const removed = await runner(
          'git',
          ['worktree', 'remove', '--force', branch.worktreePath],
          { cwd: opts.workDir, allowFailure: true },
        );
        if (removed.code !== 0) {
          const reason = (removed.stderr || removed.stdout).trim();
          cleanupWarnings.push(`worktree remove failed: ${reason}`);
          logger.warn(
            `[ai-sdlc] best-effort worktree remove failed for ${branch.worktreePath}: ${reason}`,
          );
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        cleanupWarnings.push(`worktree remove threw: ${reason}`);
        logger.warn(`[ai-sdlc] best-effort worktree remove threw: ${reason}`);
      }
    }
  }

  // AISDLC-200 — When cleanup encountered warnings, surface them in the
  // returned envelope's `notes` so the CLI wrapper's JSON output gives
  // the operator visibility into partial-cleanup state. Original abort
  // reason takes precedence; warnings are appended.
  let finalNotes: string | undefined = aborted ?? undefined;
  if (cleanupWarnings.length > 0) {
    const warnings = `cleanup warnings: ${cleanupWarnings.join('; ')}`;
    finalNotes = finalNotes ? `${finalNotes} | ${warnings}` : warnings;
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
    notes: finalNotes,
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
