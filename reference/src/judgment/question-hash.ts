import { createHash } from 'node:crypto';
import type { JudgmentDefinition } from './definition.js';

/** JSON with object keys sorted at every depth, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const out = JSON.stringify(value);
    return out === undefined ? 'null' : out;
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** SHA-256 over the canonical JSON of the questions for a probe input plus the version. */
export function questionSetHash<I, D>(definition: JudgmentDefinition<I, D>, probeInput: I): string {
  return sha256Hex(
    canonicalJson({ questions: definition.questions(probeInput), version: definition.version }),
  );
}
