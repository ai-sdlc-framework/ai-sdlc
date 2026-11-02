/**
 * Evaluator-only quarantine (RFC-0053 OQ-5). Questions mined from transcripts are untrusted text:
 * they are scrubbed, de-duplicated and written ONLY under the quarantine directory, and no hook
 * or prompt builder reads that directory. Synthetic questions land there too.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { KnowledgeEntry } from '../entry.js';

export const QUARANTINE_DIR = '.ai-sdlc/context/eval-quarantine';
export const MINED_FILE = 'mined.jsonl';
export const SYNTHETIC_FILE = 'synthetic.jsonl';

const SCRUBBERS: [RegExp, string][] = [
  [/\b(?:sk|pk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|AKIA)[-_A-Za-z0-9]{12,}/g, '<secret>'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer <secret>'],
  [/\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S+/gi, '<secret>'],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '<secret>'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>'],
  [/(?:\/Users|\/home)\/[^\s/]+/g, '<home>'],
  [/\b(?:AISDLC|DEC|RFC)-\d+(?:\.\d+)?\b/g, '<id>'],
  [/https?:\/\/\S+/g, '<url>'],
];

export function scrub(text: string): string {
  let out = text;
  for (const [re, sub] of SCRUBBERS) out = out.replace(re, sub);
  return out.replace(/\s+/g, ' ').trim();
}

export function questionKey(q: string): string {
  const norm = q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/** Resolve a file in the quarantine dir; refuses anything that would land outside it. */
export function quarantineFile(projectRoot: string, name: string): string {
  const dir = resolve(projectRoot, QUARANTINE_DIR);
  const file = resolve(dir, name);
  if (relative(dir, file).startsWith('..') || relative(dir, file) === '') {
    throw new Error(`quarantine write refused outside ${QUARANTINE_DIR}: ${name}`);
  }
  mkdirSync(dir, { recursive: true });
  return file;
}

function readKeys(file: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(file)) return keys;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      keys.add((JSON.parse(line) as { key: string }).key);
    } catch {
      // torn line: ignore
    }
  }
  return keys;
}

/** User-authored text of a transcript JSONL (Claude Code shape) or plain lines. */
export function userMessages(transcript: string): string[] {
  const out: string[] = [];
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as {
        type?: string;
        message?: { content?: string | { type?: string; text?: string }[] };
      };
      if (rec.type !== 'user') continue;
      const c = rec.message?.content;
      if (typeof c === 'string') out.push(c);
      else if (Array.isArray(c)) {
        for (const b of c) if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
      }
    } catch {
      out.push(line);
    }
  }
  return out;
}

export interface MineResult {
  written: number;
  duplicates: number;
}

/** Mine questions (messages containing a `?`) into the quarantine; repeats are dropped. */
export function mineQuestions(projectRoot: string, transcripts: string[]): MineResult {
  const file = quarantineFile(projectRoot, MINED_FILE);
  const seen = readKeys(file);
  let written = 0;
  let duplicates = 0;
  for (const t of transcripts) {
    for (const msg of userMessages(t)) {
      for (const sentence of msg.split(/(?<=[?\n])/)) {
        if (!sentence.includes('?')) continue;
        const q = scrub(sentence);
        if (q.length < 8 || q.length > 300) continue;
        const key = questionKey(q);
        if (seen.has(key)) {
          duplicates++;
          continue;
        }
        seen.add(key);
        appendFileSync(file, `${JSON.stringify({ key, question: q })}\n`);
        written++;
      }
    }
  }
  return { written, duplicates };
}

export interface SyntheticQuestion {
  key: string;
  question: string;
  entryId: string;
}

/** One question per entry, built from the entry's id and the head of its value. */
export function generateSynthetic(entries: KnowledgeEntry[]): SyntheticQuestion[] {
  return entries
    .filter((e) => !e.superseded)
    .map((e) => {
      const topic = e.id.replace(/[-_./]+/g, ' ').trim();
      const head =
        e.value
          .replace(/\s+/g, ' ')
          .split(/(?<=[.!?])\s/)[0]
          ?.slice(0, 120) ?? '';
      const question = `What do we know about ${topic}${head ? ` (${head})` : ''}?`;
      return { key: questionKey(e.id), question, entryId: e.id };
    });
}

export function writeSynthetic(projectRoot: string, qs: SyntheticQuestion[]): number {
  const file = quarantineFile(projectRoot, SYNTHETIC_FILE);
  const seen = readKeys(file);
  let n = 0;
  for (const q of qs) {
    if (seen.has(q.key)) continue;
    appendFileSync(file, `${JSON.stringify(q)}\n`);
    n++;
  }
  return n;
}

export function readSynthetic(projectRoot: string): SyntheticQuestion[] {
  const file = join(projectRoot, QUARANTINE_DIR, SYNTHETIC_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SyntheticQuestion);
}
