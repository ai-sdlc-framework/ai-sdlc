import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { DesignSystemBinding } from '@ai-sdlc/reference';
import { StateStore } from './state/store.js';
import {
  analyzeTrend,
  detectDesignQualityTrendDegrading,
  evaluateCiPassRate,
  evaluateReviewRejectionRate,
  evaluateTokenComplianceTrend,
  splitHistoryByWindow,
  DEFAULT_TREND_CONFIG,
} from './design-quality-trend.js';
import type { CodeAreaMetricsRecord, TokenComplianceRecord } from './state/types.js';

const FROZEN_NOW_MS = Date.parse('2026-04-24T00:00:00Z');

function makeMetric(
  computedAtIso: string,
  overrides: Partial<CodeAreaMetricsRecord> = {},
): CodeAreaMetricsRecord {
  return {
    codeArea: 'ui/Button.tsx',
    hasFrontendComponents: true,
    dataPointCount: 20,
    computedAt: computedAtIso,
    ...overrides,
  };
}

function withDesignMetrics(
  computedAtIso: string,
  metrics: {
    designCIPassRate?: number;
    designReviewRejectionRate?: number;
    usabilitySimPassRate?: number;
  },
): CodeAreaMetricsRecord {
  return makeMetric(computedAtIso, { designMetricsJson: JSON.stringify(metrics) });
}

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function makeDsb(overrides: Partial<DesignSystemBinding['spec']> = {}): DesignSystemBinding {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignSystemBinding',
    metadata: { name: 'acme-ds' },
    spec: {
      stewardship: {
        designAuthority: { principals: ['design-lead', 'designer-2'], scope: [] },
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
      ...overrides,
    },
  };
}

describe('splitHistoryByWindow', () => {
  it('takes up to windowPrs newest rows within windowDays', () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      makeMetric(new Date(FROZEN_NOW_MS - i * 24 * 60 * 60 * 1000).toISOString()),
    );
    const { recent, baseline } = splitHistoryByWindow(
      history,
      { windowPrs: 10, windowDays: 30 },
      FROZEN_NOW_MS,
    );
    expect(recent).toHaveLength(10);
    expect(baseline).toHaveLength(10);
  });

  it('respects the windowDays cutoff when PR count is large', () => {
    const history = Array.from({ length: 50 }, (_, i) =>
      // Alternate: newest 5 within 30d, rest 60+ days ago
      makeMetric(
        i < 5
          ? new Date(FROZEN_NOW_MS - i * 24 * 60 * 60 * 1000).toISOString()
          : new Date(FROZEN_NOW_MS - 60 * 24 * 60 * 60 * 1000).toISOString(),
      ),
    );
    const { recent } = splitHistoryByWindow(
      history,
      { windowPrs: 10, windowDays: 30 },
      FROZEN_NOW_MS,
    );
    expect(recent).toHaveLength(5);
  });
});

describe('evaluateCiPassRate', () => {
  it('triggers when recent mean drops by ≥ threshold', () => {
    const recent = Array.from({ length: 5 }, (_, i) =>
      withDesignMetrics(`2026-04-0${i + 1}T00:00:00Z`, { designCIPassRate: 0.7 }),
    );
    const baseline = Array.from({ length: 5 }, (_, i) =>
      withDesignMetrics(`2026-03-0${i + 1}T00:00:00Z`, { designCIPassRate: 0.95 }),
    );
    const result = evaluateCiPassRate(recent, baseline, 0.15);
    expect(result.triggered).toBe(true);
    expect(result.delta).toBeCloseTo(0.25, 5);
  });

  it('does not trigger when drop is below threshold', () => {
    const recent = [withDesignMetrics('2026-04-01', { designCIPassRate: 0.86 })];
    const baseline = [withDesignMetrics('2026-03-01', { designCIPassRate: 0.95 })];
    const result = evaluateCiPassRate(recent, baseline, 0.15);
    expect(result.triggered).toBe(false);
  });

  it('does not trigger when no metrics present', () => {
    expect(evaluateCiPassRate([], [], 0.15).triggered).toBe(false);
  });
});

