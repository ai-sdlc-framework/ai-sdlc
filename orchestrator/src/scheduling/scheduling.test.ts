import { describe, it, expect } from 'vitest';
import { isOffPeakAt, nextOffPeakStart, freshnessLevel, ageInDays } from './off-peak.js';
import { SubscriptionLedger, validateTenantShares } from './ledger.js';
import { evaluateSchedule } from './schedule-decision.js';
import { CalibrationStore, COLD_START_DEFAULT } from './calibration.js';
import { buildBurnDownReport } from './burn-down.js';
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

describe('SubscriptionLedger', () => {
  it('admit returns yes when consumption is under hardCap', async () => {
    const io = memoryIO();
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io });
    await ledger.load(sampleKey, samplePlan);
    const decision = ledger.admit(sampleKey, samplePlan, { input: 1000, output: 100 });
    expect(decision.kind).toBe('yes');
  });

  it('admit returns no when consumption would exceed hardCap', async () => {
    const io = memoryIO();
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io });
    await ledger.load(sampleKey, samplePlan);
    // Consume close to the cap.
    for (let i = 0; i < 10; i++) {
      await ledger.record(sampleKey, samplePlan, { input: 90_000, output: 10_000 });
    }
    const decision = ledger.admit(sampleKey, samplePlan, { input: 100_000, output: 50_000 });
    expect(decision.kind).toBe('no');
    if (decision.kind === 'no') expect(decision.blockedBy).toBe('hardCap');
  });

  it('record applies off-peak multiplier (effective consumption divided)', async () => {
    const io = memoryIO();
    // Off-peak time: 23:00 PT
    const offPeakNow = () => new Date('2026-04-08T06:00:00Z');
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io, now: offPeakNow });
    await ledger.load(sampleKey, samplePlan);
    await ledger.record(sampleKey, samplePlan, { input: 100_000, output: 100_000 });
    const ws = ledger.windowState(sampleKey, samplePlan);
    // 200_000 / 2.0 multiplier = 100_000 effective
    expect(ws.consumedTokens).toBe(100_000);
  });

  it('persists to keyed file path', async () => {
    const io = memoryIO();
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io });
    await ledger.load(sampleKey, samplePlan);
    await ledger.record(sampleKey, samplePlan, { input: 100, output: 50 });
    const expectedPath = '/tmp/artifacts/_ledger/claude-code-a3f2c891-__default__.json';
    expect(io.store.get(expectedPath)).toBeDefined();
  });

  it('pay-per-token plan always admits', async () => {
    const ppt: SubscriptionPlan = {
      name: 'pay-per-token',
      harness: 'claude-code',
      billingMode: 'pay-per-token',
      pacingTarget: 1,
      hardCap: 1,
      quotaSource: 'self-tracked',
    };
    const io = memoryIO();
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io });
    await ledger.load(sampleKey, ppt);
    const d = ledger.admit(sampleKey, ppt, { input: 9_999_999, output: 9_999_999 });
    expect(d.kind).toBe('yes');
  });
});

describe('validateTenantShares', () => {
  it('passes when no tenants are declared', () => {
    expect(
      validateTenantShares([
        { name: 'p1', harness: 'claude-code', accountId: 'a1' },
        { name: 'p2', harness: 'claude-code', accountId: 'a1' },
      ]),
    ).toEqual([]);
  });

  it('passes when tenant shares sum to 1.0', () => {
    expect(
      validateTenantShares([
        {
          name: 'p1',
          harness: 'claude-code',
          accountId: 'a1',
          tenant: 't1',
          tenantQuotaShare: 0.6,
        },
        {
          name: 'p2',
          harness: 'claude-code',
          accountId: 'a1',
          tenant: 't2',
          tenantQuotaShare: 0.4,
        },
      ]),
    ).toEqual([]);
  });

  it('fails when shares sum != 1.0', () => {
    const failures = validateTenantShares([
      { name: 'p1', harness: 'claude-code', accountId: 'a1', tenant: 't1', tenantQuotaShare: 0.6 },
      { name: 'p2', harness: 'claude-code', accountId: 'a1', tenant: 't2', tenantQuotaShare: 0.5 },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0].sumOfShares).toBeCloseTo(1.1);
  });

  it('fails on mixed declared/undeclared tenants on the same account', () => {
    const failures = validateTenantShares([
      { name: 'p1', harness: 'claude-code', accountId: 'a1', tenant: 't1', tenantQuotaShare: 1.0 },
      { name: 'p2', harness: 'claude-code', accountId: 'a1' },
    ]);
    expect(failures).toHaveLength(1);
  });

  it('groups separately per (harness, accountId)', () => {
    const failures = validateTenantShares([
      { name: 'p1', harness: 'claude-code', accountId: 'a1', tenant: 't1', tenantQuotaShare: 1.0 },
      { name: 'p2', harness: 'codex', accountId: 'b2', tenant: 't1', tenantQuotaShare: 1.0 },
    ]);
    expect(failures).toEqual([]);
  });
});

