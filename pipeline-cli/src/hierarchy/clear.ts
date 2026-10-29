/**
 * Clear an executor between tasks (AISDLC-1107). Dispatch owns the clear and drives the pane
 * itself; the executor's model and hooks module are not involved, and no request file or
 * acknowledgement exists. The verdict file proves the task ended.
 *
 * Sequence (the same pane driving `restart` relies on): wait for the idle prompt, type `/clear`
 * and Enter, wait for the fresh prompt, type the executor command and Enter. When the pane does
 * not reach an idle or fresh prompt within the ceiling, the fallback is `restart <name>` (kill
 * and relaunch), which needs no cooperation either.
 *
 * Refusals, all named and all sending nothing:
 *  - the name is not a running roster session, or its roster entry is unsafe;
 *  - an executor that holds an inflight manifest (its context is work in progress);
 *  - the tmux session was not started by `cli-hierarchy up`, or the recorded pane is stale.
 */

import { readInflightManifest } from '../dispatch/board.js';
import type { EventEmitter } from './emit.js';
import { listInflight } from './inflight.js';
import { readRosterChecked, unsafeEntryReason } from './roster.js';
import { ownershipRefusal, paneIsIdle, resolveSendTarget, sendLine } from './tmux.js';
import type { CommandRunner } from './types.js';

/** Default ceiling, in milliseconds, for the pane to reach an idle or fresh prompt. Overridable in `.ai-sdlc/pr-lifecycle.yaml` (`clear.handshakeCeilingMs`) or `--settle-ms`. */
export const DEFAULT_SETTLE_MS = 30_000;
/** Default spacing of the prompt checks. */
export const DEFAULT_POLL_INTERVAL_MS = 500;

const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Collaborators of {@link clearExecutor}; every one is injected in tests. */
export interface ClearDeps {
  boardDir: string;
  /** Runs `tmux`. */
  run: CommandRunner;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Records the `ExecutorContextCleared` event. */
  emit?: EventEmitter;
  log?: (line: string) => void;
  /** Kill and relaunch the executor; the fallback when the pane never shows a prompt. Absent means no fallback. */
  restart?: (name: string) => Promise<unknown>;
}

/** Inputs of {@link clearExecutor}. */
export interface ClearOptions {
  /** Roster name of the executor to clear. */
  executor: string;
  /** Ceiling for each wait for the pane's prompt; default {@link DEFAULT_SETTLE_MS}. */
  settleMs?: number;
  pollIntervalMs?: number;
  /** Task whose verdict triggered the clear; recorded on the event. */
  taskId?: string;
  /** Roster name of the session asking; recorded as the event's worker. */
  workerId?: string;
}

/** What a clear did. */
export interface ClearResult {
  executor: string;
  ok: boolean;
  /** How the context was emptied; absent when `ok` is false. */
  via?: 'clear' | 'restart';
  settleMs: number;
  /** Set when `ok` is false: the named refusal. */
  reason?: string;
}

/** The command typed into a cleared executor pane. */
export const EXECUTOR_RESUME = '/ai-sdlc:executor';

/** The task the named session holds inflight, or undefined. */
export function holdsInflight(boardDir: string, name: string): string | undefined {
  for (const item of listInflight(boardDir)) {
    if (item.workerId === name || readInflightManifest(boardDir, item.taskId)?.workerId === name) {
      return item.taskId;
    }
  }
  return undefined;
}

/**
 * Empty the named session's context from the dispatch side.
 * @throws, sending nothing, when the name is invalid, is not a running roster session, its entry is
 *   unsafe, it holds an inflight task, or its tmux session or pane cannot be trusted.
 */
export async function clearExecutor(opts: ClearOptions, deps: ClearDeps): Promise<ClearResult> {
  const name = opts.executor;
  if (typeof name !== 'string' || !SESSION_NAME_RE.test(name)) {
    throw new Error(`'${String(name)}' is not a valid session name`);
  }
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isInteger(settleMs) || settleMs < 0) {
    throw new Error('the settle time must be a whole number of milliseconds');
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error('the poll interval must be a positive whole number of milliseconds');
  }

  const { roster } = readRosterChecked(deps.boardDir);
  const entry = roster.sessions.find((e) => e.name === name);
  if (!entry) throw new Error(`'${name}' is not in the roster`);
  if (entry.status !== 'running') {
    throw new Error(`'${name}' is not running (status ${entry.status})`);
  }
  const unsafe = unsafeEntryReason(entry);
  if (unsafe) throw new Error(`refusing to clear '${name}': it ${unsafe}`);
  if (entry.role !== 'executor') {
    throw new Error(`refusing to clear '${name}': clear applies to executors only (${entry.role})`);
  }
  const held = holdsInflight(deps.boardDir, name);
  if (held) {
    throw new Error(`refusing to clear '${name}': it holds ${held}, which is still inflight`);
  }
  const unowned = ownershipRefusal(deps.run, entry);
  if (unowned) throw new Error(`refusing to clear '${name}': ${unowned}`);
  const target = resolveSendTarget(deps.run, entry.tmuxSession, entry.tmuxWindow, entry.paneId);

  const polls = Math.max(1, Math.ceil(settleMs / pollIntervalMs));
  const waitForPrompt = async (): Promise<boolean> => {
    for (let i = 0; i < polls; i++) {
      if (paneIsIdle(deps.run, entry.tmuxSession, entry.tmuxWindow)) return true;
      await deps.sleep(pollIntervalMs);
    }
    return false;
  };

  let via: 'clear' | 'restart' | undefined;
  let reason: string | undefined;
  // The pane must be idle before `/clear` is typed, and fresh again before the resume command.
  if ((await waitForPrompt()) && sendLine(deps.run, target, '/clear')) {
    // Let the pane leave the old prompt before looking for the fresh one.
    await deps.sleep(pollIntervalMs);
    if ((await waitForPrompt()) && sendLine(deps.run, target, EXECUTOR_RESUME)) via = 'clear';
  }
  if (!via) {
    if (deps.restart) {
      deps.log?.(`'${name}' did not reach a fresh prompt within ${settleMs} ms; restarting it`);
      try {
        await deps.restart(name);
        via = 'restart';
      } catch (err) {
        reason = `no fresh prompt within ${settleMs} ms and the restart fallback failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      reason = `no fresh prompt within ${settleMs} ms and no restart fallback is available`;
    }
  }
  const ok = via !== undefined;
  deps.emit?.({
    type: 'ExecutorContextCleared',
    executor: name,
    paneId: entry.paneId,
    resumed: ok,
    settleMs,
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.workerId ? { workerId: opts.workerId } : {}),
  });
  deps.log?.(ok ? `cleared '${name}' (${via})` : `clear of '${name}' failed: ${reason}`);
  return {
    executor: name,
    ok,
    settleMs,
    ...(via ? { via } : {}),
    ...(reason === undefined ? {} : { reason }),
  };
}
