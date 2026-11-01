import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContextCli } from '../cli/context.js';
import { parseEntryFile } from './entry.js';
import { INGEST_SOURCES, type IngestSource } from './ingest-sources.js';
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
  ]).parseAsync();
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
