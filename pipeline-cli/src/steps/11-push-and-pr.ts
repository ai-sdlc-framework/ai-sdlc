/**
 * Step 11 — Push the worktree branch and open the GitHub PR.
 *
 * Mirrors `execute-orchestrator.md` Step 11. Reads the PR title template
 * from `.ai-sdlc/pipeline.yaml` (`spec.backlog.pullRequest.titleTemplate`)
 * with a fallback to the deprecated `.ai-sdlc/pipeline-backlog.yaml`
 * (`pullRequest.titleTemplate`, AISDLC-245.5),
 * composes the PR body from the developer summary + changed files +
 * code reviewer summary, then runs `git push -u origin <branch>` followed
 * by `gh pr create`.
 *
 * AISDLC-232 — Late-rebase before push:
 *   Before the first `git push`, this step runs `git fetch origin main &&
 *   git rebase origin/main` to catch conflicts that emerged while the dev
 *   ran (Step 3's initial rebase may be 20-40 min stale by now). Mechanical
 *   conflicts (CHANGELOG `Unreleased`, test additions, prettier drift) are
 *   auto-resolved in-place. Semantic conflicts abort the rebase and return
 *   `{ pushed: false, rebaseConflict: { files, reason } }` so the
 *   orchestrator can record the `rebase-conflict` outcome and continue.
 *
 * Hard rules (NEVER violated, see RFC §11.5):
 *   - No `git push --force` / `-f`
 *   - No `gh pr merge`
 *   - No `git branch -D` / `-d`
 *   - On non-fast-forward push: abort cleanly with `pushed: false` + reason, unless the remote
 *     head is the pre-rebase copy of this branch and the policy allows a lease (AISDLC-1016)
 *
 * @module steps/11-push-and-pr
 */

import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { checkOwnWorktreeForOperator, isProtectedBranch } from '../hierarchy/lease-policy.js';
import { leasePushPreflight, type LeasePreflight } from '../hierarchy/lease-preflight.js';
import { loadOperationalPolicy } from '../hierarchy/operational.js';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { runTrustedPush } from '../runtime/trusted-push.js';
import {
  DEFAULT_LOGGER,
  type PipelineLogger,
  type PushAndPrOptions,
  type PushAndPrResult,
} from '../types.js';
import {
  parseLegacyKey,
  parsePipelineBacklogKey,
  resolveTargetBranch,
} from './02-compute-branch.js';
import {
  findProtectedPathChanges,
  UNTRUSTED_PROTECTED_CAUSE,
} from './untrusted-protected-paths.js';
import { landPrep } from './land-prep.js';
import { ensureWorkspaceBuilt } from './ensure-workspace-built.js';
import { loadVerification } from './verification-config.js';
import { VERIFICATION_KEYS } from './verify-defaults.js';
import { decidePrDraft } from '../hierarchy/mark-ready.js';
import { detectDraftPrForBranch } from './03-setup-worktree.js';
import { composeJudgmentNotes } from '../judgment/agent-output-checks.js';
import { writeEvent, type WriteEventOpts } from '../orchestrator/events.js';

export interface PushAndPrStepOptions extends PushAndPrOptions {
  runner?: Runner;
  /**
   * AISDLC-493 — artifacts directory for the orchestrator events stream.
   * When set, a `PrOpened` event is appended to
   * `<artifactsDir>/_orchestrator/events-YYYY-MM-DD.jsonl` after `gh pr create`
   * succeeds. Falls back to `ARTIFACTS_DIR` env then `./artifacts` when omitted.
   */
  artifactsDir?: string;
  /**
   * AISDLC-493 — override clock for the events writer (tests inject a
   * frozen clock). Falls back to `new Date()` when omitted.
   */
  now?: () => Date;
  /**
   * AISDLC-493 — override the orchestrator flag predicate for hermetic
   * tests (bypasses the `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` env check).
   */
  isEnabled?: WriteEventOpts['isEnabled'];
  /** AISDLC-798 — replaces the lease-push preflight (tests). */
  leasePreflight?: (opts: PushAndPrStepOptions) => LeasePreflight;
}

const DEFAULT_TITLE_TEMPLATE = 'feat: {issueTitle} ({issueId})';

