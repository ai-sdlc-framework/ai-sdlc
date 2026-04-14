/**
 * Structural Design Preprocessor (RFC-0006 Addendum A §A.4).
 *
 * Computes deterministic structural analysis of components before
 * AI or human review. Findings are prepended to review context as
 * "Pre-Verified Structural Analysis."
 */

// ── Structural Analysis Types ────────────────────────────────────────

export interface ComplexityFactors {
  variantCount: number;
  propCount: number;
  responsiveBreakpoints: number;
  interactiveStates: number;
  composedComponents: number;
  tokenReferences: number;
}

export interface SpacingAnalysis {
  onGridValues: number;
  offGridValues: number;
  consistencyScore: number;
  offGridLocations: Array<{
    property: string;
    value: string;
    file: string;
    line: number;
  }>;
}

export interface TypographyAudit {
  uniqueFontSizes: number;
  uniqueLineHeights: number;
  uniqueLetterSpacings: number;
  allOnScale: boolean;
  deviations: Array<{
    property: string;
    value: string;
    nearestScaleValue: string;
    file: string;
    line: number;
  }>;
}

export interface ColorAudit {
  uniqueColors: number;
  tokenizedColors: number;
  hardcodedColors: number;
  paletteCompliance: number;
}

export interface StateCoverage {
  requiredStates: string[];
  coveredStates: string[];
  missingStates: string[];
  coveragePercent: number;
}

export interface ReuseAnalysis {
  existingComponentsUsed: string[];
  newElementsIntroduced: string[];
  reuseScore: number;
}

export interface StructuralDesignAnalysis {
  complexityScore: number;
  complexityFactors: ComplexityFactors;
  spacingAnalysis: SpacingAnalysis;
  typographyAudit: TypographyAudit;
  colorAudit: ColorAudit;
  stateCoverage: StateCoverage;
  reuseAnalysis: ReuseAnalysis;
}

// ── Complexity Scoring ───────────────────────────────────────────────

/**
 * Compute complexity score (1-10) from structural factors.
 * Components scoring 7+ auto-trigger design review.
 */
export function computeComplexityScore(factors: ComplexityFactors): number {
  // Weighted scoring: each factor contributes proportionally
  let score = 1;

  // Variants: 1-3 = +0, 4-6 = +1, 7+ = +2
  if (factors.variantCount >= 7) score += 2;
  else if (factors.variantCount >= 4) score += 1;

  // Props: 1-5 = +0, 6-10 = +1, 11-15 = +2, 16+ = +3
  if (factors.propCount >= 16) score += 3;
  else if (factors.propCount >= 11) score += 2;
  else if (factors.propCount >= 6) score += 1;

  // Breakpoints: 1-2 = +0, 3-4 = +1, 5+ = +2
  if (factors.responsiveBreakpoints >= 5) score += 2;
  else if (factors.responsiveBreakpoints >= 3) score += 1;

  // States: 1-3 = +0, 4-6 = +1, 7+ = +2
  if (factors.interactiveStates >= 7) score += 2;
  else if (factors.interactiveStates >= 4) score += 1;

  // Composed components: 0-1 = +0, 2-4 = +0.5, 5+ = +1
  if (factors.composedComponents >= 5) score += 1;

  // Token references: high count indicates well-integrated component
  // Not a complexity penalty, but very low count flags concern
  if (factors.tokenReferences === 0) score += 1;

  return Math.min(10, Math.max(1, Math.round(score)));
}

/**
 * Analyze a component's structural properties.
 */
export function analyzeStructure(input: {
  factors: ComplexityFactors;
  spacingValues: Array<{
    property: string;
    value: string;
    numericValue: number;
    file: string;
    line: number;
  }>;
  typographyValues: Array<{ property: string; value: string; file: string; line: number }>;
  colorValues: Array<{ value: string; isTokenized: boolean }>;
  states: { componentType: string; required: string[]; covered: string[] };
  reuse: { catalogComponents: string[]; newElements: string[] };
  gridBaseUnit?: number;
  typographyScale?: Set<string>;
}): StructuralDesignAnalysis {
  const complexityScore = computeComplexityScore(input.factors);

  // Spacing analysis
  const baseUnit = input.gridBaseUnit ?? 4;
  const onGrid = input.spacingValues.filter(
    (v) => v.numericValue === 0 || v.numericValue === 1 || v.numericValue % baseUnit === 0,
  ).length;
  const offGrid = input.spacingValues.length - onGrid;

  const spacingAnalysis: SpacingAnalysis = {
    onGridValues: onGrid,
    offGridValues: offGrid,
    consistencyScore: input.spacingValues.length > 0 ? onGrid / input.spacingValues.length : 1,
    offGridLocations: input.spacingValues
      .filter(
        (v) => v.numericValue !== 0 && v.numericValue !== 1 && v.numericValue % baseUnit !== 0,
      )
      .map((v) => ({ property: v.property, value: v.value, file: v.file, line: v.line })),
  };

  // Typography audit
  const scale = input.typographyScale ?? new Set<string>();
  const fontSizes = new Set(
    input.typographyValues.filter((v) => v.property === 'font-size').map((v) => v.value),
  );
  const lineHeights = new Set(
    input.typographyValues.filter((v) => v.property === 'line-height').map((v) => v.value),
  );
  const letterSpacings = new Set(
    input.typographyValues.filter((v) => v.property === 'letter-spacing').map((v) => v.value),
  );
  const deviations =
    scale.size > 0 ? input.typographyValues.filter((v) => !scale.has(v.value)) : [];

  const typographyAudit: TypographyAudit = {
    uniqueFontSizes: fontSizes.size,
    uniqueLineHeights: lineHeights.size,
    uniqueLetterSpacings: letterSpacings.size,
    allOnScale: deviations.length === 0,
    deviations: deviations.map((v) => ({
      property: v.property,
      value: v.value,
      nearestScaleValue: 'N/A',
      file: v.file,
      line: v.line,
    })),
  };

  // Color audit
  const tokenized = input.colorValues.filter((c) => c.isTokenized).length;
  const hardcoded = input.colorValues.filter((c) => !c.isTokenized).length;
  const colorAudit: ColorAudit = {
    uniqueColors: new Set(input.colorValues.map((c) => c.value)).size,
    tokenizedColors: tokenized,
    hardcodedColors: hardcoded,
    paletteCompliance: input.colorValues.length > 0 ? tokenized / input.colorValues.length : 1,
  };

  // State coverage
  const covered = new Set(input.states.covered);
  const missing = input.states.required.filter((s) => !covered.has(s));
  const stateCoverage: StateCoverage = {
    requiredStates: input.states.required,
    coveredStates: input.states.covered,
    missingStates: missing,
    coveragePercent:
      input.states.required.length > 0
        ? ((input.states.required.length - missing.length) / input.states.required.length) * 100
        : 100,
  };

  // Reuse analysis
  const totalElements = input.reuse.catalogComponents.length + input.reuse.newElements.length;
  const reuseAnalysis: ReuseAnalysis = {
    existingComponentsUsed: input.reuse.catalogComponents,
    newElementsIntroduced: input.reuse.newElements,
    reuseScore: totalElements > 0 ? input.reuse.catalogComponents.length / totalElements : 1,
  };

  return {
    complexityScore,
    complexityFactors: input.factors,
    spacingAnalysis,
    typographyAudit,
    colorAudit,
    stateCoverage,
    reuseAnalysis,
  };
}

/**
 * Check if a component's complexity triggers automatic design review.
 */
export function triggersDesignReview(analysis: StructuralDesignAnalysis): boolean {
  return analysis.complexityScore >= 7;
}
