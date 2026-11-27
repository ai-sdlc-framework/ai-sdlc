import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  checkEvidenceLedger,
  draftSha256,
  formatEvidenceFailures,
  normalizeDraftText,
} from './evidence-ledger.js';
import { appendDecisionEvent, makeDecisionOpenedEvent } from './event-log.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'spec',
  'schemas',
  'decision-evidence-ledger.v1.schema.json',
);

const DRAFT = 'OQ-1: storage backend?\nPick A, JSONL.\n';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'evidence-ledger-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'store.ts'),
    ['// header', 'export const STORE = "jsonl";', '', 'export function read() {}', ''].join('\n'),
  );
  mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
  writeFileSync(join(root, 'backlog', 'tasks', 'AISDLC-9001 - Define the store.md'), '');
  mkdirSync(join(root, 'backlog', 'completed'), { recursive: true });
  writeFileSync(join(root, 'backlog', 'completed', 'AISDLC-9002 - Old work.md'), '');
  mkdirSync(join(root, 'spec', 'rfcs'), { recursive: true });
  writeFileSync(join(root, 'spec', 'rfcs', 'RFC-0019-vectors.md'), '');
});

afterEach(() => removeFixtureDir(root));

function passingLedger(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ref: 'rfc:RFC-0019#OQ-1',
    draftSha256: draftSha256(DRAFT),
    researchedBy: 'Explore (sonnet)',
    researchedAt: '2026-11-27T10:00:00Z',
    entries: [
      {
        id: 'f1',
        kind: 'fact',
        claim: 'The store is JSONL',
        status: 'checked',
        source: { file: 'src/store.ts', line: 2, quote: 'STORE = "jsonl"' },
      },
      {
        id: 'f2',
        kind: 'fact',
        claim: 'cosine over 10K vectors takes about 50 ms',
        status: 'checked',
        source: { command: 'node bench.mjs', output: '49ms', ranAt: '2026-11-27T10:01:00Z' },
      },
      {
        id: 'f3',
        kind: 'fact',
        claim: 'WCAG 2.2 is a W3C Recommendation',
        status: 'checked',
        source: {
          url: 'https://www.w3.org/TR/WCAG22/',
          readAt: '2026-11-27T10:02:00Z',
          quote: 'W3C Recommendation',
        },
      },
      {
        id: 'f4',
        kind: 'fact',
        claim: 'RFC-0019 defines the store',
        status: 'checked',
        source: { record: 'RFC-0019' },
      },
      {
        id: 'f5',
        kind: 'fact',
        claim: 'a completed task exists',
        status: 'checked',
        source: { record: 'AISDLC-9002' },
      },
      {
        id: 'd1',
        kind: 'dependency',
        claim: 'the store module exists',
        status: 'checked',
        what: 'store module',
        exists: { path: 'src/store.ts' },
      },
      {
        id: 'd2',
        kind: 'dependency',
        claim: 'the GC job is filed',
        status: 'checked',
        what: 'GC job',
        prerequisite: 'AISDLC-9001',
      },
      {
        id: 'a1',
        kind: 'assumption',
        claim: 'adopter corpora stay under 100K vectors',
        status: 'checked',
        restsOn: ['f1', 'f2'],
        falsifiedBy: 'a pilot adopter reports a corpus over 100K',
      },
    ],
  };
}

function entries(l: Record<string, unknown>): Array<Record<string, unknown>> {
  return l.entries as Array<Record<string, unknown>>;
}

function check(l: unknown, draftText?: string) {
  return checkEvidenceLedger(l, {
    repoRoot: root,
    ...(draftText !== undefined ? { draftText } : {}),
  });
}

