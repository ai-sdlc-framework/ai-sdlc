import { describe, it, expect } from 'vitest';
import {
  createFileAuditLog,
  computeAuditHash,
  // Re-exports
  computeEntryHash,
  createFileSink,
  createAuditLog,
} from './audit-extended.js';
import type { AuditEntry } from '@ai-sdlc/reference';

describe('Extended audit', () => {
  describe('createFileAuditLog()', () => {
    it('creates an audit log backed by a file sink', () => {
      const log = createFileAuditLog('/tmp/test-audit.jsonl');
      expect(log).toBeDefined();
      expect(typeof log.record).toBe('function');
      expect(typeof log.query).toBe('function');
    });
  });

  describe('computeAuditHash()', () => {
    it('computes a hash for an audit entry', () => {
      const entry: AuditEntry = {
        id: 'test-1',
        timestamp: new Date().toISOString(),
        action: 'gate.evaluated',
        actor: 'pipeline',
        resource: 'test-resource',
        decision: 'allowed',
      };
      const hash = computeAuditHash(entry);
      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(0);
    });

    it('produces different hashes for different entries', () => {
      const e1: AuditEntry = {
        id: 'test-1',
        timestamp: '2025-01-01T00:00:00Z',
        action: 'gate.evaluated',
        actor: 'agent-a',
        resource: 'resource-1',
        decision: 'allowed',
      };
      const e2: AuditEntry = {
        id: 'test-2',
        timestamp: '2025-01-01T00:00:01Z',
        action: 'gate.evaluated',
        actor: 'agent-b',
        resource: 'resource-2',
        decision: 'denied',
      };
      expect(computeAuditHash(e1)).not.toBe(computeAuditHash(e2));
    });

    it('chains hashes with previousHash', () => {
      const entry: AuditEntry = {
        id: 'test-1',
        timestamp: '2025-01-01T00:00:00Z',
        action: 'gate.evaluated',
        actor: 'pipeline',
        resource: 'res',
        decision: 'allowed',
      };
      const h1 = computeAuditHash(entry);
      const h2 = computeAuditHash(entry, 'prev-hash');
      expect(h1).not.toBe(h2);
    });
  });

  describe('reference re-exports', () => {
    it('computeEntryHash computes hash', () => {
      expect(typeof computeEntryHash).toBe('function');
    });

    it('createFileSink creates a sink', () => {
      const sink = createFileSink('/tmp/test-sink.jsonl');
      expect(sink).toBeDefined();
      expect(typeof sink.write).toBe('function');
    });

    it('createAuditLog creates a log from a sink', () => {
      const sink = createFileSink('/tmp/test-log.jsonl');
      const log = createAuditLog(sink);
      expect(typeof log.record).toBe('function');
    });
  });
});
