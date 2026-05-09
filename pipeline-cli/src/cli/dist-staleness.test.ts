/**
 * Hermetic tests for the dist-staleness auto-rebuild helper (AISDLC-226).
 *
 * Coverage matrix (AC #5):
 *   - src/ newer than dist/ → rebuild fires
 *   - dist/ newer than src/ (or equal) → rebuild skipped
 *   - nested src file (not src/index.ts) newer than dist/ → rebuild fires
 *     (MAJOR fix: single-sentinel approach missed commits that only touched
 *      e.g. src/cli/orchestrator.ts without updating src/index.ts)
 *   - AI_SDLC_ORCHESTRATOR_SKIP_REBUILD=1 → rebuild skipped unconditionally
 *   - opts.skipRebuild=true → rebuild skipped unconditionally
 *   - opts.skipRebuild=false → check forced even when env=1
 *   - rebuild failure (non-zero exit) → throws with clear message
 *   - dist/index.js missing (fresh clone) → silent no-op
 *   - src/ directory missing (wrong package root) → silent no-op
 *
 * All tests use a tmpdir fixture tree and inject spawnFn/stderrWrite to stay
 * fully hermetic — no real pnpm build is invoked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { checkAndRebuildIfStale, type DistStalenessOptions } from './dist-staleness.js';

let tmp: string;
let stderrMessages: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dist-staleness-test-'));
  stderrMessages = [];
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  // Restore any env mutations done in tests.
  delete process.env['AI_SDLC_ORCHESTRATOR_SKIP_REBUILD'];
});

// ── Fixture helpers ────────────────────────────────────────────────────────

/**
 * Create a minimal fixture package root at `tmp` with:
 *   - `src/index.ts` at mtime `srcMtime`
 *   - `dist/index.js` at mtime `distMtime`
 */
function makeFixture(opts: { srcMtime: Date; distMtime: Date }): void {
  mkdirSync(join(tmp, 'src'), { recursive: true });
  mkdirSync(join(tmp, 'dist'), { recursive: true });
  writeFileSync(join(tmp, 'src', 'index.ts'), '// src\n');
  writeFileSync(join(tmp, 'dist', 'index.js'), '// dist\n');
  utimesSync(join(tmp, 'src', 'index.ts'), opts.srcMtime, opts.srcMtime);
  utimesSync(join(tmp, 'dist', 'index.js'), opts.distMtime, opts.distMtime);
}

/**
 * Create a fixture with `src/index.ts`, a nested src file, and `dist/index.js`,
 * each at independently-specified mtimes.
 */
function makeFixtureWithNestedFile(opts: {
  indexMtime: Date;
  nestedMtime: Date;
  distMtime: Date;
  nestedPath?: string; // relative to src/, defaults to 'cli/orchestrator.ts'
}): void {
  const nestedRel = opts.nestedPath ?? 'cli/orchestrator.ts';
  const nestedFullPath = join(tmp, 'src', nestedRel);
  mkdirSync(dirname(nestedFullPath), { recursive: true });
  mkdirSync(join(tmp, 'dist'), { recursive: true });
  writeFileSync(join(tmp, 'src', 'index.ts'), '// src\n');
  writeFileSync(nestedFullPath, '// nested\n');
  writeFileSync(join(tmp, 'dist', 'index.js'), '// dist\n');
  utimesSync(join(tmp, 'src', 'index.ts'), opts.indexMtime, opts.indexMtime);
  utimesSync(nestedFullPath, opts.nestedMtime, opts.nestedMtime);
  utimesSync(join(tmp, 'dist', 'index.js'), opts.distMtime, opts.distMtime);
}

