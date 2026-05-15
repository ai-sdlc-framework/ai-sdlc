import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('runConformanceTests() — skipped-kind handling (PR #474 coverage)', () => {
  let tmp: string;

  beforeAll(() => {
    // Build a tmp fixtures dir with a single fixture whose `kind` is unknown
    // to the schema registry. The runner's skipped-kind branch must (a) mark
    // the result as failed regardless of expectedValid, (b) attach an
    // unknown-kind error with /kind path + 'unknown-kind' keyword.
    tmp = mkdtempSync(join(tmpdir(), 'aisdlc-265-runner-skipped-'));
    const subdir = join(tmp, 'pipeline');
    mkdirSync(subdir, { recursive: true });
    // Despite the `valid-` prefix the unknown kind makes this NOT exercise
    // the schema, so the runner must still report it as failed.
    writeFileSync(
      join(subdir, 'valid-unknown-kind.yaml'),
      'apiVersion: ai-sdlc.io/v1alpha1\nkind: TotallyMadeUpKind\nmetadata:\n  name: planted\n',
    );
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('marks unknown-kind fixture as failed even when filename says valid-*', async () => {
    const report = await runConformanceTests(tmp);
    expect(report.total).toBe(1);
    expect(report.failed).toBe(1);
    const r = report.results[0];
    expect(r.passed).toBe(false);
    expect(r.expectedValid).toBe(true);
    expect(r.actualValid).toBe(true);
    expect(r.errors).toBeDefined();
    expect(r.errors!.length).toBe(1);
    expect(r.errors![0].path).toBe('/kind');
    expect(r.errors![0].keyword).toBe('unknown-kind');
    expect(r.errors![0].message).toMatch(/unknown kind 'TotallyMadeUpKind'/);
    expect(r.errors![0].message).toMatch(/skipped without exercising schema/);
  });
});
