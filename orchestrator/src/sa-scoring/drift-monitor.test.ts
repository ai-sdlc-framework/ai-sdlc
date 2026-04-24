import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { DesignSystemBinding } from '@ai-sdlc/reference';
import { StateStore } from '../state/store.js';
import {
  DEFAULT_CONSECUTIVE_WINDOWS,
  DEFAULT_MEAN_THRESHOLD,
  DEFAULT_STDDEV_THRESHOLD,
  DEFAULT_WINDOW_DAYS,
  computeTrend,
  computeWindowStats,
  describeDriftSource,
  detectSoulDrift,
  mean,
  stddev,
  type WindowStats,
} from './drift-monitor.js';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;
const NOW_MS = Date.parse('2026-04-24T00:00:00Z');
const ONE_DAY = 24 * 60 * 60 * 1000;

function makeDsb(): DesignSystemBinding {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignSystemBinding',
    metadata: { name: 'acme-ds' },
    spec: {
      stewardship: {
        designAuthority: { principals: ['design-lead'], scope: [] },
        engineeringAuthority: { principals: ['eng-lead'], scope: [] },
      },
      designToolAuthority: 'collaborative',
      tokens: {
        provider: 'p',
        format: 'w3c-dtcg',
        source: { repository: 'r' },
        versionPolicy: 'minor',
      },
      catalog: { provider: 'c' },
      compliance: { coverage: { minimum: 85 } },
    },
  };
}

describe('mean + stddev', () => {
  it('computes arithmetic mean', () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });

  it('computes population stddev', () => {
    // values: 0, 0, 0 → stddev 0
    expect(stddev([0, 0, 0])).toBe(0);
    // values: 0, 10 → stddev 5 (population)
    expect(stddev([0, 10])).toBeCloseTo(5, 6);
  });
});

describe('computeTrend', () => {
  const wsAt = (meanVal: number): WindowStats => ({
    count: 1,
    mean: meanVal,
    stddev: 0,
    structuralMean: 0,
    llmMean: 0,
    deterministicFlags: 0,
    windowStartMs: 0,
    windowEndMs: 0,
    violates: true,
  });

  it('stable when newest vs oldest are within 0.05', () => {
    expect(computeTrend([wsAt(0.6), wsAt(0.58), wsAt(0.56)])).toBe('stable');
  });

  it('increasing when newest > oldest by > 0.05', () => {
    expect(computeTrend([wsAt(0.7), wsAt(0.5), wsAt(0.4)])).toBe('increasing');
  });

  it('decreasing when newest < oldest by > 0.05', () => {
    expect(computeTrend([wsAt(0.3), wsAt(0.5), wsAt(0.7)])).toBe('decreasing');
  });
});

describe('describeDriftSource', () => {
  const mkWindow = (
    structuralMean: number,
    llmMean: number,
    deterministicFlags = 0,
  ): WindowStats => ({
    count: 1,
    mean: 0.3,
    stddev: 0,
    structuralMean,
    llmMean,
    deterministicFlags,
    windowStartMs: 0,
    windowEndMs: 0,
    violates: true,
  });

  it('identifies LLM-layer drift when LLM mean lags structural by > 0.15', () => {
    const d = describeDriftSource([mkWindow(0.7, 0.3)]);
    expect(d.note).toContain('LLM-layer drift');
    expect(d.structuralScoreMean).toBeCloseTo(0.7, 6);
    expect(d.llmScoreMean).toBeCloseTo(0.3, 6);
  });

  it('identifies structural drift when structural lags LLM by > 0.15', () => {
    const d = describeDriftSource([mkWindow(0.3, 0.7)]);
    expect(d.note).toContain('Structural drift');
  });

  it('flags hard-gated events in mixed drift', () => {
    const d = describeDriftSource([mkWindow(0.3, 0.3, 5)]);
    expect(d.note).toContain('hard-gated');
    expect(d.deterministicFlags).toBe(5);
  });

  it('defaults to uniform drift when layers are balanced', () => {
    const d = describeDriftSource([mkWindow(0.3, 0.3, 0)]);
    expect(d.note).toContain('Uniform drift');
  });
});

