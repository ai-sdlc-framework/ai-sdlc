import { describe, it, expect } from 'vitest';
import { createStubCodeAnalysis } from './code-analysis.js';
import type { Finding } from '../interfaces.js';

describe('createStubCodeAnalysis', () => {
  it('runs a scan and returns an ID', async () => {
    const ca = createStubCodeAnalysis();
    const result = await ca.runScan({ repository: 'test-repo' });
    expect(result.id).toMatch(/^scan-/);
    expect(result.status).toBe('completed');
  });

  it('returns empty findings by default', async () => {
    const ca = createStubCodeAnalysis();
    const scan = await ca.runScan({ repository: 'test-repo' });
    const findings = await ca.getFindings(scan.id);
    expect(findings).toHaveLength(0);
  });

  it('returns preloaded findings', async () => {
    const preloaded: Finding[] = [
      { id: 'f1', severity: 'high', message: 'Issue', file: 'main.ts', rule: 'no-eval' },
      { id: 'f2', severity: 'low', message: 'Style', file: 'util.ts', rule: 'indent' },
    ];
    const ca = createStubCodeAnalysis({ preloadedFindings: preloaded });
    const scan = await ca.runScan({ repository: 'test-repo' });
    const findings = await ca.getFindings(scan.id);
    expect(findings).toHaveLength(2);
  });

  it('computes severity summary correctly', async () => {
    const findings: Finding[] = [
      { id: 'f1', severity: 'critical', message: 'C', file: 'a.ts', rule: 'r1' },
      { id: 'f2', severity: 'high', message: 'H', file: 'b.ts', rule: 'r2' },
      { id: 'f3', severity: 'high', message: 'H2', file: 'c.ts', rule: 'r3' },
      { id: 'f4', severity: 'low', message: 'L', file: 'd.ts', rule: 'r4' },
    ];
    const ca = createStubCodeAnalysis({ preloadedFindings: findings });
    const scan = await ca.runScan({ repository: 'test-repo' });
    const summary = await ca.getSeveritySummary(scan.id);
    expect(summary).toEqual({ critical: 1, high: 2, medium: 0, low: 1 });
  });

  it('throws for unknown scan ID', async () => {
    const ca = createStubCodeAnalysis();
    await expect(ca.getFindings('unknown')).rejects.toThrow('not found');
  });

  it('tracks scan count', async () => {
    const ca = createStubCodeAnalysis();
    expect(ca.getScanCount()).toBe(0);
    await ca.runScan({ repository: 'repo-1' });
    await ca.runScan({ repository: 'repo-2' });
    expect(ca.getScanCount()).toBe(2);
  });

  it('exposes stored findings for test inspection', async () => {
    const findings: Finding[] = [
      { id: 'f1', severity: 'medium', message: 'M', file: 'x.ts', rule: 'r1' },
    ];
    const ca = createStubCodeAnalysis({ preloadedFindings: findings });
    const scan = await ca.runScan({ repository: 'repo' });
    expect(ca.getStoredFindings(scan.id)).toHaveLength(1);
    expect(ca.getStoredFindings('missing')).toHaveLength(0);
  });
});
