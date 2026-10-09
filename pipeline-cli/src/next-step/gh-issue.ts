/**
 * GitHub-issue path of `/ai-sdlc execute` (AISDLC-393).
 *
 * The issue is the source of truth (no backlog file). The composite
 * `executePipeline()` drives every step and spawns the agents through the
 * subscription `claude -p` spawner, so the model has nothing to orchestrate:
 * `next-step gh:<n>` runs the whole pipeline and returns the terminal
 * instruction. Billing safety is preserved: the `claude` CLI must be on PATH
 * and the API-key fallback is switched off.
 *
 * @module next-step/gh-issue
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executePipeline } from '../execute-pipeline.js';
import { defaultSpawner } from '../runtime/default-spawner.js';
import type { PipelineOptions, PipelineResult, TaskSpec } from '../types.js';
import type { DoneInstruction, NextStepContext, StopInstruction } from './types.js';

export interface GhIssueDeps {
  /** True when `claude` resolves on PATH. */
  claudeOnPath: () => Promise<boolean>;
  /** Fetch + synthesise the inline spec (dogfood `fetchGhIssueAsTaskSpec`). */
  fetchSpec: (
    distFile: string,
    issueNumber: number,
  ) => Promise<{ spec: TaskSpec; issueNumber: number }>;
  /** Run the composite with the subscription spawner. */
  execute: (opts: Omit<PipelineOptions, 'spawner'>) => Promise<PipelineResult>;
}

export const defaultGhIssueDeps: GhIssueDeps = {
  claudeOnPath: async () => {
    const { defaultWhich } = await import('../runtime/default-spawner.js');
    return defaultWhich('claude');
  },
  fetchSpec: async (distFile, issueNumber) => {
    const mod = (await import(pathToFileURL(distFile).href)) as {
      fetchGhIssueAsTaskSpec: (n: number) => Promise<{ spec: TaskSpec; issueNumber: number }>;
    };
    return mod.fetchGhIssueAsTaskSpec(issueNumber);
  },
  execute: async (opts) => {
    // Pretend ANTHROPIC_API_KEY is unset so the resolution chain is `claude -p` or an error.
    const spawner = await defaultSpawner({ env: () => undefined });
    return executePipeline({ ...opts, spawner });
  },
};

function failure(taskId: string, reason: string): StopInstruction {
  return { action: 'stop', taskId, outcome: 'aborted', reason, prUrl: null, notes: reason };
}

/** Run the gh-issue pipeline end to end. */
export async function runGhIssue(
  ctx: NextStepContext,
  issueNumber: number,
  deps: GhIssueDeps = defaultGhIssueDeps,
): Promise<DoneInstruction | StopInstruction> {
  const taskId = `gh-issue-${issueNumber}`;
  if (!(await deps.claudeOnPath())) {
    return failure(
      taskId,
      `/ai-sdlc execute <gh-issue> requires the \`claude\` CLI on PATH (subscription billing path). ` +
        `Refusing to fall back to ANTHROPIC_API_KEY-based dispatch without explicit operator opt-in. ` +
        `For the API-key path use: pnpm --filter @ai-sdlc/dogfood watch --issue ${issueNumber}`,
    );
  }
  const dist = join(ctx.workDir, 'dogfood', 'dist', 'dispatch-from-issue.js');
  if (!ctx.exists(dist)) {
    return failure(
      taskId,
      `dogfood dist missing at ${dist}. Run \`pnpm --filter @ai-sdlc/dogfood build\` to fix.`,
    );
  }
  let fetched: { spec: TaskSpec; issueNumber: number };
  try {
    fetched = await deps.fetchSpec(dist, issueNumber);
  } catch (err) {
    return failure(
      taskId,
      `failed to fetch GitHub issue #${issueNumber}: ${(err as Error).message}`,
    );
  }
  let result: PipelineResult;
  try {
    result = await deps.execute({
      taskId: fetched.spec.id,
      workDir: ctx.workDir,
      taskSpec: fetched.spec,
      sourceKind: 'gh-issue',
      issueNumber: fetched.issueNumber,
    });
  } catch (err) {
    return failure(fetched.spec.id, `GH-issue dispatch failed: ${(err as Error).message}`);
  }
  if (result.outcome === 'approved' || result.outcome === 'needs-human-attention') {
    return {
      action: 'done',
      taskId: result.taskId,
      branch: result.branch,
      worktreePath: result.worktreePath,
      outcome: result.outcome,
      prUrl: result.prUrl,
      siblingPrUrls: result.siblingPrUrls,
      iterations: result.iterations,
      developer: null,
      reviews: null,
      ...(result.notes ? { notes: result.notes } : {}),
    };
  }
  return {
    action: 'stop',
    taskId: result.taskId,
    outcome:
      result.outcome === 'developer-failed' || result.outcome === 'developer-json-contract-violated'
        ? result.outcome
        : 'aborted',
    reason: result.notes ?? `pipeline outcome: ${result.outcome}`,
    branch: result.branch,
    worktreePath: result.worktreePath,
    prUrl: null,
    ...(result.notes ? { notes: result.notes } : {}),
  };
}