describe('computeWindowStats', () => {
  it('parses layer result JSON and computes means', () => {
    const stats = computeWindowStats(
      [
        {
          didName: 'd',
          issueNumber: 1,
          saDimension: 'SA-1',
          phase: '2b',
          compositeScore: 0.3,
          layer2ResultJson: JSON.stringify({ score: 0.5 }),
          layer3ResultJson: JSON.stringify({ domainIntent: 0.2 }),
          layer1ResultJson: JSON.stringify({ hardGated: true }),
          createdAt: new Date(NOW_MS).toISOString(),
        },
      ],
      0,
      NOW_MS,
      DEFAULT_MEAN_THRESHOLD,
      DEFAULT_STDDEV_THRESHOLD,
    );
    expect(stats.count).toBe(1);
    expect(stats.mean).toBe(0.3);
    expect(stats.structuralMean).toBe(0.5);
    expect(stats.llmMean).toBe(0.2);
    expect(stats.deterministicFlags).toBe(1);
    expect(stats.violates).toBe(true); // mean 0.3 < 0.4
  });

  it('does NOT violate when count is 0', () => {
    const stats = computeWindowStats([], 0, NOW_MS, 0.4, 0.15);
    expect(stats.violates).toBe(false);
  });

  it('violates on stddev > threshold even with mean in range', () => {
    const stats = computeWindowStats(
      [
        {
          didName: 'd',
          issueNumber: 1,
          saDimension: 'SA-1',
          phase: '2b',
          compositeScore: 0.1,
        },
        {
          didName: 'd',
          issueNumber: 2,
          saDimension: 'SA-1',
          phase: '2b',
          compositeScore: 0.9,
        },
      ],
      0,
      NOW_MS,
      0.4,
      0.15,
    );
    expect(stats.mean).toBeCloseTo(0.5, 6);
    expect(stats.stddev).toBeCloseTo(0.4, 6);
    expect(stats.violates).toBe(true);
  });
});

