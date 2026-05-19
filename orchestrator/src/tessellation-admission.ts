/**
 * RFC-0009 Phase 2.1 — Tessellation routing for admission composite.
 *
 * Implements the soul-scope routing algorithm from RFC-0009 §6:
 *
 *   resolveAffectedSouls(w) = set of Soul DIDs the work item affects,
 *     computed from the dependency graph snapshot (RFC-0014).
 *
 *   If tessellation absent on the resolved DID:
 *     Behavior unchanged from RFC-0008. Single-DID semantics preserved.
 *
 *   Else if |resolveAffectedSouls(w)| == 0:
 *     // Pure substrate work touching no soul-importing module
 *     Sα(w) = min over ALL souls { Sα(w, soul) }    (§6 degenerate case)
 *
 *   Else if |resolveAffectedSouls(w)| == 1:
 *     Sα(w) = Sα(w, targetSoul)                     // soul's own DSB
 *
 *   Else:
 *     Sα(w) = crossSoulScoringRule(w, affectedSouls) // default `min`
 *
 * The same resolution applies to Eρ₄ (Design System Readiness) per §6:
 *   "The same soul-resolution applies to Eρ₄ which reads against the
 *    targeted soul's DSB rather than the platform-aggregate DSB."
 *
 * @see spec/rfcs/RFC-0009-tessellated-design-intent-documents.md §6 + §10
 */

import type { Tessellation } from '@ai-sdlc/reference';

// ── Dep-graph soul scope bridge ────────────────────────────────────────

/**
 * A minimal representation of one dep-graph snapshot record's soul scope.
 *
 * Derived from the RFC-0014 snapshot (SnapshotRecord) via the pipeline-cli
 * reader layer. Callers populate this from `snapshot.*.jsonl` records before
 * calling `resolveAffectedSouls`.
 *
 * When `targetedSoulIds` is absent or empty, the work item is treated as
 * substrate-only — affecting the full `min`-over-all-souls degenerate case.
 */
export interface DepGraphSoulEntry {
  /**
   * Canonical task ID (case-insensitive match used internally). E.g. "AISDLC-313".
   */
  id: string;
  /**
   * Soul slugs (soulId values from the Tessellation manifest) that this
   * work item explicitly targets. Empty or absent = substrate-only change.
   *
   * Populated by the pipeline-cli layer reading the dep-graph snapshot; the
   * soulId values must match `tessellation.souls[].soulId` for the lookup to
   * produce useful results.
   */
  targetedSoulIds?: string[];
}

// ── Per-soul scores ────────────────────────────────────────────────────

/**
 * Per-soul scoring data used by the tessellated admission composite.
 * One entry per active soul in the tessellation.
 */
export interface SoulScores {
  /**
   * Soul-specific soul-alignment score in [0, 1].
   * Scored against this soul's DSB and product vertex (§6 + §5.1.1).
   */
  soulAlignment: number;
  /**
   * Soul-specific Eρ₄ Design System Readiness in [0, 1].
   * Reads from the soul's own DSB at `.ai-sdlc/souls/<slug>/design-system-binding.yaml`
   * rather than the platform-aggregate DSB (§6 last para).
   */
  er4: number;
}

// ── Tessellation context ───────────────────────────────────────────────

/**
 * All tessellation-related inputs needed by the admission composite
 * for RFC-0009 Phase 2.1 soul-scope routing.
 *
 * Callers build this once per pipeline tick and pass it to
 * `computeAdmissionComposite` via `AdmissionCompositeOptions.tessellationContext`.
 */
export interface TessellationContext {
  /**
   * The Tessellated DID's `tessellation` field (from `DesignIntentDocumentSpec`).
   * Carries the soul manifest + `crossSoulScoringRule` + `substrateInvariants`.
   */
  tessellation: Tessellation;
  /**
   * Pre-computed per-soul scores, keyed by `soulId` (matching
   * `tessellation.souls[].soulId`). Must cover at least every active soul.
   *
   * In a full Phase 2 implementation these are computed by reading each
   * soul's DSB at `.ai-sdlc/souls/<slug>/design-system-binding.yaml` and
   * scoring Sα against the soul's product vertex.
   */
  soulScores: Record<string, SoulScores>;
  /**
   * Dep-graph soul scope entries — one per work item in the active backlog.
   * Read from the latest RFC-0014 snapshot via `pipeline-cli`'s snapshot
   * reader before calling the admission composite.
   *
   * When `undefined` or empty, every work item is treated as substrate-only.
   */
  depGraphEntries?: DepGraphSoulEntry[];
}

// ── Core functions ─────────────────────────────────────────────────────

/**
 * Resolve the set of soul IDs affected by a work item.
 *
 * Algorithm (RFC-0009 §6 + OQ-2 sub-decision):
 * 1. Find the work item's dep-graph entry by case-insensitive ID match.
 * 2. Filter its `targetedSoulIds` against souls present in the tessellation.
 * 3. Return the validated intersection.
 * 4. If no entry is found, or `targetedSoulIds` is empty/absent → return `[]`
 *    (substrate-only; triggers the `min`-over-all-souls degenerate case in §6).
 *
 * @param workItemId  - The work item's canonical ID (e.g. "AISDLC-313").
 * @param depGraphEntries - Soul scope entries from the RFC-0014 snapshot.
 * @param tessellation - The tessellation manifest to validate soul IDs against.
 * @returns Array of valid affected soul IDs (empty = substrate-only).
 */
