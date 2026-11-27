import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setClock } from '../clock.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import { FilesKnowledgeStore, type KnowledgeStore } from './knowledge-store.js';
import { knowledgeSyncStatus, readSyncStamp, runKnowledgeSync, SYNC_STAMP_PATH } from './sync.js';

let dir: string;
let restore: () => void = () => {};
afterEach(() => {
  removeFixtureDir(dir);
  restore();
});

function stub(over: Partial<KnowledgeStore> = {}): KnowledgeStore {
  return {
    kind: 'stub',
    get: () => null,
    list: () => [],
    listRaw: () => [],
    create: () => Promise.reject(new Error('not used')),
    write: () => Promise.reject(new Error('not used')),
    sync: async () => ({ pulled: 3, pushed: 1 }),
    status: async () => ({ queued: 2, rejected: 1, lastSyncAt: 'backend-time' }),
    ...over,
  };
}

describe('runKnowledgeSync (AISDLC-1459)', () => {
  it('syncs, rebuilds the index and writes the stamp', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-sync-'));
    restore = setClock(() => new Date('2026-11-27T10:00:00.000Z'));
    const order: string[] = [];
    const r = await runKnowledgeSync(dir, {
      store: stub({ sync: async () => (order.push('sync'), { pulled: 3, pushed: 1 }) }),
      rebuild: async () => (order.push('rebuild'), 7),
    });
    expect(order).toEqual(['sync', 'rebuild']);
    const stamp = {
      at: '2026-11-27T10:00:00.000Z',
      ok: true,
      pulled: 3,
      pushed: 1,
      indexed: 7,
    };
    expect(r).toEqual({ supported: true, ...stamp });
    expect(JSON.parse(readFileSync(join(dir, SYNC_STAMP_PATH), 'utf-8'))).toEqual(stamp);
  });

  it('records a sync error without rebuilding', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-sync-'));
    let rebuilt = false;
    const r = await runKnowledgeSync(dir, {
      store: stub({
        sync: async () => {
          throw new Error('remote unreachable');
        },
      }),
      rebuild: async () => ((rebuilt = true), 0),
    });
    expect(rebuilt).toBe(false);
    expect(r).toMatchObject({ supported: true, ok: false, error: 'remote unreachable' });
    expect(readSyncStamp(dir)).toMatchObject({ ok: false, error: 'remote unreachable' });
  });

  it('records a non-Error rebuild failure', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-sync-'));
    const r = await runKnowledgeSync(dir, {
      store: stub(),
      rebuild: async () => Promise.reject('index locked'),
    });
    expect(r).toMatchObject({ ok: false, error: 'index locked' });
  });

  it('reports supported:false for the files backend and writes no stamp', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-sync-'));
    const store = new FilesKnowledgeStore({ trackedRoot: '.ai-sdlc/knowledge' }, dir);
    expect(await runKnowledgeSync(dir, { store })).toEqual({ ok: true, supported: false });
    expect(await knowledgeSyncStatus(dir, { store })).toEqual({ ok: true, supported: false });
    expect(readSyncStamp(dir)).toBeNull();
  });
});

describe('knowledgeSyncStatus (AISDLC-1459)', () => {
  it('uses the backend status when no sync ran', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-sync-'));
    expect(await knowledgeSyncStatus(dir, { store: stub() })).toEqual({
      ok: true,
      supported: true,
      queued: 2,
      rejected: 1,
      lastSyncAt: 'backend-time',
      lastSync: null,
    });
  });

  it('merges the stamp: its time and error win', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-sync-'));
    mkdirSync(join(dir, '.ai-sdlc/state'), { recursive: true });
    const stamp = { at: '2026-11-27T09:00:00.000Z', ok: false, error: 'boom' };
    writeFileSync(join(dir, SYNC_STAMP_PATH), JSON.stringify(stamp));
    expect(await knowledgeSyncStatus(dir, { store: stub() })).toEqual({
      ok: true,
      supported: true,
      queued: 2,
      rejected: 1,
      lastSyncAt: stamp.at,
      lastError: 'boom',
      lastSync: stamp,
    });
  });

  it('ignores an unreadable stamp', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-sync-'));
    mkdirSync(join(dir, '.ai-sdlc/state'), { recursive: true });
    writeFileSync(join(dir, SYNC_STAMP_PATH), '{not json');
    expect(readSyncStamp(dir)).toBeNull();
  });
});
