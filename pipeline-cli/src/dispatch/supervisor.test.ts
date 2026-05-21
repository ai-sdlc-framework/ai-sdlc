/**
 * Tests for the Worker Supervisor (RFC-0041 §4.5, AISDLC-377.3).
 *
 * Coverage map:
 *   - AC #1: Bin is ≤200 LOC + registered (asserted via a separate LOC test
 *     in `dispatch-supervisor.cli.test.ts`).
 *   - AC #2: Atomic claim already covered in `board.test.ts` — the
 *     supervisor's claim path calls `claimNext` directly so we cover the
 *     supervisor-level invariant (single spawn per manifest) here.
 *   - AC #3: PID file management (refuse second start when first live;
 *     stop cleans up gracefully).
 *   - AC #4: Stale heartbeat sweep fires at the configured threshold and
 *     SIGTERMs the spawned Worker.
 *   - AC #5: `env -u CLAUDECODE` confirmed before spawn.
 *   - AC #8: 3-manifest queue + 3 mock spawns → 3 verdicts collected,
 *     concurrency cap respected.
 *
 * Real `claude` is never invoked — the test injects a stub `spawn` that
 * returns a `MockChildProcess` with controllable `exit` semantics.
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claimNext,
  collectVerdicts,
  ensureBoardDirs,
  peekQueue,
  writeHeartbeat,
  writeManifest,
} from './board.js';
import {
  acquirePidLock,
  buildClaudeArgv,
  buildManifestPrompt,
  createSupervisorState,
  isProcessAlive,
  readPidFile,
  releasePidLock,
  runSupervisorTick,
  type SupervisorSpawn,
} from './supervisor.js';
import type { DispatchManifest, InflightHeartbeat } from './types.js';

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function mkBoard(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'sup-board-')), 'dispatch');
}

function mkManifest(taskId: string, overrides: Partial<DispatchManifest> = {}): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}-feat-x`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'claude-p-shell',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'conductor-test',
    spec: {
      taskFile: `backlog/tasks/${taskId.toLowerCase()} - feat.md`,
      budgetMs: 1800000,
      verifyCommands: ['pnpm build', 'pnpm test', 'pnpm lint'],
    },
    ...overrides,
  };
}

/** Mock ChildProcess that captures argv + env + can be triggered to exit. */
class MockChildProcess extends EventEmitter {
  public readonly pid: number;
  public readonly command: string;
  public readonly args: readonly string[];
  public readonly env: NodeJS.ProcessEnv;
  public readonly cwd: string | undefined;
  public killed = false;

  constructor(
    pid: number,
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) {
    super();
    this.pid = pid;
    this.command = command;
    this.args = args;
    this.env = options.env ?? {};
    this.cwd = options.cwd;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    setImmediate(() => this.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  }

  /** Test helper — emit a clean exit with a verdict already written. */
  exitClean(): void {
    setImmediate(() => this.emit('exit', 0, null));
  }

  /** Test helper — emit a non-zero exit (spawn-rejected style). */
  exitNonZero(code: number): void {
    setImmediate(() => this.emit('exit', code, null));
  }
}

function makeMockSpawnFactory(): {
  spawn: SupervisorSpawn;
  spawnedProcesses: MockChildProcess[];
} {
  const spawnedProcesses: MockChildProcess[] = [];
  let nextPid = 10000;
  const spawn: SupervisorSpawn = (command, args, options) => {
    const child = new MockChildProcess(nextPid++, command, args, options);
    spawnedProcesses.push(child);
    // Cast to ChildProcess — MockChildProcess satisfies the surface we use.
    return child as unknown as ReturnType<SupervisorSpawn>;
  };
  return { spawn, spawnedProcesses };
}

// ---------------------------------------------------------------------------
// buildClaudeArgv + buildManifestPrompt — pure helpers
// ---------------------------------------------------------------------------

describe('buildClaudeArgv', () => {
  it('emits the expected --print --output-format json --permission-mode argv shape', () => {
    const argv = buildClaudeArgv(mkManifest('AISDLC-100'));
    expect(argv).toContain('--print');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('json');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('bypassPermissions');
    expect(argv).toContain('--agent');
    expect(argv).toContain('developer');
  });

  it('includes --resume <sessionId> when lastSessionId is set (OQ-4 iteration)', () => {
    const argv = buildClaudeArgv(mkManifest('AISDLC-101', { lastSessionId: 'session-abc-123' }));
    expect(argv).toContain('--resume');
    expect(argv).toContain('session-abc-123');
  });

  it('omits --resume when lastSessionId is undefined', () => {
    const argv = buildClaudeArgv(mkManifest('AISDLC-102'));
    expect(argv).not.toContain('--resume');
  });

  it('places the prompt body as the final positional argument', () => {
    const argv = buildClaudeArgv(mkManifest('AISDLC-103'));
    const prompt = argv[argv.length - 1];
    expect(prompt).toContain('AISDLC-103');
    expect(prompt).toContain('claude-p-shell Worker');
  });
});

describe('buildManifestPrompt', () => {
  it('mentions the task id, worktree, branch, base sha, task file', () => {
    const manifest = mkManifest('AISDLC-200');
    const prompt = buildManifestPrompt(manifest);
    expect(prompt).toContain('AISDLC-200');
    expect(prompt).toContain(manifest.worktree);
    expect(prompt).toContain(manifest.branch);
    expect(prompt).toContain(manifest.baseSha);
    expect(prompt).toContain(manifest.spec.taskFile);
  });

  it('directs the agent to write to .ai-sdlc/dispatch/done/<task-id>.verdict.json', () => {
    const prompt = buildManifestPrompt(mkManifest('AISDLC-201'));
    expect(prompt).toContain('.ai-sdlc/dispatch/done');
    expect(prompt).toContain('.verdict.json');
  });
});

// ---------------------------------------------------------------------------
// PID file management
// ---------------------------------------------------------------------------

describe('PID file management (AC #3)', () => {
  let pidFile: string;
  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sup-pid-'));
    pidFile = path.join(dir, '.supervisor.pid');
  });

