import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildContextCli } from '../cli/context.js';
import { parseEntryFile } from './entry.js';
import { generatedAuthority, INGEST_SOURCES, type IngestSource } from './ingest-sources.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let dir: string;
const root = (): string => join(dir, '.ai-sdlc/knowledge');

function put(rel: string, text: string): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const trunk of readdirSync(root())) {
    for (const f of readdirSync(join(root(), trunk))) {
      out[`${trunk}/${f}`] = readFileSync(join(root(), trunk, f), 'utf-8');
    }
  }
  return out;
}

function entries(): Record<string, unknown>[] {
  return Object.values(snapshot()).map((t) => {
    const p = parseEntryFile(t);
    if (!('fields' in p)) throw new Error('unparseable');
    return p.fields;
  });
}

async function ingest(kind: string, observed = '2026-10-26'): Promise<void> {
  await buildContextCli([
    'ingest',
    '--source',
    kind,
    '--project-dir',
    dir,
    '--observed',
    observed,
    ...(kind === 'generated' ? ['--file', join(dir, 'generated.json')] : []),
  ]).parseAsync();
}

const GEN = {
  id: 'gen-billing-owner',
  trunk: 'systems',
  type: 'fact',
  value: 'Billing is owned by the payments team',
  source: 'generators/owners',
  proof: 'path-exists:CODEOWNERS',
};

function generated(records: unknown[]): void {
  put('generated.json', JSON.stringify(records));
}

const decisionEvent = (summary: string): string =>
  JSON.stringify({
    eventVersion: 'v1',
    type: 'decision-opened',
    ts: '2026-10-10T00:00:00.000Z',
    decisionId: 'DEC-0001',
    source: 'ad-hoc',
    scope: 'x',
    summary,
    options: [{ id: 'a', description: 'A' }],
  }) + '\n';

const FIXTURES: Record<IngestSource, () => void> = {
  decisions: () => put('.ai-sdlc/_decisions/events.jsonl', decisionEvent('Use pnpm')),
  rfc: () =>
    put(
      'spec/rfcs/RFC-0099-x.md',
      '---\nid: RFC-0099\ntitle: Example\nlifecycle: Signed Off\n---\n\n# X\n\n## Open Questions\n\n**OQ-1 - Why?**\n\nText.\n\n**Resolution (2026-10-01): do it.**\n\n## Next\n',
    ),
  reviews: () =>
    put(
      '.ai-sdlc/reviews/aisdlc-1.jsonl',
      JSON.stringify({
        taskId: 'AISDLC-1',
        commitSha: 'abcdef1234',
        iteration: 1,
        role: 'code',
        verdict: 'approved',
        findings: [{ severity: 'minor', summary: 'nit' }],
      }) + '\n',
    ),
  events: () =>
    put(
      '.ai-sdlc/_events.jsonl',
      JSON.stringify({
        type: 'stage-started',
        timestamp: '2026-10-01T00:00:00Z',
        issueId: 'AISDLC-1',
        stage: 'plan',
      }) + '\n',
    ),
  tasks: () =>
    put(
      'backlog/tasks/AISDLC-1 - t.md',
      '---\nid: AISDLC-1\ntitle: Do thing\nstatus: To Do\n---\n\nbody\n',
    ),
  generated: () => generated([GEN]),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ingest-src-'));
});
afterEach(() => {
  removeFixtureDir(dir);
  process.exitCode = 0;
});

describe('cli-context ingest', () => {
  it('decisions: one specialist entry per record with the record id as proof', async () => {
    FIXTURES.decisions();
    await ingest('decisions');
    const e = entries();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ authority: 'specialist', proof: 'DEC-0001' });
    expect(String(e[0].value)).toContain('Use pnpm');
  });

  it('rfc: frontmatter and open question resolutions', async () => {
    FIXTURES.rfc();
    await ingest('rfc');
    const values = entries().map((e) => String(e.value));
    expect(values).toHaveLength(2);
    expect(values.some((v) => v.startsWith('RFC-0099: Example'))).toBe(true);
    expect(values.some((v) => v.startsWith('Resolution (2026-10-01)'))).toBe(true);
  });

  it('reviews, events and tasks write entries', async () => {
    for (const kind of ['reviews', 'events', 'tasks'] as const) {
      FIXTURES[kind]();
      await ingest(kind);
    }
    expect(entries()).toHaveLength(3);
  });

  it('never writes canonical and every entry validates', async () => {
    for (const kind of INGEST_SOURCES) {
      FIXTURES[kind]();
      await ingest(kind);
    }
    expect(entries().length).toBeGreaterThanOrEqual(6);
    for (const e of entries()) expect(e.authority).not.toBe('canonical');
    await buildContextCli(['validate', '--project-dir', dir]).parseAsync();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('is idempotent by contentHash', async () => {
    for (const kind of INGEST_SOURCES) {
      FIXTURES[kind]();
      await ingest(kind);
    }
    const before = snapshot();
    for (const kind of INGEST_SOURCES) await ingest(kind, '2026-11-01');
    expect(snapshot()).toEqual(before);
  });

  it('a changed source updates the entry and records supersession', async () => {
    FIXTURES.decisions();
    await ingest('decisions');
    const oldHash = entries()[0].contentHash;
    put('.ai-sdlc/_decisions/events.jsonl', decisionEvent('Use npm'));
    await ingest('decisions', '2026-11-01');
    const e = entries();
    expect(e).toHaveLength(1);
    expect(String(e[0].value)).toContain('Use npm');
    expect(e[0].supersedes).toBe(`decision-dec-0001@${String(oldHash)}`);
  });
});

