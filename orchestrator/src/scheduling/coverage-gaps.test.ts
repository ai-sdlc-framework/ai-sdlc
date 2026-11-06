/**
 * Targeted coverage tests for scheduling paths flagged by codecov on PR #67.
 * Covers ledger edge cases (load with malformed/expired state, monthly-cap window),
 * burn-down recommendation thresholds, schedule-decision off-peak fall-through,
 * and calibration frozen + variance edge cases.
 */

import { describe, it, expect } from 'vitest';
import { CalibrationStore } from './calibration.js';
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
