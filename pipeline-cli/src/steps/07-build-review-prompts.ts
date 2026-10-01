/**
 * Step 7 — Build review prompts (default: 3 reviewers — code, test, security).
 *
 * Mirrors `execute-orchestrator.md` Step 7. Captures the PR diff + changed
 * file list, detects whether `codex` is installed (independence harness),
 * and produces reviewer-specific prompt strings that can be fed to parallel
 * `SubagentSpawner.spawn()` calls (Tier 2) or parallel Agent tool
 * invocations (Tier 1).
 *
 * AISDLC-617 — the reviewer SET is flag-driven via
 * `resolveReviewerSet()` (`steps/reviewer-set.ts`): the DEFAULT remains the
 * three reviewers above; `reviewerSet: code-test-merged` (opt-in, via
 * `AI_SDLC_REVIEWER_SET` or `.ai-sdlc/review-config.yaml`) swaps in exactly
 * two — `correctness-reviewer` (merged code+test remit) + `security-reviewer`
 * (unchanged, separate). With a judgment provider configured, `selectReviewerSet()`
 * may pick the merged set per PR (trusted work only, never past a path veto) and
 * `routeReviewers()` may add reviewers afterwards; neither ever shrinks a set. Do not hardcode a reviewer count anywhere downstream
 * of this step — always read `prompts.length`.
 *
 * The reviewer subagents themselves run via the LLM dispatch boundary
 * (Step 7b) which is NOT part of this step.
 *
 * @module steps/07-build-review-prompts
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import type { BuildReviewPromptsResult, ReviewPrompt, ReviewerType, TaskSpec } from '../types.js';
import { resolveTargetBranch } from './02-compute-branch.js';
import { selectReviewerSet } from './reviewer-set.js';
import { routeReviewers } from './review-routing.js';
import { buildJudgmentContext } from '../judgment/context.js';
import type { EvaluateJudgmentContext } from '@ai-sdlc/reference';
import { resolveModel } from '../routing/resolve-model.js';
import { routingArtifactsDir, routingRecordable } from '../routing/artifacts-dir.js';
import { taskClassOf } from '../routing/task-class.js';

export interface BuildReviewPromptsOptions {
  taskId: string;
  task: TaskSpec;
  branch: string;
  worktreePath: string;
  workDir: string;
  runner?: Runner;
  /** Override the codex-availability detection (test injection). */
  codexAvailable?: boolean;
  /** Override the resolved reviewer set (test injection / explicit caller choice). AISDLC-617. */
  reviewers?: ReviewerType[];
  /** Source of the work; only an explicit `backlog` is eligible for model exploration. */
  sourceKind?: 'backlog' | 'gh-issue';
  /** Review iteration (default 1). */
  iteration?: number;
  /** Artifacts directory for the assignment log (defaults to $ARTIFACTS_DIR). */
  artifactsDir?: string;
  /**
   * Set false to resolve models without writing the assignment log or reporting
   * the routing capability (offline replay must leave no trace).
   */
  recordRouting?: boolean;
  /**
   * Judgment context for `review.reviewer-set` and `review.routing` (test injection).
   * Defaults to the context built from the trusted base-branch config; with no
   * provider configured the judgments are never evaluated and the reviewers are
   * exactly what the resolver returns.
   */
  judgment?: EvaluateJudgmentContext;
}