  it('acquires the lock when no file exists', () => {
    const result = acquirePidLock(pidFile);
    expect(result.acquired).toBe(true);
    expect(result.pid).toBe(process.pid);
    expect(existsSync(pidFile)).toBe(true);
    releasePidLock(pidFile);
  });

  it('refuses to acquire when a live PID owns the lock', () => {
    // Plant the current process's PID — it's by definition alive.
    writeFileSync(pidFile, `${process.pid}\n`, 'utf-8');
    const result = acquirePidLock(pidFile);
    expect(result.acquired).toBe(false);
    expect(result.liveOwner).toBe(process.pid);
    expect(result.reason).toMatch(/already running/i);
  });

  it('reclaims a stale lock (file present, PID dead)', () => {
    // Use a PID that won't exist — 1 is reserved init on POSIX but
    // outside container namespaces it's an arbitrary user PID. Use a
    // very large value to maximise the chance it's reaped.
    writeFileSync(pidFile, '99999999\n', 'utf-8');
    const result = acquirePidLock(pidFile);
    expect(result.acquired).toBe(true);
    expect(result.pid).toBe(process.pid);
    releasePidLock(pidFile);
  });

  it('readPidFile returns undefined on missing file', () => {
    expect(readPidFile(pidFile)).toBeUndefined();
  });

  it('readPidFile returns undefined on corrupt content', () => {
    writeFileSync(pidFile, 'not a number', 'utf-8');
    expect(readPidFile(pidFile)).toBeUndefined();
  });

  it('releasePidLock only removes file owned by current process', () => {
    writeFileSync(pidFile, `${process.pid + 1}\n`, 'utf-8');
    releasePidLock(pidFile);
    expect(existsSync(pidFile)).toBe(true);
  });