/**
 * Read `pullRequest.titleTemplate` from the canonical location:
 *   1. `.ai-sdlc/pipeline.yaml` → `spec.backlog.pullRequest.titleTemplate` (AISDLC-245.5)
 *   2. `.ai-sdlc/pipeline-backlog.yaml` → `pullRequest.titleTemplate` (deprecated shim,
 *      logs a warning on first use; will be removed in the next major release)
 *
 * Returns the default when neither file has the key.
 *
 * Exported for unit tests.
 */
export function readTitleTemplate(workDir: string, logger?: PipelineLogger): string {
  // --- 1. Canonical path: pipeline.yaml spec.backlog.pullRequest.titleTemplate ---
  // Uses real YAML parsing (js-yaml via parsePipelineBacklogKey from step-02)
  // so the lookup is properly section-scoped: a missing
  // `spec.backlog.pullRequest.titleTemplate` does NOT fall through to a
  // sibling `spec.pullRequest.titleTemplate` (AISDLC-245.5 code-reviewer
  // round-2 MAJOR finding).
  const pipelineYamlPath = join(workDir, '.ai-sdlc', 'pipeline.yaml');
  if (existsSync(pipelineYamlPath)) {
    const tpl = parsePipelineBacklogKey<string>(pipelineYamlPath, ['pullRequest', 'titleTemplate']);
    if (typeof tpl === 'string' && tpl.length > 0) return tpl;
  }

  // --- 2. Deprecated shim: pipeline-backlog.yaml pullRequest.titleTemplate ---
  const legacyPath = join(workDir, '.ai-sdlc', 'pipeline-backlog.yaml');
  if (!existsSync(legacyPath)) return DEFAULT_TITLE_TEMPLATE;
  const tpl = parseLegacyKey<string>(legacyPath, ['pullRequest', 'titleTemplate']);
  if (typeof tpl === 'string' && tpl.length > 0) {
    const log = logger ?? DEFAULT_LOGGER;
    log.warn(
      '[ai-sdlc] DEPRECATION: reading pullRequest.titleTemplate from .ai-sdlc/pipeline-backlog.yaml. ' +
        'Migrate this setting to .ai-sdlc/pipeline.yaml under spec.backlog.pullRequest.titleTemplate. ' +
        'pipeline-backlog.yaml will be removed in the next major release (AISDLC-245.5).',
    );
    return tpl;
  }
  return DEFAULT_TITLE_TEMPLATE;
}

/**
 * Compose the final PR title applying the optional `[needs-human-attention]`
 * suffix per `execute-orchestrator.md` Step 9.
 *
 * AISDLC-393 — when `sourceKind === 'gh-issue'`, the `{issueId}` placeholder
 * is replaced with `closes #N` so the resulting title reads e.g.
 * `feat: <title> (closes #612)` and GitHub auto-closes the issue on merge.
 *
 * Exported for unit tests.
 */
export function composeTitle(
  template: string,
  taskId: string,
  taskTitle: string,
  needsHumanAttention: boolean,
  opts?: { sourceKind?: 'backlog' | 'gh-issue'; issueNumber?: number },
): string {
  const tagged = needsHumanAttention ? `${taskTitle} [needs-human-attention]` : taskTitle;
  const idReplacement =
    opts?.sourceKind === 'gh-issue' && opts.issueNumber !== undefined
      ? `closes #${opts.issueNumber}`
      : taskId;
  return template.replace(/\{issueTitle\}/g, tagged).replace(/\{issueId\}/g, idReplacement);
}

/**
 * Compose the PR body — developer summary, changed-files list, and a
 * collapsed code-reviewer details block. Exported for unit tests.
 *
 * AISDLC-393 — when `sourceKind === 'gh-issue'`, prepend `Closes #N` so
 * GitHub's keyword-resolver auto-closes the issue on merge, and replace the
 * footer's `References <taskId>` line (the synthetic `gh-issue-N` id is
 * not meaningful outside the pipeline).
 */
