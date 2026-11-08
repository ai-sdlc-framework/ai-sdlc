/**
 * Held-task triage (AISDLC-1244). A queued task held on a dependency that no executor will ever claim
 * (`dispatchable: false`, or not on the board) used to sit held indefinitely. The tick classifies each
 * hold; a non-`waiting` class is recorded once in `held/<id>.json` and typed once into the planner session.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadEligibilityContext } from '../dispatch/board.js';
import { findTaskFileRelative } from '../dor/dispatch-readiness.js';

export type HeldClass = 'waiting' | 'operator-gated' | 'absent' | 'circular';

/** What the classifier needs to know about one unmet dependency. */
export interface HeldFacts {
  heldId: string;
  /** The dependency is queued, inflight, blocked, delivered or failed on the board. */
  onBoard: boolean;
  /** Raw text of the dependency's task file, when it has one. */
  dependencyText?: string;
}

/** True when the frontmatter of a task file says `dispatchable: false`. */
export function isDispatchableFalse(raw: string): boolean {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  return /^dispatchable:\s*["']?false["']?\s*$/im.test(fm);
}

/** Classify one hold. `circular` wins: the dependency can close only when the held task lands. */
export function classifyHold(facts: HeldFacts): HeldClass {
  if (facts.onBoard) return 'waiting';
  const text = facts.dependencyText;
  if (text !== undefined) {
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
    if (body.toLowerCase().includes(facts.heldId.toLowerCase())) return 'circular';
    if (isDispatchableFalse(text)) return 'operator-gated';
  }
  return 'absent';
}

/** One classified hold. */
export interface HeldRow {
  taskId: string;
  dependency: string;
  class: HeldClass;
  taskPath?: string;
  dependencyPath?: string;
}

function readIfExists(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Classify every queued task's unmet `after` dependencies. */
export function listHeld(boardDir: string, repoDir: string): HeldRow[] {
  const queueDir = path.join(boardDir, 'queue');
  if (!existsSync(queueDir)) return [];
  const ctx = loadEligibilityContext(boardDir, repoDir);
  const rows: HeldRow[] = [];
  for (const file of readdirSync(queueDir).filter((f) => f.endsWith('.dispatch.json'))) {
    let manifest: { taskId?: unknown; after?: unknown };
    try {
      manifest = JSON.parse(readFileSync(path.join(queueDir, file), 'utf-8')) as typeof manifest;
    } catch {
      continue;
    }
    if (typeof manifest.taskId !== 'string' || !Array.isArray(manifest.after)) continue;
    const taskId = manifest.taskId;
    for (const dep of manifest.after.filter((d): d is string => typeof d === 'string')) {
      if (ctx.doneTaskIds.has(dep) || ctx.isDoneOnMain?.(dep)) continue;
      const depPath = findTaskFileRelative(dep, repoDir);
      const taskPath = findTaskFileRelative(taskId, repoDir);
      const cls = classifyHold({
        heldId: taskId,
        onBoard: ctx.onBoardTaskIds.has(dep),
        ...(depPath ? { dependencyText: readIfExists(path.join(repoDir, depPath)) ?? '' } : {}),
      });
      rows.push({
        taskId,
        dependency: dep,
        class: cls,
        ...(taskPath ? { taskPath } : {}),
        ...(depPath ? { dependencyPath: depPath } : {}),
      });
    }
  }
  return rows;
}

/** A held record, `held/<id>.json`. */
export interface HeldRecord {
  schemaVersion: 'v1';
  taskId: string;
  dependency: string;
  class: HeldClass;
  taskPath?: string;
  dependencyPath?: string;
  createdAt: string;
  /** False while the planner line could not be delivered; the next tick retries it. */
  notified: boolean;
}

/**
 * Record each non-`waiting` hold once per (task, dependency, class) and tell the planner one line.
 * Returns the task ids announced this call.
 */
export function triageHeld(
  boardDir: string,
  repoDir: string,
  now: Date,
  notify: (text: string) => void,
): string[] {
  const dir = path.join(boardDir, 'held');
  const announced: string[] = [];
  for (const row of listHeld(boardDir, repoDir)) {
    if (row.class === 'waiting') continue;
    const file = path.join(dir, `${row.taskId}.json`);
    const prior = readIfExists(file);
    if (prior !== undefined) {
      try {
        const rec = JSON.parse(prior) as HeldRecord;
        if (rec.dependency === row.dependency && rec.class === row.class && rec.notified) continue;
      } catch {
        /* an unreadable record is rewritten */
      }
    }
    const record: HeldRecord = {
      schemaVersion: 'v1',
      ...row,
      createdAt: now.toISOString(),
      notified: false,
    };
    try {
      notify(
        `Held task ${row.taskId} waits on ${row.dependency} (${row.class}): ${row.taskPath ?? row.taskId} / ${row.dependencyPath ?? row.dependency}; drop the dependency with \`cli-file task --update\`, park the task, or leave it.`,
      );
      record.notified = true;
      announced.push(row.taskId);
    } catch {
      /* no planner to tell; the record stays unnotified and the next tick retries */
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf-8');
  }
  return announced;
}
