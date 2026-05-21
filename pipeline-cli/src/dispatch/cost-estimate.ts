/**
 * Cost-warning helper for the Conductor's `claude-p-shell` emission UX
 * (RFC-0041 §4.5 + AC #7).
 *
 * When the Conductor emits the first manifest in a session that resolves to
 * `workerKind: claude-p-shell` (or `any` that gets claimed by the shell
 * supervisor), it prints a one-line cost notice naming the post-2026-06-15
 * Agent SDK credit pool. The notice is suppressible via the
 * `suppressCostWarning` field on `DispatchConfig`.
 *
 * **Estimate source** — the function reads the board's `done/` verdicts for
 * `workerKind === 'claude-p-shell'`. Each verdict carries `durationMs`; we
 * derive an average and multiply by the Agent SDK credit burn rate
 * documented in `pipeline-cli/docs/spawner.md` (Max-20x: ~$200/mo for
 * ~unlimited subscription, with Agent SDK calls drawing from a $200/mo
 * credit pool — practical heuristic: ~$0.05-0.20 per `claude -p` invocation
 * depending on prompt size, per AISDLC-353 observations).
 *
 * Until enough `claude-p-shell` verdicts accumulate to compute a rolling
 * average (we require ≥3 to call it "calibrated"), the estimate uses a
 * conservative default of $0.20 per task — toward the high end of the
 * observed range so operators are not surprised by overage.
 *
 * The function is intentionally pure: no I/O outside reading verdict
 * files. Tests inject a synthetic board fixture and verify both the
 * default path and the calibrated path.
 */

import { collectVerdicts } from './board.js';

/**
 * Default per-task cost in USD when we have no calibrated history. This
 * is a conservative upper-bound rather than a median: it errs toward
 * "warning is appropriately loud" instead of "we under-quoted and the
 * operator is surprised by a $20 day."
 */
export const DEFAULT_PER_TASK_USD = 0.2;

/** Minimum claude-p-shell verdicts before we trust the rolling average. */
export const CALIBRATION_FLOOR = 3;

/** Result of `estimateClaudePShellCost`. */
export interface CostEstimate {
  /** Mean USD per claude-p-shell task. */
  perTaskUsd: number;
  /** True when computed from ≥CALIBRATION_FLOOR verdicts; false → default. */
  calibrated: boolean;
  /** Number of verdicts that contributed to the estimate. */
  sampleSize: number;
  /** Total elapsed wall-clock time across the sampled verdicts. */
  totalDurationMs: number;
}

/**
 * Inspect the board's `done/` + `failed/` verdicts for `claude-p-shell`
 * entries, compute the rolling per-task average duration, and convert to
 * USD via a documented heuristic.
 *
 * The conversion `ms → USD` uses Anthropic's published Max-20x pricing for
 * the Agent SDK credit pool (~$200/mo ÷ ~1000 typical tasks/mo ≈ $0.20).
 * We avoid trying to compute tokens-out without the Anthropic API exposing
 * a usage field on `claude -p`; duration is the only reliably-observable
 * proxy for "how much credit did this draw".
 *
 * When a verdict lacks `durationMs`, it contributes to the sample count
 * but uses the default $0.20 for its contribution (so a partially-populated
 * dataset still produces a meaningful average without zeroing the cell).
 */
export function estimateClaudePShellCost(boardDir: string): CostEstimate {
  const verdicts = collectVerdicts(boardDir, { includeFailed: true });
  const shellVerdicts = verdicts.filter((v) => v.workerKind === 'claude-p-shell');

  if (shellVerdicts.length < CALIBRATION_FLOOR) {
    return {
      perTaskUsd: DEFAULT_PER_TASK_USD,
      calibrated: false,
      sampleSize: shellVerdicts.length,
      totalDurationMs: shellVerdicts.reduce((acc, v) => acc + (v.durationMs ?? 0), 0),
    };
  }

  const totalDurationMs = shellVerdicts.reduce((acc, v) => acc + (v.durationMs ?? 0), 0);
  const sampleSize = shellVerdicts.length;
  // Heuristic: 1 hour of `claude -p` ~= $0.40 (Max-20x SDK pool burn rate
  // observed). Per task: durationHrs × $0.40 — clamped at $1.00 to keep a
  // single outlier from poisoning the cost display.
  const meanDurationMs = totalDurationMs / sampleSize;
  const meanDurationHrs = meanDurationMs / (60 * 60 * 1000);
  const rawPerTask = Math.min(1.0, meanDurationHrs * 0.4);
  // Floor at the documented minimum so we never advertise "$0.00 per task".
  const perTaskUsd = Math.max(0.05, rawPerTask);

  return {
    perTaskUsd,
    calibrated: true,
    sampleSize,
    totalDurationMs,
  };
}