export function resolveAffectedSouls(
  workItemId: string,
  depGraphEntries: DepGraphSoulEntry[] | undefined,
  tessellation: Tessellation,
): string[] {
  if (!depGraphEntries || depGraphEntries.length === 0) return [];

  const normalizedId = workItemId.toLowerCase();
  const entry = depGraphEntries.find((e) => e.id.toLowerCase() === normalizedId);
  if (!entry || !entry.targetedSoulIds || entry.targetedSoulIds.length === 0) return [];

  // Validate each declared soul ID against the tessellation manifest.
  const validSoulIds = new Set(tessellation.souls.map((s) => s.soulId));
  return entry.targetedSoulIds.filter((id) => validSoulIds.has(id));
}

/**
 * Apply `crossSoulScoringRule` over a per-soul score map.
 *
 * Currently implements `min` (default per OQ-2 resolution) and `max`/`mean`
 * escape valves. `weighted-traffic` and `weighted-revenue` require an external
 * data source and are documented as advanced — they fall through to `min` when
 * no weights are available (safe degenerate).
 *
 * @param soulIds   - The soul IDs to aggregate over.
 * @param scores    - Per-soul score map (keyed by soulId).
 * @param rule      - The aggregation rule from the Tessellated DID.
 * @param fallback  - Default score when no soul scores are available (0.5).
 */
export function applyCrossSoulRule(
  soulIds: string[],
  scores: Record<string, number>,
  rule: Tessellation['crossSoulScoringRule'],
  fallback = 0.5,
): number {
  const values = soulIds.map((id) => scores[id]).filter((v): v is number => v !== undefined);
  if (values.length === 0) return fallback;

  switch (rule ?? 'min') {
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'mean':
      return values.reduce((sum, v) => sum + v, 0) / values.length;
    case 'weighted-traffic':
    case 'weighted-revenue':
      // Advanced variants require an external data source (per RFC-0009 §5.2 note).
      // Degenerate to `min` when no weight data available — safe, conservative.
      return Math.min(...values);
  }
}

// ── Tessellated Sα + Eρ₄ resolution ───────────────────────────────────

/**
 * Result of tessellation-based soul-alignment resolution.
 * Exposes routing path for auditability.
 */
export interface TessellatedSaResult {
  /** The resolved Sα value in [0, 1]. */
  soulAlignment: number;
  /** The resolved Eρ₄ value in [0, 1]. */
  er4: number;
  /**
   * Routing path taken (matches RFC-0009 §6 case labels).
   *
   * - `'non-tessellated'`   — tessellation absent; single-DID path preserved.
   * - `'substrate-only'`    — 0 affected souls; `min`-over-ALL-souls degenerate.
   * - `'single-soul'`       — 1 affected soul; scored against that soul's DSB.
   * - `'multi-soul'`        — N>1 affected souls; crossSoulScoringRule applied.
   */
  routingPath: 'non-tessellated' | 'substrate-only' | 'single-soul' | 'multi-soul';
  /** Soul IDs used in the aggregation (empty for `non-tessellated`). */
  affectedSoulIds: string[];
}

/**
 * Compute tessellated Sα + Eρ₄ for a work item, implementing RFC-0009 §6.
 *
 * @param workItemId         - The canonical work item ID.
 * @param fallbackSa         - SA score to use when tessellation is absent (single-DID path).
 * @param fallbackEr4        - Eρ₄ score to use when tessellation is absent.
 * @param tessellationCtx    - Tessellation context, or undefined for non-tessellated DID.
 */
export function computeTessellatedScores(
  workItemId: string,
  fallbackSa: number,
  fallbackEr4: number,
  tessellationCtx: TessellationContext | undefined,
): TessellatedSaResult {
  // ── Non-tessellated path (RFC-0008 legacy) ─────────────────────
  if (!tessellationCtx) {
    return {
      soulAlignment: fallbackSa,
      er4: fallbackEr4,
      routingPath: 'non-tessellated',
      affectedSoulIds: [],
    };
  }

  const { tessellation, soulScores, depGraphEntries } = tessellationCtx;
  const affectedSoulIds = resolveAffectedSouls(workItemId, depGraphEntries, tessellation);

  // Build per-soul score maps for Sα and Eρ₄.
  const soulSaMap: Record<string, number> = {};
  const soulEr4Map: Record<string, number> = {};
  for (const soul of tessellation.souls) {
    const scores = soulScores[soul.soulId];
    if (scores) {
      soulSaMap[soul.soulId] = scores.soulAlignment;
      soulEr4Map[soul.soulId] = scores.er4;
    }
  }

  const rule = tessellation.crossSoulScoringRule ?? 'min';
  const allSoulIds = tessellation.souls.map((s) => s.soulId);

  // ── Substrate-only path (§6 degenerate) ───────────────────────
  if (affectedSoulIds.length === 0) {
    return {
      soulAlignment: applyCrossSoulRule(allSoulIds, soulSaMap, rule, fallbackSa),
      er4: applyCrossSoulRule(allSoulIds, soulEr4Map, rule, fallbackEr4),
      routingPath: 'substrate-only',
      affectedSoulIds: [],
    };
  }

  // ── Single-soul path ───────────────────────────────────────────
  if (affectedSoulIds.length === 1) {
    const soulId = affectedSoulIds[0];
    const scores = soulScores[soulId];
    return {
      soulAlignment: scores?.soulAlignment ?? fallbackSa,
      er4: scores?.er4 ?? fallbackEr4,
      routingPath: 'single-soul',
      affectedSoulIds,
    };
  }

  // ── Multi-soul path (crossSoulScoringRule over affected souls) ─
  return {
    soulAlignment: applyCrossSoulRule(affectedSoulIds, soulSaMap, rule, fallbackSa),
    er4: applyCrossSoulRule(affectedSoulIds, soulEr4Map, rule, fallbackEr4),
    routingPath: 'multi-soul',
    affectedSoulIds,
  };
}
