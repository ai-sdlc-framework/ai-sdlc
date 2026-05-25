/**
 * RFC-0017 Phase 2 — In-Soul Variant Pattern admission scorer composition.
 *
 * Implements the variant-scope routing algorithm described in RFC-0017 §5.4
 * and §9 (Phase 2):
 *
 *   resolveTargetedVariants(w) = set of (soulId, variantId) pairs declared on
 *     the work item via `targetedVariants[]` (URI shape `<soul-id>/<variant-id>`).
 *
 *   If no `targetedVariants` declared:
 *     Scoring proceeds at soul-aggregate scope (backward-compatible — unchanged
 *     from RFC-0009 baseline).
 *
 *   Else if |targeted| == 1 (single-variant):
 *     Sα₁(w) = scoreSα₁(variant.audienceCharacteristics)
 *     Sα₂(w) = scoreSα₂(variant.designOverrides ∪ variant.designImperatives)
 *
 *   Else (multi-variant):
 *     Per-variant Sα₁ + Sα₂ are aggregated via the Soul's
 *     `crossVariantAggregation` rule (per-Soul override; default `min` per
 *     RFC-0017 OQ-4 / RFC-0009 §7.2 consistency).
 *
 * This module mirrors the surface shape of `tessellation-admission.ts` so the
 * composite reader can compose the two layers cleanly: tessellation routing
 * picks the Soul scope; variant routing refines that to a variant scope when
 * the work item declares targeted variants of one of the affected souls.
 *
 * **Schema dependency note (Phase 1 not yet shipped):**
 * Phase 1 (AISDLC-352) ships the JSON Schema additions for `variants[]` on
 * Soul DID and `targetedVariants[]` on Work Item, plus the inheritance
 * validator. Phase 2 (this file) defines the in-memory shapes the admission
 * composite needs and the pure routing algorithm. Phase 1 loaders will
 * populate `VariantContext` from on-disk Soul DIDs once they exist. The
 * shapes here parallel the schema layout in RFC-0017 §6.1.
 *
 * @see spec/rfcs/RFC-0017-in-soul-variant-pattern.md §5.4 + §9 + §10
 * @see orchestrator/src/tessellation-admission.ts — sibling Soul-scope router
 */

import type { Tessellation } from '@ai-sdlc/reference';

// ── Variant-overlay declarations (mirror RFC-0017 §6.1 schema) ──────────

/**
 * Framework-owned `designOverrides` enum fields per RFC-0017 §6.1 + OQ-5.
 * These are the only field names the framework declares; adopters extend via
 * vendor-prefix (see `designOverridesExt` below).
 */
export interface VariantDesignOverridesFramework {
  /** Variant-scoped voice register (e.g. "approachable-municipal"). */
  voiceRegister?: string;
  /** Variant-scoped color palette overlay (additive over soul palette). */
  colorPaletteOverlay?: string;
  /** Variant-scoped density profile. */
  densityProfile?: 'compact' | 'comfortable' | 'spacious';
}

/**
 * Vendor-prefixed `designOverrides` extension map per RFC-0017 OQ-5.
 * Keys MUST follow reverse-DNS prefix convention (e.g. `acme.com/accessibilityProfile`).
 * Schema validation of the prefix is Phase 1's concern; Phase 2 simply consumes
 * whatever keys are present and treats their truthy presence as a variant-scoped
 * Sα₂ signal contribution.
 */
export type VariantDesignOverridesExt = Record<string, string | number | boolean>;

/**
 * In-memory representation of one variant declared on a Soul DID, parallel to
 * the YAML/JSON schema fields in RFC-0017 §6.1. Phase 1 (AISDLC-352) ships the
 * schema + loader; Phase 2 uses this shape as the contract between loader and
 * the variant-scope router.
 */
export interface VariantOverlay {
  /** Variant identifier (kebab-case, unique within the parent Soul). */
  id: string;
  /**
   * Variant-scoped audience characteristics. Feeds Sα₁ Problem/Audience
   * Resonance scoring when the work item targets this variant (RFC-0017
   * §5.4 + §6.1 `targetAudience`).
   */
  audienceCharacteristics?: {
    segments?: string[];
    sizeRange?: { minStaff?: number; maxStaff?: number };
    /** Free-form adopter-defined audience fields — preserved as-is for Sα₁. */
    [k: string]: unknown;
  };
  /**
   * Framework-owned design override fields (closed enum per OQ-5).
   */
  designOverrides?: VariantDesignOverridesFramework;
  /**
   * Vendor-prefixed adopter extensions (OQ-5). Schema validates the prefix;
   * any present key contributes to the variant-scoped Sα₂ surface.
   */
  designOverridesExt?: VariantDesignOverridesExt;
  /**
   * Variant-scoped Sα₂ design imperatives (layered on top of soul-level
   * imperatives, variant wins on conflict per RFC-0017 §5.4).
   */
  designImperatives?: string[];
}

