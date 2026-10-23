/**
 * Rotate request for the model-less dispatch host (RFC-0058 phase 2, AISDLC-1035).
 *
 * The dispatch session no longer types `/clear` into its own pane. `cli-hierarchy clear --self`
 * for the dispatch role writes this request file under the board; the hierarchy hooks module
 * reads it on its next tick or event and rotates (handoff, clear) through the host, the same
 * way it rotates at 120k tokens.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Where the rotate request of the named dispatch session is written. */
export function rotateRequestPath(boardDir: string, name: string): string {
  return path.join(boardDir, 'handoff', `rotate-request-${name}.json`);
}

/** Write the rotate request; returns the file path. The hooks module consumes and deletes it. */
export function requestDispatchRotate(boardDir: string, name: string, now: Date): string {
  const file = rotateRequestPath(boardDir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ kind: 'rotate', name, requestedAt: now.toISOString() }) + '\n',
    'utf-8',
  );
  return file;
}

/** True when any rotate request is pending; the requests are deleted, so one request rotates once. */
export function consumeRotateRequests(boardDir: string): boolean {
  const dir = path.join(boardDir, 'handoff');
  if (!existsSync(dir)) return false;
  const files = readdirSync(dir).filter((f) => /^rotate-request-.+\.json$/.test(f));
  for (const f of files) rmSync(path.join(dir, f), { force: true });
  return files.length > 0;
}
