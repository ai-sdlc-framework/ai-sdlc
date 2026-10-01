/**
 * Session heartbeat reaper (AISDLC-481).
 *
 * Detects sessions whose `lastHeartbeat` (in
 * `.ai-sdlc/dispatch/sessions/<task>.session.json`) is older than a
 * configurable threshold and marks them `failed` in the session file.
 *
 * Two-substrate reconciliation: after marking the session file failed, the
 * reaper also sweeps the Dispatch Board inflight substrate (board.ts
 * `sweepStaleHeartbeats`) for the same task ID so the two substrates stay
 * consistent — no orphan in one while the other shows the session alive.
 *
 * The reaper is mechanism-agnostic: it operates purely on filesystem state
 * (session files + board files) and does not invoke tmux or any process
 * management. Callers (execute-parallel-status, orchestrator-tick) invoke it
 * on each poll cycle.
 *
 * Hermetic: all I/O goes through injected `boardDir` and `now` — no real
 * time or filesystem globals.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_HEARTBEAT_STALE_MS,
  ensureBoardDirs,
  readHeartbeat,
  readInflightManifest,
  requeueInflight,
  sweepStaleHeartbeats,
  writeDiagnostic,
} from './board.js';
import { listSessions, readCancelSignal, removeCancelSignal, updateSession } from './sessions.js';
import type { DispatchVerdict } from './types.js';

// ---------------------------------------------------------------------------
// Default threshold
// ---------------------------------------------------------------------------

/**
 * Default stale-session threshold: 30 minutes. Matches the Dispatch Board
 * inflight sweeper default (RFC-0041 OQ-3) so the two substrates' liveness
 * windows are identical.
 */
export const DEFAULT_SESSION_STALE_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for a reaper run. */
export interface ReaperOptions {
  /**
   * Directory root of the dispatch board (e.g. `.ai-sdlc/dispatch`).
   * Defaults to `.ai-sdlc/dispatch` relative to cwd when omitted.
   */
  boardDir?: string;
  /**
   * Age threshold in milliseconds. Sessions whose `lastHeartbeat` is older
   * than this are reaped. Defaults to `DEFAULT_SESSION_STALE_MS` (30 min).
   */
  staleMs?: number;
  /**
   * Clock injection for hermetic testing. Defaults to `() => new Date()`.
   */
  now?: () => Date;
}

/** Per-task result of a reap operation. */
export interface ReapedSession {
  taskId: string;
  /** ISO-8601 timestamp of the last observed heartbeat that triggered the reap. */
  lastHeartbeat: string;
  /** True when the Dispatch Board inflight entry was also swept. */
  boardReconciled: boolean;
}

/** Aggregate result returned by `reapStaleSessions`. */
export interface SessionReaperResult {
  /** Task IDs whose session file was reaped (status → `failed`). */
  reaped: ReapedSession[];
  /**
   * Task IDs from the board-level sweep that were NOT in the sessions
   * substrate (board-only orphans also reconciled by this run).
   */
  boardOnlyReaped: string[];
}

// ---------------------------------------------------------------------------
// Core reaper
// ---------------------------------------------------------------------------

/**
 * Sweep the sessions substrate for stale heartbeats and reconcile with the
 * Dispatch Board inflight substrate.
 *
 * Algorithm:
 *   1. List all session files via `listSessions`.
 *   2. For each session with status `starting` or `in-progress`:
 *      a. If `lastHeartbeat` is absent, use `spawnedAt` as the liveness anchor.
 *      b. If the anchor is older than `staleMs`, mark the session `failed`.
 *      c. Attempt to reconcile the Dispatch Board inflight entry for the same
 *         task ID via `sweepStaleHeartbeats` with `staleMs=0` (force-reap) for
 *         that specific task. If no inflight entry existed, `boardReconciled`
 *         is false.
 *   3. Run a board-level sweep for all inflight entries (catches entries with
 *      no corresponding session file — board-only orphans).
 *
 * Returns aggregated results so callers can surface the reap in the status
 * table and events.jsonl.
 */
