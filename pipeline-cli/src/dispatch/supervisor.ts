/**
 * Worker Supervisor for the `claude-p-shell` Worker kind (RFC-0041 §4.5).
 *
 * The supervisor is a small daemon that polls the Dispatch Board's `queue/`
 * subdirectory at a fixed cadence and spawns `claude -p` subprocesses for
 * each manifest whose `workerKind` ∈ {`claude-p-shell`, `any`}. Each spawn:
 *
 *   - scrubs `CLAUDECODE` from the env (RFC §4.4 — Claude Code's startup
 *     guard refuses to launch when `CLAUDECODE=1` is set);
 *   - runs in the manifest's `worktree` cwd;
 *   - is tracked by PID so concurrency caps + stale-heartbeat sweeps work.
 *
 * The core (`runSupervisorTick`) is a pure-ish function: it takes a
 * `SupervisorState` (in-memory), an injectable `spawn` (so tests can avoid
 * touching `claude` and just observe the argv/env shape), and an injectable
 * `now`. The CLI bin wraps it in a `setInterval` loop.
 *
 * **OQ resolutions baked into this module:**
 *   - OQ-1: supervisor lives in `pipeline-cli/bin/`, not a separate package.
 *   - OQ-2: env is inherited (no new auth mode). `CLAUDECODE` is the only
 *     scrubbed key — `ANTHROPIC_API_KEY` / `~/.claude/credentials` flow
 *     through unchanged.
 *   - OQ-3: 30-min heartbeat threshold matches `ShellClaudePSpawner`'s
 *     `DEFAULT_TIMEOUT_MS`.
 *   - OQ-6: 15-second default poll cadence (slower than in-session-agent's
 *     5s) so subscription Workers preferentially win `any` races.
 *
 * AC #1: <200 LOC target — this module currently sits at ~190 LOC after
 * comments + types. The CLI wrapper at `pipeline-cli/src/cli/dispatch-supervisor.ts`
 * adds another ~110 LOC for start/status/stop subcommands.
 */

import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  claimNext,
  ensureBoardDirs,
  peekQueue,
  sweepStaleHeartbeats,
  writeVerdict,
} from './board.js';
import type { DispatchManifest, DispatchVerdict } from './types.js';

// Re-export PID lock helpers so callers depending on supervisor.ts get
// the singleton-enforcement surface in one import.
export { acquirePidLock, isProcessAlive, readPidFile, releasePidLock } from './pid-lock.js';
export type { PidLockResult } from './pid-lock.js';

/** Injectable shape so tests can stub `child_process.spawn`. */
export type SupervisorSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcess;

/**
 * Per-supervisor mutable state. Exists in memory only — there's no
 * persisted "supervisor session" across restarts. On restart the
 * stale-heartbeat sweeper picks up any inflight manifests left behind.
 */
export interface SupervisorState {
  /** PID → manifest for processes currently spawned by this supervisor. */
  readonly inflight: Map<number, DispatchManifest>;
}

/** Create a fresh, empty supervisor state. */
export function createSupervisorState(): SupervisorState {
  return { inflight: new Map() };
}

/** Options for a single `runSupervisorTick` call. */
export interface SupervisorTickOptions {
  /** Absolute path to the dispatch board (`<repo>/.ai-sdlc/dispatch`). */
  boardDir: string;
  /** Maximum concurrent `claude -p` Workers. From DispatchConfig. */
  maxConcurrent: number;
  /** Stale-heartbeat threshold passed to `sweepStaleHeartbeats`. */
  staleMs: number;
  /** Mutable in-memory state (PID → manifest). */
  state: SupervisorState;
  /** Injectable spawn primitive — defaults to `node:child_process.spawn`. */
  spawn: SupervisorSpawn;
  /** Path to the `claude` binary. Default: 'claude'. */
  claudeBinary?: string;
  /** Injectable wall clock (defaults to `Date.now`). */
  now?: () => Date;
  /** Optional stderr logger; falls back to no-op. Tests inject a buffer. */
  log?: (msg: string) => void;
}

