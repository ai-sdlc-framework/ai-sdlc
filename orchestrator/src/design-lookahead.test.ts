import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from './state/store.js';
import type { PillarBreakdown } from './pillar-breakdown.js';
import {
  detectDesignImpactReasons,
  detectDesignLookaheadNotifications,
  DEFAULT_LOOKAHEAD_CONFIG,
  type BacklogItem,
} from './design-lookahead.js';

const NOW_MS = Date.parse('2026-04-24T00:00:00Z');
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

function emptyPillar(overrides: Partial<PillarBreakdown> = {}): PillarBreakdown {
  return {
    product: {
      pillar: 'product',
      governedDimensions: ['SA-1'],
      signal: 0.5,
      interpretation: 'neutral Product signal',
    },
    design: {
      pillar: 'design',
      governedDimensions: ['ER-4'],
      signal: 0.5,
      interpretation: 'neutral Design signal',
    },
    engineering: {
      pillar: 'engineering',
      governedDimensions: ['ER-1'],
      signal: 0.5,
      interpretation: 'neutral Engineering signal',
    },
    shared: {
      hcComposite: { explicit: 0, consensus: 0, decision: 0, design: 0, value: 0 },
    },
    tensions: [],
    ...overrides,
  };
}

function makeItem(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    issueNumber: 42,
    composite: 0.8,
    pillarBreakdown: emptyPillar(),
    ...overrides,
  };
}

describe('detectDesignImpactReasons', () => {
  it('empty reasons when no impact', () => {
    expect(detectDesignImpactReasons(makeItem())).toEqual([]);
  });

  it('frontend-components when hasFrontendComponents=true', () => {
    expect(detectDesignImpactReasons(makeItem({ hasFrontendComponents: true }))).toEqual([
      'frontend-components',
    ]);
  });

  it('catalog-gaps when catalogGaps populated', () => {
    expect(detectDesignImpactReasons(makeItem({ catalogGaps: ['Avatar', 'Toast'] }))).toEqual([
      'catalog-gaps',
    ]);
  });

  it('product-design-tension when tension flag present', () => {
    const item = makeItem({
      pillarBreakdown: emptyPillar({
        tensions: [{ type: 'PRODUCT_HIGH_DESIGN_LOW', suggestedAction: 'x' }],
      }),
    });
    expect(detectDesignImpactReasons(item)).toEqual(['product-design-tension']);
  });

  it('collects all reasons when multiple conditions hold', () => {
    const item = makeItem({
      hasFrontendComponents: true,
      catalogGaps: ['Avatar'],
      pillarBreakdown: emptyPillar({
        tensions: [{ type: 'PRODUCT_HIGH_DESIGN_LOW', suggestedAction: 'x' }],
      }),
    });
    expect(detectDesignImpactReasons(item).sort()).toEqual([
      'catalog-gaps',
      'frontend-components',
      'product-design-tension',
    ]);
  });

  it('non-design-tension flags (e.g. PRODUCT_HIGH_ENGINEERING_LOW) do NOT trigger design impact', () => {
    const item = makeItem({
      pillarBreakdown: emptyPillar({
        tensions: [{ type: 'PRODUCT_HIGH_ENGINEERING_LOW', suggestedAction: 'x' }],
      }),
    });
    expect(detectDesignImpactReasons(item)).toEqual([]);
  });
});

