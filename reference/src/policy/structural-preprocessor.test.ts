import { describe, it, expect } from 'vitest';
import {
  computeComplexityScore,
  analyzeStructure,
  triggersDesignReview,
  type ComplexityFactors,
} from './structural-preprocessor.js';

describe('computeComplexityScore', () => {
  it('returns 1 for minimal component', () => {
    const factors: ComplexityFactors = {
      variantCount: 1,
      propCount: 2,
      responsiveBreakpoints: 1,
      interactiveStates: 1,
      composedComponents: 0,
      tokenReferences: 5,
    };
    expect(computeComplexityScore(factors)).toBe(1);
  });

  it('returns moderate score for medium component', () => {
    const factors: ComplexityFactors = {
      variantCount: 4,
      propCount: 8,
      responsiveBreakpoints: 3,
      interactiveStates: 4,
      composedComponents: 2,
      tokenReferences: 10,
    };
    const score = computeComplexityScore(factors);
    expect(score).toBeGreaterThanOrEqual(4);
    expect(score).toBeLessThanOrEqual(7);
  });

  it('returns high score for complex component', () => {
    const factors: ComplexityFactors = {
      variantCount: 10,
      propCount: 20,
      responsiveBreakpoints: 5,
      interactiveStates: 8,
      composedComponents: 6,
      tokenReferences: 0,
    };
    const score = computeComplexityScore(factors);
    expect(score).toBeGreaterThanOrEqual(7);
  });

  it('clamps to 10 maximum', () => {
    const factors: ComplexityFactors = {
      variantCount: 99,
      propCount: 99,
      responsiveBreakpoints: 99,
      interactiveStates: 99,
      composedComponents: 99,
      tokenReferences: 0,
    };
    expect(computeComplexityScore(factors)).toBe(10);
  });

  it('penalizes zero token references', () => {
    const withTokens: ComplexityFactors = {
      variantCount: 3,
      propCount: 5,
      responsiveBreakpoints: 2,
      interactiveStates: 3,
      composedComponents: 1,
      tokenReferences: 10,
    };
    const withoutTokens = { ...withTokens, tokenReferences: 0 };
    expect(computeComplexityScore(withoutTokens)).toBeGreaterThan(
      computeComplexityScore(withTokens),
    );
  });
});

describe('analyzeStructure', () => {
  it('produces full structural analysis', () => {
    const result = analyzeStructure({
      factors: {
        variantCount: 3,
        propCount: 5,
        responsiveBreakpoints: 2,
        interactiveStates: 4,
        composedComponents: 2,
        tokenReferences: 8,
      },
      spacingValues: [
        { property: 'padding', value: '8px', numericValue: 8, file: 'a.tsx', line: 1 },
        { property: 'margin', value: '5px', numericValue: 5, file: 'a.tsx', line: 2 },
      ],
      typographyValues: [{ property: 'font-size', value: '16px', file: 'a.tsx', line: 3 }],
      colorValues: [
        { value: '#3B82F6', isTokenized: true },
        { value: '#ff0000', isTokenized: false },
      ],
      states: {
        componentType: 'button',
        required: ['default', 'hover', 'focus', 'disabled'],
        covered: ['default', 'hover'],
      },
      reuse: {
        catalogComponents: ['Icon', 'Label'],
        newElements: ['CustomBadge'],
      },
    });

    expect(result.complexityScore).toBeGreaterThanOrEqual(1);
    expect(result.spacingAnalysis.offGridValues).toBe(1);
    expect(result.spacingAnalysis.consistencyScore).toBe(0.5);
    expect(result.typographyAudit.uniqueFontSizes).toBe(1);
    expect(result.colorAudit.hardcodedColors).toBe(1);
    expect(result.colorAudit.paletteCompliance).toBe(0.5);
    expect(result.stateCoverage.missingStates).toEqual(['focus', 'disabled']);
    expect(result.stateCoverage.coveragePercent).toBe(50);
    expect(result.reuseAnalysis.reuseScore).toBeCloseTo(2 / 3);
  });

  it('handles empty inputs gracefully', () => {
    const result = analyzeStructure({
      factors: {
        variantCount: 0,
        propCount: 0,
        responsiveBreakpoints: 0,
        interactiveStates: 0,
        composedComponents: 0,
        tokenReferences: 0,
      },
      spacingValues: [],
      typographyValues: [],
      colorValues: [],
      states: { componentType: 'div', required: [], covered: [] },
      reuse: { catalogComponents: [], newElements: [] },
    });
    expect(result.spacingAnalysis.consistencyScore).toBe(1);
    expect(result.colorAudit.paletteCompliance).toBe(1);
    expect(result.stateCoverage.coveragePercent).toBe(100);
    expect(result.reuseAnalysis.reuseScore).toBe(1);
  });
});

describe('triggersDesignReview', () => {
  it('returns true for score >= 7', () => {
    const analysis = analyzeStructure({
      factors: {
        variantCount: 10,
        propCount: 20,
        responsiveBreakpoints: 5,
        interactiveStates: 8,
        composedComponents: 6,
        tokenReferences: 0,
      },
      spacingValues: [],
      typographyValues: [],
      colorValues: [],
      states: { componentType: 'x', required: [], covered: [] },
      reuse: { catalogComponents: [], newElements: [] },
    });
    expect(triggersDesignReview(analysis)).toBe(true);
  });

  it('returns false for score < 7', () => {
    const analysis = analyzeStructure({
      factors: {
        variantCount: 1,
        propCount: 2,
        responsiveBreakpoints: 1,
        interactiveStates: 1,
        composedComponents: 0,
        tokenReferences: 5,
      },
      spacingValues: [],
      typographyValues: [],
      colorValues: [],
      states: { componentType: 'x', required: [], covered: [] },
      reuse: { catalogComponents: [], newElements: [] },
    });
    expect(triggersDesignReview(analysis)).toBe(false);
  });
});
