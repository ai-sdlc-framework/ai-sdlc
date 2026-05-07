/**
 * Reader for `_operator/decisions.jsonl` (RFC-0023 §10 / AISDLC-178.6).
 *
 * Read-side counterpart to `decisions-writer.ts`. The Analytics pane's
 * metric module consumes this. Best-effort: missing file → empty result;
 * malformed lines are skipped silently.
 */

import { existsSync, readFileSync } from 'node:fs';

import { decisionsPath } from './paths.js';
import { classifyFsError } from '../sources/types.js';
import type { SourceErrorKind } from '../sources/types.js';
import type { DecisionRecord } from './decisions-writer.js';

export interface ReadDecisionsOpts {
  /** Override the artifacts directory. */
  artifactsDir?: string;
}

export interface ReadDecisionsResult {
  records: DecisionRecord[];
  error: SourceErrorKind | null;
}

function parseLine(line: string): DecisionRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<DecisionRecord>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.ts === 'string' &&
      typeof parsed.taskId === 'string' &&
      typeof parsed.fromStatus === 'string' &&
      typeof parsed.toStatus === 'string'
    ) {
      return parsed as DecisionRecord;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Read every record on the decisions stream. Records are returned in
 * file order (oldest-first — append-only semantics).
 */
export function readDecisions(opts: ReadDecisionsOpts = {}): ReadDecisionsResult {
  const path = decisionsPath(opts.artifactsDir);
  if (!existsSync(path)) {
    // Missing file is normal pre-first-decision; surface as empty rather
    // than an alarming sentinel so the pane shows the "no data yet" state.
    return { records: [], error: null };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { records: [], error: classifyFsError(err) };
  }
  const records: DecisionRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const parsed = parseLine(line);
    if (parsed) records.push(parsed);
  }
  return { records, error: null };
}