/** Outcome of a single tick (useful for tests + status printing). */
export interface SupervisorTickResult {
  /** How many manifests were claimed and spawned during this tick. */
  spawned: number;
  /** Stale-heartbeat sweep result. */
  reapedTaskIds: readonly string[];
  /** Inflight count after the tick. */
  inflightCount: number;
}

/**
 * Run one supervisor cycle. Concretely:
 *
 *   1. Sweep stale heartbeats (idempotent on overlap with the Worker's own
 *      30-min `setTimeout` — both writing a `failed/<id>.diagnostic.json`
 *      under the same `cause: stale-heartbeat` is the documented OQ-3
 *      "no race" property).
 *   2. Up to `maxConcurrent - state.inflight.size` times, atomically claim
 *      the next `workerKind ∈ {claude-p-shell, any}` manifest and spawn
 *      `env -u CLAUDECODE claude -p ...` in the manifest's worktree.
 *   3. Wire the child's `exit` event to drop its PID from `state.inflight`
 *      and (on non-zero exit) write a `spawn-rejected` diagnostic.
 *
 * This function is intentionally synchronous — `child.spawn` returns
 * immediately, and tick callbacks complete fast. The caller drives cadence
 * with `setInterval` (or a `await sleep(pollMs)` loop in tests).
 */
export function runSupervisorTick(opts: SupervisorTickOptions): SupervisorTickResult {
  const {
    boardDir,
    maxConcurrent,
    staleMs,
    state,
    spawn,
    claudeBinary = 'claude',
    now = () => new Date(),
    log = () => {},
  } = opts;

  ensureBoardDirs(boardDir);
  const sweep = sweepStaleHeartbeats(boardDir, { staleMs, now });
  // If the sweep reaped any task that this supervisor had spawned, send
  // SIGTERM to its PID. The Worker's own watchdog may also fire; either
  // way the child exit handler runs and cleans up `state.inflight`.
  if (sweep.reapedTaskIds.length > 0) {
    for (const [pid, manifest] of state.inflight.entries()) {
      if (sweep.reapedTaskIds.includes(manifest.taskId)) {
        try {
          process.kill(pid, 'SIGTERM');
          log(`[supervisor] SIGTERM pid=${pid} task=${manifest.taskId} cause=stale-heartbeat`);
        } catch (err) {
          log(`[supervisor] kill pid=${pid} failed: ${stringifyError(err)}`);
        }
      }
    }
  }

  let spawned = 0;
  while (state.inflight.size < maxConcurrent) {
    const result = claimNext(boardDir, 'claude-p-shell', now);
    if (!result.claimed || !result.manifest) break;
    const manifest = result.manifest;

    // Scrub CLAUDECODE from the env (RFC §4.4). We also forward the parent
    // env explicitly so OQ-2 (inherit operator env) is preserved.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CLAUDECODE;

    const argv = buildClaudeArgv(manifest);

    let child: ChildProcess;
    try {
      child = spawn(claudeBinary, argv, { cwd: manifest.worktree, env });
    } catch (err) {
      writeSpawnRejected(boardDir, manifest, stringifyError(err));
      log(`[supervisor] spawn-rejected task=${manifest.taskId} err=${stringifyError(err)}`);
      continue;
    }

    const pid = child.pid;
    if (typeof pid !== 'number') {
      writeSpawnRejected(boardDir, manifest, 'child.pid undefined');
      log(`[supervisor] spawn-rejected task=${manifest.taskId} err=pid-undefined`);
      continue;
    }

    state.inflight.set(pid, manifest);
    spawned++;
    log(`[supervisor] spawned pid=${pid} task=${manifest.taskId} worktree=${manifest.worktree}`);

    // child_process.spawn surfaces ENOENT (missing binary) + EACCES via
    // the 'error' event, NOT a synchronous throw. Wire a handler so the
    // event doesn't bubble up as an uncaught exception, and synthesize a
    // spawn-rejected diagnostic — the exit handler's verdict-present
    // probe will see this and short-circuit (no double-write).
    child.on('error', (err: Error) => {
      state.inflight.delete(pid);
      if (!verdictPresent(boardDir, manifest.taskId)) {
        writeSpawnRejected(boardDir, manifest, stringifyError(err));
      }
      log(`[supervisor] spawn-error pid=${pid} task=${manifest.taskId} err=${stringifyError(err)}`);
    });

    child.on('exit', (code, signal) => {
      state.inflight.delete(pid);
      // If the Worker exited non-zero AND the board has no verdict for this
      // task, treat it as a spawn-rejected failure. (When the Worker writes
      // a verdict, the inflight manifest is cleared by writeVerdict; the
      // board's `peek` will show no inflight entry.)
      if (code !== 0 && code !== null) {
        const counts = peekQueue(boardDir);
        // Defensive: only synthesize a diagnostic if the Worker didn't
        // already land a verdict for this task on its own.
        if (!verdictPresent(boardDir, manifest.taskId)) {
          writeSpawnRejected(
            boardDir,
            manifest,
            `claude -p exited code=${code} signal=${signal ?? 'null'}`,
          );
        }
        log(
          `[supervisor] exit pid=${pid} task=${manifest.taskId} code=${code} signal=${signal ?? 'null'} board=${JSON.stringify(counts)}`,
        );
        return;
      }
      log(`[supervisor] exit pid=${pid} task=${manifest.taskId} code=${code ?? 'null'} ok`);
    });
  }

  return {
    spawned,
    reapedTaskIds: sweep.reapedTaskIds,
    inflightCount: state.inflight.size,
  };
}

