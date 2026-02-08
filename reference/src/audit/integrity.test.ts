import { describe, it, expect } from 'vitest';
import { createAuditLog, computeEntryHash } from './logger.js';

describe('Tamper-evident audit log', () => {
  it('every entry has a hash', () => {
    const log = createAuditLog();
    log.record({ actor: 'agent-a', action: 'execute', resource: 'r1', decision: 'allowed' });
    log.record({ actor: 'agent-b', action: 'promote', resource: 'r2', decision: 'allowed' });

    for (const entry of log.entries()) {
      expect(entry.hash).toBeDefined();
      expect(typeof entry.hash).toBe('string');
      expect(entry.hash!.length).toBe(64); // SHA-256 hex
    }
  });

  it('chain links: each entry references previous hash', () => {
    const log = createAuditLog();
    log.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });
    log.record({ actor: 'b', action: 'y', resource: 'r', decision: 'denied' });
    log.record({ actor: 'c', action: 'z', resource: 'r', decision: 'allowed' });

    const entries = log.entries();
    expect(entries[0].previousHash).toBeUndefined();
    expect(entries[1].previousHash).toBe(entries[0].hash);
    expect(entries[2].previousHash).toBe(entries[1].hash);
  });

  it('tamper detection: modifying middle entry breaks chain', () => {
    const log = createAuditLog();
    log.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });
    log.record({ actor: 'b', action: 'y', resource: 'r', decision: 'denied' });
    log.record({ actor: 'c', action: 'z', resource: 'r', decision: 'allowed' });

    expect(log.verifyIntegrity()).toEqual({ valid: true });

    // Tamper with the middle entry by replacing it in the internal array
    const entries = log.entries() as unknown as { hash: string; actor: string }[];
    const tampered = { ...entries[1], actor: 'hacker', hash: 'fake-hash' };
    (entries as unknown[])[1] = tampered;

    const result = log.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it('empty log is valid', () => {
    const log = createAuditLog();
    expect(log.verifyIntegrity()).toEqual({ valid: true });
  });

  it('single entry log is valid', () => {
    const log = createAuditLog();
    log.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });
    expect(log.verifyIntegrity()).toEqual({ valid: true });
  });

  it('verify after multiple records succeeds', () => {
    const log = createAuditLog();
    for (let i = 0; i < 10; i++) {
      log.record({
        actor: `agent-${i}`,
        action: 'execute',
        resource: `r${i}`,
        decision: 'allowed',
      });
    }
    expect(log.verifyIntegrity()).toEqual({ valid: true });
    expect(log.entries()).toHaveLength(10);
  });

  it('computeEntryHash produces consistent results', () => {
    const entry = {
      id: 'test-1',
      timestamp: '2025-01-01T00:00:00.000Z',
      actor: 'agent',
      action: 'execute',
      resource: 'r1',
      decision: 'allowed' as const,
    };
    const h1 = computeEntryHash(entry, undefined);
    const h2 = computeEntryHash(entry, undefined);
    expect(h1).toBe(h2);
  });

  it('computeEntryHash differs with different previousHash', () => {
    const entry = {
      id: 'test-1',
      timestamp: '2025-01-01T00:00:00.000Z',
      actor: 'agent',
      action: 'execute',
      resource: 'r1',
      decision: 'allowed' as const,
    };
    const h1 = computeEntryHash(entry, undefined);
    const h2 = computeEntryHash(entry, 'abc123');
    expect(h1).not.toBe(h2);
  });
});