describe('evaluateSchedule', () => {
  it('schedule: now dispatches when admission yes', async () => {
    const io = memoryIO();
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io });
    await ledger.load(sampleKey, samplePlan);
    const d = evaluateSchedule('now', {
      ledger,
      ledgerKey: sampleKey,
      plan: samplePlan,
      estimate: { input: 100, output: 50 },
    });
    expect(d.kind).toBe('dispatch-now');
  });

  it('schedule: off-peak waits when off-peak window is within offPeakMaxWait', async () => {
    const io = memoryIO();
    // 21:00 PT (04:00 UTC) — peak, but only 1 hour before 22:00 PT off-peak start.
    const peakAlmostOffPeak = new Date('2026-04-08T04:00:00Z');
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io, now: () => peakAlmostOffPeak });
    await ledger.load(sampleKey, samplePlan);
    const d = evaluateSchedule('off-peak', {
      ledger,
      ledgerKey: sampleKey,
      plan: samplePlan,
      estimate: { input: 100, output: 50 },
      now: () => peakAlmostOffPeak,
    });
    expect(d.kind).toBe('wait-until');
  });

  it('schedule: off-peak dispatches on-peak when next off-peak exceeds offPeakMaxWait', async () => {
    const io = memoryIO();
    // 12:00 PT — 10 hours before next off-peak, exceeding the 8h default max wait.
    const farFromOffPeak = new Date('2026-04-08T19:00:00Z');
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io, now: () => farFromOffPeak });
    await ledger.load(sampleKey, samplePlan);
    const d = evaluateSchedule('off-peak', {
      ledger,
      ledgerKey: sampleKey,
      plan: samplePlan,
      estimate: { input: 100, output: 50 },
      now: () => farFromOffPeak,
    });
    expect(d.kind).toBe('dispatch-now');
    expect(d.reason).toMatch(/OffPeakDeferralExceeded/);
  });

  it('schedule: quota-permitting requeues when admission no', async () => {
    const io = memoryIO();
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io });
    await ledger.load(sampleKey, samplePlan);
    for (let i = 0; i < 10; i++) {
      await ledger.record(sampleKey, samplePlan, { input: 90_000, output: 10_000 });
    }
    const d = evaluateSchedule('quota-permitting', {
      ledger,
      ledgerKey: sampleKey,
      plan: samplePlan,
      estimate: { input: 200_000, output: 100_000 },
    });
    expect(d.kind).toBe('requeue');
  });

  it('schedule: defer-if-low-priority dispatches top-quartile work even with low headroom', async () => {
    const io = memoryIO();
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io });
    await ledger.load(sampleKey, samplePlan);
    // Consume enough that headroom is < 30%
    for (let i = 0; i < 7; i++) {
      await ledger.record(sampleKey, samplePlan, { input: 90_000, output: 10_000 });
    }
    const d = evaluateSchedule('defer-if-low-priority', {
      ledger,
      ledgerKey: sampleKey,
      plan: samplePlan,
      estimate: { input: 1000, output: 100 },
      ppaScore: 0.95,
      queueScores: [0.95, 0.5, 0.4, 0.3],
    });
    expect(d.kind).toBe('dispatch-now');
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

describe('buildBurnDownReport', () => {
  it('produces an under-pacing recommendation when projected < pacingTarget - 0.10', async () => {
    const io = memoryIO();
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io });
    await ledger.load(sampleKey, samplePlan);
    await ledger.record(sampleKey, samplePlan, { input: 50_000, output: 10_000 });
    const report = buildBurnDownReport({
      ledger,
      ledgerKey: sampleKey,
      plan: samplePlan,
      dollarsSpent: 0,
      shadowCostUsd: 5,
      queueDepth: 2,
      projectedUtilization: 0.5, // below 0.85 - 0.10 = 0.75
    });
    expect(report.recommendation).toBe('under-pacing');
    expect(report.subscriptionTokensConsumed).toBe(60_000);
  });

  it('produces an over-pacing recommendation when projected > pacingTarget + 0.05', async () => {
    const io = memoryIO();
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io });
    await ledger.load(sampleKey, samplePlan);
    const report = buildBurnDownReport({
      ledger,
      ledgerKey: sampleKey,
      plan: samplePlan,
      dollarsSpent: 0,
      shadowCostUsd: 0,
      queueDepth: 5,
      projectedUtilization: 0.99,
    });
    expect(report.recommendation).toBe('over-pacing');
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
