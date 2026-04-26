/**
 * Targeted coverage tests for scheduling paths flagged by codecov on PR #67.
 * Covers ledger edge cases (load with malformed/expired state, monthly-cap window),
 * burn-down recommendation thresholds, schedule-decision off-peak fall-through,
 * and calibration frozen + variance edge cases.
 */

import { describe, it, expect } from 'vitest';
import { SubscriptionLedger } from './ledger.js';
import { evaluateSchedule } from './schedule-decision.js';
import { CalibrationStore } from './calibration.js';
import { buildBurnDownReport } from './burn-down.js';
import { analyzeTier } from './tier-analysis.js';
import { DEFAULT_TENANT, type LedgerKey, type SubscriptionPlan } from './types.js';

const baseKey: LedgerKey = {
  harness: 'claude-code',
  accountId: 'a3f2c891',
  tenant: DEFAULT_TENANT,
};

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

const sessionPlan: SubscriptionPlan = {
  name: 'claude-code-max-5x',
  harness: 'claude-code',
  billingMode: 'session-window',
  windowDuration: 'PT5H',
  windowQuotaTokens: 1_000_000,
  pacingTarget: 0.85,
  hardCap: 0.95,
  quotaSource: 'self-tracked',
};

const monthlyPlan: SubscriptionPlan = {
  name: 'codex-pro',
  harness: 'codex',
  billingMode: 'monthly-cap',
  windowQuotaTokens: 5_000_000,
  pacingTarget: 0.85,
  hardCap: 0.95,
  quotaSource: 'self-tracked',
};

describe('SubscriptionLedger — gap coverage', () => {
  it('load resets when persisted state is malformed JSON', async () => {
    const io = memoryIO();
    const path = '/tmp/artifacts/_ledger/claude-code-a3f2c891-__default__.json';
    io.store.set(path, 'not-json');
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io });
    await ledger.load(baseKey, sessionPlan);
    const ws = ledger.windowState(baseKey, sessionPlan);
    expect(ws.consumedTokens).toBe(0);
  });

  it('load resets when persisted window has expired', async () => {
    const io = memoryIO();
    const longAgo = new Date('2020-01-01T00:00:00Z').toISOString();
    const path = '/tmp/artifacts/_ledger/claude-code-a3f2c891-__default__.json';
    io.store.set(path, JSON.stringify({ windowStart: longAgo, consumedTokens: 999 }));
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io });
    await ledger.load(baseKey, sessionPlan);
    expect(ledger.windowState(baseKey, sessionPlan).consumedTokens).toBe(0);
  });

  it('load reuses persisted state when window is still active', async () => {
    const io = memoryIO();
    const recent = new Date(Date.now() - 60_000).toISOString();
    const path = '/tmp/artifacts/_ledger/claude-code-a3f2c891-__default__.json';
    io.store.set(path, JSON.stringify({ windowStart: recent, consumedTokens: 12345 }));
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io });
    await ledger.load(baseKey, sessionPlan);
    expect(ledger.windowState(baseKey, sessionPlan).consumedTokens).toBe(12345);
  });

  it('windowState throws when key not loaded', () => {
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io: memoryIO() });
    expect(() => ledger.windowState(baseKey, sessionPlan)).toThrow(/not loaded/);
  });

  it('record throws when key not loaded', async () => {
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io: memoryIO() });
    await expect(ledger.record(baseKey, sessionPlan, { input: 1, output: 1 })).rejects.toThrow(
      /not loaded/,
    );
  });

  it('reset re-initializes the window', async () => {
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io: memoryIO() });
    await ledger.load(baseKey, sessionPlan);
    await ledger.record(baseKey, sessionPlan, { input: 100_000, output: 50_000 });
    expect(ledger.windowState(baseKey, sessionPlan).consumedTokens).toBeGreaterThan(0);
    ledger.reset(baseKey);
    expect(ledger.windowState(baseKey, sessionPlan).consumedTokens).toBe(0);
  });

  it('monthly-cap plan computes a month-boundary window end', async () => {
    const ledger = new SubscriptionLedger('/tmp/artifacts', {
      io: memoryIO(),
      now: () => new Date('2026-04-26T12:00:00Z'),
    });
    const codexKey: LedgerKey = { harness: 'codex', accountId: 'b1', tenant: DEFAULT_TENANT };
    await ledger.load(codexKey, monthlyPlan);
    const ws = ledger.windowState(codexKey, monthlyPlan);
    expect(ws.windowEnd.getMonth()).toBe(4); // May (next month from April=3)
  });

  it('isOffPeak returns false when plan has no offPeak config', async () => {
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io: memoryIO() });
    expect(ledger.isOffPeak(sessionPlan)).toBe(false);
  });

  it('keyToFilename truncates accountId to 8 chars', () => {
    const filename = SubscriptionLedger.keyToFilename({
      harness: 'claude-code',
      accountId: 'abcdef0123456789',
      tenant: 'mytenant',
    });
    expect(filename).toBe('claude-code-abcdef01-mytenant.json');
  });
});

