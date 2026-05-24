/**
 * Tests for the RFC-0025 failure-mode classifier — Phase 2 confidence-
 * bucketed classifier (AISDLC-303 / OQ-1).
 *
 * Covers:
 *   - §5 taxonomy classification (all 4 classes)
 *   - OQ-1 three-tier confidence buckets:
 *       - `'auto-classify'` (≥ autoClassify, default 0.7)
 *       - `'ambiguous'`     (≥ ambiguous, < autoClassify; default 0.3..0.7)
 *       - `'unclassified'`  (< ambiguous, default 0.3) — log-only, no surface
 *   - Per-org threshold overrides + per-call thresholds via ctx
 *   - Threshold-boundary edge cases (`==` autoClassify, `==` ambiguous, reversed)
 *   - OQ-10 / §10: vendor-namespace enforcement for custom subclasses
 *   - §7 severity rubric (composite = max(operatorTimeCost, blastRadius),
 *     raised by 1 when frequency is high)
 *   - Caller-provided `subclassHint` + `severityAxes` overrides
 *   - Calibration loop (`recordClassificationOverride` / silence sweep)
 */

import { describe, expect, it } from 'vitest';

import {
  _bucketForConfidence,
  _resolveEffectiveThresholds,
  _scoreSignal,
  ClassificationError,
  classifyFailure,
  computeSeverity,
  DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLDS,
  validateVendorNamespace,
  type ClassificationContext,
  type FailureSignal,
  type SeverityAxes,
} from './quality-classifier.js';

// FailureSignal is re-exported from quality-classifier.ts for consumers.
type MinimalFailureSignal = Pick<FailureSignal, 'stderr' | 'exitCode' | 'source'>;

function signal(
  stderr = '',
  exitCode: number | null = null,
  source?: string,
): MinimalFailureSignal {
  return { stderr, exitCode, source } as FailureSignal;
}

// ── §7 Severity rubric ────────────────────────────────────────────────

describe('computeSeverity', () => {
  it('high + high → high (no frequency bump needed)', () => {
    const axes: SeverityAxes = { operatorTimeCost: 'high', blastRadius: 'high', frequency: 'low' };
    expect(computeSeverity(axes).composite).toBe('high');
  });

  it('low + low → low', () => {
    const axes: SeverityAxes = { operatorTimeCost: 'low', blastRadius: 'low', frequency: 'low' };
    expect(computeSeverity(axes).composite).toBe('low');
  });

  it('medium + low → medium', () => {
    const axes: SeverityAxes = { operatorTimeCost: 'medium', blastRadius: 'low', frequency: 'low' };
    expect(computeSeverity(axes).composite).toBe('medium');
  });

  it('low + low, frequency high → medium (bumped one level)', () => {
    const axes: SeverityAxes = { operatorTimeCost: 'low', blastRadius: 'low', frequency: 'high' };
    expect(computeSeverity(axes).composite).toBe('medium');
  });

  it('high + high, frequency high → high (already at ceiling)', () => {
    const axes: SeverityAxes = { operatorTimeCost: 'high', blastRadius: 'high', frequency: 'high' };
    expect(computeSeverity(axes).composite).toBe('high');
  });

  it('medium + medium, frequency high → high', () => {
    const axes: SeverityAxes = {
      operatorTimeCost: 'medium',
      blastRadius: 'medium',
      frequency: 'high',
    };
    expect(computeSeverity(axes).composite).toBe('high');
  });

  it('exposes axes in the result', () => {
    const axes: SeverityAxes = { operatorTimeCost: 'low', blastRadius: 'medium', frequency: 'low' };
    const result = computeSeverity(axes);
    expect(result.axes).toEqual(axes);
  });
});

// ── OQ-10 / §10 vendor-namespace enforcement ─────────────────────────

