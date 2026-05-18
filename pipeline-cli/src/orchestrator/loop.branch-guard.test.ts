/**
 * Unit tests for `runParentBranchGuard` and `ParentNotOnMainError`
 * (AISDLC-358 reviewer findings — Test Major 1 + Test Major 2).
 *
 * Covers all five branches of `runParentBranchGuard`:
 *   1. No-git-repo (workDir not a git repo) → skips silently
 *   2. Detached HEAD → warns + continues (doesn't throw)
 *   3. Already on main → pass-through (no checkout/reset called)
 *   4. Clean non-main → auto-recover (checkout + reset called, info logged)
 *   5. Dirty non-main → throws `ParentNotOnMainError`
 *   6. Checkout failure → throws `ParentNotOnMainError` (Code Major 2 fix)
 *   7. Reset failure → throws `ParentNotOnMainError` (Code Major 2 fix)
 *
 * Also covers `ParentNotOnMainError` constructor:
 *   - dirtyPaths.length ≤ 5: no truncation
 *   - dirtyPaths.length > 5: truncates to 5 + "+N more" suffix
 *   - message contains branch name, dirty paths, recovery command with workDir
 */

import { describe, expect, it } from 'vitest';

import { ParentNotOnMainError, runParentBranchGuard } from './loop.js';
import type { Runner } from '../runtime/exec.js';
import type { PipelineLogger } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function silentLogger(): PipelineLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} };
}

function captureLogger(): { logger: PipelineLogger; infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    logger: {
      info: (m: string) => infos.push(m),
      warn: (m: string) => warns.push(m),
      error: () => {},
      progress: () => {},
    },
  };
}

/**
 * Build a synthetic `Runner` that returns configurable results based on
 * the first two git args (e.g. `rev-parse --git-common-dir`).
 *
 * `responses` maps `"<command> <arg0> <arg1>"` (or shorter) to a result.
 * Unmatched calls return `{ stdout: '', stderr: '', code: 0 }` by default.
 */
function makeRunner(responses: Record<string, { stdout: string; stderr: string; code: number }>): {
  runner: Runner;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: Runner = async (command, args) => {
    calls.push({ command, args: [...args] });
    const key2 = `${command} ${args.slice(0, 2).join(' ')}`;
    const key1 = `${command} ${args[0] ?? ''}`;
    return responses[key2] ?? responses[key1] ?? { stdout: '', stderr: '', code: 0 };
  };
  return { runner, calls };
}

// ── Branch 1: not in a git repo ───────────────────────────────────────────

describe('runParentBranchGuard — branch 1: not in a git repo', () => {
  it('skips silently when git rev-parse --git-common-dir returns empty stdout', async () => {
    const { runner, calls } = makeRunner({
      'git rev-parse': { stdout: '', stderr: 'fatal: not a git repository', code: 128 },
    });
    // Must not throw.
    await expect(
      runParentBranchGuard('/tmp/not-a-repo', runner, silentLogger()),
    ).resolves.toBeUndefined();
    // Only one call — no further git ops.
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('--git-common-dir');
  });

  it('skips silently when runner throws (test-double unconditional throw path)', async () => {
    const throwingRunner: Runner = async () => {
      throw new Error('runner exploded');
    };
    await expect(
      runParentBranchGuard('/tmp/not-a-repo', throwingRunner, silentLogger()),
    ).resolves.toBeUndefined();
  });

  it('skips silently when git-common-dir returns code 0 but empty stdout', async () => {
    const { runner } = makeRunner({
      'git rev-parse': { stdout: '  \n', stderr: '', code: 0 },
    });
    await expect(
      runParentBranchGuard('/tmp/strange', runner, silentLogger()),
    ).resolves.toBeUndefined();
  });
});

// ── Branch 2: detached HEAD ───────────────────────────────────────────────

describe('runParentBranchGuard — branch 2: detached HEAD', () => {
  it('warns + returns without throwing when HEAD is detached', async () => {
    const { runner } = makeRunner({
      'git rev-parse': { stdout: '.git\n', stderr: '', code: 0 },
      // symbolic-ref fails when HEAD is detached.
      'git symbolic-ref': {
        stdout: '',
        stderr: 'fatal: ref HEAD is not a symbolic ref',
        code: 128,
      },
    });
    const { logger, warns } = captureLogger();
    await expect(runParentBranchGuard('/tmp/repo', runner, logger)).resolves.toBeUndefined();
    expect(warns.some((w) => w.includes('detached'))).toBe(true);
  });

  it('warns when symbolic-ref returns code 0 but empty branch name', async () => {
    const { runner } = makeRunner({
      'git rev-parse': { stdout: '.git\n', stderr: '', code: 0 },
      'git symbolic-ref': { stdout: '\n', stderr: '', code: 0 },
    });
    const { logger, warns } = captureLogger();
    await runParentBranchGuard('/tmp/repo', runner, logger);
    expect(warns.some((w) => w.includes('detached'))).toBe(true);
  });
});

