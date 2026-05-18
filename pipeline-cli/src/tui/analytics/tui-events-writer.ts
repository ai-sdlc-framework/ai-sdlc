/**
 * Writer for the TUI self-observability event log
 * (`$ARTIFACTS_DIR/_tui/events.jsonl`).
 *
 * The existing `cli-tui-corpus aggregate` reads this file (RFC-0023 §13 Phase
 * 7 / `corpus/aggregate.ts`).  By writing `TuiCaptureFiled` events here when
 * a Decision is resolved from the DecisionsPendingPane, Phase 8 COMPOSES with
 * the existing aggregator rather than creating a duplicate aggregator (AC#5).
 *
 * Event shape (matches the `TuiEvent` type in `corpus/aggregate.ts`):
 *
 *   TuiCaptureFiled { ts, type, sessionId?, captureId, pane? }
 *
 * The `sessionId` field is optional — callers that don't have a session ID
 * omit it; the aggregator buckets those events into `'(unknown-session)'`.
 *
 * @module tui/analytics/tui-events-writer
 */

import { appendJsonlRecord, type AppendJsonlOpts } from './jsonl-append.js';
import { tuiEventsPath } from './paths.js';
import { isTelemetryEnabled } from './feature-flag.js';

export interface WriteTuiCaptureFiledOpts extends AppendJsonlOpts {
  /** Override the artifacts directory (tests). */
  artifactsDir?: string;
  /** Override the telemetry-enabled predicate (tests). */
  isEnabled?: () => boolean;
  /** Override the clock used to stamp `ts` (tests). */
  now?: () => Date;
}

/**
 * Append a `TuiCaptureFiled` event to `$ARTIFACTS_DIR/_tui/events.jsonl`.
 *
 * Called by the DecisionsPendingPane after each operator resolution so the
 * corpus aggregator counts Decision resolves as captures filed in the session.
 *
 * Returns true on success, false when the telemetry flag is off or the write
 * threw.  Best-effort — never throws.
 */
export function writeTuiCaptureFiled(
  captureId: string,
  opts: WriteTuiCaptureFiledOpts & {
    pane?: string;
    sessionId?: string;
  } = {},
): boolean {
  const enabled = (opts.isEnabled ?? isTelemetryEnabled)();
  if (!enabled) return false;
  const now = opts.now ?? ((): Date => new Date());
  const record: Record<string, unknown> = {
    ts: now().toISOString(),
    type: 'TuiCaptureFiled',
    captureId,
  };
  if (opts.sessionId) record.sessionId = opts.sessionId;
  if (opts.pane) record.pane = opts.pane;
  return appendJsonlRecord(tuiEventsPath(opts.artifactsDir), record, {
    logger: opts.logger,
    loggerTag: '[tui:capture-filed]',
  });
}
