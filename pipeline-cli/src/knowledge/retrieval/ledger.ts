/**
 * Per-session load ledger (RFC-0053): which entries (id + contentHash) were already
 * injected into a session. Stored at `.ai-sdlc/context/sessions/<session-id>.jsonl`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { now as clockNow } from '../../clock.js';
import { loadKey, type QueryHit } from './types.js';

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

function ledgerFile(projectRoot: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error(`invalid session id '${sessionId}' (allowed: letters, digits, '.', '_', '-')`);
  }
  return join(projectRoot, '.ai-sdlc', 'context', 'sessions', `${sessionId}.jsonl`);
}

export function loadedKeys(projectRoot: string, sessionId: string): Set<string> {
  const file = ledgerFile(projectRoot, sessionId);
  const keys = new Set<string>();
  if (!existsSync(file)) return keys;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { id?: string; contentHash?: string };
      if (rec.id && rec.contentHash) keys.add(loadKey(rec.id, rec.contentHash));
    } catch {
      // a torn line is ignored; the entry becomes eligible again
    }
  }
  return keys;
}

export function recordLoaded(
  projectRoot: string,
  sessionId: string,
  hits: QueryHit[],
  now: Date = clockNow(),
): void {
  if (hits.length === 0) return;
  const file = ledgerFile(projectRoot, sessionId);
  mkdirSync(join(file, '..'), { recursive: true });
  const lines = hits.map((h) =>
    JSON.stringify({
      id: h.id,
      contentHash: h.contentHash,
      tokens: h.tokens,
      at: now.toISOString(),
    }),
  );
  appendFileSync(file, `${lines.join('\n')}\n`);
}
