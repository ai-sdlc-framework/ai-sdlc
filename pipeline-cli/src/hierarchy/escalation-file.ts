/**
 * Escalation file for the model-less dispatch host (RFC-0058 phase 2, AISDLC-1035).
 *
 * A tick result the policy tables cannot classify is written under `<board>/escalations/` for the
 * planner, in the shape RFC-0056 OQ-5 names: the failure record, a log tail and a PR check summary.
 * The hooks module has no file API, so it calls this through `cli-hierarchy escalation-file`; the
 * dispatch model is never prompted.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { CommandRunner } from './types.js';

/** Lines of `notes` kept as the log tail. */
export const LOG_TAIL_LINES = 20;
/** Lines of `gh pr checks` kept as the check summary. */
export const CHECK_SUMMARY_LINES = 40;

/** What the file holds. */
export interface EscalationFile {
  schemaVersion: 'v1';
  taskId: string;
  message: string;
  createdAt: string;
  /** The task's verdict or diagnostic, or null when the board holds none. */
  failureRecord: Record<string, unknown> | null;
  /** The last lines of the failure record's notes. */
  logTail: string[];
  /** `gh pr checks` output for the task's pull request; empty when it has none or gh failed. */
  prCheckSummary: string[];
}

export interface EscalationInputs {
  boardDir: string;
  taskId: string;
  message: string;
  now: Date;
  run: CommandRunner;
}

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Write the escalation file; returns its path. @throws on an invalid task id. */
export function writeEscalationFile(inputs: EscalationInputs): { file: string } {
  const { boardDir, taskId, message, now, run } = inputs;
  if (!TASK_ID_RE.test(taskId)) throw new Error(`'${taskId}' is not a valid task id`);
  const failureRecord =
    readJson(path.join(boardDir, 'failed', `${taskId}.diagnostic.json`)) ??
    readJson(path.join(boardDir, 'failed', `${taskId}.verdict.json`)) ??
    readJson(path.join(boardDir, 'done', `${taskId}.verdict.json`));
  const notes = typeof failureRecord?.notes === 'string' ? failureRecord.notes : '';
  const logTail = notes.split('\n').filter(Boolean).slice(-LOG_TAIL_LINES);
  const pr = failureRecord?.prNumber;
  let prCheckSummary: string[] = [];
  if (typeof pr === 'number' && Number.isInteger(pr) && pr > 0) {
    const r = run('gh', ['pr', 'checks', String(pr)]);
    prCheckSummary = r.stdout.split('\n').filter(Boolean).slice(0, CHECK_SUMMARY_LINES);
  }
  const body: EscalationFile = {
    schemaVersion: 'v1',
    taskId,
    message,
    createdAt: now.toISOString(),
    failureRecord,
    logTail,
    prCheckSummary,
  };
  const dir = path.join(boardDir, 'escalations');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${taskId}-${now.getTime()}.json`);
  writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf-8');
  return { file };
}
