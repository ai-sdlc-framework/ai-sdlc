/**
 * Everything after the reviewers approve (or the iteration cap is hit):
 *
 *   10.5  pre-sign rebase + contentHash oracle (AISDLC-102)
 *   10    task Done + verdicts file + chore commit (signing stays with the hook)
 *   10.6  in-process signing on consumer repos (AISDLC-598)
 *   11    push (hook may sign and ask for one re-push), DRAFT PR (AISDLC-218),
 *         incremental-review marker (AISDLC-142)
 *   12    sibling PRs
 *   13    `gh pr ready` (CI fires once, on the fully signed state)
 *   15    sentinel cleanup
 *
 * Hard rules honoured here: no force-push of any kind, no merge command, the
 * CI-skip tokens are scrubbed from the chore-commit body (AISDLC-88), and a
 * rebase conflict is never auto-resolved.
 *
 * @module next-step/ship
 */

import { join } from 'node:path';
import { writeVerdictFile } from '../cli/execute.js';
import { resolveTargetBranch } from '../steps/02-compute-branch.js';
import { detectDraftPrForBranch } from '../steps/03-setup-worktree.js';
import { findTaskFile } from '../steps/01-validate.js';
import { buildFinalSummary } from '../steps/10-finalize.js';
import { composeBody, composeTitle, readTitleTemplate } from '../steps/11-push-and-pr.js';
import { siblingPrs } from '../steps/12-sibling-prs.js';
import { cleanupTask } from '../steps/13-cleanup.js';
import {
  TRUSTED_MARKER_AUTHOR_ASSOCIATIONS,
  TRUSTED_MARKER_AUTHOR_LOGINS,
  MARKER_PREFIX,
} from '../incremental-review/incremental.js';
import { markTaskDone } from './task-done.js';
import { recordSessionPr, updateSessionState } from './session.js';
import type { DoneInstruction, NextStepContext, NextStepState, StopInstruction } from './types.js';

// ── 10.5 pre-sign rebase ─────────────────────────────────────────────

export type PreSignRebaseResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'unchanged'; hash: string }
  | { kind: 'changed'; before: string; after: string }
  | { kind: 'failed'; reason: string };

const MAX_REBASE_ATTEMPTS = 3;

async function contentHash(ctx: NextStepContext, worktreePath: string): Promise<string> {
  const r = await ctx.runner(
    'node',
    [join(ctx.pluginScriptsDir, 'sign-attestation.mjs'), '--print-content-hash'],
    { cwd: worktreePath, allowFailure: true },
  );
  return r.code === 0 ? r.stdout.trim() : '';
}

/**
 * Rebase onto the latest target branch before signing. Fetch trouble skips the
 * rebase (a flaky network must not block signing); a conflict or a rebase loop
 * fails the run, because conflict resolution is the operator's.
 */
export async function preSignRebase(
  ctx: NextStepContext,
  state: NextStepState,
): Promise<PreSignRebaseResult> {
  const wt = state.worktreePath;
  const target = resolveTargetBranch(ctx.workDir);
  const before = await contentHash(ctx, wt);

  const fetch = await ctx.runner('git', ['fetch', 'origin', target], {
    cwd: wt,
    allowFailure: true,
    timeout: 30_000,
  });
  if (fetch.code !== 0) {
    return { kind: 'skipped', reason: `git fetch origin ${target} failed (timeout/network)` };
  }
  const anc = await ctx.runner('git', ['merge-base', '--is-ancestor', `origin/${target}`, 'HEAD'], {
    cwd: wt,
    allowFailure: true,
  });
  if (anc.code === 0)
    return { kind: 'skipped', reason: `origin/${target} already ancestor of HEAD` };

  let attempts = 0;
  let ok = false;
  while (attempts < MAX_REBASE_ATTEMPTS) {
    attempts += 1;
    const rb = await ctx.runner('git', ['rebase', `origin/${target}`], {
      cwd: wt,
      allowFailure: true,
      timeout: 120_000,
    });
    if (rb.code === 0) {
      ok = true;
      break;
    }
    await ctx.runner('git', ['rebase', '--abort'], { cwd: wt, allowFailure: true });
    const refetch = await ctx.runner('git', ['fetch', 'origin', target], {
      cwd: wt,
      allowFailure: true,
      timeout: 30_000,
    });
    if (refetch.code !== 0) break;
  }
  if (!ok) {
    return {
      kind: 'failed',
      reason:
        attempts >= MAX_REBASE_ATTEMPTS
          ? `Step 10.5 rebase loop: ${target} moved ${MAX_REBASE_ATTEMPTS} times during rebase attempts (rebase-loop)`
          : `Step 10.5 rebase conflict, operator must resolve manually: cd ${wt} && git fetch origin ${target} && git rebase origin/${target}; then re-run /ai-sdlc execute ${state.taskId} (rebase-conflict)`,
    };
  }
  const after = await contentHash(ctx, wt);
  if (before !== '' && before === after) return { kind: 'unchanged', hash: before };
  return { kind: 'changed', before, after };
}

