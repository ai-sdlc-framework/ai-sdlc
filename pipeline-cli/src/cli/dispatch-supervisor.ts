/**
 * `cli-dispatch-supervisor` — Worker Supervisor CLI (RFC-0041 §4.5,
 * AISDLC-377.3).
 *
 * Subcommands:
 *
 *   - `start [--board-dir <p>] [--max-concurrent <n>] [--poll-interval-sec <s>]
 *     [--stale-ms <ms>] [--pid-file <p>] [--once]` — start the supervisor
 *     daemon. `--once` runs a single tick and exits (used by hermetic
 *     tests + operator dry-runs). Without `--once`, the process loops
 *     until SIGTERM / SIGINT.
 *
 *   - `status [--board-dir <p>] [--pid-file <p>]` — read the PID file,
 *     probe liveness, print `{pid, alive, board: {queued, inflight, …}}`
 *     as JSON on stdout. Exit 0 when alive, 1 when no/dead PID.
 *
 *   - `stop [--pid-file <p>] [--grace-ms <ms>]` — read the PID, send
 *     SIGTERM, wait `--grace-ms`, force-kill if still alive, remove the
 *     PID file. Exit 0 on clean stop / no-op (no PID file).
 *
 * The CLI is intentionally thin — the heavy lifting (atomic claim,
 * stale sweep, spawn protocol) lives in `pipeline-cli/src/dispatch/
 * supervisor.ts`. This module owns argv parsing + the `setInterval`
 * lifecycle + signal handlers.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import {
  acquirePidLock,
  createSupervisorState,
  DEFAULT_BOARD_DIR,
  DEFAULT_HEARTBEAT_STALE_MS,
  isProcessAlive,
  peekQueue,
  readPidFile,
  releasePidLock,
  runSupervisorTick,
  type SupervisorSpawn,
  type SupervisorState,
} from '../dispatch/index.js';

/** Minimal argv parser — mirrors `cli-dispatch`'s parseArgv. */
export function parseArgv(argv: readonly string[]): {
  subcommand: string;
  flags: Record<string, string>;
} {
  const [subcommand = '', ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = 'true';
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { subcommand, flags };
}

/** Resolve `--board-dir <p>` or fall back to the default. */
function resolveBoardDir(flags: Record<string, string>): string {
  return path.resolve(flags['board-dir'] ?? DEFAULT_BOARD_DIR);
}

/** Resolve `--pid-file <p>` or fall back to `<boardDir>/.supervisor.pid`. */
function resolvePidFile(boardDir: string, flags: Record<string, string>): string {
  return path.resolve(flags['pid-file'] ?? path.join(boardDir, '.supervisor.pid'));
}

/** Result interface for the start subcommand — observable for tests. */
export interface StartResult {
  exit: number;
  /** Ticks executed before exit (typically 1 for `--once`, N for loop runs). */
  ticksRun: number;
}

/** Options for `runStart` — exposes the injectable spawn for tests. */
export interface RunStartOptions {
  boardDir: string;
  pidFile: string;
  maxConcurrent: number;
  pollIntervalSec: number;
  staleMs: number;
  once: boolean;
  spawn?: SupervisorSpawn;
  /** Pre-acquired state (tests may inject; production calls createSupervisorState). */
  state?: SupervisorState;
  /** Inject a sleep-fn (tests use a microtask-resolving stub). */
  sleep?: (ms: number) => Promise<void>;
  /** Inject a stop signal — when the promise resolves, the loop exits. */
  stopSignal?: Promise<void>;
  /** stderr logger override (defaults to process.stderr.write). */
  log?: (msg: string) => void;
}

/**
 * Daemon loop entry-point. Handles:
 *
 *   1. PID-file acquisition (refuses to start if another live supervisor
 *      owns the lock; AC #3).
 *   2. A polling loop that drives `runSupervisorTick` at `pollIntervalSec`
 *      cadence. `--once` runs a single tick and resolves.
 *   3. Cleanup on exit — releases the PID file.
 *
 * Returns the exit code + tick count.
 */
export async function runStart(opts: RunStartOptions): Promise<StartResult> {
  const log = opts.log ?? ((m: string): void => void process.stderr.write(`${m}\n`));
  const lock = acquirePidLock(opts.pidFile);
  if (!lock.acquired) {
    log(`[cli-dispatch-supervisor] refusing to start: ${lock.reason}`);
    return { exit: 1, ticksRun: 0 };
  }
  log(`[cli-dispatch-supervisor] started pid=${process.pid} board=${opts.boardDir}`);

  const state = opts.state ?? createSupervisorState();
  const spawn = opts.spawn ?? (nodeSpawn as SupervisorSpawn);
  const sleep =
    opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));

  let ticksRun = 0;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  if (opts.stopSignal) opts.stopSignal.then(stop, stop);

  try {
    do {
      const tick = runSupervisorTick({
        boardDir: opts.boardDir,
        maxConcurrent: opts.maxConcurrent,
        staleMs: opts.staleMs,
        state,
        spawn,
        log,
      });
      ticksRun++;
      if (tick.spawned > 0 || tick.reapedTaskIds.length > 0) {
        log(
          `[cli-dispatch-supervisor] tick ` +
            `spawned=${tick.spawned} ` +
            `reaped=${tick.reapedTaskIds.length} ` +
            `inflight=${tick.inflightCount}`,
        );
      }
      if (opts.once || stopped) break;
      await sleep(opts.pollIntervalSec * 1000);
    } while (!stopped);
  } finally {
    releasePidLock(opts.pidFile);
    log(`[cli-dispatch-supervisor] exiting pid=${process.pid} ticksRun=${ticksRun}`);
  }
  return { exit: 0, ticksRun };
}