// ── Branch 3: already on main ─────────────────────────────────────────────

describe('runParentBranchGuard — branch 3: already on main', () => {
  it('returns without any git checkout/reset when already on main', async () => {
    const { runner, calls } = makeRunner({
      'git rev-parse': { stdout: '.git\n', stderr: '', code: 0 },
      'git symbolic-ref': { stdout: 'main\n', stderr: '', code: 0 },
    });
    await expect(
      runParentBranchGuard('/tmp/repo', runner, silentLogger()),
    ).resolves.toBeUndefined();
    const commandArgs = calls.map((c) => c.args[0]);
    // Must NOT have issued a checkout or reset.
    expect(commandArgs).not.toContain('checkout');
    expect(commandArgs).not.toContain('reset');
  });

  it('does not warn or log info when already on main', async () => {
    const { runner } = makeRunner({
      'git rev-parse': { stdout: '.git\n', stderr: '', code: 0 },
      'git symbolic-ref': { stdout: 'main\n', stderr: '', code: 0 },
    });
    const { logger, infos, warns } = captureLogger();
    await runParentBranchGuard('/tmp/repo', runner, logger);
    expect(infos).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });
});

// ── Branch 4: clean non-main → auto-recover ───────────────────────────────

describe('runParentBranchGuard — branch 4: clean non-main → auto-recover', () => {
  it('calls checkout + reset + logs info on a clean non-main branch', async () => {
    const { runner, calls } = makeRunner({
      'git rev-parse': { stdout: '.git\n', stderr: '', code: 0 },
      'git symbolic-ref': { stdout: 'feature/foo\n', stderr: '', code: 0 },
      'git status': { stdout: '', stderr: '', code: 0 }, // clean
      'git checkout': { stdout: '', stderr: '', code: 0 },
      'git reset': { stdout: 'HEAD is now at abc1234\n', stderr: '', code: 0 },
    });
    const { logger, infos, warns } = captureLogger();
    await expect(runParentBranchGuard('/tmp/repo', runner, logger)).resolves.toBeUndefined();

    // warn fires before the checkout
    expect(warns.some((w) => w.includes('feature/foo') && w.includes('auto-recovering'))).toBe(
      true,
    );
    // info fires after the reset
    expect(infos.some((i) => i.includes('auto-recovered') && i.includes('feature/foo'))).toBe(true);

    // checkout + reset were both called
    const checkoutCall = calls.find((c) => c.command === 'git' && c.args[0] === 'checkout');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall?.args).toContain('main');

    const resetCall = calls.find((c) => c.command === 'git' && c.args[0] === 'reset');
    expect(resetCall).toBeDefined();
    expect(resetCall?.args).toContain('--hard');
    expect(resetCall?.args).toContain('origin/main');
  });
});

// ── Branch 4 failure cases (Code Major 2 fix) ─────────────────────────────

describe('runParentBranchGuard — checkout/reset failure → throws (Code Major 2)', () => {
  it('throws ParentNotOnMainError when git checkout main fails', async () => {
    const { runner } = makeRunner({
      'git rev-parse': { stdout: '.git\n', stderr: '', code: 0 },
      'git symbolic-ref': { stdout: 'feature/broken\n', stderr: '', code: 0 },
      'git status': { stdout: '', stderr: '', code: 0 }, // clean
      'git checkout': {
        stdout: '',
        stderr: 'error: pathspec "main" did not match any branch',
        code: 1,
      },
    });
    await expect(runParentBranchGuard('/tmp/repo', runner, silentLogger())).rejects.toBeInstanceOf(
      ParentNotOnMainError,
    );
  });

  it('throws ParentNotOnMainError when git reset --hard origin/main fails', async () => {
    const { runner } = makeRunner({
      'git rev-parse': { stdout: '.git\n', stderr: '', code: 0 },
      'git symbolic-ref': { stdout: 'feature/broken\n', stderr: '', code: 0 },
      'git status': { stdout: '', stderr: '', code: 0 }, // clean
      'git checkout': { stdout: '', stderr: '', code: 0 }, // checkout succeeds
      'git reset': { stdout: '', stderr: 'fatal: ambiguous argument "origin/main"', code: 128 },
    });
    await expect(runParentBranchGuard('/tmp/repo', runner, silentLogger())).rejects.toBeInstanceOf(
      ParentNotOnMainError,
    );
  });

  it('does NOT log info "auto-recovered" when checkout fails', async () => {
    const { runner } = makeRunner({
      'git rev-parse': { stdout: '.git\n', stderr: '', code: 0 },
      'git symbolic-ref': { stdout: 'feature/broken\n', stderr: '', code: 0 },
      'git status': { stdout: '', stderr: '', code: 0 },
      'git checkout': { stdout: '', stderr: 'fatal: not a branch', code: 128 },
    });
    const { logger, infos } = captureLogger();
    await runParentBranchGuard('/tmp/repo', runner, logger).catch(() => {});
    expect(infos.some((i) => i.includes('auto-recovered'))).toBe(false);
  });
});

