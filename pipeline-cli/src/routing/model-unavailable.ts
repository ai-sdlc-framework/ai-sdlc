/**
 * Model-unavailable markers (AISDLC-1364): a model the account cannot use until a reset time,
 * for example after "You've hit your Fable limit". The marker is a small JSON file on the
 * dispatch board; routing reads it to pick the next weaker model in `strength` order. A marker
 * past its `until` time is ignored, so the model is used again with no cleanup step.
 *
 * @module routing/model-unavailable
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ModelMarker {
  model: string;
  /** ISO time the model is usable again. */
  until: string;
  reason: string;
}

export const MODEL_MARKER_FILE = 'model-unavailable.json';

function readAll(dir: string): ModelMarker[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dir, MODEL_MARKER_FILE), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ModelMarker =>
        !!m &&
        typeof m.model === 'string' &&
        typeof m.until === 'string' &&
        typeof m.reason === 'string',
    );
  } catch {
    return [];
  }
}

/** True when `m` is still in force at `now`. An unparseable `until` is not in force. */
export function markerActive(m: ModelMarker, now: Date): boolean {
  const t = Date.parse(m.until);
  return Number.isFinite(t) && t > now.getTime();
}

/** The markers in `dir` that are in force at `now`. Unreadable files read as none. */
export function readActiveMarkers(dir: string, now: Date): ModelMarker[] {
  return readAll(dir).filter((m) => markerActive(m, now));
}

function writeAll(dir: string, markers: ModelMarker[]): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, MODEL_MARKER_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(markers, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Record `marker`, replacing any earlier marker for the same model. */
export function writeModelMarker(dir: string, marker: ModelMarker): void {
  writeAll(dir, [...readAll(dir).filter((m) => m.model !== marker.model), marker]);
}

/** Remove the marker for `model`; returns whether one existed. */
export function clearModelMarker(dir: string, model: string): boolean {
  const all = readAll(dir);
  const rest = all.filter((m) => m.model !== model);
  if (rest.length === all.length) return false;
  writeAll(dir, rest);
  return true;
}
