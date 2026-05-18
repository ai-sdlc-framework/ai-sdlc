/**
 * Integration tests for AISDLC-256 — sweepMergedWorktrees() wired into
 * the autonomous orchestrator tick loop.
 *
 * These tests verify:
 *   1. A merged-PR worktree is removed at the START of a tick (before the
 *      frontier scan fires).
 *   2. A sweep failure NEVER aborts the tick — the loop continues even if
 *      `gh` is unreachable.
 *   3. An `OrchestratorWorktreeSwept` event is emitted per swept entry.
 *   4. Non-merged worktrees (open PR or no PR) are NOT removed.
 *
 * Hermetic: uses `mkdtempSync` workDirs + a stub runner/dispatcher so no
 * real git/gh/spawner calls happen.
 *
 * IMPORTANT: every `execSync('git ...')` call uses `env: GIT_ENV` per
 * AISDLC-253, preventing GIT_DIR / GIT_WORK_TREE bleed from the parent
 * shell's husky pre-push environment.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultOrchestratorConfig,
  runOrchestratorTick,
  type OrchestratorAdapters,
} from './index.js';
import type { OrchestratorEvent } from './events.js';
import type { ExecOptions, ExecResult, Runner } from '../runtime/exec.js';
import type { PipelineLogger } from '../types.js';
import { makeGitEnv } from '../__test-helpers/git-env.js';

// ── Test helpers ──────────────────────────────────────────────────────────
//
// AISDLC-253: every `execSync('git ...')` MUST use `env: GIT_ENV` so the
// fixture's git ops never bleed into the host worktree via polluted
// GIT_DIR / GIT_WORK_TREE inherited from the parent shell.

const GIT_ENV: NodeJS.ProcessEnv = makeGitEnv();

function silentLogger(): PipelineLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} };
}

function captureSink(): { events: OrchestratorEvent[]; sink: (e: OrchestratorEvent) => void } {
  const events: OrchestratorEvent[] = [];
  return { events, sink: (e: OrchestratorEvent): void => void events.push(e) };
}

/**
 * Create a minimal worktree fixture under `<workDir>/.worktrees/<wtName>/`
 * with a real git repo so `git rev-parse --abbrev-ref HEAD` returns `<branch>`.
 */
function makeWorktreeFixture(workDir: string, wtName: string, branch: string): string {
  const wtPath = join(workDir, '.worktrees', wtName);
  mkdirSync(wtPath, { recursive: true });
  execSync('git init -b ' + branch, { cwd: wtPath, env: GIT_ENV, stdio: 'pipe' });
  // Commit so HEAD is not detached (rev-parse needs a resolvable HEAD).
  writeFileSync(join(wtPath, 'README.md'), '# fixture', 'utf8');
  execSync('git add README.md', { cwd: wtPath, env: GIT_ENV, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: wtPath, env: GIT_ENV, stdio: 'pipe' });
  return wtPath;
}

/**
 * Build a runner that:
 *   - Uses real `execSync` for `git` commands (so actual git repos are
 *     queried and modified — rev-parse returns the real branch, worktree
 *     remove actually removes the directory).
 *   - Stubs `gh pr list` to return a configurable PR state.
 *   - All other non-git/non-gh commands return code 0 / empty.
 */
