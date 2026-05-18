/**
 * `ai-sdlc-pipeline execute --resume-from-draft <task-id>` — recovery path for
 * the AISDLC-218 mid-state: draft PR exists + branch has commits + attestation
 * incomplete or reviewers not yet run.
 *
 * AISDLC-273 — See `docs/operations/recovery-flows.md` for the full decision tree.
 *
 * ## Why this path exists
 *
 * The AISDLC-218 workflow intentionally opens PRs as DRAFT and flips them to
 * ready-for-review (Step 13) only after reviewers + attestation complete. If the
 * dispatch crashes between Step 11 (draft PR opened) and Step 13 (ready
 * promotion), the framework is stuck: `--run` hits Step 3's open-PR predicate
 * and refuses to create a new worktree, and no path exists to resume from the
 * partial state.
 *
 * This subcommand is the explicit operator opt-in: "I know there is a draft PR;
 * pick up at the first incomplete step." It does NOT re-dispatch the developer
 * unless `--rework-dev` is passed (that is the `--rework-pr` path).
 *
 * ## Step detection
 *
 * The command detects which steps are already complete by examining on-disk
 * state:
 *
 *   - Worktree exists → Step 3 complete.
 *   - `.active-task` sentinel → Step 4 complete.
 *   - Commits beyond origin/main → Step 5/6 (dev ran).
 *   - `.ai-sdlc/verdicts/<task-id>.json` → Step 8 aggregate written.
 *   - Draft PR on GitHub → Step 11 complete (push + draft PR open).
 *   - `chore: auto-sign attestation` commit → Step 10 + attestation complete.
 *
 * The command then picks up at the FIRST incomplete step:
 *
 *   a) Draft PR exists but no verdict file → re-run reviewers (Step 7) + attestation
 *      (Step 10) + flip to ready (Step 13).
 *   b) Draft PR exists + verdict file exists → re-sign attestation if needed
 *      (Step 10) + flip to ready (Step 13).
 *   c) Draft PR exists + attestation present → flip to ready only (Step 13).
 *
 * @module cli/resume-from-draft
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { detectDraftPrForBranch } from '../steps/03-setup-worktree.js';
import {
  aggregateVerdicts,
  buildReviewPrompts,
  cleanupTask,
  computeBranchName,
  spawnReviewerWithRetry,
  validateTask,
} from '../steps/index.js';
import {
  DEFAULT_LOGGER,
  type AggregatedVerdict,
  type PipelineLogger,
  type ReviewerType,
  type ReviewerVerdict,
  type SubagentSpawner,
} from '../types.js';
import { writeVerdictFile } from './execute.js';
import { PROTECTED_BRANCHES } from './rework-pr.js';

const REVIEWER_TYPES: ReviewerType[] = ['code-reviewer', 'test-reviewer', 'security-reviewer'];

/**
 * The completion state of an existing draft-PR dispatch — which steps
 * have already run based on on-disk signals.
 */
export interface DraftPrState {
  /** True when the worktree directory exists. */
  hasWorktree: boolean;
  /** True when the `.active-task` sentinel exists. */
  hasSentinel: boolean;
  /** Number of commits beyond origin/main. */
  commitCount: number;
  /** True when a draft PR is open on GitHub. */
  hasDraftPr: boolean;
  /** True when a ready (non-draft) PR is open on GitHub. */
  hasReadyPr: boolean;
  /** The PR number when an open PR is found (draft or ready). */
  prNumber: number | null;
  /** The PR URL when an open PR is found. */
  prUrl: string | null;
  /** True when `.ai-sdlc/verdicts/<task-id>.json` exists in the worktree. */
  hasVerdictFile: boolean;
  /** True when an attestation chore commit is present on the branch. */
  hasAttestationCommit: boolean;
}

/**
 * Detect the current state of an existing draft-PR mid-state for the given
 * task. Returns null when no draft PR is detected (nothing to resume).
 */
