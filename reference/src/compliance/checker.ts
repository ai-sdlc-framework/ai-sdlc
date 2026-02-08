/**
 * Compliance coverage checker.
 * Evaluates which regulatory controls are covered by enabled AI-SDLC controls.
 */

import type { RegulatoryFramework, ControlMapping } from './mappings.js';
import { AI_SDLC_CONTROLS, getMappingsForFramework, REGULATORY_FRAMEWORKS } from './mappings.js';

export interface ComplianceCoverageReport {
  framework: RegulatoryFramework;
  totalControls: number;
  coveredControls: number;
  gaps: ControlMapping[];
  coveragePercent: number;
}

/**
 * Check compliance coverage for a specific regulatory framework.
 *
 * @param enabledControls - Set of AI-SDLC control IDs currently enabled
 * @param framework - The regulatory framework to check against
 */
export function checkCompliance(
  enabledControls: ReadonlySet<string>,
  framework: RegulatoryFramework,
): ComplianceCoverageReport {
  const mappings = getMappingsForFramework(framework);
  const gaps: ControlMapping[] = [];

  for (const mapping of mappings) {
    if (!enabledControls.has(mapping.controlId)) {
      gaps.push(mapping);
    }
  }

  const totalControls = mappings.length;
  const coveredControls = totalControls - gaps.length;
  const coveragePercent = totalControls === 0 ? 100 : (coveredControls / totalControls) * 100;

  return {
    framework,
    totalControls,
    coveredControls,
    gaps,
    coveragePercent,
  };
}

/**
 * Check compliance coverage across all regulatory frameworks.
 *
 * @param enabledControls - Set of AI-SDLC control IDs currently enabled
 */
export function checkAllFrameworks(
  enabledControls: ReadonlySet<string>,
): ComplianceCoverageReport[] {
  return REGULATORY_FRAMEWORKS.map((fw) => checkCompliance(enabledControls, fw));
}

/**
 * Get all available control IDs.
 * Useful for enabling all controls (full coverage).
 */
export function getAllControlIds(): Set<string> {
  return new Set(AI_SDLC_CONTROLS.map((c) => c.id));
}
