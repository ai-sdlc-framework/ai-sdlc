/**
 * Step 5 — Build the developer subagent's prompt.
 *
 * Pure function: TaskSpec + branch context → prompt string. Mirrors the
 * prose template in `execute-orchestrator.md` Step 5 verbatim so swapping
 * Tier 1 / Tier 2 invocation produces byte-identical prompts.
 *
 * The LLM dispatch (Step 5b) is NOT implemented here — that's the
 * `SubagentSpawner.spawn({ type: 'developer', prompt })` boundary which
 * Tier 2 invokes from `execute-pipeline.ts` and Tier 1 invokes via the
 * Agent tool from the slash command body.
 *
 * @module steps/05-build-dev-prompt
 */

import type { DeveloperPromptResult, TaskSpec } from '../types.js';

export interface BuildDeveloperPromptOptions {
  taskId: string;
  task: TaskSpec;
  branch: string;
  worktreePath: string;
  /** Optional reviewer feedback bundle for iteration N>1 (Step 9). */
  reviewerFeedback?: string;
  /** Iteration number — set to >1 to inject the feedback section (default 1). */
  iteration?: number;
}

export async function buildDeveloperPrompt(
  opts: BuildDeveloperPromptOptions,
): Promise<DeveloperPromptResult> {
  const acList = opts.task.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n');

  const refs =
    opts.task.references && opts.task.references.length > 0
      ? opts.task.references.join('\n')
      : '(none)';

  const externalPaths =
    opts.task.permittedExternalPaths && opts.task.permittedExternalPaths.length > 0
      ? opts.task.permittedExternalPaths.join('\n')
      : 'none';

  const iteration = opts.iteration ?? 1;
  const feedbackBlock =
    iteration > 1 && opts.reviewerFeedback
      ? `\n\n## Reviewer feedback (round ${iteration - 1})\n\n${opts.reviewerFeedback}\n\n` +
        `Address every finding above and re-run all four verifications before committing.\n`
      : '';

  const prompt =
    `You are implementing backlog task ${opts.taskId} in worktree ${opts.worktreePath}.\n\n` +
    `## Task title\n${opts.task.title}\n\n` +
    `## Description\n${opts.task.description}\n\n` +
    `## Acceptance criteria\n${acList}\n\n` +
    `## References\n${refs}\n\n` +
    `## Permitted external paths (cross-repo writes)\n${externalPaths}\n\n` +
    `## Verification commands (run before commit)\n` +
    `- pnpm build\n- pnpm test\n- pnpm lint\n- pnpm format:check\n\n` +
    `## Commit message template\n` +
    `<conventional-commit type>: <subject> (${opts.taskId})\n\n` +
    `<body>\n\n` +
    `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>\n\n` +
    `## Branch\nYou are on branch \`${opts.branch}\` checked out at \`${opts.worktreePath}\`.\n` +
    feedbackBlock +
    `\nReturn the JSON shape documented in your agent definition.\n`;

  return { prompt, task: opts.task };
}