export function composeBody(opts: PushAndPrOptions): string {
  const isGhIssue = opts.sourceKind === 'gh-issue' && opts.issueNumber !== undefined;

  const headerWarning = opts.needsHumanAttention
    ? `> **⚠ This PR exceeded the auto-iteration cap with unresolved review findings. Human review/intervention requested.**\n\n`
    : '';
  const closesHeader = isGhIssue ? `Closes #${opts.issueNumber}\n\n` : '';
  const filesBlock =
    opts.developerReturn.filesChanged.length > 0
      ? opts.developerReturn.filesChanged.map((f) => `- ${f}`).join('\n')
      : '- (none)';

  const reviewer = opts.verdict.verdicts.find(
    (v) => v.agentId === 'code-reviewer' || v.agentId === 'code-reviewer-codex',
  );
  const reviewBlock = reviewer
    ? `\n<details>\n<summary>Code reviewer verdict</summary>\n\n${
        reviewer.summary ?? '(no summary)'
      }\n\n</details>\n`
    : '';

  // Advisory judgment notes: only when something was flagged (empty string otherwise).
  const judgmentNotes = composeJudgmentNotes({
    ...(opts.acCoverage ? { acCoverage: opts.acCoverage } : {}),
    groundingAnnotations: opts.groundingAnnotations ?? opts.verdict.groundingAnnotations ?? [],
    acceptanceCriteria: opts.task.acceptanceCriteria,
  });
  const notesBlock = judgmentNotes ? `\n${judgmentNotes}` : '';

  const summaries = opts.developerReturn.verificationSummaries;
  const verification = loadVerification(opts.workDir);
  const verificationBlock = summaries
    ? `\n## Verification\n\n${VERIFICATION_KEYS.map((key) =>
        verification[key]
          ? `- \`${verification[key]}\` - ${opts.developerReturn.verifications[key]}${
              summaries[key] ? ` (${summaries[key]})` : ''
            }`
          : `- \`${key}\` - skipped (not configured)`,
      ).join('\n')}${
        opts.developerReturn.verificationScope
          ? `\nScope of the last verify run: ${opts.developerReturn.verificationScope}.`
          : ''
      }\n`
    : '';

  // AISDLC-1024: the hotfix lane runs on a pinned pipeline build; the PR says which.
  const pipelineRef = opts.pipelineRef ?? process.env.AI_SDLC_PIPELINE_REF;
  const pipelineBlock = pipelineRef
    ? `\n## Pipeline build\n\nThis run used the pinned pipeline-cli build ${pipelineRef} (pipeline hotfix lane, AI_SDLC_PIPELINE_REF), not main HEAD.\n`
    : '';

  const footer = isGhIssue ? `\nCloses #${opts.issueNumber}\n` : `\nReferences ${opts.taskId}\n`;

  return (
    headerWarning +
    closesHeader +
    `${opts.developerReturn.summary}\n\n` +
    `## Changed files\n${filesBlock}\n` +
    reviewBlock +
    notesBlock +
    verificationBlock +
    pipelineBlock +
    footer
  );
}

/**
 * AISDLC-738 — the resume push is a lease push made from a child process, where
 * the PreToolUse hook never looks, so the same rules are applied here: the trusted
 * policy must allow `leaseOnOwnBranch`, the branch must not be protected, and the
 * worktree must be a genuine registered one of this repository. Returns the
 * refusal (naming the config key or next step), or null when the push may go ahead.
 */
export function checkResumeLeasePush(
  opts: Pick<
    PushAndPrStepOptions,
    'workDir' | 'worktreePath' | 'branch' | 'resumeRemoteSha' | 'resumeLeasePolicy'
  >,
): string | null {
  let policy = opts.resumeLeasePolicy;
  if (!policy) {
    const trusted = loadOperationalPolicy(opts.workDir, opts.workDir);
    policy = {
      forcePushMode: trusted.forcePushMode,
      protectedBranches: trusted.protectedBranches,
      ownWorktree: (worktree) => checkOwnWorktreeForOperator(opts.workDir, worktree),
    };
  }
  if (policy.forcePushMode === 'never') {
    return (
      `resume push to '${opts.branch}' refused: the trusted policy does not allow a lease push ` +
      `(spec.governance.allowForcePush in .ai-sdlc/agent-role.yaml on the main checkout must be ` +
      `'leaseOnOwnBranch', the default when unset). Set it, or ask the dispatch session to push the branch`
    );
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(opts.branch) ||
    opts.branch.includes('..') ||
    isProtectedBranch(opts.branch, policy.protectedBranches)
  ) {
    return (
      `resume push refused: '${opts.branch}' is a protected or malformed branch name ` +
      `(spec.governance.protectedBranches and the built-in protected list); a resumed task pushes only its own task branch`
    );
  }
  const notOwn = policy.ownWorktree(opts.worktreePath);
  if (notOwn) {
    return (
      `resume push refused: ${opts.worktreePath} is not this task's registered worktree of the main checkout (${notOwn}); ` +
      `run the resume from the task's own .worktrees/<task-id> worktree`
    );
  }
  if (!opts.resumeRemoteSha || !/^[0-9a-f]{7,64}$/i.test(opts.resumeRemoteSha)) {
    return (
      `resume push refused: origin/${opts.branch} was not recorded at Step 3, so the lease has no expected value; ` +
      `run a normal \`/ai-sdlc execute\` if the branch was never pushed`
    );
  }
  return null;
}

