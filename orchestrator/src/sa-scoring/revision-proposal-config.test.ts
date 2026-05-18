/**
 * Tests for RFC-0031 §12.6 per-org calibration config (Refit AISDLC-310).
 *
 * AC coverage:
 *   AC #1 — confidenceThresholds.highSampleSize + lowSampleSize read from
 *            calibration.yaml (defaults: 20, 5)
 *   AC #2 — rejectionPrecedent.weights.* read from calibration.yaml
 *            (defaults: 0.8 / 0.5 / 0.2)
 *   AC #3 — rejectionPrecedent.confidencePenaltyFloor read from calibration.yaml
 *            (default: 0.2)
 *   AC #4 — Validation: highSampleSize > lowSampleSize > 0; weights in [0,1];
 *            floor in [0,1]
 *   AC #6 — Test coverage: default load + override load + invalid config rejection
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONFIDENCE_HIGH_SAMPLE_SIZE,
  DEFAULT_CONFIDENCE_LOW_SAMPLE_SIZE,
  DEFAULT_REJECTION_WEIGHT_HIGH,
  DEFAULT_REJECTION_WEIGHT_MEDIUM,
  DEFAULT_REJECTION_WEIGHT_LOW,
  DEFAULT_CONFIDENCE_PENALTY_FLOOR,
  DEFAULT_RESOLVED_CALIBRATION_CONFIG,
  validateRevisionProposalCalibrationConfig,
  resolveRevisionProposalCalibrationConfig,
  parseRevisionProposalCalibrationYaml,
} from './revision-proposal-config.js';
import {
  computeConfidence,
  recordRejection,
  computeRejectionPrecedentFactor,
  type DIDRevisionProposalEvent,
} from './revision-proposal.js';

// ── Default constant exports ──────────────────────────────────────────

describe('default constant exports (AC #1, #2, #3)', () => {
  it('DEFAULT_CONFIDENCE_HIGH_SAMPLE_SIZE is 20 (OQ-12.1 shipped default)', () => {
    expect(DEFAULT_CONFIDENCE_HIGH_SAMPLE_SIZE).toBe(20);
  });

  it('DEFAULT_CONFIDENCE_LOW_SAMPLE_SIZE is 5 (OQ-12.1 shipped default)', () => {
    expect(DEFAULT_CONFIDENCE_LOW_SAMPLE_SIZE).toBe(5);
  });

  it('DEFAULT_REJECTION_WEIGHT_HIGH is 0.8 (OQ-12.5 shipped default)', () => {
    expect(DEFAULT_REJECTION_WEIGHT_HIGH).toBe(0.8);
  });

  it('DEFAULT_REJECTION_WEIGHT_MEDIUM is 0.5 (OQ-12.5 shipped default)', () => {
    expect(DEFAULT_REJECTION_WEIGHT_MEDIUM).toBe(0.5);
  });

  it('DEFAULT_REJECTION_WEIGHT_LOW is 0.2 (OQ-12.5 shipped default)', () => {
    expect(DEFAULT_REJECTION_WEIGHT_LOW).toBe(0.2);
  });

  it('DEFAULT_CONFIDENCE_PENALTY_FLOOR is 0.2 (OQ-12.5 shipped default)', () => {
    expect(DEFAULT_CONFIDENCE_PENALTY_FLOOR).toBe(0.2);
  });

  it('DEFAULT_RESOLVED_CALIBRATION_CONFIG carries all shipped defaults', () => {
    const c = DEFAULT_RESOLVED_CALIBRATION_CONFIG;
    expect(c.confidenceThresholds.highSampleSize).toBe(20);
    expect(c.confidenceThresholds.lowSampleSize).toBe(5);
    expect(c.rejectionPrecedent.weights.highConfidenceRejection).toBe(0.8);
    expect(c.rejectionPrecedent.weights.mediumConfidenceRejection).toBe(0.5);
    expect(c.rejectionPrecedent.weights.lowConfidenceRejection).toBe(0.2);
    expect(c.rejectionPrecedent.confidencePenaltyFloor).toBe(0.2);
    expect(c.lockNoProposal).toEqual([]);
  });
});

// ── resolveRevisionProposalCalibrationConfig — default load ────────────

describe('resolveRevisionProposalCalibrationConfig — default load (AC #1, #2, #3, #6)', () => {
  it('returns all shipped defaults when called with empty config', () => {
    const config = resolveRevisionProposalCalibrationConfig({});
    expect(config.confidenceThresholds.highSampleSize).toBe(20);
    expect(config.confidenceThresholds.lowSampleSize).toBe(5);
    expect(config.rejectionPrecedent.weights.highConfidenceRejection).toBe(0.8);
    expect(config.rejectionPrecedent.weights.mediumConfidenceRejection).toBe(0.5);
    expect(config.rejectionPrecedent.weights.lowConfidenceRejection).toBe(0.2);
    expect(config.rejectionPrecedent.confidencePenaltyFloor).toBe(0.2);
    expect(config.lockNoProposal).toEqual([]);
  });

  it('returns all shipped defaults when called with no argument', () => {
    const config = resolveRevisionProposalCalibrationConfig();
    expect(config.confidenceThresholds.highSampleSize).toBe(20);
    expect(config.confidenceThresholds.lowSampleSize).toBe(5);
  });
});

// ── resolveRevisionProposalCalibrationConfig — override load ──────────

describe('resolveRevisionProposalCalibrationConfig — override load (AC #1, #2, #3, #6)', () => {
  it('applies custom highSampleSize while preserving lowSampleSize default', () => {
    const config = resolveRevisionProposalCalibrationConfig({
      confidenceThresholds: { highSampleSize: 30 },
    });
    expect(config.confidenceThresholds.highSampleSize).toBe(30);
    expect(config.confidenceThresholds.lowSampleSize).toBe(5); // default preserved
  });

  it('applies custom lowSampleSize while preserving highSampleSize default', () => {
    const config = resolveRevisionProposalCalibrationConfig({
      confidenceThresholds: { lowSampleSize: 3 },
    });
    expect(config.confidenceThresholds.highSampleSize).toBe(20); // default preserved
    expect(config.confidenceThresholds.lowSampleSize).toBe(3);
  });

  it('applies custom rejection weights while preserving untouched defaults', () => {
    const config = resolveRevisionProposalCalibrationConfig({
      rejectionPrecedent: {
        weights: { highConfidenceRejection: 0.9 },
      },
    });
    expect(config.rejectionPrecedent.weights.highConfidenceRejection).toBe(0.9);
    expect(config.rejectionPrecedent.weights.mediumConfidenceRejection).toBe(0.5); // default
    expect(config.rejectionPrecedent.weights.lowConfidenceRejection).toBe(0.2); // default
  });

  it('applies custom confidencePenaltyFloor', () => {
    const config = resolveRevisionProposalCalibrationConfig({
      rejectionPrecedent: { confidencePenaltyFloor: 0.1 },
    });
    expect(config.rejectionPrecedent.confidencePenaltyFloor).toBe(0.1);
  });

  it('applies lockNoProposal override', () => {
    const config = resolveRevisionProposalCalibrationConfig({
      lockNoProposal: ['$.soulPurpose.mission'],
    });
    expect(config.lockNoProposal).toEqual(['$.soulPurpose.mission']);
  });

  it('applies all overrides together', () => {
    const config = resolveRevisionProposalCalibrationConfig({
      lockNoProposal: ['$.foo'],
      confidenceThresholds: { highSampleSize: 50, lowSampleSize: 10 },
      rejectionPrecedent: {
        weights: {
          highConfidenceRejection: 0.9,
          mediumConfidenceRejection: 0.6,
          lowConfidenceRejection: 0.1,
        },
        confidencePenaltyFloor: 0.15,
      },
    });
    expect(config.lockNoProposal).toEqual(['$.foo']);
    expect(config.confidenceThresholds.highSampleSize).toBe(50);
    expect(config.confidenceThresholds.lowSampleSize).toBe(10);
    expect(config.rejectionPrecedent.weights.highConfidenceRejection).toBe(0.9);
    expect(config.rejectionPrecedent.weights.mediumConfidenceRejection).toBe(0.6);
    expect(config.rejectionPrecedent.weights.lowConfidenceRejection).toBe(0.1);
    expect(config.rejectionPrecedent.confidencePenaltyFloor).toBe(0.15);
  });
});

// ── validateRevisionProposalCalibrationConfig — invalid rejection ──────

describe('validateRevisionProposalCalibrationConfig — invalid config rejection (AC #4, #6)', () => {
  it('passes empty config (all defaults)', () => {
    expect(validateRevisionProposalCalibrationConfig({}).valid).toBe(true);
  });

  it('passes valid custom thresholds where highSampleSize > lowSampleSize > 0', () => {
    const result = validateRevisionProposalCalibrationConfig({
      confidenceThresholds: { highSampleSize: 30, lowSampleSize: 10 },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects when highSampleSize === lowSampleSize', () => {
    const result = validateRevisionProposalCalibrationConfig({
      confidenceThresholds: { highSampleSize: 10, lowSampleSize: 10 },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === 'confidenceThresholds')).toBe(true);
    }
  });

  it('rejects when highSampleSize < lowSampleSize', () => {
    const result = validateRevisionProposalCalibrationConfig({
      confidenceThresholds: { highSampleSize: 3, lowSampleSize: 10 },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === 'confidenceThresholds')).toBe(true);
    }
  });

  it('rejects when lowSampleSize is 0 (must be > 0)', () => {
    const result = validateRevisionProposalCalibrationConfig({
      confidenceThresholds: { lowSampleSize: 0 },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === 'confidenceThresholds.lowSampleSize')).toBe(
        true,
      );
    }
  });

  it('rejects when highSampleSize is 0 (must be > 0)', () => {
    const result = validateRevisionProposalCalibrationConfig({
      confidenceThresholds: { highSampleSize: 0, lowSampleSize: 0 },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects when highSampleSize is negative', () => {
    const result = validateRevisionProposalCalibrationConfig({
      confidenceThresholds: { highSampleSize: -5 },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects when lowSampleSize is negative', () => {
    const result = validateRevisionProposalCalibrationConfig({
      confidenceThresholds: { lowSampleSize: -1 },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects when highConfidenceRejection weight > 1', () => {
    const result = validateRevisionProposalCalibrationConfig({
      rejectionPrecedent: {
        weights: { highConfidenceRejection: 1.1 },
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((e) => e.field === 'rejectionPrecedent.weights.highConfidenceRejection'),
      ).toBe(true);
    }
  });

  it('rejects when mediumConfidenceRejection weight < 0', () => {
    const result = validateRevisionProposalCalibrationConfig({
      rejectionPrecedent: {
        weights: { mediumConfidenceRejection: -0.1 },
      },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects when lowConfidenceRejection weight > 1', () => {
    const result = validateRevisionProposalCalibrationConfig({
      rejectionPrecedent: {
        weights: { lowConfidenceRejection: 1.5 },
      },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects when confidencePenaltyFloor > 1', () => {
    const result = validateRevisionProposalCalibrationConfig({
      rejectionPrecedent: { confidencePenaltyFloor: 1.1 },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((e) => e.field === 'rejectionPrecedent.confidencePenaltyFloor'),
      ).toBe(true);
    }
  });

  it('rejects when confidencePenaltyFloor < 0', () => {
    const result = validateRevisionProposalCalibrationConfig({
      rejectionPrecedent: { confidencePenaltyFloor: -0.1 },
    });
    expect(result.valid).toBe(false);
  });

  it('accumulates multiple errors when multiple fields are invalid', () => {
    const result = validateRevisionProposalCalibrationConfig({
      confidenceThresholds: { highSampleSize: 3, lowSampleSize: 10 },
      rejectionPrecedent: {
        weights: { highConfidenceRejection: 2.0 },
        confidencePenaltyFloor: -1,
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});

// ── parseRevisionProposalCalibrationYaml — YAML loading ───────────────

describe('parseRevisionProposalCalibrationYaml (AC #1, #2, #3, #6)', () => {
  it('default load: empty calibration block resolves to shipped defaults', () => {
    const yaml = `calibration: {}`;
    const config = parseRevisionProposalCalibrationYaml(yaml);
    expect(config.confidenceThresholds.highSampleSize).toBe(20);
    expect(config.confidenceThresholds.lowSampleSize).toBe(5);
    expect(config.rejectionPrecedent.weights.highConfidenceRejection).toBe(0.8);
    expect(config.rejectionPrecedent.weights.mediumConfidenceRejection).toBe(0.5);
    expect(config.rejectionPrecedent.weights.lowConfidenceRejection).toBe(0.2);
    expect(config.rejectionPrecedent.confidencePenaltyFloor).toBe(0.2);
  });

  it('default load: omitted calibration key resolves to shipped defaults', () => {
    // A calibration.yaml that has other keys but no `calibration:` block
    const yaml = `apiVersion: ai-sdlc.io/v1alpha1\nkind: SomeOtherThing`;
    const config = parseRevisionProposalCalibrationYaml(yaml);
    expect(config.confidenceThresholds.highSampleSize).toBe(20);
    expect(config.confidenceThresholds.lowSampleSize).toBe(5);
  });

  it('override load: custom confidenceThresholds applied from YAML', () => {
    const yaml = `
calibration:
  confidenceThresholds:
    highSampleSize: 30
    lowSampleSize: 8
`;
    const config = parseRevisionProposalCalibrationYaml(yaml);
    expect(config.confidenceThresholds.highSampleSize).toBe(30);
    expect(config.confidenceThresholds.lowSampleSize).toBe(8);
  });

  it('override load: custom rejectionPrecedent applied from YAML', () => {
    const yaml = `
calibration:
  rejectionPrecedent:
    weights:
      highConfidenceRejection: 0.9
      mediumConfidenceRejection: 0.6
      lowConfidenceRejection: 0.1
    confidencePenaltyFloor: 0.15
`;
    const config = parseRevisionProposalCalibrationYaml(yaml);
    expect(config.rejectionPrecedent.weights.highConfidenceRejection).toBe(0.9);
    expect(config.rejectionPrecedent.weights.mediumConfidenceRejection).toBe(0.6);
    expect(config.rejectionPrecedent.weights.lowConfidenceRejection).toBe(0.1);
    expect(config.rejectionPrecedent.confidencePenaltyFloor).toBe(0.15);
  });

  it('override load: lockNoProposal list applied from YAML', () => {
    const yaml = `
calibration:
  lockNoProposal:
    - $.soulPurpose.mission
    - $.identityClass.core.foo
`;
    const config = parseRevisionProposalCalibrationYaml(yaml);
    expect(config.lockNoProposal).toEqual(['$.soulPurpose.mission', '$.identityClass.core.foo']);
  });

  it('override load: full §12.6 schema example parses correctly', () => {
    const yaml = `
calibration:
  lockNoProposal:
    - $.identityClass.evolving.foo
    - $.identityClass.core.bar

  confidenceThresholds:
    highSampleSize: 20
    lowSampleSize: 5

  rejectionPrecedent:
    weights:
      highConfidenceRejection: 0.8
      mediumConfidenceRejection: 0.5
      lowConfidenceRejection: 0.2
    confidencePenaltyFloor: 0.2
`;
    const config = parseRevisionProposalCalibrationYaml(yaml);
    expect(config.lockNoProposal).toEqual([
      '$.identityClass.evolving.foo',
      '$.identityClass.core.bar',
    ]);
    expect(config.confidenceThresholds.highSampleSize).toBe(20);
    expect(config.confidenceThresholds.lowSampleSize).toBe(5);
    expect(config.rejectionPrecedent.weights.highConfidenceRejection).toBe(0.8);
    expect(config.rejectionPrecedent.confidencePenaltyFloor).toBe(0.2);
  });

  it('invalid config rejection: throws when highSampleSize <= lowSampleSize', () => {
    const yaml = `
calibration:
  confidenceThresholds:
    highSampleSize: 5
    lowSampleSize: 10
`;
    expect(() => parseRevisionProposalCalibrationYaml(yaml)).toThrow(
      /calibration\.yaml validation failed/,
    );
  });

  it('invalid config rejection: throws when weight out of [0, 1]', () => {
    const yaml = `
calibration:
  rejectionPrecedent:
    weights:
      highConfidenceRejection: 2.0
`;
    expect(() => parseRevisionProposalCalibrationYaml(yaml)).toThrow(
      /calibration\.yaml validation failed/,
    );
  });

  it('invalid config rejection: throws when confidencePenaltyFloor out of [0, 1]', () => {
    const yaml = `
calibration:
  rejectionPrecedent:
    confidencePenaltyFloor: 1.5
`;
    expect(() => parseRevisionProposalCalibrationYaml(yaml)).toThrow(
      /calibration\.yaml validation failed/,
    );
  });

  it('invalid config rejection: error message lists all violations', () => {
    const yaml = `
calibration:
  confidenceThresholds:
    highSampleSize: 3
    lowSampleSize: 10
  rejectionPrecedent:
    confidencePenaltyFloor: -0.5
`;
    try {
      parseRevisionProposalCalibrationYaml(yaml);
      expect.fail('Expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('confidenceThresholds');
      expect(msg).toContain('confidencePenaltyFloor');
    }
  });
});

// ── Integration: revision-proposal functions respect calibration config ─

describe('revision-proposal functions respect calibration config (AC #1, #2, #3)', () => {
  const baseTrigger = {
    dismissSignals: 25,
    escalateSignals: 5,
    demandMisalignment: 0.1,
    driftEvents: 2,
    triggerWindow: 'P60D',
  };

  // AC #1 — computeConfidence respects custom highSampleSize
  describe('computeConfidence respects calibration config (AC #1)', () => {
    it('uses default thresholds when no config provided (unchanged behavior)', () => {
      // sampleSize = 25+5+2 = 32 >= 20 → high (with evolving + non-ambiguous)
      expect(computeConfidence(baseTrigger, 'healthy', 'evolving')).toBe('high');
    });

    it('uses custom highSampleSize from config — raises threshold to 50', () => {
      const config = resolveRevisionProposalCalibrationConfig({
        confidenceThresholds: { highSampleSize: 50 },
      });
      // sampleSize 32 < 50 → no longer 'high' → falls to 'medium'
      expect(computeConfidence(baseTrigger, 'healthy', 'evolving', config)).toBe('medium');
    });

    it('uses custom lowSampleSize from config — lowers threshold to 40', () => {
      const config = resolveRevisionProposalCalibrationConfig({
        confidenceThresholds: { lowSampleSize: 40, highSampleSize: 60 },
      });
      // sampleSize 32 < 40 (new low threshold) → forced 'low'
      expect(computeConfidence(baseTrigger, 'healthy', 'evolving', config)).toBe('low');
    });

    it('raising highSampleSize to exact sample count still gives high', () => {
      const config = resolveRevisionProposalCalibrationConfig({
        confidenceThresholds: { highSampleSize: 32 }, // sampleSize 32 >= 32
      });
      expect(computeConfidence(baseTrigger, 'healthy', 'evolving', config)).toBe('high');
    });
  });

  // AC #2 — recordRejection respects custom weights
  describe('recordRejection respects calibration config (AC #2)', () => {
    const baseProposal: DIDRevisionProposalEvent = {
      type: 'DIDRevisionProposal',
      proposalId: 'p1',
      scope: 'shard',
      shardId: 'acme',
      field: 'soulPurpose.mission',
      currentValue: 'old',
      proposedValue: 'new',
      identityClass: 'evolving',
      classification: 'healthy',
      classificationEvidence: {
        demandClusterICPMatchRate: 0.8,
        demandClusterChurnCorrelation: 0.7,
        dismissToEscalateRatio: 3.0,
        coreDIDFieldsAffected: false,
      },
      triggerEvidence: {
        dismissSignals: 15,
        escalateSignals: 2,
        demandMisalignment: 0.1,
        driftEvents: 1,
        triggerWindow: 'P60D',
      },
      confidence: 'high',
      approvalPath: 'pillarLead',
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    it('uses default weight 0.8 for high-confidence rejection without config', () => {
      const record = recordRejection(
        baseProposal,
        'alex@example.com',
        'DID accurately reflects intent',
      );
      expect(record.rejectionPrecedentWeight).toBe(0.8);
    });

    it('uses custom high weight from config', () => {
      const config = resolveRevisionProposalCalibrationConfig({
        rejectionPrecedent: { weights: { highConfidenceRejection: 0.95 } },
      });
      const record = recordRejection(
        baseProposal,
        'alex@example.com',
        'DID accurately reflects intent',
        undefined,
        config,
      );
      expect(record.rejectionPrecedentWeight).toBe(0.95);
    });

    it('uses custom medium weight from config', () => {
      const config = resolveRevisionProposalCalibrationConfig({
        rejectionPrecedent: { weights: { mediumConfidenceRejection: 0.4 } },
      });
      const mediumProposal = { ...baseProposal, confidence: 'medium' as const };
      const record = recordRejection(
        mediumProposal,
        'dom@example.com',
        'not yet — needs more evidence',
        undefined,
        config,
      );
      expect(record.rejectionPrecedentWeight).toBe(0.4);
    });

    it('uses custom low weight from config', () => {
      const config = resolveRevisionProposalCalibrationConfig({
        rejectionPrecedent: { weights: { lowConfidenceRejection: 0.05 } },
      });
      const lowProposal = { ...baseProposal, confidence: 'low' as const };
      const record = recordRejection(
        lowProposal,
        'morgan@example.com',
        'noise — appears stochastic, hold off',
        undefined,
        config,
      );
      expect(record.rejectionPrecedentWeight).toBe(0.05);
    });
  });

  // AC #3 — computeRejectionPrecedentFactor respects custom floor
  describe('computeRejectionPrecedentFactor respects calibration config (AC #3)', () => {
    const highWeightRejections = [
      {
        proposalId: 'p1',
        shardId: 'acme',
        field: 'soulPurpose.mission',
        rejectedBy: 'alex@example.com',
        rationale: 'operator-affirmed stay',
        rejectedAt: new Date().toISOString(),
        classification: 'healthy' as const,
        rejectionPrecedentWeight: 0.8,
      },
    ];

    it('uses default floor 0.2 without config', () => {
      // factor = 1.0 - 0.8 * 0.5 = 0.6; max(0.2, 0.6) = 0.6
      const factor = computeRejectionPrecedentFactor('soulPurpose.mission', highWeightRejections);
      expect(factor).toBeCloseTo(0.6, 6);
    });

    it('uses custom floor 0.1 from config (lower floor allows more suppression)', () => {
      const config = resolveRevisionProposalCalibrationConfig({
        rejectionPrecedent: { confidencePenaltyFloor: 0.1 },
      });
      // factor = 1.0 - 0.8 * 0.5 = 0.6; max(0.1, 0.6) = 0.6 (floor not hit here)
      const factor = computeRejectionPrecedentFactor(
        'soulPurpose.mission',
        highWeightRejections,
        config,
      );
      expect(factor).toBeCloseTo(0.6, 6);
    });

    it('custom floor 0.7 increases minimum factor (more conservative suppression)', () => {
      const config = resolveRevisionProposalCalibrationConfig({
        rejectionPrecedent: { confidencePenaltyFloor: 0.7 },
      });
      // factor = 1.0 - 0.8 * 0.5 = 0.6; max(0.7, 0.6) = 0.7 (floor kicks in)
      const factor = computeRejectionPrecedentFactor(
        'soulPurpose.mission',
        highWeightRejections,
        config,
      );
      expect(factor).toBeCloseTo(0.7, 6);
    });

    it('floor is applied when computed rawFactor would go below it', () => {
      // Artificially high rejectionPrecedentWeight to force rawFactor below floor
      const heavyRejections = [{ ...highWeightRejections[0], rejectionPrecedentWeight: 1.6 }];
      const config = resolveRevisionProposalCalibrationConfig({
        rejectionPrecedent: { confidencePenaltyFloor: 0.3 },
      });
      // rawFactor = 1.0 - 1.6 * 0.5 = 0.2; max(0.3, 0.2) = 0.3
      const factor = computeRejectionPrecedentFactor(
        'soulPurpose.mission',
        heavyRejections,
        config,
      );
      expect(factor).toBeCloseTo(0.3, 6);
    });
  });
});
