/**
 * RFC-0009 Phase 2.2 — per-soul DSB resolution tests.
 *
 * Covers acceptance criteria:
 *   AC #2: DSB reader resolves per-soul DSB when admission routes through soul scope
 *   AC #4: Per-soul DSB extends platform-root DSB additively per §6.3 resolution rules
 *   AC #5: Backwards-compat: single-DSB layout still works (legacy platforms)
 *   AC #6: Test coverage: single DSB / multi-soul DSB / DSB-resolution edge cases
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSoulDsb,
  resolveAllSoulDsbs,
  mergeSoulDsb,
  mergeSoulDsbSpec,
} from './soul-dsb-resolver.js';
import type { DesignSystemBinding } from './types.js';

// ── Fixture builders ──────────────────────────────────────────────────

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function makePlatformDsb(overrides: Partial<DesignSystemBinding> = {}): DesignSystemBinding {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignSystemBinding',
    metadata: {
      name: 'platform-dsb',
      labels: { 'ai-sdlc/scope': 'platform' },
    },
    spec: {
      stewardship: {
        designAuthority: {
          principals: ['morgan@example.com'],
          scope: ['designPrinciples', 'brandIdentity'],
        },
        engineeringAuthority: {
          principals: ['dominique@example.com'],
          scope: ['tokenSchema', 'complianceRules'],
        },
      },
      designToolAuthority: 'specification',
      tokens: {
        provider: 'tokens-studio',
        format: 'w3c-dtcg',
        source: { repository: 'platform/design-tokens', branch: 'main', path: 'tokens/' },
        versionPolicy: 'minor',
      },
      catalog: {
        provider: 'storybook',
        source: { storybookUrl: 'https://platform.storybook.io' },
      },
      compliance: {
        coverage: { minimum: 0.6, target: 0.8 },
        disallowHardcoded: [
          {
            category: 'color',
            pattern: '#[0-9a-fA-F]{3,6}',
            message: 'Use design tokens for colors.',
          },
        ],
      },
      designReview: {
        required: true,
        reviewers: ['morgan@example.com'],
        scope: ['visual-quality', 'accessibility-intent'],
      },
    },
    status: {
      catalogHealth: { totalComponents: 50, documentedComponents: 30, coveragePercent: 60 },
      tokenCompliance: { currentCoverage: 0.72, violations: 5, trend: 'improving' },
    },
    ...overrides,
  };
}

function makeSoulDsb(
  soulSlug: string,
  overrides: Partial<DesignSystemBinding> = {},
): DesignSystemBinding {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignSystemBinding',
    metadata: {
      name: `${soulSlug}-dsb`,
      labels: { 'ai-sdlc/soul': soulSlug },
    },
    spec: {
      extends: 'platform-dsb',
      stewardship: {
        designAuthority: {
          principals: [`${soulSlug}-designer@example.com`],
          scope: [`${soulSlug}-specific`],
        },
        engineeringAuthority: {
          principals: ['dominique@example.com'],
          scope: [`${soulSlug}-engineering`],
        },
      },
      designToolAuthority: 'specification',
      tokens: {
        provider: 'tokens-studio',
        format: 'w3c-dtcg',
        source: {
          repository: `platform/design-tokens`,
          branch: `soul/${soulSlug}`,
          path: `tokens/souls/${soulSlug}/`,
        },
        versionPolicy: 'minor',
      },
      catalog: {
        provider: 'storybook',
        source: { storybookUrl: `https://${soulSlug}.storybook.io` },
      },
      compliance: {
        coverage: { minimum: 0.7, target: 0.9 },
      },
    },
    status: {
      catalogHealth: { totalComponents: 20, documentedComponents: 18, coveragePercent: 90 },
      tokenCompliance: { currentCoverage: 0.85, violations: 1, trend: 'improving' },
    },
    ...overrides,
  };
}

// ── AC #5: Backward-compat — single-DSB layout ────────────────────────

describe('resolveSoulDsb — backward-compat (AC #5)', () => {
  it('returns the platform DSB unchanged when no soul DSB is provided', () => {
    const platform = makePlatformDsb();
    const result = resolveSoulDsb('soul-a', platform, undefined);

    expect(result.dsb).toBe(platform); // same reference — no copy
    expect(result.hasSoulOverride).toBe(false);
    expect(result.soulSlug).toBe('soul-a');
  });

  it('returns undefined when no platform DSB exists (pre-design-system phase)', () => {
    const result = resolveSoulDsb('soul-a', undefined, undefined);

    expect(result.dsb).toBeUndefined();
    expect(result.hasSoulOverride).toBe(false);
    expect(result.soulSlug).toBe('soul-a');
  });

  it('returns undefined when platform DSB is absent even if a soul DSB is given', () => {
    // Edge case: soul DSB without a platform DSB (misconfigured setup)
    const soulDsb = makeSoulDsb('soul-a');
    const result = resolveSoulDsb('soul-a', undefined, soulDsb);

    expect(result.dsb).toBeUndefined();
    expect(result.hasSoulOverride).toBe(false);
  });

  it('single-DSB admission scoring still works: resolved DSB = platform DSB', () => {
    const platform = makePlatformDsb();
    const { dsb } = resolveSoulDsb('soul-a', platform, undefined);

    // Downstream code can read DSB status for Eρ₄ scoring unchanged
    expect(dsb?.status?.catalogHealth?.coveragePercent).toBe(60);
    expect(dsb?.status?.tokenCompliance?.currentCoverage).toBe(0.72);
  });
});

// ── AC #2: DSB reader resolves per-soul DSB ───────────────────────────

describe('resolveSoulDsb — per-soul DSB resolution (AC #2)', () => {
  it('returns hasSoulOverride=true when a soul DSB is merged', () => {
    const platform = makePlatformDsb();
    const soul = makeSoulDsb('soul-a');
    const result = resolveSoulDsb('soul-a', platform, soul);

    expect(result.hasSoulOverride).toBe(true);
    expect(result.soulSlug).toBe('soul-a');
    expect(result.dsb).toBeDefined();
  });

  it('merged DSB metadata.name encodes soul slug for traceability', () => {
    const platform = makePlatformDsb();
    const soul = makeSoulDsb('soul-a');
    const { dsb } = resolveSoulDsb('soul-a', platform, soul);

    expect(dsb?.metadata.name).toBe('platform-dsb/soul-a');
  });

  it('merged DSB metadata.labels include soul tag', () => {
    const platform = makePlatformDsb();
    const soul = makeSoulDsb('soul-a');
    const { dsb } = resolveSoulDsb('soul-a', platform, soul);

    expect(dsb?.metadata.labels?.['ai-sdlc/soul']).toBe('soul-a');
  });

  it('merged DSB metadata.annotations record the inheritance chain', () => {
    const platform = makePlatformDsb();
    const soul = makeSoulDsb('soul-a');
    const { dsb } = resolveSoulDsb('soul-a', platform, soul);

    expect(dsb?.metadata.annotations?.['ai-sdlc/soul-slug']).toBe('soul-a');
    expect(dsb?.metadata.annotations?.['ai-sdlc/extends-platform-dsb']).toBe('platform-dsb');
  });
});

// ── AC #4: Additive resolution rules ─────────────────────────────────

describe('mergeSoulDsb — additive resolution rules (AC #4)', () => {
  it('soul stewardship principals are UNIONED with platform principals', () => {
    const platform = makePlatformDsb();
    const soul = makeSoulDsb('soul-a');
    const merged = mergeSoulDsb('soul-a', platform, soul);

    const designPrincipals = merged.spec.stewardship.designAuthority.principals;
    // Both morgan@example.com (platform) and soul-a-designer@example.com (soul)
    expect(designPrincipals).toContain('morgan@example.com');
    expect(designPrincipals).toContain('soul-a-designer@example.com');
  });

  it('soul compliance disallowHardcoded rules are ADDED on top of platform rules', () => {
    const platform = makePlatformDsb();
    const soul = makeSoulDsb('soul-a', {
      spec: {
        ...makeSoulDsb('soul-a').spec,
        compliance: {
          coverage: { minimum: 0.8 },
          disallowHardcoded: [
            {
              category: 'spacing',
              pattern: '\\d+px',
              message: 'Use spacing tokens.',
            },
          ],
        },
      },
    });
    const merged = mergeSoulDsb('soul-a', platform, soul);

    // Platform had 1 rule (color), soul adds 1 rule (spacing) → 2 rules total
    expect(merged.spec.compliance.disallowHardcoded).toHaveLength(2);
    const categories = merged.spec.compliance.disallowHardcoded!.map((r) => r.category);
    expect(categories).toContain('color');
    expect(categories).toContain('spacing');
  });

  it('soul coverage threshold overrides platform coverage threshold', () => {
    const platform = makePlatformDsb(); // coverage.minimum = 0.6
    const soul = makeSoulDsb('soul-a'); // coverage.minimum = 0.7
    const merged = mergeSoulDsb('soul-a', platform, soul);

    // Soul-level threshold wins (stricter requirement)
    expect(merged.spec.compliance.coverage.minimum).toBe(0.7);
    expect(merged.spec.compliance.coverage.target).toBe(0.9);
  });

  it('soul design review reviewers are UNIONED with platform reviewers', () => {
    const platform = makePlatformDsb(); // reviewers: [morgan@example.com]
    const soulBase = makeSoulDsb('soul-a');
    const soul: DesignSystemBinding = {
      ...soulBase,
      spec: {
        ...soulBase.spec,
        designReview: {
          required: true,
          reviewers: ['soul-a-reviewer@example.com'],
        },
      },
    };
    const merged = mergeSoulDsb('soul-a', platform, soul);

    const reviewers = merged.spec.designReview?.reviewers ?? [];
    expect(reviewers).toContain('morgan@example.com');
    expect(reviewers).toContain('soul-a-reviewer@example.com');
  });

  it('soul tokens source overrides platform tokens source (soul wins, platform fills gaps)', () => {
    const platform = makePlatformDsb();
    const soul = makeSoulDsb('soul-a');
    const merged = mergeSoulDsb('soul-a', platform, soul);

    // Soul uses soul-specific token branch
    expect(merged.spec.tokens.source.branch).toBe('soul/soul-a');
    expect(merged.spec.tokens.source.path).toBe('tokens/souls/soul-a/');
    // Provider/format fall through to platform when soul matches
    expect(merged.spec.tokens.provider).toBe('tokens-studio');
  });

  it('soul catalog storybookUrl overrides platform URL', () => {
    const platform = makePlatformDsb();
    const soul = makeSoulDsb('soul-a');
    const merged = mergeSoulDsb('soul-a', platform, soul);

    expect(merged.spec.catalog.source?.storybookUrl).toBe('https://soul-a.storybook.io');
  });

  it('soul status overrides platform status for Eρ₄ scoring', () => {
    const platform = makePlatformDsb(); // catalogHealth.coveragePercent = 60, tokenCompliance = 0.72
    const soul = makeSoulDsb('soul-a'); // catalogHealth.coveragePercent = 90, tokenCompliance = 0.85
    const merged = mergeSoulDsb('soul-a', platform, soul);

    // Soul status wins — this is the key Eρ₄ lift for soul-bounded work
    expect(merged.status?.catalogHealth?.coveragePercent).toBe(90);
    expect(merged.status?.tokenCompliance?.currentCoverage).toBe(0.85);
  });

  it('platform status fills in when soul status is absent', () => {
    const platform = makePlatformDsb(); // has full status
    const soulBase = makeSoulDsb('soul-b');
    const soul: DesignSystemBinding = { ...soulBase, status: undefined };
    const merged = mergeSoulDsb('soul-b', platform, soul);

    // Platform status provides fallback
    expect(merged.status?.catalogHealth?.coveragePercent).toBe(60);
    expect(merged.status?.tokenCompliance?.currentCoverage).toBe(0.72);
  });

  it('soul platform-level stewardship scope is UNIONED (not replaced)', () => {
    const platform = makePlatformDsb();
    const soul = makeSoulDsb('soul-a');
    const merged = mergeSoulDsb('soul-a', platform, soul);

    const scope = merged.spec.stewardship.designAuthority.scope;
    // Platform: designPrinciples, brandIdentity; Soul: soul-a-specific
    expect(scope).toContain('designPrinciples');
    expect(scope).toContain('brandIdentity');
    expect(scope).toContain('soul-a-specific');
  });

  it('extends field in merged spec documents the inheritance chain', () => {
    const platform = makePlatformDsb();
    const soul = makeSoulDsb('soul-a'); // soul.spec.extends = 'platform-dsb'
    const merged = mergeSoulDsb('soul-a', platform, soul);

    expect(merged.spec.extends).toBe('platform-dsb');
  });

  it('deduplicates principals when soul and platform share a principal', () => {
    const platform = makePlatformDsb();
    // Soul lists the same engineer as platform
    const soulBase = makeSoulDsb('soul-a');
    const soul: DesignSystemBinding = {
      ...soulBase,
      spec: {
        ...soulBase.spec,
        stewardship: {
          designAuthority: {
            principals: ['morgan@example.com'], // same as platform
            scope: ['soul-a-specific'],
          },
          engineeringAuthority: {
            principals: ['dominique@example.com'], // same as platform
            scope: ['soul-a-engineering'],
          },
        },
      },
    };
    const merged = mergeSoulDsb('soul-a', platform, soul);

    const designPrincipals = merged.spec.stewardship.designAuthority.principals;
    // Should not duplicate morgan@example.com
    const morgans = designPrincipals.filter((p) => p === 'morgan@example.com');
    expect(morgans).toHaveLength(1);
  });
});

// ── AC #6: Multi-soul DSB resolution ─────────────────────────────────

describe('resolveAllSoulDsbs — multi-soul tessellation (AC #6)', () => {
  it('resolves all souls in a tessellation', () => {
    const platform = makePlatformDsb();
    const soulA = makeSoulDsb('soul-a');
    const soulB = makeSoulDsb('soul-b');

    const results = resolveAllSoulDsbs(['soul-a', 'soul-b', 'soul-c'], platform, {
      'soul-a': soulA,
      'soul-b': soulB,
      'soul-c': undefined,
    });

    expect(results['soul-a'].hasSoulOverride).toBe(true);
    expect(results['soul-b'].hasSoulOverride).toBe(true);
    expect(results['soul-c'].hasSoulOverride).toBe(false); // falls back to platform
    expect(results['soul-c'].dsb).toBe(platform); // exact same reference
  });

  it('each soul has an independent merge (no cross-soul contamination)', () => {
    const platform = makePlatformDsb();
    const soulA = makeSoulDsb('soul-a');
    const soulB = makeSoulDsb('soul-b');

    const results = resolveAllSoulDsbs(['soul-a', 'soul-b'], platform, {
      'soul-a': soulA,
      'soul-b': soulB,
    });

    const aSlug = results['soul-a'].dsb?.metadata.labels?.['ai-sdlc/soul'];
    const bSlug = results['soul-b'].dsb?.metadata.labels?.['ai-sdlc/soul'];
    expect(aSlug).toBe('soul-a');
    expect(bSlug).toBe('soul-b');
  });

  it('all souls without a per-soul DSB fall back to platform DSB (backward-compat)', () => {
    const platform = makePlatformDsb();
    const results = resolveAllSoulDsbs(['soul-x', 'soul-y'], platform, {});

    expect(results['soul-x'].dsb).toBe(platform);
    expect(results['soul-y'].dsb).toBe(platform);
    expect(results['soul-x'].hasSoulOverride).toBe(false);
    expect(results['soul-y'].hasSoulOverride).toBe(false);
  });

  it('returns empty record for empty soul list', () => {
    const platform = makePlatformDsb();
    const results = resolveAllSoulDsbs([], platform, {});
    expect(Object.keys(results)).toHaveLength(0);
  });

  it('returns all undefined DSBs when no platform DSB exists', () => {
    const results = resolveAllSoulDsbs(['soul-a', 'soul-b'], undefined, {
      'soul-a': makeSoulDsb('soul-a'),
    });

    expect(results['soul-a'].dsb).toBeUndefined();
    expect(results['soul-b'].dsb).toBeUndefined();
  });
});

// ── AC #6: Edge cases ─────────────────────────────────────────────────

describe('mergeSoulDsbSpec — edge cases (AC #6)', () => {
  it('soul with no disallowHardcoded rules inherits platform rules only', () => {
    const platform = makePlatformDsb();
    const soulBase = makeSoulDsb('soul-a');
    // Soul compliance has no disallowHardcoded (only coverage)
    const soul: DesignSystemBinding = {
      ...soulBase,
      spec: {
        ...soulBase.spec,
        compliance: { coverage: { minimum: 0.8 } },
      },
    };
    const merged = mergeSoulDsb('soul-a', platform, soul);

    // Platform's disallowHardcoded rules pass through unchanged
    expect(merged.spec.compliance.disallowHardcoded).toHaveLength(1);
    expect(merged.spec.compliance.disallowHardcoded![0].category).toBe('color');
  });

  it('soul with no designReview inherits platform designReview', () => {
    const platform = makePlatformDsb(); // has designReview
    const soulBase = makeSoulDsb('soul-a');
    const soul: DesignSystemBinding = {
      ...soulBase,
      spec: {
        ...soulBase.spec,
        designReview: undefined,
      },
    };
    const merged = mergeSoulDsb('soul-a', platform, soul);

    expect(merged.spec.designReview?.required).toBe(true);
    expect(merged.spec.designReview?.reviewers).toContain('morgan@example.com');
  });

  it('soul without extends field still merges correctly', () => {
    const platform = makePlatformDsb();
    const soulBase = makeSoulDsb('soul-a');
    const soul: DesignSystemBinding = {
      ...soulBase,
      spec: { ...soulBase.spec, extends: undefined },
    };
    // Platform also has no extends
    const platformWithoutExtends: DesignSystemBinding = {
      ...platform,
      spec: { ...platform.spec, extends: undefined },
    };
    const merged = mergeSoulDsb('soul-a', platformWithoutExtends, soul);

    // Both extends are undefined → merged extends is undefined (no orphan reference)
    expect(merged.spec.extends).toBeUndefined();
  });

  it('mergeSoulDsbSpec is a pure function — inputs are not mutated', () => {
    const platformSpec = makePlatformDsb().spec;
    const soulSpec = makeSoulDsb('soul-a').spec;

    const originalPlatformRules = [...(platformSpec.compliance.disallowHardcoded ?? [])];
    const originalPlatformPrincipals = [...platformSpec.stewardship.designAuthority.principals];

    mergeSoulDsbSpec(platformSpec, soulSpec);

    // Platform spec is unchanged
    expect(platformSpec.compliance.disallowHardcoded).toEqual(originalPlatformRules);
    expect(platformSpec.stewardship.designAuthority.principals).toEqual(originalPlatformPrincipals);
  });
});
