/**
 * Hermetic unit tests for `runParentBranchGuard` (AISDLC-363 AC #4).
 *
 * Cover the three defence-in-depth skip paths:
 *   1. GH merge-queue probe branch (gh-readonly-queue/*) → skip silently.
 *   2. Shallow CI clone where `git checkout main` returns pathspec error → skip.
 *   3. Non-main + clean tree + local main present → auto-recovers (checkout succeeds).
 *
 * All tests use an injected `Runner` stub — no real git process is spawned.
 */

import { describe, expect, it } from 'vitest';

import { runParentBranchGuard, ParentNotOnMainError } from './index.js';
import type { Runner } from '../runtime/exec.js';
import type { PipelineLogger } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────

function captureLogger(): { logger: PipelineLogger; warns: string[]; infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  const logger: PipelineLogger = {
    info: (msg: string) => {
      infos.push(msg);
    },
    warn: (msg: string) => {
      warns.push(msg);
    },
    error: () => {},
    progress: () => {},
  };
  return { logger, warns, infos };
}

/**
 * Build a stub Runner. The caller supplies a map from
 * `"<command> <args.join(' ')>"` → ExecResult. Any key not found in the map
 * defaults to `{ stdout: '', stderr: '', code: 0 }`.
 */
function makeStubRunner(
  responses: Record<string, { stdout: string; stderr: string; code: number }>,
): Runner {
  return async (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    return responses[key] ?? { stdout: '', stderr: '', code: 0 };
  };
}

// ── Test cases ────────────────────────────────────────────────────────

describe('runParentBranchGuard — AISDLC-363 AC #4', () => {
  it('skips silently when already on main', async () => {
    const { logger, warns, infos } = captureLogger();
    const runner = makeStubRunner({
      'git symbolic-ref --short HEAD': { stdout: 'main\n', stderr: '', code: 0 },
    });

    await runParentBranchGuard('/tmp/test-workdir', runner, logger);

    // No warnings, no info — completely silent.
    expect(warns).toHaveLength(0);
    expect(infos).toHaveLength(0);
  });

  it('skips with info when on a GH merge-queue probe branch (AISDLC-363 code-reviewer)', async () => {
    const { logger, warns, infos } = captureLogger();
    const queueBranch = 'gh-readonly-queue/main/pr-42-a1b2c3d4e5f6';
    const runner = makeStubRunner({
      'git symbolic-ref --short HEAD': { stdout: `${queueBranch}\n`, stderr: '', code: 0 },
    });

    await runParentBranchGuard('/tmp/test-workdir', runner, logger);

    // Should emit one info containing the queue branch name (info, not warn —
    // queue probe is sanctioned ephemeral state, not an anomaly).
    expect(infos.some((m) => m.includes(queueBranch))).toBe(true);
    expect(warns).toHaveLength(0);
    // Should NOT throw — the function must return normally.
  });

  it('skips with warn when git checkout main returns pathspec error (shallow clone)', async () => {
    const { logger, warns } = captureLogger();
    const runner = makeStubRunner({
      'git symbolic-ref --short HEAD': { stdout: 'feat/something\n', stderr: '', code: 0 },
      'git status --porcelain': { stdout: '', stderr: '', code: 0 },
      'git checkout main': {
        stdout: '',
        stderr: "error: pathspec 'main' did not match any file(s) known to git",
        code: 1,
      },
    });

    await runParentBranchGuard('/tmp/test-workdir', runner, logger);

    // Should emit a warning about shallow clone.
    expect(warns.some((w) => w.toLowerCase().includes('shallow') || w.includes('pathspec'))).toBe(
      true,
    );
  });

  it('auto-recovers clean non-main tree by checking out main', async () => {
    const { logger, warns, infos } = captureLogger();
    const runner = makeStubRunner({
      'git symbolic-ref --short HEAD': { stdout: 'feat/my-feature\n', stderr: '', code: 0 },
      'git status --porcelain': { stdout: '', stderr: '', code: 0 }, // clean tree
      'git checkout main': { stdout: '', stderr: '', code: 0 },
    });

    await runParentBranchGuard('/tmp/test-workdir', runner, logger);

    // Should have warned about being on the wrong branch, then info'd the recovery.
    expect(warns.some((w) => w.includes('feat/my-feature'))).toBe(true);
    expect(infos.some((i) => i.includes('auto-recovered'))).toBe(true);
  });

  it('throws ParentNotOnMainError when tree is dirty on non-main branch', async () => {
    const { logger } = captureLogger();
    const runner = makeStubRunner({
      'git symbolic-ref --short HEAD': { stdout: 'feat/dirty\n', stderr: '', code: 0 },
      'git status --porcelain': {
        stdout: ' M pipeline-cli/src/index.ts\n M CHANGELOG.md\n',
        stderr: '',
        code: 0,
      },
    });

    await expect(runParentBranchGuard('/tmp/test-workdir', runner, logger)).rejects.toBeInstanceOf(
      ParentNotOnMainError,
    );
  });

  it('throws ParentNotOnMainError when checkout main fails for a non-pathspec reason', async () => {
    const { logger } = captureLogger();
    const runner = makeStubRunner({
      'git symbolic-ref --short HEAD': { stdout: 'feat/conflict\n', stderr: '', code: 0 },
      'git status --porcelain': { stdout: '', stderr: '', code: 0 },
      'git checkout main': {
        stdout: '',
        stderr: 'error: Your local changes to the following files would be overwritten by checkout',
        code: 1,
      },
    });

    await expect(runParentBranchGuard('/tmp/test-workdir', runner, logger)).rejects.toBeInstanceOf(
      ParentNotOnMainError,
    );
  });

  it('skips with warn when symbolic-ref fails (detached HEAD)', async () => {
    const { logger, warns } = captureLogger();
    const runner = makeStubRunner({
      'git symbolic-ref --short HEAD': {
        stdout: '',
        stderr: 'fatal: ref HEAD is not a symbolic ref',
        code: 128,
      },
    });

    await runParentBranchGuard('/tmp/test-workdir', runner, logger);

    // Detached HEAD → non-fatal skip.
    expect(warns.some((w) => w.includes('cannot resolve HEAD'))).toBe(true);
  });
});