describe('evaluateReviewRejectionRate', () => {
  it('triggers when recent mean rises by ≥ threshold', () => {
    const recent = Array.from({ length: 5 }, () =>
      withDesignMetrics('2026-04-01', { designReviewRejectionRate: 0.35 }),
    );
    const baseline = Array.from({ length: 5 }, () =>
      withDesignMetrics('2026-03-01', { designReviewRejectionRate: 0.1 }),
    );
    expect(evaluateReviewRejectionRate(recent, baseline, 0.2).triggered).toBe(true);
  });

  it('does not trigger when rise is below threshold', () => {
    const recent = [withDesignMetrics('2026-04-01', { designReviewRejectionRate: 0.25 })];
    const baseline = [withDesignMetrics('2026-03-01', { designReviewRejectionRate: 0.1 })];
    expect(evaluateReviewRejectionRate(recent, baseline, 0.2).triggered).toBe(false);
  });
});

describe('evaluateTokenComplianceTrend', () => {
  it('triggers on a streak of consecutive declines ≥ minConsecutive', () => {
    const history: TokenComplianceRecord[] = [
      { bindingName: 'ds', coveragePercent: 60, violationsCount: 0 },
      { bindingName: 'ds', coveragePercent: 65, violationsCount: 0 },
      { bindingName: 'ds', coveragePercent: 70, violationsCount: 0 },
      { bindingName: 'ds', coveragePercent: 75, violationsCount: 0 },
      { bindingName: 'ds', coveragePercent: 80, violationsCount: 0 },
      { bindingName: 'ds', coveragePercent: 85, violationsCount: 0 },
    ];
    expect(evaluateTokenComplianceTrend(history, 5).triggered).toBe(true);
  });

  it('does not trigger on non-monotonic (noisy) history', () => {
    const history: TokenComplianceRecord[] = [
      { bindingName: 'ds', coveragePercent: 70, violationsCount: 0 },
      { bindingName: 'ds', coveragePercent: 72, violationsCount: 0 },
      { bindingName: 'ds', coveragePercent: 68, violationsCount: 0 },
      { bindingName: 'ds', coveragePercent: 71, violationsCount: 0 },
      { bindingName: 'ds', coveragePercent: 70, violationsCount: 0 },
    ];
    expect(evaluateTokenComplianceTrend(history, 5).triggered).toBe(false);
  });
});

describe('analyzeTrend', () => {
  it('combines triggers from all three conditions', () => {
    // 5 declining recent CI metrics, 5 stable baseline
    const recentCi = Array.from({ length: 5 }, (_, i) =>
      withDesignMetrics(new Date(FROZEN_NOW_MS - i * 60_000).toISOString(), {
        designCIPassRate: 0.65,
        designReviewRejectionRate: 0.3,
      }),
    );
    const baselineCi = Array.from({ length: 10 }, (_, i) =>
      withDesignMetrics(new Date(FROZEN_NOW_MS - (40 + i) * 24 * 60 * 60 * 1000).toISOString(), {
        designCIPassRate: 0.95,
        designReviewRejectionRate: 0.05,
      }),
    );
    const tokenHistory: TokenComplianceRecord[] = [
      { bindingName: 'ds', coveragePercent: 60, violationsCount: 0 },
      { bindingName: 'ds', coveragePercent: 65, violationsCount: 0 },
      { bindingName: 'ds', coveragePercent: 70, violationsCount: 0 },
      { bindingName: 'ds', coveragePercent: 75, violationsCount: 0 },
      { bindingName: 'ds', coveragePercent: 80, violationsCount: 0 },
      { bindingName: 'ds', coveragePercent: 85, violationsCount: 0 },
    ];

    const result = analyzeTrend(
      'ui/Button.tsx',
      [...recentCi, ...baselineCi],
      tokenHistory,
      FROZEN_NOW_MS,
    );
    expect(result.triggered).toBe(true);
    expect(Object.keys(result.conditions).sort()).toEqual([
      'designCIPassRate',
      'designReviewRejectionRate',
      'tokenComplianceTrend',
    ]);
  });

  it('returns triggered=false when nothing degrades', () => {
    const stable = Array.from({ length: 15 }, (_, i) =>
      withDesignMetrics(new Date(FROZEN_NOW_MS - i * 24 * 60 * 60 * 1000).toISOString(), {
        designCIPassRate: 0.9,
        designReviewRejectionRate: 0.1,
      }),
    );
    const result = analyzeTrend('ui/Button.tsx', stable, [], FROZEN_NOW_MS);
    expect(result.triggered).toBe(false);
    expect(result.conditions).toEqual({});
  });
});

