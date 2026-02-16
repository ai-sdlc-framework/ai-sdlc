import { describe, it, expect } from 'vitest';
import {
  createSignedAuditLog,
  signEntry,
  verifySignature,
  type SigningKey,
  type SignedAuditEntry,
} from './signed-logger.js';
import { computeEntryHash } from './logger.js';
import type { AuditEntry } from './types.js';

const testKey: SigningKey = { id: 'key-1', secret: 'test-secret-key-123' };
const testKey2: SigningKey = { id: 'key-2', secret: 'another-secret-456' };

describe('SignedAuditLog', () => {
  it('signs entries with HMAC-SHA256', () => {
    const log = createSignedAuditLog(testKey);

    const entry = log.record({
      actor: 'agent-1',
      action: 'execute',
      resource: 'pipeline/build',
      decision: 'allowed',
    });

    expect(entry.signature).toBeTruthy();
    expect(entry.signature).toHaveLength(64); // SHA-256 hex
    expect(entry.keyId).toBe('key-1');
  });

  it('maintains hash chain alongside signatures', () => {
    const log = createSignedAuditLog(testKey);

    const e1 = log.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });
    const e2 = log.record({ actor: 'b', action: 'y', resource: 'r', decision: 'denied' });

    expect(e2.previousHash).toBe(e1.hash);
    expect(e1.previousHash).toBeUndefined();
  });

  it('verifies integrity of signed chain', () => {
    const log = createSignedAuditLog(testKey);

    log.record({ actor: 'agent-1', action: 'build', resource: 'pipeline/ci', decision: 'allowed' });
    log.record({ actor: 'agent-2', action: 'deploy', resource: 'pipeline/cd', decision: 'allowed' });
    log.record({ actor: 'admin', action: 'override', resource: 'gate/quality', decision: 'overridden' });

    const result = log.verifyIntegrity();

    expect(result.valid).toBe(true);
    expect(result.signaturesValid).toBe(true);
    expect(result.invalidSignatureAt).toBeUndefined();
  });

  it('detects tampered signatures', () => {
    const log = createSignedAuditLog(testKey);

    log.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });
    const entries = log.entries();

    // Tamper with the entry (bypass freeze for test)
    const tampered = { ...entries[0], signature: 'tampered-sig' } as SignedAuditEntry;
    expect(verifySignature(tampered, testKey)).toBe(false);
  });

  it('rotates signing keys', () => {
    const log = createSignedAuditLog(testKey);

    const e1 = log.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });
    expect(e1.keyId).toBe('key-1');

    log.rotateKey(testKey2);

    const e2 = log.record({ actor: 'b', action: 'y', resource: 'r', decision: 'denied' });
    expect(e2.keyId).toBe('key-2');

    // Both entries should verify
    const result = log.verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.signaturesValid).toBe(true);
  });

  it('entries are frozen', () => {
    const log = createSignedAuditLog(testKey);

    const entry = log.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });

    expect(() => {
      (entry as unknown as Record<string, unknown>).actor = 'tampered';
    }).toThrow();
  });

  it('returns all entries in order', () => {
    const log = createSignedAuditLog(testKey);

    log.record({ actor: 'a', action: '1', resource: 'r', decision: 'allowed' });
    log.record({ actor: 'b', action: '2', resource: 'r', decision: 'denied' });
    log.record({ actor: 'c', action: '3', resource: 'r', decision: 'allowed' });

    expect(log.entries()).toHaveLength(3);
    expect(log.entries()[0].actor).toBe('a');
    expect(log.entries()[2].actor).toBe('c');
  });
});

describe('signEntry / verifySignature', () => {
  it('produces consistent signatures', () => {
    const entry: AuditEntry = {
      id: 'test-id',
      timestamp: '2025-01-01T00:00:00Z',
      actor: 'agent-1',
      action: 'execute',
      resource: 'pipeline/build',
      decision: 'allowed',
      hash: 'abc123',
      previousHash: undefined,
    };

    const sig1 = signEntry(entry, testKey);
    const sig2 = signEntry(entry, testKey);

    expect(sig1).toBe(sig2);
  });

  it('different keys produce different signatures', () => {
    const entry: AuditEntry = {
      id: 'test-id',
      timestamp: '2025-01-01T00:00:00Z',
      actor: 'agent-1',
      action: 'execute',
      resource: 'pipeline/build',
      decision: 'allowed',
    };

    const sig1 = signEntry(entry, testKey);
    const sig2 = signEntry(entry, testKey2);

    expect(sig1).not.toBe(sig2);
  });

  it('verifies correct signatures', () => {
    const entry: SignedAuditEntry = {
      id: 'test-id',
      timestamp: '2025-01-01T00:00:00Z',
      actor: 'agent-1',
      action: 'execute',
      resource: 'pipeline/build',
      decision: 'allowed',
      signature: '',
      keyId: 'key-1',
    };
    // Compute the real signature
    const sig = signEntry(entry, testKey);
    const signed = { ...entry, signature: sig };

    expect(verifySignature(signed, testKey)).toBe(true);
  });
});
