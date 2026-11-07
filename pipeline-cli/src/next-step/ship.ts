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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { reviewsLedgerPath } from '../attestation/reviews-ledger.js';
import { createHash } from 'node:crypto';
import { PUSH_NON_FAST_FORWARD_CAUSE } from '../hierarchy/playbook.js';
import { loadOperationalPolicy } from '../hierarchy/operational.js';
import { isProtectedBranch } from '../hierarchy/lease-policy.js';
import { leasePushPreflight, type LeasePreflight } from '../hierarchy/lease-preflight.js';
import { writeVerdictFile } from '../cli/execute.js';
import { resolveTargetBranch } from '../steps/02-compute-branch.js';
import { decidePrDraft } from '../hierarchy/mark-ready.js';
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
import { attachVerdictRecordDraft } from './review-finalize.js';
import { runTrustedPush } from '../runtime/trusted-push.js';
import { buildVerdictRefspec } from './verdict-ref-push.js';
import { markTaskDone } from './task-done.js';
import { recordSessionPr, updateSessionState } from './session.js';
import type { DoneInstruction, NextStepContext, NextStepState, StopInstruction } from './types.js';

// ── lease-push preflight (AISDLC-798) ────────────────────────────────

/**
 * Evaluate the lease-push hook's own predicate for this task's worktree before the
 * pre-sign rebase, so a push the hook would refuse stops the run before any review
 * or signing is spent.
 */
export function leasePreflightStep(ctx: NextStepContext, state: NextStepState): LeasePreflight {
  const dir = ctx.env['CLAUDE_PROJECT_DIR'];
  return leasePushPreflight({
    projectDir: dir && dir.startsWith('/') ? dir : ctx.workDir,
    cwd: state.worktreePath,
    taskId: state.taskId,
    branch: state.branch,
    env: ctx.env,
  });
}

// ── 10.5 pre-sign rebase ─────────────────────────────────────────────

export type PreSignRebaseResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'unchanged'; hash: string }
  | { kind: 'changed'; before: string; after: string }
  | {
      kind: 'failed';
      reason: string;
      conflictingFiles?: string[];
      cause?: 'rebase-conflict' | 'dirty-worktree' | 'rebase-failed' | 'ledger-not-staged';
    };

/**
 * Content identity of HEAD against its merge-base with `baseRef`: a hash of the
 * (path, new blob id) pairs the branch changes. The old blob id is left out because
 * it moves with the base; a path the base also touched gets a new blob, so a rebase
 * that merged content changes the hash. Empty when it cannot be computed.
 */
async function contentHash(
  ctx: NextStepContext,
  worktreePath: string,
  baseRef: string,
): Promise<string> {
  const mb = await ctx.runner('git', ['merge-base', baseRef, 'HEAD'], {
    cwd: worktreePath,
    allowFailure: true,
  });
  if (mb.code !== 0 || mb.stdout.trim() === '') return '';
  const diff = await ctx.runner(
    'git',
    ['diff', '--raw', '--no-abbrev', '--no-renames', mb.stdout.trim(), 'HEAD'],
    { cwd: worktreePath, allowFailure: true },
  );
  if (diff.code !== 0) return '';
  const pairs = diff.stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [meta = '', path = ''] = l.split('\t');
      return `${meta.split(' ')[3] ?? ''} ${path}`;
    });
  return createHash('sha256').update(pairs.join('\n')).digest('hex');
}

/**
 * Rebase onto the latest target branch before signing. Fetch trouble skips the
 * rebase (a flaky network must not block signing); a conflict fails the run, because conflict resolution is the operator's.
 */
