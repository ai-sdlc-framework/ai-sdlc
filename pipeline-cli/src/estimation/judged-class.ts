/**
 * Judgment-layer input for class assignment.
 *
 * Class assignment is synchronous, so the judgment layer is consulted first and its
 * class is passed in (`AssignClassInput.judgedClass`). Only an `act` outcome counts:
 * with no runner, or on abstain, escalate or failure, the regex and default apply as
 * before. A frontmatter class always wins, so it is not asked.
 *
 * @module estimation/judged-class
 */

import { estimateClassDefinition } from '@ai-sdlc/reference';
import type { JudgmentRunner } from '../judgment/runner.js';
import { findTaskFile, parseTaskFile } from '../steps/01-validate.js';
import { assignClass } from './class-assignment.js';
import { readFrontmatterClass } from './stage-a.js';
import { TASK_CLASSES, type TaskClass } from './types.js';

export interface JudgeTaskClassInput {
  taskId?: string;
  title: string;
  description?: string;
  /** Raw frontmatter `class:` value. */
  frontmatterClass?: string | undefined;
  /** Kind of the work item. Estimation reads backlog task files, so this is `backlog`. */
  sourceKind?: string;
}

/** The judged class, or `undefined` when there is no runner or the judgment did not act. */
export async function judgeTaskClass(
  input: JudgeTaskClassInput,
  runner: JudgmentRunner | undefined,
): Promise<TaskClass | undefined> {
  if (!runner) return undefined;
  const fm = input.frontmatterClass?.trim().toLowerCase();
  if (fm && (TASK_CLASSES as readonly string[]).includes(fm)) return undefined;
  const incumbent = assignClass({ title: input.title });
  const outcome = await runner(
    estimateClassDefinition,
    { title: input.title, ...(input.description ? { description: input.description } : {}) },
    {
      incumbent: incumbent.taskClass,
      ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    },
  );
  return outcome.kind === 'act' ? outcome.decision : undefined;
}

/**
 * Judge the class of a backlog task by id. Returns `undefined` when there is no runner,
 * the task file is missing, a frontmatter class is set, or the judgment did not act.
 */
export async function judgeClassForTask(
  opts: { taskId: string; workDir: string },
  runner: JudgmentRunner | undefined,
): Promise<TaskClass | undefined> {
  if (!runner) return undefined;
  const taskFilePath = findTaskFile(opts.taskId, opts.workDir);
  if (!taskFilePath) return undefined;
  try {
    const task = parseTaskFile(taskFilePath);
    return await judgeTaskClass(
      {
        taskId: task.id,
        title: task.title,
        ...(task.description ? { description: task.description } : {}),
        frontmatterClass: readFrontmatterClass(taskFilePath),
        sourceKind: 'backlog',
      },
      runner,
    );
  } catch {
    return undefined;
  }
}
