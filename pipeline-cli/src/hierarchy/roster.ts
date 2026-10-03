/**
 * Roster file I/O for the session hierarchy.
 *
 * The roster lives at `<boardDir>/hierarchy.json`. Writes are atomic
 * (temp file + rename) and validated against the roster schema.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { validateHierarchyRoster } from '@ai-sdlc/reference';

import { HIERARCHY_TMUX_SESSION, type Roster, type RosterEntry } from './types.js';
import { isValidSessionName, roleOfDefaultName } from './validate.js';

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
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(roster, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
  renameSync(tmp, target);
  return target;
}

/** Roster entries that are safe to act on, plus a message for each one that is not. */
export interface CheckedRoster {
  roster: Roster;
  rejected: string[];
}

/** True for an entry written by the old layout (a window in the shared hierarchy session). */
export function isLegacyLayoutEntry(entry: RosterEntry): boolean {
  return entry.tmuxSession === HIERARCHY_TMUX_SESSION;
}

/**
 * Why a roster entry must never be acted on, or undefined when it is safe.
 *
 * An entry is safe only when it names a tmux target this tool could have created:
 * either a valid window of the legacy `ai-sdlc-hierarchy` session, or a session
 * named exactly like its window and equal to a default hierarchy name (`planner`,
 * `operator-dispatch`, `executor-alpha`..`executor-epsilon`). A hostile or corrupt
 * roster can therefore never make `down` or `brief --notify` act on another session.
 */
export function unsafeEntryReason(entry: RosterEntry): string | undefined {
  if (typeof entry.tmuxWindow !== 'string' || !isValidSessionName(entry.tmuxWindow)) {
    return `has an invalid tmux window '${String(entry.tmuxWindow)}'`;
  }
  if (!isLegacyLayoutEntry(entry)) {
    if (entry.tmuxSession !== entry.tmuxWindow) {
      return `names tmux session '${String(entry.tmuxSession)}', which is neither '${HIERARCHY_TMUX_SESSION}' nor the session named after window '${entry.tmuxWindow}'`;
    }
    if (roleOfDefaultName(entry.tmuxSession) === undefined) {
      return `names tmux session '${entry.tmuxSession}', which is not one of the default hierarchy session names`;
    }
  }
  if (typeof entry.paneId !== 'string' || !/^(%[0-9]+)?$/.test(entry.paneId)) {
    return `has an invalid pane id '${String(entry.paneId)}'`;
  }
  return undefined;
}

/**
 * Read the roster, keeping only entries that pass validation. Entries that fail
 * the schema or name a tmux target outside the hierarchy session are returned
 * as `rejected` messages and are never acted on.
 * @throws when the file is not valid JSON or its envelope is malformed.
 */
export function readRosterChecked(boardDir: string): CheckedRoster {
  const file = rosterPath(boardDir);
  if (!existsSync(file)) return { roster: emptyRoster(), rejected: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`roster ${file} is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const doc = parsed as { schemaVersion?: unknown; sessions?: unknown };
  if (doc?.schemaVersion !== 'v1' || !Array.isArray(doc.sessions)) {
    throw new Error(
      `roster ${file} does not match the roster schema: bad schemaVersion or sessions`,
    );
  }
  const sessions: RosterEntry[] = [];
  const rejected: string[] = [];
  doc.sessions.forEach((raw: unknown, i: number) => {
    const label = `roster entry #${i + 1}`;
    const result = validateHierarchyRoster<Roster>({ schemaVersion: 'v1', sessions: [raw] });
    if (!result.valid) {
      const detail = (result.errors ?? []).map((e) => `${e.path} ${e.message}`).join('; ');
      rejected.push(`${label} ignored, it does not match the roster schema: ${detail}`);
      return;
    }
    const entry = raw as RosterEntry;
    const reason = unsafeEntryReason(entry);
    if (reason) {
      rejected.push(`${label} ('${entry.name}') ignored, it ${reason}`);
      return;
    }
    sessions.push(entry);
  });
  return { roster: { schemaVersion: 'v1', sessions }, rejected };
}
