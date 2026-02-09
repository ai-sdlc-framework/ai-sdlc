import { describe, it, expect, beforeAll } from 'vitest';
import {
  runConformanceTests,
  expectedValidity,
  classifyFixtureLevel,
  type RunnerReport,
} from './runner.js';

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

describe('classifyFixtureLevel()', () => {
  const base = '/fixtures';

  it('classifies pipeline as core', () => {
    expect(classifyFixtureLevel('/fixtures/pipeline/valid-minimal.yaml', base)).toBe('core');
  });

  it('classifies quality-gate as core', () => {
    expect(classifyFixtureLevel('/fixtures/quality-gate/valid-gate.yaml', base)).toBe('core');
  });

  it('classifies adapter as adapter', () => {
    expect(classifyFixtureLevel('/fixtures/adapter/valid-adapter.yaml', base)).toBe('adapter');
  });

  it('classifies agent-role as adapter', () => {
    expect(classifyFixtureLevel('/fixtures/agent-role/valid-role.yaml', base)).toBe('adapter');
  });

  it('classifies autonomy-policy as full', () => {
    expect(classifyFixtureLevel('/fixtures/autonomy-policy/valid-policy.yaml', base)).toBe('full');
  });

  it('defaults unknown directories to core', () => {
    expect(classifyFixtureLevel('/fixtures/other/valid-other.yaml', base)).toBe('core');
  });
});

describe('runConformanceTests()', () => {
  let report: RunnerReport;

  beforeAll(async () => {
    report = await runConformanceTests();
  });

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

  it('populates conformanceLevel on each schema result', () => {
    for (const r of report.results) {
      expect(['core', 'adapter', 'full']).toContain(r.conformanceLevel);
    }
  });

  it('includes conformanceLevels sub-report', () => {
    expect(report.conformanceLevels).toBeDefined();
    const levels = report.conformanceLevels!;
    expect(levels.core.total).toBeGreaterThan(0);
    expect(levels.core.total).toBe(levels.core.passed + levels.core.failed);
    expect(levels.adapter.total).toBe(levels.adapter.passed + levels.adapter.failed);
    expect(levels.full.total).toBe(levels.full.passed + levels.full.failed);
    // Total across levels should equal total schema results
    const totalAcrossLevels = levels.core.total + levels.adapter.total + levels.full.total;
    expect(totalAcrossLevels).toBe(report.results.length);
  });
});
