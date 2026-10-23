import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildContextCli } from '../../cli/context.js';
import { loadRetrievalConfig } from '../config.js';
import { hashValue, type KnowledgeEntry } from '../entry.js';
import { HashedEmbedder } from './embedder.js';
import { loadedKeys } from './ledger.js';
import { createRetrievalIndex, RetrievalAdapterError } from './registry.js';
import { queryIndex, rebuildIndex } from './service.js';
import { fuseRanks, SqliteRetrievalIndex } from './sqlite-index.js';
import type { Embedder } from './types.js';

let root: string;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

function mk(id: string, value: string, over: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id,
    trunk: 'systems',
    type: 'fact',
    value,
    confidence: 0.7,
    authority: 'inferred',
    scope: 'internal',
    source: `src/${id}.ts`,
    observed: '2026-10-09',
    decay: 'durable',
    relations: [],
    contentHash: hashValue(value),
    body: '',
    ...over,
  };
}

function entryFile(e: KnowledgeEntry): string {
  const { body, ...fm } = e;
  return `---\n${JSON.stringify(fm)}\n---\n${body}\n`;
}

function project(entries: KnowledgeEntry[], config = ''): string {
  root = mkdtempSync(join(tmpdir(), 'retrieval-'));
  for (const e of entries) {
    const p = join(root, '.ai-sdlc/knowledge/systems', `${e.id}.md`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, entryFile(e));
  }
  if (config) {
    mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(root, '.ai-sdlc/context.yaml'), config);
  }
  return root;
}

/** Embedder that maps chosen words to fixed axes so vector similarity is controlled. */
class AxisEmbedder implements Embedder {
  readonly name = 'axis';
  readonly dimensions = 4;
  constructor(private readonly axes: Record<string, number[]>) {}
  async embed(text: string): Promise<number[]> {
    const v = [0, 0, 0, 0];
    for (const [w, a] of Object.entries(this.axes)) {
      if (text.toLowerCase().includes(w)) a.forEach((x, i) => (v[i] += x));
    }
    return v;
  }
}

const CORPUS = [
  mk('gateway', 'The gateway retries failed requests three times with backoff'),
  mk('billing', 'Billing runs nightly and posts invoices to the ledger'),
  mk('auth', 'Authentication tokens expire after one hour'),
];