/**
 * Build the argv list passed to `claude -p`. Mirrors `ShellClaudePSpawner`
 * but uses `--working-directory <worktree>` only by setting `options.cwd`
 * (no `--cwd` flag exists on `claude`). The prompt positional points the
 * Worker at the Dispatch Board manifest by passing the absolute path to
 * the inflight manifest; the developer agent's slash-command body reads
 * the manifest and acts on it. Lastly we include `--resume <sessionId>`
 * when the manifest carries a `lastSessionId` so iterate-dev (OQ-4) can
 * resume the prior conversation.
 */
export function buildClaudeArgv(manifest: DispatchManifest): string[] {
  const argv: string[] = [
    '--print',
    '--output-format',
    'json',
    '--permission-mode',
    'bypassPermissions',
    '--agent',
    'developer',
  ];
  if (manifest.lastSessionId) {
    argv.push('--resume', manifest.lastSessionId);
  }
  // The prompt is just the manifest path — the developer agent's prompt
  // template reads the manifest and inflates it to a full task brief.
  argv.push(buildManifestPrompt(manifest));
  return argv;
}

/**
 * Produce the prompt body passed to the `developer` subagent. Keep it
 * compact and deterministic; the subagent reads the underlying manifest +
 * task file directly.
 */
export function buildManifestPrompt(manifest: DispatchManifest): string {
  return [
    `RFC-0041 claude-p-shell Worker — task ${manifest.taskId}.`,
    `Worktree: ${manifest.worktree}`,
    `Branch: ${manifest.branch}`,
    `Task file: ${manifest.spec.taskFile}`,
    `Base SHA: ${manifest.baseSha}`,
    'Read the task file and acceptance criteria. Implement, verify, commit.',
    'Verdict will be written to .ai-sdlc/dispatch/done/<task-id>.verdict.json.',
  ].join('\n');
}

/** Write a `spawn-rejected` diagnostic into `failed/`. */
function writeSpawnRejected(boardDir: string, manifest: DispatchManifest, err: string): void {
  const diagnostic: DispatchVerdict = {
    schemaVersion: 'v1',
    taskId: manifest.taskId,
    outcome: 'failed',
    completedAt: new Date().toISOString(),
    workerId: `supervisor-pid-${process.pid}`,
    workerKind: 'claude-p-shell',
    cause: 'spawn-rejected',
    notes: err,
  };
  writeVerdict(boardDir, diagnostic);
}

/** Read the dispatch board's done/ + failed/ for a taskId verdict file. */
function verdictPresent(boardDir: string, taskId: string): boolean {
  return (
    existsSync(path.join(boardDir, 'done', `${taskId}.verdict.json`)) ||
    existsSync(path.join(boardDir, 'failed', `${taskId}.verdict.json`)) ||
    existsSync(path.join(boardDir, 'failed', `${taskId}.diagnostic.json`))
  );
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
