import { describe, it, expect } from 'vitest';
import type { Gate, EnforcementLevel } from '@ai-sdlc/reference';
import {
  getComplexityBand,
  getGateProfile,
  adjustEnforcement,
  adjustGateForComplexity,
  adjustGatesForComplexity,
  computeGateAdjustments,
} from './progressive-gates.js';

function makeGate(name: string, enforcement: EnforcementLevel): Gate {
  return {
    name,
    enforcement,
    rule: { metric: 'test-coverage', operator: '>=', threshold: 80 },
  };
}

describe('progressive-gates', () => {
  describe('getComplexityBand', () => {
    it('returns trivial for scores 1-3', () => {
      expect(getComplexityBand(1)).toBe('trivial');
      expect(getComplexityBand(2)).toBe('trivial');
      expect(getComplexityBand(3)).toBe('trivial');
    });

    it('returns standard for scores 4-6', () => {
      expect(getComplexityBand(4)).toBe('standard');
      expect(getComplexityBand(5)).toBe('standard');
      expect(getComplexityBand(6)).toBe('standard');
    });

    it('returns complex for scores 7-8', () => {
      expect(getComplexityBand(7)).toBe('complex');
      expect(getComplexityBand(8)).toBe('complex');
    });

    it('returns critical for scores 9-10', () => {
      expect(getComplexityBand(9)).toBe('critical');
      expect(getComplexityBand(10)).toBe('critical');
    });

    it('clamps out-of-range scores', () => {
      expect(getComplexityBand(0)).toBe('trivial');
      expect(getComplexityBand(-5)).toBe('trivial');
      expect(getComplexityBand(15)).toBe('critical');
    });
  });

  describe('getGateProfile', () => {
    it('returns the correct profile for each band', () => {
      const trivial = getGateProfile(2);
      expect(trivial.band).toBe('trivial');
      expect(trivial.testCoverageThreshold).toBe(60);
      expect(trivial.reviewRequired).toBe(false);

      const standard = getGateProfile(5);
      expect(standard.band).toBe('standard');
      expect(standard.testCoverageThreshold).toBe(75);
      expect(standard.reviewRequired).toBe(true);

      const complex = getGateProfile(7);
      expect(complex.band).toBe('complex');
      expect(complex.testCoverageThreshold).toBe(85);
      expect(complex.securityScanRequired).toBe(true);

      const critical = getGateProfile(10);
      expect(critical.band).toBe('critical');
      expect(critical.testCoverageThreshold).toBe(90);
    });
  });

  describe('adjustEnforcement', () => {
    it('relaxes enforcement for trivial band', () => {
      expect(adjustEnforcement('hard-mandatory', 'trivial')).toBe('soft-mandatory');
      expect(adjustEnforcement('soft-mandatory', 'trivial')).toBe('advisory');
      expect(adjustEnforcement('advisory', 'trivial')).toBe('advisory');
    });

    it('keeps enforcement unchanged for standard band', () => {
      expect(adjustEnforcement('hard-mandatory', 'standard')).toBe('hard-mandatory');
      expect(adjustEnforcement('soft-mandatory', 'standard')).toBe('soft-mandatory');
      expect(adjustEnforcement('advisory', 'standard')).toBe('advisory');
    });

    it('tightens enforcement for complex band', () => {
      expect(adjustEnforcement('advisory', 'complex')).toBe('soft-mandatory');
      expect(adjustEnforcement('soft-mandatory', 'complex')).toBe('hard-mandatory');
      expect(adjustEnforcement('hard-mandatory', 'complex')).toBe('hard-mandatory');
    });

    it('tightens enforcement for critical band', () => {
      expect(adjustEnforcement('advisory', 'critical')).toBe('soft-mandatory');
      expect(adjustEnforcement('soft-mandatory', 'critical')).toBe('hard-mandatory');
    });
  });

  describe('adjustGateForComplexity', () => {
    it('adjusts a gate with trivial complexity', () => {
      const gate = makeGate('test-coverage', 'soft-mandatory');
      const adjusted = adjustGateForComplexity(2, gate);
      expect(adjusted.enforcement).toBe('advisory');
      expect(adjusted.originalEnforcement).toBe('soft-mandatory');
      expect(adjusted.complexityBand).toBe('trivial');
      expect(adjusted.adjustedThresholds?.testCoverageThreshold).toBe(60);
    });

    it('adjusts a gate with critical complexity', () => {
      const gate = makeGate('lint', 'advisory');
      const adjusted = adjustGateForComplexity(10, gate);
      expect(adjusted.enforcement).toBe('soft-mandatory');
      expect(adjusted.originalEnforcement).toBe('advisory');
      expect(adjusted.complexityBand).toBe('critical');
      expect(adjusted.adjustedThresholds?.securityScanRequired).toBe(true);
    });

    it('applies overrides from the database', () => {
      const gate = makeGate('security', 'advisory');
      const overrides = [{
        id: 1,
        gateName: 'security',
        complexityBand: 'trivial',
        enforcementLevel: 'hard-mandatory',
        thresholdOverrides: JSON.stringify({ testCoverageThreshold: 99 }),
        active: 1,
      }];
      const adjusted = adjustGateForComplexity(1, gate, overrides);
      expect(adjusted.enforcement).toBe('hard-mandatory');
      expect(adjusted.adjustedThresholds?.testCoverageThreshold).toBe(99);
    });
  });

  describe('adjustGatesForComplexity', () => {
    it('adjusts all gates in a list', () => {
      const gates = [
        makeGate('test-coverage', 'soft-mandatory'),
        makeGate('lint', 'hard-mandatory'),
      ];
      const adjusted = adjustGatesForComplexity(2, gates);
      expect(adjusted).toHaveLength(2);
      expect(adjusted[0].enforcement).toBe('advisory');
      expect(adjusted[1].enforcement).toBe('soft-mandatory');
    });

    it('handles empty gate list', () => {
      const adjusted = adjustGatesForComplexity(5, []);
      expect(adjusted).toHaveLength(0);
    });
  });

  describe('computeGateAdjustments', () => {
    it('computes adjustment report', () => {
      const gates = [
        makeGate('test-coverage', 'soft-mandatory'),
        makeGate('lint', 'advisory'),
      ];
      const adjustments = computeGateAdjustments(9, gates);
      expect(adjustments).toHaveLength(2);
      expect(adjustments[0].originalEnforcement).toBe('soft-mandatory');
      expect(adjustments[0].adjustedEnforcement).toBe('hard-mandatory');
      expect(adjustments[0].band).toBe('critical');
      expect(adjustments[1].originalEnforcement).toBe('advisory');
      expect(adjustments[1].adjustedEnforcement).toBe('soft-mandatory');
    });
  });
});