describe('validateVendorNamespace', () => {
  it('accepts built-in subclasses without a prefix', () => {
    expect(validateVendorNamespace('framework-contract-violated')).toBeNull();
    expect(validateVendorNamespace('framework-gate-faulty')).toBeNull();
  });

  it('accepts a valid vendor-namespaced custom subclass', () => {
    expect(validateVendorNamespace('acme-corp:custom-gate-faulty')).toBeNull();
    expect(validateVendorNamespace('my-company:billing-timeout')).toBeNull();
  });

  it('rejects un-namespaced custom subclasses', () => {
    const err = validateVendorNamespace('custom-gate-faulty');
    expect(err).not.toBeNull();
    expect(err).toMatch(/vendor-namespaced/);
  });

  it('rejects custom subclasses with an invalid vendor prefix (uppercase)', () => {
    const err = validateVendorNamespace('AcmeCorp:custom-gate');
    expect(err).not.toBeNull();
    expect(err).toMatch(/lower-kebab-case/);
  });

  it('rejects custom subclasses with an empty name after the colon', () => {
    const err = validateVendorNamespace('acme-corp:');
    expect(err).not.toBeNull();
    expect(err).toMatch(/non-empty name/);
  });
});

// ── §5 classification (legacy assertions; class/subclass still correct) ──

/**
 * Default-thresholds context: bypasses the per-org config lookup so
 * tests run hermetically. The shipping defaults (0.7 / 0.3) are applied.
 */
const HERMETIC_CTX: ClassificationContext = {
  resolvedThresholds: { ...DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLDS },
};

describe('classifyFailure', () => {
  // External dependency failures — strong signal → auto-classify
  it('classifies Anthropic API rate-limit as external-dependency-failed', () => {
    const result = classifyFailure(
      signal('Anthropic Claude: rate-limited, please retry') as FailureSignal,
      HERMETIC_CTX,
    );
    expect(result.class).toBe('external-dependency-failed');
    expect(result.bucket).toBe('auto-classify');
    expect(result.captureRecord).toBeNull();
  });

  it('classifies network timeout as external-dependency-failed', () => {
    const result = classifyFailure(
      signal('ECONNRESET: connection reset by peer') as FailureSignal,
      HERMETIC_CTX,
    );
    expect(result.class).toBe('external-dependency-failed');
    expect(result.bucket).toBe('auto-classify');
  });

  it('classifies GitHub API outage as external-dependency-failed', () => {
    const result = classifyFailure(
      signal('GitHub API error: service unavailable') as FailureSignal,
      HERMETIC_CTX,
    );
    expect(result.class).toBe('external-dependency-failed');
    expect(result.bucket).toBe('auto-classify');
  });

  // Framework contract violations — strong signal
  it('classifies developer prose return as framework-contract-violated', () => {
    const result = classifyFailure(
      signal('developer subagent returned prose instead of JSON envelope', 1) as FailureSignal,
      HERMETIC_CTX,
    );
    expect(result.class).toBe('framework-misbehaved');
    expect(result.bucket).toBe('auto-classify');
    expect(result.subclass).toBe('framework-contract-violated');
    expect(result.captureRecord).not.toBeNull();
    expect(result.captureRecord?.triage).toBe('framework-bug');
  });

  it('classifies SyntaxError JSON as framework-contract-violated', () => {
    const result = classifyFailure(
      signal(
        'SyntaxError: JSON parse failed — developer return was not valid JSON',
      ) as FailureSignal,
      HERMETIC_CTX,
    );
    expect(result.class).toBe('framework-misbehaved');
    expect(result.subclass).toBe('framework-contract-violated');
  });

  // Caller-provided subclass hint promotes confidence into auto-classify
  it('respects caller-provided subclassHint for framework-misbehaved', () => {
    const result = classifyFailure(
      signal('tick completed but DorConfig schema not registered', 1) as FailureSignal,
      {
        ...HERMETIC_CTX,
        subclassHint: 'framework-gate-faulty',
      },
    );
    expect(result.class).toBe('framework-misbehaved');
    expect(result.subclass).toBe('framework-gate-faulty');
    expect(result.bucket).toBe('auto-classify');
    expect(result.captureRecord).not.toBeNull();
  });

  // Vendor-namespace enforcement via subclassHint
  it('throws ClassificationError when subclassHint is un-namespaced custom subclass', () => {
    expect(() =>
      classifyFailure(signal('some error') as FailureSignal, {
        ...HERMETIC_CTX,
        subclassHint: 'my-custom-subclass',
      }),
    ).toThrow(ClassificationError);
  });

  it('accepts a valid vendor-namespaced custom subclass hint', () => {
    const result = classifyFailure(signal('billing system timeout', 1) as FailureSignal, {
      ...HERMETIC_CTX,
      subclassHint: 'acme-corp:billing-timeout',
    });
    expect(result.class).toBe('framework-misbehaved');
    expect(result.subclass).toBe('acme-corp:billing-timeout');
  });

  // Capture record audit trail
  it('populates captureRecord with auditTrail for framework-misbehaved', () => {
    const stderr = 'developer returned prose instead of JSON envelope';
    const result = classifyFailure(signal(stderr, 1) as FailureSignal, {
      ...HERMETIC_CTX,
      taskId: 'AISDLC-123',
      workerId: 'worker-abc',
    });
    expect(result.captureRecord?.taskId).toBe('AISDLC-123');
    expect(result.captureRecord?.workerId).toBe('worker-abc');
    expect(result.captureRecord?.auditTrail.originalFailure.stderr).toContain('prose');
    expect(result.captureRecord?.auditTrail.originalFailure.exitCode).toBe(1);
  });

  // Severity axes override
  it('respects caller-provided severityAxes override', () => {
    const result = classifyFailure(signal('developer returned prose', 1) as FailureSignal, {
      ...HERMETIC_CTX,
      subclassHint: 'framework-contract-violated',
      severityAxes: { operatorTimeCost: 'high', blastRadius: 'high', frequency: 'high' },
    });
    expect(result.severity.composite).toBe('high');
    expect(result.severity.axes.frequency).toBe('high');
  });
});