/** Status subcommand result. */
export interface StatusResult {
  pid?: number;
  alive: boolean;
  board: ReturnType<typeof peekQueue>;
}

/** Read the PID + board occupancy. Pure I/O. */
export function runStatus(boardDir: string, pidFile: string): StatusResult {
  const pid = readPidFile(pidFile);
  const alive = pid !== undefined && isProcessAlive(pid);
  const board = peekQueue(boardDir);
  return pid !== undefined ? { pid, alive, board } : { alive, board };
}

/** Options for stop subcommand. */
export interface RunStopOptions {
  pidFile: string;
  /** Wait this long after SIGTERM before force-killing. Default 5000ms. */
  graceMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable kill (tests). */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Injectable liveness probe (tests). */
  alive?: (pid: number) => boolean;
}

/**
 * Stop subcommand. Reads the PID, SIGTERMs, waits `graceMs`, force-kills
 * if needed, removes the PID file. Returns the exit code (0 = clean).
 */
export async function runStop(opts: RunStopOptions): Promise<{ exit: number; killed: boolean }> {
  const graceMs = opts.graceMs ?? 5000;
  const sleep =
    opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const kill = opts.kill ?? ((pid: number, signal): void => void process.kill(pid, signal));
  const alive = opts.alive ?? ((pid: number): boolean => isProcessAlive(pid));

  const pid = readPidFile(opts.pidFile);
  if (pid === undefined) {
    return { exit: 0, killed: false };
  }
  if (!alive(pid)) {
    releasePidLock(opts.pidFile);
    return { exit: 0, killed: false };
  }
  try {
    kill(pid, 'SIGTERM');
  } catch {
    // Already gone — clean up and exit.
    releasePidLock(opts.pidFile);
    return { exit: 0, killed: false };
  }
  await sleep(graceMs);
  if (alive(pid)) {
    try {
      kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
  releasePidLock(opts.pidFile);
  return { exit: 0, killed: true };
}

const HELP_TEXT = `cli-dispatch-supervisor — Worker Supervisor (RFC-0041 §4.5)

Usage:
  cli-dispatch-supervisor <subcommand> [flags]

Subcommands:
  start [--board-dir <p>] [--max-concurrent <n>] [--poll-interval-sec <s>]
        [--stale-ms <ms>] [--pid-file <p>] [--once]
  status [--board-dir <p>] [--pid-file <p>]
  stop [--pid-file <p>] [--grace-ms <ms>]

Environment:
  AI_SDLC_DISPATCH_BOARD_DIR  Overrides default board path.
  CLAUDE_BINARY               Overrides the 'claude' binary name.
`;

/**
 * CLI entry. Returns the intended exit code. Spawns the daemon when
 * `start` is the subcommand; one-shot subcommands print JSON + exit.
 */
export async function runDispatchSupervisorCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const { subcommand, flags } = parseArgv(argv);
  const boardDir = resolveBoardDir(flags);
  const pidFile = resolvePidFile(boardDir, flags);

  switch (subcommand) {
    case 'start': {
      const maxConcurrent = flags['max-concurrent']
        ? Number.parseInt(flags['max-concurrent'], 10)
        : 2;
      const pollIntervalSec = flags['poll-interval-sec']
        ? Number.parseInt(flags['poll-interval-sec'], 10)
        : 15;
      const staleMs = flags['stale-ms']
        ? Number.parseInt(flags['stale-ms'], 10)
        : DEFAULT_HEARTBEAT_STALE_MS;
      const once = flags['once'] === 'true';

      // Wire SIGTERM / SIGINT → stopSignal.
      let resolveStop: (() => void) | undefined;
      const stopSignal = new Promise<void>((r) => {
        resolveStop = r;
      });
      const handler = (): void => {
        if (resolveStop) resolveStop();
      };
      if (!once) {
        process.once('SIGTERM', handler);
        process.once('SIGINT', handler);
      }

      const result = await runStart({
        boardDir,
        pidFile,
        maxConcurrent,
        pollIntervalSec,
        staleMs,
        once,
        stopSignal: once ? undefined : stopSignal,
      });
      return result.exit;
    }

    case 'status': {
      const status = runStatus(boardDir, pidFile);
      process.stdout.write(JSON.stringify(status) + '\n');
      return status.alive ? 0 : 1;
    }

    case 'stop': {
      const graceMs = flags['grace-ms'] ? Number.parseInt(flags['grace-ms'], 10) : undefined;
      const result = await runStop({ pidFile, graceMs });
      process.stdout.write(JSON.stringify(result) + '\n');
      return result.exit;
    }

    case '':
    case 'help':
    case '--help':
    case '-h': {
      process.stdout.write(HELP_TEXT);
      return 0;
    }

    default: {
      process.stderr.write(`cli-dispatch-supervisor: unknown subcommand '${subcommand}'\n`);
      process.stderr.write(HELP_TEXT);
      return 2;
    }
  }
}