describe('detectDesignQualityTrendDegrading', () => {
  let store: StateStore;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    store = StateStore.open(db);
  });

  afterEach(() => {
    store.close();
  });

  it('AC #3: monotonic 10-PR CI-decline fixture fires the event', () => {
    // Seed 15 points: 5 recent declining, 10 baseline stable
    for (let i = 0; i < 5; i++) {
      store.insertCodeAreaMetrics({
        codeArea: 'ui/Button.tsx',
        hasFrontendComponents: true,
        dataPointCount: 20,
        designMetricsJson: JSON.stringify({ designCIPassRate: 0.7 - i * 0.02 }),
      });
    }
    // Note: the store orders by (computed_at DESC, id DESC), so newest
    // inserts surface first. Baseline (older) inserts go first.
    db.prepare(`DELETE FROM code_area_metrics`).run();
    // Baseline inserts (older)
    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO code_area_metrics (code_area, has_frontend_components, design_metrics_json, data_point_count, computed_at)
         VALUES (?, 1, ?, 20, ?)`,
      ).run(
        'ui/Button.tsx',
        JSON.stringify({ designCIPassRate: 0.95 }),
        new Date(FROZEN_NOW_MS - (40 + i) * 24 * 60 * 60 * 1000).toISOString(),
      );
    }
    // Recent declining
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO code_area_metrics (code_area, has_frontend_components, design_metrics_json, data_point_count, computed_at)
         VALUES (?, 1, ?, 20, ?)`,
      ).run(
        'ui/Button.tsx',
        JSON.stringify({ designCIPassRate: 0.7 }),
        new Date(FROZEN_NOW_MS - i * 24 * 60 * 60 * 1000).toISOString(),
      );
    }

    const event = detectDesignQualityTrendDegrading('ui/Button.tsx', {
      stateStore: store,
      now: () => FROZEN_NOW_MS,
    });
    expect(event).toBeDefined();
    expect(event!.triggeredConditions).toContain('designCIPassRate');
  });

  it('AC #3: noisy data around baseline does NOT fire', () => {
    for (let i = 0; i < 15; i++) {
      db.prepare(
        `INSERT INTO code_area_metrics (code_area, has_frontend_components, design_metrics_json, data_point_count, computed_at)
         VALUES (?, 1, ?, 20, ?)`,
      ).run(
        'ui/Button.tsx',
        JSON.stringify({ designCIPassRate: 0.92 + (i % 3) * 0.01 }),
        new Date(FROZEN_NOW_MS - i * 24 * 60 * 60 * 1000).toISOString(),
      );
    }

    const event = detectDesignQualityTrendDegrading('ui/Button.tsx', {
      stateStore: store,
      now: () => FROZEN_NOW_MS,
    });
    expect(event).toBeUndefined();
  });

  it('AC #2: does NOT re-fire within the hysteresis recovery window', () => {
    // Seed degrading fixture
    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO code_area_metrics (code_area, has_frontend_components, design_metrics_json, data_point_count, computed_at)
         VALUES (?, 1, ?, 20, ?)`,
      ).run(
        'ui/Button.tsx',
        JSON.stringify({ designCIPassRate: 0.95 }),
        new Date(FROZEN_NOW_MS - (40 + i) * 24 * 60 * 60 * 1000).toISOString(),
      );
    }
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO code_area_metrics (code_area, has_frontend_components, design_metrics_json, data_point_count, computed_at)
         VALUES (?, 1, ?, 20, ?)`,
      ).run(
        'ui/Button.tsx',
        JSON.stringify({ designCIPassRate: 0.7 }),
        new Date(FROZEN_NOW_MS - i * 24 * 60 * 60 * 1000).toISOString(),
      );
    }

    // Pretend we fired 1 day ago → still within 7d recovery window
    const event = detectDesignQualityTrendDegrading('ui/Button.tsx', {
      stateStore: store,
      now: () => FROZEN_NOW_MS,
      getLastTriggerAt: () => new Date(FROZEN_NOW_MS - 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(event).toBeUndefined();
  });

  it('AC #2: re-fires after hysteresis window elapses', () => {
    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO code_area_metrics (code_area, has_frontend_components, design_metrics_json, data_point_count, computed_at)
         VALUES (?, 1, ?, 20, ?)`,
      ).run(
        'ui/Button.tsx',
        JSON.stringify({ designCIPassRate: 0.95 }),
        new Date(FROZEN_NOW_MS - (40 + i) * 24 * 60 * 60 * 1000).toISOString(),
      );
    }
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO code_area_metrics (code_area, has_frontend_components, design_metrics_json, data_point_count, computed_at)
         VALUES (?, 1, ?, 20, ?)`,
      ).run(
        'ui/Button.tsx',
        JSON.stringify({ designCIPassRate: 0.7 }),
        new Date(FROZEN_NOW_MS - i * 24 * 60 * 60 * 1000).toISOString(),
      );
    }

    // Fired 10 days ago → beyond 7d default recovery window
    const event = detectDesignQualityTrendDegrading('ui/Button.tsx', {
      stateStore: store,
      now: () => FROZEN_NOW_MS,
      getLastTriggerAt: () => new Date(FROZEN_NOW_MS - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(event).toBeDefined();
  });

  it('AC #4: notifiedPrincipals is the union of designAuthority + engineeringAuthority', () => {
    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO code_area_metrics (code_area, has_frontend_components, design_metrics_json, data_point_count, computed_at)
         VALUES (?, 1, ?, 20, ?)`,
      ).run(
        'ui/Button.tsx',
        JSON.stringify({ designCIPassRate: 0.95 }),
        new Date(FROZEN_NOW_MS - (40 + i) * 24 * 60 * 60 * 1000).toISOString(),
      );
    }
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO code_area_metrics (code_area, has_frontend_components, design_metrics_json, data_point_count, computed_at)
         VALUES (?, 1, ?, 20, ?)`,
      ).run(
        'ui/Button.tsx',
        JSON.stringify({ designCIPassRate: 0.7 }),
        new Date(FROZEN_NOW_MS - i * 24 * 60 * 60 * 1000).toISOString(),
      );
    }
    const dsb = makeDsb();
    const event = detectDesignQualityTrendDegrading('ui/Button.tsx', {
      stateStore: store,
      now: () => FROZEN_NOW_MS,
      getBindingForCodeArea: () => dsb,
    });
    expect(event).toBeDefined();
    expect(event!.notifiedPrincipals.sort()).toEqual(
      ['design-lead', 'designer-2', 'eng-lead'].sort(),
    );
    expect(event!.bindingName).toBe('acme-ds');
  });

  it('returns undefined when history is empty', () => {
    expect(
      detectDesignQualityTrendDegrading('ui/Unseen.tsx', {
        stateStore: store,
        now: () => FROZEN_NOW_MS,
      }),
    ).toBeUndefined();
  });

  it('issueBodyMarkdown includes baseline + current values', () => {
    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO code_area_metrics (code_area, has_frontend_components, design_metrics_json, data_point_count, computed_at)
         VALUES (?, 1, ?, 20, ?)`,
      ).run(
        'ui/Button.tsx',
        JSON.stringify({ designCIPassRate: 0.95 }),
        new Date(FROZEN_NOW_MS - (40 + i) * 24 * 60 * 60 * 1000).toISOString(),
      );
    }
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO code_area_metrics (code_area, has_frontend_components, design_metrics_json, data_point_count, computed_at)
         VALUES (?, 1, ?, 20, ?)`,
      ).run(
        'ui/Button.tsx',
        JSON.stringify({ designCIPassRate: 0.7 }),
        new Date(FROZEN_NOW_MS - i * 24 * 60 * 60 * 1000).toISOString(),
      );
    }
    const event = detectDesignQualityTrendDegrading('ui/Button.tsx', {
      stateStore: store,
      now: () => FROZEN_NOW_MS,
    });
    expect(event).toBeDefined();
    expect(event!.issueBodyMarkdown).toContain('designCIPassRate');
    expect(event!.issueBodyMarkdown).toContain('ui/Button.tsx');
  });
});

describe('AC #1: default window config', () => {
  it('defaults are 10 PRs / 30 days / 0.15 / 0.20 / 5', () => {
    expect(DEFAULT_TREND_CONFIG).toEqual({
      windowPrs: 10,
      windowDays: 30,
      ciDropThreshold: 0.15,
      reviewIncreaseThreshold: 0.2,
      consecutiveNegativeCompliance: 5,
    });
  });
});
