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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import type { PushAndPrOptions, PushAndPrResult } from '../types.js';
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
 *   2. `.ai-sdlc/pipeline-backlog.yaml` → `pullRequest.titleTemplate` (deprecated shim)
 *
 * Returns the default when neither file has the key.
 *
 * Exported for unit tests.
 */
export function readTitleTemplate(workDir: string): string {
  // --- 1. Canonical path: pipeline.yaml spec.backlog.pullRequest.titleTemplate ---
  const pipelineYamlPath = join(workDir, '.ai-sdlc', 'pipeline.yaml');
  if (existsSync(pipelineYamlPath)) {
    let raw: string;
    try {
      raw = readFileSync(pipelineYamlPath, 'utf8');
    } catch {
      raw = '';
    }
    // Match `backlog:` section with nested `pullRequest:` → `titleTemplate:`.
    const backlogSection = raw.match(/^backlog:\s*[\r\n]((?:[ \t]+[^\r\n]*[\r\n])*)/m);
    if (backlogSection) {
      const m = backlogSection[0].match(
        /pullRequest:\s*[\r\n]+\s*titleTemplate:\s*['"]?([^'"\r\n]+)['"]?/,
      );
      if (m) return m[1].trim();
    }
    // Also handle full Pipeline kind document shape.
    const specBacklogM = raw.match(
      /spec:\s*[\r\n](?:[\s\S]*?)backlog:\s*[\r\n](?:[\s\S]*?)pullRequest:\s*[\r\n]\s*titleTemplate:\s*['"]?([^'"\r\n]+)['"]?/,
    );
    if (specBacklogM) return specBacklogM[1].trim();
  }

  // --- 2. Deprecated shim: pipeline-backlog.yaml pullRequest.titleTemplate ---
  const legacyPath = join(workDir, '.ai-sdlc', 'pipeline-backlog.yaml');
  if (!existsSync(legacyPath)) return DEFAULT_TITLE_TEMPLATE;
  let raw: string;
  try {
    raw = readFileSync(legacyPath, 'utf8');
  } catch {
    return DEFAULT_TITLE_TEMPLATE;
  }
  const m = raw.match(/pullRequest:\s*[\r\n]+\s*titleTemplate:\s*['"]?([^'"\r\n]+)['"]?/);
  return m ? m[1].trim() : DEFAULT_TITLE_TEMPLATE;
}

/**
 * Compose the final PR title applying the optional `[needs-human-attention]`
 * suffix per `execute-orchestrator.md` Step 9.
 *
 * Exported for unit tests.
 */
export function composeTitle(
  template: string,
  taskId: string,
  taskTitle: string,
  needsHumanAttention: boolean,
): string {
  const tagged = needsHumanAttention ? `${taskTitle} [needs-human-attention]` : taskTitle;
  return template.replace(/\{issueTitle\}/g, tagged).replace(/\{issueId\}/g, taskId);
}

/**
 * Compose the PR body — developer summary, changed-files list, and a
 * collapsed code-reviewer details block. Exported for unit tests.
 */
export function composeBody(opts: PushAndPrOptions): string {
  const headerWarning = opts.needsHumanAttention
    ? `> **⚠ This PR exceeded the auto-iteration cap with unresolved review findings. Human review/intervention requested.**\n\n`
    : '';
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

  return (
    headerWarning +
    `${opts.developerReturn.summary}\n\n` +
    `## Changed files\n${filesBlock}\n` +
    reviewBlock +
    `\nReferences ${opts.taskId}\n`
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
  const titleTemplate = readTitleTemplate(opts.workDir);
  const title = composeTitle(
    titleTemplate,
    opts.taskId,
    opts.task.title,
    !!opts.needsHumanAttention,
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
