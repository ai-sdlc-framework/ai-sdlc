import { describe, it, expect } from 'vitest';
import {
  checkAccessibility,
  checkTouchTargets,
  checkTypographyScale,
  checkSpacingGrid,
  checkColorPalette,
  checkStateCompleteness,
  generateDesignCIBoundary,
  runDesignCI,
  type DesignCIViolation,
} from './design-ci.js';

describe('checkAccessibility', () => {
  it('passes with no violations', () => {
    const result = checkAccessibility([]);
    expect(result.passed).toBe(true);
    expect(result.name).toBe('wcag-aa-automated');
  });

  it('fails with violations', () => {
    const violations: DesignCIViolation[] = [
      { rule: 'color-contrast', message: 'Insufficient contrast ratio' },
    ];
    const result = checkAccessibility(violations);
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
  });
});

describe('checkTouchTargets', () => {
  it('passes when all elements meet minimum size', () => {
    const result = checkTouchTargets([
      { selector: 'button.primary', width: 48, height: 48 },
      { selector: 'a.link', width: 44, height: 44 },
    ]);
    expect(result.passed).toBe(true);
  });

  it('fails when element is too small', () => {
    const result = checkTouchTargets([{ selector: 'button.small', width: 30, height: 30 }]);
    expect(result.passed).toBe(false);
    expect(result.violations[0].message).toContain('30x30');
    expect(result.violations[0].message).toContain('44x44');
  });

  it('uses custom minimum size', () => {
    const result = checkTouchTargets([{ selector: 'button', width: 40, height: 40 }], {
      minimumSize: { width: 48, height: 48 },
      applyTo: [],
    });
    expect(result.passed).toBe(false);
  });
});

describe('checkTypographyScale', () => {
  const scale = new Set(['12px', '14px', '16px', '20px', '24px', '32px']);

  it('passes when all values are on scale', () => {
    const result = checkTypographyScale(
      [
        { property: 'font-size', value: '16px' },
        { property: 'font-size', value: '24px' },
      ],
      scale,
    );
    expect(result.passed).toBe(true);
  });

  it('fails when value is off scale', () => {
    const result = checkTypographyScale(
      [{ property: 'font-size', value: '15px', file: 'Button.tsx', line: 10 }],
      scale,
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0].property).toBe('font-size');
    expect(result.violations[0].actualValue).toBe('15px');
  });
});

describe('checkSpacingGrid', () => {
  it('passes when all values are on grid', () => {
    const result = checkSpacingGrid([
      { property: 'padding', value: '8px', numericValue: 8 },
      { property: 'margin', value: '16px', numericValue: 16 },
    ]);
    expect(result.passed).toBe(true);
  });

  it('fails when value is off grid', () => {
    const result = checkSpacingGrid([{ property: 'gap', value: '5px', numericValue: 5 }]);
    expect(result.passed).toBe(false);
    expect(result.violations[0].message).toContain('5px');
    expect(result.violations[0].message).toContain('4px grid');
  });

  it('allows off-grid exceptions', () => {
    const result = checkSpacingGrid(
      [{ property: 'border', value: '1px', numericValue: 1 }],
      4,
      new Set(['1px', '0px']),
    );
    expect(result.passed).toBe(true);
  });

  it('supports custom base unit', () => {
    const result = checkSpacingGrid([{ property: 'padding', value: '6px', numericValue: 6 }], 8);
    expect(result.passed).toBe(false);
  });
});

describe('checkColorPalette', () => {
  const palette = new Set(['#3b82f6', '#10b981', '#ef4444', '#ffffff', '#000000']);

  it('passes when all colors in palette', () => {
    const result = checkColorPalette([{ property: 'color', value: '#3B82F6' }], palette);
    expect(result.passed).toBe(true);
  });

  it('fails when color not in palette', () => {
    const result = checkColorPalette([{ property: 'background-color', value: '#ff00ff' }], palette);
    expect(result.passed).toBe(false);
    expect(result.violations[0].actualValue).toBe('#ff00ff');
  });
});

describe('checkStateCompleteness', () => {
  const config = {
    requiredStates: {
      button: ['default', 'hover', 'focus', 'active', 'disabled', 'loading'],
      input: ['default', 'focus', 'filled', 'error', 'disabled'],
    },
    verification: 'storybook-stories' as const,
  };

  it('passes when all states covered', () => {
    const result = checkStateCompleteness(
      [
        {
          componentType: 'button',
          coveredStates: ['default', 'hover', 'focus', 'active', 'disabled', 'loading'],
        },
      ],
      config,
    );
    expect(result.passed).toBe(true);
  });

  it('fails when states missing', () => {
    const result = checkStateCompleteness(
      [{ componentType: 'button', coveredStates: ['default', 'hover'] }],
      config,
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0].message).toContain('focus');
    expect(result.violations[0].message).toContain('active');
  });

  it('ignores unknown component types', () => {
    const result = checkStateCompleteness(
      [{ componentType: 'badge', coveredStates: ['default'] }],
      config,
    );
    expect(result.passed).toBe(true);
  });
});

describe('generateDesignCIBoundary', () => {
  it('generates boundary from check results', () => {
    const results = [
      { name: 'wcag-aa', passed: true, violations: [] },
      { name: 'touch-targets', passed: true, violations: [] },
    ];
    const boundary = generateDesignCIBoundary(results);
    expect(boundary.automated).toHaveLength(2);
    expect(boundary.automated[0].reviewerAction).toBe('skip');
    expect(boundary.humanReviewFocus.length).toBeGreaterThan(0);
  });
});

describe('runDesignCI', () => {
  it('reports overall pass when all checks pass', () => {
    const result = runDesignCI([
      { name: 'a', passed: true, violations: [] },
      { name: 'b', passed: true, violations: [] },
    ]);
    expect(result.passed).toBe(true);
    expect(result.totalViolations).toBe(0);
    expect(result.boundary.automated).toHaveLength(2);
  });

  it('reports overall fail when any check fails', () => {
    const result = runDesignCI([
      { name: 'a', passed: true, violations: [] },
      { name: 'b', passed: false, violations: [{ rule: 'x', message: 'fail' }] },
    ]);
    expect(result.passed).toBe(false);
    expect(result.totalViolations).toBe(1);
  });
});
