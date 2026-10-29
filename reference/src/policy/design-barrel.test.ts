import { describe, it, expect } from 'vitest';
import * as pkg from '../index.js';

describe('RFC-0006 Addendum A reference barrel wiring', () => {
  it.each([
    'runDesignCI',
    'generateDesignCIBoundary',
    'checkAccessibility',
    'checkTouchTargets',
    'checkTypographyScale',
    'checkSpacingGrid',
    'checkColorPalette',
    'checkStateCompleteness',
    'analyzeStructure',
    'computeComplexityScore',
    'triggersDesignReview',
    'DESIGN_REVIEW_PRINCIPLES',
    'createExemplarBank',
    'parseExemplarsFromYaml',
  ])('exports %s from the package root', (name) => {
    expect((pkg as Record<string, unknown>)[name]).toBeDefined();
  });
});
