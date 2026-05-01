/**
 * Step 12 — Cross-repo PRs (siblings under permittedExternalPaths).
 *
 * Mirrors `execute-orchestrator.md` Step 12. For each entry in
 * `developer.filesChangedExternal`:
 *   1. Verify the path is a git repo.
 *   2. Skip if `gh status --porcelain` is empty (nothing to push).
 *   3. Confirm `gh` auth works for the sibling.
 *   4. Create a parallel branch named `ai-sdlc/<task-id-lower>-sibling`.
 *   5. Stage the developer-reported files, commit, push.
 *   6. Open the sibling PR linking back to the main PR.
 *
 * Each sibling is independent — failure of one does not roll back the main PR.
 *
 * @module steps/12-sibling-prs
 */

import { defaultRunner, type Runner } from '../runtime/exec.js';
import type { SiblingPrOptions, SiblingPrResult } from '../types.js';

export interface SiblingPrStepOptions extends SiblingPrOptions {
  runner?: Runner;
}

export async function siblingPrs(opts: SiblingPrStepOptions): Promise<SiblingPrResult> {
  const runner = opts.runner ?? defaultRunner;
  const taskIdLower = opts.taskId.toLowerCase();
  const branchName = `ai-sdlc/${taskIdLower}-sibling`;

  const externals = opts.developerReturn.filesChangedExternal ?? [];
  if (externals.length === 0) {
    return { prs: [] };
  }

  const prs: SiblingPrResult['prs'] = [];

  for (const ext of externals) {
    // 1. Confirm it's a git repo
    const isRepo = await runner('git', ['-C', ext.repo, 'rev-parse', '--show-toplevel'], {
      allowFailure: true,
    });
    if (isRepo.code !== 0) {
      prs.push({ repo: ext.repo, branch: branchName, prUrl: null, reason: 'not a git repository' });
      continue;
    }

    // 2. Skip if nothing dirty
    const status = await runner('git', ['-C', ext.repo, 'status', '--porcelain'], {
      allowFailure: true,
    });
    if (status.code !== 0 || !status.stdout.trim()) {
      prs.push({
        repo: ext.repo,
        branch: branchName,
        prUrl: null,
        reason: 'no dirty files in sibling repo',
      });
      continue;
    }

    // 3. Confirm gh auth (best-effort; we still try the create even if this is funky).
    const repoView = await runner(
      'gh',
      ['-R', '.', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      { cwd: ext.repo, allowFailure: true },
    );
    if (repoView.code !== 0) {
      prs.push({
        repo: ext.repo,
        branch: branchName,
        prUrl: null,
        reason: `gh auth not configured for sibling repo (${repoView.stderr.trim() || 'unknown'})`,
      });
      continue;
    }
    const nameWithOwner = repoView.stdout.trim();

    // 4. Branch + add + commit + push
    const checkout = await runner('git', ['-C', ext.repo, 'checkout', '-b', branchName], {
      allowFailure: true,
    });
    if (checkout.code !== 0) {
      prs.push({
        repo: ext.repo,
        branch: branchName,
        prUrl: null,
        reason: `git checkout -b failed: ${checkout.stderr.trim()}`,
      });
      continue;
    }

    const addArgs = ['-C', ext.repo, 'add', '--', ...ext.files];
    await runner('git', addArgs, { allowFailure: true });

    const message =
      `feat: ${opts.task.title} — sibling for ${opts.taskId}\n\n` +
      `Companion changes for ${opts.mainPrUrl}.\n\n` +
      `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>\n`;
    const commit = await runner('git', ['-C', ext.repo, 'commit', '-m', message], {
      allowFailure: true,
    });
    if (commit.code !== 0) {
      prs.push({
        repo: ext.repo,
        branch: branchName,
        prUrl: null,
        reason: `git commit failed: ${commit.stderr.trim()}`,
      });
      continue;
    }

    const push = await runner('git', ['-C', ext.repo, 'push', '-u', 'origin', branchName], {
      allowFailure: true,
    });
    if (push.code !== 0) {
      prs.push({
        repo: ext.repo,
        branch: branchName,
        prUrl: null,
        reason: `git push failed: ${push.stderr.trim()}`,
      });
      continue;
    }

    // 5. Open the PR
    const filesList = ext.files.map((f) => `- ${f}`).join('\n');
    const body =
      `Companion PR for ${opts.mainPrUrl} (${opts.taskId}).\n\n` +
      `${opts.developerReturn.summary}\n\n` +
      `## Files changed\n${filesList || '- (none)'}\n`;
    const prTitle = `feat: ${opts.task.title} — sibling for ${opts.taskId}`;
    const create = await runner(
      'gh',
      [
        '-R',
        nameWithOwner,
        'pr',
        'create',
        '--title',
        prTitle,
        '--body',
        body,
        '--base',
        'main',
        '--head',
        branchName,
      ],
      { allowFailure: true, cwd: ext.repo },
    );
    if (create.code !== 0) {
      prs.push({
        repo: ext.repo,
        branch: branchName,
        prUrl: null,
        reason: `gh pr create failed: ${create.stderr.trim() || create.stdout.trim()}`,
      });
      continue;
    }
    const prUrl = create.stdout.trim().split('\n').pop()?.trim() ?? null;
    prs.push({ repo: ext.repo, branch: branchName, prUrl });
  }

  return { prs };
}
