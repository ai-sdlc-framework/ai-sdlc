/**
 * Per-soul DSB resolution logic for RFC-0009 Phase 2.2.
 *
 * Resolves the effective DesignSystemBinding for a given soul by merging
 * the platform-root DSB with the per-soul DSB additively, per the §6
 * resolution rules:
 *
 *   1. Start with the platform-root DSB as the base.
 *   2. Apply per-soul DSB fields additively (soul fields extend, not replace).
 *   3. Fields absent from the per-soul DSB fall through to the platform-root DSB.
 *
 * The `spec.extends` field on the per-soul DSB conventionally references the
 * platform-root DSB name. The resolver honours this for documentation purposes
 * but does not require it — the merge is performed structurally regardless.
 *
 * Backward-compatible: when no per-soul DSB is provided, the platform-root
 * DSB is returned unchanged (single-DSB layout preserved).
 *
 * @see RFC-0009 §6 — "Admission Composite Extension"
 * @see RFC-0009 §10 Phase 2 — "Per-soul DSB authoring"
 */

import type {
  DesignSystemBinding,
  DesignSystemBindingSpec,
  DesignSystemBindingStatus,
  Stewardship,
  ComplianceConfig,
  DesignReviewConfig,
  TokenConfig,
  CatalogConfig,
  VisualRegressionConfig,
} from './types.js';

// ── Public types ──────────────────────────────────────────────────────

/**
 * Result of resolving the effective DSB for a soul.
 */
export interface SoulDsbResolution {
  /**
   * The effective DesignSystemBinding for this soul.
   * - `soulDsb` present: merged soul-over-platform DSB
   * - `soulDsb` absent: platform DSB returned unchanged (backward-compat)
   * - `platformDsb` absent: undefined (no DSB configured for this platform)
   */
  dsb: DesignSystemBinding | undefined;
  /**
   * Whether a per-soul DSB was found and merged.
   * `false` means the resolution fell back to the platform-root DSB.
   */
  hasSoulOverride: boolean;
  /**
   * The soul slug this resolution is for (diagnostic).
   */
  soulSlug: string;
}

// ── Merge helpers ─────────────────────────────────────────────────────

/**
 * Merge two `Stewardship` blocks additively.
 *
 * Soul-level authorities extend the platform-level ones:
 * - principals are concatenated (union); soul principals added to platform set
 * - scope lists are concatenated (union)
 * - `changeApproval` defers to soul when present, else platform
 */
function mergeStewardship(platform: Stewardship, soul: Stewardship): Stewardship {
  const designPrincipals = unionStrings(
    platform.designAuthority.principals,
    soul.designAuthority.principals,
  );
  const engineeringPrincipals = unionStrings(
    platform.engineeringAuthority.principals,
    soul.engineeringAuthority.principals,
  );
  return {
    designAuthority: {
      principals: designPrincipals,
      scope: unionStrings(platform.designAuthority.scope, soul.designAuthority.scope),
    },
    engineeringAuthority: {
      principals: engineeringPrincipals,
      scope: unionStrings(platform.engineeringAuthority.scope, soul.engineeringAuthority.scope),
    },
    ...((soul.sharedAuthority ?? platform.sharedAuthority)
      ? { sharedAuthority: soul.sharedAuthority ?? platform.sharedAuthority }
      : {}),
    ...((soul.changeApproval ?? platform.changeApproval)
      ? { changeApproval: soul.changeApproval ?? platform.changeApproval }
      : {}),
  };
}

/**
 * Merge two `ComplianceConfig` blocks additively.
 *
 * Soul-level compliance rules are added on top of platform rules:
 * - `disallowHardcoded` rules are concatenated (both sets apply)
 * - `coverage` defers to soul when present, else platform
 */
function mergeCompliance(platform: ComplianceConfig, soul: ComplianceConfig): ComplianceConfig {
  return {
    disallowHardcoded: [...(platform.disallowHardcoded ?? []), ...(soul.disallowHardcoded ?? [])],
    coverage: soul.coverage ?? platform.coverage,
  };
}

/**
 * Merge two `DesignReviewConfig` blocks additively.
 *
 * Soul reviewers extend (union with) platform reviewers.
 * All other fields defer to soul when present, else platform.
 */
function mergeDesignReview(
  platform: DesignReviewConfig,
  soul: DesignReviewConfig,
): DesignReviewConfig {
  return {
    required: soul.required ?? platform.required,
    reviewers: unionStrings(platform.reviewers ?? [], soul.reviewers ?? []),
    scope: soul.scope ?? platform.scope,
    triggerConditions: soul.triggerConditions ?? platform.triggerConditions,
  };
}