// ── OQ-1 three-tier confidence buckets (AISDLC-303 Phase 2) ─────────────

describe('OQ-1 confidence bucket selection', () => {
  describe('bucket = auto-classify (≥ autoClassify threshold)', () => {
    it('strong external-dependency signal lands in auto-classify', () => {
      const result = classifyFailure(
        signal('Anthropic API: rate-limited', 1) as FailureSignal,
        HERMETIC_CTX,
      );
      expect(result.bucket).toBe('auto-classify');
      expect(result.confidence).toBeGreaterThanOrEqual(
        DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLDS.autoClassify,
      );
      expect(result.class).toBe('external-dependency-failed');
    });

    it('strong contract-violation signal lands in auto-classify with capture record', () => {
      const result = classifyFailure(
        signal('developer returned prose instead of JSON envelope', 1) as FailureSignal,
        HERMETIC_CTX,
      );
      expect(result.bucket).toBe('auto-classify');
      expect(result.class).toBe('framework-misbehaved');
      expect(result.captureRecord).not.toBeNull();
    });

    it('auto-classify result carries the effective thresholds in the audit', () => {
      const result = classifyFailure(
        signal('Anthropic API: rate-limited', 1) as FailureSignal,
        HERMETIC_CTX,
      );
      expect(result.effectiveThresholds).toEqual(DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLDS);
    });
  });

  describe('bucket = ambiguous (≥ ambiguous, < autoClassify)', () => {
    it('mid-confidence signal (perf-regression alone) lands in ambiguous', () => {
      const result = classifyFailure(
        signal('operation took dramatically longer than baseline', 1) as FailureSignal,
        HERMETIC_CTX,
      );
      expect(result.bucket).toBe('ambiguous');
      expect(result.class).toBe('ambiguous');
      expect(result.captureRecord).toBeNull();
      expect(result.confidence).toBeGreaterThanOrEqual(
        DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLDS.ambiguous,
      );
      expect(result.confidence).toBeLessThan(DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLDS.autoClassify);
    });

    it('mid-confidence sweep-incomplete signal lands in ambiguous', () => {
      // Single-pattern match: `sentinel.*not.*removed` only. Confidence ~
      // 0.55 (single match in soft family) + 0.05 (real failure) = 0.60,
      // which lands in the ambiguous bucket (0.3 ≤ 0.60 < 0.7).
      const result = classifyFailure(
        signal('sentinel not removed after early return', 1) as FailureSignal,
        HERMETIC_CTX,
      );
      expect(result.bucket).toBe('ambiguous');
      expect(result.class).toBe('ambiguous');
      expect(result.captureRecord).toBeNull();
    });

    it('rationale references the leading candidate when bucket is ambiguous', () => {
      const result = classifyFailure(
        signal('operation took dramatically longer than baseline', 1) as FailureSignal,
        HERMETIC_CTX,
      );
      expect(result.rationale).toMatch(/leading candidate/);
      expect(result.rationale).toMatch(/framework-misbehaved/);
    });
  });

  describe('bucket = unclassified (< ambiguous threshold)', () => {
    it('weak / inconclusive signal lands in unclassified', () => {
      const result = classifyFailure(
        signal('some random stderr output that matches no heuristic') as FailureSignal,
        HERMETIC_CTX,
      );
      expect(result.bucket).toBe('unclassified');
      expect(result.class).toBe('ambiguous');
      expect(result.captureRecord).toBeNull();
    });

    it('completely empty signal lands in unclassified', () => {
      const result = classifyFailure(signal('') as FailureSignal, HERMETIC_CTX);
      expect(result.bucket).toBe('unclassified');
      expect(result.captureRecord).toBeNull();
    });

    it('unclassified result writes to ctx.logger.info but NOT to operator surface', () => {
      const logs: string[] = [];
      const result = classifyFailure(signal('inscrutable stderr') as FailureSignal, {
        ...HERMETIC_CTX,
        logger: { info: (m): void => void logs.push(m) },
      });
      expect(result.bucket).toBe('unclassified');
      expect(result.captureRecord).toBeNull();
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toMatch(/unclassified/);
      expect(logs[0]).toMatch(/no operator surface/);
    });

    it('unclassified rationale documents the breakdown for post-mortem', () => {
      const result = classifyFailure(signal('inscrutable stderr') as FailureSignal, HERMETIC_CTX);
      expect(result.rationale).toMatch(/log-only/);
      expect(result.rationale).toMatch(/scores=/);
    });
  });
});

