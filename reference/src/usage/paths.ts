/**
 * Usage directory resolution and file naming.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageStoreOptions } from './types.js';

export const USAGE_DIR_ENV = 'AI_SDLC_USAGE_DIR';

/** Explicit option, then `AI_SDLC_USAGE_DIR`, then `<home>/.ai-sdlc/usage`. */
export function resolveUsageDir(opts: UsageStoreOptions = {}): string {
  if (opts.dir) return opts.dir;
  const fromEnv = process.env[USAGE_DIR_ENV];
  if (fromEnv) return fromEnv;
  return join(homedir(), '.ai-sdlc', 'usage');
}

const LEDGER_FILE_RE = /^ledger-(\d{4})-(\d{2})\.jsonl$/;

/** Month file name for an ISO timestamp, by the timestamp's own UTC month. */
export function ledgerFileForTs(ts: string): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  return `ledger-${y}-${m}.jsonl`;
}

export function isLedgerFile(name: string): boolean {
  return LEDGER_FILE_RE.test(name);
}

/** `YYYY-MM` of a ledger file name, or undefined when it is not one. */
export function ledgerFileMonth(name: string): string | undefined {
  const m = LEDGER_FILE_RE.exec(name);
  return m ? `${m[1]}-${m[2]}` : undefined;
}
