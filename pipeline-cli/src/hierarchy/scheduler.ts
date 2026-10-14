/**
 * Reconcile scheduler (RFC-0054, AISDLC-829). Deterministic code in the dispatch
 * loop, never a model turn. A reconcile runs (a) once at start (session start or
 * machine wake), (b) shortly after the webhook receiver touches the wake file
 * (debounced), and (c) on a timer: 60 s while any task or docs PR is open, else 15 min.
 */

import { statSync } from 'node:fs';

export const BUSY_INTERVAL_MS = 60_000;
export const IDLE_INTERVAL_MS = 15 * 60_000;
export const DEFAULT_DEBOUNCE_MS = 2_000;
export const WAKE_POLL_MS = 1_000;

/** Timer delay until the next reconcile, given how many PRs are open. Pure. */
export function nextIntervalMs(openPrs: number): number {
  return openPrs > 0 ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS;
}

export interface SchedulerDeps {
  wakeFile: string;
  /** Runs one reconcile and returns the number of open PRs afterwards. */
  reconcile: () => Promise<number> | number;
  debounceMs?: number;
  pollMs?: number;
  /** Modification time of the wake file in ms, or undefined when it does not exist. */
  mtime?: (file: string) => number | undefined;
}

export interface Scheduler {
  stop(): void;
}

function fsMtime(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Start the scheduler: one reconcile now, then on wake-file touch and on the timer. */
export function startScheduler(deps: SchedulerDeps): Scheduler {
  const mtime = deps.mtime ?? fsMtime;
  const debounce = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let seen = mtime(deps.wakeFile);
  let stopped = false;
  let running = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let tickTimer: ReturnType<typeof setTimeout> | undefined;

  const run = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    clearTimeout(tickTimer);
    let open = 0;
    try {
      open = await deps.reconcile();
    } catch {
      /* a failed pass is retried on the next trigger */
    } finally {
      running = false;
    }
    if (!stopped) tickTimer = setTimeout(() => void run(), nextIntervalMs(open));
  };

  const poll = setInterval(() => {
    const m = mtime(deps.wakeFile);
    if (m !== undefined && m !== seen) {
      seen = m;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void run(), debounce);
    }
  }, deps.pollMs ?? WAKE_POLL_MS);

  void run();
  return {
    stop() {
      stopped = true;
      clearInterval(poll);
      clearTimeout(debounceTimer);
      clearTimeout(tickTimer);
    },
  };
}
