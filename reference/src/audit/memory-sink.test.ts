import { describe, it, expect } from 'vitest';
import { createInMemoryAuditSink } from './memory-sink.js';
import type { AuditEntry } from './types.js';

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'entry-1',
    timestamp: '2026-02-10T00:00:00Z',
    actor: 'agent-1',
    action: 'execute',
    resource: 'pipeline/test',
    decision: 'allowed',
    ...overrides,
  };
}

describe('InMemoryAuditSink', () => {
  it('stores written entries', () => {
    const sink = createInMemoryAuditSink();
    const entry = makeEntry();
    sink.write(entry);
    expect(sink.getEntryCount()).toBe(1);
    expect(sink.getEntries()[0]).toBe(entry);
  });

  it('stores multiple entries', () => {
    const sink = createInMemoryAuditSink();
    sink.write(makeEntry({ id: 'e1' }));
    sink.write(makeEntry({ id: 'e2' }));
    sink.write(makeEntry({ id: 'e3' }));
    expect(sink.getEntryCount()).toBe(3);
  });

  it('queries by actor', async () => {
    const sink = createInMemoryAuditSink();
    sink.write(makeEntry({ id: 'e1', actor: 'alice' }));
    sink.write(makeEntry({ id: 'e2', actor: 'bob' }));
    sink.write(makeEntry({ id: 'e3', actor: 'alice' }));
    const results = await sink.query!({ actor: 'alice' });
    expect(results).toHaveLength(2);
  });

  it('queries by decision', async () => {
    const sink = createInMemoryAuditSink();
    sink.write(makeEntry({ id: 'e1', decision: 'allowed' }));
    sink.write(makeEntry({ id: 'e2', decision: 'denied' }));
    const results = await sink.query!({ decision: 'denied' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('e2');
  });

  it('queries by time range', async () => {
    const sink = createInMemoryAuditSink();
    sink.write(makeEntry({ id: 'e1', timestamp: '2026-02-09T00:00:00Z' }));
    sink.write(makeEntry({ id: 'e2', timestamp: '2026-02-10T12:00:00Z' }));
    sink.write(makeEntry({ id: 'e3', timestamp: '2026-02-11T00:00:00Z' }));
    const results = await sink.query!({ from: '2026-02-10T00:00:00Z', to: '2026-02-10T23:59:59Z' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('e2');
  });

  it('rotates by clearing entries', async () => {
    const sink = createInMemoryAuditSink();
    sink.write(makeEntry());
    sink.write(makeEntry({ id: 'e2' }));
    expect(sink.getEntryCount()).toBe(2);
    await sink.rotate!();
    expect(sink.getEntryCount()).toBe(0);
  });

  it('throws after close', async () => {
    const sink = createInMemoryAuditSink();
    await sink.close!();
    expect(() => sink.write(makeEntry())).toThrow('closed');
  });

  it('returns empty results for non-matching query', async () => {
    const sink = createInMemoryAuditSink();
    sink.write(makeEntry({ actor: 'alice' }));
    const results = await sink.query!({ actor: 'bob' });
    expect(results).toHaveLength(0);
  });
});