export async function preSignRebase(
  ctx: NextStepContext,
  state: NextStepState,
): Promise<PreSignRebaseResult> {
  const wt = state.worktreePath;
  const target = resolveTargetBranch(ctx.workDir);
  const before = await contentHash(ctx, wt, `origin/${target}`);

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
  if (anc.code === 0) {
    return { kind: 'skipped', reason: `origin/${target} already ancestor of HEAD` };
  }

  // One rebase per run. A non-zero exit is a conflict, never a moved base:
  // under strict=false (AISDLC-727) a PR need not be current with the target,
  // so chasing a moving base buys nothing and a retry would only repeat the
  // same conflict (AISDLC-818).
  const baseBefore = await ctx.runner('git', ['rev-parse', `origin/${target}`], {
    cwd: wt,
    allowFailure: true,
  });
  // The task's review ledger is an untracked/modified file that makes git refuse the
  // rebase; commit it first. A non-empty porcelain means a real change, so no empty
  // commit is made when the ledger equals HEAD (AISDLC-951).
  // Empty root keeps the ledger path worktree-relative; the writer owns the
  // (lowercase) spelling, so it is never rebuilt by hand (AISDLC-1017).
  const owned = [reviewsLedgerPath(state.taskId, '')];
  const pending = await ctx.runner('git', ['status', '--porcelain', '--', ...owned], {
    cwd: wt,
    allowFailure: true,
  });
  if (pending.code === 0 && pending.stdout.trim() !== '') {
    await ctx.runner('git', ['add', '--', owned[0]!], { cwd: wt, allowFailure: true });
    await ctx.runner('git', ['commit', '-m', `chore: commit review ledger (${state.taskId})`], {
      cwd: wt,
      allowFailure: true,
      timeout: 300_000,
    });
  }
  // AISDLC-967: an ignored ledger makes the add above a silent no-op and the PR
  // would ship without it (the incremental review reads committed ledgers only).
  const ledger = owned[0]!;
  if (existsSync(join(wt, ledger))) {
    const tracked = await ctx.runner('git', ['ls-files', '--error-unmatch', '--', ledger], {
      cwd: wt,
      allowFailure: true,
    });
    if (tracked.code !== 0) {
      const rule = await ctx.runner('git', ['check-ignore', '-v', '--no-index', '--', ledger], {
        cwd: wt,
        allowFailure: true,
      });
      const named = rule.stdout.trim() || '(no ignore rule reported; git add did not stage it)';
      return {
        kind: 'failed',
        reason:
          `Step 10.5 cannot stage the review ledger ${ledger} (ledger-not-staged): ${named}. ` +
          `Remove the ignore rule, then re-run /ai-sdlc execute ${state.taskId}`,
        conflictingFiles: [],
        cause: 'ledger-not-staged',
      };
    }
  }
  const rb = await ctx.runner('git', ['rebase', `origin/${target}`], {
    cwd: wt,
    allowFailure: true,
    timeout: 120_000,
  });
  if (rb.code !== 0) {
    const conflicted = await ctx.runner('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd: wt,
      allowFailure: true,
    });
    const files = conflicted.stdout
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f !== '');
    await ctx.runner('git', ['rebase', '--abort'], { cwd: wt, allowFailure: true });
    if (files.length === 0) {
      const err = (rb.stderr || rb.stdout).trim();
      const cause = /uncommitted|unstaged|local changes|dirty/i.test(err)
        ? 'dirty-worktree'
        : 'rebase-failed';
      let dirtyNote = '';
      if (cause === 'dirty-worktree') {
        const dirty = await ctx.runner('git', ['status', '--porcelain'], {
          cwd: wt,
          allowFailure: true,
        });
        const paths = dirty.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '');
        dirtyNote = paths.length > 0 ? ` Dirty paths: ${paths.join(', ')}.` : '';
      }
      return {
        kind: 'failed',
        reason:
          `Step 10.5 rebase refused (${cause}): ${err || '(no git output)'}.${dirtyNote} ` +
          `Fix in ${wt}, then re-run /ai-sdlc execute ${state.taskId} (${cause})`,
        conflictingFiles: [],
        cause,
      };
    }
    const named = files.join(', ');
    return {
      kind: 'failed',
      reason:
        `Step 10.5 rebase conflict in: ${named}. Resolve by hand: cd ${wt} && ` +
        `git fetch origin ${target} && git rebase origin/${target}; then re-run ` +
        `/ai-sdlc execute ${state.taskId} (rebase-conflict)`,
      conflictingFiles: files,
      cause: 'rebase-conflict',
    };
  }
  const baseAfter = await ctx.runner('git', ['rev-parse', `origin/${target}`], {
    cwd: wt,
    allowFailure: true,
  });
  if (baseBefore.code === 0 && baseAfter.code === 0 && baseBefore.stdout !== baseAfter.stdout) {
    ctx.logger.progress(
      'step-10.5',
      `origin/${target} moved during the rebase (now ${baseAfter.stdout.trim()}); not an error under strict=false`,
    );
  }
  const after = await contentHash(ctx, wt, `origin/${target}`);
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
      `The review verdict is recorded outside the branch (RFC-0061); no attestation file is committed.\n\n` +
      `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`,
  );
}

