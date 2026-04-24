/**
 * C1 — SA-2 computable component (RFC-0008 v4 §5.2).
 *
 * SA-2 ("soul alignment with design system") has two halves:
 *   - Computable: deterministic formula over DSB status fields
 *   - LLM: structured assessment of principle coverage (M5)
 *
 * This module implements the computable half only. LLM is returned as
 * `null` until M5 (AISDLC-59/60) replaces it.
 *
 * Formula (§5.2):
 *   computableComponent = 0.3 × tokenCompliance + 0.2 × catalogHealth
 *
 * Where `tokenCompliance` and `catalogHealth` are normalized to [0, 1]
 * from the DSB's published status.
 */

import type { DesignIntentDocument, DesignSystemBinding } from '@ai-sdlc/reference';

export interface Sa2ComputableResult {
  /** Normalized token-compliance value in [0, 1]. */
  tokenCompliance: number;
  /** Normalized catalog-health coverage in [0, 1]. */
  catalogHealth: number;
  /** 0.3 × tokenCompliance + 0.2 × catalogHealth. */
  computableComponent: number;
  /** LLM component — filled by M5. Always `null` in Phase 1. */
  llmComponent: null;
}

/**
 * Compute the SA-2 computable half from a DID and its resolved DSB.
 *
 * Returns `undefined` (caller falls back to label-based `soulAlignment`)
 * when:
 *   - `dsb` is undefined, OR
 *   - Neither `tokenCompliance.currentCoverage` nor `catalogHealth.coveragePercent`
 *     is present on the DSB status (can't compute either term).
 *
 * The DID is accepted for API symmetry and future extension (e.g. when
 * individual principles select which DSB metrics to include); §5.2
 * itself only reads DSB status.
 */
export function computeSa2Computable(
  did: DesignIntentDocument,
  dsb: DesignSystemBinding | undefined,
): Sa2ComputableResult | undefined {
  void did;
  if (!dsb?.status) return undefined;

  const rawTokenCoverage = dsb.status.tokenCompliance?.currentCoverage;
  const rawCatalogCoverage = dsb.status.catalogHealth?.coveragePercent;

  if (rawTokenCoverage === undefined && rawCatalogCoverage === undefined) {
    return undefined;
  }

  const tokenCompliance = normalizeCoverage(rawTokenCoverage);
  const catalogHealth = normalizeCoverage(rawCatalogCoverage);

  const computableComponent = 0.3 * tokenCompliance + 0.2 * catalogHealth;

  return {
    tokenCompliance,
    catalogHealth,
    computableComponent,
    llmComponent: null,
  };
}

/**
 * Normalize a coverage value to [0, 1]. Accepts percentages (0–100) or
 * ratios (0–1). Missing values are treated as 0.
 */
function normalizeCoverage(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return 0;
  const clamped = value > 1 ? value / 100 : value;
  return Math.min(1, Math.max(0, clamped));
}
