/**
 * Hermetic tests for the dist-staleness auto-rebuild helper (AISDLC-226).
 *
 * Coverage matrix (AC #5):
 *   - src/ newer than dist/ → rebuild fires
 *   - dist/ newer than src/ (or equal) → rebuild skipped
 *   - AI_SDLC_ORCHESTRATOR_SKIP_REBUILD=1 → rebuild skipped unconditionally
 *   - skipRebuild option → rebuild skipped unconditionally
 *   - rebuild failure (non-zero exit) → throws with clear message
 *   - dist/index.js missing (fresh clone) → silent no-op
 *   - src/index.ts missing (wrong package root) → silent no-op
 *
 * All tests use a tmpdir fixture tree and inject spawnFn/stderrWrite to stay
 * fully hermetic — no real pnpm build is invoked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
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

    it('is a no-op when src/index.ts does not exist (wrong package root)', () => {
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