describe('cli-context ingest --source generated', () => {
  const allowlist = (): void =>
    put(
      '.ai-sdlc/context.yaml',
      'knowledge:\n  promotion:\n    commands:\n      ver: [node, --version]\n',
    );

  it('writes the records from --file', async () => {
    generated([GEN, { ...GEN, id: 'gen-two', value: 'Second' }]);
    await ingest('generated');
    const e = entries();
    expect(e).toHaveLength(2);
    expect(e.find((x) => x.id === GEN.id)).toMatchObject({
      trunk: 'systems',
      source: 'generators/owners',
      proof: 'path-exists:CODEOWNERS',
      authority: 'inferred',
    });
  });

  it('fails clearly without --file', async () => {
    await expect(async () =>
      buildContextCli(['ingest', '--source', 'generated', '--project-dir', dir]).parseAsync(),
    ).rejects.toThrow(/--source generated requires --file/);
  });

  it('fails when the file is not a JSON array', async () => {
    put('generated.json', '{}');
    await expect(async () => ingest('generated')).rejects.toThrow(/expected a JSON array/);
  });

  it('re-ingest is unchanged; a changed value supersedes', async () => {
    generated([GEN]);
    await ingest('generated');
    const before = snapshot();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await ingest('generated', '2026-11-01');
    expect(out.mock.calls.map((c) => String(c[0])).join('')).toContain('1 unchanged');
    out.mockRestore();
    expect(snapshot()).toEqual(before);
    const oldHash = entries()[0].contentHash;
    generated([{ ...GEN, value: 'Billing is owned by finance' }]);
    await ingest('generated', '2026-11-02');
    const e = entries();
    expect(e).toHaveLength(1);
    expect(e[0].value).toBe('Billing is owned by finance');
    expect(e[0].supersedes).toBe(`${GEN.id}@${String(oldHash)}`);
  });

  it('allowlisted command proof is specialist; every other proof is inferred', async () => {
    allowlist();
    const proofs = {
      'gen-cmd': 'allowlisted-command:ver::v2',
      'gen-cmd-unknown': 'allowlisted-command:nope::v2',
      'gen-cmd-no-expected': 'allowlisted-command:ver',
      'gen-path': 'path-exists:README.md',
      'gen-test': 'test-id:foo.test.ts::bar',
      'gen-free': 'trust me',
    };
    generated(Object.entries(proofs).map(([id, proof]) => ({ ...GEN, id, proof })));
    await ingest('generated');
    const byId = Object.fromEntries(entries().map((e) => [e.id, e.authority]));
    expect(byId).toEqual({
      'gen-cmd': 'specialist',
      'gen-cmd-unknown': 'inferred',
      'gen-cmd-no-expected': 'inferred',
      'gen-path': 'inferred',
      'gen-test': 'inferred',
      'gen-free': 'inferred',
    });
  });

  it('reports and skips invalid records, still writing valid ones', async () => {
    generated([
      { ...GEN, id: 'gen-ok' },
      { ...GEN, id: 'gen-no-proof', proof: undefined },
      { ...GEN, id: 'gen-num', value: 42 },
      { ...GEN, id: 'gen-bad-trunk', trunk: 'nowhere' },
      { ...GEN, id: '../escape' },
      'not an object',
    ]);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await ingest('generated');
    const lines = err.mock.calls.map((c) => String(c[0])).join('');
    err.mockRestore();
    expect(entries().map((e) => e.id)).toEqual(['gen-ok']);
    expect(lines).toContain('skipped record 1: missing or non-string proof');
    expect(lines).toContain('skipped record 2: missing or non-string value');
    expect(lines).toMatch(/skipped record 3 \(gen-bad-trunk\): unknown trunk 'nowhere'/);
    expect(lines).toContain("skipped record 4: id '../escape'");
    expect(lines).toContain('skipped record 5: missing or non-string id');
  });

  it('generatedAuthority defaults to an empty allowlist', () => {
    expect(generatedAuthority('allowlisted-command:ver::v2')).toBe('inferred');
    expect(generatedAuthority('allowlisted-command:ver::v2', { ver: ['x'] })).toBe('specialist');
  });
});
