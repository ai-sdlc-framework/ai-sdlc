/**
 * Stub SonarQube adapter for testing.
 * Implements CodeAnalysis interface in-memory with configurable findings.
 */

import type {
  CodeAnalysis,
  ScanInput,
  ScanResult,
  Finding,
  SeveritySummary,
} from '../interfaces.js';

export interface StubSonarQubeConfig {
  /** Preloaded findings to return for all scans. */
  preloadedFindings?: Finding[];
  /** Default quality gate status. */
  qualityGateStatus?: 'OK' | 'ERROR';
}

export interface StubSonarQubeAdapter extends CodeAnalysis {
  getStoredFindings(scanId: string): Finding[];
  getScanCount(): number;
  getQualityGateStatus(): string;
}

export function createStubSonarQube(config?: StubSonarQubeConfig): StubSonarQubeAdapter {
  const scans = new Map<string, { input: ScanInput; findings: Finding[] }>();
  let nextId = 1;

  return {
    async runScan(input: ScanInput): Promise<ScanResult> {
      const id = `sq-scan-${nextId++}`;
      const findings = config?.preloadedFindings
        ? config.preloadedFindings.map((f) => ({ ...f }))
        : [];
      scans.set(id, { input, findings });
      return { id, status: 'completed' };
    },

    async getFindings(scanId: string): Promise<Finding[]> {
      const scan = scans.get(scanId);
      if (!scan) throw new Error(`Scan "${scanId}" not found`);
      return scan.findings;
    },

    async getSeveritySummary(scanId: string): Promise<SeveritySummary> {
      const findings = await this.getFindings(scanId);
      const summary: SeveritySummary = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const finding of findings) {
        summary[finding.severity]++;
      }
      return summary;
    },

    getStoredFindings(scanId: string): Finding[] {
      return scans.get(scanId)?.findings ?? [];
    },

    getScanCount(): number {
      return scans.size;
    },

    getQualityGateStatus(): string {
      return config?.qualityGateStatus ?? 'OK';
    },
  };
}
