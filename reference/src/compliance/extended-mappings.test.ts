import { describe, it, expect } from 'vitest';
import {
  ISO_12207_MAPPINGS,
  OWASP_ASI_MAPPINGS,
  CSA_ATF_MAPPINGS,
  getMappingsForFramework,
  REGULATORY_FRAMEWORKS,
} from './mappings.js';
import { checkAllFrameworks } from './checker.js';

describe('ISO 12207 mappings', () => {
  it('has unique control IDs', () => {
    const ids = ISO_12207_MAPPINGS.map((m) => m.controlId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all mappings reference iso-12207 framework', () => {
    for (const mapping of ISO_12207_MAPPINGS) {
      expect(mapping.framework).toBe('iso-12207');
    }
  });

  it('has valid framework references', () => {
    for (const mapping of ISO_12207_MAPPINGS) {
      expect(mapping.frameworkReference).toBeTruthy();
      expect(mapping.frameworkReference.length).toBeGreaterThan(5);
    }
  });
});

describe('OWASP ASI mappings', () => {
  it('has unique control IDs', () => {
    const ids = OWASP_ASI_MAPPINGS.map((m) => m.controlId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all mappings reference owasp-asi framework', () => {
    for (const mapping of OWASP_ASI_MAPPINGS) {
      expect(mapping.framework).toBe('owasp-asi');
    }
  });
});

describe('CSA ATF mappings', () => {
  it('has unique control IDs', () => {
    const ids = CSA_ATF_MAPPINGS.map((m) => m.controlId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all mappings reference csa-atf framework', () => {
    for (const mapping of CSA_ATF_MAPPINGS) {
      expect(mapping.framework).toBe('csa-atf');
    }
  });
});

describe('getMappingsForFramework with extended frameworks', () => {
  it('returns mappings for iso-12207', () => {
    expect(getMappingsForFramework('iso-12207')).toBe(ISO_12207_MAPPINGS);
  });

  it('returns mappings for owasp-asi', () => {
    expect(getMappingsForFramework('owasp-asi')).toBe(OWASP_ASI_MAPPINGS);
  });

  it('returns mappings for csa-atf', () => {
    expect(getMappingsForFramework('csa-atf')).toBe(CSA_ATF_MAPPINGS);
  });
});

describe('REGULATORY_FRAMEWORKS', () => {
  it('lists all 6 frameworks', () => {
    expect(REGULATORY_FRAMEWORKS).toHaveLength(6);
    expect(REGULATORY_FRAMEWORKS).toContain('iso-12207');
    expect(REGULATORY_FRAMEWORKS).toContain('owasp-asi');
    expect(REGULATORY_FRAMEWORKS).toContain('csa-atf');
  });
});

describe('coverage checker with extended frameworks', () => {
  it('checkAllFrameworks includes all 6 frameworks', () => {
    const implementedControls = new Set(['quality-gates', 'audit-logging']);
    const reports = checkAllFrameworks(implementedControls);
    expect(reports).toHaveLength(6);
    const frameworks = reports.map((r) => r.framework);
    expect(frameworks).toContain('iso-12207');
    expect(frameworks).toContain('owasp-asi');
    expect(frameworks).toContain('csa-atf');
  });
});
