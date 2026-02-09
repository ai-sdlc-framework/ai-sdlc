import { describe, it, expect } from 'vitest';
import {
  checkFrameworkCompliance,
  getControlCatalog,
  getFrameworkMappings,
  listSupportedFrameworks,
  // Re-exports
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
} from './compliance-extended.js';

describe('Extended compliance', () => {
  describe('checkFrameworkCompliance()', () => {
    it('checks compliance against EU AI Act', () => {
      const controlIds = getAllControlIds();
      const report = checkFrameworkCompliance('eu-ai-act', controlIds);
      expect(report).toBeDefined();
      expect(typeof report.coveragePercent).toBe('number');
    });

    it('reports 0% when no controls implemented', () => {
      const report = checkFrameworkCompliance('eu-ai-act', new Set());
      expect(report.coveragePercent).toBe(0);
    });
  });

  describe('getControlCatalog()', () => {
    it('returns all control IDs as a Set', () => {
      const ids = getControlCatalog();
      expect(ids instanceof Set).toBe(true);
      expect(ids.size).toBeGreaterThan(0);
    });
  });

  describe('getFrameworkMappings()', () => {
    it('returns mappings for EU AI Act', () => {
      const mappings = getFrameworkMappings('eu-ai-act');
      expect(Array.isArray(mappings)).toBe(true);
      expect(mappings.length).toBeGreaterThan(0);
    });

    it('returns mappings for NIST AI RMF', () => {
      const mappings = getFrameworkMappings('nist-ai-rmf');
      expect(mappings.length).toBeGreaterThan(0);
    });

    it('returns mappings for ISO 42001', () => {
      const mappings = getFrameworkMappings('iso-42001');
      expect(mappings.length).toBeGreaterThan(0);
    });
  });

  describe('listSupportedFrameworks()', () => {
    it('lists all 6 regulatory frameworks', () => {
      const frameworks = listSupportedFrameworks();
      expect(frameworks).toContain('eu-ai-act');
      expect(frameworks).toContain('nist-ai-rmf');
      expect(frameworks).toContain('iso-42001');
      expect(frameworks).toContain('iso-12207');
      expect(frameworks).toContain('owasp-asi');
      expect(frameworks).toContain('csa-atf');
      expect(frameworks).toHaveLength(6);
    });
  });

  describe('reference re-exports', () => {
    it('checkCompliance is a function', () => {
      expect(typeof checkCompliance).toBe('function');
    });

    it('checkAllFrameworks is a function', () => {
      expect(typeof checkAllFrameworks).toBe('function');
    });

    it('getAllControlIds returns Set', () => {
      const ids = getAllControlIds();
      expect(ids instanceof Set).toBe(true);
    });

    it('getMappingsForFramework returns array', () => {
      expect(Array.isArray(getMappingsForFramework('eu-ai-act'))).toBe(true);
    });

    it('AI_SDLC_CONTROLS is defined', () => {
      expect(AI_SDLC_CONTROLS).toBeDefined();
    });

    it('EU_AI_ACT_MAPPINGS is defined', () => {
      expect(EU_AI_ACT_MAPPINGS).toBeDefined();
    });

    it('NIST_AI_RMF_MAPPINGS is defined', () => {
      expect(NIST_AI_RMF_MAPPINGS).toBeDefined();
    });

    it('ISO_42001_MAPPINGS is defined', () => {
      expect(ISO_42001_MAPPINGS).toBeDefined();
    });

    it('ISO_12207_MAPPINGS is defined', () => {
      expect(ISO_12207_MAPPINGS).toBeDefined();
    });

    it('OWASP_ASI_MAPPINGS is defined', () => {
      expect(OWASP_ASI_MAPPINGS).toBeDefined();
    });

    it('CSA_ATF_MAPPINGS is defined', () => {
      expect(CSA_ATF_MAPPINGS).toBeDefined();
    });

    it('REGULATORY_FRAMEWORKS is defined', () => {
      expect(REGULATORY_FRAMEWORKS).toBeDefined();
    });
  });
});