export async function detectDraftPrState(
  taskId: string,
  branch: string,
  worktreePath: string,
  workDir: string,
  runner: Runner,
): Promise<DraftPrState> {
  const hasWorktree = existsSync(worktreePath);
  const hasSentinel = hasWorktree && existsSync(join(worktreePath, '.active-task'));

  // Count commits beyond origin/main
  let commitCount = 0;
  if (hasWorktree) {
    const revResult = await runner('git', ['rev-list', '--count', 'origin/main..HEAD'], {
      cwd: worktreePath,
      allowFailure: true,
    });
    if (revResult.code === 0) {
      const n = parseInt(revResult.stdout.trim(), 10);
      commitCount = Number.isFinite(n) ? n : 0;
    }
  }

  // Check for open PR (draft or ready)
  const prInfo = await detectDraftPrForBranch(runner, workDir, branch);
  const hasDraftPr = prInfo?.isDraft === true;
  const hasReadyPr = prInfo !== null && prInfo.isDraft === false;

  // Check for verdict file in the worktree
  const taskIdLower = taskId.toLowerCase();
  const verdictPath = join(worktreePath, '.ai-sdlc', 'verdicts', `${taskIdLower}.json`);
  const hasVerdictFile = hasWorktree && existsSync(verdictPath);

  // Check for attestation chore commit on the branch
  let hasAttestationCommit = false;
  if (hasWorktree && commitCount > 0) {
    const logResult = await runner(
      'git',
      ['log', '--oneline', '--grep', 'auto-sign attestation', 'origin/main..HEAD'],
      { cwd: worktreePath, allowFailure: true },
    );
    if (logResult.code === 0 && logResult.stdout.trim().length > 0) {
      hasAttestationCommit = true;
    }
  }

  return {
    hasWorktree,
    hasSentinel,
    commitCount,
    hasDraftPr,
    hasReadyPr,
    prNumber: prInfo?.prNumber ?? null,
    prUrl: prInfo?.prUrl ?? null,
    hasVerdictFile,
    hasAttestationCommit,
  };
}

/** Options for `runResumeFromDraft`. */
export interface ResumeFromDraftOptions {
  taskId: string;
  workDir: string;
  spawner: SubagentSpawner;
  runner?: Runner;
  logger?: PipelineLogger;
  /** Override for tests — inject a fake executor. */
  verdictWriter?: typeof writeVerdictFile;
  /**
   * AISDLC-355: when true, force-bypass any existing verdict file and re-run
   * reviewers regardless of whether the file looks stale or valid.
   * Equivalent operator override to `rm .ai-sdlc/verdicts/<task-id>.json`.
   */
  forceReviewers?: boolean;
}

/** Result from `runResumeFromDraft`. */
export interface ResumeFromDraftResult {
  ok: boolean;
  /** Human-readable description of what was resumed. */
  resumedFrom: string;
  /** The final PR URL (the draft PR that was flipped to ready). */
  prUrl: string | null;
  outcome: 'resumed-and-ready' | 'already-ready' | 'no-draft-pr' | 'failed';
  reason?: string;
  /** Aggregated verdict from the resumed reviewer run (if reviewers ran). */
  finalVerdict?: AggregatedVerdict;
}

/**
 * AISDLC-273 — resume a stalled dispatch from its draft-PR mid-state.
 *
 * Detects which steps are already complete and picks up at the first
 * incomplete step. Does NOT re-dispatch the developer subagent.
 *
 * Resume decision tree:
 *  1. If no open PR for the branch → return `no-draft-pr`.
 *  2. If a ready PR exists → return `already-ready` (nothing to do).
 *  3. If draft PR + attestation commit → flip to ready (Step 13 only).
 *  4. If draft PR + verdict file but no attestation → re-sign (Step 10) + flip ready (Step 13).
 *  5. If draft PR + commits but no verdict file → re-run reviewers (Step 7) + write verdict (Step 8/10) + flip ready.
 */
