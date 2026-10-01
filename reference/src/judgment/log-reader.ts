/**
 * Reader for the JSONL judgment log written by `createJudgmentLogSink`:
 * `<artifactsDir>/_judgment/log-YYYY-MM-DD.jsonl`. Tolerant by design: a
 * malformed line, an oversized file or a symlinked file is skipped and counted,
 * never an error.
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JudgmentOutcome, Thresholds } from './definition.js';
import type { JudgmentAnswer } from './types.js';

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const LOG_FILE_RE = /^log-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** One parsed log line. `incumbent` is null when the caller recorded none. */
export interface JudgmentLogEntry {
  ts: string;
  judgmentId: string;
  version: number | null;
  provider: string | null;
  modelVersion: string | null;
  configuredMode: string | null;
  effectiveMode: string | null;
  answers: Record<string, JudgmentAnswer> | null;
  thresholds: Thresholds | null;
  outcome: JudgmentOutcome<unknown> | null;
  incumbent: unknown;
  latencyMs: number | null;
  cacheHit: boolean;
}

export interface ReadJudgmentLogOptions {
  /** Keep only records at or after this instant. */
  since?: Date;
  /** Keep only records of this judgment. */
  judgmentId?: string;
  /** Skip files larger than this. Default 64 MiB. */
  maxFileBytes?: number;
}

export interface ReadJudgmentLogResult {
  entries: JudgmentLogEntry[];
  malformedLines: number;
  /** Log files not read (symlink, oversized or unreadable). */
  skippedFiles: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseEntry(line: string): JudgmentLogEntry | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(raw)) return undefined;
  if (typeof raw.ts !== 'string' || Number.isNaN(Date.parse(raw.ts))) return undefined;
  if (typeof raw.judgmentId !== 'string' || raw.judgmentId === '') return undefined;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const outcome =
    isObject(raw.outcome) && typeof raw.outcome.kind === 'string'
      ? (raw.outcome as unknown as JudgmentOutcome<unknown>)
      : null;
  return {
    ts: raw.ts,
    judgmentId: raw.judgmentId,
    version: typeof raw.version === 'number' ? raw.version : null,
    provider: str(raw.provider),
    modelVersion: str(raw.modelVersion),
    configuredMode: str(raw.configuredMode),
    effectiveMode: str(raw.effectiveMode),
    answers: isObject(raw.answers) ? (raw.answers as Record<string, JudgmentAnswer>) : null,
    thresholds: isObject(raw.thresholds) ? (raw.thresholds as Thresholds) : null,
    outcome,
    incumbent: raw.incumbent ?? null,
    latencyMs: typeof raw.latencyMs === 'number' ? raw.latencyMs : null,
    cacheHit: raw.cacheHit === true,
  };
}

/** Read judgment log records, oldest file first. Never throws. */
export function readJudgmentLog(
  artifactsDir: string,
  opts: ReadJudgmentLogOptions = {},
): ReadJudgmentLogResult {
  const result: ReadJudgmentLogResult = { entries: [], malformedLines: 0, skippedFiles: [] };
  const dir = join(artifactsDir, '_judgment');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return result;
  }
  const sinceYmd =
    opts.since && !Number.isNaN(opts.since.getTime())
      ? opts.since.toISOString().slice(0, 10)
      : undefined;
  const sinceMs = opts.since?.getTime();
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const files = names
    .map((name) => ({ name, m: LOG_FILE_RE.exec(name) }))
    .filter((f): f is { name: string; m: RegExpExecArray } => f.m !== null)
    .filter((f) => !sinceYmd || f.m[1] >= sinceYmd)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const { name } of files) {
    const path = join(dir, name);
    let text: string;
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size > maxBytes) {
        result.skippedFiles.push(name);
        continue;
      }
      text = readFileSync(path, 'utf8');
    } catch {
      result.skippedFiles.push(name);
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const entry = parseEntry(line);
      if (!entry) {
        result.malformedLines += 1;
        continue;
      }
      if (sinceMs !== undefined && Date.parse(entry.ts) < sinceMs) continue;
      if (opts.judgmentId && entry.judgmentId !== opts.judgmentId) continue;
      result.entries.push(entry);
    }
  }
  return result;
}
