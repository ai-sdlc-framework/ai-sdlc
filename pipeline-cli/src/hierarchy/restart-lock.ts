/**
 * Restart lock and restart-request file (AISDLC-1110).
 *
 * Any roster session (or the operator at a shell) may restart another session. Two callers
 * cannot race on one pane because `restart` takes a per-session lock file under the board
 * dir first; a second caller inside the lock window is refused with the holder's name.
 * A restart-request file asks the next dispatch tick to restart a session.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Seconds a restart lock holds after it is taken. */
export const RESTART_LOCK_WINDOW_MS = 120_000;

const LOCK_DIR = 'restart-locks';
const REQUEST_DIR = 'restart-requests';
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fileFor(boardDir: string, dir: string, name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`'${name}' is not a valid session name`);
  return path.join(boardDir, dir, `${name}.json`);
}

/**
 * Take the restart lock of `target` for `holder`.
 * @throws naming the current holder when another caller holds an unexpired lock.
 */
export function acquireRestartLock(
  boardDir: string,
  target: string,
  holder: string,
  now: Date,
  windowMs: number = RESTART_LOCK_WINDOW_MS,
): void {
  const file = fileFor(boardDir, LOCK_DIR, target);
  mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ holder, at: now.toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, body, { flag: 'wx' });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let cur: { holder?: string; at?: string } = {};
    try {
      cur = JSON.parse(readFileSync(file, 'utf-8')) as typeof cur;
    } catch {
      /* unreadable lock: treated as stale */
    }
    const at = cur.at ? Date.parse(cur.at) : Number.NaN;
    const live = !Number.isNaN(at) && now.getTime() - at < windowMs;
    if (live && cur.holder !== holder) {
      throw new Error(
        `refusing to restart '${target}': '${cur.holder ?? 'another caller'}' holds its restart lock (taken ${cur.at}); it clears after ${Math.round(windowMs / 1000)} s. Check cli-hierarchy status, then retry`,
      );
    }
    rmSync(file, { force: true });
  }
  throw new Error(`could not take the restart lock of '${target}'`);
}

/** A request for the next dispatch tick to restart `session`. */
export interface RestartRequest {
  session: string;
  by: string;
  at: string;
}

/** Write (replace) the request to restart `session`. */
export function writeRestartRequest(
  boardDir: string,
  session: string,
  by: string,
  now: Date,
): void {
  const file = fileFor(boardDir, REQUEST_DIR, session);
  mkdirSync(path.dirname(file), { recursive: true });
  const req: RestartRequest = { session, by, at: now.toISOString() };
  writeFileSync(file, JSON.stringify(req));
}

/** Read and remove every pending restart request, oldest name first. */
export function takeRestartRequests(boardDir: string): RestartRequest[] {
  const dir = path.join(boardDir, REQUEST_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: RestartRequest[] = [];
  for (const n of names.sort()) {
    const file = path.join(dir, n);
    try {
      const r = JSON.parse(readFileSync(file, 'utf-8')) as Partial<RestartRequest>;
      if (typeof r.session === 'string' && SAFE_NAME.test(r.session)) {
        out.push({ session: r.session, by: String(r.by ?? 'unknown'), at: String(r.at ?? '') });
      }
    } catch {
      /* a malformed request is dropped below */
    }
    rmSync(file, { force: true });
  }
  return out;
}