describe('SqliteRetrievalIndex', () => {
  it('has FTS5, vector and edges tables', async () => {
    const idx = new SqliteRetrievalIndex(':memory:', new HashedEmbedder());
    expect(idx.tables()).toEqual(expect.arrayContaining(['entries_fts', 'vectors', 'edges']));
    idx.close();
  });

  it('createRetrievalIndex builds the sqlite adapter', () => {
    const idx = createRetrievalIndex('sqlite', { indexPath: ':memory:' });
    expect(idx.kind).toBe('sqlite');
    idx.close();
  });

  it('rebuild after deleting the file returns identical results', async () => {
    const dir = project(CORPUS);
    await rebuildIndex(dir);
    const first = await queryIndex(dir, { text: 'gateway retries' });
    rmSync(join(dir, '.ai-sdlc/context-index.db'));
    expect(await rebuildIndex(dir)).toBe(3);
    const second = await queryIndex(dir, { text: 'gateway retries' });
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(first[0].id).toBe('gateway');
  });

  it('fuses signals: a document found by only one signal still ranks', async () => {
    const embedder = new AxisEmbedder({ zebra: [1, 0, 0, 0], giraffe: [1, 0, 0, 0] });
    const idx = new SqliteRetrievalIndex(':memory:', embedder);
    await idx.rebuild([
      mk('kw-only', 'zebra crossing rules'),
      mk('vec-only', 'giraffe neck length'),
      mk('noise', 'quarterly budget review'),
    ]);
    // Keyword matches kw-only; vector (shared axis) matches both zebra and giraffe docs.
    const hits = await idx.query('zebra');
    expect(hits.map((h) => h.id)).toEqual(expect.arrayContaining(['kw-only', 'vec-only']));
    expect(hits.map((h) => h.id)).not.toContain('noise');
    expect(hits[0].id).toBe('kw-only');
    const vecOnly = hits.find((h) => h.id === 'vec-only')!;
    expect(vecOnly.score).toBeGreaterThan(0);
    idx.close();
  });

  it('fuseRanks sums reciprocal ranks', () => {
    const s = fuseRanks([['a', 'b'], ['b']], 60);
    expect(s.get('b')).toBeCloseTo(1 / 62 + 1 / 61);
    expect(s.get('a')).toBeCloseTo(1 / 61);
  });

  it('prefers the head of a supersedes chain', async () => {
    const idx = new SqliteRetrievalIndex(':memory:', new HashedEmbedder());
    await idx.rebuild([
      mk('v1', 'deploy uses blue green rollout'),
      mk('v2', 'deploy rollout updated', { supersedes: 'v1' }),
      mk('v3', 'deploy canary', { supersedes: 'v2' }),
    ]);
    const hits = await idx.query('deploy blue green rollout');
    expect(hits.map((h) => h.id)).toEqual(['v3']);
    idx.close();
  });

  it('honors budget and min-score and returns citations and contentHash', async () => {
    const idx = new SqliteRetrievalIndex(':memory:', new HashedEmbedder());
    await idx.rebuild(CORPUS);
    const all = await idx.query('gateway billing tokens requests invoices');
    expect(all[0]).toMatchObject({
      contentHash: expect.any(String),
      citations: [expect.stringContaining('src/')],
    });
    const budget = all[0].tokens;
    const trimmed = await idx.query('gateway billing tokens requests invoices', { budget });
    expect(trimmed).toHaveLength(1);
    const floored = await idx.query('gateway billing tokens requests invoices', {
      minScore: 0.999,
    });
    expect(floored.every((h) => h.score >= 0.999)).toBe(true);
    expect(floored.length).toBeLessThan(all.length);
    idx.close();
  });

  it('returns nothing for a query with no tokens and walks edges recursively', async () => {
    const idx = new SqliteRetrievalIndex(':memory:', new HashedEmbedder());
    await idx.rebuild([
      mk('a', 'alpha', { relations: [{ type: 'depends-on', target: 'b' }] }),
      mk('b', 'beta', { relations: [{ type: 'depends-on', target: 'c' }] }),
      mk('c', 'gamma'),
    ]);
    expect(await idx.query('!!!')).toEqual([]);
    expect(idx.related('a', 1)).toEqual(['b']);
    expect(idx.related('a', 2)).toEqual(['b', 'c']);
    idx.close();
  });
});

describe('session ledger', () => {
  it('omits loaded entries unless the contentHash changed', async () => {
    const dir = project(CORPUS);
    await rebuildIndex(dir);
    const first = await queryIndex(dir, { text: 'gateway retries', sessionId: 's1' });
    expect(first.map((h) => h.id)).toContain('gateway');
    const again = await queryIndex(dir, { text: 'gateway retries', sessionId: 's1' });
    expect(again.map((h) => h.id)).not.toContain('gateway');
    // Another session still sees it.
    const other = await queryIndex(dir, { text: 'gateway retries', sessionId: 's2' });
    expect(other.map((h) => h.id)).toContain('gateway');
    // Changed content re-injects.
    writeFileSync(
      join(dir, '.ai-sdlc/knowledge/systems/gateway.md'),
      entryFile(mk('gateway', 'The gateway retries failed requests five times')),
    );
    await rebuildIndex(dir);
    const changed = await queryIndex(dir, { text: 'gateway retries', sessionId: 's1' });
    expect(changed.map((h) => h.id)).toContain('gateway');
    expect(loadedKeys(dir, 's1').size).toBeGreaterThan(1);
  });

  it('rejects path-like session ids', async () => {
    const dir = project(CORPUS);
    await rebuildIndex(dir);
    await expect(queryIndex(dir, { text: 'gateway', sessionId: '../x' })).rejects.toThrow(
      /invalid session id/,
    );
  });
});

