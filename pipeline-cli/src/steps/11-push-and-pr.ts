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
 *   - On non-fast-forward push: abort cleanly with `pushed: false` + reason
 *
 * @module steps/11-push-and-pr
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import {
  DEFAULT_LOGGER,
  type PipelineLogger,
  type PushAndPrOptions,
  type PushAndPrResult,
} from '../types.js';
import { parseLegacyKey, parsePipelineBacklogKey } from './02-compute-branch.js';
import { lateRebase } from './11-late-rebase.js';

export interface PushAndPrStepOptions extends PushAndPrOptions {
  runner?: Runner;
  /**
   * Path to sign-attestation.mjs helper (defaults to env-var detection).
   * Passed through from Step 10 (finalizeTask) pattern — the signer reads
   * `.ai-sdlc/verdicts/<task-id>.json` and writes
   * `.ai-sdlc/attestations/<sha>.dsse.json` at the NEW HEAD so
   * verify-attestation.yml sees a valid envelope after the rebase.
   */
  signAttestationScript?: string;
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

  const reviewer = opts.verdict.verdicts.find((v) => v.agentId === 'code-reviewer');
  const reviewBlock = reviewer
    ? `\n<details>\n<summary>Code reviewer verdict</summary>\n\n${
        reviewer.summary ?? '(no summary)'
      }\n\n</details>\n`
    : '';

  const footer = isGhIssue ? `\nCloses #${opts.issueNumber}\n` : `\nReferences ${opts.taskId}\n`;

  return (
    headerWarning +
    closesHeader +
    `${opts.developerReturn.summary}\n\n` +
    `## Changed files\n${filesBlock}\n` +
    reviewBlock +
    footer
  );
}

export async function pushAndPr(opts: PushAndPrStepOptions): Promise<PushAndPrResult> {
  const runner = opts.runner ?? defaultRunner;

  // 0. AISDLC-232 — Late-rebase: fetch + rebase origin/main before pushing.
  //    This catches conflicts that accumulated while the dev ran (Steps 5-10
  //    take 20-40 min; origin/main may have moved). Mechanical conflicts are
  //    auto-resolved in-place; semantic conflicts abort + return the conflict
  //    files so the orchestrator can record `rebase-conflict` and continue.
  const rebase = await lateRebase({ worktreePath: opts.worktreePath, runner });
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

  // 0b. AISDLC-232 — Re-sign attestation after auto-resolve.
  //     When lateRebase resolved one or more files, HEAD's blob SHAs have
  //     shifted. The contentHashV4 in the Step-10 attestation envelope
  //     (signed at the pre-rebase SHA) no longer matches the new HEAD →
  //     verify-attestation.yml would post `ai-sdlc/attestation: failure`.
  //
  //     Fix: invoke sign-attestation.mjs at the NEW HEAD, then commit the
  //     refreshed envelope as a chore commit BEFORE the push so the
  //     pre-push hook (check-attestation-sign.sh) sees an envelope at HEAD
  //     and skips its own sign-and-exit-1 dance.
  if (rebase.resolvedFiles.length > 0) {
    const helperScript =
      opts.signAttestationScript ??
      (process.env.CLAUDE_PLUGIN_ROOT
        ? join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts', 'sign-attestation.mjs')
        : null);

    if (helperScript && existsSync(helperScript)) {
      const signResult = await runner('node', [helperScript], {
        cwd: opts.worktreePath,
        allowFailure: true,
      });
      if (signResult.code === 0) {
        // Stage the refreshed envelope + commit as chore before push.
        // Mirrors the AISDLC-220 chore-commit pattern used in Step 10.
        await runner('git', ['add', '.ai-sdlc/attestations'], {
          cwd: opts.worktreePath,
          allowFailure: true,
        });
        const reSignMessage =
          `chore(spec): re-sign attestation after late-rebase auto-resolve (AISDLC-232)\n\n` +
          `Late-rebase resolved ${rebase.resolvedFiles.join(', ')} — HEAD blob SHAs shifted.\n` +
          `Refreshed DSSE envelope so verify-attestation.yml sees a valid contentHashV4.\n\n` +
          `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>\n`;
        await runner('git', ['commit', '-m', reSignMessage], {
          cwd: opts.worktreePath,
          allowFailure: true,
          env: { GIT_EDITOR: 'true' },
        });
      }
      // If sign fails (script unavailable or signer error): continue with push.
      // The pre-push hook's check-attestation-sign.sh will handle sign + exit-1
      // → re-run dance as the fallback (AISDLC-232 failure mode A is still
      // better than silently pushing an invalid envelope).
    }
  }

  // 1. Push -u origin <branch>. NEVER force.
  const pushResult = await runner('git', ['push', '-u', 'origin', opts.branch], {
    cwd: opts.worktreePath,
    allowFailure: true,
  });
  if (pushResult.code !== 0) {
    const stderr = pushResult.stderr.trim();
    const reason = /non-fast-forward|rejected/i.test(stderr)
      ? `non-fast-forward push to '${opts.branch}'; cleanup is to delete the remote branch and rerun, ` +
        `but that's destructive — confirm with the operator first`
      : `git push failed: ${stderr || pushResult.stdout.trim() || 'unknown error'}`;
    return { pushed: false, prUrl: null, reason };
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
  // once. See `docs/operations/aisdlc-218-draft-pr-flow.md` and
  // `ai-sdlc-plugin/commands/execute.md` Step 11 / Step 13.
  const prResult = await runner(
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
      'main',
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
  return { pushed: true, prUrl };
}
