/**
 * `cli-staged-review`: drives the staged review set (`reviewerSet: staged`).
 *
 * The staged review is five phases. The coordinator (`/ai-sdlc execute`, Step 7) runs
 * them in order, making the two model calls in between itself:
 *
 *   prepare      risk map, baseline and the planner's prompt; or a fallback to `three`
 *   (planner)    agent `review-planner` on the prompt prepare wrote
 *   plan         validate the planner's plan: `retry` once, then the code-built fallback plan
 *   execute      run the probes (read-only, tool-restricted) and write the evidence
 *   synth-prompt the synthesizer's prompt
 *   (synthesizer) agent `review-synthesizer` on that prompt
 *   finalize     validate and ground the verdict; write the verdict and the leaf manifest
 *   status       print the dispatch record
 *
 * Every subcommand prints one JSON object. `prepare` and `finalize` answer
 * `ok: false` with `fallbackSet: "three"` and the rejections when the staged review
 * cannot review the change; the coordinator then runs the existing reviewer set. The same
 * information is kept in `<artifacts>/_staged-review/<task-id>/dispatch.json`.
 *
 * @module cli/staged-review
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { buildJudgmentContext } from '../judgment/context.js';
import type { ProbeSpawner } from '../review-plan/executor.js';
import { resolveModel } from '../routing/resolve-model.js';
import { resolveArtifactsDir } from '../routing/artifacts-dir.js';
import { findTaskFile, parseTaskFile } from '../steps/01-validate.js';
import {
  executeStagedReview,
  finalizeStagedReview,
  planStagedReview,
  prepareStagedReview,
  readDispatchRecord,
  recordStagedFallback,
  stagedRunDir,
  synthesizerPromptForRun,
} from '../review-staged/index.js';

function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function readOptional(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(resolve(path), 'utf8');
  } catch {
    return undefined;
  }
}

function common(y: Argv): Argv {
  return y
    .option('task-id', {
      type: 'string',
      demandOption: true,
      describe: 'Task id, e.g. AISDLC-676.',
    })
    .option('artifacts-dir', {
      type: 'string',
      describe:
        'Artifacts directory (default: $ARTIFACTS_DIR, then <work-dir>/.ai-sdlc/artifacts).',
    })
    .option('work-dir', {
      type: 'string',
      describe: "The task's worktree (default: the current directory).",
    });
}

function dirs(args: Record<string, unknown>): { workDir: string; artifactsDir: string } {
  const workDir = resolve((args['work-dir'] as string | undefined) ?? process.cwd());
  return {
    workDir,
    artifactsDir: resolve(
      resolveArtifactsDir(workDir, args['artifacts-dir'] as string | undefined),
    ),
  };
}

export interface StagedReviewCliDeps {
  /** Replaces the production probe adapters. For tests; the bin shim passes none. */
  spawner?: ProbeSpawner;
}

