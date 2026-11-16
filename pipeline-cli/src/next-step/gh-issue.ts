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

export interface FetchedIssue {
  spec: TaskSpec;
  issueNumber: number;
  /** Author association from the GitHub API response (never from issue text). */
  authorAssociation?: string;
  /** Label names on the issue. */
  labels?: string[];
}

/** Label only a user with triage or write access can apply. */
export const EXECUTE_APPROVED_LABEL = 'execute-approved';
/** Associations treated as inside the project. */
const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
/** Byte cap for the issue title and for the description. */
export const MAX_ISSUE_TITLE_BYTES = 500;
export const MAX_ISSUE_DESCRIPTION_BYTES = 20000;

export interface GhIssueDeps {
  /** True when `claude` resolves on PATH. */
  claudeOnPath: () => Promise<boolean>;
  /** Fetch + synthesise the inline spec (dogfood `fetchGhIssueAsTaskSpec`). */
  fetchSpec: (distFile: string, issueNumber: number) => Promise<FetchedIssue>;
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
      fetchGhIssueAsTaskSpec: (n: number) => Promise<FetchedIssue>;
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
  let fetched: FetchedIssue;
  try {
    fetched = await deps.fetchSpec(dist, issueNumber);
  } catch (err) {
    return failure(
      taskId,
      `failed to fetch GitHub issue #${issueNumber}: ${(err as Error).message}`,
    );
  }
  const assoc = fetched.authorAssociation;
  if (!assoc || !TRUSTED_ASSOCIATIONS.includes(assoc)) {
    if (!(fetched.labels ?? []).includes(EXECUTE_APPROVED_LABEL)) {
      return failure(
        taskId,
        `issue #${issueNumber} was written by an author with association ` +
          `${assoc ? `"${assoc}"` : 'unknown (could not be read)'}, outside the project. ` +
          `Refusing to execute it unless a maintainer applies the \`${EXECUTE_APPROVED_LABEL}\` label.`,
      );
    }
  }
  const titleBytes = Buffer.byteLength(fetched.spec.title, 'utf8');
  const descBytes = Buffer.byteLength(fetched.spec.description ?? '', 'utf8');
  if (titleBytes > MAX_ISSUE_TITLE_BYTES) {
    return failure(
      taskId,
      `issue #${issueNumber} title is ${titleBytes} bytes, over the ${MAX_ISSUE_TITLE_BYTES}-byte cap.`,
    );
  }
  if (descBytes > MAX_ISSUE_DESCRIPTION_BYTES) {
    return failure(
      taskId,
      `issue #${issueNumber} description is ${descBytes} bytes, over the ${MAX_ISSUE_DESCRIPTION_BYTES}-byte cap.`,
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
      result.outcome === 'developer-failed' ||
      result.outcome === 'developer-parked' ||
      result.outcome === 'developer-json-contract-violated'
        ? result.outcome
        : 'aborted',
    reason: result.notes ?? `pipeline outcome: ${result.outcome}`,
    branch: result.branch,
    worktreePath: result.worktreePath,
    prUrl: null,
    ...(result.notes ? { notes: result.notes } : {}),
  };
}
