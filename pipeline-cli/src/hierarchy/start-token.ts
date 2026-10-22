/**
 * Start tokens (AISDLC-1028): `cli-hierarchy clear` types the executor command into the
 * pane, so the start has no harness message envelope. The clear instead leaves a
 * token naming the issuing dispatch session; `executor-start` verifies it when it is given
 * no sender flag, and it stays verified for re-issued starts until the next clear or a claim.
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
  /** Set by the first verified start; later starts of that session are accepted at any age. */
  verifiedAt?: string;
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
 * Verify the token without consuming it. True when it names `dispatchPid` and either was
 * already verified (a later start of the same session, accepted at any age) or is at most
 * {@link START_TOKEN_MAX_AGE_MS} old, in which case `verifiedAt` is recorded in the file.
 * `clear` overwrites the file, so a new session never inherits an earlier verification.
 */
export function verifyStartToken(
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
  if (dispatchPid === undefined || token.issuerPid !== dispatchPid) return false;
  if (Number.isFinite(Date.parse(String(token.verifiedAt ?? '')))) return true;
  const issued = Date.parse(String(token.issuedAt ?? ''));
  if (!Number.isFinite(issued) || nowMs - issued < 0 || nowMs - issued > START_TOKEN_MAX_AGE_MS) {
    return false;
  }
  writeFileSync(
    file,
    `${JSON.stringify({ ...token, verifiedAt: new Date(nowMs).toISOString() })}\n`,
    'utf-8',
  );
  return true;
}

/** Remove the token: a claimed task is the authority from then on. */
export function clearStartToken(boardDir: string, executor: string): void {
  rmSync(tokenPath(boardDir, executor), { force: true });
}
