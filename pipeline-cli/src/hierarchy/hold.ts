/**
 * The hold (AISDLC-899): a board state that pauses actions, never reporting.
 *
 * `cli-hierarchy hold --reason <text>` writes `<board>/.hold`; `cli-hierarchy resume`
 * removes it. While it exists `tick` still ingests, watches verdicts, classifies PRs
 * and returns reports and escalations, but it does not clear or relaunch executors,
 * re-queue failures or reap stalled claims, and `executor-start` does not claim.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { now } from '../clock.js';

/** Filename of the hold flag under the board directory. */
export const HOLD_FILENAME = '.hold';
/** Filename of the append-only log of holds and resumes. */
export const HOLD_LOG_FILENAME = 'hold-events.jsonl';

/** The flag's content. */
export interface Hold {
  reason: string;
  since: string;
  by: string;
}

/** Path of the hold flag. */
export function holdPath(boardDir: string): string {
  return path.join(boardDir, HOLD_FILENAME);
}

/**
 * The active hold, or null when the board is not held. A flag file that exists
 * but cannot be read fails closed: the board stays held until the file is fixed
 * or removed.
 */
export function readHold(boardDir: string): Hold | null {
  if (!existsSync(holdPath(boardDir))) return null;
  try {
    const doc = JSON.parse(readFileSync(holdPath(boardDir), 'utf-8')) as Partial<Hold>;
    if (typeof doc.reason !== 'string' || doc.reason === '') throw new Error('no reason');
    return {
      reason: doc.reason,
      since: typeof doc.since === 'string' ? doc.since : '',
      by: typeof doc.by === 'string' ? doc.by : '',
    };
  } catch {
    return { reason: 'the hold flag is unreadable; fix or remove it', since: '', by: 'unresolved' };
  }
}

/** Append an event to the hold log. */
export function appendHoldEvent(boardDir: string, event: Record<string, unknown>): void {
  appendFileSync(path.join(boardDir, HOLD_LOG_FILENAME), JSON.stringify(event) + '\n', 'utf-8');
}

/** Set the hold (replacing any earlier one) and log it. */
export function writeHold(boardDir: string, hold: Hold): void {
  mkdirSync(boardDir, { recursive: true });
  const target = holdPath(boardDir);
  const tmp = `${target}.tmp-${process.pid}-${now().getTime()}`;
  writeFileSync(tmp, JSON.stringify(hold, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
  appendHoldEvent(boardDir, { event: 'hold', ...hold });
}

/** Remove the hold; returns the hold that was lifted, or null when there was none. */
export function clearHold(boardDir: string, by: string, at: string): Hold | null {
  const held = readHold(boardDir);
  rmSync(holdPath(boardDir), { force: true });
  if (held) appendHoldEvent(boardDir, { event: 'resume', by, at, reason: held.reason });
  return held;
}
