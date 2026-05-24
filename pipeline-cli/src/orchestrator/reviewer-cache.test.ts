/**
 * Hermetic tests for the reviewer-pass cache (AISDLC-418).
 *
 * Coverage targets:
 *   - Empty cache → no-cache-entry
 *   - File-coverage overlap → file-coverage-overlap
 *   - TTL expiry → ttl-expired
 *   - Agent-hash change → agent-hash-changed
 *   - Stable file lists hash identically regardless of order
 *   - Save+check round-trip on the happy path
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkReviewerCache,
  computeAgentFileHash,
  computeFilesFingerprint,
  DEFAULT_CACHE_TTL_HOURS,
  reviewerCachePath,
  saveReviewerCache,
} from './reviewer-cache.js';

describe('reviewer-cache', () => {
  let workDir: string;
  let agentFile: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'reviewer-cache-'));
    agentFile = path.join(workDir, 'agent.md');
    writeFileSync(agentFile, '# code-reviewer\nrules: ...\n', 'utf8');
  });

  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('computeFilesFingerprint', () => {
    it('returns the same hash for differently-ordered file lists', () => {
      const a = computeFilesFingerprint(['b.ts', 'a.ts', 'c.ts']);
      const b = computeFilesFingerprint(['c.ts', 'a.ts', 'b.ts']);
      expect(a).toBe(b);
      expect(a).toHaveLength(64);
    });

    it('treats empty + whitespace entries as no-ops', () => {
      const a = computeFilesFingerprint(['a.ts', '', '  ', 'b.ts']);
      const b = computeFilesFingerprint(['a.ts', 'b.ts']);
      expect(a).toBe(b);
    });
  });

  describe('computeAgentFileHash', () => {
    it('returns SHA-256 hex when file exists', () => {
      const h = computeAgentFileHash(agentFile);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns sentinel when file is missing', () => {
      const h = computeAgentFileHash(path.join(workDir, 'nope.md'));
      expect(h).toBe('missing-agent-file');
    });
  });

  describe('reviewerCachePath', () => {
    it('lowercases the task ID component', () => {
      const p = reviewerCachePath(workDir, 'AISDLC-418', 'code-reviewer');
      expect(p).toBe(
        path.join(workDir, '.ai-sdlc', 'verdicts', 'cache', 'aisdlc-418', 'code-reviewer.json'),
      );
    });
  });

  describe('checkReviewerCache + saveReviewerCache', () => {
    it('miss on empty cache', () => {
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: ['src/foo.ts'],
        agentFilePath: agentFile,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('no-cache-entry');
    });

    it('hit on round-trip with disjoint files', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: ['src/a.ts', 'src/b.ts'],
        agentFilePath: agentFile,
        verdict: { approved: true, findings: { critical: 0, major: 0, minor: 0, suggestion: 0 } },
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: ['src/c.ts', 'src/d.ts'],
        agentFilePath: agentFile,
      });
      expect(result.hit).toBe(true);
      expect(result.reason).toBeNull();
      expect(result.entry?.verdict.approved).toBe(true);
    });

    it('miss when ANY current file overlaps prior coverage', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: ['src/a.ts', 'src/b.ts'],
        agentFilePath: agentFile,
        verdict: { approved: true },
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: ['src/b.ts', 'src/c.ts'],
        agentFilePath: agentFile,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('file-coverage-overlap');
    });

    it('miss after TTL expiry', () => {
      const cachedAt = new Date(
        Date.now() - (DEFAULT_CACHE_TTL_HOURS + 1) * 3600_000,
      ).toISOString();
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: ['src/a.ts'],
        agentFilePath: agentFile,
        verdict: { approved: true },
        cachedAt,
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: ['src/b.ts'],
        agentFilePath: agentFile,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('ttl-expired');
    });

    it('hit within TTL window', () => {
      const cachedAt = new Date(Date.now() - 1000).toISOString();
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: ['src/a.ts'],
        agentFilePath: agentFile,
        verdict: { approved: true },
        cachedAt,
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: ['src/b.ts'],
        agentFilePath: agentFile,
        ttlHours: 2,
      });
      expect(result.hit).toBe(true);
    });

    it('miss when reviewer agent .md changes', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: ['src/a.ts'],
        agentFilePath: agentFile,
        verdict: { approved: true },
      });
      // Mutate the agent file → its hash changes → cache invalidates.
      writeFileSync(agentFile, '# code-reviewer v2\nrules: NEW\n', 'utf8');
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: ['src/b.ts'],
        agentFilePath: agentFile,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('agent-hash-changed');
    });

    it('miss when cache file is malformed JSON', () => {
      const cachePath = reviewerCachePath(workDir, 'AISDLC-418', 'code-reviewer');
      // Need to ensure the dir exists.
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: ['src/a.ts'],
        agentFilePath: agentFile,
        verdict: { approved: true },
      });
      writeFileSync(cachePath, '{not valid json', 'utf8');
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: ['src/b.ts'],
        agentFilePath: agentFile,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('malformed-cache');
    });

    it('save overwrites prior entry for the same (task, reviewer)', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: ['src/a.ts'],
        agentFilePath: agentFile,
        verdict: { approved: true, findings: { critical: 0 } },
      });
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: ['src/b.ts'],
        agentFilePath: agentFile,
        verdict: { approved: false, findings: { critical: 1 } },
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: ['src/c.ts'],
        agentFilePath: agentFile,
      });
      expect(result.hit).toBe(true);
      expect(result.entry?.verdict.approved).toBe(false);
    });

    it('per-reviewer entries are independent (saving code-reviewer leaves test-reviewer untouched)', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: ['src/a.ts'],
        agentFilePath: agentFile,
        verdict: { approved: true },
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'test-reviewer',
        currentFiles: ['src/b.ts'],
        agentFilePath: agentFile,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('no-cache-entry');
    });
  });
});
