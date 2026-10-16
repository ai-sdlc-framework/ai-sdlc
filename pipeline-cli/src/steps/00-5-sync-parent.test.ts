/**
 * Tests for Step 0.5 — syncParentUntrackedFiles + helpers.
 *
 * All tests are hermetic: a FakeRunner scripts git/gh invocations and a
 * temporary filesystem directory is created per test for any real I/O.
 *
 * Coverage:
 *   (a) 3 untracked task files in parent → opens 1 sync PR with all 3
 *   (b) 1 untracked random file (not in backlog/) → surfaces error (ok: false)
 *   (c) 1 untracked file matching an already-on-origin path → skipped (ok: true + skippedReason)
 *   (d) parent fully clean (no untracked files) → no-op (ok: true, syncedFiles: [])
 *   (e) parent dirty with backlog files + non-backlog files → refuses + surfaces error
 *   (f) git worktree add fails → ok: false with reason
 *   (g) git push fails → ok: false with reason
 *   (h) gh pr create fails → ok: false (but syncedFiles populated)
 *   (i) AISDLC-222: local tasks/ + origin completed/ → path-mismatch, skip with log
 *   (j) AISDLC-222: local completed/ + origin tasks/ → symmetric path-mismatch, skip with log
 *   (k) AISDLC-222: auto-reconcile opt-in deletes stale local copy
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  syncParentUntrackedFiles,
  listUntrackedFiles,
  isFileOnOriginMain,
  findPathMismatchOnOrigin,
  isFileOnOriginMainInAnyDir,
  pruneStaleParentDebris,
  extractTaskId,
  findCompletedCounterpartOnOrigin,
  readOriginMainFile,
  readConfiguredTaskPrefix,
  removeUntrackedIdenticalToMain,
} from './00-5-sync-parent.js';
import type { FileDeps } from '../cli/file.js';
import { FakeRunner, ok, fail as fakeRunnerFail } from '../__test-helpers/fake-runner.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-step05-test-'));
  mkdirSync(join(workDir, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(workDir, 'backlog', 'completed'), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ── Helper unit tests ─────────────────────────────────────────────────

describe('listUntrackedFiles', () => {
  it('returns empty array on git failure (code !== 0)', async () => {
    const fake = new FakeRunner().on(/^git ls-files/, fakeRunnerFail('not a git repo', 128));
    const result = await listUntrackedFiles(workDir, fake.toRunner());
    expect(result).toEqual([]);
  });

  it('parses newline-separated output into an array', async () => {
    const fake = new FakeRunner().on(
      /^git ls-files/,
      ok('backlog/tasks/aisdlc-1 - foo.md\nbacklog/tasks/aisdlc-2 - bar.md\n'),
    );
    const result = await listUntrackedFiles(workDir, fake.toRunner());
    expect(result).toEqual(['backlog/tasks/aisdlc-1 - foo.md', 'backlog/tasks/aisdlc-2 - bar.md']);
  });

  it('filters blank lines', async () => {
    const fake = new FakeRunner().on(/^git ls-files/, ok('\nbacklog/tasks/aisdlc-1 - foo.md\n\n'));
    const result = await listUntrackedFiles(workDir, fake.toRunner());
    expect(result).toEqual(['backlog/tasks/aisdlc-1 - foo.md']);
  });
});

describe('isFileOnOriginMain', () => {
  it('returns true when ls-tree returns a non-empty path', async () => {
    const fake = new FakeRunner().on(
      /^git ls-tree origin\/main/,
      ok('backlog/tasks/aisdlc-1 - foo.md\n'),
    );
    const result = await isFileOnOriginMain(
      'backlog/tasks/aisdlc-1 - foo.md',
      workDir,
      fake.toRunner(),
    );
    expect(result).toBe(true);
  });

  it('returns false when ls-tree returns empty output (file not on origin)', async () => {
    const fake = new FakeRunner().on(/^git ls-tree origin\/main/, ok(''));
    const result = await isFileOnOriginMain(
      'backlog/tasks/aisdlc-99 - new.md',
      workDir,
      fake.toRunner(),
    );
    expect(result).toBe(false);
  });

  it('returns false when git ls-tree exits non-zero', async () => {
    const fake = new FakeRunner().on(/^git ls-tree/, fakeRunnerFail('error', 128));
    const result = await isFileOnOriginMain(
      'backlog/tasks/aisdlc-99 - new.md',
      workDir,
      fake.toRunner(),
    );
    expect(result).toBe(false);
  });
});

// ── syncParentUntrackedFiles integration tests ────────────────────────

describe('Step 0.5 — syncParentUntrackedFiles', () => {
  it('AISDLC-825: untracked decision events do not refuse the execute', async () => {
    const fake = new FakeRunner().on(
      /^git ls-files/,
      ok('.ai-sdlc/_decisions/events/2026-10-12-DEC-0153-created.json\n'),
    );
    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('(d) parent fully clean → no-op (ok: true, syncedFiles: [])', async () => {
    const fake = new FakeRunner().on(/^git ls-files/, ok(''));
    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    expect(result.ok).toBe(true);
    expect(result.syncedFiles).toEqual([]);
    expect(result.prUrl).toBeUndefined();
    expect(result.skippedReason).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it('(b) 1 untracked random file (not in backlog/) → surfaces error', async () => {
    const fake = new FakeRunner().on(/^git ls-files/, ok('dist/index.js\n'));
    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/non-backlog untracked files/);
    expect(result.reason).toContain('dist/index.js');
    expect(result.syncedFiles).toEqual([]);
    // AISDLC-609: no backlog/config.yml in workDir → refusal names the
    // prefix-agnostic fallback shape explicitly (self-diagnosing, not just
    // "non-backlog" with no indication of what pattern was expected).
    expect(result.reason).toContain('no task_prefix configured in backlog/config.yml');
  });

  it('(b2) AISDLC-609: refusal message names the configured prefix when backlog/config.yml sets one', async () => {
    writeFileSync(
      join(workDir, 'backlog/config.yml'),
      "project_name: 'local-trades'\ntask_prefix: 'LT'\n",
      'utf8',
    );
    const fake = new FakeRunner().on(/^git ls-files/, ok('dist/index.js\n'));
    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('prefix "lt" read from backlog/config.yml');
    expect(result.reason).toContain('dist/index.js');
  });

  it('(e) backlog + non-backlog untracked files → refuses with error listing non-backlog', async () => {
    const fake = new FakeRunner().on(
      /^git ls-files/,
      ok('backlog/tasks/aisdlc-99 - new.md\norphan-artifact.json\n'),
    );
    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/non-backlog untracked files/);
    expect(result.reason).toContain('orphan-artifact.json');
    // backlog file not listed in reason (only non-backlog files are the problem)
    expect(result.syncedFiles).toEqual([]);
  });

  it('(c) 1 untracked file already on origin/main → skipped (ok: true + skippedReason)', async () => {
    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-10 - existing.md\n'))
      .on(/^git ls-tree origin\/main/, ok('backlog/tasks/aisdlc-10 - existing.md\n'));
    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    expect(result.ok).toBe(true);
    expect(result.syncedFiles).toEqual([]);
    expect(result.skippedReason).toBeDefined();
    expect(result.skippedReason).toMatch(/already on origin\/main/);
  });

  it('does NOT block on non-ok results from git ls-files (clean + non-backlog)', async () => {
    // Verify that the step still proceeds if git ls-files errors (returns empty)
    const fake = new FakeRunner().on(/^git ls-files/, fakeRunnerFail('not a git repo', 128));
    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    // git error → treated as no untracked files → clean no-op
    expect(result.ok).toBe(true);
    expect(result.syncedFiles).toEqual([]);
  });
});

// ── AISDLC-222: Path-mismatch helper unit tests ──────────────────────

describe('findPathMismatchOnOrigin', () => {
  it('returns found: true with canonicalPath when basename exists in completed/ on origin', async () => {
    // Local file is in tasks/, but on origin/main it's in completed/
    const fake = new FakeRunner().on(
      /^git ls-tree origin\/main .+completed\/aisdlc-10/,
      ok('backlog/completed/aisdlc-10 - done.md\n'),
    );
    const result = await findPathMismatchOnOrigin(
      'backlog/tasks/aisdlc-10 - done.md',
      workDir,
      fake.toRunner(),
    );
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.canonicalPath).toBe('backlog/completed/aisdlc-10 - done.md');
    }
  });

  it('returns found: true with canonicalPath when basename exists in tasks/ on origin (symmetric)', async () => {
    // Local file is in completed/, but on origin/main it's still in tasks/
    const fake = new FakeRunner().on(
      /^git ls-tree origin\/main .+tasks\/aisdlc-11/,
      ok('backlog/tasks/aisdlc-11 - in-progress.md\n'),
    );
    const result = await findPathMismatchOnOrigin(
      'backlog/completed/aisdlc-11 - in-progress.md',
      workDir,
      fake.toRunner(),
    );
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.canonicalPath).toBe('backlog/tasks/aisdlc-11 - in-progress.md');
    }
  });

  it('returns found: false when alternate directory check finds nothing', async () => {
    const fake = new FakeRunner().on(/^git ls-tree origin\/main/, ok(''));
    const result = await findPathMismatchOnOrigin(
      'backlog/tasks/aisdlc-99 - new.md',
      workDir,
      fake.toRunner(),
    );
    expect(result.found).toBe(false);
  });

  it('returns found: false for a non-backlog path', async () => {
    const fake = new FakeRunner(); // no expectations needed
    const result = await findPathMismatchOnOrigin('src/some-file.ts', workDir, fake.toRunner());
    expect(result.found).toBe(false);
  });

  it('returns found: false when git ls-tree exits non-zero', async () => {
    const fake = new FakeRunner().on(/^git ls-tree/, fakeRunnerFail('error', 128));
    const result = await findPathMismatchOnOrigin(
      'backlog/tasks/aisdlc-12 - foo.md',
      workDir,
      fake.toRunner(),
    );
    expect(result.found).toBe(false);
  });
});

describe('isFileOnOriginMainInAnyDir', () => {
  it('returns exactMatch:true when file is on origin at the exact same path', async () => {
    const fake = new FakeRunner().on(
      /^git ls-tree origin\/main .+tasks\/aisdlc-20/,
      ok('backlog/tasks/aisdlc-20 - foo.md\n'),
    );
    const result = await isFileOnOriginMainInAnyDir(
      'backlog/tasks/aisdlc-20 - foo.md',
      workDir,
      fake.toRunner(),
    );
    expect(result.onOrigin).toBe(true);
    expect(result.exactMatch).toBe(true);
    expect(result.canonicalPath).toBe('backlog/tasks/aisdlc-20 - foo.md');
  });

  it('returns exactMatch:false + onOrigin:true when file is on origin at alternate path', async () => {
    const fake = new FakeRunner()
      // Exact path check: tasks/ → not found
      .on(/^git ls-tree origin\/main .+tasks\/aisdlc-21/, ok(''))
      // Alternate path check: completed/ → found
      .on(
        /^git ls-tree origin\/main .+completed\/aisdlc-21/,
        ok('backlog/completed/aisdlc-21 - done.md\n'),
      );
    const result = await isFileOnOriginMainInAnyDir(
      'backlog/tasks/aisdlc-21 - done.md',
      workDir,
      fake.toRunner(),
    );
    expect(result.onOrigin).toBe(true);
    expect(result.exactMatch).toBe(false);
    expect(result.canonicalPath).toBe('backlog/completed/aisdlc-21 - done.md');
  });

  it('returns onOrigin:false when file is not on origin in any directory', async () => {
    const fake = new FakeRunner().on(/^git ls-tree origin\/main/, ok(''));
    const result = await isFileOnOriginMainInAnyDir(
      'backlog/tasks/aisdlc-99 - brand-new.md',
      workDir,
      fake.toRunner(),
    );
    expect(result.onOrigin).toBe(false);
    expect(result.exactMatch).toBe(false);
    expect(result.canonicalPath).toBeNull();
  });
});

// ── AISDLC-222: Path-mismatch integration tests ──────────────────────

describe('Step 0.5 — path-mismatch reconciliation (AISDLC-222)', () => {
  it('(i) local tasks/aisdlc-N + origin completed/aisdlc-N → skip with log (no sync PR)', async () => {
    // Local: backlog/tasks/aisdlc-10 - done.md
    // Origin: only backlog/completed/aisdlc-10 - done.md
    writeFileSync(
      join(workDir, 'backlog/tasks/aisdlc-10 - done.md'),
      '# aisdlc-10\ncontent',
      'utf8',
    );

    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logLines.push(msg);
    });

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-10 - done.md\n'))
      // Exact path check: tasks/ → NOT on origin
      .on(/^git ls-tree origin\/main .+tasks\/aisdlc-10/, ok(''))
      // Alternate path check: completed/ → FOUND (path-mismatch)
      .on(
        /^git ls-tree origin\/main .+completed\/aisdlc-10/,
        ok('backlog/completed/aisdlc-10 - done.md\n'),
      );

    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });

    consoleSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.syncedFiles).toEqual([]);
    expect(result.pathMismatchedFiles).toEqual(['backlog/tasks/aisdlc-10 - done.md']);
    expect(result.skippedReason).toBeDefined();
    expect(result.skippedReason).toMatch(/path-mismatched/);
    // Verify log line was emitted
    const mismatchLog = logLines.find(
      (l) => l.includes('[step-0.5]') && l.includes('stale local copy'),
    );
    expect(mismatchLog).toBeDefined();
    expect(mismatchLog).toContain('backlog/tasks/aisdlc-10 - done.md');
    expect(mismatchLog).toContain('backlog/completed/aisdlc-10 - done.md');
  });

  it('(j) local completed/aisdlc-N + origin tasks/aisdlc-N → symmetric path-mismatch, skip with log', async () => {
    // Symmetric case: operator promoted locally but main hasn't caught up
    writeFileSync(
      join(workDir, 'backlog/completed/aisdlc-11 - in-progress.md'),
      '# aisdlc-11\ncontent',
      'utf8',
    );

    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logLines.push(msg);
    });

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/completed/aisdlc-11 - in-progress.md\n'))
      // Exact path check: completed/ → NOT on origin
      .on(/^git ls-tree origin\/main .+completed\/aisdlc-11/, ok(''))
      // Alternate path check: tasks/ → FOUND (symmetric path-mismatch)
      .on(
        /^git ls-tree origin\/main .+tasks\/aisdlc-11/,
        ok('backlog/tasks/aisdlc-11 - in-progress.md\n'),
      );

    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });

    consoleSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.syncedFiles).toEqual([]);
    expect(result.pathMismatchedFiles).toEqual(['backlog/completed/aisdlc-11 - in-progress.md']);
    expect(result.skippedReason).toBeDefined();
    expect(result.skippedReason).toMatch(/path-mismatched/);
    // Verify log line was emitted
    const mismatchLog = logLines.find(
      (l) => l.includes('[step-0.5]') && l.includes('stale local copy'),
    );
    expect(mismatchLog).toBeDefined();
    expect(mismatchLog).toContain('backlog/completed/aisdlc-11 - in-progress.md');
    expect(mismatchLog).toContain('backlog/tasks/aisdlc-11 - in-progress.md');
  });

  it('(k) AI_SDLC_STEP_0_5_AUTO_RECONCILE=1: deletes stale local copy when set', async () => {
    const staleFile = join(workDir, 'backlog/tasks/aisdlc-50 - done.md');
    writeFileSync(staleFile, '# aisdlc-50\ncontent', 'utf8');
    expect(existsSync(staleFile)).toBe(true);

    // Set the auto-reconcile env var
    const originalEnv = process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'];
    process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'] = '1';

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-50 - done.md\n'))
      // Exact path: NOT found
      .on(/^git ls-tree origin\/main .+tasks\/aisdlc-50/, ok(''))
      // Alternate path: FOUND
      .on(
        /^git ls-tree origin\/main .+completed\/aisdlc-50/,
        ok('backlog/completed/aisdlc-50 - done.md\n'),
      )
      // git rm fails (file is untracked, not staged) → fallback to direct delete
      .on(/^git rm/, fakeRunnerFail('not tracked', 128));

    try {
      const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });

      expect(result.ok).toBe(true);
      expect(result.syncedFiles).toEqual([]);
      expect(result.pathMismatchedFiles).toEqual(['backlog/tasks/aisdlc-50 - done.md']);
      // The file should have been deleted by the auto-reconcile fallback
      expect(existsSync(staleFile)).toBe(false);
    } finally {
      consoleSpy.mockRestore();
      if (originalEnv === undefined) {
        delete process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'];
      } else {
        process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'] = originalEnv;
      }
    }
  });

  it('(k) auto-reconcile NOT triggered when env var is unset', async () => {
    const staleFile = join(workDir, 'backlog/tasks/aisdlc-51 - done.md');
    writeFileSync(staleFile, '# aisdlc-51\ncontent', 'utf8');
    expect(existsSync(staleFile)).toBe(true);

    const originalEnv = process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'];
    delete process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'];

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-51 - done.md\n'))
      .on(/^git ls-tree origin\/main .+tasks\/aisdlc-51/, ok(''))
      .on(
        /^git ls-tree origin\/main .+completed\/aisdlc-51/,
        ok('backlog/completed/aisdlc-51 - done.md\n'),
      );

    try {
      const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });

      expect(result.ok).toBe(true);
      expect(result.pathMismatchedFiles).toEqual(['backlog/tasks/aisdlc-51 - done.md']);
      // File should NOT have been deleted (auto-reconcile not enabled)
      expect(existsSync(staleFile)).toBe(true);
    } finally {
      consoleSpy.mockRestore();
      if (originalEnv === undefined) {
        delete process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'];
      } else {
        process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'] = originalEnv;
      }
    }
  });
});

// ── AISDLC-446: pruneStaleParentDebris unit tests ─────────────────────────────

describe('extractTaskId', () => {
  it('extracts lowercase task ID from backlog/tasks/ path', () => {
    expect(extractTaskId('backlog/tasks/aisdlc-446 - some-slug.md')).toBe('aisdlc-446');
  });

  it('extracts lowercase task ID from backlog/completed/ path', () => {
    expect(extractTaskId('backlog/completed/AISDLC-100 - foo.md')).toBe('aisdlc-100');
  });

  it('returns null for a non-backlog path', () => {
    expect(extractTaskId('src/some-file.ts')).toBeNull();
  });

  it('returns null for a path without the numeric suffix', () => {
    expect(extractTaskId('backlog/tasks/README.md')).toBeNull();
  });
});

describe('findCompletedCounterpartOnOrigin', () => {
  it('returns the completed/ path when a same-ID file exists on origin/main', async () => {
    const fake = new FakeRunner().on(
      /^git ls-tree origin\/main .+backlog\/completed\//,
      ok(
        'backlog/completed/aisdlc-446 - prune-stale-debris.md\nbacklog/completed/aisdlc-447 - other.md\n',
      ),
    );
    const result = await findCompletedCounterpartOnOrigin('aisdlc-446', workDir, fake.toRunner());
    expect(result).toBe('backlog/completed/aisdlc-446 - prune-stale-debris.md');
  });

  it('returns null when no same-ID file exists in completed/', async () => {
    const fake = new FakeRunner().on(
      /^git ls-tree origin\/main .+backlog\/completed\//,
      ok('backlog/completed/aisdlc-999 - other.md\n'),
    );
    const result = await findCompletedCounterpartOnOrigin('aisdlc-446', workDir, fake.toRunner());
    expect(result).toBeNull();
  });

  it('returns null when completed/ directory is empty on origin', async () => {
    const fake = new FakeRunner().on(/^git ls-tree origin\/main .+backlog\/completed\//, ok(''));
    const result = await findCompletedCounterpartOnOrigin('aisdlc-446', workDir, fake.toRunner());
    expect(result).toBeNull();
  });

  it('returns null when git ls-tree exits non-zero', async () => {
    const fake = new FakeRunner().on(/^git ls-tree/, fakeRunnerFail('error', 128));
    const result = await findCompletedCounterpartOnOrigin('aisdlc-446', workDir, fake.toRunner());
    expect(result).toBeNull();
  });

  it('matches case-insensitively (AISDLC vs aisdlc)', async () => {
    const fake = new FakeRunner().on(
      /^git ls-tree origin\/main .+backlog\/completed\//,
      ok('backlog/completed/AISDLC-446 - prune-stale-debris.md\n'),
    );
    const result = await findCompletedCounterpartOnOrigin('aisdlc-446', workDir, fake.toRunner());
    // The file from origin is returned as-is; the match is by ID equality
    expect(result).toBe('backlog/completed/AISDLC-446 - prune-stale-debris.md');
  });
});

describe('readOriginMainFile', () => {
  it('returns content string on success', async () => {
    const fake = new FakeRunner().on(
      /^git show origin\/main:/,
      ok('---\nid: AISDLC-446\nstatus: Done\n---\n\n## Body\n'),
    );
    const result = await readOriginMainFile(
      'backlog/completed/aisdlc-446 - slug.md',
      workDir,
      fake.toRunner(),
    );
    expect(result).toBe('---\nid: AISDLC-446\nstatus: Done\n---\n\n## Body\n');
  });

  it('returns null when git show exits non-zero', async () => {
    const fake = new FakeRunner().on(/^git show/, fakeRunnerFail('not found', 128));
    const result = await readOriginMainFile(
      'backlog/completed/aisdlc-446 - slug.md',
      workDir,
      fake.toRunner(),
    );
    expect(result).toBeNull();
  });
});

// ── AISDLC-446: pruneStaleParentDebris integration tests ──────────────────────

describe('pruneStaleParentDebris — AISDLC-446', () => {
  const CONTENT_MATCH = '---\nid: AISDLC-446\nstatus: Done\n---\n\n## Body\n\nDone.\n';
  const CONTENT_LOCAL_EDIT =
    '---\nid: AISDLC-446\nstatus: To Do\n---\n\n## Body\n\nEdited locally.\n';

  it('AC#3 — clean-delete: content matches → deletes the stale tasks/ file', async () => {
    const staleFile = join(workDir, 'backlog/tasks/aisdlc-446 - prune-stale-debris.md');
    writeFileSync(staleFile, CONTENT_MATCH, 'utf8');
    expect(existsSync(staleFile)).toBe(true);

    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logLines.push(msg);
    });

    const fake = new FakeRunner()
      // git ls-files returns the stale file
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-446 - prune-stale-debris.md\n'))
      // git ls-tree for completed/ listing returns the counterpart
      .on(
        /^git ls-tree origin\/main .+backlog\/completed\//,
        ok('backlog/completed/aisdlc-446 - prune-stale-debris.md\n'),
      )
      // git show returns same content as local file
      .on(/^git show origin\/main:/, ok(CONTENT_MATCH));

    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    consoleSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual(['backlog/tasks/aisdlc-446 - prune-stale-debris.md']);
    expect(result.skippedContentDiffers).toEqual([]);
    expect(result.noCounterpart).toEqual([]);
    // File should have been deleted
    expect(existsSync(staleFile)).toBe(false);
    // One log line should have been emitted
    const pruneLog = logLines.find(
      (l) => l.includes('[prune-stale-debris]') && l.includes('pruned'),
    );
    expect(pruneLog).toBeDefined();
    expect(pruneLog).toContain('backlog/tasks/aisdlc-446');
  });

  it('AC#4 — content-mismatch-skip: content differs → logs warning, leaves file intact', async () => {
    const staleFile = join(workDir, 'backlog/tasks/aisdlc-446 - prune-stale-debris.md');
    writeFileSync(staleFile, CONTENT_LOCAL_EDIT, 'utf8');
    expect(existsSync(staleFile)).toBe(true);

    const warnLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
      warnLines.push(msg);
    });

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-446 - prune-stale-debris.md\n'))
      .on(
        /^git ls-tree origin\/main .+backlog\/completed\//,
        ok('backlog/completed/aisdlc-446 - prune-stale-debris.md\n'),
      )
      // git show returns DIFFERENT content
      .on(/^git show origin\/main:/, ok(CONTENT_MATCH));

    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    consoleSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual([]);
    expect(result.skippedContentDiffers).toEqual([
      'backlog/tasks/aisdlc-446 - prune-stale-debris.md',
    ]);
    expect(result.noCounterpart).toEqual([]);
    // File must NOT have been deleted
    expect(existsSync(staleFile)).toBe(true);
    // Warning must have been emitted
    const warnLog = warnLines.find(
      (l) => l.includes('[prune-stale-debris]') && l.includes('content differs'),
    );
    expect(warnLog).toBeDefined();
  });

  it('AC#5 — no-counterpart-no-op: no completed/ counterpart → leaves file alone, no output', async () => {
    const taskFile = join(workDir, 'backlog/tasks/aisdlc-999 - brand-new.md');
    writeFileSync(taskFile, CONTENT_MATCH, 'utf8');
    expect(existsSync(taskFile)).toBe(true);

    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logLines.push(msg);
    });
    const warnLines: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
      warnLines.push(msg);
    });

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-999 - brand-new.md\n'))
      // completed/ listing returns no same-ID file
      .on(/^git ls-tree origin\/main .+backlog\/completed\//, ok(''));

    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    consoleSpy.mockRestore();
    warnSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual([]);
    expect(result.skippedContentDiffers).toEqual([]);
    expect(result.noCounterpart).toEqual(['backlog/tasks/aisdlc-999 - brand-new.md']);
    // File should still exist
    expect(existsSync(taskFile)).toBe(true);
    // No prune-stale-debris log lines
    const pruneLines = [...logLines, ...warnLines].filter((l) =>
      l.includes('[prune-stale-debris]'),
    );
    expect(pruneLines).toHaveLength(0);
  });

  it('AC#6 — idempotent: no untracked task files → no-op, no output', async () => {
    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logLines.push(msg);
    });
    const warnLines: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
      warnLines.push(msg);
    });

    const fake = new FakeRunner().on(/^git ls-files/, ok(''));

    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    consoleSpy.mockRestore();
    warnSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual([]);
    expect(result.skippedContentDiffers).toEqual([]);
    expect(result.noCounterpart).toEqual([]);
    const pruneLines = [...logLines, ...warnLines].filter((l) =>
      l.includes('[prune-stale-debris]'),
    );
    expect(pruneLines).toHaveLength(0);
  });

  it('AC#9 — one log line per pruned file, silent when no debris', async () => {
    // Create two stale files with matching content
    const staleFile1 = join(workDir, 'backlog/tasks/aisdlc-100 - stale-a.md');
    const staleFile2 = join(workDir, 'backlog/tasks/aisdlc-101 - stale-b.md');
    writeFileSync(staleFile1, CONTENT_MATCH, 'utf8');
    writeFileSync(staleFile2, CONTENT_MATCH, 'utf8');

    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logLines.push(msg);
    });

    const fake = new FakeRunner()
      .on(
        /^git ls-files/,
        ok('backlog/tasks/aisdlc-100 - stale-a.md\nbacklog/tasks/aisdlc-101 - stale-b.md\n'),
      )
      // Both have counterparts in completed/
      .on(
        /^git ls-tree origin\/main .+backlog\/completed\//,
        ok(
          'backlog/completed/aisdlc-100 - stale-a.md\nbacklog/completed/aisdlc-101 - stale-b.md\n',
        ),
      )
      // Both have identical content
      .on(/^git show origin\/main:/, ok(CONTENT_MATCH));

    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    consoleSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.pruned).toHaveLength(2);
    // Exactly one log line per pruned file
    const pruneLogLines = logLines.filter(
      (l) => l.includes('[prune-stale-debris]') && l.includes('pruned'),
    );
    expect(pruneLogLines).toHaveLength(2);
    expect(existsSync(staleFile1)).toBe(false);
    expect(existsSync(staleFile2)).toBe(false);
  });

  it('only targets backlog/tasks/ files, not backlog/completed/ untracked files', async () => {
    // An untracked file in backlog/completed/ should NOT be pruned
    writeFileSync(
      join(workDir, 'backlog/completed/aisdlc-200 - in-completed.md'),
      CONTENT_MATCH,
      'utf8',
    );

    const fake = new FakeRunner().on(
      /^git ls-files/,
      ok('backlog/completed/aisdlc-200 - in-completed.md\n'),
    );
    // Should not need to call ls-tree since the file doesn't match tasks/ pattern
    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual([]);
    expect(result.noCounterpart).toEqual([]);
    expect(result.skippedContentDiffers).toEqual([]);
    // The completed/ file should still exist
    expect(existsSync(join(workDir, 'backlog/completed/aisdlc-200 - in-completed.md'))).toBe(true);
  });

  it('skips when local readFileSync throws (file vanished between ls-files and read)', async () => {
    const phantomFile = 'backlog/tasks/aisdlc-446 - phantom.md';
    expect(existsSync(join(workDir, phantomFile))).toBe(false);

    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
      warnings.push(msg);
    });

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok(`${phantomFile}\n`))
      .on(
        /^git ls-tree origin\/main .+backlog\/completed\//,
        ok('backlog/completed/aisdlc-446 - phantom.md\n'),
      )
      .on(/^git show origin\/main:/, ok(CONTENT_MATCH));

    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    warnSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual([]);
    expect(result.skippedContentDiffers).toEqual([phantomFile]);
    expect(result.noCounterpart).toEqual([]);
    const warnLog = warnings.find(
      (l) => l.includes('[prune-stale-debris]') && l.includes('could not read local file'),
    );
    expect(warnLog).toBeDefined();
  });
});

// ── AISDLC-609: task-id-prefix-agnostic resolution ─────────────────────────

describe('readConfiguredTaskPrefix', () => {
  it('returns null when backlog/config.yml does not exist', () => {
    expect(readConfiguredTaskPrefix(workDir)).toBeNull();
  });

  it('reads and lowercases the task_prefix field from backlog/config.yml', () => {
    writeFileSync(
      join(workDir, 'backlog/config.yml'),
      "project_name: 'demo'\ntask_prefix: 'LT'\ndefault_status: 'To Do'\n",
      'utf8',
    );
    expect(readConfiguredTaskPrefix(workDir)).toBe('lt');
  });

  it('returns null when task_prefix field is absent from config.yml', () => {
    writeFileSync(join(workDir, 'backlog/config.yml'), "project_name: 'demo'\n", 'utf8');
    expect(readConfiguredTaskPrefix(workDir)).toBeNull();
  });
});

describe('Step 0.5 sync — non-aisdlc-prefix repo (AC-1, AC-4)', () => {
  it('recognizes the repo-configured LT-N files as backlog files (no false "refuse")', async () => {
    // Regression guard: a repo with task_prefix LT should not treat its OWN
    // LT-N files as "other" debris.
    writeFileSync(
      join(workDir, 'backlog/config.yml'),
      "project_name: 'local-trades'\ntask_prefix: 'LT'\n",
      'utf8',
    );
    writeFileSync(join(workDir, 'backlog/tasks/LT-9 - feature.md'), '# LT-9\n', 'utf8');
    // A genuinely non-backlog untracked file should still trigger the refuse path.
    writeFileSync(join(workDir, 'random-debris.txt'), 'oops', 'utf8');

    const fake = new FakeRunner().on(
      /^git ls-files/,
      ok('backlog/tasks/LT-9 - feature.md\nrandom-debris.txt\n'),
    );

    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('random-debris.txt');
    expect(result.reason).not.toContain('LT-9');
  });
});

describe('extractTaskId — prefix-agnostic (AC-1)', () => {
  it('extracts a non-aisdlc prefix task ID (LT-42)', () => {
    expect(extractTaskId('backlog/tasks/LT-42 - some-feature.md')).toBe('lt-42');
  });

  it('extracts a non-aisdlc prefix task ID from completed/', () => {
    expect(extractTaskId('backlog/completed/LT-7 - fallback.md')).toBe('lt-7');
  });

  it('still extracts aisdlc-N task IDs (AC-2 regression)', () => {
    expect(extractTaskId('backlog/tasks/aisdlc-446 - some-slug.md')).toBe('aisdlc-446');
  });
});

describe('pruneStaleParentDebris — non-aisdlc-prefix repo (AC-1)', () => {
  const CONTENT_MATCH = '---\nid: LT-42\nstatus: Done\n---\n\n## Body\n\nDone.\n';

  it('prunes an untracked LT-N task file whose completed/ counterpart matches on origin/main', async () => {
    writeFileSync(
      join(workDir, 'backlog/config.yml'),
      "project_name: 'local-trades'\ntask_prefix: 'LT'\n",
      'utf8',
    );
    const staleFile = join(workDir, 'backlog/tasks/LT-42 - some-feature.md');
    writeFileSync(staleFile, CONTENT_MATCH, 'utf8');

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/LT-42 - some-feature.md\n'))
      .on(
        /^git ls-tree origin\/main .+backlog\/completed\//,
        ok('backlog/completed/LT-42 - some-feature.md\n'),
      )
      .on(/^git show origin\/main:/, ok(CONTENT_MATCH));

    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual(['backlog/tasks/LT-42 - some-feature.md']);
    expect(existsSync(staleFile)).toBe(false);
  });
});

describe('AISDLC-860 step 0.5 files through the cli-file path', () => {
  const file = 'backlog/tasks/aisdlc-900 - thing.md';
  const FILE_PR = 'https://github.com/org/repo/pull/9';

  function setup(files: string[], onMain: string) {
    for (const f of files) writeFileSync(join(workDir, f), '---\nid: x\n---\n', 'utf8');
    const execCalls: Array<[string, string[]]> = [];
    const fileDeps: FileDeps = {
      exec(cmd, args) {
        execCalls.push([cmd, args]);
        if (cmd === 'git' && args[0] === 'ls-tree')
          return { status: 0, stdout: onMain, stderr: '' };
        if (cmd === 'gh') return { status: 0, stdout: FILE_PR + '\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
      drift: () => null,
      dor: () => null,
    };
    const fake = new FakeRunner()
      .on(/^git ls-files/, ok(files.join('\n') + '\n'))
      .on(/^git ls-tree origin\/main/, ok(''))
      .on(/^gh pr list/, ok('[]'));
    return { fake, fileDeps, execCalls };
  }
  const created = (calls: Array<[string, string[]]>) =>
    calls.some(([c, a]) => (c === 'git' && a[0] === 'worktree') || (c === 'gh' && a[0] === 'pr'));

  it('refuses a file whose id exists on origin/main in any case (tasks or completed)', async () => {
    const { fake, fileDeps, execCalls } = setup(
      [file],
      'backlog/completed/AISDLC-900 - old thing.md\n',
    );
    const r = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner(), fileDeps });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('blocked');
    expect(r.refused?.[0].file).toBe(file);
    expect(r.reason).toContain('AISDLC-900 - old thing.md');
    expect(created(execCalls)).toBe(false);
  });

  it('refuses a file whose name differs only in case from a file on main', async () => {
    const { fake, fileDeps, execCalls } = setup([file], 'backlog/tasks/AISDLC-900 - THING.md\n');
    const r = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner(), fileDeps });
    expect(r.verdict).toBe('blocked');
    expect(r.reason).toContain('case-insensitive');
    expect(created(execCalls)).toBe(false);
  });

  it('refuses everything when one of several files is refused', async () => {
    const other = 'backlog/tasks/aisdlc-901 - clean.md';
    const { fake, fileDeps, execCalls } = setup([file, other], 'backlog/tasks/aisdlc-900 - a.md\n');
    const r = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner(), fileDeps });
    expect(r.refused).toHaveLength(1);
    expect(created(execCalls)).toBe(false);
  });

  it('files a clean new file via cli-file with drift and DoR checked', async () => {
    const { fake, fileDeps, execCalls } = setup([file], '');
    const drift = vi.fn(() => null);
    const dor = vi.fn(() => null);
    const r = await syncParentUntrackedFiles({
      workDir,
      runner: fake.toRunner(),
      fileDeps: { ...fileDeps, drift, dor },
    });
    expect(r.ok).toBe(true);
    expect(r.prUrl).toBe(FILE_PR);
    expect(drift).toHaveBeenCalledTimes(1);
    expect(dor).toHaveBeenCalledTimes(1);
    expect(execCalls.some(([c, a]) => c === 'git' && a.includes('ai-sdlc/file-aisdlc-900'))).toBe(
      true,
    );
    expect(execCalls.some(([, a]) => a.some((x) => x.startsWith('chore/sync-tasks')))).toBe(false);
  });

  it('AISDLC-950: skips a file whose filing branch already exists and names the branch', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fileDeps, execCalls } = setup([file], '');
    const fake = new FakeRunner()
      .on(/^git ls-files/, ok(file + '\n'))
      .on(/^git ls-tree origin\/main/, ok(''))
      .on(/^git branch --all/, ok('  ai-sdlc/file-aisdlc-900\n'));
    const r = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner(), fileDeps });
    expect(r.ok).toBe(true);
    expect(r.syncedFiles).toEqual([]);
    expect(created(execCalls)).toBe(false);
    expect(log.mock.calls.some((c) => String(c[0]).includes('ai-sdlc/file-aisdlc-900'))).toBe(true);
    log.mockRestore();
  });

  it('refuses when DoR or drift fails', async () => {
    const { fake, fileDeps } = setup([file], '');
    const r = await syncParentUntrackedFiles({
      workDir,
      runner: fake.toRunner(),
      fileDeps: { ...fileDeps, dor: () => 'DoR: no' },
    });
    expect(r.verdict).toBe('blocked');
    expect(r.reason).toContain('DoR: no');
  });

  it('reuses an open filing PR on resume', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fileDeps, execCalls } = setup([file], '');
    const fake = new FakeRunner()
      .on(/^git ls-files/, ok(file + '\n'))
      .on(/^git ls-tree origin\/main/, ok(''))
      .on(/^gh pr list/, ok(JSON.stringify([{ number: 42, url: 'https://x/pull/42' }])));
    const r = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner(), fileDeps });
    expect(r.prUrl).toBe('https://x/pull/42');
    expect(created(execCalls)).toBe(false);
    log.mockRestore();
  });

  it('reports a filing failure after validation', async () => {
    const { fake, fileDeps } = setup([file], '');
    const r = await syncParentUntrackedFiles({
      workDir,
      runner: fake.toRunner(),
      fileDeps: {
        ...fileDeps,
        exec: (cmd, args, cwd) =>
          cmd === 'git' && args[0] === 'worktree'
            ? { status: 1, stdout: '', stderr: 'boom' }
            : fileDeps.exec(cmd, args, cwd),
      },
    });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBeUndefined();
    expect(r.reason).toContain('filing');
  });
});

describe('removeUntrackedIdenticalToMain (AISDLC-874)', () => {
  const rel = '.ai-sdlc/_decisions/events/e1.json';
  const setup = (content: string) => {
    mkdirSync(join(workDir, '.ai-sdlc', '_decisions', 'events'), { recursive: true });
    writeFileSync(join(workDir, rel), content);
  };

  it('removes an untracked event identical to origin/main', async () => {
    setup('x');
    const fake = new FakeRunner()
      .on(/^git rev-parse --verify/, ok('abc123\n'))
      .on(/^git hash-object/, ok('abc123\n'));
    const removed = await removeUntrackedIdenticalToMain([rel], workDir, fake.toRunner());
    expect(removed).toEqual([rel]);
    expect(existsSync(join(workDir, rel))).toBe(false);
  });

  it('keeps and reports an untracked event that differs from origin/main', async () => {
    setup('x');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakeRunner()
      .on(/^git rev-parse --verify/, ok('abc123\n'))
      .on(/^git hash-object/, ok('def456\n'));
    const removed = await removeUntrackedIdenticalToMain([rel], workDir, fake.toRunner());
    expect(removed).toEqual([]);
    expect(existsSync(join(workDir, rel))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('differs from origin/main'));
    warn.mockRestore();
  });

  it('ignores files absent on origin/main and files outside the events dir', async () => {
    setup('x');
    writeFileSync(join(workDir, 'other.txt'), 'x');
    const fake = new FakeRunner().on(/^git rev-parse --verify/, fakeRunnerFail('', 1));
    const removed = await removeUntrackedIdenticalToMain(
      [rel, 'other.txt'],
      workDir,
      fake.toRunner(),
    );
    expect(removed).toEqual([]);
    expect(existsSync(join(workDir, rel))).toBe(true);
    expect(existsSync(join(workDir, 'other.txt'))).toBe(true);
  });
});
