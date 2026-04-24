/**
 * C7 — Design Lookahead Notification (RFC-0008 §11 + Amendment 6).
 *
 * Fires a notification when a backlog item has:
 *   1. Stayed in the top-10 of the prioritized backlog for ≥48h
 *      (OQ-7 stability threshold against priority churn)
 *   2. Design-system impact (any of: frontend code area, catalog gaps,
 *      or `PRODUCT_HIGH_DESIGN_LOW` tension flag)
 *   3. Not been notified within the last 7 days
 *      (dedupe via `design_lookahead_notifications` table)
 *
 * The payload is the full `PillarBreakdown` plus gap and tension
 * information — design reviewers need the structured context to decide
 * whether to unblock, reprioritize, or flag the item.
 */

import type { StateStore } from './state/store.js';
import type { PillarBreakdown, TensionFlag } from './pillar-breakdown.js';

// ── Thresholds ─────────────────────────────────────────────────────────

const DEFAULT_STABILITY_MS = 48 * 60 * 60 * 1000;
const DEFAULT_DEDUPE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TOP_N = 10;

export interface DesignLookaheadConfig {
  /** Min time an issue must have been in top-N to qualify. Default 48h. */
  stabilityThresholdMs: number;
  /** Min time since last notification before re-notifying. Default 7d. */
  dedupeExpiryMs: number;
  /** Cutoff for "top" (ignored when `items` is already pre-filtered). */
  topN: number;
}

export const DEFAULT_LOOKAHEAD_CONFIG: DesignLookaheadConfig = {
  stabilityThresholdMs: DEFAULT_STABILITY_MS,
  dedupeExpiryMs: DEFAULT_DEDUPE_EXPIRY_MS,
  topN: DEFAULT_TOP_N,
};

// ── Backlog item shape ────────────────────────────────────────────────

export interface BacklogItem {
  issueNumber: number;
  /** Composite score that placed this item in top-N. */
  composite: number;
  /** Pillar breakdown from the admission composite. */
  pillarBreakdown: PillarBreakdown;
  /** When the item first entered the top-N (ISO timestamp). */
  enteredTop10At?: string;
  /** Whether the code area has frontend components (C3 classifier). */
  hasFrontendComponents?: boolean;
  /** Catalog gaps surfaced during enrichment (C2). */
  catalogGaps?: string[];
}

export type DesignImpactReason = 'frontend-components' | 'catalog-gaps' | 'product-design-tension';

export interface DesignLookaheadNotification {
  type: 'DesignLookaheadNotification';
  issueNumber: number;
  notifiedAt: string;
  /** Reasons this item was flagged (ordered as detected). */
  reasons: DesignImpactReason[];
  pillarBreakdown: PillarBreakdown;
  catalogGaps: string[];
  tensionFlags: TensionFlag[];
}

// ── Impact detection ───────────────────────────────────────────────────

export function detectDesignImpactReasons(item: BacklogItem): DesignImpactReason[] {
  const reasons: DesignImpactReason[] = [];
  if (item.hasFrontendComponents) reasons.push('frontend-components');
  if ((item.catalogGaps ?? []).length > 0) reasons.push('catalog-gaps');
  if (item.pillarBreakdown.tensions.some((t) => t.type === 'PRODUCT_HIGH_DESIGN_LOW')) {
    reasons.push('product-design-tension');
  }
  return reasons;
}

// ── Detector ───────────────────────────────────────────────────────────

export interface DesignLookaheadDetectorDeps {
  stateStore: StateStore;
  now?: () => number;
  config?: Partial<DesignLookaheadConfig>;
}

/**
 * Run one scheduler tick. `items` should already be the top-N backlog
 * items in descending composite order; caller is responsible for
 * tracking `enteredTop10At` across ticks. Returns the notifications
 * to emit + persist for this tick.
 */
export function detectDesignLookaheadNotifications(
  items: readonly BacklogItem[],
  deps: DesignLookaheadDetectorDeps,
): DesignLookaheadNotification[] {
  const config = { ...DEFAULT_LOOKAHEAD_CONFIG, ...deps.config };
  const nowMs = (deps.now ?? (() => Date.now()))();
  const topItems = items.slice(0, config.topN);
  const emissions: DesignLookaheadNotification[] = [];

  for (const item of topItems) {
    // 1. Stability check — must have been in top-N ≥ stabilityThresholdMs.
    if (!item.enteredTop10At) continue;
    const enteredMs = Date.parse(item.enteredTop10At);
    if (Number.isNaN(enteredMs)) continue;
    if (nowMs - enteredMs < config.stabilityThresholdMs) continue;

    // 2. Design-system impact.
    const reasons = detectDesignImpactReasons(item);
    if (reasons.length === 0) continue;

    // 3. Dedupe via notification table.
    const existing = deps.stateStore.getDesignLookaheadNotification(item.issueNumber);
    if (existing?.lastNotifiedAt) {
      const lastMs = Date.parse(existing.lastNotifiedAt);
      if (!Number.isNaN(lastMs) && nowMs - lastMs < config.dedupeExpiryMs) continue;
    }

    // 4. Emit + record.
    const notification: DesignLookaheadNotification = {
      type: 'DesignLookaheadNotification',
      issueNumber: item.issueNumber,
      notifiedAt: new Date(nowMs).toISOString(),
      reasons,
      pillarBreakdown: item.pillarBreakdown,
      catalogGaps: item.catalogGaps ?? [],
      tensionFlags: item.pillarBreakdown.tensions,
    };
    emissions.push(notification);

    deps.stateStore.upsertDesignLookaheadNotification({
      issueNumber: item.issueNumber,
      pillarBreakdownJson: JSON.stringify(item.pillarBreakdown),
    });
  }

  return emissions;
}
