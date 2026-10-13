/**
 * Where one staged review's state lives, and the dispatch record that summarises it.
 *
 * The staged review runs as separate command invocations (prepare, plan, execute,
 * synthesize, finalize) with the planner and synthesizer model calls made by the
 * coordinator in between. Everything a later phase needs is therefore written to one
 * run directory under the artifacts directory by the phase before it, and nothing is
 * carried in memory between phases.
 *
 *   <artifactsDir>/_staged-review/<task-id>/
 *     dispatch.json          what the staged review did, and why it fell back, if it did
 *     task.json              the inputs fixed at prepare time
 *     config.json            the limits in force (read from the base ref)
 *     risk-map.json          the validated risk map
 *     baseline.json          the code-defined baseline plan
 *     fallback-plan.json     the code-built plan used when the planner's is rejected twice
 *     planner-prompt.txt     what the planner is asked
 *     plan.json              the plan that will run
 *     evidence.json          the evidence bundle
 *     synthesizer-prompt.txt what the synthesizer is asked
 *     verdict.json           the grounded verdict
 *     execute-leaves.json    the probe transcripts that were written
 *     leaves.json            the transcript leaves to emit
 *
 * @module review-staged/run-store
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { now } from '../clock.js';
import type { Rejection } from '../review-plan/types.js';

export const STAGED_RUN_DIR = '_staged-review';

/** Characters a path segment built from an id may keep. */
export function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'run';
}

/** The run directory for a task. Not created here. */
export function stagedRunDir(artifactsDir: string, taskId: string): string {
  return join(resolve(artifactsDir), STAGED_RUN_DIR, safeSegment(taskId));
}

export const RUN_FILES = {
  dispatch: 'dispatch.json',
  task: 'task.json',
  config: 'config.json',
  riskMap: 'risk-map.json',
  baseline: 'baseline.json',
  fallbackPlan: 'fallback-plan.json',
  plannerPrompt: 'planner-prompt.txt',
  plannerTruncation: 'planner-truncation.json',
  plan: 'plan.json',
  evidence: 'evidence.json',
  synthesizerPrompt: 'synthesizer-prompt.txt',
  synthesizerTruncation: 'synthesizer-truncation.json',
  verdict: 'verdict.json',
  reviewerVerdict: 'reviewer-verdict.json',
  executeLeaves: 'execute-leaves.json',
  leaves: 'leaves.json',
} as const;

export async function writeRunJson(runDir: string, file: string, value: unknown): Promise<string> {
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, file);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

export async function writeRunText(runDir: string, file: string, text: string): Promise<string> {
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, file);
  await writeFile(path, text, 'utf8');
  return path;
}

export async function readRunJson<T>(runDir: string, file: string): Promise<T> {
  return JSON.parse(await readFile(join(runDir, file), 'utf8')) as T;
}

/** Remove every file a previous review of this task left, except the dispatch record. */
export async function clearRun(runDir: string): Promise<void> {
  for (const [key, file] of Object.entries(RUN_FILES)) {
    if (key === 'dispatch') continue;
    await rm(join(runDir, file), { force: true });
  }
}

// ── Dispatch record ──────────────────────────────────────────────────────

export type StagedStatus = 'prepared' | 'planned' | 'executed' | 'finalized' | 'fallback';

export interface ProbeCounts {
  total: number;
  ok: number;
  failed: number;
  refused: number;
  skipped: number;
}

/**
 * The record of what the staged review did for one change. When the staged review could
 * not run (`status: 'fallback'`), `fallbackSet` names the set that handles the change
 * instead and `rejections` carries every reason the plan or its inputs were refused.
 */
export interface StagedDispatchRecord {
  schemaVersion: 1;
  taskId: string;
  sourceKind: string;
  status: StagedStatus;
  /** The set that handles the change when the staged review does not. */
  fallbackSet?: 'three';
  reason?: string;
  rejections: Rejection[];
  /** Where the plan that ran came from. */
  planSource?: 'planner' | 'fallback';
  /** Planner outputs offered for validation (1 or 2). */
  plannerAttempts?: number;
  /** Rejections of the planner's plan on its attempts. */
  planRejections?: Rejection[];
  probes?: ProbeCounts;
  /** Findings removed before aggregation because no evidence backed them. */
  droppedFindings?: number;
  /** Hunks no probe returned evidence for. */
  uncoveredHunks?: string[];
  updatedAt: string;
}

export async function readDispatchRecord(
  runDir: string,
): Promise<StagedDispatchRecord | undefined> {
  try {
    return await readRunJson<StagedDispatchRecord>(runDir, RUN_FILES.dispatch);
  } catch {
    return undefined;
  }
}

/** Merge `patch` into the record (creating it from `base` when absent) and write it. */
export async function updateDispatchRecord(
  runDir: string,
  base: Pick<StagedDispatchRecord, 'taskId' | 'sourceKind'>,
  patch: Partial<StagedDispatchRecord>,
  clock: () => Date = now,
): Promise<StagedDispatchRecord> {
  const current = (await readDispatchRecord(runDir)) ?? {
    schemaVersion: 1 as const,
    taskId: base.taskId,
    sourceKind: base.sourceKind,
    status: 'prepared' as const,
    rejections: [],
    updatedAt: clock().toISOString(),
  };
  const next: StagedDispatchRecord = { ...current, ...patch, updatedAt: clock().toISOString() };
  await writeRunJson(runDir, RUN_FILES.dispatch, next);
  return next;
}
