import { describe, it, expect } from 'vitest';
import { runConformanceTests, expectedValidity } from './runner.js';

describe('expectedValidity()', () => {
  it('returns true for valid-* files', () => {
    expect(expectedValidity('valid-minimal.yaml')).toBe(true);
  });

  it('returns false for invalid-* files', () => {
    expect(expectedValidity('invalid-missing-stages.yaml')).toBe(false);
  });

  it('throws for unrecognized naming', () => {
    expect(() => expectedValidity('unknown-file.yaml')).toThrow();
  });
});

describe('runConformanceTests()', () => {
  const report = runConformanceTests();

  it('finds all fixtures', () => {
    expect(report.total).toBeGreaterThan(0);
  });

  it('all valid-* fixtures pass validation', () => {
    const validResults = report.results.filter((r) => r.expectedValid);
    for (const r of validResults) {
      expect(r.actualValid, `Expected ${r.file} to be valid`).toBe(true);
    }
  });

  it('all invalid-* fixtures are correctly rejected', () => {
    const invalidResults = report.results.filter((r) => !r.expectedValid);
    expect(invalidResults.length).toBeGreaterThan(0);
    for (const r of invalidResults) {
      expect(r.actualValid, `Expected ${r.file} to be invalid`).toBe(false);
    }
  });

  it('has zero total failures', () => {
    expect(report.failed).toBe(0);
  });
});
