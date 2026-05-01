/**
 * Step 11 — Push the worktree branch and open the GitHub PR.
 *
 * Mirrors `execute-orchestrator.md` Step 11. Reads the PR title template
 * from `.ai-sdlc/pipeline-backlog.yaml` (`pullRequest.titleTemplate`),
 * composes the PR body from the developer summary + changed files +
 * code reviewer summary, then runs `git push -u origin <branch>` followed
 * by `gh pr create`.
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

export interface PushAndPrStepOptions extends PushAndPrOptions {
  runner?: Runner;
}

const DEFAULT_TITLE_TEMPLATE = 'feat: {issueTitle} ({issueId})';

/**
 * Read `pullRequest.titleTemplate` from `.ai-sdlc/pipeline-backlog.yaml`.
 * Returns the default if the file is missing or the key isn't present.
 *
 * Exported for unit tests.
 */
export function readTitleTemplate(workDir: string): string {
  const path = join(workDir, '.ai-sdlc', 'pipeline-backlog.yaml');
  if (!existsSync(path)) return DEFAULT_TITLE_TEMPLATE;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
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

  const prResult = await runner(
    'gh',
    ['pr', 'create', '--title', title, '--body', body, '--base', 'main', '--head', opts.branch],
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
