import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveEntries, loadArchivedEntries, verifyArchiveContinuity } from './audit-archival.js';
import { createAuditLog } from '@ai-sdlc/reference';
import type { AuditEntry } from '@ai-sdlc/reference';

let archiveDir: string;

beforeEach(() => {
  archiveDir = mkdtempSync(join(tmpdir(), 'audit-archive-'));
});

afterEach(() => {
  rmSync(archiveDir, { recursive: true, force: true });
});

function createTestEntries(count: number, baseTime: number): AuditEntry[] {
  const log = createAuditLog();
  for (let i = 0; i < count; i++) {
    log.record({
      actor: `agent-${i}`,
      action: 'execute',
      resource: `pipeline/run-${i}`,
      decision: 'allowed',
      timestamp: new Date(baseTime + i * 1000).toISOString(),
    });
  }
  return [...log.entries()];
}

describe('archiveEntries', () => {
  it('archives entries older than cutoff', async () => {
    const now = Date.now();
    const entries = createTestEntries(5, now - 10_000); // 10s ago

    const result = await archiveEntries(entries, {
      olderThanMs: 5000, // archive entries older than 5s
      archiveDir,
    });

    // Some entries should be archived, some remain
    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.entryCount).toBeGreaterThan(0);
    expect(result.remaining.length).toBeLessThan(entries.length);
  });

  it('returns null manifest when nothing to archive', async () => {
    const entries = createTestEntries(3, Date.now()); // all recent

    const result = await archiveEntries(entries, {
      olderThanMs: 1000,
      archiveDir,
    });

    expect(result.manifest).toBeNull();
    expect(result.remaining).toHaveLength(3);
  });

  it('creates gzipped archive file', async () => {
    const entries = createTestEntries(5, Date.now() - 60_000); // 1 minute ago

    const result = await archiveEntries(entries, {
      olderThanMs: 1000,
      archiveDir,
    });

    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.archivePath).toMatch(/\.jsonl\.gz$/);
  });

  it('manifest contains correct metadata', async () => {
    const baseTime = Date.now() - 60_000;
    const entries = createTestEntries(5, baseTime);

    const result = await archiveEntries(entries, {
      olderThanMs: 1000,
      archiveDir,
    });

    const m = result.manifest!;
    expect(m.archiveId).toMatch(/^archive-/);
    expect(m.entryCount).toBe(5);
    expect(m.firstTimestamp).toBeTruthy();
    expect(m.lastTimestamp).toBeTruthy();
    expect(m.firstHash).toBeTruthy();
    expect(m.lastHash).toBeTruthy();
    expect(m.archivedAt).toBeTruthy();
  });
});

describe('loadArchivedEntries', () => {
  it('loads entries from gzipped archive', async () => {
    const entries = createTestEntries(5, Date.now() - 60_000);

    const result = await archiveEntries(entries, {
      olderThanMs: 1000,
      archiveDir,
    });

    const loaded = await loadArchivedEntries(result.manifest!.archivePath);

    expect(loaded).toHaveLength(5);
    expect(loaded[0].actor).toBe('agent-0');
    expect(loaded[4].actor).toBe('agent-4');
  });

  it('returns empty array for missing file', async () => {
    const loaded = await loadArchivedEntries('/nonexistent/path.jsonl.gz');
    expect(loaded).toHaveLength(0);
  });
});

describe('verifyArchiveContinuity', () => {
  it('verifies chain continuity between archive and remaining entries', async () => {
    const baseTime = Date.now() - 60_000;
    const log = createAuditLog();

    // Create entries — first 3 will be "archived", last 2 remain
    for (let i = 0; i < 5; i++) {
      log.record({
        actor: `agent-${i}`,
        action: 'execute',
        resource: `pipeline/${i}`,
        decision: 'allowed',
        timestamp: new Date(baseTime + i * 10_000).toISOString(),
      });
    }

    const allEntries = [...log.entries()];
    const archiveManifest = {
      archiveId: 'test',
      entryCount: 3,
      firstTimestamp: allEntries[0].timestamp,
      lastTimestamp: allEntries[2].timestamp,
      firstHash: allEntries[0].hash ?? '',
      lastHash: allEntries[2].hash ?? '',
      archivedAt: new Date().toISOString(),
      archivePath: '/tmp/test.jsonl.gz',
    };

    const firstRemaining = allEntries[3];
    const valid = verifyArchiveContinuity(archiveManifest, firstRemaining);
    expect(valid).toBe(true);
  });

  it('returns true when no remaining entries', () => {
    const manifest = {
      archiveId: 'test',
      entryCount: 5,
      firstTimestamp: '',
      lastTimestamp: '',
      firstHash: 'abc',
      lastHash: 'xyz',
      archivedAt: new Date().toISOString(),
      archivePath: '/tmp/test.jsonl.gz',
    };

    expect(verifyArchiveContinuity(manifest, undefined)).toBe(true);
  });

  it('returns false when chain is broken', () => {
    const manifest = {
      archiveId: 'test',
      entryCount: 3,
      firstTimestamp: '',
      lastTimestamp: '',
      firstHash: 'abc',
      lastHash: 'wrong-hash',
      archivedAt: new Date().toISOString(),
      archivePath: '/tmp/test.jsonl.gz',
    };

    const entry = {
      id: 'e4',
      timestamp: '',
      actor: 'a',
      action: 'x',
      resource: 'r',
      decision: 'allowed' as const,
      previousHash: 'correct-hash',
    };

    expect(verifyArchiveContinuity(manifest, entry)).toBe(false);
  });
});