describe('detectSoulDrift (AC #1, #2, #4)', () => {
  let db: InstanceType<typeof Database>;
  let store: StateStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = StateStore.open(db);
  });

  afterEach(() => {
    store.close();
  });

  function seedScoringEvents(opts: {
    dimension: 'SA-1' | 'SA-2';
    daysAgo: number;
    compositeScore: number;
    structural?: number;
    llm?: number;
    hardGated?: boolean;
  }): void {
    db.prepare(
      `INSERT INTO did_scoring_events (did_name, issue_number, sa_dimension, phase, layer1_result_json, layer2_result_json, layer3_result_json, composite_score, phase_weights_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'acme',
      1,
      opts.dimension,
      '2b',
      JSON.stringify({ hardGated: opts.hardGated ?? false }),
      opts.structural !== undefined ? JSON.stringify({ score: opts.structural }) : null,
      opts.llm !== undefined ? JSON.stringify({ domainIntent: opts.llm }) : null,
      opts.compositeScore,
      JSON.stringify({ wStructural: 0.35, wLlm: 0.65 }),
      new Date(NOW_MS - opts.daysAgo * ONE_DAY).toISOString(),
    );
  }

  it('AC #1: 3 consecutive 30-day windows with mean < 0.4 fires exactly once', () => {
    // Seed 3 windows: 0-30, 30-60, 60-90 days ago — all with mean ~0.3.
    for (let window = 0; window < 3; window++) {
      for (let i = 0; i < 5; i++) {
        seedScoringEvents({
          dimension: 'SA-1',
          daysAgo: window * 30 + i + 1,
          compositeScore: 0.3,
          structural: 0.3,
          llm: 0.3,
        });
      }
    }
    const event = detectSoulDrift('SA-1', {
      stateStore: store,
      now: () => NOW_MS,
    });
    expect(event).toBeDefined();
    expect(event!.dimension).toBe('SA-1');
    expect(event!.sprintsInViolation).toBe(DEFAULT_CONSECUTIVE_WINDOWS);
    expect(event!.rollingMean).toBeCloseTo(0.3, 6);
  });

  it('does NOT fire when only 2 of 3 windows violate', () => {
    // 2 windows bad, newest window healthy
    for (let i = 0; i < 5; i++) {
      seedScoringEvents({
        dimension: 'SA-1',
        daysAgo: i + 1,
        compositeScore: 0.8,
        structural: 0.8,
        llm: 0.8,
      });
    }
    for (let window = 1; window < 3; window++) {
      for (let i = 0; i < 5; i++) {
        seedScoringEvents({
          dimension: 'SA-1',
          daysAgo: window * 30 + i + 1,
          compositeScore: 0.3,
          structural: 0.3,
          llm: 0.3,
        });
      }
    }
    const event = detectSoulDrift('SA-1', {
      stateStore: store,
      now: () => NOW_MS,
    });
    expect(event).toBeUndefined();
  });

  it('AC #1: hysteresis prevents re-fire within recovery window', () => {
    for (let window = 0; window < 3; window++) {
      for (let i = 0; i < 5; i++) {
        seedScoringEvents({
          dimension: 'SA-1',
          daysAgo: window * 30 + i + 1,
          compositeScore: 0.3,
        });
      }
    }
    // Last triggered 1 day ago — within 7d recovery.
    const event = detectSoulDrift('SA-1', {
      stateStore: store,
      now: () => NOW_MS,
      getLastTriggerAt: () => new Date(NOW_MS - ONE_DAY).toISOString(),
    });
    expect(event).toBeUndefined();
  });

  it('re-fires after recovery window elapses', () => {
    for (let window = 0; window < 3; window++) {
      for (let i = 0; i < 5; i++) {
        seedScoringEvents({
          dimension: 'SA-1',
          daysAgo: window * 30 + i + 1,
          compositeScore: 0.3,
        });
      }
    }
    const event = detectSoulDrift('SA-1', {
      stateStore: store,
      now: () => NOW_MS,
      getLastTriggerAt: () => new Date(NOW_MS - 10 * ONE_DAY).toISOString(),
    });
    expect(event).toBeDefined();
  });

  it('AC #2: driftSource separates structural vs LLM means', () => {
    // High structural, low LLM → LLM-layer drift
    for (let window = 0; window < 3; window++) {
      for (let i = 0; i < 5; i++) {
        seedScoringEvents({
          dimension: 'SA-1',
          daysAgo: window * 30 + i + 1,
          compositeScore: 0.3,
          structural: 0.6,
          llm: 0.2,
        });
      }
    }
    const event = detectSoulDrift('SA-1', {
      stateStore: store,
      now: () => NOW_MS,
    });
    expect(event).toBeDefined();
    expect(event!.driftSource.structuralScoreMean).toBeGreaterThan(event!.driftSource.llmScoreMean);
    expect(event!.driftSource.note).toContain('LLM-layer drift');
  });

  it('AC #4: notifiedPrincipals union of design + engineering authorities', () => {
    for (let window = 0; window < 3; window++) {
      for (let i = 0; i < 5; i++) {
        seedScoringEvents({
          dimension: 'SA-1',
          daysAgo: window * 30 + i + 1,
          compositeScore: 0.3,
        });
      }
    }
    const event = detectSoulDrift('SA-1', {
      stateStore: store,
      now: () => NOW_MS,
      getBinding: () => makeDsb(),
    });
    expect(event!.notifiedPrincipals.sort()).toEqual(['design-lead', 'eng-lead']);
  });

  it('does NOT fire when no events exist', () => {
    expect(
      detectSoulDrift('SA-1', {
        stateStore: store,
        now: () => NOW_MS,
      }),
    ).toBeUndefined();
  });

  it('defaults match spec thresholds', () => {
    expect(DEFAULT_MEAN_THRESHOLD).toBe(0.4);
    expect(DEFAULT_STDDEV_THRESHOLD).toBe(0.15);
    expect(DEFAULT_CONSECUTIVE_WINDOWS).toBe(3);
    expect(DEFAULT_WINDOW_DAYS).toBe(30);
  });
});
