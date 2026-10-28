/**
 * Knowledge log (RFC-0053 OQ-3): append-only JSONL of promotion, supersession,
 * refutation and re-observation events, kept next to the tracked root.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { now } from '../clock.js';

export const KNOWLEDGE_LOG_FILE = 'knowledge-log.jsonl';

/** Sibling of the tracked root, so entry scans never see it. */
export function knowledgeLogPath(trackedRootAbs: string): string {
  return join(dirname(trackedRootAbs), KNOWLEDGE_LOG_FILE);
}

export type KnowledgeEventKind = 'promoted' | 'superseded' | 'refuted' | 'reobserved';

export interface KnowledgeEvent {
  ts: string;
  event: KnowledgeEventKind;
  id: string;
  from?: string;
  to?: string;
  proof?: string;
  by?: string;
  detail?: string;
}

export function appendKnowledgeEvent(
  trackedRootAbs: string,
  e: Omit<KnowledgeEvent, 'ts'>,
): KnowledgeEvent {
  const full: KnowledgeEvent = { ts: now().toISOString(), ...e };
  const file = knowledgeLogPath(trackedRootAbs);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(full)}\n`);
  return full;
}

export function readKnowledgeLog(trackedRootAbs: string): KnowledgeEvent[] {
  const file = knowledgeLogPath(trackedRootAbs);
  if (!existsSync(file)) return [];
  const out: KnowledgeEvent[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as KnowledgeEvent);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** One line per promotion with its proof, for `cli-context audit`. */
export function auditLines(events: KnowledgeEvent[]): string[] {
  return events
    .filter((e) => e.event === 'promoted')
    .map(
      (e) =>
        `${e.ts} ${e.id} ${e.from ?? '?'} -> ${e.to ?? '?'} proof=${e.proof ?? '(none)'} by=${e.by ?? '?'}`,
    );
}
