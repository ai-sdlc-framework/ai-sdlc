/**
 * Append-only monthly JSONL store for model-call records, with a dedup index
 * and ingester cursors. All mutations hold the directory lock, so appends are
 * line-atomic and dedup is exact across concurrent processes.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { validateModelCallRecord } from '../core/validation.js';
import { withUsageLock, writeFileAtomic } from './fs-lock.js';
import { isLedgerFile, ledgerFileForTs, resolveUsageDir } from './paths.js';
import type { AppendResult, ModelCallRecord, UsageStoreOptions } from './types.js';

const INDEX_IDS_FILE = 'dedup-ids.txt';
const INDEX_META_FILE = 'dedup-meta.json';
const CURSORS_FILE = 'cursors.json';

interface IndexMeta {
  version: 1;
  /** Ledger file name to the byte size the index was last consistent with. */
  sizes: Record<string, number>;
}

function listLedgerFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(isLedgerFile).sort();
}

function currentSizes(dir: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const f of listLedgerFiles(dir)) sizes[f] = statSync(join(dir, f)).size;
  return sizes;
}

function sameSizes(a: Record<string, number>, b: Record<string, number>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => a[k] === b[k]);
}

function readMeta(dir: string): IndexMeta | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, INDEX_META_FILE), 'utf-8')) as IndexMeta;
    if (parsed.version === 1 && parsed.sizes && typeof parsed.sizes === 'object') return parsed;
  } catch {
    // missing or corrupt: treated as inconsistent
  }
  return undefined;
}

function writeMeta(dir: string): void {
  const meta: IndexMeta = { version: 1, sizes: currentSizes(dir) };
  writeFileAtomic(join(dir, INDEX_META_FILE), JSON.stringify(meta));
}

/** Rebuild the dedup index from the ledger files. Caller holds the lock. */
function rebuildIndex(dir: string): Set<string> {
  const ids = new Set<string>();
  for (const f of listLedgerFiles(dir)) {
    for (const line of readFileSync(join(dir, f), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const id = (JSON.parse(line) as { callId?: unknown }).callId;
        if (typeof id === 'string' && id) ids.add(id);
      } catch {
        // skip a corrupt line; it cannot be deduplicated against
      }
    }
  }
  writeFileAtomic(join(dir, INDEX_IDS_FILE), [...ids].map((i) => `${i}\n`).join(''));
  writeMeta(dir);
  return ids;
}

/** Load the known-id set, rebuilding when the index is missing or out of step. Caller holds the lock. */
function loadKnownIds(dir: string): Set<string> {
  const meta = readMeta(dir);
  const idsPath = join(dir, INDEX_IDS_FILE);
  if (!meta || !existsSync(idsPath) || !sameSizes(meta.sizes, currentSizes(dir))) {
    return rebuildIndex(dir);
  }
  return new Set(
    readFileSync(idsPath, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0),
  );
}

/** Drop fields that must never be written for scope 'other'. */
function sanitize(record: ModelCallRecord): ModelCallRecord {
  if (record.scope !== 'other') return record;
  const { repo: _repo, taskId: _taskId, source: _source, ...rest } = record;
  return rest;
}

/**
 * Append records, skipping any whose `callId` is already in the ledger.
 * Each record lands in the month file of its own timestamp.
 */
export function appendModelCalls(
  records: ReadonlyArray<ModelCallRecord>,
  opts: UsageStoreOptions = {},
): AppendResult {
  const dir = resolveUsageDir(opts);
  const result: AppendResult = { written: 0, skipped: 0, invalid: 0 };
  if (records.length === 0) return result;

  return withUsageLock(dir, () => {
    const known = loadKnownIds(dir);
    const byFile = new Map<string, string[]>();
    const newIds: string[] = [];

    for (const raw of records) {
      if (!validateModelCallRecord(raw).valid) {
        result.invalid++;
        continue;
      }
      if (known.has(raw.callId)) {
        result.skipped++;
        continue;
      }
      known.add(raw.callId);
      newIds.push(raw.callId);
      const file = ledgerFileForTs(raw.ts);
      const lines = byFile.get(file) ?? [];
      lines.push(JSON.stringify(sanitize(raw)));
      byFile.set(file, lines);
      result.written++;
    }

    if (result.written === 0) return result;

    mkdirSync(dir, { recursive: true });
    for (const [file, lines] of byFile) {
      appendFileSync(join(dir, file), `${lines.join('\n')}\n`, 'utf-8');
    }
    appendFileSync(join(dir, INDEX_IDS_FILE), newIds.map((i) => `${i}\n`).join(''), 'utf-8');
    writeMeta(dir);
    return result;
  });
}

// ── Cursors ─────────────────────────────────────────────────────────

function readCursors(dir: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, CURSORS_FILE), 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
  } catch {
    // missing or corrupt: no cursors
  }
  return {};
}

/** Byte offset already ingested for `file`; 0 when none is recorded. */
export function readCursor(file: string, opts: UsageStoreOptions = {}): number {
  const v = readCursors(resolveUsageDir(opts))[file];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Record the byte offset ingested for `file`. */
export function writeCursor(file: string, offset: number, opts: UsageStoreOptions = {}): void {
  const dir = resolveUsageDir(opts);
  withUsageLock(dir, () => {
    const cursors = readCursors(dir);
    cursors[file] = offset;
    writeFileAtomic(join(dir, CURSORS_FILE), JSON.stringify(cursors));
  });
}