describe('detectDesignLookaheadNotifications', () => {
  let store: StateStore;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    store = StateStore.open(db);
  });

  afterEach(() => {
    store.close();
  });

  it('AC #4: no notification when item has no design-system impact', () => {
    const items: BacklogItem[] = [
      makeItem({
        enteredTop10At: new Date(NOW_MS - 72 * ONE_HOUR).toISOString(),
      }),
    ];
    const result = detectDesignLookaheadNotifications(items, {
      stateStore: store,
      now: () => NOW_MS,
    });
    expect(result).toEqual([]);
  });

  it('AC #1: item at 47h in top-10 does NOT fire', () => {
    const items: BacklogItem[] = [
      makeItem({
        hasFrontendComponents: true,
        enteredTop10At: new Date(NOW_MS - 47 * ONE_HOUR).toISOString(),
      }),
    ];
    const result = detectDesignLookaheadNotifications(items, {
      stateStore: store,
      now: () => NOW_MS,
    });
    expect(result).toEqual([]);
  });

  it('AC #1: item at 48h+ in top-10 with design impact fires exactly once', () => {
    const items: BacklogItem[] = [
      makeItem({
        hasFrontendComponents: true,
        enteredTop10At: new Date(NOW_MS - 48 * ONE_HOUR).toISOString(),
      }),
    ];
    const result = detectDesignLookaheadNotifications(items, {
      stateStore: store,
      now: () => NOW_MS,
    });
    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(42);
    expect(result[0].reasons).toContain('frontend-components');
    // Persisted to state store.
    expect(store.getDesignLookaheadNotification(42)).toBeDefined();
  });

  it('AC #1: subsequent ticks within 7d do NOT re-fire', () => {
    const items: BacklogItem[] = [
      makeItem({
        hasFrontendComponents: true,
        enteredTop10At: new Date(NOW_MS - 48 * ONE_HOUR).toISOString(),
      }),
    ];
    const first = detectDesignLookaheadNotifications(items, {
      stateStore: store,
      now: () => NOW_MS,
    });
    expect(first).toHaveLength(1);

    // Later tick, 6 days later — still within dedupe window.
    const later = detectDesignLookaheadNotifications(items, {
      stateStore: store,
      now: () => NOW_MS + 6 * ONE_DAY,
    });
    expect(later).toEqual([]);
  });

  it('AC #2: re-fires after 7d expiry even if item stayed in top-10', () => {
    const items: BacklogItem[] = [
      makeItem({
        hasFrontendComponents: true,
        enteredTop10At: new Date(NOW_MS - 48 * ONE_HOUR).toISOString(),
      }),
    ];
    const first = detectDesignLookaheadNotifications(items, {
      stateStore: store,
      now: () => NOW_MS,
    });
    expect(first).toHaveLength(1);

    // Force the stored lastNotifiedAt to 8 days ago.
    db.prepare(
      `UPDATE design_lookahead_notifications SET last_notified_at = ? WHERE issue_number = 42`,
    ).run(new Date(NOW_MS - 8 * ONE_DAY).toISOString());

    const second = detectDesignLookaheadNotifications(items, {
      stateStore: store,
      now: () => NOW_MS,
    });
    expect(second).toHaveLength(1);
  });

  it('AC #3: payload includes pillarBreakdown exactly as passed in', () => {
    const pillar = emptyPillar({
      tensions: [{ type: 'PRODUCT_HIGH_DESIGN_LOW', suggestedAction: 'catalog-first' }],
    });
    const items: BacklogItem[] = [
      makeItem({
        pillarBreakdown: pillar,
        enteredTop10At: new Date(NOW_MS - 48 * ONE_HOUR).toISOString(),
        catalogGaps: ['Avatar'],
      }),
    ];
    const result = detectDesignLookaheadNotifications(items, {
      stateStore: store,
      now: () => NOW_MS,
    });
    expect(result).toHaveLength(1);
    expect(result[0].pillarBreakdown).toBe(pillar);
    expect(result[0].catalogGaps).toEqual(['Avatar']);
    expect(result[0].tensionFlags).toEqual(pillar.tensions);
  });

  it('AC #5: skips items without enteredTop10At (just entered this tick)', () => {
    const items: BacklogItem[] = [
      makeItem({ hasFrontendComponents: true /* no enteredTop10At */ }),
    ];
    const result = detectDesignLookaheadNotifications(items, {
      stateStore: store,
      now: () => NOW_MS,
    });
    expect(result).toEqual([]);
  });

  it('respects topN config — items outside top-N are ignored', () => {
    // Both items qualify; config.topN=1 should only consider the first
    const items: BacklogItem[] = [
      makeItem({
        issueNumber: 1,
        hasFrontendComponents: true,
        enteredTop10At: new Date(NOW_MS - 48 * ONE_HOUR).toISOString(),
      }),
      makeItem({
        issueNumber: 2,
        hasFrontendComponents: true,
        enteredTop10At: new Date(NOW_MS - 48 * ONE_HOUR).toISOString(),
      }),
    ];
    const result = detectDesignLookaheadNotifications(items, {
      stateStore: store,
      now: () => NOW_MS,
      config: { topN: 1 },
    });
    expect(result.map((r) => r.issueNumber)).toEqual([1]);
  });

  it('persists pillarBreakdown JSON in the lookahead notifications table', () => {
    const pillar = emptyPillar({
      tensions: [{ type: 'PRODUCT_HIGH_DESIGN_LOW', suggestedAction: 'x' }],
    });
    const items: BacklogItem[] = [
      makeItem({
        pillarBreakdown: pillar,
        catalogGaps: ['Avatar'],
        enteredTop10At: new Date(NOW_MS - 48 * ONE_HOUR).toISOString(),
      }),
    ];
    detectDesignLookaheadNotifications(items, { stateStore: store, now: () => NOW_MS });
    const stored = store.getDesignLookaheadNotification(42);
    expect(stored).toBeDefined();
    expect(stored!.pillarBreakdownJson).toBeDefined();
    const parsed = JSON.parse(stored!.pillarBreakdownJson!);
    expect(parsed.tensions[0].type).toBe('PRODUCT_HIGH_DESIGN_LOW');
  });

  it('default config defaults: 48h stability, 7d dedupe, top 10', () => {
    expect(DEFAULT_LOOKAHEAD_CONFIG.stabilityThresholdMs).toBe(48 * ONE_HOUR);
    expect(DEFAULT_LOOKAHEAD_CONFIG.dedupeExpiryMs).toBe(7 * ONE_DAY);
    expect(DEFAULT_LOOKAHEAD_CONFIG.topN).toBe(10);
  });
});