/**
 * Merge two token configs. Soul-level tokens override platform-level tokens.
 * Absent soul fields fall through to the platform config.
 */
function mergeTokenConfig(platform: TokenConfig, soul: Partial<TokenConfig>): TokenConfig {
  return {
    provider: soul.provider ?? platform.provider,
    format: soul.format ?? platform.format,
    source: soul.source ?? platform.source,
    versionPolicy: soul.versionPolicy ?? platform.versionPolicy,
    ...((soul.pinnedVersion ?? platform.pinnedVersion)
      ? { pinnedVersion: soul.pinnedVersion ?? platform.pinnedVersion }
      : {}),
    ...((soul.platform ?? platform.platform)
      ? { platform: soul.platform ?? platform.platform }
      : {}),
    ...((soul.sync ?? platform.sync) ? { sync: soul.sync ?? platform.sync } : {}),
  };
}

/**
 * Merge two catalog configs. Soul-level catalog overrides platform-level.
 * Absent soul fields fall through to the platform config.
 */
function mergeCatalogConfig(platform: CatalogConfig, soul: Partial<CatalogConfig>): CatalogConfig {
  return {
    provider: soul.provider ?? platform.provider,
    ...((soul.source ?? platform.source) ? { source: soul.source ?? platform.source } : {}),
    ...((soul.discovery ?? platform.discovery)
      ? { discovery: soul.discovery ?? platform.discovery }
      : {}),
  };
}

/**
 * Merge two `VisualRegressionConfig` blocks. Soul overrides platform.
 */
function mergeVisualRegression(
  platform: VisualRegressionConfig | undefined,
  soul: VisualRegressionConfig | undefined,
): VisualRegressionConfig | undefined {
  if (!soul) return platform;
  if (!platform) return soul;
  return {
    provider: soul.provider ?? platform.provider,
    config: soul.config ?? platform.config,
  };
}