// ── Per-variant precomputed scores ───────────────────────────────────────

/**
 * Per-variant Sα₁ + Sα₂ scores. One entry per variant of one Soul.
 *
 * Phase 1's loader OR a Phase 2/3 scorer populates this — Phase 2's router
 * is agnostic to how the per-variant scores are produced (could be BM25
 * against `audienceCharacteristics.segments`, embedding similarity against
 * `designImperatives`, etc.). The router only knows how to ROUTE among them.
 */
export interface VariantScores {
  /** Variant-scoped Sα₁ Problem/Audience Resonance score, in [0, 1]. */
  sa1: number;
  /** Variant-scoped Sα₂ Vibe Coherence score, in [0, 1]. */
  sa2: number;
}

// ── Per-Soul variant config (RFC-0017 §10.1) ─────────────────────────────

/**
 * Per-Soul `variantConfig` block, projected from the
 * `.ai-sdlc/variant-config.yaml` (per-org defaults) + per-Soul overrides
 * in `spec.variantConfig` (RFC-0017 §10.1).
 *
 * Currently surfaces only the OQ-4-resolved knob (cross-variant aggregation).
 * Future Phase-1 phases add `limits`, `lifecycle`, etc.; this interface stays
 * tightly scoped to what the admission router consumes.
 */
export interface VariantConfig {
  /**
   * OQ-4 — cross-variant aggregation rule. Default `min` (matches RFC-0009
   * §7.2 cross-soul default per the OQ-4 resolution). Per-Soul override
   * accommodates adopters needing `max` for experimental-variant promotion
   * or `mean` for blended audience studies.
   */
  crossVariantAggregation?: VariantAggregationRule;
}

/**
 * Supported cross-variant aggregation rules. Subset of `Tessellation['crossSoulScoringRule']`
 * — we expose `min`/`max`/`mean` since those are the variant-scope-meaningful options
 * (the `weighted-*` variants are platform-scope-only per RFC-0009 §5.2).
 */
export type VariantAggregationRule = 'min' | 'max' | 'mean';

// ── Per-work-item targeting (mirror RFC-0017 §6.1 Work Item schema) ──────

/**
 * One work item's `targetedVariants[]` declaration. Entries are URI-shaped
 * `<soul-id>/<variant-id>` per RFC-0017 §6.1 (the URI pattern enforced by
 * the schema; we accept the trimmed slug form here because the DID prefix
 * `did:platform-x:soul:` is platform-scoped, not router-scoped).
 *
 * The `did:platform-x:soul:engage/variant:small-utility` URI form from
 * OQ-6 reduces to `engage/small-utility` after the schema's URI parser
 * extracts the soul-id + variant-id segments.
 */
export interface WorkItemVariantTargeting {
  /** Canonical work item ID (case-insensitive). E.g. "AISDLC-313". */
  id: string;
  /**
   * Variant references in the schema-accepted form. Each entry MUST be the
   * `<soul-id>/<variant-id>` slug pair (the schema's URI parser normalizes
   * the full `did:...:variant:...` form down to this).
   */
  targetedVariants?: string[];
}

// ── Context handed to the admission composite ────────────────────────────

/**
 * Variant-scope context for the admission composite — everything Phase 2's
 * router needs to refine an already-soul-routed score into a variant-scope
 * score. Built once per pipeline tick from:
 *
 *   - The Soul DIDs of every active soul (their `variants[]` declarations)
 *   - Pre-computed per-variant Sα₁/Sα₂ scores (Phase 2/3 scorers populate)
 *   - The active backlog's work-item targeting (one entry per work item)
 *   - Per-Soul `variantConfig` overrides (resolved against per-org defaults)
 *
 * When `undefined` is passed to `computeVariantScopedScores`, the router
 * preserves single-soul Sα₁/Sα₂ semantics unchanged (backward-compatible).
 */