// ── 10 chore commit ──────────────────────────────────────────────────

const CI_SKIP_REWRITES: Array<[RegExp, string]> = [
  [/\[skip ci\]/gi, '(skip ci marker)'],
  [/\[ci skip\]/gi, '(ci skip marker)'],
  [/\[no ci\]/gi, '(no ci marker)'],
  [/\[skip actions\]/gi, '(skip actions marker)'],
  [/\[actions skip\]/gi, '(actions skip marker)'],
];

/**
 * Rewrite the five GitHub Actions CI-skip magic tokens to their paren-quoted
 * form (AISDLC-88, hard rule 7). A commit that carries one silently disables
 * verify-attestation and ai-sdlc-review.
 */
export function sanitizeCiSkipTokens(text: string): string {
  return CI_SKIP_REWRITES.reduce((acc, [re, to]) => acc.replace(re, to), text);
}

export function choreCommitMessage(taskId: string): string {
  return sanitizeCiSkipTokens(
    `chore: mark ${taskId} complete\n\n` +
      `Auto-generated by /ai-sdlc execute. Reviews approved; task lifecycle landed in this PR.\n` +
      `The signed review attestation lands on a follow-up chore commit auto-produced by\n` +
      `the husky pre-push hook (AISDLC-133) at .ai-sdlc/attestations/<head-sha>.dsse.json\n` +
      `(AISDLC-74) so CI's verify-attestation workflow can skip the duplicate review run.\n\n` +
      `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`,
  );
}

// ── result builders ──────────────────────────────────────────────────

function stop(
  state: NextStepState,
  outcome: StopInstruction['outcome'],
  reason: string,
): StopInstruction {
  return {
    action: 'stop',
    taskId: state.taskId,
    outcome,
    reason,
    branch: state.branch,
    worktreePath: state.worktreePath,
    prUrl: null,
    developer: state.developer,
    notes: reason,
  };
}

function reviewsSummary(state: NextStepState): DoneInstruction['reviews'] {
  const v = state.verdict;
  if (!v) return null;
  return {
    iterations: state.iteration,
    harnessNote: v.harnessNote,
    verdicts: v.verdicts.map((x) => {
      const findings = { critical: 0, major: 0, minor: 0, suggestion: 0 };
      for (const f of x.findings ?? []) findings[f.severity] = (findings[f.severity] ?? 0) + 1;
      return { agentId: String(x.agentId), harness: x.harness, approved: x.approved, findings };
    }),
  };
}

// ── ship ─────────────────────────────────────────────────────────────

const PUSH_ATTEMPTS = 2;
const PUSH_TIMEOUT_MS = 30 * 60_000;

/**
 * Close the run: mark Done, push, open the DRAFT PR, flip it ready. Returns the
 * terminal instruction (`done` or `stop`); the sentinel is always cleaned up.
 */
export async function shipTask(
  ctx: NextStepContext,
  state: NextStepState,
): Promise<DoneInstruction | StopInstruction> {
  try {
    return await shipInner(ctx, state);
  } finally {
    try {
      await cleanupTask({ taskId: state.taskId, worktreePath: state.worktreePath });
    } catch (err) {
      ctx.logger.warn(`Step 15 sentinel cleanup failed (non-fatal): ${(err as Error).message}`);
    }
  }
}

