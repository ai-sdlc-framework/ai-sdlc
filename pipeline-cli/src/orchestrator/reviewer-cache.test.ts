/**
 * Hermetic tests for the reviewer-pass cache (AISDLC-418, iter-2).
 *
 * Coverage targets (post-iter-2 redesign):
 *   - HEAD-SHA invalidation (CRITICAL #1)
 *   - Subset + blob-SHA semantics (CRITICAL #2)
 *   - Transcript persistence + restore for v6 emit-leaf (MAJOR #3)
 *   - TTL expiry, agent-hash change, malformed JSON, schema downgrade
 *   - Save validates headSha (rejects empty / non-hex)
 *   - Normalization helpers (sort, trim, lowercase blob SHAs)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkReviewerCache,
  computeAgentFileHash,
  computeFilesFingerprint,
  DEFAULT_CACHE_TTL_HOURS,
  normalizeFileEntries,
  resolveBlobShaForPath,
  resolveBlobShasForPaths,
  restoreCachedTranscriptToWorktree,
  reviewerCachePath,
  reviewerCacheTranscriptPath,
  saveReviewerCache,
  type CacheFileEntry,
} from './reviewer-cache.js';

const HEAD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BLOB_A = '1111111111111111111111111111111111111111';
const BLOB_B = '2222222222222222222222222222222222222222';
const BLOB_C = '3333333333333333333333333333333333333333';
const BLOB_A_PRIME = '4444444444444444444444444444444444444444';

function entry(p: string, blob: string): CacheFileEntry {
  return { path: p, blobSha: blob };
}

describe('reviewer-cache (iter-2)', () => {
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

  describe('normalizeFileEntries', () => {
    it('sorts by path, trims whitespace, lowercases blob SHAs, drops empties', () => {
      const result = normalizeFileEntries([
        { path: 'src/c.ts', blobSha: 'CCCC' },
        { path: '  src/a.ts ', blobSha: ' AAAA ' },
        { path: '', blobSha: 'xxx' },
        { path: 'src/b.ts', blobSha: '' },
        { path: 'src/b.ts', blobSha: 'bbbb' },
      ]);
      expect(result).toEqual([
        { path: 'src/a.ts', blobSha: 'aaaa' },
        { path: 'src/b.ts', blobSha: 'bbbb' },
        { path: 'src/c.ts', blobSha: 'cccc' },
      ]);
    });
  });

  describe('computeFilesFingerprint', () => {
    it('produces identical hashes for differently-ordered file lists with same content', () => {
      const a = computeFilesFingerprint([entry('b.ts', BLOB_B), entry('a.ts', BLOB_A)]);
      const b = computeFilesFingerprint([entry('a.ts', BLOB_A), entry('b.ts', BLOB_B)]);
      expect(a).toBe(b);
      expect(a).toHaveLength(64);
    });

    it('produces different hashes for same paths with different blob SHAs', () => {
      const a = computeFilesFingerprint([entry('a.ts', BLOB_A)]);
      const b = computeFilesFingerprint([entry('a.ts', BLOB_A_PRIME)]);
      expect(a).not.toBe(b);
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

  describe('reviewerCachePath + reviewerCacheTranscriptPath', () => {
    it('lowercases task ID + co-locates transcript with cache JSON', () => {
      const cache = reviewerCachePath(workDir, 'AISDLC-418', 'code-reviewer');
      const transcript = reviewerCacheTranscriptPath(workDir, 'AISDLC-418', 'code-reviewer');
      expect(cache).toBe(
        path.join(workDir, '.ai-sdlc', 'verdicts', 'cache', 'aisdlc-418', 'code-reviewer.json'),
      );
      expect(transcript).toBe(
        path.join(
          workDir,
          '.ai-sdlc',
          'verdicts',
          'cache',
          'aisdlc-418',
          'code-reviewer.transcript.jsonl',
        ),
      );
    });
  });

  describe('saveReviewerCache — input validation', () => {
    it('throws when headSha is empty', () => {
      expect(() =>
        saveReviewerCache({
          workDir,
          taskId: 'AISDLC-418',
          reviewer: 'code-reviewer',
          files: [entry('a.ts', BLOB_A)],
          agentFilePath: agentFile,
          headSha: '',
          verdict: { approved: true },
        }),
      ).toThrow(/invalid headSha/);
    });

    it('throws when headSha is not hex', () => {
      expect(() =>
        saveReviewerCache({
          workDir,
          taskId: 'AISDLC-418',
          reviewer: 'code-reviewer',
          files: [entry('a.ts', BLOB_A)],
          agentFilePath: agentFile,
          headSha: 'not-a-sha',
          verdict: { approved: true },
        }),
      ).toThrow(/invalid headSha/);
    });
  });

  describe('checkReviewerCache — empty cache', () => {
    it('misses with no-cache-entry', () => {
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('no-cache-entry');
    });
  });

  describe('CRITICAL #1 — HEAD-SHA invalidation', () => {
    it('misses with head-sha-mismatch when current HEAD differs from cached HEAD', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: OTHER_SHA,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('head-sha-mismatch');
    });

    it('hits when HEAD matches AND files match', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A), entry('src/b.ts', BLOB_B)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(true);
      expect(result.reason).toBeNull();
      expect(result.entry?.verdict.approved).toBe(true);
    });

    it('misses with head-sha-mismatch when caller passes empty headSha (defense in depth)', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: '',
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('head-sha-mismatch');
    });
  });

  describe('CRITICAL #2 — subset + blob-SHA semantics', () => {
    it('HIT when current files are a SUBSET of cached files (all blobs match)', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A), entry('src/b.ts', BLOB_B), entry('src/c.ts', BLOB_C)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('src/a.ts', BLOB_A), entry('src/b.ts', BLOB_B)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(true);
    });

    it('MISS when current diff adds a NEW file not in the cached set (not-subset-of-cached-files)', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A), entry('src/b.ts', BLOB_B)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        // src/c.ts is a brand-new file the reviewer never saw — MUST miss.
        currentFiles: [entry('src/a.ts', BLOB_A), entry('src/c.ts', BLOB_C)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('not-subset-of-cached-files');
    });

    it('MISS when same file path re-touched with different blob SHA (blob-sha-mismatch)', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A), entry('src/b.ts', BLOB_B)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        // src/a.ts re-touched with new content — same path, different blob.
        currentFiles: [entry('src/a.ts', BLOB_A_PRIME)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('blob-sha-mismatch');
    });

    it('MISS when current diff is empty (degenerate guard)', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('not-subset-of-cached-files');
    });

    it('iter-1 behaviour explicitly REJECTED: disjoint-files reuse must MISS', () => {
      // The iter-1 cache returned HIT in this scenario — iter-2 redesign
      // must MISS because the reviewer never saw the c/d files.
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A), entry('src/b.ts', BLOB_B)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('src/c.ts', BLOB_C), entry('src/d.ts', BLOB_A_PRIME)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('not-subset-of-cached-files');
    });
  });

  describe('MAJOR #3 — transcript persistence + restore (v6 Merkle chain)', () => {
    it('saves the transcript alongside the cache when transcriptPath is provided', () => {
      const transcriptSrc = path.join(workDir, 'review-transcript.jsonl');
      writeFileSync(transcriptSrc, '{"event":"review-complete"}\n', 'utf8');
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
        transcriptPath: transcriptSrc,
      });
      const sibling = reviewerCacheTranscriptPath(workDir, 'AISDLC-418', 'code-reviewer');
      expect(existsSync(sibling)).toBe(true);
      expect(readFileSync(sibling, 'utf8')).toBe('{"event":"review-complete"}\n');
    });

    it('checkReviewerCache returns transcriptPath on HIT so caller can restore for emit-leaf', () => {
      const transcriptSrc = path.join(workDir, 'review-transcript.jsonl');
      writeFileSync(transcriptSrc, '{"event":"review"}\n', 'utf8');
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
        transcriptPath: transcriptSrc,
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(true);
      expect(result.transcriptPath).toBe(
        reviewerCacheTranscriptPath(workDir, 'AISDLC-418', 'code-reviewer'),
      );
    });

    it('restoreCachedTranscriptToWorktree copies sibling into worktree transcripts dir', () => {
      const transcriptSrc = path.join(workDir, 'review-transcript.jsonl');
      writeFileSync(transcriptSrc, '{"event":"review"}\n', 'utf8');
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
        transcriptPath: transcriptSrc,
      });
      const worktreePath = path.join(workDir, 'wt-mock');
      const sibling = reviewerCacheTranscriptPath(workDir, 'AISDLC-418', 'code-reviewer');
      const dest = restoreCachedTranscriptToWorktree(
        workDir,
        'AISDLC-418',
        'code-reviewer',
        worktreePath,
        sibling,
      );
      expect(dest).toBe(
        path.join(worktreePath, '.ai-sdlc', 'transcripts', 'aisdlc-418', 'code-reviewer.jsonl'),
      );
      expect(readFileSync(dest, 'utf8')).toBe('{"event":"review"}\n');
    });

    it('restoreCachedTranscriptToWorktree returns "" when source is missing', () => {
      const dest = restoreCachedTranscriptToWorktree(
        workDir,
        'AISDLC-418',
        'code-reviewer',
        path.join(workDir, 'nowhere'),
        '/does/not/exist.jsonl',
      );
      expect(dest).toBe('');
    });
  });

  describe('TTL', () => {
    it('MISS after TTL expiry', () => {
      const cachedAt = new Date(
        Date.now() - (DEFAULT_CACHE_TTL_HOURS + 1) * 3600_000,
      ).toISOString();
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
        cachedAt,
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('ttl-expired');
    });

    it('HIT within TTL window', () => {
      const cachedAt = new Date(Date.now() - 1000).toISOString();
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
        cachedAt,
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        ttlHours: 2,
      });
      expect(result.hit).toBe(true);
    });
  });

  describe('Reviewer agent .md hash', () => {
    it('MISS when reviewer agent .md changes', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
      });
      writeFileSync(agentFile, '# code-reviewer v2\nrules: NEW\n', 'utf8');
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('agent-hash-changed');
    });
  });

  describe('Schema downgrade protection', () => {
    it('MISS when cache file is malformed JSON', () => {
      const cachePath = reviewerCachePath(workDir, 'AISDLC-418', 'code-reviewer');
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
      });
      writeFileSync(cachePath, '{not valid json', 'utf8');
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('malformed-cache');
    });

    it('MISS when on-disk schema version is v1 (iter-1 downgrade attempt)', () => {
      const cachePath = reviewerCachePath(workDir, 'AISDLC-418', 'code-reviewer');
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
      });
      // Forge an old-schema entry — should be rejected as malformed.
      const malformed = {
        schemaVersion: 'v1',
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        filesFingerprint: 'whatever',
        agentFileHash: computeAgentFileHash(agentFile),
        cachedAtHeadSha: HEAD_SHA,
        verdictPath: '',
        transcriptPath: '',
        verdict: { approved: true },
        cachedAt: new Date().toISOString(),
      };
      writeFileSync(cachePath, JSON.stringify(malformed), 'utf8');
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('malformed-cache');
    });

    it('MISS when files[] is empty on disk (defensive)', () => {
      const cachePath = reviewerCachePath(workDir, 'AISDLC-418', 'code-reviewer');
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
      });
      const json = JSON.parse(readFileSync(cachePath, 'utf8'));
      json.files = [];
      writeFileSync(cachePath, JSON.stringify(json), 'utf8');
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('malformed-cache');
    });
  });

  describe('resolveBlobShaForPath / resolveBlobShasForPaths (real git)', () => {
    let repo: string;
    beforeEach(() => {
      repo = mkdtempSync(path.join(tmpdir(), 'reviewer-cache-git-'));
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
      writeFileSync(path.join(repo, 'a.ts'), 'console.log("a")\n', 'utf8');
      writeFileSync(path.join(repo, 'b.ts'), 'console.log("b")\n', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: repo });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    });

    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    it('resolveBlobShaForPath returns the 40-char SHA for a tracked file', () => {
      const sha = resolveBlobShaForPath(repo, 'a.ts');
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it("resolveBlobShaForPath returns '' for an untracked path", () => {
      expect(resolveBlobShaForPath(repo, 'never-tracked.ts')).toBe('');
    });

    it("resolveBlobShaForPath returns '' when path contains a traversal segment", () => {
      expect(resolveBlobShaForPath(repo, '../a.ts')).toBe('');
      expect(resolveBlobShaForPath(repo, 'a/..')).toBe('');
      expect(resolveBlobShaForPath(repo, '')).toBe('');
    });

    it('resolveBlobShasForPaths resolves all tracked + drops untracked', () => {
      const out = resolveBlobShasForPaths(repo, ['a.ts', 'b.ts', 'never-tracked.ts']);
      expect(out).toHaveLength(2);
      expect(out.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts']);
      for (const f of out) {
        expect(f.blobSha).toMatch(/^[0-9a-f]{40}$/);
      }
    });

    it('two files with different content produce different blob SHAs', () => {
      const shaA = resolveBlobShaForPath(repo, 'a.ts');
      const shaB = resolveBlobShaForPath(repo, 'b.ts');
      expect(shaA).not.toBe(shaB);
    });
  });

  describe('Save semantics', () => {
    it('save overwrites prior entry for the same (task, reviewer)', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true, findings: { critical: 0 } },
      });
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/b.ts', BLOB_B)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: false, findings: { critical: 1 } },
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('src/b.ts', BLOB_B)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(true);
      expect(result.entry?.verdict.approved).toBe(false);
    });

    it('MISS when cachedAt is not parseable as a date', () => {
      const cachePath = reviewerCachePath(workDir, 'AISDLC-418', 'code-reviewer');
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
      });
      const json = JSON.parse(readFileSync(cachePath, 'utf8'));
      json.cachedAt = 'not-a-date';
      writeFileSync(cachePath, JSON.stringify(json), 'utf8');
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        currentFiles: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('malformed-cache');
    });

    it('per-reviewer entries are independent', () => {
      saveReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'code-reviewer',
        files: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
        verdict: { approved: true },
      });
      const result = checkReviewerCache({
        workDir,
        taskId: 'AISDLC-418',
        reviewer: 'test-reviewer',
        currentFiles: [entry('src/a.ts', BLOB_A)],
        agentFilePath: agentFile,
        headSha: HEAD_SHA,
      });
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('no-cache-entry');
    });
  });
});