/**
 * AISDLC-1019 - refuse a push that would clobber the task branch. Two signatures:
 *  - the git toplevel of the push cwd is not the task worktree (a push typed in the
 *    Pattern C parent carries main's content);
 *  - `HEAD` equals `origin/<target>` while `origin/<branch>` already has commits ahead
 *    of it (pushing would reset the remote branch to main and auto-close the PR).
 * Probes that return nothing (git unavailable, branch not on origin) never refuse.
 * Returns the refusal, or null when the push may go ahead.
 */
export async function checkClobberSignature(
  opts: Pick<PushAndPrStepOptions, 'worktreePath' | 'branch'>,
  targetBranch: string,
  runner: Runner,
): Promise<string | null> {
  const git = async (args: string[]): Promise<string> => {
    const r = await runner('git', args, { cwd: opts.worktreePath, allowFailure: true });
    return r.code === 0 ? r.stdout.trim() : '';
  };
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const top = await git(['rev-parse', '--show-toplevel']);
  if (top && real(top) !== real(opts.worktreePath)) {
    return (
      `push refused: the git toplevel of the push cwd is ${top}, not the task worktree ${opts.worktreePath} ` +
      `(a push from the Pattern C parent overwrites the task branch with main); run it from ${opts.worktreePath}`
    );
  }
  const head = await git(['rev-parse', 'HEAD']);
  const mainSha = await git(['rev-parse', `origin/${targetBranch}`]);
  if (!head || head !== mainSha) return null;
  const ahead = Number.parseInt(
    await git(['rev-list', '--count', `origin/${targetBranch}..origin/${opts.branch}`]),
    10,
  );
  if (ahead > 0) {
    return (
      `push refused: HEAD equals origin/${targetBranch} but origin/${opts.branch} has ${ahead} commit(s) ahead of it; ` +
      `pushing would reset the task branch to ${targetBranch} and auto-close its PR. Check out the task branch in ${opts.worktreePath} and retry`
    );
  }
  return null;
}

/**
 * AISDLC-1016: after a non-fast-forward rejection, lease-push once when the remote head is
 * an ancestor of the ref this step held before its own rebase (the pre-rebase copy of the
 * same patch, so no foreign commit) and the trusted policy permits a lease push. The lease
 * names the observed remote head. Returns the push result, or null to keep the abort.
 */
async function leasePushOwnRebase(
  opts: PushAndPrStepOptions,
  runner: Runner,
  preRebaseSha: string,
): Promise<Awaited<ReturnType<Runner>> | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(preRebaseSha)) return null;
  const trusted = opts.resumeLeasePolicy ? null : loadOperationalPolicy(opts.workDir, opts.workDir);
  const policy = opts.resumeLeasePolicy ?? {
    forcePushMode: trusted!.forcePushMode,
    protectedBranches: trusted!.protectedBranches,
    ownWorktree: (worktree: string) => checkOwnWorktreeForOperator(opts.workDir, worktree),
  };
  if (policy.forcePushMode === 'never') return null;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(opts.branch) ||
    opts.branch.includes('..') ||
    isProtectedBranch(opts.branch, policy.protectedBranches)
  ) {
    return null;
  }
  if (policy.forcePushMode === 'leaseOnOwnBranch' && policy.ownWorktree(opts.worktreePath)) {
    return null;
  }
  const cwd = opts.worktreePath;
  const fetched = await runner('git', ['fetch', 'origin', opts.branch], {
    cwd,
    allowFailure: true,
  });
  if (fetched.code !== 0) return null;
  const remote = await runner('git', ['rev-parse', `refs/remotes/origin/${opts.branch}`], {
    cwd,
    allowFailure: true,
  });
  const remoteSha = remote.code === 0 ? remote.stdout.trim() : '';
  if (!/^[0-9a-f]{40,64}$/i.test(remoteSha)) return null;
  const ancestor = await runner('git', ['merge-base', '--is-ancestor', remoteSha, preRebaseSha], {
    cwd,
    allowFailure: true,
  });
  if (ancestor.code !== 0) return null;
  return runTrustedPush(
    runner,
    { mainCheckout: opts.workDir, worktree: cwd },
    [
      'push',
      '-u',
      `--force-with-lease=refs/heads/${opts.branch}:${remoteSha}`,
      'origin',
      `HEAD:refs/heads/${opts.branch}`,
    ],
    { allowFailure: true },
  );
}