async function shipInner(
  ctx: NextStepContext,
  state: NextStepState,
): Promise<DoneInstruction | StopInstruction> {
  const { runner } = ctx;
  const wt = state.worktreePath;
  const developer = state.developer;
  const verdict = state.verdict;
  if (!developer || !verdict)
    return stop(state, 'aborted', 'ship called before a developer pass and a review verdict exist');
  const needsHuman = state.needsHumanAttention;

  if (!needsHuman) {
    // Step 10 — refuse early when the contributor has no signing key (the hook would fail loudly).
    if (!ctx.exists(join(ctx.homeDir, '.ai-sdlc', 'signing-key.pem'))) {
      return stop(
        state,
        'aborted',
        'No signing key at ~/.ai-sdlc/signing-key.pem. Run /ai-sdlc init-signing-key once, open the printed onboarding PR adding your pubkey to .ai-sdlc/trusted-reviewers.yaml, then re-run. (The pre-push hook refuses to sign without this key.)',
      );
    }
    const { finalSummary, acceptanceCriteriaCheck } = buildFinalSummary({
      taskId: state.taskId,
      workDir: ctx.workDir,
      worktreePath: wt,
      task: state.task,
      developerReturn: developer,
      verdict,
      iterations: state.iteration,
    });
    const taskFile = findTaskFile(state.taskId, wt);
    if (taskFile) {
      markTaskDone(taskFile, { acceptanceCriteriaCheck, finalSummary });
    } else if (!ctx.exists(join(wt, 'backlog', 'completed'))) {
      return stop(
        state,
        'aborted',
        `Step 10: cannot locate task file for ${state.taskId} under ${wt}`,
      );
    }
    writeVerdictFile({
      taskId: state.taskId,
      worktreePath: wt,
      iteration: state.iteration,
      verdict,
    });

    await runner('git', ['add', 'backlog/tasks', 'backlog/completed'], {
      cwd: wt,
      allowFailure: true,
    });
    const commit = await runner('git', ['commit', '-m', choreCommitMessage(state.taskId)], {
      cwd: wt,
      allowFailure: true,
      timeout: 300_000,
    });
    if (commit.code !== 0) {
      return stop(
        state,
        'aborted',
        `Step 10 chore commit failed: ${(commit.stderr || commit.stdout).trim()}`,
      );
    }

    // Step 10.6 — consumer repos have no hook that signs; the script no-ops in the monorepo.
    const sign = await runner(
      'bash',
      [join(ctx.pluginScriptsDir, 'sign-attestation-if-consumer.sh')],
      { cwd: wt, allowFailure: true, timeout: 600_000 },
    );
    if (sign.code !== 0) {
      return stop(
        state,
        'aborted',
        `Step 10.6 in-process attestation signing failed self-verification or the signer failed; aborting before push. ${(sign.stderr || sign.stdout).trim()}`,
      );
    }
  }

  // Step 11a — push. The pre-push hook may sign, commit the envelope and exit 1 once.
  const pushEnv = {
    AI_SDLC_ITERATION_COUNT: String(state.iteration),
    AI_SDLC_HARNESS_NOTE: verdict.harnessNote,
  };
  let pushRc = 1;
  let pushErr = '';
  for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt += 1) {
    const push = await runner('git', ['push', '-u', 'origin', state.branch], {
      cwd: wt,
      allowFailure: true,
      timeout: PUSH_TIMEOUT_MS,
      env: pushEnv,
    });
    pushRc = push.code;
    pushErr = (push.stderr || push.stdout).trim();
    if (pushRc === 0) break;
  }
  if (pushRc !== 0) {
    const nonFf = /non-fast-forward|rejected/i.test(pushErr);
    return stop(
      state,
      'aborted',
      nonFf
        ? `non-fast-forward push to '${state.branch}'; cleanup is to delete the remote branch and rerun, but that is destructive, confirm with the operator first (no force-push is attempted)`
        : `${PUSH_ATTEMPTS} push attempts failed (last exit ${pushRc}): ${pushErr}`,
    );
  }

  // Step 11b — DRAFT PR (CI must not fire until Step 13).
  const existing = await detectDraftPrForBranch(runner, wt, state.branch);
  let prUrl: string | null = existing?.prUrl || null;
  let prNumber: number | null = existing?.prNumber ?? null;
  const notes: string[] = [];
  if (existing) {
    notes.push(`reused open PR #${existing.prNumber} for ${state.branch} (already opened)`);
  } else {
    const template = readTitleTemplate(ctx.workDir, ctx.logger);
    const title = composeTitle(template, state.taskId, state.task.title, needsHuman);
    let body = composeBody({
      taskId: state.taskId,
      workDir: ctx.workDir,
      worktreePath: wt,
      branch: state.branch,
      task: state.task,
      developerReturn: developer,
      verdict,
      needsHumanAttention: needsHuman,
    });
    const footer = `\nReferences ${state.taskId}\n`;
    const line = state.classifierLine ? `\n${state.classifierLine}\n` : '';
    body = body.endsWith(footer) ? body.slice(0, -footer.length) + line + footer : body + line;
    const create = await runner(
      'gh',
      [
        'pr',
        'create',
        '--draft',
        '--title',
        title,
        '--body',
        body,
        '--base',
        resolveTargetBranch(ctx.workDir),
        '--head',
        state.branch,
      ],
      { cwd: wt, allowFailure: true },
    );
    if (create.code !== 0) {
      return stop(
        state,
        'aborted',
        `gh pr create failed: ${(create.stderr || create.stdout).trim()}`,
      );
    }
    prUrl = create.stdout.trim().split('\n').pop()?.trim() || null;
    const m = prUrl ? /\/pull\/(\d+)/.exec(prUrl) : null;
    prNumber = m ? Number(m[1]) : null;
  }
  if (prUrl) recordSessionPr(ctx, state.taskIdLower, prUrl);

  // Step 11c — incremental-review marker, only ever bound to an APPROVED state.
  if (!needsHuman && prNumber !== null && state.review?.incremental.contentHash) {
    await upsertReviewMarker(ctx, state, prNumber, notes);
  }

  // Step 12 — sibling PRs (a failure here never rolls back the main PR).
  let siblingPrUrls: string[] = [];
  if (prUrl) {
    try {
      const sibs = await siblingPrs({
        taskId: state.taskId,
        workDir: ctx.workDir,
        task: state.task,
        developerReturn: developer,
        mainPrUrl: prUrl,
        runner,
      });
      siblingPrUrls = sibs.prs.map((p) => p.prUrl).filter((u): u is string => !!u);
      for (const p of sibs.prs)
        if (!p.prUrl) notes.push(`sibling PR for ${p.repo} not created: ${p.reason ?? 'unknown'}`);
    } catch (err) {
      notes.push(`sibling PR step failed (main PR unaffected): ${(err as Error).message}`);
    }
  }

  // Step 13 — flip draft to ready (CI fires exactly once). Non-fatal.
  if (!needsHuman && prNumber !== null) {
    const ready = await runner('gh', ['pr', 'ready', String(prNumber)], {
      cwd: ctx.workDir,
      allowFailure: true,
    });
    if (ready.code !== 0) {
      notes.push(
        `gh pr ready failed (flip it manually): ${(ready.stderr || ready.stdout).trim() || 'unknown error'}`,
      );
    }
  }
  await updateSessionState(ctx, state.taskIdLower, 'done');

  return {
    action: 'done',
    taskId: state.taskId,
    branch: state.branch,
    worktreePath: wt,
    outcome: needsHuman ? 'needs-human-attention' : 'approved',
    prUrl,
    siblingPrUrls,
    iterations: state.iteration,
    developer,
    reviews: reviewsSummary(state),
    ...(notes.length > 0 ? { notes: notes.join('; ') } : {}),
  };
}