export interface VariantContext {
  /**
   * Variant overlays keyed by soulId. Source of truth for which variant IDs
   * are valid per Soul + their `audienceCharacteristics` / `designOverrides`.
   */
  variantsBySoul: Record<string, VariantOverlay[]>;
  /**
   * Pre-computed per-variant scores, keyed first by soulId then by variantId.
   * Missing entries fall back to the work item's soul-aggregate Sα₁/Sα₂.
   */
  variantScores: Record<string, Record<string, VariantScores>>;
  /**
   * Work-item targeting entries — one per work item in the active backlog.
   * Missing entries (or empty `targetedVariants`) → backward-compat soul-scope.
   */
  workItemTargeting?: WorkItemVariantTargeting[];
  /**
   * Per-Soul `variantConfig` overrides (defaults to `{ crossVariantAggregation: 'min' }`
   * when absent). Keyed by soulId.
   */
  configBySoul?: Record<string, VariantConfig>;
}

// ── URI parsing ──────────────────────────────────────────────────────────

/**
 * One parsed targeted-variant reference. Internal use; surfaced via the router
 * for auditability.
 */
export interface ParsedVariantRef {
  soulId: string;
  variantId: string;
  /** The original schema-form string (for round-trip + error reporting). */
  raw: string;
}

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Parse a targeted-variant reference. Accepts both the schema's accepted forms:
 *
 *   1. Slug-pair: `engage/small-utility` (RFC-0017 §6.1 Work Item schema pattern)
 *   2. Full DID: `did:platform-x:soul:engage/variant:small-utility` (OQ-6)
 *
 * Returns `undefined` for any malformed input — caller's responsibility to
 * surface diagnostics. The schema-side validator is Phase 1's responsibility;
 * the router treats any malformed entry as ignorable (silent skip + caller can
 * count them via the returned `parsedTargets`/`malformedTargets` split if
 * desired).
 */
