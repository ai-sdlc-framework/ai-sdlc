import { describe, it, expect, afterEach } from 'vitest';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAuditLog } from './logger.js';
import {
  createFileSink,
  loadEntriesFromFile,
  verifyFileIntegrity,
  rotateAuditFile,
} from './file-sink.js';

const testDir = join(import.meta.dirname ?? '.', '..', '..', '.test-tmp');
const testFile = join(testDir, 'audit-test.jsonl');
const cleanupFiles: string[] = [];

function cleanup() {
  for (const f of [testFile, ...cleanupFiles]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      // ignore
    }
  }
  cleanupFiles.length = 0;
}

afterEach(cleanup);

describe('createFileSink', () => {
  it('writes entries to JSONL file', () => {
    const sink = createFileSink(testFile);
    const log = createAuditLog(sink);

    log.record({ actor: 'agent-a', action: 'execute', resource: 'r1', decision: 'allowed' });
    log.record({ actor: 'agent-b', action: 'promote', resource: 'r2', decision: 'denied' });

    const entries = loadEntriesFromFile(testFile);
    expect(entries).toHaveLength(2);
    expect(entries[0].actor).toBe('agent-a');
    expect(entries[1].actor).toBe('agent-b');
  });

  it('entries have hash chain', () => {
    const sink = createFileSink(testFile);
    const log = createAuditLog(sink);

    log.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });
    log.record({ actor: 'b', action: 'y', resource: 'r', decision: 'allowed' });

    const entries = loadEntriesFromFile(testFile);
    expect(entries[0].hash).toBeTruthy();
    expect(entries[1].previousHash).toBe(entries[0].hash);
  });
});

describe('loadEntriesFromFile', () => {
  it('returns empty array for non-existent file', () => {
    expect(loadEntriesFromFile('/tmp/nonexistent-audit.jsonl')).toEqual([]);
  });
});

describe('verifyFileIntegrity', () => {
  it('valid file passes integrity check', () => {
    const sink = createFileSink(testFile);
    const log = createAuditLog(sink);

    for (let i = 0; i < 5; i++) {
      log.record({ actor: `agent-${i}`, action: 'test', resource: 'r', decision: 'allowed' });
    }

    expect(verifyFileIntegrity(testFile)).toEqual({ valid: true });
  });

  it('empty file is valid', () => {
    expect(verifyFileIntegrity('/tmp/nonexistent-audit.jsonl')).toEqual({ valid: true });
  });
});

describe('rotateAuditFile', () => {
  it('rotates file and creates empty replacement', () => {
    const sink = createFileSink(testFile);
    const log = createAuditLog(sink);

    log.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });

    const rotatedPath = rotateAuditFile(testFile);
    cleanupFiles.push(rotatedPath);

    // Original file should be empty
    const entries = loadEntriesFromFile(testFile);
    expect(entries).toHaveLength(0);

    // Rotated file should have the entry
    const rotatedEntries = loadEntriesFromFile(rotatedPath);
    expect(rotatedEntries).toHaveLength(1);
    expect(rotatedEntries[0].actor).toBe('a');
  });
});
