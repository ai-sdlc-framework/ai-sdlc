/**
 * `_operator/interactions.jsonl` writer (RFC-0023 §10 / OQ-8 / AC#3 /
 * AISDLC-178.6).
 *
 * Records TUI navigation events — `paneOpened`, `drillDown`, `refresh`,
 * `search` etc. — to a local-only JSONL stream. Default ON per OQ-8;
 * the operator opts OUT via `AI_SDLC_TUI_TELEMETRY=off`. Disclosure of
 * the path + opt-out is shown at TUI startup (see `tui/banner.ts`).
 *
 * The data is local-only by design — operators own the file and can
 * `rm` it at will. RFC §10 OQ-8 reserves the right to flip to opt-IN
 * if/when this stream ever ships offsite.
 */

import { appendJsonlRecord, type AppendJsonlOpts } from './jsonl-append.js';
import { interactionsPath } from './paths.js';
import { isTelemetryEnabled } from './feature-flag.js';

/** The interaction kinds the writer recognizes. Open-ended on purpose. */
export type InteractionKind =
  | 'pane-opened'
  | 'drill-down'
  | 'refresh'
  | 'search-opened'
  | 'search-committed';

export interface InteractionRecord {
  /** ISO-8601 wall-clock. */
  ts: string;
  /** Discriminator. */
  kind: InteractionKind;
  /** The pane / mode the interaction targeted (e.g. `blockers`, `prs`). */
  pane?: string;
  /** Optional drill-down target (task ID, PR number, etc.). */
  target?: string;
  /** Free-form label (e.g. the search query). */
  detail?: string;
}

export interface WriteInteractionOpts extends AppendJsonlOpts {
  /** Override the artifacts directory (tests). */
  artifactsDir?: string;
  /** Override the env predicate (tests pass `() => true` to bypass the gate). */
  isEnabled?: () => boolean;
  /** Inject the clock used to stamp `ts` when callers omit it. */
  now?: () => Date;
}

/**
 * Append one interaction record. Best-effort; returns false when the
 * `AI_SDLC_TUI_TELEMETRY=off` flag is set OR the write threw.
 *
 * Stamps `ts` if the caller didn't pre-set it (the common path — most
 * mode-router callsites mint the event at the same instant they invoke
 * this function).
 */
export function writeInteraction(
  record: Omit<InteractionRecord, 'ts'> & { ts?: string },
  opts: WriteInteractionOpts = {},
): boolean {
  const enabled = (opts.isEnabled ?? isTelemetryEnabled)();
  if (!enabled) return false;
  const now = opts.now ?? ((): Date => new Date());
  const stamped: InteractionRecord = {
    ...(record as InteractionRecord),
    ts: record.ts ?? now().toISOString(),
  };
  return appendJsonlRecord(
    interactionsPath(opts.artifactsDir),
    stamped as unknown as Record<string, unknown>,
    { logger: opts.logger, loggerTag: '[tui-analytics:interactions]' },
  );
}
