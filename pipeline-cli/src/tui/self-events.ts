/**
 * `_tui/events.jsonl` writer — TUI self-observability stream
 * (RFC-0023 §12 / AISDLC-178.7).
 *
 * Distinct from `_operator/interactions.jsonl` (RFC §10). The two streams
 * answer different questions:
 *
 *   - `_operator/interactions.jsonl` (Phase 6) — operator-throughput
 *     instrumentation. Pane-opened / drill-down / refresh / search events
 *     keyed by mode. Source for "how is the operator using the surface?"
 *   - `_tui/events.jsonl` (this module) — TUI self-observability for
 *     framework maintainers. Process-lifecycle (`TuiStarted`, `TuiCrashed`)
 *     and data-source health (`TuiDataSourceFailed`) events. Source for
 *     "is the TUI itself healthy?" and the Phase 7 promotion gate (RFC
 *     §13: "zero TuiCrashed events during the soak — hard gate").
 *
 * Both streams are gated by the same `AI_SDLC_TUI_TELEMETRY=off` opt-out
 * (per OQ-8) so an operator who opts out gets the same kill-switch
 * coverage. Off-disk shipping is still strictly opt-IN per OQ-8 — this
 * writer is local-only.
 *
 * Best-effort by design: write failures are swallowed so a transient disk
 * hiccup never crashes the Ink render loop. Schema:
 *
 *   {
 *     "ts": "2026-05-07T16:42:03.123Z",
 *     "type": "TuiStarted" | "TuiCrashed" | "TuiDataSourceFailed" |
 *             "TuiPaneOpened" | "TuiActionTaken",
 *     "version": "0.1.0",                    // optional, on TuiStarted
 *     "termCols": 120, "termRows": 40,       // optional, on TuiStarted
 *     "errorMessage": "...", "stack": "...", // on TuiCrashed
 *     "source": "gh-pr-cache",               // on TuiDataSourceFailed
 *     "errorKind": "source-unavailable",
 *     ...                                    // free-form additional fields
 *   }
 *
 * @module tui/self-events
 */

import { join } from 'node:path';
import { appendJsonlRecord, type AppendJsonlOpts } from './analytics/jsonl-append.js';
import { isTelemetryEnabled } from './analytics/feature-flag.js';
import { resolveArtifactsDir } from './sources/types.js';

/**
 * Kinds the writer recognises. Open-ended on purpose so future event types
 * (e.g. `TuiPaneOpened` overlap with the operator stream) can ride on the
 * same writer without a schema bump. Phase 7 ships `TuiStarted` and
 * `TuiCrashed`; the remaining kinds are reserved per RFC §12 for follow-on
 * phases.
 */
export type SelfEventType =
  | 'TuiStarted'
  | 'TuiCrashed'
  | 'TuiDataSourceFailed'
  | 'TuiPaneOpened'
  | 'TuiActionTaken';

export interface SelfEventEnvelope {
  /** ISO-8601 wall-clock; stamped by the writer when the caller omits it. */
  ts: string;
  /** Discriminator. */
  type: SelfEventType;
  /** Free-form per-type payload. */
  [k: string]: unknown;
}

export interface WriteSelfEventOpts extends AppendJsonlOpts {
  /** Override the artifacts directory (tests). */
  artifactsDir?: string;
  /** Override the env predicate (tests pass `() => true` to bypass the gate). */
  isEnabled?: () => boolean;
  /** Inject the clock used to stamp `ts` when callers omit it. */
  now?: () => Date;
}

/**
 * Resolve the on-disk path for the self-observability events file. Single
 * file (not date-rotated) — TUI usage is bursty + lifetime-low (operator
 * runs the TUI for a session, closes it). The corpus aggregator handles
 * windowing internally rather than relying on rotation.
 */
export function selfEventsPath(artifactsDir?: string): string {
  return join(resolveArtifactsDir({ artifactsDir }), '_tui', 'events.jsonl');
}

/**
 * Append one self-observability event to `_tui/events.jsonl`. Best-effort
 * — returns `false` when telemetry is disabled OR the write threw. The
 * caller can ignore the return; tests use it for assertions.
 */
export function writeSelfEvent(
  event: Omit<SelfEventEnvelope, 'ts'> & { ts?: string },
  opts: WriteSelfEventOpts = {},
): boolean {
  const enabled = (opts.isEnabled ?? isTelemetryEnabled)();
  if (!enabled) return false;
  const now = opts.now ?? ((): Date => new Date());
  const stamped: SelfEventEnvelope = {
    ...(event as SelfEventEnvelope),
    ts: event.ts ?? now().toISOString(),
  };
  return appendJsonlRecord(
    selfEventsPath(opts.artifactsDir),
    stamped as unknown as Record<string, unknown>,
    {
      logger: opts.logger,
      loggerTag: '[tui-self-events]',
    },
  );
}

/**
 * Convenience wrapper for the `TuiStarted` event. Captures version +
 * terminal dimensions when available so the corpus can detect "operator
 * launched but never opened a pane" patterns (a usability signal — does
 * the surface fit on their terminal?).
 *
 * `version` is read from the package's exported version when callers don't
 * supply one. `termCols`/`termRows` fall back to `process.stdout` when the
 * Ink render hasn't bound them yet.
 */
export function writeTuiStarted(
  context: { version?: string; termCols?: number; termRows?: number } = {},
  opts: WriteSelfEventOpts = {},
): boolean {
  return writeSelfEvent(
    {
      type: 'TuiStarted',
      version: context.version,
      termCols: context.termCols ?? process.stdout.columns,
      termRows: context.termRows ?? process.stdout.rows,
    },
    opts,
  );
}

/**
 * Convenience wrapper for the `TuiCrashed` event. The hard promotion gate
 * (RFC §13 / AC#2) requires ZERO occurrences across the soak window, so
 * any caller that catches an unhandled error in the TUI process MUST
 * funnel it here.
 *
 * `error` accepts both `Error` instances and arbitrary thrown values
 * (string, undefined, etc.); the writer normalises into `errorMessage` +
 * optional `stack` so the corpus aggregator's count math is consistent.
 */
export function writeTuiCrashed(error: unknown, opts: WriteSelfEventOpts = {}): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  return writeSelfEvent({ type: 'TuiCrashed', errorMessage, stack }, opts);
}
