/**
 * Start tokens (AISDLC-1028): `cli-hierarchy clear` types the executor command into the
 * pane, so the start has no harness message envelope. The clear instead leaves a
 * single-use token naming the issuing dispatch session; `executor-start` consumes it
 * when it is given no sender flag.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Longest age of a token that still proves a start. */
export const START_TOKEN_MAX_AGE_MS = 30 * 60 * 1000;

/** What a token carries. */
export interface StartToken {
  issuerPid: number;
  issuerName: string;
  issuedAt: string;
}

function tokenPath(boardDir: string, executor: string): string {
  return path.join(boardDir, 'starts', `${executor}.json`);
}

/** Write the token for `executor`; replaces any earlier one. */
export function writeStartToken(boardDir: string, executor: string, token: StartToken): void {
  mkdirSync(path.join(boardDir, 'starts'), { recursive: true });
  writeFileSync(tokenPath(boardDir, executor), `${JSON.stringify(token)}\n`, 'utf-8');
}

/**
 * Consume the token: it is deleted whether or not it is valid (single use). True only
 * when it names `dispatchPid` and is at most {@link START_TOKEN_MAX_AGE_MS} old.
 */
export function consumeStartToken(
  boardDir: string,
  executor: string,
  dispatchPid: number | undefined,
  nowMs: number,
): boolean {
  const file = tokenPath(boardDir, executor);
  if (!existsSync(file)) return false;
  let token: Partial<StartToken> = {};
  try {
    token = JSON.parse(readFileSync(file, 'utf-8')) as Partial<StartToken>;
  } catch {
    // an unreadable token proves nothing
  }
  rmSync(file, { force: true });
  const issued = Date.parse(String(token.issuedAt ?? ''));
  return (
    dispatchPid !== undefined &&
    token.issuerPid === dispatchPid &&
    Number.isFinite(issued) &&
    nowMs - issued >= 0 &&
    nowMs - issued <= START_TOKEN_MAX_AGE_MS
  );
}
