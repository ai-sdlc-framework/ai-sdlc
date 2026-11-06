import { describe, it, expect } from 'vitest';
import { isOffPeakAt, nextOffPeakStart, freshnessLevel, ageInDays } from './off-peak.js';
import { CalibrationStore, COLD_START_DEFAULT } from './calibration.js';
import { analyzeTier } from './tier-analysis.js';
import {
  DEFAULT_TENANT,
  type LedgerKey,
  type SubscriptionPlan,
  type TokenEstimate,
} from './types.js';

const samplePlan: SubscriptionPlan = {
  name: 'claude-code-max-5x',
  harness: 'claude-code',
  billingMode: 'session-window',
  windowDuration: 'PT5H',
  windowQuotaTokens: 1_000_000,
  pacingTarget: 0.85,
  hardCap: 0.95,
  quotaSource: 'self-tracked',
  offPeak: {
    enabled: true,
    multiplier: 2,
    schedule: [{ tz: 'America/Los_Angeles', hours: '22-06' }],
    lastVerified: '2026-04-15',
  },
};

const sampleKey: LedgerKey = {
  harness: 'claude-code',
  accountId: 'a3f2c891',
  tenant: DEFAULT_TENANT,
};

// In-memory IO stub so tests don't touch disk.
function memoryIO() {
  const store = new Map<string, string>();
  return {
    read: async (p: string) => store.get(p) ?? null,
    write: async (p: string, c: string) => {
      store.set(p, c);
    },
    store,
  };
}

describe('off-peak evaluation', () => {
  it('isOffPeakAt returns true within a wrapping range (22-06)', () => {
    // 23:00 PT on a Wednesday in 2026
    const at = new Date('2026-04-08T06:00:00Z'); // 23:00 Apr 7 PT (DST)
    expect(isOffPeakAt(samplePlan.offPeak!, at)).toBe(true);
  });

  it('isOffPeakAt returns false at 12:00 PT', () => {
    const at = new Date('2026-04-08T19:00:00Z'); // 12:00 PT
    expect(isOffPeakAt(samplePlan.offPeak!, at)).toBe(false);
  });

  it('returns false when off-peak is disabled', () => {
    const disabled = { ...samplePlan.offPeak!, enabled: false };
    expect(isOffPeakAt(disabled, new Date('2026-04-08T06:00:00Z'))).toBe(false);
  });

  it('day-of-week filter limits to specified days', () => {
    const sched = {
      enabled: true,
      multiplier: 2,
      schedule: [{ tz: 'America/Los_Angeles', hours: '0-23', daysOfWeek: 'Sat,Sun' }],
    };
    // 2026-04-08 is a Wednesday in PT
    expect(isOffPeakAt(sched, new Date('2026-04-08T19:00:00Z'))).toBe(false);
    // 2026-04-04 is a Saturday in PT
    expect(isOffPeakAt(sched, new Date('2026-04-04T19:00:00Z'))).toBe(true);
  });

  it('nextOffPeakStart returns a Date in the future when off-peak is configured', () => {
    const from = new Date('2026-04-08T19:00:00Z'); // 12:00 PT (peak)
    const next = nextOffPeakStart(samplePlan.offPeak!, from);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });

  it('ageInDays handles missing date as Infinity', () => {
    expect(ageInDays(undefined)).toBe(Infinity);
    expect(ageInDays('not-a-date')).toBe(Infinity);
  });

  it('freshnessLevel: ≤30 fresh, 30-90 advisory, >90 error', () => {
    const now = new Date('2026-05-01T00:00:00Z');
    expect(freshnessLevel('2026-04-15', now)).toBe('fresh');
    expect(freshnessLevel('2026-03-01', now)).toBe('advisory');
    expect(freshnessLevel('2025-12-01', now)).toBe('error');
    expect(freshnessLevel(undefined, now)).toBe('error');
  });
});

