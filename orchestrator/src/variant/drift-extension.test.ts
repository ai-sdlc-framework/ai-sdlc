/**
 * RFC-0017 Phase 3 — Eτ_tessellation_drift variant-scoped extension tests.
 *
 * AC #4: Eτ_tessellation_drift extended for variant-scoped scans; emits
 * `Decision: variant-design-intent-drift`.
 */

import { describe, it, expect } from 'vitest';

import {
  detectVariantDrift,
  type VariantDriftExtensionInput,
  type VariantDesignIntentDriftEvent,
} from './drift-extension.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const variantsBySoul = {
  'spry-engage': [
    { id: 'small-utility', audienceCharacteristics: { segments: ['municipal-small'] } },
    { id: 'enterprise', audienceCharacteristics: { segments: ['municipal-large'] } },
  ],
};

const cleanSubstrateFile = {
  path: 'src/shared/event-bus.ts',
  contents: `
export function publishEvent(type: string, payload: unknown) {
  return { type, payload, timestamp: new Date().toISOString() };
}
`,
};

const variantLeakingFile = {
  path: 'src/shared/theme-provider.ts',
  contents: `
// Theme configuration for all products
function getTheme(soulId: string) {
  // TODO: migrate these variant-specific branches
  if (variant === 'small-utility') {
    return { density: 'comfortable', radius: 'rounded' };
  }
  return { density: 'compact', radius: 'default' };
}
`,
};