export function reapStaleSessions(opts: ReaperOptions = {}): SessionReaperResult {
  const boardDir = opts.boardDir ?? '.ai-sdlc/dispatch';
  const staleMs = opts.staleMs ?? DEFAULT_SESSION_STALE_MS;
  const now = opts.now ?? (() => new Date());

  const wallNow = now();
  const cutoffMs = wallNow.getTime() - staleMs;

  // Ensure board dirs exist before any sweep.
  for (const sub of ['queue', 'inflight', 'done', 'failed']) {
    mkdirSync(path.join(boardDir, sub), { recursive: true });
  }

  const sessions = listSessions(boardDir);
  const reaped: ReapedSession[] = [];

  for (const session of sessions) {
    if (session.status !== 'starting' && session.status !== 'in-progress') continue;

    // Use lastHeartbeat if available; fall back to spawnedAt.
    const anchorIso = session.lastHeartbeat ?? session.spawnedAt;
    const anchorMs = anchorIso ? Date.parse(anchorIso) : NaN;

    if (Number.isNaN(anchorMs) || anchorMs > cutoffMs) {
      // Still alive — not stale.
      continue;
    }

    // Reap: mark session file failed.
    updateSession(boardDir, session.taskId, {
      status: 'failed',
      lastHeartbeat: wallNow.toISOString(),
    });

    // Reconcile the board inflight entry.
    // We force a sweep with staleMs=0 which makes any existing inflight entry
    // for this taskId appear stale regardless of its own heartbeat age.
    // We detect board reconciliation by checking whether the sweep reaped
    // the specific task's entry.
    const boardSweep = sweepStaleHeartbeats(boardDir, { staleMs: 0, now });
    const boardReconciled = boardSweep.reapedTaskIds.includes(session.taskId);

    // If the board had NO inflight entry for this task at all (the session
    // was a tmux-only session not backed by a board manifest), we write a
    // diagnostic to failed/ so both substrates record the event.
    if (!boardReconciled) {
      const inflightManifestPath = path.join(
        boardDir,
        'inflight',
        `${session.taskId}.dispatch.json`,
      );
      if (!existsSync(inflightManifestPath)) {
        const diagnostic: DispatchVerdict = {
          schemaVersion: 'v1',
          taskId: session.taskId,
          outcome: 'failed',
          completedAt: wallNow.toISOString(),
          workerId: 'session-reaper',
          cause: 'stale-heartbeat',
          notes: `session-reaper: tmux session file heartbeat ${anchorIso} older than ${staleMs}ms; no board inflight entry found`,
        };
        try {
          writeDiagnostic(boardDir, diagnostic);
        } catch {
          /* non-fatal — diagnostic write failure should not abort the reap */
        }
      }
    }

    reaped.push({
      taskId: session.taskId,
      lastHeartbeat: anchorIso ?? wallNow.toISOString(),
      boardReconciled,
    });
  }

  // Board-level sweep: catches inflight entries with no corresponding session
  // file (board-only orphans from Workers that don't use execute-parallel).
  const boardOnlySweep = sweepStaleHeartbeats(boardDir, { staleMs, now });
  // Filter out tasks already reaped above to compute the board-only set.
  const alreadyReapedIds = new Set(reaped.map((r) => r.taskId));
  const boardOnlyReaped = boardOnlySweep.reapedTaskIds.filter((id) => !alreadyReapedIds.has(id));

  return { reaped, boardOnlyReaped };
}

// ---------------------------------------------------------------------------
// Cancel-acknowledgment helper
// ---------------------------------------------------------------------------

/**
 * Check whether a cancel signal exists for a task and, if so, mark the
 * session file `cancelled` and write a board diagnostic. Returns `true` when
 * the session was cancelled (caller should stop the pipeline); `false`
 * otherwise.
 *
 * This is the Worker-side handler. It reads
 * `.ai-sdlc/dispatch/sessions/<task>.cancel.json`, consumes it (removes the
 * file), marks the session file `cancelled`, and writes a board diagnostic so
 * the Conductor's verdict poll sees the cancellation.
 *
 * The cancel signal file is removed BEFORE the session update so that a crash
 * between the two writes never leaves the signal in place for a re-run to
 * honor spuriously.
 *
 * V1 SCOPE: cancel-only. Full pause/resume is a deliberate follow-up (AC-4).
 */