describe('evaluateSchedule — gap coverage', () => {
  it('off-peak with no off-peak config behaves as now', async () => {
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io: memoryIO() });
    await ledger.load(baseKey, sessionPlan);
    const d = evaluateSchedule('off-peak', {
      ledger,
      ledgerKey: baseKey,
      plan: sessionPlan,
      estimate: { input: 100, output: 50 },
    });
    expect(d.kind).toBe('dispatch-now');
  });

  it('throws on unknown schedule mode', async () => {
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io: memoryIO() });
    await ledger.load(baseKey, sessionPlan);
    expect(() =>
      evaluateSchedule('mystery' as 'now', {
        ledger,
        ledgerKey: baseKey,
        plan: sessionPlan,
        estimate: { input: 100, output: 50 },
      }),
    ).toThrow();
  });

  it('defer-if-low-priority falls through to off-peak path when no top-quartile + low headroom', async () => {
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io: memoryIO() });
    await ledger.load(baseKey, sessionPlan);
    // Consume to lower headroom under 30%.
    for (let i = 0; i < 8; i++) {
      await ledger.record(baseKey, sessionPlan, { input: 90_000, output: 10_000 });
    }
    const d = evaluateSchedule('defer-if-low-priority', {
      ledger,
      ledgerKey: baseKey,
      plan: sessionPlan,
      estimate: { input: 100, output: 50 },
      ppaScore: 0.1,
      queueScores: [0.95, 0.9, 0.85, 0.1],
    });
    // No off-peak config on plan, so falls through to 'now' → dispatch-now.
    expect(d.kind).toBe('dispatch-now');
  });

  it('quota-permitting honors offPeakMaxWait override (parses ISO duration)', async () => {
    const planWithOff: SubscriptionPlan = {
      ...sessionPlan,
      offPeak: {
        enabled: true,
        multiplier: 2,
        schedule: [{ tz: 'America/Los_Angeles', hours: '22-06' }],
      },
    };
    const ledger = new SubscriptionLedger('/tmp/artifacts', {
      io: memoryIO(),
      now: () => new Date('2026-04-08T19:00:00Z'),
    });
    await ledger.load(baseKey, planWithOff);
    const d = evaluateSchedule('off-peak', {
      ledger,
      ledgerKey: baseKey,
      plan: planWithOff,
      estimate: { input: 100, output: 50 },
      now: () => new Date('2026-04-08T19:00:00Z'),
      offPeakMaxWait: 'P2D', // 48h — easily covers the 10h gap
    });
    expect(d.kind).toBe('wait-until');
  });
});

