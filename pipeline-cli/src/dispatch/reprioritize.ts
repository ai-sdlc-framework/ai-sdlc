/**
 * `cli-dispatch reprioritize` (AISDLC-904): change the priority of a queued task and
 * optionally attach a note, without hand-editing board files.
 *
 * AISDLC-1015/1047: a note is audit metadata and never changes how the task executes. It always
 * lands in `reorderNote`; `resume` (owned by the reconciler and the reenter path) is never written,
 * so an audit note cannot overwrite an execution instruction.
 */

import { dependenciesOfTaskFile } from './enqueue.js';
import { readQueuedManifest, repoRootOfBoard, updateQueuedManifest } from './board.js';
import { normaliseNote } from './resume.js';

export interface ReprioritizeOptions {
  priority: number;
  /** Audit note stored in `reorderNote` only (validated like a resume note); never touches `resume`. */
  note?: string;
  /** Who made the change (audit only). */
  by?: string;
}

/** Rewrite `priority` (and `reorderNote` when given) on `queue/<taskId>.dispatch.json`. */
export function reprioritizeQueued(
  boardDir: string,
  taskId: string,
  opts: ReprioritizeOptions,
): string {
  if (!Number.isFinite(opts.priority)) {
    throw new Error('reprioritize: --priority must be a finite number');
  }
  const reorderNote = opts.note !== undefined ? normaliseNote(opts.note) : undefined;
  const queued = readQueuedManifest(boardDir, taskId);
  const derived =
    queued && (!queued.after || queued.after.length === 0)
      ? dependenciesOfTaskFile(repoRootOfBoard(boardDir), queued.spec.taskFile)
      : [];
  return updateQueuedManifest(boardDir, taskId, {
    priority: opts.priority,
    ...(derived.length > 0 ? { after: derived } : {}),
    ...(reorderNote !== undefined ? { reorderNote } : {}),
  });
}
