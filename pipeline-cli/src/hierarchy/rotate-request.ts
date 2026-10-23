/**
 * Rotate requests (RFC-0058 phases 2 and 4, AISDLC-1035, AISDLC-1037).
 *
 * `cli-hierarchy clear <name>` (and `clear --self` from the dispatch session) writes one request file
 * per session under the board. The dispatch session's hooks module reads them on its next tick through
 * `cli-hierarchy rotate-pending`: a request naming the host rotates the host; any other request is
 * delivered to the named session with `$.session.send`, whose module runs its own rotation. The file
 * is deleted as it is consumed, so one request rotates once and its disappearance is the acknowledgement.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REQUEST_RE = /^rotate-request-(.+)\.json$/;

/** Where the rotate request of the named session is written. */
export function rotateRequestPath(boardDir: string, name: string): string {
  return path.join(boardDir, 'handoff', `rotate-request-${name}.json`);
}

/** Write the rotate request; returns the file path. The dispatch host consumes and deletes it. */
export function requestRotate(boardDir: string, name: string, now: Date): string {
  const file = rotateRequestPath(boardDir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ kind: 'rotate', name, requestedAt: now.toISOString() }) + '\n',
    'utf-8',
  );
  return file;
}

/** What one consumption found: whether the host itself must rotate, and which other sessions to tell. */
export interface RotateRequests {
  self: boolean;
  forward: string[];
}

/**
 * Consume every pending request. A request is the host's own when its name is in `hostNames`;
 * the others are returned for forwarding. All request files are deleted.
 */
export function consumeRotateRequests(
  boardDir: string,
  hostNames: readonly string[],
): RotateRequests {
  const dir = path.join(boardDir, 'handoff');
  const out: RotateRequests = { self: false, forward: [] };
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const name = REQUEST_RE.exec(f)?.[1];
    if (name === undefined) continue;
    rmSync(path.join(dir, f), { force: true });
    if (hostNames.includes(name)) out.self = true;
    else out.forward.push(name);
  }
  return out;
}
