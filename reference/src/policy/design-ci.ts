/**
 * Design CI Boundary — deterministic design checks (RFC-0006 Addendum A §A.3).
 *
 * Six checks that are fully deterministic (binary pass/fail) and MUST
 * execute in CI before any AI or human review:
 * 1. Accessibility audit (WCAG 2.2 AA via axe-core)
 * 2. Touch target validation (44px minimum)
 * 3. Typography scale compliance
 * 4. Spacing grid compliance
 * 5. Color palette compliance
 * 6. Interactive state completeness
 */

// ── Check Result Types ───────────────────────────────────────────────

export interface DesignCIViolation {
  rule: string;
  element?: string;
  property?: string;
  actualValue?: string;
  expectedValue?: string;
  file?: string;
  line?: number;
  message: string;
}

export interface DesignCICheckResult {
  name: string;
  passed: boolean;
  violations: DesignCIViolation[];
}

// ── Accessibility Audit ──────────────────────────────────────────────

export interface AccessibilityAuditConfig {
  standard: 'WCAG22-AA' | 'WCAG22-AAA';
  rules?: string[];
  viewports?: number[];
}

/** Injectable axe-core engine for testability. */
export interface AccessibilityEngine {
  run(html: string, config: AccessibilityAuditConfig): Promise<DesignCIViolation[]>;
}

export function checkAccessibility(violations: DesignCIViolation[]): DesignCICheckResult {
  return {
    name: 'wcag-aa-automated',
    passed: violations.length === 0,
    violations,
  };
}

// ── Touch Target Validation ──────────────────────────────────────────

export interface TouchTargetConfig {
  minimumSize: { width: number; height: number };
  applyTo: string[];
}

export interface ElementSize {
  selector: string;
  width: number;
  height: number;
}

export function checkTouchTargets(
  elements: ElementSize[],
  config: TouchTargetConfig = { minimumSize: { width: 44, height: 44 }, applyTo: [] },
): DesignCICheckResult {
  const violations: DesignCIViolation[] = [];

  for (const el of elements) {
    if (el.width < config.minimumSize.width || el.height < config.minimumSize.height) {
      violations.push({
        rule: 'touch-targets',
        element: el.selector,
        actualValue: `${el.width}x${el.height}`,
        expectedValue: `${config.minimumSize.width}x${config.minimumSize.height}`,
        message: `Interactive element "${el.selector}" is ${el.width}x${el.height}px, minimum is ${config.minimumSize.width}x${config.minimumSize.height}px`,
      });
    }
  }

  return { name: 'touch-targets', passed: violations.length === 0, violations };
}

// ── Typography Scale Compliance ──────────────────────────────────────

export interface TypographyValue {
  property: 'font-size' | 'line-height' | 'letter-spacing';
  value: string;
  file?: string;
  line?: number;
}

export function checkTypographyScale(
  values: TypographyValue[],
  allowedValues: Set<string>,
): DesignCICheckResult {
  const violations: DesignCIViolation[] = [];

  for (const v of values) {
    if (!allowedValues.has(v.value)) {
      violations.push({
        rule: 'type-scale',
        property: v.property,
        actualValue: v.value,
        file: v.file,
        line: v.line,
        message: `${v.property} value "${v.value}" is not in the design system type scale`,
      });
    }
  }

  return { name: 'type-scale', passed: violations.length === 0, violations };
}

// ── Spacing Grid Compliance ──────────────────────────────────────────

export interface SpacingValue {
  property: string;
  value: string;
  numericValue: number;
  file?: string;
  line?: number;
}

