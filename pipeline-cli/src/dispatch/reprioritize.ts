/**
 * `cli-dispatch reprioritize` (AISDLC-904): change the priority of a queued task and
 * optionally attach a fresh resume note, without hand-editing board files.
 */

import { now } from '../clock.js';
import { readQueuedManifest, updateQueuedManifest } from './board.js';
import { normaliseNote } from './resume.js';
import type { ResumeFeedback } from './types.js';

export interface ReprioritizeOptions {
  priority: number;
  /** Replaces `resume.note` (validated like a resume note). */
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
  if (opts.note !== undefined) {
    const note = normaliseNote(opts.note);
    const existing = readQueuedManifest(boardDir, taskId)?.resume;
    resume = existing
      ? { ...existing, note }
      : { note, resumedAt: now().toISOString(), resumedBy: opts.by ?? 'reprioritize' };
  }
  return updateQueuedManifest(boardDir, taskId, {
    priority: opts.priority,
    ...(resume ? { resume } : {}),
  });
}
