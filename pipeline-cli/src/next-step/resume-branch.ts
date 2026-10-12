/**
 * Which branch a resumed task continues on (AISDLC-762.2).
 *
 * On a resume the branch is a fact recorded elsewhere (the dispatch manifest,
 * the pull request, the worktree), not something to recompute from the task
 * title: a PR pushed as `ai-sdlc/aisdlc-651.2` is not found by recomputing
 * `ai-sdlc/aisdlc-651.2-rfc-0050-...`. Sources are tried in order and the
 * first that names a branch wins; `undefined` means a fresh task.
 *
 * @module next-step/resume-branch
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readInflightManifest } from '../dispatch/board.js';
import type { NextStepContext } from './types.js';

export type ResumeBranchSource = 'manifest' | 'pr' | 'worktree';

export interface ResumeBranch {
  branch: string;
  source: ResumeBranchSource;
}

const REF_RE = /^[A-Za-z0-9._/-]+$/;

function cleanRef(raw: string | undefined): string | undefined {
  const ref = raw?.trim();
  if (!ref || ref.startsWith('-') || ref.includes('..') || !REF_RE.test(ref)) return undefined;
  return ref;
}

async function prHeadRef(ctx: NextStepContext, pr: number): Promise<string | undefined> {
  const r = await ctx.runner(
    'gh',
    ['api', `repos/{owner}/{repo}/pulls/${pr}`, '--jq', '.head.ref'],
    { cwd: ctx.workDir, allowFailure: true, timeout: 30_000 },
  );
  return r.code === 0 ? cleanRef(r.stdout) : undefined;
}

/** Branch to resume, with where it came from; `undefined` for a fresh task. */
export async function resolveResumeBranch(
  ctx: NextStepContext,
  taskId: string,
): Promise<ResumeBranch | undefined> {
  const boardDir = join(ctx.workDir, '.ai-sdlc', 'dispatch');
  const manifest = readInflightManifest(boardDir, taskId);
  const resume = manifest?.resume;
  if (manifest && resume) {
    const recorded =
      cleanRef(resume.prHeadRef) ?? (resume.branchGuessed ? undefined : cleanRef(manifest.branch));
    if (recorded) return { branch: recorded, source: 'manifest' };
    if (resume.prNumber !== undefined) {
      const ref = await prHeadRef(ctx, resume.prNumber);
      if (ref) return { branch: ref, source: 'pr' };
    }
  }
  const worktree = join(ctx.workDir, '.worktrees', taskId.toLowerCase());
  if (existsSync(join(worktree, '.git'))) {
    const r = await ctx.runner('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktree,
      allowFailure: true,
    });
    const ref = r.code === 0 ? cleanRef(r.stdout) : undefined;
    if (ref && ref !== 'HEAD') return { branch: ref, source: 'worktree' };
  }
  return undefined;
}