export async function buildReviewPrompts(
  opts: BuildReviewPromptsOptions,
): Promise<BuildReviewPromptsResult> {
  const runner = opts.runner ?? defaultRunner;

  // AISDLC-606 — diff against the resolved integration branch (defaults to
  // `origin/main` when `spec.branching.targetBranch` is unset, so main-based
  // repos are byte-identical to pre-AISDLC-606 behavior).
  const targetBranch = resolveTargetBranch(opts.workDir);
  const baseRef = `origin/${targetBranch}`;

  const diffResult = await runner('git', ['diff', `${baseRef}...HEAD`], {
    cwd: opts.worktreePath,
    allowFailure: true,
  });
  const diff = diffResult.code === 0 ? diffResult.stdout : '';

  const filesResult = await runner('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    cwd: opts.worktreePath,
    allowFailure: true,
  });
  const changedFiles =
    filesResult.code === 0
      ? filesResult.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : [];

  // Codex independence detection
  let codexAvailable = opts.codexAvailable;
  if (codexAvailable === undefined) {
    try {
      const which = await runner('which', ['codex'], { allowFailure: true });
      codexAvailable = which.code === 0 && which.stdout.trim().length > 0;
    } catch {
      codexAvailable = false;
    }
  }
  const harnessNote = codexAvailable
    ? ''
    : '⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)';

  // Optional review policy from .ai-sdlc/review-policy.md (project-specific calibration)
  const policyPath = join(opts.workDir, '.ai-sdlc', 'review-policy.md');
  const policy = existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : '';

  const acList = opts.task.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n');

  // Offline replay (`recordRouting: false`) leaves no trace, so it never reaches a provider.
  const judgment =
    opts.recordRouting === false
      ? undefined
      : (opts.judgment ??
        buildJudgmentContext({
          workDir: opts.workDir,
          artifactsDir: routingArtifactsDir(opts.worktreePath, opts.artifactsDir),
          ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
          taskId: opts.taskId,
        }));
  const selected =
    opts.reviewers ??
    (
      await selectReviewerSet({
        workDir: opts.workDir,
        ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
        taskId: opts.taskId,
        changedFiles,
        diff,
        ...(judgment ? { judgment } : {}),
      })
    ).reviewers;
  // review.routing runs after set selection and can only add reviewers.
  const reviewers = (
    await routeReviewers({
      reviewers: selected,
      changedFiles,
      diff,
      ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
      taskId: opts.taskId,
      ...(judgment ? { judgment } : {}),
    })
  ).reviewers;

  const taskClass = taskClassOf(opts.task.rawBody);
  const prompts: ReviewPrompt[] = reviewers.map((reviewer) => {
    const routed = resolveModel({
      role: reviewer,
      taskClass,
      taskId: opts.taskId,
      sourceKind: opts.sourceKind,
      iteration: opts.iteration ?? 1,
      workDir: opts.workDir,
      artifactsDir: routingArtifactsDir(opts.worktreePath, opts.artifactsDir),
      record:
        opts.recordRouting !== false && routingRecordable(opts.worktreePath, opts.artifactsDir),
    });
    return {
      reviewer,
      ...(routed.model !== undefined ? { model: routed.model } : {}),
      modelArm: routed.arm,
      prompt: buildPrompt(reviewer, {
        taskId: opts.taskId,
        title: opts.task.title,
        description: opts.task.description,
        acList,
        diff,
        changedFiles,
        branch: opts.branch,
        policy,
        harnessNote,
      }),
    };
  });

  return { prompts, diff, changedFiles, harnessNote };
}

interface PromptInputs {
  taskId: string;
  title: string;
  description: string;
  acList: string;
  diff: string;
  changedFiles: string[];
  branch: string;
  policy: string;
  harnessNote: string;
}

function buildPrompt(reviewer: ReviewerType, inputs: PromptInputs): string {
  const policyBlock = inputs.policy
    ? `\n## Project review policy (.ai-sdlc/review-policy.md)\n\n${inputs.policy}\n`
    : '';
  const harnessBlock = inputs.harnessNote ? `\n${inputs.harnessNote}\n` : '';
  const filesBlock = inputs.changedFiles.length
    ? inputs.changedFiles.map((f) => `- ${f}`).join('\n')
    : '(none)';

  return (
    `You are the ${reviewer} for backlog task ${inputs.taskId}.\n\n` +
    `## Task\n${inputs.title}\n\n` +
    `## Description\n${inputs.description}\n\n` +
    `## Acceptance criteria\n${inputs.acList}\n\n` +
    `## Branch / base\nbranch: ${inputs.branch} → main\n\n` +
    `## Changed files\n${filesBlock}\n` +
    policyBlock +
    harnessBlock +
    `\n## Diff\n\n\`\`\`diff\n${inputs.diff}\n\`\`\`\n\n` +
    `Return a verdict JSON: { approved: boolean, findings: [...], summary: string }.\n`
  );
}