/**
 * AISDLC-1154: a fast-forward push cannot clobber anything, so it needs no lease. On a resumed
 * run the lease recorded at Step 3 goes stale when the developer subagent pushes mid-run; fetch
 * `origin/<branch>` and, when it is an ancestor of HEAD, push plainly. Returns the push result
 * plus the observed shas, or `remote: null` when the remote head could not be read.
 */
async function fastForwardPush(
  opts: PushAndPrStepOptions,
  runner: Runner,
): Promise<{
  result: Awaited<ReturnType<Runner>> | null;
  remote: string | null;
  head: string | null;
}> {
  const cwd = opts.worktreePath;
  const fetched = await runner('git', ['fetch', 'origin', opts.branch], {
    cwd,
    allowFailure: true,
  });
  if (fetched.code !== 0) return { result: null, remote: null, head: null };
  const rev = async (ref: string): Promise<string | null> => {
    const r = await runner('git', ['rev-parse', ref], { cwd, allowFailure: true });
    const sha = r.code === 0 ? r.stdout.trim() : '';
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
  };
  const remote = await rev(`refs/remotes/origin/${opts.branch}`);
  const head = await rev('HEAD');
  if (!remote) return { result: null, remote: null, head };
  const ancestor = await runner('git', ['merge-base', '--is-ancestor', remote, 'HEAD'], {
    cwd,
    allowFailure: true,
  });
  if (ancestor.code !== 0) return { result: null, remote, head };
  const result = await runTrustedPush(
    runner,
    { mainCheckout: opts.workDir, worktree: cwd },
    ['push', '-u', 'origin', `HEAD:refs/heads/${opts.branch}`],
    { allowFailure: true },
  );
  return { result, remote, head };
}

/**
 * AISDLC-1138: the developer subagent may already have pushed the branch, so the first push of
 * this run can meet a remote head that the late rebase made non-fast-forward. When
 * `origin/<branch>` exists and the trusted policy permits a lease push to the task's own branch,
 * return that head as the lease. `forcePushMode: never` is reported as `policyNever` so a
 * refusal can name the policy. Protected or malformed branches never get a lease.
 */
async function firstPushLease(
  opts: PushAndPrStepOptions,
  runner: Runner,
): Promise<{ sha: string | null; policyNever: boolean }> {
  const none = { sha: null, policyNever: false };
  const ls = await runner('git', ['ls-remote', '--heads', 'origin', opts.branch], {
    cwd: opts.worktreePath,
    allowFailure: true,
  });
  if (ls.code !== 0) return none;
  const line = ls.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find((f) => f[1] === `refs/heads/${opts.branch}`);
  const sha = line?.[0] ?? '';
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) return none;
  const trusted = opts.resumeLeasePolicy ? null : loadOperationalPolicy(opts.workDir, opts.workDir);
  const policy = opts.resumeLeasePolicy ?? {
    forcePushMode: trusted!.forcePushMode,
    protectedBranches: trusted!.protectedBranches,
    ownWorktree: (worktree: string) => checkOwnWorktreeForOperator(opts.workDir, worktree),
  };
  if (policy.forcePushMode === 'never') return { sha: null, policyNever: true };
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(opts.branch) ||
    opts.branch.includes('..') ||
    isProtectedBranch(opts.branch, policy.protectedBranches)
  ) {
    return none;
  }
  if (policy.forcePushMode === 'leaseOnOwnBranch' && policy.ownWorktree(opts.worktreePath)) {
    return none;
  }
  return { sha, policyNever: false };
}