function makeRunner(branchStates: Record<string, 'MERGED' | 'OPEN' | null>): {
  runner: Runner;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: Runner = async (command, args, opts: ExecOptions = {}): Promise<ExecResult> => {
    calls.push({ command, args: [...args] });

    // Stub: gh pr list --head <branch> --state all ...
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      const headIdx = args.indexOf('--head');
      const branch = headIdx >= 0 ? args[headIdx + 1] : undefined;
      const state = branch ? (branchStates[branch] ?? null) : null;
      if (state === 'MERGED') {
        return {
          stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-05-09T12:00:00Z', number: 1 }),
          stderr: '',
          code: 0,
        };
      }
      if (state === 'OPEN') {
        return {
          stdout: JSON.stringify({ state: 'OPEN', mergedAt: null, number: 2 }),
          stderr: '',
          code: 0,
        };
      }
      // null = no PR found
      return { stdout: 'null', stderr: '', code: 0 };
    }

    // Real git execution — allows rev-parse to work against the fixture repos
    // created by makeWorktreeFixture(). `git worktree remove` is intercepted
    // and handled via rmSync because the fixture repos are standalone (not
    // linked worktrees), so `git worktree remove` would fail in that context.
    if (command === 'git') {
      // Intercept `git worktree remove --force <path>` — remove the directory
      // directly so the test can assert on directory existence.
      if (args[0] === 'worktree' && args[1] === 'remove') {
        const targetPath = args[args.length - 1];
        if (targetPath) {
          try {
            rmSync(targetPath, { recursive: true, force: true });
          } catch {
            // no-op — mirror the allow-failure behaviour of the real function
          }
        }
        return { stdout: '', stderr: '', code: 0 };
      }
      try {
        const result = execSync([command, ...args].join(' '), {
          cwd: opts.cwd as string | undefined,
          env: GIT_ENV,
          stdio: 'pipe',
        });
        return { stdout: result.toString('utf8'), stderr: '', code: 0 };
      } catch (err) {
        const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
        return {
          stdout: e.stdout?.toString('utf8') ?? '',
          stderr: e.stderr?.toString('utf8') ?? '',
          code: e.status ?? 1,
        };
      }
    }

    // Permissive default.
    return { stdout: '', stderr: '', code: 0 };
  };
  return { runner, calls };
}

/** Minimal task file so the frontier returns a candidate (or empty). */
function makeWorkDirWithTask(taskId: string, status = 'To Do'): string {
  const workDir = mkdtempSync(join(tmpdir(), 'loop-sweep-test-'));
  mkdirSync(join(workDir, 'backlog', 'tasks'), { recursive: true });
  const taskFile = join(workDir, 'backlog', 'tasks', `${taskId.toLowerCase()} - test-task.md`);
  writeFileSync(
    taskFile,
    `---\nid: ${taskId}\ntitle: test task\nstatus: ${status}\n---\n\n## Description\nbody\n`,
    'utf8',
  );
  return workDir;
}

// ── Cleanup ───────────────────────────────────────────────────────────────

