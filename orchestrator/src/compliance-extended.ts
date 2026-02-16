/**
 * Extended compliance integration — covers individual framework checking,
 * control IDs, framework mappings, and all 6 regulatory frameworks.
 */

import {
  checkCompliance,
  getAllControlIds,
  getMappingsForFramework,
  REGULATORY_FRAMEWORKS,
  type RegulatoryFramework,
  type ControlMapping,
  type ComplianceCoverageReport,
} from '@ai-sdlc/reference';

/**
 * Check compliance against a single regulatory framework.
 */
export function checkFrameworkCompliance(
  framework: RegulatoryFramework,
  implementedControls: ReadonlySet<string>,
): ComplianceCoverageReport {
  return checkCompliance(implementedControls, framework);
}

/**
 * Get all control IDs defined in the AI-SDLC control catalog.
 */
export function getControlCatalog(): Set<string> {
  return getAllControlIds();
}

/**
 * Get the control mappings for a specific regulatory framework.
 */
export function getFrameworkMappings(framework: RegulatoryFramework): readonly ControlMapping[] {
  return getMappingsForFramework(framework);
}

/**
 * List all supported regulatory frameworks.
 */
export function listSupportedFrameworks(): readonly RegulatoryFramework[] {
  return [...REGULATORY_FRAMEWORKS];
}

/**
 * Detailed compliance report for a single framework.
 */
export interface DetailedFrameworkReport {
  framework: RegulatoryFramework;
  coveragePercent: number;
  gaps: string[];
  coveredControls: string[];
}

/**
 * Generate a detailed compliance report for each of the 6 regulatory frameworks.
 */
export function generateDetailedComplianceReport(
  implementedControls: ReadonlySet<string>,
): DetailedFrameworkReport[] {
  const frameworks = listSupportedFrameworks();
  return frameworks.map((framework) => {
    const report = checkCompliance(implementedControls, framework);
    const mappings = getMappingsForFramework(framework);
    const requiredControls = mappings.map((m) => m.controlId);
    const covered = requiredControls.filter((c) => implementedControls.has(c));
    const gaps = requiredControls.filter((c) => !implementedControls.has(c));
    return {
      framework,
      coveragePercent: report.coveragePercent,
      gaps,
      coveredControls: covered,
    };
  });
}

/**
 * Get compliance gaps (missing controls) for a specific framework.
 */
export function getComplianceGaps(
  framework: RegulatoryFramework,
  implementedControls: ReadonlySet<string>,
): string[] {
  const mappings = getMappingsForFramework(framework);
  return mappings.map((m) => m.controlId).filter((c) => !implementedControls.has(c));
}

// Direct re-exports (passthrough)
export {
  checkCompliance,
  checkAllFrameworks,
  getAllControlIds,
  getMappingsForFramework,
  AI_SDLC_CONTROLS,
  EU_AI_ACT_MAPPINGS,
  NIST_AI_RMF_MAPPINGS,
  ISO_42001_MAPPINGS,
  ISO_12207_MAPPINGS,
  OWASP_ASI_MAPPINGS,
  CSA_ATF_MAPPINGS,
  REGULATORY_FRAMEWORKS,
} from '@ai-sdlc/reference';

export type {
  RegulatoryFramework,
  ComplianceControl,
  ControlMapping,
  ComplianceCoverageReport,
} from '@ai-sdlc/reference';
