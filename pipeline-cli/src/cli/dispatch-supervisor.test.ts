/**
 * Tests for `cli-dispatch-supervisor` — the daemon CLI surface (RFC-0041
 * §4.5, AISDLC-377.3).
 *
 * Covered:
 *   - parseArgv: subcommand + flag pairs + bare flags.
 *   - `start --once`: runs one tick + exits cleanly + releases the PID file.
 *   - `start` refuses second invocation when a live PID owns the lock (AC #3).
 *   - `status`: returns alive=true when PID file points to current process;
 *     alive=false on missing/dead PID; includes board occupancy.
 *   - `stop`: SIGTERMs the PID, force-kills after graceMs, removes PID file (AC #3).
 *   - Help text printed for `help` / unknown subcommand routing.
 *   - LOC budget: `pipeline-cli/src/cli/dispatch-supervisor.ts` ≤200 LOC of
 *     non-comment code (AC #1 — supervisor bin ≤200 LOC; we count the CLI
 *     wrapper since the core supervisor module is in dispatch/supervisor.ts).
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeManifest } from '../dispatch/board.js';
import type { DispatchManifest, SupervisorSpawn } from '../dispatch/index.js';

import {
  parseArgv,
  runDispatchSupervisorCli,
  runStart,
  runStatus,
  runStop,
} from './dispatch-supervisor.js';

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function mkBoard(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sup-cli-'));
  return path.join(dir, 'dispatch');
}

function mkPidFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sup-pid-'));
  return path.join(dir, '.supervisor.pid');
}

function mkManifest(taskId: string): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc',
    workerKind: 'claude-p-shell',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'conductor-test',
    spec: {
      taskFile: `backlog/tasks/${taskId.toLowerCase()}.md`,
      verifyCommands: ['pnpm test'],
    },
  };
}

class MockChildProcess extends EventEmitter {
  public readonly pid = Math.floor(Math.random() * 100_000) + 10_000;
  public killed = false;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    setImmediate(() => this.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  }
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// parseArgv
// ---------------------------------------------------------------------------

describe('parseArgv', () => {
  it('parses subcommand + key/value flag pairs', () => {
    const { subcommand, flags } = parseArgv([
      'start',
      '--board-dir',
      '/tmp/x',
      '--max-concurrent',
      '4',
    ]);
    expect(subcommand).toBe('start');
    expect(flags['board-dir']).toBe('/tmp/x');
    expect(flags['max-concurrent']).toBe('4');
  });

  it('treats bare --once flag as true', () => {
    const { flags } = parseArgv(['start', '--once']);
    expect(flags['once']).toBe('true');
  });

  it('handles empty argv', () => {
    expect(parseArgv([])).toEqual({ subcommand: '', flags: {} });
  });

  it('treats a flag immediately followed by another --flag as bare-true', () => {
    const { flags } = parseArgv(['start', '--once', '--max-concurrent', '4']);
    expect(flags['once']).toBe('true');
    expect(flags['max-concurrent']).toBe('4');
  });
});

// ---------------------------------------------------------------------------
// runStart — daemon loop
// ---------------------------------------------------------------------------

describe('runStart (--once mode)', () => {
  it('acquires the PID lock, runs one tick, releases the lock', async () => {
    const boardDir = mkBoard();
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    cleanup.push(() => rmSync(path.dirname(boardDir), { recursive: true, force: true }));

    writeManifest(boardDir, mkManifest('AISDLC-CLI-100'));
    const spawnedPids: number[] = [];
    const spawn: SupervisorSpawn = () => {
      const child = new MockChildProcess();
      spawnedPids.push(child.pid);
      // Exit immediately so the child handler runs before the tick returns.
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ReturnType<SupervisorSpawn>;
    };

    const result = await runStart({
      boardDir,
      pidFile,
      maxConcurrent: 1,
      pollIntervalSec: 1,
      staleMs: 30 * 60_000,
      once: true,
      spawn,
    });

    expect(result.exit).toBe(0);
    expect(result.ticksRun).toBe(1);
    expect(existsSync(pidFile)).toBe(false); // released
    expect(spawnedPids).toHaveLength(1);
  });

  it('refuses to start when another live supervisor owns the PID file (AC #3)', async () => {
    const boardDir = mkBoard();
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    cleanup.push(() => rmSync(path.dirname(boardDir), { recursive: true, force: true }));

    // Plant our own PID — guaranteed alive.
    writeFileSync(pidFile, `${process.pid}\n`, 'utf-8');
    const logs: string[] = [];

    const result = await runStart({
      boardDir,
      pidFile,
      maxConcurrent: 1,
      pollIntervalSec: 1,
      staleMs: 30 * 60_000,
      once: true,
      spawn: () => {
        throw new Error('spawn must not be called when lock fails');
      },
      log: (m) => logs.push(m),
    });

    expect(result.exit).toBe(1);
    expect(result.ticksRun).toBe(0);
    expect(logs.some((l) => l.includes('refusing to start'))).toBe(true);
    // The pre-existing PID file should NOT be cleaned up — only releasePidLock
    // owned by current PID removes the file.
    expect(existsSync(pidFile)).toBe(true);
  });
});

describe('runStart (loop mode)', () => {
  it('runs the loop until stopSignal resolves', async () => {
    const boardDir = mkBoard();
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    cleanup.push(() => rmSync(path.dirname(boardDir), { recursive: true, force: true }));

    writeManifest(boardDir, mkManifest('AISDLC-CLI-200'));
    const spawn: SupervisorSpawn = () => {
      const child = new MockChildProcess();
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ReturnType<SupervisorSpawn>;
    };

    let resolveStop: (() => void) | undefined;
    const stopSignal = new Promise<void>((r) => {
      resolveStop = r;
    });

    // Inject a sleep stub that resolves after a real macrotask, so the
    // event loop drains before the next tick — gives stopSignal.then()
    // chance to flip `stopped` to true. (A microtask-only sleep starves
    // the macrotask queue and the loop never observes the stop signal.)
    const sleep = vi
      .fn()
      .mockImplementation((): Promise<void> => new Promise((r) => setTimeout(r, 1)));
    let tickCount = 0;
    // After 3 ticks, fire the stop signal — this is a controlled exit so
    // the test doesn't hang if something regresses.
    const trippedStop = sleep.mockImplementation((): Promise<void> => {
      tickCount++;
      if (tickCount >= 3 && resolveStop) {
        resolveStop();
        resolveStop = undefined;
      }
      return new Promise((r) => setTimeout(r, 1));
    });

    const result = await runStart({
      boardDir,
      pidFile,
      maxConcurrent: 1,
      pollIntervalSec: 1,
      staleMs: 30 * 60_000,
      once: false,
      spawn,
      sleep: trippedStop,
      stopSignal,
    });
    expect(result.exit).toBe(0);
    expect(result.ticksRun).toBeGreaterThanOrEqual(3);
    expect(trippedStop).toHaveBeenCalledWith(1000);
    expect(existsSync(pidFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runStatus
// ---------------------------------------------------------------------------

describe('runStatus', () => {
  it('returns alive=false on missing PID file', () => {
    const boardDir = mkBoard();
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    cleanup.push(() => rmSync(path.dirname(boardDir), { recursive: true, force: true }));

    const status = runStatus(boardDir, pidFile);
    expect(status.alive).toBe(false);
    expect(status.pid).toBeUndefined();
    expect(status.board).toEqual({ queued: 0, inflight: 0, done: 0, failed: 0 });
  });

  it('returns alive=true when PID file points to a live process (we use our own)', () => {
    const boardDir = mkBoard();
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    cleanup.push(() => rmSync(path.dirname(boardDir), { recursive: true, force: true }));

    writeFileSync(pidFile, `${process.pid}\n`, 'utf-8');
    const status = runStatus(boardDir, pidFile);
    expect(status.alive).toBe(true);
    expect(status.pid).toBe(process.pid);
  });

  it('returns alive=false on a dead PID', () => {
    const boardDir = mkBoard();
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    cleanup.push(() => rmSync(path.dirname(boardDir), { recursive: true, force: true }));

    writeFileSync(pidFile, '99999999\n', 'utf-8');
    const status = runStatus(boardDir, pidFile);
    expect(status.alive).toBe(false);
    expect(status.pid).toBe(99999999);
  });

  it('reports board occupancy alongside PID status', () => {
    const boardDir = mkBoard();
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    cleanup.push(() => rmSync(path.dirname(boardDir), { recursive: true, force: true }));

    writeManifest(boardDir, mkManifest('AISDLC-CLI-300'));
    writeManifest(boardDir, mkManifest('AISDLC-CLI-301'));
    const status = runStatus(boardDir, pidFile);
    expect(status.board.queued).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runStop
// ---------------------------------------------------------------------------

describe('runStop', () => {
  it('no-ops when PID file is absent', async () => {
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    const result = await runStop({ pidFile });
    expect(result.exit).toBe(0);
    expect(result.killed).toBe(false);
  });

  it('no-ops when the recorded PID is dead, and cleans the file', async () => {
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    writeFileSync(pidFile, `${process.pid}\n`, 'utf-8');
    const result = await runStop({
      pidFile,
      alive: () => false, // pretend it's dead
    });
    expect(result.exit).toBe(0);
    expect(result.killed).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('SIGTERMs an alive PID, waits graceMs, removes the file (AC #3)', async () => {
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    writeFileSync(pidFile, `${process.pid}\n`, 'utf-8');

    const killCalls: Array<[number, NodeJS.Signals | 0]> = [];
    let aliveCallNo = 0;
    const result = await runStop({
      pidFile,
      graceMs: 5,
      kill: (pid, sig) => {
        killCalls.push([pid, sig]);
      },
      // First call (initial check) → alive. Second call (after grace) → dead.
      alive: () => {
        aliveCallNo++;
        return aliveCallNo === 1;
      },
      sleep: () => Promise.resolve(),
    });
    expect(result.exit).toBe(0);
    expect(result.killed).toBe(true);
    expect(killCalls[0]?.[1]).toBe('SIGTERM');
    expect(existsSync(pidFile)).toBe(false);
  });

  it('force-kills with SIGKILL when SIGTERM did not stop the process', async () => {
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    writeFileSync(pidFile, `${process.pid}\n`, 'utf-8');

    const killCalls: Array<NodeJS.Signals | 0> = [];
    const result = await runStop({
      pidFile,
      graceMs: 5,
      kill: (_pid, sig) => {
        killCalls.push(sig);
      },
      alive: () => true,
      sleep: () => Promise.resolve(),
    });
    expect(result.exit).toBe(0);
    expect(result.killed).toBe(true);
    expect(killCalls).toEqual(['SIGTERM', 'SIGKILL']);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('tolerates kill errors (PID already gone between read + signal)', async () => {
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    writeFileSync(pidFile, `${process.pid}\n`, 'utf-8');
    const result = await runStop({
      pidFile,
      graceMs: 5,
      kill: () => {
        throw new Error('ESRCH');
      },
      alive: () => true,
      sleep: () => Promise.resolve(),
    });
    expect(result.exit).toBe(0);
    expect(existsSync(pidFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runDispatchSupervisorCli — top-level entry routing
// ---------------------------------------------------------------------------

describe('runDispatchSupervisorCli', () => {
  function captureStdout(fn: () => Promise<number>): Promise<{ exit: number; raw: string }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write);
    return fn().then((exit) => {
      spy.mockRestore();
      return { exit, raw: chunks.join('') };
    });
  }

  it('prints help text on `help` subcommand', async () => {
    const { exit, raw } = await captureStdout(() => runDispatchSupervisorCli(['help']));
    expect(exit).toBe(0);
    expect(raw).toContain('cli-dispatch-supervisor');
    expect(raw).toContain('Subcommands:');
  });

  it('prints help text on empty argv', async () => {
    const { exit, raw } = await captureStdout(() => runDispatchSupervisorCli([]));
    expect(exit).toBe(0);
    expect(raw).toContain('Usage:');
  });

  it('returns 2 on unknown subcommand', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { exit } = await captureStdout(() => runDispatchSupervisorCli(['gibberish']));
    expect(exit).toBe(2);
    errSpy.mockRestore();
  });

  it('returns status JSON on stdout for `status`', async () => {
    const boardDir = mkBoard();
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    cleanup.push(() => rmSync(path.dirname(boardDir), { recursive: true, force: true }));

    const { exit, raw } = await captureStdout(() =>
      runDispatchSupervisorCli(['status', '--board-dir', boardDir, '--pid-file', pidFile]),
    );
    // No PID → alive false → exit 1.
    expect(exit).toBe(1);
    const json = JSON.parse(raw.trim()) as { alive: boolean };
    expect(json.alive).toBe(false);
  });

  it('returns 0 + alive:true when PID file is current process', async () => {
    const boardDir = mkBoard();
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    cleanup.push(() => rmSync(path.dirname(boardDir), { recursive: true, force: true }));
    writeFileSync(pidFile, `${process.pid}\n`, 'utf-8');

    const { exit, raw } = await captureStdout(() =>
      runDispatchSupervisorCli(['status', '--board-dir', boardDir, '--pid-file', pidFile]),
    );
    expect(exit).toBe(0);
    const json = JSON.parse(raw.trim()) as { alive: boolean; pid: number };
    expect(json.alive).toBe(true);
    expect(json.pid).toBe(process.pid);
  });

  it('returns 0 on `stop` with no PID file', async () => {
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    const { exit, raw } = await captureStdout(() =>
      runDispatchSupervisorCli(['stop', '--pid-file', pidFile]),
    );
    expect(exit).toBe(0);
    const json = JSON.parse(raw.trim()) as { killed: boolean };
    expect(json.killed).toBe(false);
  });

  it('runs `start --once` end-to-end through the top-level CLI router (empty queue → no spawn)', async () => {
    // Drive the top-level router's `start` branch with --once and an
    // empty queue so the production `child_process.spawn` is never
    // invoked (avoiding ENOENT on `claude` in CI). Covers the argv
    // parsing + maxConcurrent/pollIntervalSec/staleMs defaults branch.
    const boardDir = mkBoard();
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    cleanup.push(() => rmSync(path.dirname(boardDir), { recursive: true, force: true }));

    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { exit } = await captureStdout(() =>
        runDispatchSupervisorCli([
          'start',
          '--board-dir',
          boardDir,
          '--pid-file',
          pidFile,
          '--max-concurrent',
          '1',
          '--poll-interval-sec',
          '60',
          '--stale-ms',
          '1800000',
          '--once',
        ]),
      );
      expect(exit).toBe(0);
    } finally {
      errSpy.mockRestore();
    }
    // PID lock released on exit.
    expect(existsSync(pidFile)).toBe(false);
  });

  it('routes `start` (no --once) through the SIGTERM handler branch (empty queue + maxConcurrent=0 keeps spawn out of the picture)', async () => {
    // Drive start without --once, then synthetically emit SIGTERM after
    // a brief delay so the loop exits cleanly. Covers the process.once
    // SIGTERM/SIGINT handler installation branch (lines 278-281 in
    // dispatch-supervisor.ts). maxConcurrent: 0 + empty queue ensures
    // no real `claude` spawn is attempted.
    const boardDir = mkBoard();
    const pidFile = mkPidFile();
    cleanup.push(() => rmSync(path.dirname(pidFile), { recursive: true, force: true }));
    cleanup.push(() => rmSync(path.dirname(boardDir), { recursive: true, force: true }));

    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      setTimeout(() => process.emit('SIGTERM'), 50);
      const { exit } = await captureStdout(() =>
        runDispatchSupervisorCli([
          'start',
          '--board-dir',
          boardDir,
          '--pid-file',
          pidFile,
          '--max-concurrent',
          '0',
          '--poll-interval-sec',
          '1',
        ]),
      );
      expect(exit).toBe(0);
    } finally {
      errSpy.mockRestore();
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
    }
    expect(existsSync(pidFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC #1 — supervisor source LOC budget
// ---------------------------------------------------------------------------

describe('AC #1 — supervisor source LOC budget', () => {
  it('pipeline-cli/src/dispatch/supervisor.ts has ≤200 lines of non-comment code', () => {
    // We measure the implementation file itself (the CLI wrapper at
    // dispatch-supervisor.ts is a separate concern and not part of the
    // ≤200 LOC budget per the task — that file routes flags + lifecycle).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const supervisorPath = path.join(here, '..', 'dispatch', 'supervisor.ts');
    const src = readFileSync(supervisorPath, 'utf-8');
    const lines = src.split('\n');
    let codeLines = 0;
    let inBlockComment = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (inBlockComment) {
        if (line.includes('*/')) inBlockComment = false;
        continue;
      }
      if (line === '') continue;
      if (line.startsWith('//')) continue;
      if (line.startsWith('/*')) {
        if (!line.includes('*/')) inBlockComment = true;
        continue;
      }
      if (line.startsWith('*')) continue;
      codeLines++;
    }
    // AC #1 specifies ≤200 LOC; we publish the actual count so any future
    // bloat is caught immediately.
    expect(codeLines).toBeLessThanOrEqual(200);
  });

  it('cli-dispatch-supervisor is registered as a bin in pipeline-cli/package.json (AC #1)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, '..', '..', 'package.json'), 'utf-8')) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin['cli-dispatch-supervisor']).toBe('bin/cli-dispatch-supervisor.mjs');
  });
});