export async function runResumeFromDraft(
  opts: ResumeFromDraftOptions,
): Promise<ResumeFromDraftResult> {
  const logger = opts.logger ?? DEFAULT_LOGGER;
  const runner = opts.runner ?? defaultRunner;
  // opts.verdictWriter is kept in the interface for API compatibility but
  // resume-from-draft now writes the flat verdicts array directly (Bug 2 fix).
  void opts.verdictWriter;

  logger.progress('resume-from-draft', `detecting state for ${opts.taskId}`);

  // Step 1: validate task + compute branch
  const validation = await validateTask({ taskId: opts.taskId, workDir: opts.workDir });
  if (!validation.ok || !validation.task) {
    return {
      ok: false,
      resumedFrom: 'validation',
      prUrl: null,
      outcome: 'failed',
      reason: validation.reason ?? 'validation failed',
    };
  }
  const task = validation.task;

  const branchResult = await computeBranchName({
    taskId: opts.taskId,
    task,
    workDir: opts.workDir,
  });
  const { branch, worktreePath } = branchResult;

  // Refuse to operate against main/master. The branch is computed from the
  // task ID + branching pattern, so the only path to main/master here is a
  // catastrophically misconfigured `branching.pattern`. Refuse early to
  // honor CLAUDE.md's "Never force-push to main/master" rule.
  if (PROTECTED_BRANCHES.has(branch)) {
    return {
      ok: false,
      resumedFrom: 'pre-flight',
      prUrl: null,
      outcome: 'failed',
      reason: `refusing to resume on protected branch '${branch}'. Check .ai-sdlc/pipeline-backlog.yaml branching.pattern — it must not collapse to a default branch name.`,
    };
  }

  // Step 2: detect state
  const state = await detectDraftPrState(opts.taskId, branch, worktreePath, opts.workDir, runner);

  logger.info(
    `[ai-sdlc] resume-from-draft state for ${opts.taskId}: ` +
      `hasWorktree=${state.hasWorktree} hasDraftPr=${state.hasDraftPr} ` +
      `hasReadyPr=${state.hasReadyPr} commitCount=${state.commitCount} ` +
      `hasVerdictFile=${state.hasVerdictFile} hasAttestationCommit=${state.hasAttestationCommit}`,
  );

  if (!state.hasDraftPr && !state.hasReadyPr) {
    return {
      ok: false,
      resumedFrom: 'detection',
      prUrl: null,
      outcome: 'no-draft-pr',
      reason: `No open PR found for branch '${branch}'. Use --run to start a fresh dispatch.`,
    };
  }

  if (state.hasReadyPr) {
    return {
      ok: true,
      resumedFrom: 'detection',
      prUrl: state.prUrl,
      outcome: 'already-ready',
      reason: `PR #${state.prNumber} is already ready-for-review. No resume needed.`,
    };
  }

  // We have a draft PR. Determine what to resume.
  const prNumber = state.prNumber!;
  const prUrl = state.prUrl;

  // Case A: attestation already committed → just flip to ready
  if (state.hasAttestationCommit) {
    logger.progress('resume-from-draft', `Step 13 only: flipping draft PR #${prNumber} to ready`);
    const readyResult = await runner('gh', ['pr', 'ready', String(prNumber)], {
      cwd: opts.workDir,
      allowFailure: true,
    });
    if (readyResult.code !== 0) {
      return {
        ok: false,
        resumedFrom: 'Step 13 flip-to-ready',
        prUrl,
        outcome: 'failed',
        reason: `gh pr ready failed: ${readyResult.stderr.trim() || readyResult.stdout.trim() || 'unknown error'}`,
      };
    }
    // Step 13 cleanup sentinel
    try {
      await cleanupTask({ taskId: opts.taskId, worktreePath });
    } catch {
      // Non-fatal
    }
    logger.progress('resume-from-draft', `PR #${prNumber} flipped to ready`);
    return {
      ok: true,
      resumedFrom: 'Step 13 (attestation already present)',
      prUrl,
      outcome: 'resumed-and-ready',
    };
  }

  // Bug 1 (AISDLC-355): A prior failed run may have written a synthetic-critical
  // placeholder verdict (from `coerceReviewerVerdict` fallback). If the verdict
  // file exists but contains a "returned no parseable verdict" finding, treat it
  // as absent so reviewers re-run rather than re-using the stale failure.
  // --force-reviewers provides an explicit operator override to bypass any
  // existing verdict file and always re-run reviewers.
  let verdictFileIsStale = opts.forceReviewers === true;
  if (verdictFileIsStale && state.hasVerdictFile) {
    logger.info(
      `[ai-sdlc] resume-from-draft: --force-reviewers set; bypassing existing verdict file for ${opts.taskId}`,
    );
  }
  if (state.hasVerdictFile && !verdictFileIsStale) {
    const taskIdLower = opts.taskId.toLowerCase();
    const verdictPath = join(worktreePath, '.ai-sdlc', 'verdicts', `${taskIdLower}.json`);
    try {
      const raw = readFileSync(verdictPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      // Handle both flat array and nested VerdictFilePayload shapes.
      const verdictEntries: unknown[] = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null && 'verdicts' in parsed
          ? ((parsed as { verdicts: unknown[] }).verdicts ?? [])
          : [];
      const hasSyntheticCritical = verdictEntries.some((v) => {
        if (!v || typeof v !== 'object') return false;
        const entry = v as { findings?: unknown };
        if (!Array.isArray(entry.findings)) return false;
        return entry.findings.some(
          (f: unknown) =>
            typeof f === 'object' &&
            f !== null &&
            typeof (f as { message?: unknown }).message === 'string' &&
            /returned no parseable verdict/i.test((f as { message: string }).message),
        );
      });
      if (hasSyntheticCritical) {
        verdictFileIsStale = true;
        logger.info(
          `[ai-sdlc] resume-from-draft: verdict file for ${opts.taskId} contains synthetic-critical placeholder — treating as absent; will re-run reviewers`,
        );
      }
    } catch {
      // If we can't read/parse the verdict, treat it as stale to be safe.
      verdictFileIsStale = true;
      logger.info(
        `[ai-sdlc] resume-from-draft: verdict file for ${opts.taskId} is unreadable — treating as absent; will re-run reviewers`,
      );
    }
  }

  // Effective hasVerdictFile: stale files are treated as absent.
  const effectiveHasVerdictFile = state.hasVerdictFile && !verdictFileIsStale;

  // Case B: verdict file exists but no attestation → re-sign + flip
  // The pre-push hook handles attestation signing. We just push the branch
  // (which triggers the attestation hook) and then flip to ready.
  if (effectiveHasVerdictFile && !state.hasAttestationCommit) {
    logger.progress(
      'resume-from-draft',
      `verdict file present; pushing to trigger attestation hook, then flipping PR #${prNumber} to ready`,
    );
    // Force-push the branch (it was already pushed, so we need --force-with-lease)
    const pushResult = await runner('git', ['push', '--force-with-lease', 'origin', branch], {
      cwd: worktreePath,
      allowFailure: true,
    });
    if (pushResult.code !== 0) {
      return {
        ok: false,
        resumedFrom: 'Step 10/11 re-push for attestation',
        prUrl,
        outcome: 'failed',
        reason: `re-push failed: ${pushResult.stderr.trim() || 'unknown error'}`,
      };
    }
    const readyResult = await runner('gh', ['pr', 'ready', String(prNumber)], {
      cwd: opts.workDir,
      allowFailure: true,
    });
    if (readyResult.code !== 0) {
      return {
        ok: false,
        resumedFrom: 'Step 13 flip-to-ready',
        prUrl,
        outcome: 'failed',
        reason: `gh pr ready failed: ${readyResult.stderr.trim() || 'unknown error'}`,
      };
    }
    try {
      await cleanupTask({ taskId: opts.taskId, worktreePath });
    } catch {
      // Non-fatal
    }
    logger.progress('resume-from-draft', `PR #${prNumber} re-pushed + flipped to ready`);
    return {
      ok: true,
      resumedFrom: 'Steps 10/11/13 (verdict present, attestation pending)',
      prUrl,
      outcome: 'resumed-and-ready',
    };
  }

  // Case C: no verdict file → re-run reviewers (Step 7/8), write verdict (Step 10), flip ready (Step 13)
  if (state.commitCount === 0) {
    return {
      ok: false,
      resumedFrom: 'detection',
      prUrl,
      outcome: 'failed',
      reason: `Draft PR #${prNumber} exists but branch has no commits beyond origin/main. Cannot determine what to review.`,
    };
  }

  logger.progress(
    'resume-from-draft',
    `running reviewers on draft PR #${prNumber} (no verdict file found)`,
  );

  const reviewBuild = await buildReviewPrompts({
    taskId: opts.taskId,
    task,
    branch,
    worktreePath,
    workDir: opts.workDir,
    runner,
  });

  // Bug 3 (AISDLC-355): Use spawnReviewerWithRetry so degenerate reviewer
  // results are retried once before falling through to the synthetic-critical
  // placeholder. Runs the 3 reviewers in parallel (same as the main pipeline).
  const verdicts: ReviewerVerdict[] = await Promise.all(
    reviewBuild.prompts.map((p, i) =>
      spawnReviewerWithRetry(
        opts.spawner,
        { type: p.reviewer, prompt: p.prompt, cwd: worktreePath },
        REVIEWER_TYPES[i],
        logger,
      ),
    ),
  );

  const aggregated = await aggregateVerdicts({
    verdicts,
    harnessNote: reviewBuild.harnessNote,
  });

  // Bug 2 (AISDLC-355): Write the FLAT verdicts array so sign-attestation.mjs
  // can read it directly. The nested VerdictFilePayload shape stays in memory
  // for in-process orchestration (via the `aggregated` object) but is NOT what
  // gets serialized to disk for the pre-push attestation hook.
  let verdictFilePath: string | undefined;
  try {
    const taskIdLower = opts.taskId.toLowerCase();
    const verdictDir = join(worktreePath, '.ai-sdlc', 'verdicts');
    mkdirSync(verdictDir, { recursive: true });
    verdictFilePath = join(verdictDir, `${taskIdLower}.json`);
    writeFileSync(verdictFilePath, JSON.stringify(aggregated.verdicts, null, 2) + '\n', 'utf8');
    logger.progress('resume-from-draft', `verdict written: ${aggregated.decision}`);
  } catch (err) {
    logger.warn(`[ai-sdlc] verdict write failed (non-fatal): ${(err as Error).message}`);
    verdictFilePath = undefined;
  }

  // Push (triggers attestation hook) + flip to ready
  const pushResult = await runner('git', ['push', '--force-with-lease', 'origin', branch], {
    cwd: worktreePath,
    allowFailure: true,
  });
  if (pushResult.code !== 0) {
    return {
      ok: false,
      resumedFrom: 'Steps 7/8/10/11 (reviewers + re-push)',
      prUrl,
      outcome: 'failed',
      reason: `re-push failed after review: ${pushResult.stderr.trim() || 'unknown error'}`,
      finalVerdict: aggregated,
    };
  }

  const readyResult = await runner('gh', ['pr', 'ready', String(prNumber)], {
    cwd: opts.workDir,
    allowFailure: true,
  });
  if (readyResult.code !== 0) {
    return {
      ok: false,
      resumedFrom: 'Step 13 flip-to-ready',
      prUrl,
      outcome: 'failed',
      reason: `gh pr ready failed: ${readyResult.stderr.trim() || 'unknown error'}`,
      finalVerdict: aggregated,
    };
  }

  try {
    await cleanupTask({ taskId: opts.taskId, worktreePath });
  } catch {
    // Non-fatal
  }

  logger.progress(
    'resume-from-draft',
    `PR #${prNumber} reviewed (${aggregated.decision}) + flipped to ready`,
  );

  void verdictFilePath; // suppress unused var (written for hook, not returned)

  return {
    ok: true,
    resumedFrom: 'Steps 7/8/10/13 (reviewers ran fresh)',
    prUrl,
    outcome: 'resumed-and-ready',
    finalVerdict: aggregated,
  };
}
