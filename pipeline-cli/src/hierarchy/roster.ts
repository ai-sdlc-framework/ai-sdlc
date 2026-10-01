/**
 * Roster file I/O for the session hierarchy.
 *
 * The roster lives at `<boardDir>/hierarchy.json`. Writes are atomic
 * (temp file + rename) and validated against the roster schema.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { validateHierarchyRoster } from '@ai-sdlc/reference';

import type { Roster } from './types.js';

/** Roster filename under the dispatch board directory. */
export const ROSTER_FILENAME = 'hierarchy.json';

/** Full path of the roster for a board directory. */
export function rosterPath(boardDir: string): string {
  return path.join(boardDir, ROSTER_FILENAME);
}

/** An empty roster. */
export function emptyRoster(): Roster {
  return { schemaVersion: 'v1', sessions: [] };
}

/**
 * Read the roster. A missing file yields an empty roster.
 * @throws when the file exists but is not valid JSON or fails schema validation.
 */
export function readRoster(boardDir: string): Roster {
  const file = rosterPath(boardDir);
  if (!existsSync(file)) return emptyRoster();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`roster ${file} is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const result = validateHierarchyRoster<Roster>(parsed);
  if (!result.valid) {
    const detail = (result.errors ?? []).map((e) => `${e.path} ${e.message}`).join('; ');
    throw new Error(`roster ${file} does not match the roster schema: ${detail}`);
  }
  return parsed as Roster;
}

/**
 * Validate and atomically write the roster.
 * @throws when the roster does not match the schema (nothing is written).
 */
export function writeRoster(boardDir: string, roster: Roster): string {
  const result = validateHierarchyRoster(roster);
  if (!result.valid) {
    const detail = (result.errors ?? []).map((e) => `${e.path} ${e.message}`).join('; ');
    throw new Error(`refusing to write an invalid roster: ${detail}`);
  }
  mkdirSync(boardDir, { recursive: true });
  const target = rosterPath(boardDir);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(roster, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
  return target;
}
