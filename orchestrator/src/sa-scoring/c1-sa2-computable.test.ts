import { describe, it, expect } from 'vitest';
import type { DesignIntentDocument, DesignSystemBinding } from '@ai-sdlc/reference';
import { computeSa2Computable } from './c1-sa2-computable.js';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function makeDid(refName = 'acme-ds'): DesignIntentDocument {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignIntentDocument',
    metadata: { name: 'acme-did' },
    spec: {
      stewardship: {
        productAuthority: { owner: 'p', approvalRequired: ['p'], scope: ['m'] },
        designAuthority: { owner: 'd', approvalRequired: ['d'], scope: ['dp'] },
      },
      soulPurpose: {
        mission: { value: 'test' },
        designPrinciples: [
          {
            id: 'x',
            name: 'X',
            description: 'x',
            measurableSignals: [{ id: 'm', metric: 'q', threshold: 1, operator: 'gte' }],
          },
        ],
      },
      designSystemRef: { name: refName },
    },
  };
}

function makeDsb(status?: DesignSystemBinding['status']): DesignSystemBinding {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignSystemBinding',
    metadata: { name: 'acme-ds' },
    spec: {
      stewardship: {
        designAuthority: { principals: ['d'], scope: [] },
        engineeringAuthority: { principals: ['e'], scope: [] },
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
    status,
  };
}

describe('computeSa2Computable', () => {
  it('returns 0.3 × tokenCompliance + 0.2 × catalogHealth when both fields present (percentages)', () => {
    const dsb = makeDsb({
      tokenCompliance: { currentCoverage: 90 },
      catalogHealth: { coveragePercent: 80 },
    });
    const result = computeSa2Computable(makeDid(), dsb);

    expect(result).toBeDefined();
    expect(result!.tokenCompliance).toBeCloseTo(0.9, 6);
    expect(result!.catalogHealth).toBeCloseTo(0.8, 6);
    expect(result!.computableComponent).toBeCloseTo(0.3 * 0.9 + 0.2 * 0.8, 6);
    expect(result!.llmComponent).toBeNull();
  });

  it('accepts normalized ratios (0–1) directly without re-scaling', () => {
    const dsb = makeDsb({
      tokenCompliance: { currentCoverage: 0.75 },
      catalogHealth: { coveragePercent: 0.6 },
    });
    const result = computeSa2Computable(makeDid(), dsb);
    expect(result!.tokenCompliance).toBeCloseTo(0.75, 6);
    expect(result!.catalogHealth).toBeCloseTo(0.6, 6);
  });

  it('treats missing tokenCompliance as 0 and still scores from catalogHealth alone', () => {
    const dsb = makeDsb({ catalogHealth: { coveragePercent: 50 } });
    const result = computeSa2Computable(makeDid(), dsb);
    expect(result).toBeDefined();
    expect(result!.tokenCompliance).toBe(0);
    expect(result!.catalogHealth).toBeCloseTo(0.5, 6);
    expect(result!.computableComponent).toBeCloseTo(0.2 * 0.5, 6);
  });

  it('treats missing catalogHealth as 0 and still scores from tokenCompliance alone', () => {
    const dsb = makeDsb({ tokenCompliance: { currentCoverage: 70 } });
    const result = computeSa2Computable(makeDid(), dsb);
    expect(result).toBeDefined();
    expect(result!.tokenCompliance).toBeCloseTo(0.7, 6);
    expect(result!.catalogHealth).toBe(0);
    expect(result!.computableComponent).toBeCloseTo(0.3 * 0.7, 6);
  });

  it('returns undefined when both coverage fields absent (caller falls back)', () => {
    const dsb = makeDsb({
      tokenCompliance: { trend: 'stable' },
      catalogHealth: { totalComponents: 10 },
    });
    expect(computeSa2Computable(makeDid(), dsb)).toBeUndefined();
  });

  it('returns undefined when DSB status is absent entirely', () => {
    const dsb = makeDsb(undefined);
    expect(computeSa2Computable(makeDid(), dsb)).toBeUndefined();
  });

  it('returns undefined when DSB is undefined (unresolved ref)', () => {
    expect(computeSa2Computable(makeDid('nonexistent-ds'), undefined)).toBeUndefined();
  });

  it('clamps coverage > 100 back to 1.0', () => {
    const dsb = makeDsb({
      tokenCompliance: { currentCoverage: 150 },
      catalogHealth: { coveragePercent: 200 },
    });
    const result = computeSa2Computable(makeDid(), dsb);
    expect(result!.tokenCompliance).toBe(1);
    expect(result!.catalogHealth).toBe(1);
    expect(result!.computableComponent).toBeCloseTo(0.5, 6);
  });

  it('clamps negative coverage to 0', () => {
    const dsb = makeDsb({
      tokenCompliance: { currentCoverage: -10 },
      catalogHealth: { coveragePercent: 50 },
    });
    const result = computeSa2Computable(makeDid(), dsb);
    expect(result!.tokenCompliance).toBe(0);
    expect(result!.catalogHealth).toBeCloseTo(0.5, 6);
  });

  it('handles NaN defensively by treating it as 0', () => {
    const dsb = makeDsb({
      tokenCompliance: { currentCoverage: Number.NaN },
      catalogHealth: { coveragePercent: 80 },
    });
    const result = computeSa2Computable(makeDid(), dsb);
    expect(result!.tokenCompliance).toBe(0);
    expect(result!.catalogHealth).toBeCloseTo(0.8, 6);
  });

  it('produces computableComponent in the theoretical max range [0, 0.5]', () => {
    const dsb = makeDsb({
      tokenCompliance: { currentCoverage: 100 },
      catalogHealth: { coveragePercent: 100 },
    });
    const result = computeSa2Computable(makeDid(), dsb);
    expect(result!.computableComponent).toBeCloseTo(0.5, 6);
  });
});