/** Produce a de-duplicated union of two string arrays. */
function unionStrings(a: readonly string[], b: readonly string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

// ── Core merge function ────────────────────────────────────────────────

/**
 * Merge a per-soul DSB spec on top of the platform-root DSB spec.
 *
 * Additive resolution rules (§6.3):
 *  - Stewardship: soul principals and scope are UNIONED with platform
 *  - Compliance: soul rules are ADDED on top of platform rules
 *  - Design review: soul reviewers are UNIONED with platform reviewers
 *  - Tokens / Catalog / Visual Regression: soul value wins; platform fills gaps
 *  - designToolAuthority: soul wins
 *  - extends: soul's extends value is preserved (documenting the inheritance chain)
 *
 * @param platformSpec - the platform-root DesignSystemBinding spec (base)
 * @param soulSpec - the per-soul DesignSystemBinding spec (override layer)
 * @returns the merged spec representing the effective soul DSB
 */
export function mergeSoulDsbSpec(
  platformSpec: DesignSystemBindingSpec,
  soulSpec: DesignSystemBindingSpec,
): DesignSystemBindingSpec {
  return {
    // Preserve the soul DSB's extends reference (documenting inheritance chain)
    extends: soulSpec.extends ?? platformSpec.extends,
    stewardship: mergeStewardship(platformSpec.stewardship, soulSpec.stewardship),
    designToolAuthority: soulSpec.designToolAuthority ?? platformSpec.designToolAuthority,
    tokens: soulSpec.tokens
      ? mergeTokenConfig(platformSpec.tokens, soulSpec.tokens)
      : platformSpec.tokens,
    catalog: soulSpec.catalog
      ? mergeCatalogConfig(platformSpec.catalog, soulSpec.catalog)
      : platformSpec.catalog,
    ...(mergeVisualRegression(platformSpec.visualRegression, soulSpec.visualRegression)
      ? {
          visualRegression: mergeVisualRegression(
            platformSpec.visualRegression,
            soulSpec.visualRegression,
          ),
        }
      : {}),
    compliance: soulSpec.compliance
      ? mergeCompliance(platformSpec.compliance, soulSpec.compliance)
      : platformSpec.compliance,
    ...((soulSpec.designReview ?? platformSpec.designReview)
      ? {
          designReview:
            soulSpec.designReview && platformSpec.designReview
              ? mergeDesignReview(platformSpec.designReview, soulSpec.designReview)
              : (soulSpec.designReview ?? platformSpec.designReview),
        }
      : {}),
  };
}

/**
 * Merge a per-soul `DesignSystemBinding` resource on top of the
 * platform-root `DesignSystemBinding`.
 *
 * Metadata:
 *  - `metadata.name` is set to `<platformName>/<soulSlug>` for traceability
 *  - `metadata.labels` are merged (soul labels override platform labels)
 *
 * Status:
 *  - Soul status is used when present, else platform status
 *
 * @param soulSlug - the soul identifier (used in the merged resource name)
 * @param platformDsb - the platform-root DesignSystemBinding (base)
 * @param soulDsb - the per-soul DesignSystemBinding (override layer)
 * @returns the merged DesignSystemBinding for the soul
 */
export function mergeSoulDsb(
  soulSlug: string,
  platformDsb: DesignSystemBinding,
  soulDsb: DesignSystemBinding,
): DesignSystemBinding {
  const mergedSpec = mergeSoulDsbSpec(platformDsb.spec, soulDsb.spec);

  // Merged status: soul wins for each status sub-field, platform fills gaps
  const mergedStatus: DesignSystemBindingStatus | undefined =
    (soulDsb.status ?? platformDsb.status)
      ? {
          lastTokenSync: soulDsb.status?.lastTokenSync ?? platformDsb.status?.lastTokenSync,
          catalogHealth: soulDsb.status?.catalogHealth ?? platformDsb.status?.catalogHealth,
          tokenCompliance: soulDsb.status?.tokenCompliance ?? platformDsb.status?.tokenCompliance,
          designReview: soulDsb.status?.designReview ?? platformDsb.status?.designReview,
          conditions: [
            ...(platformDsb.status?.conditions ?? []),
            ...(soulDsb.status?.conditions ?? []),
          ],
        }
      : undefined;

  return {
    apiVersion: platformDsb.apiVersion,
    kind: 'DesignSystemBinding',
    metadata: {
      name: `${platformDsb.metadata.name}/${soulSlug}`,
      namespace: soulDsb.metadata.namespace ?? platformDsb.metadata.namespace,
      labels: {
        ...(platformDsb.metadata.labels ?? {}),
        ...(soulDsb.metadata.labels ?? {}),
        'ai-sdlc/soul': soulSlug,
      },
      annotations: {
        ...(platformDsb.metadata.annotations ?? {}),
        ...(soulDsb.metadata.annotations ?? {}),
        'ai-sdlc/soul-slug': soulSlug,
        'ai-sdlc/extends-platform-dsb': platformDsb.metadata.name,
      },
    },
    spec: mergedSpec,
    ...(mergedStatus ? { status: mergedStatus } : {}),
  };
}

// ── Public resolution API ──────────────────────────────────────────────

/**
 * Resolve the effective DesignSystemBinding for a soul.
 *
 * Backward-compatible resolution:
 * - `soulDsb` present → merge soulDsb on top of platformDsb (RFC-0009 §6 rules)
 * - `soulDsb` absent  → return platformDsb unchanged (single-DSB backward-compat)
 * - `platformDsb` absent → return undefined (no DSB for this platform)
 *
 * @param soulSlug - soul identifier (e.g. "soul-a")
 * @param platformDsb - the platform-root DSB (required for tessellated platforms)
 * @param soulDsb - the per-soul DSB from `.ai-sdlc/souls/<slug>/design-system-binding.yaml`
 * @returns resolution result with the effective DSB and diagnostic flags
 */
export function resolveSoulDsb(
  soulSlug: string,
  platformDsb: DesignSystemBinding | undefined,
  soulDsb: DesignSystemBinding | undefined,
): SoulDsbResolution {
  // No platform DSB at all (pre-design-system phase)
  if (!platformDsb) {
    return { dsb: undefined, hasSoulOverride: false, soulSlug };
  }

  // No per-soul DSB — fall back to platform DSB (backward-compat)
  if (!soulDsb) {
    return { dsb: platformDsb, hasSoulOverride: false, soulSlug };
  }

  // Merge per-soul DSB additively on top of platform DSB
  const merged = mergeSoulDsb(soulSlug, platformDsb, soulDsb);
  return { dsb: merged, hasSoulOverride: true, soulSlug };
}

/**
 * Resolve effective DSBs for all souls in a tessellation.
 *
 * Returns a map from soul slug to resolution result.
 * Souls without a per-soul DSB fall back to the platform DSB (backward-compat).
 *
 * @param soulSlugs - all soul slugs in the tessellation
 * @param platformDsb - the platform-root DSB
 * @param soulDsbs - map from soul slug to per-soul DSB (may be partial)
 */
export function resolveAllSoulDsbs(
  soulSlugs: readonly string[],
  platformDsb: DesignSystemBinding | undefined,
  soulDsbs: Readonly<Record<string, DesignSystemBinding | undefined>>,
): Record<string, SoulDsbResolution> {
  const result: Record<string, SoulDsbResolution> = {};
  for (const slug of soulSlugs) {
    result[slug] = resolveSoulDsb(slug, platformDsb, soulDsbs[slug]);
  }
  return result;
}