// ── Branch 5: dirty non-main → throws ─────────────────────────────────────

describe('runParentBranchGuard — branch 5: dirty non-main → throws', () => {
  it('throws ParentNotOnMainError with branch + paths when dirty on non-main', async () => {
    const { runner } = makeRunner({
      'git rev-parse': { stdout: '.git\n', stderr: '', code: 0 },
      'git symbolic-ref': { stdout: 'feature/dirty\n', stderr: '', code: 0 },
      'git status': {
        stdout: ' M pipeline-cli/src/orchestrator/loop.ts\n?? untracked.txt\n',
        stderr: '',
        code: 0,
      },
    });
    const err = await runParentBranchGuard('/tmp/repo', runner, silentLogger()).catch((e) => e);
    expect(err).toBeInstanceOf(ParentNotOnMainError);
    expect((err as ParentNotOnMainError).branch).toBe('feature/dirty');
    expect((err as ParentNotOnMainError).dirtyPaths).toEqual([
      'M pipeline-cli/src/orchestrator/loop.ts',
    ]); // ?? (untracked) excluded
    expect((err as ParentNotOnMainError).message).toContain('feature/dirty');
    expect((err as ParentNotOnMainError).message).toContain(
      'pipeline-cli/src/orchestrator/loop.ts',
    );
  });

  it('does NOT call checkout or reset when dirty', async () => {
    const { runner, calls } = makeRunner({
      'git rev-parse': { stdout: '.git\n', stderr: '', code: 0 },
      'git symbolic-ref': { stdout: 'feature/dirty\n', stderr: '', code: 0 },
      'git status': { stdout: ' M src/foo.ts\n M src/bar.ts\n', stderr: '', code: 0 },
    });
    await runParentBranchGuard('/tmp/repo', runner, silentLogger()).catch(() => {});
    const commandArgs = calls.map((c) => c.args[0]);
    expect(commandArgs).not.toContain('checkout');
    expect(commandArgs).not.toContain('reset');
  });
});

// ── ParentNotOnMainError unit tests (Test Major 2) ────────────────────────

describe('ParentNotOnMainError — constructor', () => {
  it('message contains branch name', () => {
    const err = new ParentNotOnMainError('feature/x', ['src/a.ts'], '/repo/root');
    expect(err.message).toContain("'feature/x'");
  });

  it('message contains dirty paths when count ≤ 5 (no truncation)', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    const err = new ParentNotOnMainError('feat', paths, '/repo');
    for (const p of paths) {
      expect(err.message).toContain(p);
    }
    expect(err.message).not.toContain('more');
  });

  it('truncates to 5 paths and appends "+N more" when dirtyPaths.length > 5', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    const err = new ParentNotOnMainError('feat', paths, '/repo');
    // First 5 must appear.
    for (const p of paths.slice(0, 5)) {
      expect(err.message).toContain(p);
    }
    // 6th and 7th must NOT appear literally (they're covered by the "+2 more" suffix).
    expect(err.message).not.toContain('f.ts');
    expect(err.message).not.toContain('g.ts');
    // "+2 more" suffix present.
    expect(err.message).toContain('+2 more');
  });

  it('message contains recovery command with workDir', () => {
    const err = new ParentNotOnMainError('feat', ['a.ts'], '/my/project');
    expect(err.message).toContain('/my/project');
    expect(err.message).toContain('checkout main');
    expect(err.message).toContain('reset --hard origin/main');
  });

  it('sets .name to "ParentNotOnMainError"', () => {
    const err = new ParentNotOnMainError('feat', [], '/repo');
    expect(err.name).toBe('ParentNotOnMainError');
  });

  it('exposes .branch, .dirtyPaths, .workDir properties', () => {
    const paths = ['x.ts', 'y.ts'];
    const err = new ParentNotOnMainError('some-branch', paths, '/workspace');
    expect(err.branch).toBe('some-branch');
    expect(err.dirtyPaths).toEqual(paths);
    expect(err.workDir).toBe('/workspace');
  });

  it('is instanceof Error', () => {
    const err = new ParentNotOnMainError('feat', [], '/repo');
    expect(err).toBeInstanceOf(Error);
  });

  it('handles exactly 5 paths — no "+N more"', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    const err = new ParentNotOnMainError('feat', paths, '/repo');
    expect(err.message).not.toContain('more');
    expect(err.message).toContain('e.ts');
  });

  it('handles 6 paths — "+1 more"', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'];
    const err = new ParentNotOnMainError('feat', paths, '/repo');
    expect(err.message).toContain('+1 more');
    expect(err.message).not.toContain('f.ts');
  });
});
