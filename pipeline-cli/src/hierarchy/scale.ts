/**
 * The runtime executor ceiling (AISDLC-1083): `<board>/scale.json`, set by
 * `cli-hierarchy scale --max N --reason <text>` and removed by `scale --clear`.
 *
 * It can only tighten: a value above the configured `executors.max` is refused, so the
 * ceiling never raises the cap. Every set and clear is appended to `scale-events.jsonl`.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Filename of the ceiling under the board directory. */
export const SCALE_FILENAME = 'scale.json';
/** Filename of the append-only log of ceiling changes. */
export const SCALE_LOG_FILENAME = 'scale-events.jsonl';

export interface ScaleCeiling {
  max: number;
  reason: string;
  since: string;
  by: string;
}

/** The active ceiling, or null. A malformed file is ignored (it can only ever tighten). */
export function readScaleCeiling(boardDir: string): ScaleCeiling | null {
  const file = path.join(boardDir, SCALE_FILENAME);
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ScaleCeiling>;
    if (typeof doc.max !== 'number' || !Number.isInteger(doc.max) || doc.max < 1) return null;
    return {
      max: doc.max,
      reason: typeof doc.reason === 'string' ? doc.reason : '',
      since: typeof doc.since === 'string' ? doc.since : '',
      by: typeof doc.by === 'string' ? doc.by : '',
    };
  } catch {
    return null;
  }
}

function logEvent(boardDir: string, event: Record<string, unknown>): void {
  appendFileSync(path.join(boardDir, SCALE_LOG_FILENAME), JSON.stringify(event) + '\n', 'utf-8');
}

/** Set the ceiling (replacing any earlier one) and log it. */
export function writeScaleCeiling(boardDir: string, c: ScaleCeiling): void {
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(path.join(boardDir, SCALE_FILENAME), JSON.stringify(c, null, 2) + '\n', 'utf-8');
  logEvent(boardDir, { event: 'scale', ...c });
}

/** Remove the ceiling; returns the one lifted, or null when there was none. */
export function clearScaleCeiling(boardDir: string, by: string, at: string): ScaleCeiling | null {
  const was = readScaleCeiling(boardDir);
  rmSync(path.join(boardDir, SCALE_FILENAME), { force: true });
  if (was) logEvent(boardDir, { event: 'scale-clear', by, at, max: was.max });
  return was;
}