// ── result builders ──────────────────────────────────────────────────

function stop(
  state: NextStepState,
  outcome: StopInstruction['outcome'],
  reason: string,
  extra: { cause?: string } = {},
): StopInstruction {
  return {
    ...extra,
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
/** A push that failed for a reason other than a real divergence (hook refusal, auth, network). */
const PUSH_FAILED_CAUSE = 'push-failed';
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

/**
 * AISDLC-1098: lease-push the pre-sign-rebased head. Honours the trusted push policy
 * (`allowForcePush: never`, protected or malformed branch refuse), pins the lease to the
 * remote-tracking sha held before the fetch, and refuses when the fetch shows the remote
 * moved. Returns null when the fallback does not apply.
 */
async function leasePushOwnRebaseShip(
  ctx: NextStepContext,
  runner: NextStepContext['runner'],
  wt: string,
  branch: string,
  env: NodeJS.ProcessEnv | undefined,
  seenBeforeFetch?: string,
  verdictRefspec?: string | null,
): Promise<Awaited<ReturnType<NextStepContext['runner']>> | null> {
  const policy = loadOperationalPolicy(ctx.workDir, ctx.workDir);
  if (policy.forcePushMode === 'never') return null;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.includes('..') ||
    isProtectedBranch(branch, policy.protectedBranches)
  ) {
    return null;
  }
  const ref = `refs/remotes/origin/${branch}`;
  const sha = async (): Promise<string> => {
    const r = await runner('git', ['rev-parse', ref], { cwd: wt, allowFailure: true });
    return r.code === 0 ? r.stdout.trim() : '';
  };
  const recorded = seenBeforeFetch ?? (await sha());
  if (!/^[0-9a-f]{40,64}$/i.test(recorded)) return null;
  const fetched = await runner('git', ['fetch', 'origin', branch], {
    cwd: wt,
    allowFailure: true,
    timeout: 30_000,
  });
  if (fetched.code !== 0 || (await sha()) !== recorded) return null;
  return runTrustedPush(
    runner,
    { mainCheckout: ctx.workDir, worktree: wt },
    [
      'push',
      '-u',
      ...(verdictRefspec ? ['--atomic'] : []),
      `--force-with-lease=refs/heads/${branch}:${recorded}`,
      'origin',
      `HEAD:refs/heads/${branch}`,
      ...(verdictRefspec ? [verdictRefspec] : []),
    ],
    { allowFailure: true, timeout: PUSH_TIMEOUT_MS, env },
  );
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

  const pushEnv = {
    AI_SDLC_ITERATION_COUNT: String(state.iteration),
    AI_SDLC_HARNESS_NOTE: verdict.harnessNote,
  };
  if (!needsHuman) {
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
    const staged = await runner('git', ['diff', '--cached', '--quiet'], {
      cwd: wt,
      allowFailure: true,
    });
    // Exit 0 means nothing staged (task file was pre-moved): skip the commit.
    const commit =
      staged.code === 0
        ? { code: 0, stdout: '', stderr: '' }
        : await runner('git', ['commit', '-m', choreCommitMessage(state.taskId)], {
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
  }

  // Step 11a — push. RFC-0061 Phase 2: no signing and no envelope check; the push fails for git
  // reasons only, and the verdict ref rides the same atomic push.
  let pushRc = 1;
  let pushErr = '';
  let diverged = false;
  // Read once, before any push or fetch of this run: a ref created by our own fetch was never
  // seen by the developer pass, so '' (no lease) is the answer when it did not exist.
  const seenRef = await runner('git', ['rev-parse', `refs/remotes/origin/${state.branch}`], {
    cwd: wt,
    allowFailure: true,
  });
  const seenBeforeFetch = seenRef.code === 0 ? seenRef.stdout.trim() : '';
  const verdictNotes: string[] = [];
  // AISDLC-1193: every approved push carries a verdict ref. Resumed, re-entered and no-reviewer
  // rounds never passed through finalizeReview, so build the draft here when it is missing.
  if (!needsHuman && verdict.approved && !verdict.verdictRecordDraft) {
    await attachVerdictRecordDraft(ctx, state, verdict);
  }
  // AISDLC-1197: the verdict record names the PR when it already exists (resumed rounds).
  const priorPr = needsHuman ? null : await detectDraftPrForBranch(runner, wt, state.branch);
  for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt += 1) {
    // RFC-0061: branch and verdict ref in one atomic push (built per attempt: a pre-push fixup
    // can change the head).
    const verdictRef = needsHuman
      ? { refspec: null }
      : await buildVerdictRefspec(
          runner,
          wt,
          verdict.verdictRecordDraft,
          `origin/${resolveTargetBranch(ctx.workDir)}`,
          undefined,
          priorPr?.prNumber ?? 0,
        );
    if ('note' in verdictRef && verdictRef.note) verdictNotes.push(verdictRef.note);
    const pushArgs = verdictRef.refspec
      ? ['push', '-u', '--atomic', 'origin', state.branch, verdictRef.refspec]
      : ['push', '-u', 'origin', state.branch];
    const push = await runTrustedPush(
      runner,
      { mainCheckout: ctx.workDir, worktree: wt },
      pushArgs,
      { allowFailure: true, timeout: PUSH_TIMEOUT_MS, env: pushEnv },
    );
    pushRc = push.code;
    pushErr = (push.stderr || push.stdout).trim();
    if (pushRc === 0) break;
    if (/non-fast-forward/i.test(pushErr)) {
      // AISDLC-1164: only git's own non-fast-forward line, confirmed by a fetch showing the
      // remote tip is not an ancestor of HEAD, is a divergence. A remote that is an ancestor
      // means the refusal came from elsewhere (a hook); push plainly again, no lease.
      const fetched = await runner('git', ['fetch', 'origin', state.branch], {
        cwd: wt,
        allowFailure: true,
        timeout: 30_000,
      });
      // A failed fetch leaves the remote state unknown: report push-failed, not a divergence.
      if (fetched.code !== 0) break;
      const isAncestor =
        (
          await runner(
            'git',
            ['merge-base', '--is-ancestor', `refs/remotes/origin/${state.branch}`, 'HEAD'],
            { cwd: wt, allowFailure: true },
          )
        ).code === 0;
      if (isAncestor) continue;
      diverged = true;
      // AISDLC-1098: step 10.5 rebased a branch whose developer pass had already
      // force-pushed, so local and remote diverge. Push what we rebased with one
      // policy-checked lease push pinned to the remote tip this run last saw; a
      // remote that moved since (a foreign push) keeps the abort.
      const lease = await leasePushOwnRebaseShip(
        ctx,
        runner,
        wt,
        state.branch,
        pushEnv,
        seenBeforeFetch,
        verdictRef.refspec,
      );
      if (!verdictRef.refspec && !needsHuman) {
        verdictNotes.push(
          'verdict ref not pushed on the lease fallback push: no verdict refspec could be built',
        );
      }
      if (lease) {
        pushRc = lease.code;
        pushErr = (lease.stderr || lease.stdout).trim();
        if (pushRc === 0) break;
        diverged = /non-fast-forward|stale info/i.test(pushErr);
      }
    }
  }
  if (pushRc !== 0) {
    const lastLines = pushErr.split('\n').slice(-12).join('\n');
    return stop(
      state,
      'aborted',
      diverged
        ? `non-fast-forward push to '${state.branch}'; cleanup is to delete the remote branch and rerun, but that is destructive, confirm with the operator first (no force-push is attempted)`
        : `push to '${state.branch}' failed after ${PUSH_ATTEMPTS} attempts (last exit ${pushRc}); git output:\n${lastLines}`,
      { cause: diverged ? PUSH_NON_FAST_FORWARD_CAUSE : PUSH_FAILED_CAUSE },
    );
  }

  // Step 11b — DRAFT PR (CI must not fire until Step 13).
  const existing = await detectDraftPrForBranch(runner, wt, state.branch);
  let prUrl: string | null = existing?.prUrl || null;
  let prNumber: number | null = existing?.prNumber ?? null;
  const notes: string[] = [...new Set(verdictNotes)];
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
    const prDecision = decidePrDraft(
      ctx.workDir,
      loadOperationalPolicy(ctx.workDir, ctx.workDir).openTaskPrsReady,
    );
    ctx.logger.info(prDecision.reason);
    const create = await runner(
      'gh',
      [
        'pr',
        'create',
        ...(prDecision.draft ? ['--draft'] : []),
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
