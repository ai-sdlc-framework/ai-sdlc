/**
 * Stub Semgrep adapter for testing.
 * Implements CodeAnalysis interface in-memory with configurable findings.
 */

import type {
  CodeAnalysis,
  ScanInput,
  ScanResult,
  Finding,
  SeveritySummary,
} from '../interfaces.js';

export interface StubSemgrepConfig {
  /** Preloaded findings to return for all scans. */
  preloadedFindings?: Finding[];
  /** Rulesets the stub supports. */
  supportedRulesets?: string[];
}

export interface StubSemgrepAdapter extends CodeAnalysis {
  getStoredFindings(scanId: string): Finding[];
  getScanCount(): number;
  getSupportedRulesets(): string[];
}

export function createStubSemgrep(config?: StubSemgrepConfig): StubSemgrepAdapter {
  const scans = new Map<string, { input: ScanInput; findings: Finding[] }>();
  let nextId = 1;

  return {
    async runScan(input: ScanInput): Promise<ScanResult> {
      const id = `sg-scan-${nextId++}`;
      let findings = config?.preloadedFindings
        ? config.preloadedFindings.map((f) => ({ ...f }))
        : [];

      // Filter by rulesets if specified in scan input and supported
      if (input.rulesets?.length && config?.supportedRulesets?.length) {
        const matchedRulesets = input.rulesets.filter((r) => config.supportedRulesets!.includes(r));
        if (matchedRulesets.length === 0) {
          findings = [];
        }
      }

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

    getSupportedRulesets(): string[] {
      return config?.supportedRulesets ?? [];
    },
  };
}
