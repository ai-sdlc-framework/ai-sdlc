import { describe, it, expect } from 'vitest';
import { checkCompliance, checkAllFrameworks, getAllControlIds } from './checker.js';

describe('checkCompliance', () => {
  it('reports 100% coverage when all controls enabled', () => {
    const allControls = getAllControlIds();
    const report = checkCompliance(allControls, 'eu-ai-act');
    expect(report.coveragePercent).toBe(100);
    expect(report.gaps).toHaveLength(0);
    expect(report.coveredControls).toBe(report.totalControls);
  });

  it('reports 0% coverage when no controls enabled', () => {
    const report = checkCompliance(new Set(), 'eu-ai-act');
    expect(report.coveragePercent).toBe(0);
    expect(report.coveredControls).toBe(0);
    expect(report.gaps.length).toBe(report.totalControls);
  });

  it('correctly identifies gaps for partial coverage', () => {
    const partial = new Set(['quality-gates', 'audit-logging']);
    const report = checkCompliance(partial, 'eu-ai-act');
    expect(report.coveredControls).toBe(2);
    expect(report.gaps.length).toBe(report.totalControls - 2);
    // All gaps should reference controls NOT in our set
    for (const gap of report.gaps) {
      expect(partial.has(gap.controlId)).toBe(false);
    }
  });

  it('works with nist-ai-rmf framework', () => {
    const allControls = getAllControlIds();
    const report = checkCompliance(allControls, 'nist-ai-rmf');
    expect(report.framework).toBe('nist-ai-rmf');
    expect(report.coveragePercent).toBe(100);
  });

  it('works with iso-42001 framework', () => {
    const allControls = getAllControlIds();
    const report = checkCompliance(allControls, 'iso-42001');
    expect(report.framework).toBe('iso-42001');
    expect(report.coveragePercent).toBe(100);
  });

  it('includes the framework in the report', () => {
    const report = checkCompliance(new Set(), 'nist-ai-rmf');
    expect(report.framework).toBe('nist-ai-rmf');
  });
});

describe('checkAllFrameworks', () => {
  it('returns reports for all frameworks', () => {
    const reports = checkAllFrameworks(getAllControlIds());
    expect(reports).toHaveLength(3);
    const frameworks = reports.map((r) => r.framework);
    expect(frameworks).toContain('eu-ai-act');
    expect(frameworks).toContain('nist-ai-rmf');
    expect(frameworks).toContain('iso-42001');
  });

  it('all frameworks show 100% with all controls', () => {
    const reports = checkAllFrameworks(getAllControlIds());
    for (const report of reports) {
      expect(report.coveragePercent).toBe(100);
    }
  });
});

describe('getAllControlIds', () => {
  it('returns a set of 10 control IDs', () => {
    const ids = getAllControlIds();
    expect(ids.size).toBe(10);
    expect(ids.has('quality-gates')).toBe(true);
    expect(ids.has('kill-switch')).toBe(true);
  });
});