describe('config and registry', () => {
  it('reads retrieval.adapter and retrieval.indexPath from context.yaml', async () => {
    const dir = project(
      CORPUS,
      'retrieval:\n  adapter: sqlite\n  indexPath: .ai-sdlc/custom/idx.db\n',
    );
    expect(loadRetrievalConfig(dir)).toEqual({
      adapter: 'sqlite',
      indexPath: '.ai-sdlc/custom/idx.db',
    });
    await rebuildIndex(dir);
    expect(existsSync(join(dir, '.ai-sdlc/custom/idx.db'))).toBe(true);
  });

  it('defaults when the file or keys are absent', () => {
    expect(loadRetrievalConfig(project([]))).toEqual({
      adapter: 'sqlite',
      indexPath: '.ai-sdlc/context-index.db',
    });
    expect(loadRetrievalConfig(project([], 'knowledge: {}\n')).adapter).toBe('sqlite');
  });

  it('the default index path and session ledgers are gitignored', () => {
    const repo = resolve(__dirname, '../../../..');
    for (const p of ['.ai-sdlc/context-index.db', '.ai-sdlc/context/sessions/abc.jsonl']) {
      const r = spawnSync('git', ['check-ignore', '-q', p], { cwd: repo });
      expect(r.status, p).toBe(0);
    }
  });

  it('enterprise and unknown adapters fail closed', async () => {
    expect(() => createRetrievalIndex('enterprise', { indexPath: ':memory:' })).toThrow(
      /declared but not implemented/,
    );
    expect(() => createRetrievalIndex('nope', { indexPath: ':memory:' })).toThrow(
      RetrievalAdapterError,
    );
    const dir = project(CORPUS, 'retrieval:\n  adapter: enterprise\n');
    await expect(rebuildIndex(dir)).rejects.toThrow(/declared but not implemented/);
  });
});

describe('cli-context index / query', () => {
  async function run(
    dir: string,
    args: string[],
  ): Promise<{ out: string; err: string; code: number }> {
    let out = '';
    let err = '';
    const so = process.stdout.write.bind(process.stdout);
    const se = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string) => ((out += c), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: string) => ((err += c), true)) as typeof process.stderr.write;
    process.exitCode = 0;
    try {
      await buildContextCli(['--project-dir', dir, ...args]).parseAsync();
    } finally {
      process.stdout.write = so;
      process.stderr.write = se;
    }
    const code = Number(process.exitCode ?? 0);
    process.exitCode = 0;
    return { out, err, code };
  }

  it('indexes and queries with budget, min-score and session', async () => {
    const dir = project(CORPUS);
    expect((await run(dir, ['index'])).out).toContain('indexed 3 entries');
    const q = await run(dir, [
      'query',
      'gateway retries',
      '--budget',
      '1000',
      '--min-score',
      '0.1',
      '--session',
      'c1',
    ]);
    const parsed = JSON.parse(q.out) as {
      results: { id: string; contentHash: string; citations: string[] }[];
    };
    expect(parsed.results[0]).toMatchObject({
      id: 'gateway',
      contentHash: hashValue(CORPUS[0].value),
    });
    expect(parsed.results[0].citations).toEqual(['src/gateway.ts']);
    const second = JSON.parse(
      (await run(dir, ['query', 'gateway retries', '--session', 'c1'])).out,
    );
    expect(second.results.map((r: { id: string }) => r.id)).not.toContain('gateway');
  });

  it('exits non-zero for the enterprise adapter on index and query', async () => {
    const dir = project(CORPUS, 'retrieval:\n  adapter: enterprise\n');
    for (const args of [['index'], ['query', 'x']]) {
      const r = await run(dir, args);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/declared but not implemented/);
    }
  });
});

describe('benchmark', () => {
  it('p95 query latency is under 200 ms at 10K entries', async () => {
    const words = Array.from({ length: 400 }, (_, i) => `term${i}`);
    const entries = Array.from({ length: 10_000 }, (_, i) =>
      mk(
        `e${String(i).padStart(5, '0')}`,
        `${words[i % 400]} ${words[(i * 7) % 400]} ${words[(i * 13) % 400]} entry number ${i}`,
      ),
    );
    const idx = new SqliteRetrievalIndex(':memory:', new HashedEmbedder());
    await idx.rebuild(entries);
    await idx.query('warm up term1'); // load the vector cache
    const times: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      await idx.query(`term${i * 3} term${i * 5 + 1}`, { budget: 3000 });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(200);
    idx.close();
  }, 120_000);
});