export function checkSpacingGrid(
  values: SpacingValue[],
  baseUnit: number = 4,
  allowedOffGrid: Set<string> = new Set(['0px', '1px']),
): DesignCICheckResult {
  const violations: DesignCIViolation[] = [];

  for (const v of values) {
    if (allowedOffGrid.has(v.value)) continue;
    if (v.numericValue % baseUnit !== 0) {
      violations.push({
        rule: 'spacing-grid',
        property: v.property,
        actualValue: v.value,
        expectedValue: `Multiple of ${baseUnit}px`,
        file: v.file,
        line: v.line,
        message: `${v.property} value "${v.value}" (${v.numericValue}px) is not a multiple of the ${baseUnit}px grid`,
      });
    }
  }

  return { name: 'spacing-grid', passed: violations.length === 0, violations };
}

// ── Color Palette Compliance ─────────────────────────────────────────

export interface ColorValue {
  property: string;
  value: string;
  file?: string;
  line?: number;
}

export function checkColorPalette(
  values: ColorValue[],
  allowedColors: Set<string>,
): DesignCICheckResult {
  const violations: DesignCIViolation[] = [];

  for (const v of values) {
    const normalized = v.value.toLowerCase().trim();
    if (!allowedColors.has(normalized)) {
      violations.push({
        rule: 'color-palette',
        property: v.property,
        actualValue: v.value,
        file: v.file,
        line: v.line,
        message: `${v.property} value "${v.value}" is not in the defined color palette`,
      });
    }
  }

  return { name: 'color-palette', passed: violations.length === 0, violations };
}

// ── Interactive State Completeness ───────────────────────────────────

export interface StateCompletenessConfig {
  requiredStates: Record<string, string[]>;
  verification: 'storybook-stories' | 'manual';
}

export interface ComponentStates {
  componentType: string;
  coveredStates: string[];
}

export function checkStateCompleteness(
  components: ComponentStates[],
  config: StateCompletenessConfig,
): DesignCICheckResult {
  const violations: DesignCIViolation[] = [];

  for (const comp of components) {
    const required = config.requiredStates[comp.componentType];
    if (!required) continue;

    const covered = new Set(comp.coveredStates);
    const missing = required.filter((s) => !covered.has(s));

    if (missing.length > 0) {
      violations.push({
        rule: 'state-completeness',
        element: comp.componentType,
        actualValue: comp.coveredStates.join(', '),
        expectedValue: required.join(', '),
        message: `${comp.componentType} is missing states: ${missing.join(', ')}`,
      });
    }
  }

  return { name: 'state-completeness', passed: violations.length === 0, violations };
}

// ── Design CI Boundary Declaration ───────────────────────────────────

export interface DesignCIBoundaryEntry {
  category: string;
  tool: string;
  scope: string;
  reviewerAction: 'skip';
}

export interface DesignCIBoundary {
  automated: DesignCIBoundaryEntry[];
  humanReviewFocus: string[];
}

/**
 * Generate the Design CI Boundary declaration from check results.
 * This is prepended to all downstream review contexts so reviewers
 * (both human and AI) know which categories are already covered.
 */
export function generateDesignCIBoundary(results: DesignCICheckResult[]): DesignCIBoundary {
  const automated: DesignCIBoundaryEntry[] = results.map((r) => ({
    category: r.name,
    tool: `design-ci-${r.name}`,
    scope: `${r.violations.length} violation(s) checked`,
    reviewerAction: 'skip' as const,
  }));

  return {
    automated,
    humanReviewFocus: [
      'Aesthetic quality and visual polish',
      'Design language consistency across component family',
      'Visual hierarchy and information architecture',
      'Contextual fit within page/flow',
      'Brand alignment and emotional tone',
      'Responsive behavior quality (beyond breakpoint correctness)',
      'Motion and transition appropriateness',
    ],
  };
}

/**
 * Run all six Design CI checks and produce a consolidated result.
 */
export function runDesignCI(checks: DesignCICheckResult[]): {
  passed: boolean;
  results: DesignCICheckResult[];
  boundary: DesignCIBoundary;
  totalViolations: number;
} {
  const totalViolations = checks.reduce((sum, c) => sum + c.violations.length, 0);
  return {
    passed: checks.every((c) => c.passed),
    results: checks,
    boundary: generateDesignCIBoundary(checks),
    totalViolations,
  };
}