export function buildStagedReviewCli(
  argv: string[],
  deps: StagedReviewCliDeps = {},
): ReturnType<typeof yargs> {
  return yargs(argv)
    .scriptName('cli-staged-review')
    .usage('Usage: $0 <command> [options]')
    .strict()
    .command(
      'prepare',
      'Build the risk map, baseline and planner prompt, or report that the existing set must run.',
      (y: Argv) =>
        common(y)
          .option('source-kind', {
            type: 'string',
            choices: ['backlog', 'gh-issue'] as const,
            default: 'backlog',
            describe: 'Kind of the work item. Only backlog work may use the staged set.',
          })
          .option('base-ref', {
            type: 'string',
            default: 'origin/main',
            describe: 'Ref the diff is taken against and the config is read from.',
          })
          .option('diff-file', {
            type: 'string',
            describe: 'A unified diff to review instead of reading <base-ref>...HEAD.',
          }),
      async (args) => {
        const { workDir, artifactsDir } = dirs(args);
        const taskId = args['task-id'] as string;
        const sourceKind = args['source-kind'] as string;

        let criteria: string[] = [];
        let references: string[] = [];
        const taskFile = findTaskFile(taskId, workDir);
        if (taskFile) {
          try {
            const task = parseTaskFile(taskFile);
            criteria = task.acceptanceCriteria;
            references = task.references ?? [];
          } catch {
            criteria = [];
          }
        }
        if (sourceKind === 'backlog' && criteria.length === 0) {
          emitJson(
            await recordStagedFallback({
              taskId,
              sourceKind,
              artifactsDir,
              reason: 'task-unreadable',
              detail: 'the task file or its acceptance criteria could not be read',
            }),
          );
          return;
        }

        const result = await prepareStagedReview({
          taskId,
          worktreePath: workDir,
          sourceKind,
          artifactsDir,
          acceptanceCriteria: criteria,
          references,
          baseRef: args['base-ref'] as string,
          judgment: buildJudgmentContext({ workDir, artifactsDir, sourceKind, taskId }),
          ...(readOptional(args['diff-file'] as string | undefined) !== undefined
            ? { diff: readOptional(args['diff-file'] as string | undefined) as string }
            : {}),
        });
        emitJson(result);
      },
    )
    .command(
      'plan',
      "Validate the planner's plan. Answers `retry` once with the reasons, then uses the fallback plan.",
      (y: Argv) =>
        common(y)
          .option('planner-output', {
            type: 'string',
            describe:
              "File holding the planner's final message. Absent or unreadable counts as rejected.",
          })
          .option('attempt', { type: 'number', choices: [1, 2], default: 1 }),
      async (args) => {
        const { artifactsDir } = dirs(args);
        const result = await planStagedReview({
          taskId: args['task-id'] as string,
          artifactsDir,
          plannerOutput: readOptional(args['planner-output'] as string | undefined),
          attempt: (args['attempt'] as number) === 2 ? 2 : 1,
        });
        emitJson(result);
      },
    )
    .command(
      'execute',
      'Run the plan: probes on read-only, tool-restricted executors, and write the evidence.',
      (y: Argv) => common(y),
      async (args) => {
        const { workDir, artifactsDir } = dirs(args);
        const taskId = args['task-id'] as string;
        const runDir = stagedRunDir(artifactsDir, taskId);
        const record = await readDispatchRecord(runDir);
        // The model comes from the `review-executor` routing cell. Resolution here only reads.
        const routed = resolveModel({
          role: 'review-executor',
          taskId,
          workDir,
          artifactsDir,
          record: false,
          ...(record?.sourceKind === 'backlog' || record?.sourceKind === 'gh-issue'
            ? { sourceKind: record.sourceKind }
            : {}),
        });
        const result = await executeStagedReview({
          taskId,
          artifactsDir,
          ...(routed.model ? { executorModel: routed.model } : {}),
          ...(deps.spawner ? { spawner: deps.spawner } : {}),
        });
        emitJson(result);
      },
    )
    .command(
      'synth-prompt',
      "Write the synthesizer's prompt from the risk map, plan and evidence.",
      (y: Argv) => common(y),
      async (args) => {
        const { artifactsDir } = dirs(args);
        emitJson(
          await synthesizerPromptForRun({ taskId: args['task-id'] as string, artifactsDir }),
        );
      },
    )
    .command(
      'finalize',
      "Validate and ground the synthesizer's verdict; write the verdict and the leaf manifest.",
      (y: Argv) =>
        common(y)
          .option('synthesizer-output', {
            type: 'string',
            describe: "File holding the synthesizer's final message.",
          })
          .option('planner-model', { type: 'string', describe: 'Model the planner ran on.' })
          .option('synthesizer-model', {
            type: 'string',
            describe: 'Model the synthesizer ran on.',
          }),
      async (args) => {
        const { artifactsDir } = dirs(args);
        const result = await finalizeStagedReview({
          taskId: args['task-id'] as string,
          artifactsDir,
          synthesizerOutput: readOptional(args['synthesizer-output'] as string | undefined),
          ...(args['planner-model'] ? { plannerModel: args['planner-model'] as string } : {}),
          ...(args['synthesizer-model']
            ? { synthesizerModel: args['synthesizer-model'] as string }
            : {}),
        });
        emitJson(result);
      },
    )
    .command(
      'status',
      'Print the dispatch record of a task.',
      (y: Argv) => common(y),
      async (args) => {
        const { artifactsDir } = dirs(args);
        const record = await readDispatchRecord(
          stagedRunDir(artifactsDir, args['task-id'] as string),
        );
        emitJson(record ?? { status: 'none' });
      },
    )
    .demandCommand(
      1,
      'Specify a subcommand (prepare, plan, execute, synth-prompt, finalize, status)',
    )
    .help()
    .alias('h', 'help')
    .version(false);
}

/** Entry point for the bin shim. */
export async function runStagedReviewCli(): Promise<void> {
  await buildStagedReviewCli(hideBin(process.argv)).parseAsync();
}