  it('releasePidLock removes file owned by current process', () => {
    writeFileSync(pidFile, `${process.pid}\n`, 'utf-8');
    releasePidLock(pidFile);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('isProcessAlive returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('isProcessAlive returns false for an obviously dead PID', () => {
    expect(isProcessAlive(99999999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runSupervisorTick — the core spawn loop
// ---------------------------------------------------------------------------

describe('runSupervisorTick', () => {
  let boardDir: string;
  beforeEach(() => {
    boardDir = mkBoard();
  });

  afterEach(() => {
    try {
      rmSync(path.dirname(boardDir), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('claims and spawns up to maxConcurrent manifests per tick (AC #8 — concurrency cap)', () => {
    writeManifest(boardDir, mkManifest('AISDLC-300'));
    writeManifest(boardDir, mkManifest('AISDLC-301'));
    writeManifest(boardDir, mkManifest('AISDLC-302'));
    const { spawn, spawnedProcesses } = makeMockSpawnFactory();
    const state = createSupervisorState();

    const result = runSupervisorTick({
      boardDir,
      maxConcurrent: 2,
      staleMs: 30 * 60_000,
      state,
      spawn,
    });

    expect(result.spawned).toBe(2);
    expect(result.inflightCount).toBe(2);
    expect(spawnedProcesses).toHaveLength(2);
    // Third manifest stays in queue/ — concurrency cap was respected.
    expect(peekQueue(boardDir).queued).toBe(1);
    expect(peekQueue(boardDir).inflight).toBe(2);
  });

  it('skips in-session-agent manifests (only claims claude-p-shell + any)', () => {
    writeManifest(boardDir, mkManifest('AISDLC-400'));
    writeManifest(boardDir, mkManifest('AISDLC-401', { workerKind: 'in-session-agent' }));
    writeManifest(boardDir, mkManifest('AISDLC-402', { workerKind: 'any' }));
    const { spawn, spawnedProcesses } = makeMockSpawnFactory();
    const state = createSupervisorState();

    runSupervisorTick({ boardDir, maxConcurrent: 10, staleMs: 30 * 60_000, state, spawn });

    // Two spawns: AISDLC-400 (shell) + AISDLC-402 (any). 401 stays queued.
    expect(spawnedProcesses).toHaveLength(2);
    expect(peekQueue(boardDir).queued).toBe(1);
  });

  it('scrubs CLAUDECODE from the child env (AC #5)', () => {
    writeManifest(boardDir, mkManifest('AISDLC-500'));
    // Set CLAUDECODE on the parent so we can verify it's stripped from the
    // child env. process.env mutation is restored in afterEach via vi.
    const originalClaudeCode = process.env.CLAUDECODE;
    process.env.CLAUDECODE = '1';

    try {
      const { spawn, spawnedProcesses } = makeMockSpawnFactory();
      const state = createSupervisorState();
      runSupervisorTick({ boardDir, maxConcurrent: 1, staleMs: 30 * 60_000, state, spawn });
      expect(spawnedProcesses).toHaveLength(1);
      const env = spawnedProcesses[0]!.env;
      expect(env.CLAUDECODE).toBeUndefined();
    } finally {
      if (originalClaudeCode === undefined) {
        delete process.env.CLAUDECODE;
      } else {
        process.env.CLAUDECODE = originalClaudeCode;
      }
    }
  });

  it('passes the manifest worktree as the child cwd', () => {
    writeManifest(boardDir, mkManifest('AISDLC-501'));
    const { spawn, spawnedProcesses } = makeMockSpawnFactory();
    runSupervisorTick({
      boardDir,
      maxConcurrent: 1,
      staleMs: 30 * 60_000,
      state: createSupervisorState(),
      spawn,
    });
    expect(spawnedProcesses[0]!.cwd).toBe('.worktrees/aisdlc-501');
  });

  it('tracks spawned PIDs in state.inflight; exit handler drops them', async () => {
    writeManifest(boardDir, mkManifest('AISDLC-600'));
    const { spawn, spawnedProcesses } = makeMockSpawnFactory();
    const state = createSupervisorState();
    runSupervisorTick({ boardDir, maxConcurrent: 1, staleMs: 30 * 60_000, state, spawn });
    expect(state.inflight.size).toBe(1);
    spawnedProcesses[0]!.exitClean();
    // Give the setImmediate microtask a chance to run.
    await new Promise((r) => setImmediate(r));
    expect(state.inflight.size).toBe(0);
  });

  it('writes a spawn-rejected diagnostic when spawn throws', () => {
    writeManifest(boardDir, mkManifest('AISDLC-700'));
    const failingSpawn: SupervisorSpawn = () => {
      throw new Error('ENOENT: claude binary missing');
    };
    runSupervisorTick({
      boardDir,
      maxConcurrent: 1,
      staleMs: 30 * 60_000,
      state: createSupervisorState(),
      spawn: failingSpawn,
    });
    // The diagnostic lands in failed/. Use collectVerdicts to pick it up.
    const verdicts = collectVerdicts(boardDir, { includeFailed: true });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.cause).toBe('spawn-rejected');
    expect(verdicts[0]!.notes).toContain('ENOENT');
  });

  it('writes a spawn-rejected diagnostic when child emits async "error" (ENOENT)', async () => {
    // child_process.spawn does NOT throw synchronously when the binary
    // is missing; it returns a ChildProcess that emits 'error' on the
    // next tick. The supervisor's 'error' handler catches this and
    // writes a spawn-rejected diagnostic — without it, the unhandled
    // 'error' event becomes an uncaught exception that breaks the daemon.
    writeManifest(boardDir, mkManifest('AISDLC-704'));
    const asyncErrorSpawn: SupervisorSpawn = (command, args, options) => {
      const child = new MockChildProcess(98765, command, args, options);
      setImmediate(() => child.emit('error', new Error('spawn claude ENOENT')));
      return child as unknown as ReturnType<SupervisorSpawn>;
    };
    runSupervisorTick({
      boardDir,
      maxConcurrent: 1,
      staleMs: 30 * 60_000,
      state: createSupervisorState(),
      spawn: asyncErrorSpawn,
    });
    await new Promise((r) => setImmediate(r));
    const verdicts = collectVerdicts(boardDir, { includeFailed: true });
    const diag = verdicts.find((v) => v.taskId === 'AISDLC-704');
    expect(diag?.cause).toBe('spawn-rejected');
    expect(diag?.notes).toContain('ENOENT');
  });

  it('writes a spawn-rejected diagnostic when child.pid is undefined', () => {
    writeManifest(boardDir, mkManifest('AISDLC-701'));
    const pidlessSpawn: SupervisorSpawn = (command, args, options) => {
      const child = new MockChildProcess(0, command, args, options);
      // Override `pid` to undefined to simulate the failure mode.
      Object.defineProperty(child, 'pid', { value: undefined });
      return child as unknown as ReturnType<SupervisorSpawn>;
    };
    runSupervisorTick({
      boardDir,
      maxConcurrent: 1,
      staleMs: 30 * 60_000,
      state: createSupervisorState(),
      spawn: pidlessSpawn,
    });
    const verdicts = collectVerdicts(boardDir, { includeFailed: true });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.cause).toBe('spawn-rejected');
  });

  it('writes a spawn-rejected diagnostic on non-zero exit when no verdict was emitted', async () => {
    writeManifest(boardDir, mkManifest('AISDLC-702'));
    const { spawn, spawnedProcesses } = makeMockSpawnFactory();
    runSupervisorTick({
      boardDir,
      maxConcurrent: 1,
      staleMs: 30 * 60_000,
      state: createSupervisorState(),
      spawn,
    });
    spawnedProcesses[0]!.exitNonZero(1);
    await new Promise((r) => setImmediate(r));
    const verdicts = collectVerdicts(boardDir, { includeFailed: true });
    expect(verdicts.length).toBeGreaterThanOrEqual(1);
    const diag = verdicts.find((v) => v.taskId === 'AISDLC-702');
    expect(diag?.cause).toBe('spawn-rejected');
  });

  it('does NOT double-write a diagnostic if the Worker already landed a verdict', async () => {
    writeManifest(boardDir, mkManifest('AISDLC-703'));
    const { spawn, spawnedProcesses } = makeMockSpawnFactory();
    const state = createSupervisorState();
    runSupervisorTick({ boardDir, maxConcurrent: 1, staleMs: 30 * 60_000, state, spawn });

    // Simulate the Worker landing its own verdict before exit.
    ensureBoardDirs(boardDir);
    writeFileSync(
      path.join(boardDir, 'failed', 'AISDLC-703.verdict.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        taskId: 'AISDLC-703',
        outcome: 'failed',
        completedAt: '2026-05-20T11:00:00.000Z',
        workerId: 'real-worker',
        cause: 'verify-failed',
      }),
      'utf-8',
    );

    spawnedProcesses[0]!.exitNonZero(1);
    await new Promise((r) => setImmediate(r));

    const verdicts = collectVerdicts(boardDir, { includeFailed: true });
    const matching = verdicts.filter((v) => v.taskId === 'AISDLC-703');
    expect(matching).toHaveLength(1);
    expect(matching[0]!.cause).toBe('verify-failed');
  });

  it('sweeps stale heartbeats and SIGTERMs the matching spawned PID (AC #4)', () => {
    writeManifest(boardDir, mkManifest('AISDLC-800'));
    const { spawn, spawnedProcesses } = makeMockSpawnFactory();
    const state = createSupervisorState();
    runSupervisorTick({ boardDir, maxConcurrent: 1, staleMs: 30 * 60_000, state, spawn });

    // Plant a heartbeat that is 60 min old → past the 30 min threshold.
    const hb: InflightHeartbeat = {
      taskId: 'AISDLC-800',
      workerId: 'mock-worker',
      workerKind: 'claude-p-shell',
      pid: spawnedProcesses[0]!.pid,
      startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      lastHeartbeat: new Date(Date.now() - 60 * 60_000).toISOString(),
    };
    writeHeartbeat(boardDir, hb);

    // Spy on process.kill — we want to assert the supervisor sent a signal.
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const tick = runSupervisorTick({
        boardDir,
        maxConcurrent: 1,
        staleMs: 30 * 60_000,
        state,
        spawn,
      });
      expect(tick.reapedTaskIds).toContain('AISDLC-800');
      expect(killSpy).toHaveBeenCalledWith(spawnedProcesses[0]!.pid, 'SIGTERM');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('tolerates process.kill errors on stale-heartbeat sweep', () => {
    writeManifest(boardDir, mkManifest('AISDLC-801'));
    const { spawn, spawnedProcesses } = makeMockSpawnFactory();
    const state = createSupervisorState();
    runSupervisorTick({ boardDir, maxConcurrent: 1, staleMs: 30 * 60_000, state, spawn });

    writeHeartbeat(boardDir, {
      taskId: 'AISDLC-801',
      workerId: 'mock-worker',
      workerKind: 'claude-p-shell',
      pid: spawnedProcesses[0]!.pid,
      startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      lastHeartbeat: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    try {
      expect(() =>
        runSupervisorTick({
          boardDir,
          maxConcurrent: 1,
          staleMs: 30 * 60_000,
          state,
          spawn,
        }),
      ).not.toThrow();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('logs to the injected logger when present', () => {
    writeManifest(boardDir, mkManifest('AISDLC-900'));
    const { spawn } = makeMockSpawnFactory();
    const logs: string[] = [];
    runSupervisorTick({
      boardDir,
      maxConcurrent: 1,
      staleMs: 30 * 60_000,
      state: createSupervisorState(),
      spawn,
      log: (msg) => logs.push(msg),
    });
    expect(logs.some((l) => l.includes('spawned'))).toBe(true);
    expect(logs.some((l) => l.includes('AISDLC-900'))).toBe(true);
  });

  it('hermetic 3-manifest queue + supervisor → 3 spawns when cap allows it (AC #8)', () => {
    writeManifest(boardDir, mkManifest('AISDLC-1000'));
    writeManifest(boardDir, mkManifest('AISDLC-1001'));
    writeManifest(boardDir, mkManifest('AISDLC-1002'));
    const { spawn, spawnedProcesses } = makeMockSpawnFactory();
    const state = createSupervisorState();

    const tick = runSupervisorTick({
      boardDir,
      maxConcurrent: 3,
      staleMs: 30 * 60_000,
      state,
      spawn,
    });

    expect(tick.spawned).toBe(3);
    expect(spawnedProcesses).toHaveLength(3);
    expect(peekQueue(boardDir).queued).toBe(0);
    expect(peekQueue(boardDir).inflight).toBe(3);
    // Simulate all three Workers landing verdicts.
    for (const child of spawnedProcesses) {
      ensureBoardDirs(boardDir);
      const taskId = state.inflight.get(child.pid)!.taskId;
      writeFileSync(
        path.join(boardDir, 'done', `${taskId}.verdict.json`),
        JSON.stringify({
          schemaVersion: 'v1',
          taskId,
          outcome: 'success',
          completedAt: new Date().toISOString(),
          workerId: `mock-${child.pid}`,
          workerKind: 'claude-p-shell',
          durationMs: 600_000,
        }),
        'utf-8',
      );
      child.exitClean();
    }
    // Allow exit handlers to run.
    return new Promise<void>((r) =>
      setImmediate(() => {
        const verdicts = collectVerdicts(boardDir, { includeFailed: true });
        expect(verdicts).toHaveLength(3);
        r();
      }),
    );
  });

  it('respects the noClaimBefore cool-down (manifest re-emitted later wins on second tick)', () => {
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    writeManifest(boardDir, mkManifest('AISDLC-1100', { noClaimBefore: futureIso }));
    const { spawn, spawnedProcesses } = makeMockSpawnFactory();
    const state = createSupervisorState();

    // Tick 1 with the default `now` — manifest is still in cool-down.
    runSupervisorTick({ boardDir, maxConcurrent: 5, staleMs: 30 * 60_000, state, spawn });
    expect(spawnedProcesses).toHaveLength(0);
    expect(peekQueue(boardDir).queued).toBe(1);

    // Tick 2 with `now` advanced — the manifest is now claimable.
    runSupervisorTick({
      boardDir,
      maxConcurrent: 5,
      staleMs: 30 * 60_000,
      state,
      spawn,
      now: () => new Date(Date.now() + 120_000),
    });
    expect(spawnedProcesses).toHaveLength(1);
  });

  it('preserves operator env (OQ-2) — inherits parent env except CLAUDECODE', () => {
    writeManifest(boardDir, mkManifest('AISDLC-1200'));
    // Plant a sentinel env var to verify it gets forwarded.
    process.env.AISDLC_SENTINEL_FOR_TEST = 'preserved';
    try {
      const { spawn, spawnedProcesses } = makeMockSpawnFactory();
      runSupervisorTick({
        boardDir,
        maxConcurrent: 1,
        staleMs: 30 * 60_000,
        state: createSupervisorState(),
        spawn,
      });
      expect(spawnedProcesses[0]!.env.AISDLC_SENTINEL_FOR_TEST).toBe('preserved');
    } finally {
      delete process.env.AISDLC_SENTINEL_FOR_TEST;
    }
  });

  it('empty queue → no spawns, no errors', () => {
    const { spawn, spawnedProcesses } = makeMockSpawnFactory();
    const result = runSupervisorTick({
      boardDir,
      maxConcurrent: 5,
      staleMs: 30 * 60_000,
      state: createSupervisorState(),
      spawn,
    });
    expect(result.spawned).toBe(0);
    expect(spawnedProcesses).toHaveLength(0);
    expect(result.reapedTaskIds).toEqual([]);
  });

  it('uses the injected claudeBinary when provided', () => {
    writeManifest(boardDir, mkManifest('AISDLC-1300'));
    const { spawn, spawnedProcesses } = makeMockSpawnFactory();
    runSupervisorTick({
      boardDir,
      maxConcurrent: 1,
      staleMs: 30 * 60_000,
      state: createSupervisorState(),
      spawn,
      claudeBinary: '/opt/claude-staging/bin/claude',
    });
    expect(spawnedProcesses[0]!.command).toBe('/opt/claude-staging/bin/claude');
  });

  it('atomic-claim guarantee: a manifest is never spawned twice across consecutive ticks (AC #2)', () => {
    writeManifest(boardDir, mkManifest('AISDLC-1400'));
    const { spawn, spawnedProcesses } = makeMockSpawnFactory();
    const state = createSupervisorState();

    runSupervisorTick({ boardDir, maxConcurrent: 5, staleMs: 30 * 60_000, state, spawn });
    runSupervisorTick({ boardDir, maxConcurrent: 5, staleMs: 30 * 60_000, state, spawn });

    expect(spawnedProcesses).toHaveLength(1);
    // Sanity: also try claiming directly — nothing left in queue.
    expect(claimNext(boardDir, 'claude-p-shell').claimed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verdict-state interaction: a stale `dispatchedAt` (no heartbeat) → reap
// ---------------------------------------------------------------------------

describe('runSupervisorTick — fallback to manifest.dispatchedAt for staleness', () => {
  it('reaps an inflight manifest with no heartbeat when dispatchedAt is older than staleMs', () => {
    const boardDir = mkBoard();
    const oldManifest = mkManifest('AISDLC-1500', {
      dispatchedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    writeManifest(boardDir, oldManifest);
    // Manually claim so the manifest is in inflight/ but no heartbeat exists.
    claimNext(boardDir, 'claude-p-shell');

    const { spawn } = makeMockSpawnFactory();
    const state = createSupervisorState();
    const result = runSupervisorTick({
      boardDir,
      maxConcurrent: 1,
      staleMs: 30 * 60_000,
      state,
      spawn,
    });
    expect(result.reapedTaskIds).toContain('AISDLC-1500');
    const verdicts = collectVerdicts(boardDir, { includeFailed: true });
    expect(verdicts.find((v) => v.taskId === 'AISDLC-1500')?.cause).toBe('stale-heartbeat');
  });
});
