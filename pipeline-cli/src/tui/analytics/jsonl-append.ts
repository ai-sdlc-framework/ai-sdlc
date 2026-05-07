/**
 * Shared best-effort JSONL appender for the operator-throughput writers
 * (RFC-0023 §10 / AISDLC-178.6).
 *
 * Mirrors the contract of `pipeline-cli/src/orchestrator/events.ts`:
 *   - creates parent dirs on demand,
 *   - swallows write errors (best-effort — never crashes the caller),
 *   - returns boolean for test observability.
 *
 * Centralised here so the three `_operator/*.jsonl` writers all behave
 * identically and the JSONL contract is one place to read.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { PipelineLogger } from '../../types.js';

export interface AppendJsonlOpts {
  /** Optional logger — surfaces best-effort write failures. */
  logger?: PipelineLogger;
  /** Logger tag prefix for the warning line. Defaults `[tui-analytics]`. */
  loggerTag?: string;
}

/**
 * Append one JSON-stringified record to `path` followed by a newline.
 * Returns true on success, false when the write threw (caller can ignore).
 */
export function appendJsonlRecord(
  path: string,
  record: Record<string, unknown>,
  opts: AppendJsonlOpts = {},
): boolean {
  const line = JSON.stringify(record) + '\n';
  try {
    if (!existsSync(dirname(path))) {
      mkdirSync(dirname(path), { recursive: true });
    }
    appendFileSync(path, line, { encoding: 'utf8' });
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const tag = opts.loggerTag ?? '[tui-analytics]';
    opts.logger?.warn(`${tag} write failed (path=${path}): ${reason}`);
    return false;
  }
}