/** AISDLC-1054: append "Fixed by <task id>" to the body of the PR this task fixes; creates no PR. */
async function noteFixedBy(opts: PushAndPrStepOptions, runner: Runner): Promise<PushAndPrResult> {
  const pr = String(opts.fixesPr);
  const view = await runner('gh', ['pr', 'view', pr, '--json', 'body,url'], {
    cwd: opts.worktreePath,
    allowFailure: true,
  });
  let info: { body?: string; url?: string } = {};
  try {
    info = view.code === 0 ? (JSON.parse(view.stdout) as typeof info) : {};
  } catch {
    info = {};
  }
  if (!info.url) {
    return {
      pushed: true,
      prUrl: null,
      reason: `pushed to the head branch of PR #${pr}, but gh pr view failed: ${view.stderr.trim() || 'unreadable output'}`,
    };
  }
  const line = `Fixed by ${opts.taskId}`;
  const body = info.body ?? '';
  if (!body.includes(line)) {
    const edit = await runner(
      'gh',
      ['pr', 'edit', pr, '--body', `${body.trimEnd()}\n\n${line}\n`],
      {
        cwd: opts.worktreePath,
        allowFailure: true,
      },
    );
    if (edit.code !== 0) {
      (opts.logger ?? DEFAULT_LOGGER).warn(
        `[ai-sdlc] Step 11: gh pr edit on #${pr} failed (non-fatal): ${edit.stderr.trim() || 'unknown error'}`,
      );
    }
  }
  return { pushed: true, prUrl: info.url };
}

