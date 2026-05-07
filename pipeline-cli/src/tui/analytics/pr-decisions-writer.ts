/**
 * `_operator/pr-decisions.jsonl` writer + PR-state transition tracker
 * (RFC-0023 §10 / AC#2 / AISDLC-178.6).
 *
 * Two surfaces:
 *
 *   1. `writePrDecision()` — pure JSONL appender callable from any code
 *      that knows it just performed a PR action (a future `gh pr merge`
 *      wrapper, a TUI mutation handler, etc.). Best-effort + telemetry-
 *      flag gated.
 *
 *   2. `PrDecisionsTracker` — stateful detector that the TUI runs
 *      alongside the gh-pr-cache. Tracks two state edges:
 *        - `attention-required ⇒ resolved`
 *            attention-required = `state: OPEN` + reviewDecision
 *            `CHANGES_REQUESTED`. Resolved = the PR is no longer in that
 *            state on the next snapshot (merged, closed, dismissed, or
 *            reviewer re-approved).
 *        - `attention-required` first-sighting timer
 *            We need an "attention-required-at" timestamp to compute the
 *            elapsed-time field. Stored against the PR until we observe
 *            the resolution.
 *
 * Captures merge / dismiss / comment broadly per RFC §10 — but encoded as
 * a generic `actionKind: 'resolved'` for now. Phase 7 dogfood will tell
 * us whether finer granularity (separate merge/dismiss/comment) actually
 * pays for itself; the schema leaves room for extension.
 */

import { appendJsonlRecord, type AppendJsonlOpts } from './jsonl-append.js';
import { prDecisionsPath } from './paths.js';
import { isTelemetryEnabled } from './feature-flag.js';
import type { GhPrSummary } from '../sources/gh-pr-cache.js';

/** ReviewDecision string representing "operator MUST act before this PR moves". */
export const ATTENTION_REQUIRED_REVIEW_DECISION = 'CHANGES_REQUESTED';

export type PrDecisionAction = 'resolved' | 'merged' | 'closed' | 'dismissed' | 'commented';

/**
 * One record on `pr-decisions.jsonl`. The `elapsedMs` field is the time
 * the PR sat in the attention-required state before the operator acted —
 * the field RFC §10 highlights as actionable for "where is the operator
 * the bottleneck?".
 */
export interface PrDecisionRecord {
  /** ISO-8601 wall-clock when the resolution was observed. */
  ts: string;
  /** PR number. */
  pr: number;
  /** PR url (when available). */
  url?: string;
  /** Action observed — see PrDecisionAction. */
  action: PrDecisionAction;
  /** Final PR `state` field at the time of resolution (e.g. MERGED, CLOSED, OPEN). */
  finalState: string;
  /** ISO-8601 of when the PR entered `attention-required`. */
  attentionRequiredAt: string;
  /** ISO-8601 of resolution (== `ts`). */
  resolvedAt: string;
  /** Wall-clock elapsed time the PR sat in attention-required, ms. */
  elapsedMs: number;
}

export interface WritePrDecisionOpts extends AppendJsonlOpts {
  /** Override the artifacts directory (tests). */
  artifactsDir?: string;
  /** Override the env predicate (tests pass `() => true` to bypass the gate). */
  isEnabled?: () => boolean;
}

/**
 * Append one PR-decision record. Best-effort; returns false on env-gate
 * disable or write throw.
 */
export function writePrDecision(record: PrDecisionRecord, opts: WritePrDecisionOpts = {}): boolean {
  const enabled = (opts.isEnabled ?? isTelemetryEnabled)();
  if (!enabled) return false;
  return appendJsonlRecord(
    prDecisionsPath(opts.artifactsDir),
    record as unknown as Record<string, unknown>,
    { logger: opts.logger, loggerTag: '[tui-analytics:pr-decisions]' },
  );
}

// ── Tracker ──────────────────────────────────────────────────────────

export interface PrDecisionsTrackerOpts extends WritePrDecisionOpts {
  /** Inject the writer (tests). */
  writer?: (record: PrDecisionRecord, opts?: WritePrDecisionOpts) => boolean;
  /** Inject a clock. */
  now?: () => Date;
}

