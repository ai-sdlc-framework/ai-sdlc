/**
 * `ai-sdlc-pipeline execute --rework-pr <pr-number>` — rework path for
 * "PR exists, reviewers found bugs, dev needs to fix".
 *
 * AISDLC-273 — See `docs/operations/recovery-flows.md` for the full decision tree.
 *
 * ## Why this path exists
 *
 * When a dispatch completes and reviewers (post-hoc or automated) find
 * critical/major issues, the operator needs a way to:
 *   1. Feed the reviewer findings back to the developer subagent as additional
 *      context ("here are the bugs; fix them on top of the existing branch").
 *   2. Re-run Steps 5-13 fresh on top of the existing branch (no new worktree
 *      — the dev continues from where they left off).
 *   3. Force-push the rebased + re-attested HEAD.
 *
 * The `--rework-pr` path is bounded by the same Step 9 iteration cap (max N
 * rework rounds before escalation). After `maxReworkIterations` rework rounds
 * without an APPROVED verdict, the PR is tagged `[needs-human-attention]` and
 * the command exits with `outcome: 'needs-human-attention'`.
 *
 * ## Reviewer findings format
 *
 * The command reads PR comments matching the `<!-- ai-sdlc:reviewer-findings -->`
 * HTML comment marker. These are injected by the automated review step and by
 * the operator's manual review tooling. The findings block is extracted and
 * appended to the developer's re-dispatch prompt as additional context.
 *
 * @module cli/rework-pr
 */

import { defaultRunner, type Runner } from '../runtime/exec.js';
import {
  aggregateVerdicts,
  buildDeveloperPrompt,
  buildReviewPrompts,
  cleanupTask,
  coerceReviewerVerdict,
  computeBranchName,
  finalizeTask,
  iterateReviewLoop,
  parseDeveloperReturnWithRetry,
  validateTask,
} from '../steps/index.js';
import {
  DEFAULT_LOGGER,
  type AggregatedVerdict,
  type DeveloperReturn,
  type PipelineLogger,
  type ReviewerType,
  type ReviewerVerdict,
  type SubagentSpawner,
} from '../types.js';
import { writeVerdictFile } from './execute.js';

const REVIEWER_TYPES: ReviewerType[] = ['code-reviewer', 'test-reviewer', 'security-reviewer'];

/** Marker used to identify reviewer findings blocks in PR comments. */
export const REVIEWER_FINDINGS_MARKER = '<!-- ai-sdlc:reviewer-findings -->';

/**
 * Branches that the recovery-flow commands MUST refuse to force-push to,
 * even when the PR metadata or worktree state would otherwise permit it.
 * Mirrors the `/ai-sdlc rebase` resolver's protected-branch list and the
 * CLAUDE.md "Never force-push to main/master" rule.
 */
export const PROTECTED_BRANCHES = new Set(['main', 'master']);

/**
 * GitHub author associations that are trusted for reviewer-findings injection.
 * Comments from drive-by/external accounts (NONE, CONTRIBUTOR, FIRST_TIMER,
 * FIRST_TIME_CONTRIBUTOR) are IGNORED to prevent prompt-injection attacks where
 * a hostile commenter pastes the REVIEWER_FINDINGS_MARKER substring followed
 * by adversarial text that the rework dev subagent would otherwise treat as
 * authoritative reviewer guidance (PR #489 round-1 security finding).
 *
 * The set matches GitHub's `authorAssociation` enum:
 * https://docs.github.com/en/graphql/reference/enums#commentauthorassociation
 */
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Bot accounts whose comments are ALSO trusted for reviewer-findings injection
 * (regardless of authorAssociation, which is often NONE for bots). Add the bot
 * accounts your CI uses to post reviewer findings here. By default this set is
 * empty; operators MUST explicitly opt in by editing this list.
 */
const TRUSTED_BOT_LOGINS = new Set<string>([]);

interface PrComment {
  body: string;
  author?: { login?: string } | null;
  authorAssociation?: string;
}

