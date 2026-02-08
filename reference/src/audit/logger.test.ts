import { describe, it, expect } from 'vitest';
import { createAuditLog } from './logger.js';
import type { AuditSink, AuditEntry } from './types.js';

describe('createAuditLog', () => {
  it('records an entry with generated id and timestamp', () => {
    const log = createAuditLog();
    const entry = log.record({
      actor: 'code-agent',
      action: 'execute',
      resource: 'pipeline/build',
      decision: 'allowed',
    });

    expect(entry.id).toMatch(/^audit-/);
    expect(entry.timestamp).toBeTruthy();
    expect(entry.actor).toBe('code-agent');
    expect(entry.action).toBe('execute');
    expect(entry.resource).toBe('pipeline/build');
    expect(entry.decision).toBe('allowed');
  });

  it('uses provided timestamp when given', () => {
    const log = createAuditLog();
    const entry = log.record({
      actor: 'agent',
      action: 'promote',
      resource: 'policy/autonomy',
      decision: 'allowed',
      timestamp: '2026-01-01T00:00:00Z',
    });

    expect(entry.timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('entries are immutable (frozen)', () => {
    const log = createAuditLog();
    const entry = log.record({
      actor: 'agent',
      action: 'execute',
      resource: 'pipeline/build',
      decision: 'allowed',
    });

    expect(() => {
      (entry as unknown as Record<string, unknown>).actor = 'hacked';
    }).toThrow();
  });

  it('entries() returns all recorded entries in order', () => {
    const log = createAuditLog();
    log.record({ actor: 'a', action: 'x', resource: 'r1', decision: 'allowed' });
    log.record({ actor: 'b', action: 'y', resource: 'r2', decision: 'denied' });

    const entries = log.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0].actor).toBe('a');
    expect(entries[1].actor).toBe('b');
  });

  it('stores optional policy and details', () => {
    const log = createAuditLog();
    const entry = log.record({
      actor: 'agent',
      action: 'enforce',
      resource: 'gate/coverage',
      policy: 'quality-gate/standard',
      decision: 'denied',
      details: { metric: 'coverage', actual: 70, threshold: 80 },
    });

    expect(entry.policy).toBe('quality-gate/standard');
    expect(entry.details).toEqual({ metric: 'coverage', actual: 70, threshold: 80 });
  });

  it('query() filters by actor', () => {
    const log = createAuditLog();
    log.record({ actor: 'alice', action: 'execute', resource: 'r', decision: 'allowed' });
    log.record({ actor: 'bob', action: 'execute', resource: 'r', decision: 'allowed' });
    log.record({ actor: 'alice', action: 'promote', resource: 'r', decision: 'allowed' });

    const results = log.query({ actor: 'alice' });
    expect(results).toHaveLength(2);
  });

  it('query() filters by decision', () => {
    const log = createAuditLog();
    log.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });
    log.record({ actor: 'a', action: 'x', resource: 'r', decision: 'denied' });
    log.record({ actor: 'a', action: 'x', resource: 'r', decision: 'overridden' });

    expect(log.query({ decision: 'denied' })).toHaveLength(1);
    expect(log.query({ decision: 'allowed' })).toHaveLength(1);
  });

  it('query() filters by time range', () => {
    const log = createAuditLog();
    log.record({
      actor: 'a',
      action: 'x',
      resource: 'r',
      decision: 'allowed',
      timestamp: '2026-01-01T00:00:00Z',
    });
    log.record({
      actor: 'a',
      action: 'x',
      resource: 'r',
      decision: 'allowed',
      timestamp: '2026-06-01T00:00:00Z',
    });
    log.record({
      actor: 'a',
      action: 'x',
      resource: 'r',
      decision: 'allowed',
      timestamp: '2026-12-01T00:00:00Z',
    });

    const results = log.query({ from: '2026-03-01T00:00:00Z', to: '2026-09-01T00:00:00Z' });
    expect(results).toHaveLength(1);
    expect(results[0].timestamp).toBe('2026-06-01T00:00:00Z');
  });

  it('query() combines multiple filters', () => {
    const log = createAuditLog();
    log.record({ actor: 'alice', action: 'execute', resource: 'r', decision: 'allowed' });
    log.record({ actor: 'alice', action: 'execute', resource: 'r', decision: 'denied' });
    log.record({ actor: 'bob', action: 'execute', resource: 'r', decision: 'denied' });

    const results = log.query({ actor: 'alice', decision: 'denied' });
    expect(results).toHaveLength(1);
  });

  it('calls sink.write() for each entry', () => {
    const written: AuditEntry[] = [];
    const sink: AuditSink = {
      write: (e) => {
        written.push(e);
      },
    };
    const log = createAuditLog(sink);

    log.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });
    log.record({ actor: 'b', action: 'y', resource: 'r', decision: 'denied' });

    expect(written).toHaveLength(2);
    expect(written[0].actor).toBe('a');
    expect(written[1].actor).toBe('b');
  });
});
