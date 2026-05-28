import { ManualSignalIncomplete, ManualSignalRateLimitExceeded } from '../errors.js';
import type { RawSignal, SignalSourceAdapter } from '../types.js';

/**
 * RFC-0030 OQ-13.4 v0.3 re-walkthrough default cap. 10 manual signals per
 * operator per UTC day. Reasoning: a single operator processing >10
 * high-signal conversations per day for the framework specifically is
 * exceptional; 10/day allows ~50/week (sales-team conference-week scenarios);
 * per-org override via `manualEntry.dailyCapPerOperator` for genuinely
 * high-throughput contexts. Anti-gaming guardrail: makes sustained gaming
 * require sustained effort while not blocking legitimate use.
 */
export const DEFAULT_MANUAL_DAILY_CAP_PER_OPERATOR = 10;

export type ManualSignalInput = Omit<RawSignal, 'attestedAt'> & { attestedAt?: Date };

export interface ManualSignalSourceAdapterOptions {
  /**
   * Per-operator daily cap (UTC day buckets). When exceeded, `addSignal`
   * raises `ManualSignalRateLimitExceeded` so the registry can surface
   * `Decision: manual-signal-rate-limit-exceeded`. Defaults to
   * `DEFAULT_MANUAL_DAILY_CAP_PER_OPERATOR` (10). Setting to `0` or a negative
   * value DISABLES rate limiting (operator opt-out).
   */
  dailyCapPerOperator?: number;
  /**
   * Seed entries pre-populating the adapter. Useful for tests; production
   * adapters typically construct empty then `addSignal()` per CLI submit.
   */
  initialSignals?: ManualSignalInput[];
}

export class ManualSignalSourceAdapter implements SignalSourceAdapter {
  readonly name = 'signal-source-manual';
  readonly defaultTier = 1;
  /** Manual entry never requires OAuth (no upstream service). */
  readonly requiresOAuth = false;

  private readonly signals: RawSignal[] = [];
  private readonly dailyCapPerOperator: number;

  /**
   * Per-operator UTC-day bucket counter:
   *   key = `${attestedBy}|${YYYY-MM-DD}` (UTC date)
   *   val = count of manual signals accepted in that bucket
   *
   * Rebuilt lazily — addSignal increments + reads from this map; the bucket
   * key derivation uses the signal's `attestedAt` (auto-filled to `now` when
   * omitted, so the count always lands in the correct UTC day).
   */
  private readonly perOperatorPerDayCount = new Map<string, number>();

  constructor(
    initialSignalsOrOptions: ManualSignalInput[] | ManualSignalSourceAdapterOptions = [],
  ) {
    let initial: ManualSignalInput[];
    if (Array.isArray(initialSignalsOrOptions)) {
      // Legacy ctor signature: `new ManualSignalSourceAdapter([...])`
      initial = initialSignalsOrOptions;
      this.dailyCapPerOperator = DEFAULT_MANUAL_DAILY_CAP_PER_OPERATOR;
    } else {
      initial = initialSignalsOrOptions.initialSignals ?? [];
      this.dailyCapPerOperator =
        initialSignalsOrOptions.dailyCapPerOperator ?? DEFAULT_MANUAL_DAILY_CAP_PER_OPERATOR;
    }
    for (const signal of initial) this.addSignal(signal);
  }

  /** Effective per-operator daily cap (post-defaulting). Test helper. */
  get effectiveDailyCap(): number {
    return this.dailyCapPerOperator;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Add a manual signal with attestation + rate-limit enforcement.
   *
   * Order of validation:
   *   1. `attestedBy` required → `ManualSignalIncomplete` (preserved from v0.2).
   *   2. `attestedAt` defaulted to `now`.
   *   3. Per-operator UTC-day cap → `ManualSignalRateLimitExceeded` when
   *      `count(attestedBy, utcDate(attestedAt)) >= dailyCapPerOperator`.
   *      (Skipped when `dailyCapPerOperator <= 0`.)
   *
   * Returns the persisted RawSignal (with `attestedAt` filled + `evidenceUrl`
   * preserved verbatim) when accepted.
   */
  addSignal(input: ManualSignalInput, now: Date = new Date()): RawSignal {
    if (!input.attestedBy) {
      throw new ManualSignalIncomplete(input.sourceId);
    }
    const attestedAt = input.attestedAt ?? now;
    const utcDate = utcDateKey(attestedAt);
    const bucketKey = `${input.attestedBy}|${utcDate}`;

    if (this.dailyCapPerOperator > 0) {
      const currentCount = this.perOperatorPerDayCount.get(bucketKey) ?? 0;
      if (currentCount >= this.dailyCapPerOperator) {
        throw new ManualSignalRateLimitExceeded(
          input.attestedBy,
          this.dailyCapPerOperator,
          utcDate,
          input.sourceId,
        );
      }
      this.perOperatorPerDayCount.set(bucketKey, currentCount + 1);
    }

    const signal: RawSignal = {
      ...input,
      attestedAt,
    };
    this.signals.push(signal);
    return signal;
  }

  async fetchSignals(since: Date): Promise<RawSignal[]> {
    return this.signals.filter((signal) => signal.sourceTimestamp >= since);
  }

  /**
   * Test helper: current per-operator UTC-day count for the given attestedBy.
   * Exposed so unit tests can assert rate-limit bookkeeping without reaching
   * into the private map.
   */
  countForOperatorOnDate(attestedBy: string, utcDateIso: string): number {
    return this.perOperatorPerDayCount.get(`${attestedBy}|${utcDateIso}`) ?? 0;
  }
}

/**
 * UTC date key in `YYYY-MM-DD` form. Hoisted so the manual-share metric
 * helper (see `manual-share-metric.ts`) can use the same bucketing rule.
 */
export function utcDateKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