export async function pushAndPr(opts: PushAndPrStepOptions): Promise<PushAndPrResult> {
  const runner = opts.runner ?? defaultRunner;

  // 0-pre. AISDLC-738 — refuse an unsafe resume lease push before anything is rebased.
  if (opts.resume) {
    const refusal = checkResumeLeasePush(opts);
    if (refusal) return { pushed: false, prUrl: null, reason: refusal };
  }

  // 0-pre-b. AISDLC-798 — evaluate the lease-push hook's own predicate before the rebase, so a
  //    dispatch-managed session the hook would refuse stops here with the failing conditions
  //    named, not after the rebase, reviews and signing. Advice only for a hand-run session.
  const dir = process.env['CLAUDE_PROJECT_DIR'];
  const lease = (
    opts.leasePreflight ??
    ((o) =>
      leasePushPreflight({
        projectDir: dir && dir.startsWith('/') ? dir : o.workDir,
        cwd: o.worktreePath,
        taskId: o.taskId,
        branch: o.branch,
      }))
  )(opts);
  if (lease.status === 'refused') {
    if (lease.blocking) return { pushed: false, prUrl: null, reason: lease.message };
    (opts.logger ?? DEFAULT_LOGGER).warn(lease.message);
  }

  // 0. AISDLC-232 — Late-rebase: fetch + rebase origin/main before pushing.
  //    This catches conflicts that accumulated while the dev ran (Steps 5-10
  //    take 20-40 min; origin/main may have moved). Mechanical conflicts are
  //    auto-resolved in-place; semantic conflicts abort + return the conflict
  //    files so the orchestrator can record `rebase-conflict` and continue.
  const targetBranch = resolveTargetBranch(opts.workDir, opts.logger);
  // AISDLC-1016: the ref before this step rewrites the branch, to recognise the remote's copy of it.
  const preRebase = await runner('git', ['rev-parse', 'HEAD'], {
    cwd: opts.worktreePath,
    allowFailure: true,
  });
  const preRebaseSha = preRebase.code === 0 ? preRebase.stdout.trim() : '';
  const rebase = await landPrep({
    worktreePath: opts.worktreePath,
    branch: opts.branch,
    targetBranch,
    push: false,
    runner,
  });
  if (!rebase.ok) {
    return {
      pushed: false,
      prUrl: null,
      reason: rebase.reason,
      rebaseConflict: {
        files: rebase.conflictingFiles,
        reason: rebase.reason ?? 'late-rebase failed',
      },
    };
  }

  // 0a. AISDLC-1111 - build the workspace from the rebased sources before anything signs or
  //     pushes; skipped when the rebase left HEAD alone and the dist entry points exist.
  if (existsSync(join(opts.worktreePath, 'node_modules'))) {
    const built = await ensureWorkspaceBuilt(opts.worktreePath, {
      runner,
      ...(preRebaseSha ? { changedSince: preRebaseSha } : {}),
    });
    if (!built.ok) return { pushed: false, prUrl: null, reason: built.reason };
  }

  // 0b. RFC-0061 Phase 2 (AISDLC-1172): no re-sign here. Step 11 produces no v6 envelope; the review
  //     verdict is a ref outside the branch and a late-rebase auto-resolve is judged by the
  //     clean-replay carry-forward rule at check time.

  // 0b2. AISDLC-1275 - an untrusted run is checked for protected-path changes before any push.
  if (opts.untrusted) {
    let paths: string[];
    try {
      // The agent can rewrite origin/<target> and remote.origin.fetch, so fetch the base into a
      // private ref with an explicit refspec and diff against its SHA.
      const baseFetch = await runner(
        'git',
        ['fetch', 'origin', `+refs/heads/${targetBranch}:refs/ai-sdlc/untrusted-base`],
        { cwd: opts.worktreePath, allowFailure: true },
      );
      if (baseFetch.code !== 0) {
        throw new Error(`base fetch failed: ${baseFetch.stderr.trim() || 'unknown error'}`);
      }
      const baseRev = await runner('git', ['rev-parse', 'refs/ai-sdlc/untrusted-base'], {
        cwd: opts.worktreePath,
        allowFailure: true,
      });
      const baseSha = baseRev.stdout.trim();
      if (baseRev.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(baseSha)) {
        throw new Error('could not resolve the base sha');
      }
      paths = await findProtectedPathChanges({
        worktreePath: opts.worktreePath,
        baseRef: baseSha,
        runner,
      });
    } catch (err) {
      return {
        pushed: false,
        prUrl: null,
        cause: UNTRUSTED_PROTECTED_CAUSE,
        reason: `${UNTRUSTED_PROTECTED_CAUSE}: could not verify changed paths (${
          err instanceof Error ? err.message : String(err)
        }); push refused`,
      };
    }
    if (paths.length > 0) {
      return {
        pushed: false,
        prUrl: null,
        cause: UNTRUSTED_PROTECTED_CAUSE,
        protectedPaths: paths,
        reason: `${UNTRUSTED_PROTECTED_CAUSE}: untrusted run changed protected path(s): ${paths.join(', ')}`,
      };
    }
  }

  // 0c. AISDLC-1019 - refuse the clobber signature before anything is pushed.
  const clobber = await checkClobberSignature(opts, targetBranch, runner);
  if (clobber) return { pushed: false, prUrl: null, reason: clobber };

  // 1. Push -u origin <branch>. NEVER a bare force. A resumed task already has
  //    commits on origin and the late rebase changed their SHAs, so it pushes
  //    with a lease on its own branch only, expecting the origin/<branch> SHA that
  //    Step 3 recorded, so a mid-run fetch cannot widen the lease (AISDLC-738).
  const first = opts.resume
    ? { sha: null, policyNever: false }
    : await firstPushLease(opts, runner);
  const leaseSha = opts.resume ? opts.resumeRemoteSha : first.sha;
  const pushArgs = leaseSha
    ? [
        'push',
        '-u',
        `--force-with-lease=refs/heads/${opts.branch}:${leaseSha}`,
        'origin',
        `HEAD:refs/heads/${opts.branch}`,
      ]
    : ['push', '-u', 'origin', opts.branch];
  let pushResult = await runTrustedPush(
    runner,
    { mainCheckout: opts.workDir, worktree: opts.worktreePath },
    pushArgs,
    { allowFailure: true },
  );
  let diverged: { remote: string; head: string | null } | null = null;
  if (pushResult.code !== 0 && /non-fast-forward|rejected|stale info/i.test(pushResult.stderr)) {
    // AISDLC-1016: the remote may hold only the pre-rebase copy of this very branch.
    const retry = await leasePushOwnRebase(opts, runner, preRebaseSha);
    if (retry) pushResult = retry;
    else if (opts.resume) {
      // AISDLC-1154: stale recorded lease, remote head an ancestor of HEAD: plain fast-forward.
      const ff = await fastForwardPush(opts, runner);
      if (ff.result) pushResult = ff.result;
      else if (ff.remote) diverged = { remote: ff.remote, head: ff.head };
    }
  }
  if (pushResult.code !== 0) {
    const stderr = pushResult.stderr.trim();
    const reason = diverged
      ? `non-fast-forward push to '${opts.branch}': remote head ${diverged.remote} is not an ancestor of ` +
        `local head ${diverged.head ?? 'unknown'}; a human must reconcile the two histories`
      : /non-fast-forward|rejected|stale info/i.test(stderr)
        ? first.policyNever
          ? `non-fast-forward push to '${opts.branch}' refused: origin already holds this branch and the role ` +
            `(spec.governance.allowForcePush: never in .ai-sdlc/agent-role.yaml) forbids a lease push; ` +
            `set it to 'leaseOnOwnBranch' or 'lease', or ask the operator to reconcile the remote branch`
          : `non-fast-forward push to '${opts.branch}'; cleanup is to delete the remote branch and rerun, ` +
            `but that's destructive — confirm with the operator first`
        : `git push failed: ${stderr || pushResult.stdout.trim() || 'unknown error'}`;
    return { pushed: false, prUrl: null, reason };
  }

  // 1a. AISDLC-1054: a task that fixes a PR lands on it; the PR body gains a "fixed by" line.
  if (opts.fixesPr !== undefined) return noteFixedBy(opts, runner);

  // 1b. A resumed task updates its existing PR: the push above already did.
  if (opts.resume) {
    const existing = await detectDraftPrForBranch(runner, opts.worktreePath, opts.branch);
    if (existing) return { pushed: true, prUrl: existing.prUrl || null };
  }

  // 2. gh pr create
  const titleTemplate = readTitleTemplate(opts.workDir, opts.logger);
  const title = composeTitle(
    titleTemplate,
    opts.taskId,
    opts.task.title,
    !!opts.needsHumanAttention,
    // AISDLC-393 — thread sourceKind + issueNumber so the title swaps
    // `(AISDLC-N)` for `(closes #N)` on the gh-issue path.
    opts.sourceKind === 'gh-issue' && opts.issueNumber !== undefined
      ? { sourceKind: 'gh-issue', issueNumber: opts.issueNumber }
      : undefined,
  );
  const body = composeBody(opts);

  // AISDLC-218: open as DRAFT. The slash command body / library caller is
  // responsible for spawning reviewers + signing attestation, then calling
  // `gh pr ready` (Step 13) to flip the draft to ready and trigger CI exactly
  // once. See the draft-PR section of `docs/operations/cli-hierarchy.md` and
  // `ai-sdlc-plugin/commands/execute.md` Step 11 / Step 13.
  const prDecision = decidePrDraft(
    opts.workDir,
    loadOperationalPolicy(opts.workDir, opts.workDir).openTaskPrsReady,
  );
  (opts.logger ?? DEFAULT_LOGGER).info(prDecision.reason);
  const prResult = await runner(
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
      targetBranch,
      '--head',
      opts.branch,
    ],
    { cwd: opts.worktreePath, allowFailure: true },
  );
  if (prResult.code !== 0) {
    return {
      pushed: true,
      prUrl: null,
      reason: `gh pr create failed: ${prResult.stderr.trim() || prResult.stdout.trim() || 'unknown error'}`,
    };
  }
  // gh pr create prints the URL on stdout
  const prUrl = prResult.stdout.trim().split('\n').pop()?.trim() ?? null;

  // AISDLC-493: emit PrOpened event so the profiling aggregator can anchor
  // the post-dev phase of the dispatch→merge lifecycle. Best-effort — event
  // write failures are swallowed per the writeEvent contract.
  if (prUrl) {
    const prOpenedAt = (opts.now ?? (() => new Date()))().toISOString();
    writeEvent(
      {
        ts: '',
        type: 'PrOpened',
        taskId: opts.taskId,
        prUrl,
        prOpenedAt,
      },
      {
        ...(opts.artifactsDir !== undefined ? { artifactsDir: opts.artifactsDir } : {}),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        ...(opts.isEnabled !== undefined ? { isEnabled: opts.isEnabled } : {}),
      },
    );
  }

  return { pushed: true, prUrl };
}

/** Workflow registry metadata (RFC-0056). */
export const PUSH_AND_PR_STEP: import('./step-meta.js').StepMeta = {
  id: 'push-and-pr',
  inputs: 'local:verdict',
  outputs: 'local:pull-request',
};