describe('draft hash (AISDLC-1451 AC 3)', () => {
  it('ignores CRLF, trailing whitespace, outer blank lines and Evidence lines', () => {
    const variant = '\r\nOQ-1: storage backend?   \r\nPick A, JSONL.\r\nEvidence: x.json\r\n\r\n';
    expect(normalizeDraftText(variant)).toBe('OQ-1: storage backend?\nPick A, JSONL.');
    expect(draftSha256(variant)).toBe(draftSha256(DRAFT));
  });

  it('changes on any word edit', () => {
    expect(draftSha256('OQ-1: storage backend?\nPick B, JSONL.')).not.toBe(draftSha256(DRAFT));
    expect(draftSha256(DRAFT)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('checkEvidenceLedger', () => {
  it('passes a complete ledger, with and without the draft', () => {
    expect(check(passingLedger())).toEqual({ ok: true, failures: [] });
    expect(check(passingLedger(), DRAFT).ok).toBe(true);
  });

  it('fails an entry that is missing its source', () => {
    const l = passingLedger();
    delete entries(l)[0].source;
    delete entries(l)[5].exists;
    const r = check(l);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(
      expect.arrayContaining([
        { entry: 'f1', reason: 'fact has no source' },
        expect.objectContaining({ entry: 'd1', reason: expect.stringMatching(/has no source/) }),
      ]),
    );
  });

  it.each(['unchecked', 'unverifiable', undefined])('fails status %s', (status) => {
    const l = passingLedger();
    if (status === undefined) delete entries(l)[1].status;
    else entries(l)[1].status = status;
    const r = check(l);
    expect(r.ok).toBe(false);
    expect(r.failures[0].entry).toBe('f2');
    expect(r.failures[0].reason).toMatch(/only final state is "checked"/);
  });

  it('fails a file quote that has drifted from the tree', () => {
    const l = passingLedger();
    writeFileSync(join(root, 'src', 'store.ts'), 'export const STORE = "sqlite";\n');
    const r = check(l);
    expect(r.failures).toContainEqual({
      entry: 'f1',
      reason: 'quote not found in src/store.ts within 5 lines of line 2',
    });
    // the assumption resting on it fails too
    expect(r.failures.map((f) => f.entry)).toContain('a1');
  });

  it('accepts a quote within 5 lines and refuses one further away', () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    writeFileSync(join(root, 'src', 'long.ts'), body);
    const fact = (line: number) => ({
      ...passingLedger(),
      entries: [
        {
          id: 'f',
          kind: 'fact',
          claim: 'c',
          status: 'checked',
          source: { file: 'src/long.ts', line, quote: 'line 20' },
        },
      ],
    });
    expect(check(fact(15)).ok).toBe(true);
    expect(check(fact(25)).ok).toBe(true);
    expect(check(fact(14)).ok).toBe(false);
    expect(check(fact(26)).ok).toBe(false);
  });

  it('fails a file that does not exist or escapes the root', () => {
    const l = passingLedger();
    (entries(l)[0].source as Record<string, unknown>).file = 'src/missing.ts';
    expect(check(l).failures[0].reason).toBe('file src/missing.ts does not exist');
    (entries(l)[0].source as Record<string, unknown>).file = '../outside.ts';
    expect(check(l).failures[0].reason).toBe('file ../outside.ts does not exist');
  });

  it('fails a record, task or path that does not exist', () => {
    const l = passingLedger();
    (entries(l)[3].source as Record<string, unknown>).record = 'RFC-0999';
    (entries(l)[4].source as Record<string, unknown>).record = 'DEC-0001';
    entries(l)[5].exists = { path: 'src/nope.ts' };
    entries(l)[6].prerequisite = 'AISDLC-9999';
    const r = check(l);
    expect(r.failures).toEqual(
      expect.arrayContaining([
        { entry: 'f4', reason: 'record RFC-0999 does not exist on main' },
        { entry: 'f5', reason: 'record DEC-0001 does not exist on main' },
        { entry: 'd1', reason: 'path src/nope.ts does not exist' },
        { entry: 'd2', reason: 'prerequisite task AISDLC-9999 is not filed' },
      ]),
    );
  });

  it('finds a DEC record in the catalog', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'exists',
        options: [{ id: 'a', description: 'A' }],
        routing: { assignedActor: 'op@example.com' },
        capacity: { tier: 's' },
      }),
      { workDir: root },
    );
    const l = passingLedger();
    (entries(l)[3].source as Record<string, unknown>).record = 'DEC-0001';
    (entries(l)[4].source as Record<string, unknown>).record = 'DEC-0001';
    expect(check(l).ok).toBe(true);
    expect(
      checkEvidenceLedger(l, { repoRoot: root, decisionExists: () => false }).failures,
    ).toHaveLength(2);
  });

  it('fails an assumption with no passing restsOn', () => {
    const l = passingLedger();
    entries(l)[7].restsOn = [];
    expect(check(l).failures).toContainEqual({
      entry: 'a1',
      reason: 'assumption has no restsOn; it must rest on at least one checked fact',
    });
    entries(l)[7].restsOn = ['d1', 'nope'];
    const reasons = check(l).failures.map((f) => f.reason);
    expect(reasons).toContain('restsOn "d1" is not a passing fact entry');
    expect(reasons).toContain('restsOn "nope" is not a passing fact entry');
    delete entries(l)[7].falsifiedBy;
    expect(check(l).failures.map((f) => f.reason)).toContain('assumption has no falsifiedBy');
  });

  it('fails a ledger with no entries', () => {
    const r = check({ ...passingLedger(), entries: [] });
    expect(r.failures).toEqual([{ entry: 'ledger', reason: 'the ledger has no entries' }]);
  });

  it('fails a draftSha256 that does not match the draft', () => {
    const r = check(passingLedger(), DRAFT + 'Edited after research.');
    expect(r.ok).toBe(false);
    expect(r.failures[0].entry).toBe('ledger');
    expect(r.failures[0].reason).toMatch(/draftSha256 does not match the draft/);
  });

  it('fails malformed ledger fields and entries', () => {
    expect(check(null).failures).toEqual([{ entry: 'ledger', reason: 'not a JSON object' }]);
    const r = check({
      schemaVersion: 2,
      ref: 'Not A Ref',
      draftSha256: 'abc',
      researchedAt: 'yesterday',
      entries: [
        'junk',
        { id: 'x', kind: 'opinion', claim: 'c', status: 'checked' },
        { id: 'x', kind: 'fact', claim: 'c', status: 'checked', source: { other: 1 } },
        {
          id: 'y',
          kind: 'fact',
          claim: 'c',
          status: 'checked',
          source: { file: 'src/store.ts', line: 0, quote: 'x' },
        },
        { id: 'z', kind: 'fact', claim: 'c', status: 'checked', source: { command: 'ls' } },
        { id: 'u', kind: 'fact', claim: 'c', status: 'checked', source: { url: 'ftp://x' } },
        { id: 'r', kind: 'fact', claim: 'c', status: 'checked', source: { record: '' } },
        { id: 'p', kind: 'dependency', claim: 'c', status: 'checked', exists: {} },
        {
          id: 'q',
          kind: 'dependency',
          claim: 'c',
          status: 'checked',
          what: 'w',
          prerequisite: 'x',
        },
      ],
    });
    const text = formatEvidenceFailures(r.failures);
    for (const s of [
      'ledger: schemaVersion must be 1',
      'ledger: ref must be',
      'ledger: draftSha256 must be a 64-character hex sha256',
      'ledger: researchedBy is missing',
      'ledger: researchedAt must be an ISO date-time',
      '#1: entry has no id',
      '#1: entry has no claim',
      'x: kind must be fact, dependency or assumption',
      'x: duplicate entry id',
      'x: fact source must be one of',
      'y: file source needs file, line (>= 1) and quote',
      'z: command source needs command, output and an ISO ranAt',
      'u: url source needs an http(s) url',
      'r: record source has no id',
      'p: dependency has no what',
      'p: dependency exists.path is missing',
      'q: dependency prerequisite must be a task id',
    ]) {
      expect(text).toContain(s);
    }
  });
});

describe('ledger schema file (AC 2)', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));

  it('accepts the passing ledger', () => {
    expect(validate(passingLedger()), JSON.stringify(validate.errors)).toBe(true);
  });

  it('refuses an unchecked entry and an empty ledger', () => {
    const l = passingLedger();
    entries(l)[0].status = 'unchecked';
    expect(validate(l)).toBe(false);
    expect(validate({ ...passingLedger(), entries: [] })).toBe(false);
  });
});
