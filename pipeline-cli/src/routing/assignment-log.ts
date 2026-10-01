/**
 * Assignment log: one JSON line per model resolution, appended to
 * `assignments.jsonl` in the artifacts directory.
 *
 * Holds ids, counts and attribution only: timestamp, task id, role, task
 * class, iteration, model, arm and a fixed reason string. Never a prompt,
 * response, file content or tool output. Appending never throws.
 *
 * @module routing/assignment-log
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type RoutingArm = 'table' | 'explore' | 'override' | 'default';

export interface AssignmentRecord {
  ts: string;
  taskId: string;
  role: string;
  taskClass: string;
  iteration: number;
  model?: string;
  arm: RoutingArm;
  reason: string;
}

export function assignmentLogPath(artifactsDir: string): string {
  return join(artifactsDir, '_routing', 'assignments.jsonl');
}

/** Append one record. Swallows every error; returns whether the write happened. */
export function appendAssignment(artifactsDir: string, rec: AssignmentRecord): boolean {
  try {
    const file = assignmentLogPath(artifactsDir);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