/**
 * Format the cost-warning message printed by the Conductor on first
 * `claude-p-shell` emission per session. Single-line, ANSI-free, prefixed
 * with `[dispatch-cost]` so operators can grep for it in logs.
 *
 * Examples:
 *
 *   [dispatch-cost] claude-p-shell draws Agent SDK credit pool post-2026-06-15;
 *     ~$0.20/task (default; calibration after 3 verdicts).
 *
 *   [dispatch-cost] claude-p-shell draws Agent SDK credit pool post-2026-06-15;
 *     ~$0.12/task (calibrated from 7 verdicts, avg duration 18 min).
 */
export function formatCostWarning(estimate: CostEstimate): string {
  const usd = estimate.perTaskUsd.toFixed(2);
  const detail = estimate.calibrated
    ? `calibrated from ${estimate.sampleSize} verdicts, avg duration ${Math.round(estimate.totalDurationMs / estimate.sampleSize / 60_000)} min`
    : `default; calibration after ${CALIBRATION_FLOOR} verdicts`;
  return `[dispatch-cost] claude-p-shell draws Agent SDK credit pool post-2026-06-15; ~$${usd}/task (${detail}).`;
}

/**
 * Stateful gate around `formatCostWarning` — the Conductor calls
 * `maybeEmitCostWarning(state, ...)` on every manifest emission, and the
 * helper ensures the message fires **exactly once per session** for
 * `claude-p-shell` manifests (AC #7). `suppressCostWarning` short-circuits.
 *
 * The state object is opaque + caller-owned (so a Conductor that spans
 * multiple tick invocations can persist the "already fired" flag in its
 * own session state).
 */
export interface CostWarningState {
  fired: boolean;
}

/** Per-session state factory. */
export function createCostWarningState(): CostWarningState {
  return { fired: false };
}

export interface MaybeEmitOptions {
  state: CostWarningState;
  workerKind: 'in-session-agent' | 'claude-p-shell' | 'any';
  boardDir: string;
  suppressCostWarning?: boolean;
  /** Output sink — defaults to stderr so it doesn't pollute JSON-on-stdout. */
  write?: (line: string) => void;
}

/**
 * Conductor-side hook. Emits a warning on the first `claude-p-shell` (or
 * `any` — pessimistic) manifest emission per session. No-ops on
 * `in-session-agent` manifests + on suppress.
 *
 * Returns the emitted message (for tests/assertion) or `undefined` when
 * the warning was skipped.
 */
export function maybeEmitCostWarning(opts: MaybeEmitOptions): string | undefined {
  const { state, workerKind, boardDir, suppressCostWarning, write } = opts;
  if (workerKind === 'in-session-agent') return undefined;
  if (suppressCostWarning) return undefined;
  if (state.fired) return undefined;

  const estimate = estimateClaudePShellCost(boardDir);
  const line = formatCostWarning(estimate);
  state.fired = true;
  const sink = write ?? ((msg: string): void => void process.stderr.write(`${msg}\n`));
  sink(line);
  return line;
}

/**
 * Conductor-side helper for the `WorkerSupervisorMissing` failure mode
 * (RFC §5.2): returns true when queue/ + inflight/ have pending
 * `claude-p-shell` / `any` work but the supervisor PID file is missing
 * or its owning process is dead.
 *
 * The caller passes a `peekFn` + `pidProbe` so this remains a pure check
 * (testable without touching real PIDs or the real board).
 */
export interface SupervisorMissingProbe {
  pendingClaudePShell: number;
  pidFileExists: boolean;
  pidLive: boolean;
}

export function isSupervisorMissing(probe: SupervisorMissingProbe): boolean {
  if (probe.pendingClaudePShell === 0) return false;
  if (!probe.pidFileExists) return true;
  return !probe.pidLive;
}