const literalLeakingFile = {
  path: 'src/shared/routing.ts',
  contents: `
const VARIANT_ROUTES = {
  'small-utility': '/utility',
  'enterprise': '/enterprise',
  default: '/',
};
`,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('detectVariantDrift', () => {
  it('returns optedOut: true when disabled (default)', async () => {
    const input: VariantDriftExtensionInput = {
      tessellatedDid: 'did:platform-x:platform',
      variantsBySoul,
      substrateFiles: [variantLeakingFile],
    };
    const result = await detectVariantDrift(input, {});
    expect(result.optedOut).toBe(true);
    expect(result.events).toHaveLength(0);
  });

  it('returns no events when no substrate files are provided', async () => {
    const input: VariantDriftExtensionInput = {
      tessellatedDid: 'did:platform-x:platform',
      variantsBySoul,
    };
    const result = await detectVariantDrift(input, { enabled: true });
    expect(result.optedOut).toBe(false);
    expect(result.events).toHaveLength(0);
  });

  it('returns no events when substrate files have no variant slug references', async () => {
    const input: VariantDriftExtensionInput = {
      tessellatedDid: 'did:platform-x:platform',
      variantsBySoul,
      substrateFiles: [cleanSubstrateFile],
    };
    const result = await detectVariantDrift(input, { enabled: true });
    expect(result.optedOut).toBe(false);
    expect(result.events).toHaveLength(0);
  });

  it('AC #4: detects variant-conditional drift pattern (if-variant === slug)', async () => {
    const input: VariantDriftExtensionInput = {
      tessellatedDid: 'did:platform-x:platform',
      variantsBySoul,
      substrateFiles: [variantLeakingFile],
    };
    const result = await detectVariantDrift(input, { enabled: true });
    expect(result.optedOut).toBe(false);
    expect(result.events).toHaveLength(1);

    const ev = result.events[0];
    expect(ev.type).toBe('VariantDesignIntentDriftDetected');
    expect(ev.decisionKind).toBe('variant-design-intent-drift');
    expect(ev.routing.blocking).toBe(false);
    expect(ev.routing.catalogStage).toBe('A');
    expect(ev.involvedSouls).toContain('spry-engage');

    const findings = ev.details.findings;
    expect(findings.length).toBeGreaterThan(0);
    const conditionalFinding = findings.find((f) => f.pattern === 'variant-conditional');
    expect(conditionalFinding).toBeDefined();
    expect(conditionalFinding!.variantSlug).toBe('small-utility');
    expect(conditionalFinding!.filePath).toBe('src/shared/theme-provider.ts');
  });

  it('AC #4: detects string-literal drift pattern (bare string references)', async () => {
    const input: VariantDriftExtensionInput = {
      tessellatedDid: 'did:platform-x:platform',
      variantsBySoul,
      substrateFiles: [literalLeakingFile],
    };
    const result = await detectVariantDrift(input, { enabled: true });
    expect(result.events).toHaveLength(1);

    const findings = result.events[0].details.findings;
    const literalFindings = findings.filter((f) => f.pattern === 'string-literal');
    expect(literalFindings.length).toBeGreaterThanOrEqual(2);

    const slugs = literalFindings.map((f) => f.variantSlug).sort();
    expect(slugs).toContain('small-utility');
    expect(slugs).toContain('enterprise');
  });

  it('AC #4: emitDecision callback receives variant-design-intent-drift event', async () => {
    const input: VariantDriftExtensionInput = {
      tessellatedDid: 'did:platform-x:platform',
      variantsBySoul,
      substrateFiles: [variantLeakingFile],
    };
    const captured: VariantDesignIntentDriftEvent[] = [];
    await detectVariantDrift(input, { enabled: true }, async (ev) => {
      captured.push(ev);
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].decisionKind).toBe('variant-design-intent-drift');
  });

  it('uses configurable catalogStage in emitted events', async () => {
    const input: VariantDriftExtensionInput = {
      tessellatedDid: 'did:platform-x:platform',
      variantsBySoul,
      substrateFiles: [variantLeakingFile],
    };
    const result = await detectVariantDrift(input, { enabled: true, catalogStage: 'B' });
    expect(result.events[0].routing.catalogStage).toBe('B');
  });

  it('aggregates findings from multiple substrate files into a single event', async () => {
    const input: VariantDriftExtensionInput = {
      tessellatedDid: 'did:platform-x:platform',
      variantsBySoul,
      substrateFiles: [variantLeakingFile, literalLeakingFile],
    };
    const result = await detectVariantDrift(input, { enabled: true });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].details.findings.length).toBeGreaterThanOrEqual(3);
  });

  it('includes all involved soul slugs in the event', async () => {
    const multiSoulVariants = {
      'soul-a': [{ id: 'small-utility' }],
      'soul-b': [{ id: 'enterprise' }],
    };
    const fileWithBoth = {
      path: 'src/shared/utils.ts',
      contents: `const v1 = 'small-utility'; const v2 = 'enterprise';`,
    };
    const input: VariantDriftExtensionInput = {
      tessellatedDid: 'did:platform-x:platform',
      variantsBySoul: multiSoulVariants,
      substrateFiles: [fileWithBoth],
    };
    const result = await detectVariantDrift(input, { enabled: true });
    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    expect(ev.involvedSouls).toContain('soul-a');
    expect(ev.involvedSouls).toContain('soul-b');
  });

  it('does not report false positives on clean substrate code', async () => {
    const input: VariantDriftExtensionInput = {
      tessellatedDid: 'did:platform-x:platform',
      variantsBySoul,
      substrateFiles: [cleanSubstrateFile],
    };
    const result = await detectVariantDrift(input, { enabled: true });
    expect(result.events).toHaveLength(0);
  });

  it('skips invalid variant slugs gracefully', async () => {
    const variantsWithInvalidSlug = {
      'spry-engage': [
        { id: '' }, // empty slug — invalid
        { id: 'UPPER-CASE' }, // uppercase — invalid
        { id: 'valid-variant' }, // valid
      ],
    };
    const fileWithValid = {
      path: 'src/shared/test.ts',
      contents: `const x = 'valid-variant';`,
    };
    const input: VariantDriftExtensionInput = {
      tessellatedDid: 'did:platform-x:platform',
      variantsBySoul: variantsWithInvalidSlug,
      substrateFiles: [fileWithValid],
    };
    const result = await detectVariantDrift(input, { enabled: true });
    expect(result.events).toHaveLength(1);
    const slugs = result.events[0].details.findings.map((f) => f.variantSlug);
    expect(slugs).toContain('valid-variant');
    expect(slugs).not.toContain('');
  });
});