/**
 * Upsert the `last-reviewed-contenthash` marker comment. Best effort: a failure
 * only forces the next push back through a full review, never a safety loss.
 */
async function upsertReviewMarker(
  ctx: NextStepContext,
  state: NextStepState,
  prNumber: number,
  notes: string[],
): Promise<void> {
  const { runner } = ctx;
  const head = (
    await runner('git', ['rev-parse', 'HEAD'], { cwd: state.worktreePath, allowFailure: true })
  ).stdout.trim();
  const fmt = await runner(
    'node',
    [
      join(ctx.cliBinDir, 'cli-incremental-decide.mjs'),
      'format-marker',
      '--content-hash',
      state.review!.incremental.contentHash,
      '--reviewed-sha',
      head,
    ],
    { cwd: ctx.workDir, allowFailure: true },
  );
  if (fmt.code !== 0) {
    notes.push('review marker not written (format-marker failed; next push re-reviews in full)');
    return;
  }
  const commentBody =
    `## AI-SDLC: incremental review state\n\n` +
    `_Auto-managed by \`/ai-sdlc execute\`. Editing this comment will break incremental review for this PR until the next full review re-creates it._\n\n` +
    `${fmt.stdout.trim()}\n`;

  // Only a trusted author's comment may be updated or trusted (AISDLC-142 round 2).
  const list = await runner(
    'gh',
    ['api', `repos/{owner}/{repo}/issues/${prNumber}/comments`, '--paginate'],
    { cwd: ctx.workDir, allowFailure: true },
  );
  let existingId: number | null = null;
  if (list.code === 0) {
    try {
      const comments = JSON.parse(list.stdout || '[]') as Array<{
        id: number;
        body?: string;
        user?: { login?: string };
        author_association?: string;
      }>;
      for (const c of comments) {
        const trusted =
          TRUSTED_MARKER_AUTHOR_LOGINS.has(c.user?.login ?? '') ||
          TRUSTED_MARKER_AUTHOR_ASSOCIATIONS.has(c.author_association ?? '');
        if (trusted && (c.body ?? '').includes(MARKER_PREFIX)) existingId = c.id;
      }
    } catch {
      // fall through to create
    }
  }
  const write =
    existingId !== null
      ? await runner(
          'gh',
          [
            'api',
            `repos/{owner}/{repo}/issues/comments/${existingId}`,
            '-X',
            'PATCH',
            '-f',
            `body=${commentBody}`,
          ],
          { cwd: ctx.workDir, allowFailure: true },
        )
      : await runner('gh', ['pr', 'comment', String(prNumber), '--body', commentBody], {
          cwd: ctx.workDir,
          allowFailure: true,
        });
  if (write.code !== 0)
    notes.push('review marker write failed (non-fatal; next push re-creates it)');
}
