import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeEntryHash } from './logger.js';
import { verifyFileIntegrity } from './file-sink.js';
import type { AuditEntry } from './types.js';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../conformance/audit-chain');
const fixture = JSON.parse(readFileSync(resolve(dir, 'fixture.json'), 'utf-8')) as {
  schemaVersion: string;
  inputs: Omit<AuditEntry, 'hash' | 'previousHash' | 'schemaVersion'>[];
  expectedHashes: string[];
};

function seal(): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const input of fixture.inputs) {
    const prev = out.length ? out[out.length - 1].hash : undefined;
    const base = { schemaVersion: fixture.schemaVersion, ...input, previousHash: prev };
    out.push({ ...base, hash: computeEntryHash(base, prev) });
  }
  return out;
}

const lines = (entries: AuditEntry[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

describe('audit chain conformance', () => {
  it('matches the fixture hashes and (optionally) writes the sample file', () => {
    const entries = seal();
    if (process.env.AUDIT_CONFORMANCE_WRITE) {
      writeFileSync(resolve(dir, 'samples/typescript.jsonl'), lines(entries));
    }
    expect(entries.map((e) => e.hash)).toEqual(fixture.expectedHashes);
  });

  it.each(['typescript', 'go', 'python', 'legacy-typescript'])('verifies the %s sample', (name) => {
    expect(verifyFileIntegrity(resolve(dir, `samples/${name}.jsonl`))).toEqual({ valid: true });
  });

  it('fails verification when one byte of a v2 chain changes', () => {
    const text = readFileSync(resolve(dir, 'samples/go.jsonl'), 'utf-8');
    const tampered = resolve(dir, '../../node_modules/.tmp-audit-tamper.jsonl');
    writeFileSync(tampered, text.replace('policy/strict', 'policy/strict2'));
    expect(verifyFileIntegrity(tampered)).toEqual({ valid: false, brokenAt: 1 });
  });

  it('rejects a v2 chain whose schemaVersion is downgraded', () => {
    const entries = seal().map((e) => ({ ...e, schemaVersion: undefined }));
    const f = resolve(dir, '../../node_modules/.tmp-audit-downgrade.jsonl');
    writeFileSync(f, lines(entries));
    expect(verifyFileIntegrity(f).valid).toBe(false);
  });

  it('hashes 1.0 and <&> non-ASCII text in canonical form', () => {
    const e = {
      schemaVersion: '2',
      id: 'x',
      timestamp: 't',
      actor: 'a',
      action: 'b',
      resource: 'c',
      decision: 'allowed' as const,
      details: { r: 1.0, s: '<&>é' },
    };
    expect(computeEntryHash(e)).toBe(computeEntryHash({ ...e, details: { s: '<&>é', r: 1 } }));
  });
});
