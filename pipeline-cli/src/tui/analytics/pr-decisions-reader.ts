/**
 * Reader for `_operator/pr-decisions.jsonl` (RFC-0023 §10 / AISDLC-178.6).
 *
 * Mirrors the contract of `decisions-reader.ts` — best-effort, file-order
 * read, malformed lines silently dropped, missing file is not an error.
 */

import { existsSync, readFileSync } from 'node:fs';

import { prDecisionsPath } from './paths.js';
import { classifyFsError } from '../sources/types.js';
import type { SourceErrorKind } from '../sources/types.js';
import type { PrDecisionRecord } from './pr-decisions-writer.js';

export interface ReadPrDecisionsOpts {
  artifactsDir?: string;
}

export interface ReadPrDecisionsResult {
  records: PrDecisionRecord[];
  error: SourceErrorKind | null;
}

function parseLine(line: string): PrDecisionRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<PrDecisionRecord>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.ts === 'string' &&
      typeof parsed.pr === 'number' &&
      typeof parsed.action === 'string'
    ) {
      return parsed as PrDecisionRecord;
    }
  } catch {
    // ignore
  }
  return null;
}

export function readPrDecisions(opts: ReadPrDecisionsOpts = {}): ReadPrDecisionsResult {
  const path = prDecisionsPath(opts.artifactsDir);
  if (!existsSync(path)) {
    return { records: [], error: null };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { records: [], error: classifyFsError(err) };
  }
  const records: PrDecisionRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const parsed = parseLine(line);
    if (parsed) records.push(parsed);
  }
  return { records, error: null };
}
