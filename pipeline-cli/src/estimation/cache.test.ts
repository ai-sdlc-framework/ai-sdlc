/**
 * Class-assignment cache tests — RFC-0016 Phase 2 (AISDLC-280).
 *
 * Covers:
 *  - First call → assigner runs + cache file is created.
 *  - Second call with same `(title, description)` → assigner NOT run.
 *  - Title or description change → cache invalidates + assigner re-runs.
 *  - `readCacheEntry` returns the persisted row (or undefined).
 *  - Cache file is best-effort: malformed JSON / unknown version → empty.
 *  - Different `taskId` doesn't collide with an existing entry.
 *  - Per-repo isolation via `artifactsDir`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assignClassCached, readCacheEntry, type CacheFile } from './cache.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'class-cache-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('assignClassCached — first call', () => {
  it('runs the assigner and writes a cache row', () => {
    const assigner = vi.fn(() => ({ taskClass: 'bug' as const, source: 'heuristic' as const }));
    const out = assignClassCached({
      taskId: 'AISDLC-1',
      title: 'fix: null deref in PaymentValidator',
      description: 'PaymentValidator.validate() crashes when amount is null',
      artifactsDir: workdir,
      assigner,
    });
    expect(assigner).toHaveBeenCalledTimes(1);
    expect(out.cached).toBe(false);
    expect(out.taskClass).toBe('bug');
    expect(out.source).toBe('heuristic');
    expect(out.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(existsSync(join(workdir, '_estimates', 'class-assignments.json'))).toBe(true);
  });

  it('passes frontmatterClass through to the assigner when provided', () => {
    const assigner = vi.fn(() => ({ taskClass: 'chore' as const, source: 'frontmatter' as const }));
    assignClassCached({
      taskId: 'AISDLC-2',
      title: 'bump deps',
      description: '',
      frontmatterClass: 'chore',
      artifactsDir: workdir,
      assigner,
    });
    expect(assigner).toHaveBeenCalledWith({ frontmatterClass: 'chore', title: 'bump deps' });
  });

  it('omits frontmatterClass from the assigner input when undefined', () => {
    const assigner = vi.fn(() => ({ taskClass: 'feature' as const, source: 'heuristic' as const }));
    assignClassCached({
      taskId: 'AISDLC-3',
      title: 'feat: add widget',
      description: '',
      artifactsDir: workdir,
      assigner,
    });
    expect(assigner).toHaveBeenCalledWith({ title: 'feat: add widget' });
  });
});

describe('assignClassCached — cache hit', () => {
  it('returns the cached row without invoking the assigner', () => {
    const assigner = vi.fn(() => ({ taskClass: 'bug' as const, source: 'heuristic' as const }));
    assignClassCached({
      taskId: 'AISDLC-1',
      title: 'fix: x',
      description: 'd',
      artifactsDir: workdir,
      assigner,
    });
    expect(assigner).toHaveBeenCalledTimes(1);

    const second = assignClassCached({
      taskId: 'AISDLC-1',
      title: 'fix: x',
      description: 'd',
      artifactsDir: workdir,
      assigner,
    });
    expect(assigner).toHaveBeenCalledTimes(1); // not re-invoked
    expect(second.cached).toBe(true);
    expect(second.taskClass).toBe('bug');
  });

  it('is case-insensitive on taskId', () => {
    const assigner = vi.fn(() => ({ taskClass: 'bug' as const, source: 'heuristic' as const }));
    assignClassCached({
      taskId: 'AISDLC-7',
      title: 't',
      description: 'd',
      artifactsDir: workdir,
      assigner,
    });
    const second = assignClassCached({
      taskId: 'aisdlc-7',
      title: 't',
      description: 'd',
      artifactsDir: workdir,
      assigner,
    });
    expect(second.cached).toBe(true);
    expect(assigner).toHaveBeenCalledTimes(1);
  });

  it('different taskId does NOT collide with the existing entry', () => {
    const assigner = vi
      .fn()
      .mockReturnValueOnce({ taskClass: 'bug' as const, source: 'heuristic' as const })
      .mockReturnValueOnce({ taskClass: 'chore' as const, source: 'heuristic' as const });
    assignClassCached({
      taskId: 'AISDLC-1',
      title: 't1',
      description: 'd',
      artifactsDir: workdir,
      assigner,
    });
    const b = assignClassCached({
      taskId: 'AISDLC-2',
      title: 't2',
      description: 'd',
      artifactsDir: workdir,
      assigner,
    });
    expect(b.cached).toBe(false);
    expect(b.taskClass).toBe('chore');
    expect(assigner).toHaveBeenCalledTimes(2);
  });
});

describe('assignClassCached — cache invalidation', () => {
  it('re-runs the assigner when the title changes', () => {
    const assigner = vi.fn(() => ({ taskClass: 'feature' as const, source: 'heuristic' as const }));
    assignClassCached({
      taskId: 'AISDLC-1',
      title: 'feat: original',
      description: 'd',
      artifactsDir: workdir,
      assigner,
    });
    const after = assignClassCached({
      taskId: 'AISDLC-1',
      title: 'feat: changed',
      description: 'd',
      artifactsDir: workdir,
      assigner,
    });
    expect(assigner).toHaveBeenCalledTimes(2);
    expect(after.cached).toBe(false);
  });

  it('re-runs the assigner when the description changes', () => {
    const assigner = vi.fn(() => ({ taskClass: 'feature' as const, source: 'heuristic' as const }));
    assignClassCached({
      taskId: 'AISDLC-1',
      title: 't',
      description: 'original',
      artifactsDir: workdir,
      assigner,
    });
    const after = assignClassCached({
      taskId: 'AISDLC-1',
      title: 't',
      description: 'changed',
      artifactsDir: workdir,
      assigner,
    });
    expect(assigner).toHaveBeenCalledTimes(2);
    expect(after.cached).toBe(false);
  });

  it('overwrites the cached row with the fresh assignment', () => {
    const assigner = vi
      .fn()
      .mockReturnValueOnce({ taskClass: 'bug' as const, source: 'heuristic' as const })
      .mockReturnValueOnce({ taskClass: 'feature' as const, source: 'heuristic' as const });
    assignClassCached({
      taskId: 'AISDLC-1',
      title: 't1',
      description: 'd',
      artifactsDir: workdir,
      assigner,
    });
    assignClassCached({
      taskId: 'AISDLC-1',
      title: 't2', // different — triggers re-assign
      description: 'd',
      artifactsDir: workdir,
      assigner,
    });
    const entry = readCacheEntry('AISDLC-1', workdir);
    expect(entry?.taskClass).toBe('feature');
  });
});

describe('readCacheEntry', () => {
  it('returns the persisted row', () => {
    assignClassCached({
      taskId: 'AISDLC-1',
      title: 't',
      description: 'd',
      artifactsDir: workdir,
      assigner: () => ({ taskClass: 'chore', source: 'heuristic' }),
    });
    const entry = readCacheEntry('AISDLC-1', workdir);
    expect(entry).toBeDefined();
    expect(entry?.taskClass).toBe('chore');
    expect(entry?.source).toBe('heuristic');
    expect(entry?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('returns undefined for an unknown taskId', () => {
    expect(readCacheEntry('AISDLC-NEVER', workdir)).toBeUndefined();
  });
});

describe('assignClassCached — best-effort resilience', () => {
  it('treats a malformed cache file as empty', () => {
    const path = join(workdir, '_estimates', 'class-assignments.json');
    // pre-create with broken JSON
    mkdirSync(join(workdir, '_estimates'), { recursive: true });
    writeFileSync(path, '{ this is not json', 'utf8');

    const assigner = vi.fn(() => ({ taskClass: 'feature' as const, source: 'heuristic' as const }));
    const out = assignClassCached({
      taskId: 'AISDLC-1',
      title: 't',
      description: 'd',
      artifactsDir: workdir,
      assigner,
    });
    expect(out.cached).toBe(false);
    expect(assigner).toHaveBeenCalledTimes(1);
    // The next call should hit the cache because the writer recovered.
    const second = assignClassCached({
      taskId: 'AISDLC-1',
      title: 't',
      description: 'd',
      artifactsDir: workdir,
      assigner,
    });
    expect(second.cached).toBe(true);
  });

  it('rejects a cache file with an unknown version (starts fresh)', () => {
    const path = join(workdir, '_estimates', 'class-assignments.json');
    mkdirSync(join(workdir, '_estimates'), { recursive: true });
    const file: CacheFile = {
      version: 99 as unknown as 1,
      tasks: {
        'aisdlc-1': {
          taskClass: 'bug',
          source: 'heuristic',
          contentHash: 'sha256:deadbeef',
          ts: '2026-05-16T00:00:00.000Z',
        },
      },
    };
    writeFileSync(path, JSON.stringify(file), 'utf8');

    const assigner = vi.fn(() => ({ taskClass: 'feature' as const, source: 'heuristic' as const }));
    const out = assignClassCached({
      taskId: 'AISDLC-1',
      title: 't',
      description: 'd',
      artifactsDir: workdir,
      assigner,
    });
    expect(out.cached).toBe(false);
    expect(assigner).toHaveBeenCalledTimes(1);
  });

  it('uses the injected clock for the stored ts', () => {
    const fixed = new Date('2026-05-16T12:34:56.789Z');
    assignClassCached({
      taskId: 'AISDLC-1',
      title: 't',
      description: 'd',
      artifactsDir: workdir,
      now: () => fixed,
      assigner: () => ({ taskClass: 'chore', source: 'heuristic' }),
    });
    const raw = readFileSync(join(workdir, '_estimates', 'class-assignments.json'), 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    expect(parsed.tasks['aisdlc-1']?.ts).toBe('2026-05-16T12:34:56.789Z');
  });
});

describe('artifacts-dir isolation', () => {
  it('two separate dirs maintain separate caches', () => {
    const a = mkdtempSync(join(tmpdir(), 'class-cache-a-'));
    const b = mkdtempSync(join(tmpdir(), 'class-cache-b-'));
    try {
      const assigner = vi.fn(() => ({ taskClass: 'bug' as const, source: 'heuristic' as const }));
      assignClassCached({
        taskId: 'AISDLC-1',
        title: 't',
        description: 'd',
        artifactsDir: a,
        assigner,
      });
      const inB = assignClassCached({
        taskId: 'AISDLC-1',
        title: 't',
        description: 'd',
        artifactsDir: b,
        assigner,
      });
      // Cache miss in dir B even though A already has the row.
      expect(inB.cached).toBe(false);
      expect(assigner).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
