import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSqliteAuditSink } from './audit-sqlite-sink.js';
import { StateStore } from './state/index.js';
import type { AuditEntry } from '@ai-sdlc/reference';
import Database from 'better-sqlite3';

let store: StateStore;
let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  store = StateStore.open(db);
});

afterEach(() => {
  store.close();
});

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: `audit-${Date.now()}-${Math.random()}`,
    timestamp: new Date().toISOString(),
    actor: 'agent-1',
    action: 'execute',
    resource: 'pipeline/build',
    decision: 'allowed',
    hash: 'abc123',
    previousHash: undefined,
    ...overrides,
  };
}

describe('SqliteAuditSink', () => {
  it('writes an audit entry to the store', () => {
    const sink = createSqliteAuditSink(store);

    const entry = makeEntry();
    sink.write(entry);

    const stored = store.getAuditEntry(entry.id);
    expect(stored).toBeDefined();
    expect(stored!.actor).toBe('agent-1');
    expect(stored!.action).toBe('execute');
    expect(stored!.hash).toBe('abc123');
  });

  it('writes entry details as JSON', () => {
    const sink = createSqliteAuditSink(store);

    const entry = makeEntry({
      details: { filesChanged: 5, branch: 'feature/test' },
    });
    sink.write(entry);

    const stored = store.getAuditEntry(entry.id);
    expect(stored!.detail).toBe('{"filesChanged":5,"branch":"feature/test"}');
  });

  it('queries entries by actor', async () => {
    const sink = createSqliteAuditSink(store);

    sink.write(makeEntry({ id: 'e1', actor: 'agent-1' }));
    sink.write(makeEntry({ id: 'e2', actor: 'agent-2' }));
    sink.write(makeEntry({ id: 'e3', actor: 'agent-1' }));

    const results = await sink.query!({ actor: 'agent-1' });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.actor === 'agent-1')).toBe(true);
  });

  it('queries entries by action', async () => {
    const sink = createSqliteAuditSink(store);

    sink.write(makeEntry({ id: 'e1', action: 'deploy' }));
    sink.write(makeEntry({ id: 'e2', action: 'execute' }));
    sink.write(makeEntry({ id: 'e3', action: 'deploy' }));

    const results = await sink.query!({ action: 'deploy' });
    expect(results).toHaveLength(2);
  });

  it('queries entries by resource', async () => {
    const sink = createSqliteAuditSink(store);

    sink.write(makeEntry({ id: 'e1', resource: 'pipeline/build' }));
    sink.write(makeEntry({ id: 'e2', resource: 'pipeline/deploy' }));
    sink.write(makeEntry({ id: 'e3', resource: 'gate/quality' }));

    const results = await sink.query!({ resource: 'pipeline/build' });
    expect(results).toHaveLength(1);
    expect(results[0].resource).toBe('pipeline/build');
  });

  it('queries entries by time range', async () => {
    const sink = createSqliteAuditSink(store);

    sink.write(makeEntry({ id: 'e1', timestamp: '2025-01-01T00:00:00Z' }));
    sink.write(makeEntry({ id: 'e2', timestamp: '2025-06-15T00:00:00Z' }));
    sink.write(makeEntry({ id: 'e3', timestamp: '2025-12-31T00:00:00Z' }));

    const results = await sink.query!({ from: '2025-06-01T00:00:00Z', to: '2025-12-31T23:59:59Z' });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty for no matches', async () => {
    const sink = createSqliteAuditSink(store);

    sink.write(makeEntry({ id: 'e1', actor: 'agent-1' }));

    const results = await sink.query!({ actor: 'nonexistent' });
    expect(results).toHaveLength(0);
  });

  it('preserves hash chain fields', () => {
    const sink = createSqliteAuditSink(store);

    const entry = makeEntry({ hash: 'hash1', previousHash: 'hash0' });
    sink.write(entry);

    const stored = store.getAuditEntry(entry.id);
    expect(stored!.hash).toBe('hash1');
    expect(stored!.previousHash).toBe('hash0');
  });

  it('handles entries without details', () => {
    const sink = createSqliteAuditSink(store);

    const entry = makeEntry({ details: undefined });
    sink.write(entry);

    const stored = store.getAuditEntry(entry.id);
    expect(stored!.detail).toBeFalsy();
  });
});