// ── Threshold-boundary edge cases ────────────────────────────────────────

describe('threshold-boundary edge cases', () => {
  it('confidence == autoClassify is treated as auto-classify (inclusive lower bound)', () => {
    // Use a fixed-threshold call where we can target an exact boundary by
    // setting both thresholds to the same value and verifying the bucket.
    const result = classifyFailure(signal('Anthropic API: rate-limited', 1) as FailureSignal, {
      ...HERMETIC_CTX,
      resolvedThresholds: { autoClassify: 0.75, ambiguous: 0.3 },
    });
    // Confidence for this signal is 0.75 + realFailureSignal (0.05) = 0.80
    // which is ≥ 0.75 → auto-classify.
    expect(result.bucket).toBe('auto-classify');
  });

  it('confidence at the precise autoClassify boundary buckets as auto-classify', () => {
    // Pin a known confidence via the bucket helper directly.
    expect(_bucketForConfidence(0.7, { autoClassify: 0.7, ambiguous: 0.3 })).toBe('auto-classify');
  });

  it('confidence just below autoClassify buckets as ambiguous', () => {
    expect(_bucketForConfidence(0.6999, { autoClassify: 0.7, ambiguous: 0.3 })).toBe('ambiguous');
  });

  it('confidence at the precise ambiguous boundary buckets as ambiguous', () => {
    expect(_bucketForConfidence(0.3, { autoClassify: 0.7, ambiguous: 0.3 })).toBe('ambiguous');
  });

  it('confidence just below ambiguous buckets as unclassified', () => {
    expect(_bucketForConfidence(0.2999, { autoClassify: 0.7, ambiguous: 0.3 })).toBe(
      'unclassified',
    );
  });

  it('confidence = 0 buckets as unclassified regardless of thresholds', () => {
    expect(_bucketForConfidence(0, { autoClassify: 0.7, ambiguous: 0.3 })).toBe('unclassified');
  });

  it('confidence = 1 buckets as auto-classify regardless of thresholds', () => {
    expect(_bucketForConfidence(1, { autoClassify: 0.99, ambiguous: 0.5 })).toBe('auto-classify');
  });

  it('thresholds reversed by operator (ambiguous > autoClassify) are swapped silently', () => {
    const resolved = _resolveEffectiveThresholds({
      resolvedThresholds: { autoClassify: 0.3, ambiguous: 0.7 },
    });
    expect(resolved.autoClassify).toBe(0.7);
    expect(resolved.ambiguous).toBe(0.3);
  });

  it('per-call threshold override beats per-org config', () => {
    const result = classifyFailure(
      signal('operation took dramatically longer than baseline', 1) as FailureSignal,
      {
        ...HERMETIC_CTX,
        resolvedThresholds: { autoClassify: 0.4, ambiguous: 0.1 },
      },
    );
    // With a looser autoClassify threshold (0.4) the perf-regression signal
    // (~0.55) now lands in auto-classify rather than ambiguous.
    expect(result.bucket).toBe('auto-classify');
    expect(result.class).toBe('framework-misbehaved');
    expect(result.subclass).toBe('framework-perf-regression');
  });

  it('per-call threshold override can promote a normally-auto-classify result to ambiguous', () => {
    const result = classifyFailure(signal('Anthropic API: rate-limited', 1) as FailureSignal, {
      ...HERMETIC_CTX,
      resolvedThresholds: { autoClassify: 0.95, ambiguous: 0.1 },
    });
    expect(result.bucket).toBe('ambiguous');
    expect(result.class).toBe('ambiguous');
  });

  it('per-call thresholds out of range are clamped to [0, 1]', () => {
    const resolved = _resolveEffectiveThresholds({
      resolvedThresholds: { autoClassify: 1.5, ambiguous: -0.5 },
    });
    expect(resolved.autoClassify).toBe(1);
    expect(resolved.ambiguous).toBe(0);
  });

  it('NaN thresholds resolve to 0 (clamp)', () => {
    const resolved = _resolveEffectiveThresholds({
      resolvedThresholds: { autoClassify: Number.NaN, ambiguous: Number.NaN },
    });
    expect(resolved.autoClassify).toBe(0);
    expect(resolved.ambiguous).toBe(0);
  });
});