export function honorCancelIfRequested(
  boardDir: string,
  taskId: string,
  opts: { now?: () => Date; decisionId?: string } = {},
): boolean {
  const signal = readCancelSignal(boardDir, taskId);
  if (!signal) return false;

  const now = opts.now ? opts.now() : new Date();

  // Remove the signal first — no spurious re-honor on restart.
  removeCancelSignal(boardDir, taskId);

  // Mark the session file cancelled.
  updateSession(boardDir, taskId, {
    status: 'cancelled',
    lastHeartbeat: now.toISOString(),
  });

  // Write a board diagnostic so the Conductor's verdict poll sees cancellation.
  const diagnostic: DispatchVerdict = {
    schemaVersion: 'v1',
    taskId,
    outcome: 'failed',
    completedAt: now.toISOString(),
    workerId: 'session-cancel-handler',
    cause: 'operator-cancel',
    notes: [
      `session cancelled at step boundary`,
      signal.reason ? `reason: ${signal.reason}` : undefined,
      opts.decisionId ? `decision-id: ${opts.decisionId}` : undefined,
    ]
      .filter(Boolean)
      .join('; '),
  };
  try {
    writeDiagnostic(boardDir, diagnostic);
  } catch {
    /* non-fatal */
  }

  return true;
}

// ---------------------------------------------------------------------------
// Requeue reaper
// ---------------------------------------------------------------------------

/** Default number of times a stale manifest is returned to `queue/` before it fails. */
export const DEFAULT_REQUEUE_RETRY_LIMIT = 2;

/** Options for {@link requeueStaleInflight}. */
export interface RequeueOptions {
  /** Heartbeat age limit in milliseconds (default 30 minutes). */
  staleMs?: number;
  /** Requeues allowed per manifest; the next stale event fails it (default 2). */
  retryLimit?: number;
  /**
   * Live session names from the hierarchy roster. When given, an inflight
   * manifest whose claiming session (the heartbeat's worker id) is not in
   * this set is requeued regardless of heartbeat age. Omit when no roster
   * exists.
   */
  roster?: ReadonlySet<string>;
  now?: () => Date;
}

/** What the requeue reaper did with each stale inflight manifest. */
export interface RequeueResult {
  /** Returned to `queue/` with an incremented retry count. */
  requeued: { taskId: string; retryCount: number; reason: string }[];
  /** Past the retry limit; moved to `failed/` with a diagnostic. */
  failed: { taskId: string; retryCount: number; reason: string }[];
}

/**
 * Return stale inflight manifests to `queue/` for another executor.
 *
 * A manifest is stale when its heartbeat (or, with no heartbeat yet, its
 * dispatch time) is older than `staleMs`, or when a roster is supplied and
 * the claiming session is not on it. Each stale manifest has its retry count
 * incremented and goes back to `queue/`; once the incremented count exceeds
 * `retryLimit` it goes to `failed/` instead.
 */
export function requeueStaleInflight(boardDir: string, opts: RequeueOptions = {}): RequeueResult {
  ensureBoardDirs(boardDir);
  const staleMs = opts.staleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
  const retryLimit = opts.retryLimit ?? DEFAULT_REQUEUE_RETRY_LIMIT;
  const wallNow = (opts.now ?? (() => new Date()))();
  const cutoff = wallNow.getTime() - staleMs;
  const result: RequeueResult = { requeued: [], failed: [] };

  const inflightDir = path.join(boardDir, 'inflight');
  for (const entry of readdirSync(inflightDir)) {
    if (!entry.endsWith('.dispatch.json')) continue;
    const taskId = entry.slice(0, -'.dispatch.json'.length);
    const manifest = readInflightManifest(boardDir, taskId);
    if (!manifest) continue;
    const heartbeat = readHeartbeat(boardDir, taskId);

    let reason: string | undefined;
    if (opts.roster && heartbeat?.workerId && !opts.roster.has(heartbeat.workerId)) {
      reason = `claiming session ${heartbeat.workerId} is no longer on the roster`;
    } else {
      const lastTickMs = Date.parse(heartbeat ? heartbeat.lastHeartbeat : manifest.dispatchedAt);
      if (!Number.isNaN(lastTickMs) && lastTickMs <= cutoff) {
        reason = `no heartbeat for more than ${Math.round(staleMs / 60000)} minutes`;
      }
    }
    if (!reason) continue;

    const retryCount = (manifest.retryCount ?? 0) + 1;
    if (retryCount > retryLimit) {
      writeDiagnostic(boardDir, {
        schemaVersion: 'v1',
        taskId,
        outcome: 'failed',
        completedAt: wallNow.toISOString(),
        workerId: 'session-reaper',
        cause: 'retry-limit-exceeded',
        notes: `${reason}; requeued ${manifest.retryCount ?? 0} time(s), limit ${retryLimit}`,
      });
      result.failed.push({ taskId, retryCount, reason });
    } else if (requeueInflight(boardDir, taskId, retryCount)) {
      result.requeued.push({ taskId, retryCount, reason });
    }
  }
  return result;
}