describe('CalibrationStore — gap coverage', () => {
  it('load resets when persisted JSON is malformed', async () => {
    const io = memoryIO();
    const path = '/tmp/artifacts/_ledger/stage-estimates.json';
    io.store.set(path, 'not-json');
    const store = new CalibrationStore('/tmp/artifacts', { io });
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.getRollingEstimate('any-stage')).toBeUndefined();
  });

  it('load is a no-op when no file exists', async () => {
    const store = new CalibrationStore('/tmp/artifacts', { io: memoryIO() });
    await expect(store.load()).resolves.toBeUndefined();
  });

  it('record without declared estimate but with existing history (not first run) does not emit Bootstrapped', async () => {
    const store = new CalibrationStore('/tmp/artifacts', { io: memoryIO() });
    await store.load();
    await store.record('plan', { input: 100, output: 50 }, undefined); // first run → bootstrap
    const events = await store.record('plan', { input: 110, output: 55 }, undefined); // second
    expect(events.some((e) => e.type === 'EstimateBootstrapped')).toBe(false);
  });

  it('record with declared estimate that matches actuals emits no variance', async () => {
    const store = new CalibrationStore('/tmp/artifacts', { io: memoryIO() });
    await store.load();
    const events = await store.record(
      'plan',
      { input: 50_000, output: 10_000 },
      { input: 50_000, output: 10_000 },
    );
    expect(events.some((e) => e.type === 'EstimateVariance')).toBe(false);
  });

  it('record with frozen declared estimate skips variance check', async () => {
    const store = new CalibrationStore('/tmp/artifacts', { io: memoryIO() });
    await store.load();
    const events = await store.record(
      'fix-pr',
      { input: 200_000, output: 50_000 },
      { input: 50_000, output: 10_000, frozen: true },
    );
    expect(events.some((e) => e.type === 'EstimateVariance')).toBe(false);
  });

  it('rolling estimate updates exponentially-weighted across many samples', async () => {
    const store = new CalibrationStore('/tmp/artifacts', { io: memoryIO() });
    await store.load();
    for (let i = 0; i < 25; i++) {
      await store.record('plan', { input: 1000 + i * 10, output: 100 }, undefined);
    }
    // Window cap = 20; exp-weighted mean should bias toward newer samples.
    const r = store.getRollingEstimate('plan');
    expect(r).toBeDefined();
    expect(r!.input).toBeGreaterThan(1100); // pulled toward later samples
  });
});

describe('buildBurnDownReport — gap coverage', () => {
  it('on-pace recommendation when projected is within bounds', async () => {
    const ledger = new SubscriptionLedger('/tmp/artifacts', { io: memoryIO() });
    await ledger.load(baseKey, sessionPlan);
    const report = buildBurnDownReport({
      ledger,
      ledgerKey: baseKey,
      plan: sessionPlan,
      dollarsSpent: 0,
      shadowCostUsd: 0,
      queueDepth: 1,
      projectedUtilization: 0.85,
    });
    expect(report.recommendation).toBe('on-pace');
  });

  it('linearProjection handles freshly-started window (elapsed near 0) without dividing by zero', async () => {
    const fixedNow = new Date('2026-04-26T12:00:00.000Z');
    const ledger = new SubscriptionLedger('/tmp/artifacts', {
      io: memoryIO(),
      now: () => fixedNow,
    });
    await ledger.load(baseKey, sessionPlan);
    const report = buildBurnDownReport({
      ledger,
      ledgerKey: baseKey,
      plan: sessionPlan,
      dollarsSpent: 0,
      shadowCostUsd: 0,
      queueDepth: 0,
      now: () => fixedNow,
    });
    expect(Number.isFinite(report.projectedUtilization)).toBe(true);
  });
});

describe('analyzeTier — gap coverage', () => {
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

  it('low-confidence (< 5 events) keeps current plan even with contention', () => {
    const r = analyzeTier({
      billingPeriod: '2026-W17',
      ledgerKey: baseKey,
      currentPlan: proPlan,
      contentionEvents: [{ timestamp: '2026-04-26T12:00:00Z', contentionDurationMs: 60_000 }],
      issuesDeferredOffPeak: 0,
      issuesBlockedOnHardCap: 0,
      candidates: [proPlan],
    });
    expect(r.confidence).toBe('low');
    expect(r.recommendedPlan).toBe(proPlan.name);
  });

  it('medium-confidence triggers upgrade recommendation when alternatives exist', () => {
    const max5x: SubscriptionPlan = {
      ...proPlan,
      name: 'claude-code-max-5x',
      windowQuotaTokens: 1_000_000,
    };
    const r = analyzeTier({
      billingPeriod: '2026-W17',
      ledgerKey: baseKey,
      currentPlan: proPlan,
      contentionEvents: Array.from({ length: 10 }, (_, i) => ({
        timestamp: `2026-04-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
        contentionDurationMs: 30 * 60 * 1000,
      })),
      issuesDeferredOffPeak: 2,
      issuesBlockedOnHardCap: 1,
      candidates: [proPlan, max5x],
    });
    expect(r.confidence).toBe('medium');
    expect(r.recommendedPlan).toBe('claude-code-max-5x');
  });
});