// ── Scoring breakdown smoke tests ────────────────────────────────────────

describe('scoreSignal heuristic', () => {
  it('returns zero scores for all classes when stderr is empty', () => {
    const breakdown = _scoreSignal('', null);
    for (const v of Object.values(breakdown)) {
      expect(v).toBe(0);
    }
  });

  it('produces a non-zero externalDependency score for an API outage signal', () => {
    const breakdown = _scoreSignal('Anthropic API rate-limited', 1);
    expect(breakdown.externalDependency).toBeGreaterThan(0);
    expect(breakdown.contractViolation).toBe(0);
  });

  it('produces a non-zero contractViolation score for a JSON envelope failure', () => {
    const breakdown = _scoreSignal('developer returned prose instead of JSON envelope', 1);
    expect(breakdown.contractViolation).toBeGreaterThan(0);
    expect(breakdown.externalDependency).toBe(0);
  });

  it('multiple pattern matches in the same family stack confidence above a single match', () => {
    const singleMatch = _scoreSignal('developer returned prose', 1);
    const doubleMatch = _scoreSignal(
      'developer returned prose AND JSON envelope required AND SyntaxError JSON',
      1,
    );
    expect(doubleMatch.contractViolation).toBeGreaterThan(singleMatch.contractViolation);
  });
});