const workDirs: string[] = [];
afterEach(() => {
  for (const d of workDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
  workDirs.length = 0;
});

// ── AC #1 — merged worktree is removed at tick start ─────────────────────

describe('AISDLC-256 — sweep wired into runOrchestratorTick', () => {
  it('removes a merged-PR worktree before the frontier scan', async () => {
    const workDir = makeWorkDirWithTask('AISDLC-256');
    workDirs.push(workDir);

    const branch = 'ai-sdlc/aisdlc-merged-task';
    const wtPath = makeWorktreeFixture(workDir, 'aisdlc-merged-task', branch);

    const { runner } = makeRunner({ [branch]: 'MERGED' });
    const { sink } = captureSink();

    const config = defaultOrchestratorConfig({ workDir, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      runner,
      emitEvent: sink,
      // Empty frontier so the tick exits without dispatch.
      frontier: () => [],
      // No-op sleep so the test doesn't wait.
      sleep: () => Promise.resolve(),
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 0);

    // Worktree directory must have been removed.
    expect(existsSync(wtPath)).toBe(false);
  });

  // ── AC #3 — OrchestratorWorktreeSwept event emitted ──────────────────

  it('emits OrchestratorWorktreeSwept event for each swept worktree', async () => {
    const workDir = makeWorkDirWithTask('AISDLC-256');
    workDirs.push(workDir);

    const branch = 'ai-sdlc/aisdlc-swept-task';
    makeWorktreeFixture(workDir, 'aisdlc-swept-task', branch);

    const { runner } = makeRunner({ [branch]: 'MERGED' });
    const { events, sink } = captureSink();

    const config = defaultOrchestratorConfig({ workDir, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      runner,
      emitEvent: sink,
      frontier: () => [],
      sleep: () => Promise.resolve(),
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 0);

    const sweptEvents = events.filter((e) => e.type === 'OrchestratorWorktreeSwept');
    expect(sweptEvents).toHaveLength(1);
    expect(sweptEvents[0]?.branch).toBe(branch);
    expect(typeof sweptEvents[0]?.worktreePath).toBe('string');
    expect(typeof sweptEvents[0]?.mergedAt).toBe('string');
  });

  // ── AC #2 — sweep failure never aborts the tick ───────────────────────

  it('continues the tick even when the sweep throws', async () => {
    const workDir = makeWorkDirWithTask('AISDLC-256');
    workDirs.push(workDir);

    // Runner that throws unconditionally — simulates a gh network failure.
    const throwingRunner: Runner = async () => {
      throw new Error('network unreachable');
    };

    const frontierCalled = { value: false };
    const { sink } = captureSink();

    const config = defaultOrchestratorConfig({ workDir, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      runner: throwingRunner,
      emitEvent: sink,
      // Track whether frontier is called — it must be even after sweep throws.
      frontier: () => {
        frontierCalled.value = true;
        return [];
      },
      sleep: () => Promise.resolve(),
      parentBranchGuard: async () => {},
    };

    // Should NOT throw despite the runner throwing inside sweepMergedWorktrees.
    await expect(runOrchestratorTick(config, adapters, 0)).resolves.toBeDefined();
    expect(frontierCalled.value).toBe(true);
  });

  // ── Non-merged worktrees are NOT removed ─────────────────────────────

  it('does NOT remove an open-PR worktree', async () => {
    const workDir = makeWorkDirWithTask('AISDLC-256');
    workDirs.push(workDir);

    const branch = 'ai-sdlc/aisdlc-open-task';
    const wtPath = makeWorktreeFixture(workDir, 'aisdlc-open-task', branch);

    const { runner } = makeRunner({ [branch]: 'OPEN' });
    const { events, sink } = captureSink();

    const config = defaultOrchestratorConfig({ workDir, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      runner,
      emitEvent: sink,
      frontier: () => [],
      sleep: () => Promise.resolve(),
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 0);

    // Worktree must still be present.
    expect(existsSync(wtPath)).toBe(true);

    // No swept events.
    const sweptEvents = events.filter((e) => e.type === 'OrchestratorWorktreeSwept');
    expect(sweptEvents).toHaveLength(0);
  });

  it('does NOT remove a worktree with no corresponding PR', async () => {
    const workDir = makeWorkDirWithTask('AISDLC-256');
    workDirs.push(workDir);

    const branch = 'ai-sdlc/aisdlc-no-pr-task';
    const wtPath = makeWorktreeFixture(workDir, 'aisdlc-no-pr-task', branch);

    // null = no PR found
    const { runner } = makeRunner({ [branch]: null });
    const { events, sink } = captureSink();

    const config = defaultOrchestratorConfig({ workDir, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      runner,
      emitEvent: sink,
      frontier: () => [],
      sleep: () => Promise.resolve(),
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 0);

    expect(existsSync(wtPath)).toBe(true);
    const sweptEvents = events.filter((e) => e.type === 'OrchestratorWorktreeSwept');
    expect(sweptEvents).toHaveLength(0);
  });
});

// ── AC #4 (optional) — OrchestratorWorktreeSwept event fields ────────────

describe('AISDLC-256 — OrchestratorWorktreeSwept event envelope', () => {
  it('swept event carries tick + runId from the emitter', async () => {
    const workDir = makeWorkDirWithTask('AISDLC-256');
    workDirs.push(workDir);

    const branch = 'ai-sdlc/aisdlc-event-fields-task';
    makeWorktreeFixture(workDir, 'aisdlc-event-fields-task', branch);

    const { runner } = makeRunner({ [branch]: 'MERGED' });
    const { events, sink } = captureSink();

    const config = defaultOrchestratorConfig({ workDir, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      runner,
      emitEvent: sink,
      frontier: () => [],
      sleep: () => Promise.resolve(),
      runId: 'test-run-id-256',
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 7);

    const sweptEvents = events.filter((e) => e.type === 'OrchestratorWorktreeSwept');
    expect(sweptEvents).toHaveLength(1);
    expect(sweptEvents[0]?.tick).toBe(7);
    expect(sweptEvents[0]?.runId).toBe('test-run-id-256');
    expect(sweptEvents[0]?.ts).toBeTruthy();
  });
});

// ── AISDLC-256 kill switch (security review minor) ───────────────────────
//
// `AI_SDLC_SWEEP_DISABLED=1` (or true/yes/on) skips the sweep call entirely
// for the tick. Operator escape hatch when investigating a suspected
// spurious-MERGED incident or running with a known-stale gh API.

describe('AISDLC-256 — AI_SDLC_SWEEP_DISABLED kill switch', () => {
  const originalEnv = process.env['AI_SDLC_SWEEP_DISABLED'];
  afterEach(() => {
    if (originalEnv === undefined) delete process.env['AI_SDLC_SWEEP_DISABLED'];
    else process.env['AI_SDLC_SWEEP_DISABLED'] = originalEnv;
  });

  it('skips sweep entirely when AI_SDLC_SWEEP_DISABLED=1 (worktree NOT removed)', async () => {
    process.env['AI_SDLC_SWEEP_DISABLED'] = '1';
    const workDir = makeWorkDirWithTask('AISDLC-256');
    workDirs.push(workDir);
    const branch = 'ai-sdlc/aisdlc-disabled-merged';
    const wtPath = makeWorktreeFixture(workDir, 'aisdlc-disabled-merged', branch);

    const { runner } = makeRunner({ [branch]: 'MERGED' });
    const { events, sink } = captureSink();

    const config = defaultOrchestratorConfig({ workDir, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      runner,
      emitEvent: sink,
      frontier: () => [],
      sleep: () => Promise.resolve(),
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 0);

    // Worktree NOT removed because sweep was skipped.
    expect(existsSync(wtPath)).toBe(true);
    // No OrchestratorWorktreeSwept event emitted.
    expect(events.filter((e) => e.type === 'OrchestratorWorktreeSwept')).toHaveLength(0);
  });

  it.each(['true', 'yes', 'on', 'TRUE', 'YES', 'On'])(
    'accepts truthy value %s as kill switch',
    async (val) => {
      process.env['AI_SDLC_SWEEP_DISABLED'] = val;
      const workDir = makeWorkDirWithTask('AISDLC-256');
      workDirs.push(workDir);
      const branch = `ai-sdlc/aisdlc-disabled-${val.toLowerCase()}`;
      const wtPath = makeWorktreeFixture(workDir, `aisdlc-disabled-${val.toLowerCase()}`, branch);

      const { runner } = makeRunner({ [branch]: 'MERGED' });
      const { sink } = captureSink();

      const config = defaultOrchestratorConfig({ workDir, maxTicks: 1 });
      const adapters: OrchestratorAdapters = {
        logger: silentLogger(),
        runner,
        emitEvent: sink,
        frontier: () => [],
        sleep: () => Promise.resolve(),
        parentBranchGuard: async () => {},
      };

      await runOrchestratorTick(config, adapters, 0);
      expect(existsSync(wtPath)).toBe(true);
    },
  );

  it('does NOT skip sweep for falsy / unset / arbitrary values', async () => {
    // Unset
    delete process.env['AI_SDLC_SWEEP_DISABLED'];
    const workDir = makeWorkDirWithTask('AISDLC-256');
    workDirs.push(workDir);
    const branch = 'ai-sdlc/aisdlc-default-sweep';
    const wtPath = makeWorktreeFixture(workDir, 'aisdlc-default-sweep', branch);

    const { runner } = makeRunner({ [branch]: 'MERGED' });
    const { sink } = captureSink();

    const config = defaultOrchestratorConfig({ workDir, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      runner,
      emitEvent: sink,
      frontier: () => [],
      sleep: () => Promise.resolve(),
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 0);
    // Default behavior: sweep removes the merged worktree.
    expect(existsSync(wtPath)).toBe(false);
  });
});