/**
 * Fetch PR reviewer findings from PR comments.
 *
 * Returns raw bodies of comments that BOTH:
 *   1. contain the `REVIEWER_FINDINGS_MARKER` substring, AND
 *   2. were authored by a trusted account (`authorAssociation` in
 *      `TRUSTED_AUTHOR_ASSOCIATIONS`, OR `author.login` in `TRUSTED_BOT_LOGINS`).
 *
 * The author-trust filter prevents a prompt-injection attack where a
 * drive-by GitHub commenter pastes the marker followed by text that
 * subverts the rework dev subagent's task.
 */
export async function fetchReviewerFindings(
  prNumber: number,
  workDir: string,
  runner: Runner,
): Promise<string[]> {
  const result = await runner('gh', ['pr', 'view', String(prNumber), '--json', 'comments'], {
    cwd: workDir,
    allowFailure: true,
  });
  if (result.code !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { comments?: PrComment[] };
    const comments = parsed.comments ?? [];
    return comments
      .filter((c) => {
        if (!c?.body || !c.body.includes(REVIEWER_FINDINGS_MARKER)) return false;
        const association = c.authorAssociation ?? '';
        if (TRUSTED_AUTHOR_ASSOCIATIONS.has(association)) return true;
        const login = c.author?.login ?? '';
        if (login && TRUSTED_BOT_LOGINS.has(login)) return true;
        return false;
      })
      .map((c) => c.body);
  } catch {
    return [];
  }
}

/** Options for `runReworkPr`. */
export interface ReworkPrOptions {
  prNumber: number;
  workDir: string;
  spawner: SubagentSpawner;
  runner?: Runner;
  logger?: PipelineLogger;
  maxReworkIterations?: number;
  /** Override verdict writer for tests. */
  verdictWriter?: typeof writeVerdictFile;
}

/** Result from `runReworkPr`. */
export interface ReworkPrResult {
  ok: boolean;
  prUrl: string | null;
  outcome: 'approved' | 'needs-human-attention' | 'failed';
  reason?: string;
  finalVerdict?: AggregatedVerdict;
  iterations: number;
}

/**
 * AISDLC-273 — re-dispatch the developer on top of an existing branch to fix
 * reviewer findings, then re-run reviews + attestation + flip-to-ready.
 *
 * The developer is given the existing branch context plus any `<!-- ai-sdlc:reviewer-findings -->`
 * blocks from PR comments as additional rework context.
 */