export function parseTargetedVariantRef(raw: string): ParsedVariantRef | undefined {
  // Form 2 (full DID, OQ-6): `did:<method>:soul:<soul-id>/variant:<variant-id>`
  //   - `<method>` = one OR more colon-separated segments (e.g. `platform-x`,
  //     `platform-x:tenant-1`). Any non-empty sequence of `[^:]+` segments is
  //     accepted; the schema validator (Phase 1) is the source-of-truth on
  //     well-formedness — Phase 2's router accepts any string that ends in
  //     `:soul:<soul-id>/variant:<variant-id>` with valid slug components.
  const didMatch = /^did(?::[^:]+)+:soul:([a-z][a-z0-9-]*)\/variant:([a-z][a-z0-9-]*)$/.exec(raw);
  if (didMatch) {
    return { soulId: didMatch[1], variantId: didMatch[2], raw };
  }
  // Form 1 (slug-pair): `<soul-id>/<variant-id>` (RFC-0017 §6.1 pattern)
  const slugMatch = /^([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/.exec(raw);
  if (slugMatch) {
    const soulId = slugMatch[1];
    const variantId = slugMatch[2];
    if (SLUG_RE.test(soulId) && SLUG_RE.test(variantId)) {
      return { soulId, variantId, raw };
    }
  }
  return undefined;
}

// ── resolveTargetedVariants ──────────────────────────────────────────────

/**
 * Resolve the set of targeted (soulId, variantId) pairs for a given work item.
 *
 * Algorithm:
 * 1. Find the work item by case-insensitive ID match in `workItemTargeting`.
 * 2. Parse each entry of `targetedVariants[]` via `parseTargetedVariantRef`.
 * 3. Filter parsed refs against `variantsBySoul` — a (soulId, variantId) pair
 *    only survives if the soul exists AND the variantId is declared on it.
 * 4. Return the validated intersection (empty = backward-compat soul-scope).
 *
 * Returns an empty array (NOT undefined) in all "no variant routing" cases
 * — the caller distinguishes single-variant / multi-variant / soul-scope
 * paths by checking `.length`.
 */
export function resolveTargetedVariants(
  workItemId: string,
  variantCtx: VariantContext | undefined,
): ParsedVariantRef[] {
  if (!variantCtx || !variantCtx.workItemTargeting || variantCtx.workItemTargeting.length === 0) {
    return [];
  }
  const normalizedId = workItemId.toLowerCase();
  const entry = variantCtx.workItemTargeting.find((e) => e.id.toLowerCase() === normalizedId);
  if (!entry || !entry.targetedVariants || entry.targetedVariants.length === 0) {
    return [];
  }
  const out: ParsedVariantRef[] = [];
  for (const raw of entry.targetedVariants) {
    const parsed = parseTargetedVariantRef(raw);
    if (!parsed) continue;
    const variants = variantCtx.variantsBySoul[parsed.soulId];
    if (!variants) continue;
    if (!variants.some((v) => v.id === parsed.variantId)) continue;
    out.push(parsed);
  }
  return out;
}

// ── applyCrossVariantRule ────────────────────────────────────────────────

/**
 * Apply a per-Soul `crossVariantAggregation` rule over per-variant scores.
 * Mirrors `applyCrossSoulRule` in `tessellation-admission.ts` but restricted
 * to the three variant-scope-meaningful aggregations (`min` / `max` / `mean`).
 *
 * @param values   - Per-variant score samples (one per targeted variant).
 * @param rule     - The aggregation rule (defaults to `min` per OQ-4).
 * @param fallback - Returned when `values` is empty.
 */
export function applyCrossVariantRule(
  values: number[],
  rule: VariantAggregationRule | undefined,
  fallback = 0.5,
): number {
  if (values.length === 0) return fallback;
  switch (rule ?? 'min') {
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'mean':
      return values.reduce((sum, v) => sum + v, 0) / values.length;
  }
}

// ── computeVariantScopedScores (the router) ──────────────────────────────

/**
 * Result of variant-scope resolution. Composed with `TessellatedSaResult` by
 * the admission composite — variant routing only takes effect when the work
 * item declares `targetedVariants` AND the variant context is wired in.
 */
export interface VariantScopedSaResult {
  /** Resolved Sα₁ value in [0, 1] (variant-scoped or fallback). */
  sa1: number;
  /** Resolved Sα₂ value in [0, 1] (variant-scoped or fallback). */
  sa2: number;
  /**
   * Routing path taken (matches RFC-0017 §5.4 case labels).
   *
   * - `'no-variant-routing'`    — no context or no targeted variants declared;
   *                                fallback Sα₁/Sα₂ preserved (backward-compat).
   * - `'single-variant'`        — exactly one targeted variant; per-variant Sα₁/Sα₂ used.
   * - `'multi-variant'`         — multiple targeted variants; crossVariantAggregation applied.
   */
  routingPath: 'no-variant-routing' | 'single-variant' | 'multi-variant';
  /** Targeted variant references that contributed to the aggregation. */
  targetedVariants: ParsedVariantRef[];
  /**
   * The aggregation rule used when `routingPath === 'multi-variant'`. Undefined
   * for `single-variant` and `no-variant-routing` paths. Exposed for audit.
   */
  aggregationRule?: VariantAggregationRule;
}

/**
 * Compute the variant-scope-refined Sα₁ + Sα₂ for a work item.
 *
 * This runs AFTER tessellation soul-resolution: the caller has already routed
 * the work item to its target Soul(s) and obtained the soul-aggregate Sα₁ /
 * Sα₂ (the `fallbackSa1` / `fallbackSa2` arguments). Variant routing refines
 * those values when the work item declares `targetedVariants` of one of the
 * affected Souls (RFC-0017 §5.4).
 *
 * **Cross-soul + cross-variant interaction** (RFC-0017 §6.2 last bullet):
 * "When a work item targets variants in MULTIPLE souls, the cross-soul
 * aggregation rule applies at the soul level FIRST, then the cross-variant
 * rule applies within each soul." Phase 2 implements the per-Soul-scope
 * variant aggregation; the per-Soul `crossVariantAggregation` config picks
 * which rule applies inside each Soul. When variants span multiple souls,
 * each soul's per-variant scores are aggregated by THAT soul's config; the
 * resulting per-soul scores are then aggregated by the cross-soul rule
 * (handled by `tessellation-admission.ts`). At the variant-scope layer we
 * therefore aggregate per-Soul, then aggregate per-Soul-results by `min`
 * (the safest cross-soul aggregation default — matches RFC-0009 §7.2).
 *
 * @param workItemId    - The canonical work item ID.
 * @param fallbackSa1   - Soul-scope Sα₁ to use when no variant routing applies.
 * @param fallbackSa2   - Soul-scope Sα₂ to use when no variant routing applies.
 * @param variantCtx    - Variant-scope context; undefined → backward-compat passthrough.
 */
export function computeVariantScopedScores(
  workItemId: string,
  fallbackSa1: number,
  fallbackSa2: number,
  variantCtx: VariantContext | undefined,
): VariantScopedSaResult {
  const targetedVariants = resolveTargetedVariants(workItemId, variantCtx);

  // ── Backward-compat: no targeted variants → soul-scope passthrough ──
  if (targetedVariants.length === 0 || !variantCtx) {
    return {
      sa1: fallbackSa1,
      sa2: fallbackSa2,
      routingPath: 'no-variant-routing',
      targetedVariants: [],
    };
  }

  // ── Group targets by Soul (RFC-0017 §6.2 cross-soul layering) ──
  const bySoul = new Map<string, ParsedVariantRef[]>();
  for (const ref of targetedVariants) {
    const bucket = bySoul.get(ref.soulId);
    if (bucket) bucket.push(ref);
    else bySoul.set(ref.soulId, [ref]);
  }

  // ── Single-variant fast path ──
  if (targetedVariants.length === 1) {
    const ref = targetedVariants[0];
    const scores = variantCtx.variantScores[ref.soulId]?.[ref.variantId];
    return {
      sa1: scores?.sa1 ?? fallbackSa1,
      sa2: scores?.sa2 ?? fallbackSa2,
      routingPath: 'single-variant',
      targetedVariants,
    };
  }

  // ── Multi-variant: aggregate per-Soul, then aggregate cross-Soul ──
  // Per-Soul aggregation uses the Soul's `crossVariantAggregation` config
  // (default `min`). Cross-Soul aggregation between Souls (rare path) uses
  // `min` as the safest default (RFC-0017 §6.2 layering + RFC-0009 §7.2).
  const perSoulSa1: number[] = [];
  const perSoulSa2: number[] = [];
  // Track the rule used by the first (or only) Soul for auditability —
  // in single-Soul multi-variant (the common case) this faithfully reports
  // which rule shaped the aggregation. For cross-Soul multi-variant we
  // surface the FIRST Soul's rule for transparency; downstream callers
  // that need the full per-Soul rule map can inspect `configBySoul` directly.
  let firstAggregationRule: VariantAggregationRule | undefined;
  for (const [soulId, refs] of bySoul) {
    const cfg = variantCtx.configBySoul?.[soulId];
    const rule: VariantAggregationRule = cfg?.crossVariantAggregation ?? 'min';
    if (firstAggregationRule === undefined) firstAggregationRule = rule;
    const sa1Samples: number[] = [];
    const sa2Samples: number[] = [];
    for (const ref of refs) {
      const scores = variantCtx.variantScores[soulId]?.[ref.variantId];
      sa1Samples.push(scores?.sa1 ?? fallbackSa1);
      sa2Samples.push(scores?.sa2 ?? fallbackSa2);
    }
    perSoulSa1.push(applyCrossVariantRule(sa1Samples, rule, fallbackSa1));
    perSoulSa2.push(applyCrossVariantRule(sa2Samples, rule, fallbackSa2));
  }

  // Cross-soul layering (§6.2): use `min` between Souls — safety-critical
  // default consistent with RFC-0009 §7.2 cross-soul aggregation.
  const sa1 = perSoulSa1.length === 1 ? perSoulSa1[0] : Math.min(...perSoulSa1);
  const sa2 = perSoulSa2.length === 1 ? perSoulSa2[0] : Math.min(...perSoulSa2);

  return {
    sa1,
    sa2,
    routingPath: 'multi-variant',
    targetedVariants,
    aggregationRule: firstAggregationRule ?? 'min',
  };
}

// ── Cross-soul + cross-variant compatibility note ────────────────────────

/**
 * Helper for callers that already hold a `Tessellation` (sibling SoulScope router)
 * and want to lift Soul-scope tessellation aggregation rule into the
 * variant-scope cross-Soul layer. Currently the variant-scope cross-Soul
 * layer always uses `min` (RFC-0017 §6.2 + RFC-0009 §7.2 safety-critical
 * default). This helper is reserved for a future per-Soul override of the
 * cross-Soul cross-variant layer; today it returns `min` unconditionally.
 *
 * Exported for documentation + so callers can `import` the boundary rather
 * than hardcode `'min'` in two places.
 */
export function defaultCrossSoulVariantRule(_tessellation?: Tessellation): VariantAggregationRule {
  // Phase 2 default: always `min` between souls when variants span multiple
  // souls. Future Phase-3+ revisits per-tessellation override.
  return 'min';
}
