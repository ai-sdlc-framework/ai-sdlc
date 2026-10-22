/**
 * `cli-dispatch reprioritize` (AISDLC-904): change the priority of a queued task and
 * optionally attach a note, without hand-editing board files.
 *
 * AISDLC-1015: a note is audit metadata and never changes how the task executes. It updates
 * `resume.note` only when the manifest already carries a resume block; otherwise it lands in
 * `reorderNote`. A `resume` block means "a previous attempt left a branch" and is never fabricated.
 */

import { readQueuedManifest, updateQueuedManifest } from './board.js';
import { normaliseNote } from './resume.js';
import type { ResumeFeedback } from './types.js';

export interface ReprioritizeOptions {
  priority: number;
  /** Replaces `resume.note` when a resume block exists, else sets `reorderNote` (validated like a resume note). */
  note?: string;
  /** Who made the change (audit only). */
  by?: string;
}

/** Rewrite `priority` (and `resume.note` when given) on `queue/<taskId>.dispatch.json`. */
export function reprioritizeQueued(
  boardDir: string,
  taskId: string,
  opts: ReprioritizeOptions,
): string {
  if (!Number.isFinite(opts.priority)) {
    throw new Error('reprioritize: --priority must be a finite number');
  }
  let resume: ResumeFeedback | undefined;
  let reorderNote: string | undefined;
  if (opts.note !== undefined) {
    const note = normaliseNote(opts.note);
    const existing = readQueuedManifest(boardDir, taskId)?.resume;
    if (existing) resume = { ...existing, note };
    else reorderNote = note;
  }
  return updateQueuedManifest(boardDir, taskId, {
    priority: opts.priority,
    ...(resume ? { resume } : {}),
    ...(reorderNote !== undefined ? { reorderNote } : {}),
  });
}