interface PrTrackedEntry {
  /** Whether the PR is currently in the attention-required state. */
  attentionRequired: boolean;
  /** ISO-8601 when it entered attention-required (if applicable). */
  attentionRequiredAt: string | null;
  /** Last `state` we observed (OPEN / MERGED / CLOSED). */
  lastState: string;
}

function isAttentionRequired(pr: GhPrSummary): boolean {
  // OPEN PR + reviewer asked for changes = operator must act. We don't
  // count CLOSED + CHANGES_REQUESTED — that's already resolved.
  if (pr.state !== 'OPEN') return false;
  return pr.reviewDecision === ATTENTION_REQUIRED_REVIEW_DECISION;
}

function classifyAction(pr: GhPrSummary): PrDecisionAction {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  // PR still OPEN but no longer attention-required → dismissed (the
  // operator either re-requested review, addressed via commit, or the
  // reviewer flipped to APPROVED). RFC §10 lumps these together.
  return 'dismissed';
}

/**
 * Observes successive PR snapshots and emits one record per
 * attention-required-resolution edge. Cold-start: first snapshot seeds
 * the baseline without emitting any records.
 */
export class PrDecisionsTracker {
  private readonly entries = new Map<number, PrTrackedEntry>();
  private seeded = false;

  constructor(private readonly opts: PrDecisionsTrackerOpts = {}) {}

  observe(prs: ReadonlyArray<GhPrSummary>): PrDecisionRecord[] {
    const writer = this.opts.writer ?? writePrDecision;
    const now = (this.opts.now ?? ((): Date => new Date()))();
    const nowIso = now.toISOString();
    const emitted: PrDecisionRecord[] = [];
    const seenNumbers = new Set<number>();

    for (const pr of prs) {
      seenNumbers.add(pr.number);
      const prev = this.entries.get(pr.number);
      const attentionNow = isAttentionRequired(pr);

      if (!prev) {
        this.entries.set(pr.number, {
          attentionRequired: attentionNow,
          attentionRequiredAt: attentionNow ? nowIso : null,
          lastState: pr.state,
        });
        continue;
      }

      // Edge: → attention-required (start the timer).
      if (attentionNow && !prev.attentionRequired) {
        this.entries.set(pr.number, {
          attentionRequired: true,
          attentionRequiredAt: nowIso,
          lastState: pr.state,
        });
        continue;
      }

      // Edge: attention-required → resolved (emit one record).
      if (!attentionNow && prev.attentionRequired && this.seeded) {
        const attentionAt = prev.attentionRequiredAt ?? nowIso;
        const elapsedMs = Math.max(0, now.getTime() - new Date(attentionAt).getTime());
        const record: PrDecisionRecord = {
          ts: nowIso,
          pr: pr.number,
          url: pr.url,
          action: classifyAction(pr),
          finalState: pr.state,
          attentionRequiredAt: attentionAt,
          resolvedAt: nowIso,
          elapsedMs,
        };
        emitted.push(record);
        writer(record, this.opts);
        this.entries.set(pr.number, {
          attentionRequired: false,
          attentionRequiredAt: null,
          lastState: pr.state,
        });
        continue;
      }

      // Same state — just refresh the lastState cache.
      this.entries.set(pr.number, {
        attentionRequired: prev.attentionRequired,
        attentionRequiredAt: prev.attentionRequiredAt,
        lastState: pr.state,
      });
    }

    // PR fell out of the snapshot — usually because gh's --state=open
    // filter dropped it after a merge/close. If it was attention-required,
    // emit a `resolved` record using the last-known state as the final.
    for (const [number, entry] of this.entries.entries()) {
      if (seenNumbers.has(number)) continue;
      if (entry.attentionRequired && this.seeded) {
        const attentionAt = entry.attentionRequiredAt ?? nowIso;
        const elapsedMs = Math.max(0, now.getTime() - new Date(attentionAt).getTime());
        const record: PrDecisionRecord = {
          ts: nowIso,
          pr: number,
          action: 'resolved',
          finalState: entry.lastState,
          attentionRequiredAt: attentionAt,
          resolvedAt: nowIso,
          elapsedMs,
        };
        emitted.push(record);
        writer(record, this.opts);
      }
      this.entries.delete(number);
    }

    this.seeded = true;
    return emitted;
  }

  hasSeeded(): boolean {
    return this.seeded;
  }
}
