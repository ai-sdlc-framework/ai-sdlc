/**
 * Report-only production signal (RFC-0053 OQ-5): the share of entries injected in a session
 * (load ledger rows) whose id later appears in the session's output text. Never gates.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readLedger } from '../retrieval/ledger.js';

export interface CitationRate {
  injected: number;
  cited: number;
  rate: number;
}

export function sessionIds(projectRoot: string): string[] {
  const dir = join(projectRoot, '.ai-sdlc', 'context', 'sessions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length));
}

export function citationRate(projectRoot: string, sessions: string[], text: string): CitationRate {
  const haystack = text.toLowerCase();
  const injected = new Set<string>();
  for (const s of sessions) {
    for (const r of readLedger(projectRoot, s))
      if (r.kind !== 'premark') injected.add(`${s}:${r.id}`);
  }
  let cited = 0;
  for (const key of injected) {
    if (haystack.includes(key.slice(key.indexOf(':') + 1).toLowerCase())) cited++;
  }
  return { injected: injected.size, cited, rate: injected.size === 0 ? 0 : cited / injected.size };
}

export function renderCitationRate(r: CitationRate): string {
  return `citation rate ${(r.rate * 100).toFixed(1)}% (${r.cited} cited of ${r.injected} injected; report only, not a gate)`;
}