/** Build a base DistStalenessOptions with the test tmpdir and a no-op spawn. */
function baseOpts(spawnResult: { status: number | null } = { status: 0 }): DistStalenessOptions {
  return {
    packageRoot: tmp,
    stderrWrite: (m) => stderrMessages.push(m),
    spawnFn: () => spawnResult,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('checkAndRebuildIfStale', () => {
  describe('staleness detection', () => {
    it('fires rebuild when src/index.ts is newer than dist/index.js', () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-05-01T00:00:00Z');
      makeFixture({ srcMtime: fresh, distMtime: old });

      let rebuildCalled = false;
      checkAndRebuildIfStale({
        ...baseOpts(),
        spawnFn: () => {
          rebuildCalled = true;
          return { status: 0 };
        },
      });

      expect(rebuildCalled).toBe(true);
      expect(stderrMessages).toContain('[orchestrator] dist/ stale, rebuilding pipeline-cli\n');
    });

    it('skips rebuild when dist/index.js is newer than src/index.ts', () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-05-01T00:00:00Z');
      makeFixture({ srcMtime: old, distMtime: fresh });

      let rebuildCalled = false;
      checkAndRebuildIfStale({
        ...baseOpts(),
        spawnFn: () => {
          rebuildCalled = true;
          return { status: 0 };
        },
      });

      expect(rebuildCalled).toBe(false);
      expect(stderrMessages).toHaveLength(0);
    });

    it('skips rebuild when dist/index.js and src/index.ts have identical mtime', () => {
      const sameTime = new Date('2026-03-15T12:00:00Z');
      makeFixture({ srcMtime: sameTime, distMtime: sameTime });

      let rebuildCalled = false;
      checkAndRebuildIfStale({
        ...baseOpts(),
        spawnFn: () => {
          rebuildCalled = true;
          return { status: 0 };
        },
      });

      expect(rebuildCalled).toBe(false);
    });

    it('fires rebuild when a nested src file is newer than dist (MAJOR fix: git pull touches only src/cli/orchestrator.ts, not src/index.ts)', () => {
      // The pre-fix single-sentinel approach would have missed this scenario:
      // src/index.ts stays at its old mtime after pull, so the sentinel
      // comparison would say "dist is fresh" even though a newer file exists.
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-05-01T00:00:00Z');
      // src/index.ts is OLD, dist/index.js was built at a mid-point,
      // but src/cli/orchestrator.ts was updated after the build.
      const mid = new Date('2026-03-01T00:00:00Z');
      makeFixtureWithNestedFile({
        indexMtime: old, // src/index.ts untouched since the build
        distMtime: mid, // dist built at mid-point
        nestedMtime: fresh, // src/cli/orchestrator.ts updated after build
      });

      let rebuildCalled = false;
      checkAndRebuildIfStale({
        ...baseOpts(),
        spawnFn: () => {
          rebuildCalled = true;
          return { status: 0 };
        },
      });

      expect(rebuildCalled).toBe(true);
      expect(stderrMessages).toContain('[orchestrator] dist/ stale, rebuilding pipeline-cli\n');
    });

    it('skips rebuild when all src files (including nested) are older than dist', () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-05-01T00:00:00Z');
      // Both src/index.ts and nested file are old; dist is fresh.
      makeFixtureWithNestedFile({
        indexMtime: old,
        nestedMtime: old,
        distMtime: fresh,
      });

      let rebuildCalled = false;
      checkAndRebuildIfStale({
        ...baseOpts(),
        spawnFn: () => {
          rebuildCalled = true;
          return { status: 0 };
        },
      });

      expect(rebuildCalled).toBe(false);
    });

    it('ignores *.test.ts files when computing max src mtime', () => {
      // A test file is newer than dist — should NOT trigger rebuild.
      const old = new Date('2026-01-01T00:00:00Z');
      const mid = new Date('2026-03-01T00:00:00Z');
      const fresh = new Date('2026-05-01T00:00:00Z');

      // src/index.ts is old, dist is mid, src/cli/foo.test.ts is fresh.
      makeFixtureWithNestedFile({
        indexMtime: old,
        nestedMtime: fresh,
        nestedPath: 'cli/foo.test.ts',
        distMtime: mid,
      });

      let rebuildCalled = false;
      checkAndRebuildIfStale({
        ...baseOpts(),
        spawnFn: () => {
          rebuildCalled = true;
          return { status: 0 };
        },
      });

      // fresh test file is excluded from the walk; only old src/index.ts counts
      // → max src mtime < dist mtime → no rebuild.
      expect(rebuildCalled).toBe(false);
    });
  });

  describe('skip-rebuild env var', () => {
    it('skips rebuild when AI_SDLC_ORCHESTRATOR_SKIP_REBUILD=1 in environment', () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-05-01T00:00:00Z');
      makeFixture({ srcMtime: fresh, distMtime: old });

      process.env['AI_SDLC_ORCHESTRATOR_SKIP_REBUILD'] = '1';

      let rebuildCalled = false;
      checkAndRebuildIfStale({
        packageRoot: tmp,
        stderrWrite: (m) => stderrMessages.push(m),
        spawnFn: () => {
          rebuildCalled = true;
          return { status: 0 };
        },
        // Do NOT pass skipRebuild — let the env var control it.
      });

      expect(rebuildCalled).toBe(false);
      expect(stderrMessages).toHaveLength(0);
    });

    it('skips rebuild when opts.skipRebuild=true regardless of env', () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-05-01T00:00:00Z');
      makeFixture({ srcMtime: fresh, distMtime: old });

      delete process.env['AI_SDLC_ORCHESTRATOR_SKIP_REBUILD'];

      let rebuildCalled = false;
      checkAndRebuildIfStale({
        ...baseOpts(),
        skipRebuild: true,
        spawnFn: () => {
          rebuildCalled = true;
          return { status: 0 };
        },
      });

      expect(rebuildCalled).toBe(false);
    });

    it('forces rebuild when opts.skipRebuild=false even if AI_SDLC_ORCHESTRATOR_SKIP_REBUILD=1', () => {
      // skipRebuild: false is an explicit "force the check on" override.
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-05-01T00:00:00Z');
      makeFixture({ srcMtime: fresh, distMtime: old });

      process.env['AI_SDLC_ORCHESTRATOR_SKIP_REBUILD'] = '1'; // env says skip

      let rebuildCalled = false;
      checkAndRebuildIfStale({
        ...baseOpts(),
        skipRebuild: false, // explicit false overrides env=1
        spawnFn: () => {
          rebuildCalled = true;
          return { status: 0 };
        },
      });

      // Even though env=1 says "skip", the explicit false forces the check on
      // and the stale src triggers a rebuild.
      expect(rebuildCalled).toBe(true);
    });

    it('does NOT skip rebuild when AI_SDLC_ORCHESTRATOR_SKIP_REBUILD=0', () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-05-01T00:00:00Z');
      makeFixture({ srcMtime: fresh, distMtime: old });

      process.env['AI_SDLC_ORCHESTRATOR_SKIP_REBUILD'] = '0';

      let rebuildCalled = false;
      checkAndRebuildIfStale({
        packageRoot: tmp,
        stderrWrite: (m) => stderrMessages.push(m),
        spawnFn: () => {
          rebuildCalled = true;
          return { status: 0 };
        },
      });

      // env=0 does NOT trigger the skip (only '1' skips)
      expect(rebuildCalled).toBe(true);
    });
  });

  describe('rebuild failure abort', () => {
    it('throws a clear error when the rebuild exits non-zero', () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-05-01T00:00:00Z');
      makeFixture({ srcMtime: fresh, distMtime: old });

      expect(() =>
        checkAndRebuildIfStale({
          ...baseOpts({ status: 1 }),
        }),
      ).toThrow(/pipeline-cli rebuild failed/);
    });

    it('includes the exit code in the error message', () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-05-01T00:00:00Z');
      makeFixture({ srcMtime: fresh, distMtime: old });

      let caughtMessage = '';
      try {
        checkAndRebuildIfStale({
          ...baseOpts({ status: 2 }),
        });
      } catch (err) {
        caughtMessage = (err as Error).message;
      }

      expect(caughtMessage).toContain('exit 2');
      expect(caughtMessage).toContain('AI_SDLC_ORCHESTRATOR_SKIP_REBUILD=1');
    });

    it('includes "null" when the spawn process was killed (status=null)', () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-05-01T00:00:00Z');
      makeFixture({ srcMtime: fresh, distMtime: old });

      let caughtMessage = '';
      try {
        checkAndRebuildIfStale({
          ...baseOpts({ status: null }),
        });
      } catch (err) {
        caughtMessage = (err as Error).message;
      }

      expect(caughtMessage).toContain('null');
    });
  });

  describe('missing-file guards', () => {
    it('is a no-op when dist/index.js does not exist (fresh clone)', () => {
      // Only create src, no dist.
      mkdirSync(join(tmp, 'src'), { recursive: true });
      writeFileSync(join(tmp, 'src', 'index.ts'), '// src\n');

      let rebuildCalled = false;
      expect(() =>
        checkAndRebuildIfStale({
          packageRoot: tmp,
          stderrWrite: (m) => stderrMessages.push(m),
          spawnFn: () => {
            rebuildCalled = true;
            return { status: 0 };
          },
        }),
      ).not.toThrow();

      expect(rebuildCalled).toBe(false);
      expect(stderrMessages).toHaveLength(0);
    });

    it('is a no-op when src/ directory does not exist (wrong package root)', () => {
      // Only create dist, no src.
      mkdirSync(join(tmp, 'dist'), { recursive: true });
      writeFileSync(join(tmp, 'dist', 'index.js'), '// dist\n');

      let rebuildCalled = false;
      expect(() =>
        checkAndRebuildIfStale({
          packageRoot: tmp,
          stderrWrite: (m) => stderrMessages.push(m),
          spawnFn: () => {
            rebuildCalled = true;
            return { status: 0 };
          },
        }),
      ).not.toThrow();

      expect(rebuildCalled).toBe(false);
    });
  });

  describe('spawn invocation', () => {
    it('invokes pnpm with --filter @ai-sdlc/pipeline-cli build', () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-05-01T00:00:00Z');
      makeFixture({ srcMtime: fresh, distMtime: old });

      let capturedCmd = '';
      let capturedArgs: string[] = [];
      checkAndRebuildIfStale({
        packageRoot: tmp,
        stderrWrite: (m) => stderrMessages.push(m),
        spawnFn: (cmd, args) => {
          capturedCmd = cmd;
          capturedArgs = args;
          return { status: 0 };
        },
        pnpmBin: 'pnpm',
      });

      expect(capturedCmd).toBe('pnpm');
      expect(capturedArgs).toEqual(['--filter', '@ai-sdlc/pipeline-cli', 'build']);
    });

    it('uses opts.pnpmBin when supplied', () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-05-01T00:00:00Z');
      makeFixture({ srcMtime: fresh, distMtime: old });

      let capturedCmd = '';
      checkAndRebuildIfStale({
        packageRoot: tmp,
        stderrWrite: (m) => stderrMessages.push(m),
        spawnFn: (cmd) => {
          capturedCmd = cmd;
          return { status: 0 };
        },
        pnpmBin: '/custom/pnpm',
      });

      expect(capturedCmd).toBe('/custom/pnpm');
    });
  });
});
