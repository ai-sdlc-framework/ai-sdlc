/**
 * `cli-hierarchy clear <name>`: ask a roster session to rotate its context (RFC-0058 phase 4).
 *
 * The keystroke layer is gone: nothing here types into a pane or reads pane text. A clear is
 * one rotate request plus one acknowledgement. The request is a file under the board
 * (`handoff/rotate-request-<name>.json`, see `rotate-request.ts`). The dispatch session's hooks
 * module consumes it on its next tick (`cli-hierarchy rotate-pending`): it rotates itself when
 * the request names it, and otherwise sends the named session a `rotate` message with
 * `$.session.send`, whose own module runs the one rotation (handoff, clear, resume). The
 * request file disappearing is the acknowledgement.
 *
 * Refusals, all named and all sending nothing:
 *  - the name is not a running roster session, or its roster entry is unsafe;
 *  - an executor that holds an inflight manifest (its context is work in progress);
 *  - no running dispatch session: nothing would consume the request, so no hooks module is loaded;
 *  - the request was not consumed within the ceiling: the hooks module is not loaded or not ticking.
 */

import { existsSync } from 'node:fs';

import { readInflightManifest } from '../dispatch/board.js';
import type { EventEmitter } from './emit.js';
import { listInflight } from './inflight.js';
import { requestRotate, rotateRequestPath } from './rotate-request.js';
import { readRosterChecked, unsafeEntryReason } from './roster.js';

/** Default ceiling, in milliseconds, for the acknowledgement. Overridable in `.ai-sdlc/pr-lifecycle.yaml` (`clear.handshakeCeilingMs`) or `--settle-ms`. */
export const DEFAULT_SETTLE_MS = 30_000;
/** Default spacing of the "was the request consumed" checks. */
export const DEFAULT_POLL_INTERVAL_MS = 500;

const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Collaborators of {@link clearExecutor}; every one is injected in tests. */
export interface ClearDeps {
  boardDir: string;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Records the `ExecutorContextCleared` event. */
  emit?: EventEmitter;
  log?: (line: string) => void;
}

/** Inputs of {@link clearExecutor}. */
export interface ClearOptions {
  /** Roster name of the session to rotate. */
  executor: string;
  /** Ceiling for the acknowledgement; default {@link DEFAULT_SETTLE_MS}. 0 writes the request and does not wait. */
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
  /** The request was written and, unless `settleMs` is 0, acknowledged. */
  ok: boolean;
  /** The hooks module consumed the request. */
  acknowledged: boolean;
  settleMs: number;
  /** The request file. */
  file?: string;
  /** Set when `ok` is false: the named refusal. */
  reason?: string;
}

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
 * Ask the named session to rotate and report the acknowledgement.
 * @throws, writing nothing, when the name is invalid, is not a running roster session, its entry is
 *   unsafe, it holds an inflight task, or the roster has no running dispatch session to deliver the request.
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
  if (entry.role === 'executor') {
    const held = holdsInflight(deps.boardDir, name);
    if (held) {
      throw new Error(`refusing to clear '${name}': it holds ${held}, which is still inflight`);
    }
  }
  if (!roster.sessions.some((e) => e.role === 'operator-dispatch' && e.status === 'running')) {
    throw new Error(
      `refusing to clear '${name}': no running dispatch session in the roster, so no hooks module is loaded to deliver the rotate request; start one with cli-hierarchy up`,
    );
  }

  const file = requestRotate(deps.boardDir, name, deps.now());
  let acknowledged = false;
  const polls = settleMs === 0 ? 0 : Math.max(1, Math.ceil(settleMs / pollIntervalMs));
  for (let i = 0; i < polls && !acknowledged; i++) {
    await deps.sleep(pollIntervalMs);
    acknowledged = !existsSync(rotateRequestPath(deps.boardDir, name));
  }
  const ok = settleMs === 0 || acknowledged;
  const reason = ok
    ? undefined
    : `rotate request not acknowledged within ${settleMs} ms: no hooks module consumed it, so the dispatch session has no module loaded (check its pane and the module version floor); the request stays pending at ${file}`;
  deps.emit?.({
    type: 'ExecutorContextCleared',
    executor: name,
    paneId: entry.paneId,
    resumed: acknowledged,
    settleMs,
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.workerId ? { workerId: opts.workerId } : {}),
  });
  deps.log?.(ok ? `rotate requested for '${name}'` : `clear of '${name}' failed: ${reason}`);
  return {
    executor: name,
    ok,
    acknowledged,
    settleMs,
    file,
    ...(reason === undefined ? {} : { reason }),
  };
}
