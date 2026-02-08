import { describe, it, expect } from 'vitest';
import {
  AI_SDLC_CONTROLS,
  EU_AI_ACT_MAPPINGS,
  NIST_AI_RMF_MAPPINGS,
  ISO_42001_MAPPINGS,
  getMappingsForFramework,
  REGULATORY_FRAMEWORKS,
} from './mappings.js';

describe('AI_SDLC_CONTROLS', () => {
  it('has exactly 10 controls', () => {
    expect(AI_SDLC_CONTROLS).toHaveLength(10);
  });

  it('all control IDs are unique', () => {
    const ids = AI_SDLC_CONTROLS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all controls have required fields', () => {
    for (const control of AI_SDLC_CONTROLS) {
      expect(control.id).toBeTruthy();
      expect(control.name).toBeTruthy();
      expect(control.description).toBeTruthy();
    }
  });
});

describe('framework mappings', () => {
  it('all mapping controlIds reference valid controls', () => {
    const validIds = new Set(AI_SDLC_CONTROLS.map((c) => c.id));
    const allMappings = [...EU_AI_ACT_MAPPINGS, ...NIST_AI_RMF_MAPPINGS, ...ISO_42001_MAPPINGS];
    for (const mapping of allMappings) {
      expect(validIds.has(mapping.controlId)).toBe(true);
    }
  });

  it('each framework has at least 5 mappings', () => {
    expect(EU_AI_ACT_MAPPINGS.length).toBeGreaterThanOrEqual(5);
    expect(NIST_AI_RMF_MAPPINGS.length).toBeGreaterThanOrEqual(5);
    expect(ISO_42001_MAPPINGS.length).toBeGreaterThanOrEqual(5);
  });

  it('all mappings have correct framework field', () => {
    for (const m of EU_AI_ACT_MAPPINGS) expect(m.framework).toBe('eu-ai-act');
    for (const m of NIST_AI_RMF_MAPPINGS) expect(m.framework).toBe('nist-ai-rmf');
    for (const m of ISO_42001_MAPPINGS) expect(m.framework).toBe('iso-42001');
  });
});

describe('getMappingsForFramework', () => {
  it('returns correct mappings for each framework', () => {
    expect(getMappingsForFramework('eu-ai-act')).toBe(EU_AI_ACT_MAPPINGS);
    expect(getMappingsForFramework('nist-ai-rmf')).toBe(NIST_AI_RMF_MAPPINGS);
    expect(getMappingsForFramework('iso-42001')).toBe(ISO_42001_MAPPINGS);
  });
});

describe('REGULATORY_FRAMEWORKS', () => {
  it('lists all six frameworks', () => {
    expect(REGULATORY_FRAMEWORKS).toHaveLength(6);
    expect(REGULATORY_FRAMEWORKS).toContain('eu-ai-act');
    expect(REGULATORY_FRAMEWORKS).toContain('nist-ai-rmf');
    expect(REGULATORY_FRAMEWORKS).toContain('iso-42001');
    expect(REGULATORY_FRAMEWORKS).toContain('iso-12207');
    expect(REGULATORY_FRAMEWORKS).toContain('owasp-asi');
    expect(REGULATORY_FRAMEWORKS).toContain('csa-atf');
  });
});
