/**
 * Schedule-aware dispatch decision per RFC §14.3. Implements the four schedule modes
 * (now, off-peak, quota-permitting, defer-if-low-priority) on top of the
 * SubscriptionLedger admission decision.
 */

import { isOffPeakAt, nextOffPeakStart } from './off-peak.js';
import type { SubscriptionLedger } from './ledger.js';
import type {
  AdmissionDecision,
  LedgerKey,
  Schedule,
  SubscriptionPlan,
  TokenEstimate,
} from './types.js';

export type ScheduleDecision =
  | { kind: 'dispatch-now'; reason: string }
  | { kind: 'wait-until'; until: Date; reason: string }
  | { kind: 'requeue'; reason: string }
  | { kind: 'denied'; reason: string; blockedBy: string };

export interface ScheduleEvaluationContext {
  ledger: SubscriptionLedger;
  ledgerKey: LedgerKey;
  plan: SubscriptionPlan;
  estimate: TokenEstimate;
  /**
   * PPA score in [0,1]. Used by 'defer-if-low-priority' to decide whether to
   * dispatch immediately (top quartile or > 30% headroom in the window).
   */
  ppaScore?: number;
  queueScores?: number[];
  /** Maximum time to wait for the next off-peak window. ISO 8601 duration. */
  offPeakMaxWait?: string;
  now?: () => Date;
}

const DEFAULT_OFF_PEAK_MAX_WAIT_MS = 8 * 60 * 60 * 1000; // PT8H

export function evaluateSchedule(
  schedule: Schedule,
  ctx: ScheduleEvaluationContext,
): ScheduleDecision {
  const now = ctx.now ?? (() => new Date());
  const admission: AdmissionDecision = ctx.ledger.admit(ctx.ledgerKey, ctx.plan, ctx.estimate);

  switch (schedule) {
    case 'now':
      return interpretNow(admission);

    case 'off-peak':
      return interpretOffPeak(admission, ctx, now());

    case 'quota-permitting':
      return interpretQuotaPermitting(admission);

    case 'defer-if-low-priority':
      return interpretDeferIfLowPriority(admission, ctx, now());

    default:
      throw new Error(`Unknown schedule mode: ${String(schedule)}`);
  }
}

function interpretNow(admission: AdmissionDecision): ScheduleDecision {
  if (admission.kind === 'yes') return { kind: 'dispatch-now', reason: admission.reason };
  if (admission.kind === 'wait-until')
    return { kind: 'wait-until', until: admission.until, reason: admission.reason };
  return { kind: 'denied', reason: admission.reason, blockedBy: admission.blockedBy };
}

function interpretOffPeak(
  admission: AdmissionDecision,
  ctx: ScheduleEvaluationContext,
  now: Date,
): ScheduleDecision {
  if (!ctx.plan.offPeak || !ctx.plan.offPeak.enabled) {
    // No off-peak configured; behave as 'now'.
    return interpretNow(admission);
  }
  if (isOffPeakAt(ctx.plan.offPeak, now)) {
    return interpretNow(admission);
  }
  const next = nextOffPeakStart(ctx.plan.offPeak, now);
  if (!next) return interpretNow(admission);
  const maxWaitMs = parseDurationMs(ctx.offPeakMaxWait) ?? DEFAULT_OFF_PEAK_MAX_WAIT_MS;
  if (next.getTime() - now.getTime() <= maxWaitMs) {
    return {
      kind: 'wait-until',
      until: next,
      reason: 'next off-peak window within offPeakMaxWait',
    };
  }
  // Off-peak too far in the future; fall through to dispatch-on-peak with a warning.
  return { kind: 'dispatch-now', reason: 'OffPeakDeferralExceeded — dispatching on-peak' };
}

function interpretQuotaPermitting(admission: AdmissionDecision): ScheduleDecision {
  if (admission.kind === 'yes') return { kind: 'dispatch-now', reason: admission.reason };
  return { kind: 'requeue', reason: admission.reason };
}

function interpretDeferIfLowPriority(
  admission: AdmissionDecision,
  ctx: ScheduleEvaluationContext,
  now: Date,
): ScheduleDecision {
  // Top quartile of queue → dispatch immediately.
  const isTopQuartile =
    ctx.ppaScore !== undefined && ctx.queueScores && isInTopQuartile(ctx.ppaScore, ctx.queueScores);
  if (isTopQuartile) return interpretNow(admission);

  // >30% window headroom → dispatch immediately.
  const ws = ctx.ledger.windowState(ctx.ledgerKey, ctx.plan);
  const headroomFraction = 1 - ws.utilizationFraction;
  if (headroomFraction > 0.3) return interpretNow(admission);

  // Otherwise behave as 'off-peak'.
  return interpretOffPeak(admission, ctx, now);
}

function isInTopQuartile(score: number, queueScores: number[]): boolean {
  if (queueScores.length === 0) return true;
  const sorted = [...queueScores].sort((a, b) => b - a);
  const cutoff = sorted[Math.floor(sorted.length / 4)] ?? sorted[0];
  return score >= cutoff;
}

function parseDurationMs(duration: string | undefined): number | null {
  if (!duration) return null;
  const m = duration.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!m) return null;
  const days = Number.parseInt(m[1] ?? '0', 10);
  const hours = Number.parseInt(m[2] ?? '0', 10);
  const minutes = Number.parseInt(m[3] ?? '0', 10);
  return ((days * 24 + hours) * 60 + minutes) * 60 * 1000;
}
