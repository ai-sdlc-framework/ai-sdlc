/**
 * The optional concurrency token (AISDLC-1457): a versioned stub backend proves that the core
 * write helpers pass the version they read, re-read and retry on `conflict` (at most
 * `WRITE_ATTEMPTS` in total), and then fail with the conflict; the files backend ignores it.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import { reportWrite } from '../cli/context.js';
import type { KnowledgeConfig } from './config.js';
import { confirmEntry, correctEntry, supersedeEntry } from './human.js';
import { countIngestWrite } from './ingest-write.js';
import {
  openKnowledgeStore,
  registerKnowledgeBackend,
  retryOnConflict,
  WRITE_ATTEMPTS,
  type StoredEntry,
  type WriteOp,
  type WriteOptions,
  type WriteResult,
} from './knowledge-store.js';
import { DEFAULT_ONTOLOGY } from './ontology.js';
import { promoteEntry, refuteEntry, reobserveEntry } from './promote.js';

/** One in-memory entry with a version; `conflicts` writes are refused as concurrent edits. */
const stub = {
  version: 1,
  confidence: 0.5,
  conflicts: 0,
  calls: [] as { op: WriteOp; opts: WriteOptions | undefined }[],
};

function stored(): StoredEntry {
  return {
    fields: { id: 'k-1', trunk: 'systems', confidence: stub.confidence, authority: 'inferred' },
    body: 'body\n',
    scope: 'tracked',
    path: 'systems/k-1.md',
    version: `v${stub.version}`,
  };
}

registerKnowledgeBackend('versioned-stub', () => ({
  kind: 'versioned-stub',
  get: (id) => (id === 'k-1' ? stored() : null),
  list: () => [stored()],
  listRaw: () => [],
  create: () => Promise.resolve({ id: 'x', path: '', created: false, status: 'rejected' }),
  write: (id, op, opts) => {
    stub.calls.push({ op, opts });
    if (stub.conflicts > 0 || opts?.expectedVersion !== `v${stub.version}`) {
      stub.conflicts--;
      // Another session wrote in between: the entry moved on.
      stub.version++;
      stub.confidence = 0.9;
      const r: WriteResult = {
        id,
        path: '',
        created: false,
        status: 'conflict',
        reason: 'version moved',
      };
      return Promise.resolve(r);
    }
    stub.version++;
    return Promise.resolve({
      id,
      path: 'systems/k-1.md',
      created: op.kind === 'supersede',
      status: 'applied',
      version: `v${stub.version}`,
    });
  },
}));

const SEL = { backend: 'versioned-stub' } as const;
const HUMAN = { by: 'human', principal: 'human:op@example.com' } as const;
const ROOT = '/nonexistent-project';
const CTX = {
  projectDir: ROOT,
  ontology: DEFAULT_ONTOLOGY,
  config: { allowlistedCommands: {} } as unknown as KnowledgeConfig,
};

beforeEach(() => {
  stub.version = 1;
  stub.confidence = 0.5;
  stub.conflicts = 0;
  stub.calls = [];
});

/** Every helper, driven against the stub. */
const HELPERS: [string, () => Promise<{ status: string; reason?: string }>][] = [
  ['confirm', () => confirmEntry(SEL, '/t', 'k-1', 1, HUMAN, undefined, ROOT)],
  ['correct', () => correctEntry(SEL, '/t', 'k-1', 'new', HUMAN, '2026-11-27', ROOT)],
  ['supersede', () => supersedeEntry(SEL, '/t', 'k-1', 'k-2', 'new', HUMAN, undefined, ROOT)],
  [
    'promote',
    () => promoteEntry(SEL, '/t', 'k-1', { to: 'canonical', by: 'human', principal: 'h' }, CTX),
  ],
  ['reobserve', () => reobserveEntry(SEL, '/t', 'k-1', 1, HUMAN, undefined, ROOT)],
  ['refute', () => refuteEntry(SEL, '/t', 'k-1', 'wrong', HUMAN, ROOT)],
];