export async function runReworkPr(opts: ReworkPrOptions): Promise<ReworkPrResult> {
  const logger = opts.logger ?? DEFAULT_LOGGER;
  const runner = opts.runner ?? defaultRunner;
  const writer = opts.verdictWriter ?? writeVerdictFile;
  const maxReworkIterations = opts.maxReworkIterations ?? 2;

  logger.progress('rework-pr', `fetching PR #${opts.prNumber} metadata`);

  // 1. Get PR metadata (branch, task ID)
  const prMetaResult = await runner(
    'gh',
    ['pr', 'view', String(opts.prNumber), '--json', 'headRefName,title,url,isDraft'],
    { cwd: opts.workDir, allowFailure: true },
  );
  if (prMetaResult.code !== 0) {
    return {
      ok: false,
      prUrl: null,
      outcome: 'failed',
      reason: `gh pr view failed: ${prMetaResult.stderr.trim() || 'unknown error'}`,
      iterations: 0,
    };
  }

  let prMeta: { headRefName: string; title: string; url: string; isDraft: boolean };
  try {
    prMeta = JSON.parse(prMetaResult.stdout.trim()) as typeof prMeta;
  } catch {
    return {
      ok: false,
      prUrl: null,
      outcome: 'failed',
      reason: 'Failed to parse gh pr view output',
      iterations: 0,
    };
  }

  const branch = prMeta.headRefName;
  const prUrl = prMeta.url;

  // Refuse to operate on a PR whose head branch is main/master. The branch
  // is derived from PR metadata, so a misconfigured PR (or one targeting the
  // wrong refspec) could otherwise let a downstream `git push --force-with-lease`
  // rewrite main. CLAUDE.md: "Never force-push to main/master."
  if (PROTECTED_BRANCHES.has(branch)) {
    return {
      ok: false,
      prUrl,
      outcome: 'failed',
      reason: `refusing to rework PR with head branch '${branch}': main/master are protected. Operator: rebase the PR onto a non-default branch first.`,
      iterations: 0,
    };
  }

  // 2. Extract task ID from branch name (e.g. ai-sdlc/aisdlc-273-... → AISDLC-273)
  const taskIdMatch = branch.match(/aisdlc-(\d+(?:\.\d+)?)/i);
  if (!taskIdMatch) {
    return {
      ok: false,
      prUrl,
      outcome: 'failed',
      reason: `Cannot derive task ID from branch name '${branch}'. Branch must follow the ai-sdlc/<task-id>-... naming convention.`,
      iterations: 0,
    };
  }
  const taskId = `AISDLC-${taskIdMatch[1]}`;

  logger.progress('rework-pr', `task=${taskId} branch=${branch} PR=${prUrl}`);

  // 3. Validate task
  const validation = await validateTask({ taskId, workDir: opts.workDir });
  if (!validation.ok || !validation.task) {
    return {
      ok: false,
      prUrl,
      outcome: 'failed',
      reason: validation.reason ?? 'task validation failed',
      iterations: 0,
    };
  }
  const task = validation.task;

  const branchResult = await computeBranchName({
    taskId,
    task,
    workDir: opts.workDir,
  });
  const worktreePath = branchResult.worktreePath;

  // 4. Fetch reviewer findings from PR comments
  logger.progress('rework-pr', `fetching reviewer findings from PR #${opts.prNumber}`);
  const findingsComments = await fetchReviewerFindings(opts.prNumber, opts.workDir, runner);
  const findingsContext =
    findingsComments.length > 0
      ? `\n\n## Reviewer Findings from PR #${opts.prNumber}\n\n` +
        findingsComments.map((c, i) => `### Reviewer comment ${i + 1}\n\n${c}`).join('\n\n')
      : '';

  logger.info(
    `[ai-sdlc] rework-pr: found ${findingsComments.length} reviewer-findings comment(s) for PR #${opts.prNumber}`,
  );

  // 5. Build developer rework prompt with findings context
  logger.progress('rework-pr', `building rework dev prompt (iteration 1)`);
  const { prompt: baseDevPrompt } = await buildDeveloperPrompt({
    taskId,
    task,
    branch,
    worktreePath,
    iteration: 1,
  });

  const reworkDevPrompt =
    baseDevPrompt +
    findingsContext +
    '\n\n## Rework Instructions\n\n' +
    `You are being asked to fix issues found by reviewers on PR #${opts.prNumber}. ` +
    'The above reviewer findings describe the specific issues. Fix them on top of the existing commits.\n' +
    'DO NOT re-implement from scratch. Build on top of what already exists.\n' +
    'After fixing, run tests and push with --force-with-lease.\n';

  // 6. Spawn developer for rework
  logger.progress('rework-pr', `dispatching developer for rework`);
  const devSpawn = await opts.spawner.spawn({
    type: 'developer',
    prompt: reworkDevPrompt,
    cwd: worktreePath,
  });

  const parsedDev = await parseDeveloperReturnWithRetry({
    initialResult: devSpawn,
    cwd: worktreePath,
    spawner: opts.spawner,
  });

  if (!parsedDev.ok || !parsedDev.developer) {
    return {
      ok: false,
      prUrl,
      outcome: 'failed',
      reason: parsedDev.reason ?? 'developer rework subagent failed',
      iterations: 1,
    };
  }
  const initialDev: DeveloperReturn = parsedDev.developer;

  // 7. Build review prompts + spawn 3 reviewers
  logger.progress('rework-pr', `running 3 reviewers after rework`);
  const reviewBuild = await buildReviewPrompts({
    taskId,
    task,
    branch,
    worktreePath,
    workDir: opts.workDir,
    runner,
  });

  const reviewerResults = await opts.spawner.spawnParallel(
    reviewBuild.prompts.map((p) => ({
      type: p.reviewer,
      prompt: p.prompt,
      cwd: worktreePath,
    })),
  );
  const initialVerdicts: ReviewerVerdict[] = reviewerResults.map((r, i) =>
    coerceReviewerVerdict(REVIEWER_TYPES[i], r),
  );

  const initialVerdict = await aggregateVerdicts({
    verdicts: initialVerdicts,
    harnessNote: reviewBuild.harnessNote,
  });

  // 8. Iterate if needed (same cap as executePipeline)
  const loop = await iterateReviewLoop({
    taskId,
    worktreePath,
    task,
    branch,
    initialDeveloperReturn: initialDev,
    initialVerdict,
    maxIterations: maxReworkIterations,
    spawner: opts.spawner,
    onIteration: (_iteration, verdict) => {
      try {
        writer({ taskId, worktreePath, iteration: _iteration, verdict });
      } catch {
        // Non-fatal
      }
    },
  });

  // Write final verdict
  let verdictFilePath: string | undefined;
  try {
    verdictFilePath = writer({
      taskId,
      worktreePath,
      iteration: loop.iterations,
      verdict: loop.finalVerdict,
    });
    logger.progress('rework-pr', `verdict written: ${loop.finalVerdict.decision}`);
  } catch (err) {
    logger.warn(`[ai-sdlc] verdict write failed (non-fatal): ${(err as Error).message}`);
  }
  void verdictFilePath;

  // 9. Finalize (write summary + ACs)
  await finalizeTask({
    taskId,
    workDir: opts.workDir,
    worktreePath,
    task,
    developerReturn: loop.finalDeveloperReturn,
    verdict: loop.finalVerdict,
    iterations: loop.iterations,
    runner,
    skipCommit: false,
  });

  // 10. Force-push the rebased + re-attested HEAD
  logger.progress('rework-pr', `force-pushing rework branch`);
  const pushResult = await runner('git', ['push', '--force-with-lease', 'origin', branch], {
    cwd: worktreePath,
    allowFailure: true,
  });
  if (pushResult.code !== 0) {
    return {
      ok: false,
      prUrl,
      outcome: 'failed',
      reason: `force-push failed: ${pushResult.stderr.trim() || 'unknown error'}`,
      finalVerdict: loop.finalVerdict,
      iterations: loop.iterations,
    };
  }

  // 11. Flip to ready (or ensure it stays/becomes ready if it was already a draft)
  if (prMeta.isDraft) {
    logger.progress('rework-pr', `flipping PR #${opts.prNumber} from draft to ready`);
    const readyResult = await runner('gh', ['pr', 'ready', String(opts.prNumber)], {
      cwd: opts.workDir,
      allowFailure: true,
    });
    if (readyResult.code !== 0) {
      logger.warn(
        `[ai-sdlc] rework-pr: gh pr ready failed (non-fatal): ${readyResult.stderr.trim()}`,
      );
    }
  }

  // 12. Cleanup sentinel
  try {
    await cleanupTask({ taskId, worktreePath });
  } catch {
    // Non-fatal
  }

  const finalOutcome: ReworkPrResult['outcome'] = loop.needsHumanAttention
    ? 'needs-human-attention'
    : 'approved';

  logger.progress(
    'rework-pr',
    `outcome=${finalOutcome} iterations=${loop.iterations} verdict=${loop.finalVerdict.decision}`,
  );

  return {
    ok: true,
    prUrl,
    outcome: finalOutcome,
    finalVerdict: loop.finalVerdict,
    iterations: loop.iterations,
  };
}

/**
 * Build the rework path output key for the `--rework-pr` flag in
 * the CLI handler. Exported for tests.
 */
export function describeReworkOutcome(result: ReworkPrResult): string {
  if (!result.ok) return `rework failed: ${result.reason ?? 'unknown'}`;
  if (result.outcome === 'approved') {
    return `rework approved after ${result.iterations} iteration(s) — PR ready for merge`;
  }
  if (result.outcome === 'needs-human-attention') {
    return (
      `rework hit iteration cap (${result.iterations} round(s)) with unresolved findings — ` +
      `PR tagged [needs-human-attention]`
    );
  }
  return `rework: ${result.outcome}`;
}
