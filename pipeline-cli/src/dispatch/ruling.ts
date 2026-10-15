/**
 * Planner rulings kept on a task's manifest (AISDLC-903).
 *
 * A ruling the planner sends by message lives only in the dispatch session's
 * context, which is cleared after every tick. Writing it onto the task's manifest
 * keeps it for the next tick and for the regenerated handoff.
 *
 * Locations: `queue/<id>.dispatch.json`, `failed/<id>.manifest.json` (the snapshot
 * `requeueFailed` restores) and `done/<id>.manifest.json`. `inflight/` is refused:
 * the executor owns that manifest.
 */

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { now as clock } from '../clock.js';
import { TASK_ID_RE } from './board.js';
import type { DispatchManifest, TaskRuling } from './types.js';

/** A ruling together with the task it sits on. */
export interface BoardRuling extends TaskRuling {
  taskId: string;
}

const LOCATIONS = [
  { sub: 'queue', suffix: '.dispatch.json' },
  { sub: 'failed', suffix: '.manifest.json' },
  { sub: 'done', suffix: '.manifest.json' },
] as const;

function assertId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`'${String(taskId)}' is not a valid task id`);
}

function readJson(file: string): DispatchManifest | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as DispatchManifest;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  renameSync(tmp, file);
}

/** The manifest file that carries (or may carry) the ruling, or undefined. */
function locate(boardDir: string, taskId: string): string | undefined {
  for (const { sub, suffix } of LOCATIONS) {
    const f = path.join(boardDir, sub, `${taskId}${suffix}`);
    if (existsSync(f)) return f;
  }
  return undefined;
}

/** Inputs of {@link setRuling}. */
export interface SetRulingOptions {
  text: string;
  until?: string;
  by?: string;
  now?: () => Date;
}

/**
 * Write a ruling onto the task's manifest.
 * @throws when the task is inflight, or has no manifest in `queue/`, `failed/` or a
 *   `done/` record to hang one on.
 */
export function setRuling(boardDir: string, taskId: string, opts: SetRulingOptions): TaskRuling {
  assertId(taskId);
  if (!opts.text.trim()) throw new Error('a ruling needs a non-empty text');
  if (opts.until !== undefined) assertId(opts.until);
  if (existsSync(path.join(boardDir, 'inflight', `${taskId}.dispatch.json`))) {
    throw new Error(`${taskId} is inflight; a ruling cannot be set while an executor holds it`);
  }
  const ruling: TaskRuling = {
    text: opts.text.trim(),
    ...(opts.until === undefined ? {} : { until: opts.until }),
    ...(opts.by === undefined ? {} : { by: opts.by }),
    at: (opts.now ?? clock)().toISOString(),
  };
  let file = locate(boardDir, taskId);
  let manifest = file ? readJson(file) : undefined;
  if (!file) {
    const doneRecord = ['.verdict.json', '.completed.json'].some((s) =>
      existsSync(path.join(boardDir, 'done', `${taskId}${s}`)),
    );
    if (!doneRecord) {
      throw new Error(`${taskId} has no manifest in queue/, failed/ or done/`);
    }
    file = path.join(boardDir, 'done', `${taskId}.manifest.json`);
    manifest = { schemaVersion: 'v1', taskId } as DispatchManifest;
  }
  if (!manifest) throw new Error(`${taskId}: the manifest at ${file} is unreadable`);
  writeJson(file, { ...manifest, ruling });
  return ruling;
}

/** Remove the ruling from the task's manifest. Returns whether one was removed. */
export function clearRuling(boardDir: string, taskId: string): boolean {
  assertId(taskId);
  if (existsSync(path.join(boardDir, 'inflight', `${taskId}.dispatch.json`))) {
    throw new Error(`${taskId} is inflight; its manifest belongs to the executor`);
  }
  const file = locate(boardDir, taskId);
  const manifest = file ? readJson(file) : undefined;
  if (!file || !manifest?.ruling) return false;
  const { ruling: _drop, ...rest } = manifest;
  writeJson(file, rest);
  return true;
}

/** The ruling on a task, if any. */
export function readRuling(boardDir: string, taskId: string): TaskRuling | undefined {
  if (!TASK_ID_RE.test(taskId)) return undefined;
  const file = locate(boardDir, taskId);
  return file ? readJson(file)?.ruling : undefined;
}

/** Every ruling in force on the board, sorted by task id. */
export function listRulings(boardDir: string): BoardRuling[] {
  const out: BoardRuling[] = [];
  for (const { sub, suffix } of LOCATIONS) {
    const dir = path.join(boardDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(suffix)) continue;
      const taskId = f.slice(0, -suffix.length);
      const ruling = readJson(path.join(dir, f))?.ruling;
      if (ruling && TASK_ID_RE.test(taskId)) out.push({ taskId, ...ruling });
    }
  }
  return out.sort((a, b) => a.taskId.localeCompare(b.taskId, 'en', { numeric: true }));
}
