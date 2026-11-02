/**
 * Rotate-request marker (AISDLC-1150).
 *
 * When dispatch asks a session's hooks module to rotate (write its handoff, store the last
 * reply and clear), it records the request here so `cli-hierarchy status` can show a rotation
 * that is waiting on a long turn. The module consumes the request itself; the marker is
 * removed by dispatch once the session is back under its threshold.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DIR = 'rotate-requests';
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fileFor(boardDir: string, name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`'${name}' is not a valid session name`);
  return path.join(boardDir, DIR, `${name}.json`);
}

/** Record that a rotate was requested of `session` at `now`. */
export function writeRotateRequest(boardDir: string, session: string, now: Date): void {
  const file = fileFor(boardDir, session);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ session, at: now.toISOString() }));
}

/** Drop the marker of `session`. */
export function clearRotateRequest(boardDir: string, session: string): void {
  rmSync(fileFor(boardDir, session), { force: true });
}

/** Pending rotate requests by session, with the ISO time each was made. */
export function readRotateRequests(boardDir: string): Record<string, string> {
  const dir = path.join(boardDir, DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const n of names) {
    try {
      const r = JSON.parse(readFileSync(path.join(dir, n), 'utf-8')) as {
        session?: unknown;
        at?: unknown;
      };
      if (typeof r.session === 'string' && typeof r.at === 'string') out[r.session] = r.at;
    } catch {
      /* an unreadable marker contributes nothing */
    }
  }
  return out;
}