describe('core write helpers on a versioned backend (AISDLC-1457)', () => {
  it.each(HELPERS)('%s passes the version it read', async (_name, run) => {
    const r = await run();
    expect(r.status).toBe('applied');
    expect(stub.calls.map((c) => c.opts?.expectedVersion)).toEqual(['v1']);
  });

  it.each(HELPERS)('%s re-reads and retries once after one conflict', async (_name, run) => {
    stub.conflicts = 1;
    const r = await run();
    expect(r.status).toBe('applied');
    expect(stub.calls.map((c) => c.opts?.expectedVersion)).toEqual(['v1', 'v2']);
  });

  it.each(HELPERS)('%s fails with the conflict after the last attempt', async (_name, run) => {
    stub.conflicts = 99;
    const r = await run();
    expect(r.status).toBe('conflict');
    expect(r.reason).toBe(
      `write conflict persisted after ${WRITE_ATTEMPTS} attempts: version moved`,
    );
    expect(stub.calls).toHaveLength(WRITE_ATTEMPTS);
  });

  it('re-runs the decision on the re-read entry, not the stale one', async () => {
    stub.conflicts = 1;
    const r = await confirmEntry(SEL, '/t', 'k-1', 1, HUMAN, undefined, ROOT);
    // First attempt moved 0.5 toward 1; the retry moves the concurrent 0.9 toward 1.
    expect(stub.calls.map((c) => c.op.fields.confidence)).toEqual([0.65, 0.93]);
    expect(r).toMatchObject({ status: 'applied', confidence: 0.93, version: 'v3' });
  });

  it('promote reports a persistent conflict as not ok, authority unchanged', async () => {
    stub.conflicts = 99;
    const r = await promoteEntry(
      SEL,
      '/t',
      'k-1',
      { to: 'canonical', by: 'human', principal: 'h' },
      CTX,
    );
    expect(r).toMatchObject({ ok: false, authority: 'inferred', status: 'conflict' });
  });
});

describe('retryOnConflict', () => {
  it('returns the first non-conflict result without retrying', async () => {
    const attempt = vi.fn(() => Promise.resolve({ status: 'rejected', reason: 'no' }));
    expect(await retryOnConflict(attempt)).toEqual({ status: 'rejected', reason: 'no' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('reports a persistent conflict without a backend reason', async () => {
    const attempt = vi.fn(() => Promise.resolve({ status: 'conflict' }));
    expect(await retryOnConflict(attempt)).toEqual({
      status: 'conflict',
      reason: `write conflict persisted after ${WRITE_ATTEMPTS} attempts`,
    });
    expect(attempt).toHaveBeenCalledTimes(3);
  });
});

describe('conflict reporting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('reportWrite prints conflict on stderr and exits 1', () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => (err.push(String(s)), true));
    reportWrite({ status: 'conflict', reason: 'moved' }, 'x');
    reportWrite({ status: 'conflict' }, 'x');
    expect(err).toEqual(['conflict: moved\n', 'conflict: the entry changed concurrently\n']);
    expect(process.exitCode).toBe(1);
  });

  it('an ingest conflict counts as rejected', () => {
    const counts = { created: 0, updated: 0, proposed: 0, rejected: 0 };
    const lines: string[] = [];
    countIngestWrite(
      counts,
      { id: 'a', path: '', created: false, status: 'conflict', reason: 'moved' },
      (l) => lines.push(l),
    );
    expect(counts.rejected).toBe(1);
    expect(lines).toEqual(['rejected a: moved']);
  });
});

describe('files backend ignores the token (AISDLC-1457)', () => {
  let dir: string;
  afterEach(() => removeFixtureDir(dir));

  it('returns no version and applies whatever expectedVersion is passed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-version-'));
    const tracked = join(dir, 'k');
    mkdirSync(join(tracked, 'systems'), { recursive: true });
    writeFileSync(
      join(tracked, 'systems/k-1.md'),
      `---\n${JSON.stringify({ id: 'k-1', trunk: 'systems', confidence: 0.5 })}\n---\nbody\n`,
    );
    const store = openKnowledgeStore({ backend: 'files', trackedRoot: tracked }, dir);
    expect(store.get('k-1')).not.toHaveProperty('version');
    const r = await store.write(
      'k-1',
      { kind: 'confirm', fields: { confidence: 0.6 }, principal: 'human:op@example.com' },
      { expectedVersion: 'stale' },
    );
    expect(r).toEqual({ id: 'k-1', path: 'systems/k-1.md', created: false, status: 'applied' });
  });
});