describe('CalibrationStore', () => {
  it('returns cold-start default + MissingEstimate when no estimate declared and no history', async () => {
    const io = memoryIO();
    const store = new CalibrationStore('/tmp/artifacts', { io });
    await store.load();
    const r = store.resolveEstimate('triage', undefined);
    expect(r.estimate).toEqual(COLD_START_DEFAULT);
    expect(r.events.some((e) => e.type === 'MissingEstimate')).toBe(true);
  });

  it('returns declared estimate when no rolling history exists', async () => {
    const io = memoryIO();
    const store = new CalibrationStore('/tmp/artifacts', { io });
    await store.load();
    const declared: TokenEstimate = { input: 5000, output: 1000 };
    const r = store.resolveEstimate('plan', declared);
    expect(r.estimate).toEqual(declared);
  });

  it('returns rolling estimate after a stage has run', async () => {
    const io = memoryIO();
    const store = new CalibrationStore('/tmp/artifacts', { io });
    await store.load();
    await store.record('plan', { input: 10_000, output: 2000 }, undefined);
    const r = store.resolveEstimate('plan', undefined);
    expect(r.estimate.input).toBe(10_000);
  });

  it('emits EstimateBootstrapped on first run when no estimate declared', async () => {
    const io = memoryIO();
    const store = new CalibrationStore('/tmp/artifacts', { io });
    await store.load();
    const events = await store.record('triage', { input: 50_000, output: 8000 }, undefined);
    expect(events.some((e) => e.type === 'EstimateBootstrapped')).toBe(true);
  });

  it('emits EstimateVariance when actual deviates by >50% from declared', async () => {
    const io = memoryIO();
    const store = new CalibrationStore('/tmp/artifacts', { io });
    await store.load();
    const events = await store.record(
      'plan',
      { input: 200_000, output: 50_000 },
      { input: 50_000, output: 10_000 },
    );
    expect(events.some((e) => e.type === 'EstimateVariance')).toBe(true);
  });

  it('frozen estimate is not superseded by rolling', async () => {
    const io = memoryIO();
    const store = new CalibrationStore('/tmp/artifacts', { io });
    await store.load();
    await store.record('fix-pr', { input: 200_000, output: 30_000 }, undefined);
    const frozen: TokenEstimate = { input: 100_000, output: 20_000, frozen: true };
    const r = store.resolveEstimate('fix-pr', frozen);
    expect(r.estimate).toEqual(frozen);
  });
});

describe('analyzeTier', () => {
  const proPlan: SubscriptionPlan = {
    name: 'claude-code-pro',
    harness: 'claude-code',
    billingMode: 'session-window',
    windowDuration: 'PT5H',
    windowQuotaTokens: 200_000,
    pacingTarget: 0.85,
    hardCap: 0.95,
    quotaSource: 'self-tracked',
  };
  const max5x: SubscriptionPlan = {
    ...proPlan,
    name: 'claude-code-max-5x',
    windowQuotaTokens: 1_000_000,
  };

  it('recommends an upgrade when contention is high', () => {
    const result = analyzeTier({
      billingPeriod: '2026-W17',
      ledgerKey: sampleKey,
      currentPlan: proPlan,
      contentionEvents: Array.from({ length: 25 }, (_, i) => ({
        timestamp: `2026-04-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
        contentionDurationMs: 60 * 60 * 1000,
      })),
      issuesDeferredOffPeak: 5,
      issuesBlockedOnHardCap: 3,
      candidates: [proPlan, max5x],
    });
    expect(result.recommendedPlan).toBe('claude-code-max-5x');
    expect(result.confidence).toBe('high');
  });

  it('keeps current plan when no contention', () => {
    const result = analyzeTier({
      billingPeriod: '2026-W17',
      ledgerKey: sampleKey,
      currentPlan: proPlan,
      contentionEvents: [],
      issuesDeferredOffPeak: 0,
      issuesBlockedOnHardCap: 0,
      candidates: [proPlan, max5x],
    });
    expect(result.recommendedPlan).toBe('claude-code-pro');
    expect(result.confidence).toBe('low');
  });
});
