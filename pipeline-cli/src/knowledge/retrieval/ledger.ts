/**
 * Per-session load ledger (RFC-0053): which entries (id + contentHash) were already
 * injected into a session. Stored at `.ai-sdlc/context/sessions/<session-id>.jsonl`.
 *
 * One row per injection: `{id, contentHash, tokens, at, moment}`; a re-injection of an entry
 * whose hash changed also carries `supersedes: <old hash>`. CLAUDE.md and the memory index are
 * pre-marked (`kind: premark`) so no knowledge entry sourced from them is ever re-injected.
 * Appends and rewrites hold a cross-process lock so concurrent hooks cannot corrupt the file.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { now as clockNow } from '../../clock.js';
import { withFileLock } from '../../estimation/fs-lock.js';
import { loadKey, type QueryHit } from './types.js';

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Files already in every session's context; project-relative. */
export const PREMARKED_FILES = ['CLAUDE.md', '.claude/memory/MEMORY.md'] as const;

export interface LedgerRow {
  kind?: 'load' | 'premark';
  id: string;
  contentHash: string;
  tokens: number;
  at: string;
  moment: string;
  /** Hash of the earlier version of this entry that this injection supersedes. */
  supersedes?: string;
  /** Project-relative source path (premark rows only). */
  source?: string;
}

function ledgerFile(projectRoot: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error(`invalid session id '${sessionId}' (allowed: letters, digits, '.', '_', '-')`);
  }
  return join(projectRoot, '.ai-sdlc', 'context', 'sessions', `${sessionId}.jsonl`);
}

export function readLedger(projectRoot: string, sessionId: string): LedgerRow[] {
  const file = ledgerFile(projectRoot, sessionId);
  if (!existsSync(file)) return [];
  const rows: LedgerRow[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as LedgerRow;
      if (rec.id && rec.contentHash) rows.push(rec);
    } catch {
      // a torn line is ignored; the entry becomes eligible again
    }
  }
  return rows;
}

export function loadedKeys(projectRoot: string, sessionId: string): Set<string> {
  return new Set(readLedger(projectRoot, sessionId).map((r) => loadKey(r.id, r.contentHash)));
}

/** Project-relative sources pre-marked as loaded in this session. */
export function loadedSources(projectRoot: string, sessionId: string): Set<string> {
  const out = new Set<string>();
  for (const r of readLedger(projectRoot, sessionId)) if (r.source) out.add(r.source);
  return out;
}

function premarkRows(projectRoot: string, now: Date): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const rel of PREMARKED_FILES) {
    const abs = join(projectRoot, rel);
    if (!existsSync(abs)) continue;
    rows.push({
      kind: 'premark',
      id: rel,
      contentHash: createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16),
      tokens: 0,
      at: now.toISOString(),
      moment: 'premark',
      source: rel,
    });
  }
  return rows;
}

const serialize = (rows: LedgerRow[]): string =>
  rows.length === 0 ? '' : `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

function locked<T>(file: string, fn: () => T): T {
  mkdirSync(join(file, '..'), { recursive: true });
  return withFileLock(file, fn);
}

function rewrite(file: string, rows: LedgerRow[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, serialize(rows));
  renameSync(tmp, file);
}

/** Create the ledger with the pre-marked rows when the session has none yet. */
export function ensureLedger(projectRoot: string, sessionId: string, now: Date = clockNow()): void {
  const file = ledgerFile(projectRoot, sessionId);
  if (existsSync(file)) return;
  locked(file, () => {
    if (!existsSync(file)) rewrite(file, premarkRows(projectRoot, now));
  });
}

/** `/clear`: drop everything loaded; only the pre-marked entries remain. */
export function resetLedger(projectRoot: string, sessionId: string, now: Date = clockNow()): void {
  const file = ledgerFile(projectRoot, sessionId);
  locked(file, () => rewrite(file, premarkRows(projectRoot, now)));
}

/**
 * `PreCompact`: keep the rows whose entry survives in the compaction summary, drop the rest so
 * they are eligible again. Pre-marked rows always stay.
 */
export function compactLedger(
  projectRoot: string,
  sessionId: string,
  survives: (row: LedgerRow) => boolean,
  now: Date = clockNow(),
): { kept: number; dropped: number } {
  const file = ledgerFile(projectRoot, sessionId);
  return locked(file, () => {
    const rows = readLedger(projectRoot, sessionId).filter((r) => r.kind !== 'premark');
    const kept = rows.filter(survives);
    rewrite(file, [...premarkRows(projectRoot, now), ...kept]);
    return { kept: kept.length, dropped: rows.length - kept.length };
  });
}

export function recordLoaded(
  projectRoot: string,
  sessionId: string,
  hits: QueryHit[],
  opts: { moment?: string; now?: Date } = {},
): void {
  if (hits.length === 0) return;
  const file = ledgerFile(projectRoot, sessionId);
  const at = (opts.now ?? clockNow()).toISOString();
  locked(file, () => {
    const latest = new Map<string, string>();
    for (const r of readLedger(projectRoot, sessionId)) latest.set(r.id, r.contentHash);
    const rows = hits.map((h): LedgerRow => {
      const prior = latest.get(h.id);
      return {
        kind: 'load',
        id: h.id,
        contentHash: h.contentHash,
        tokens: h.tokens,
        at,
        moment: opts.moment ?? 'query',
        ...(prior && prior !== h.contentHash ? { supersedes: prior } : {}),
      };
    });
    appendFileSync(file, serialize(rows));
  });
}
