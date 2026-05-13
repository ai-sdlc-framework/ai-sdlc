/**
 * Tests for the RFC-0025 failure-mode classifier (AISDLC-270).
 *
 * Covers:
 *   - §5 taxonomy classification (all 4 classes)
 *   - OQ-1: default to `ambiguous` when signal is inconclusive
 *   - OQ-10 / §10: vendor-namespace enforcement for custom subclasses
 *   - §7 severity rubric (composite = max(operatorTimeCost, blastRadius),
 *     raised by 1 when frequency is high)
 *   - Caller-provided `subclassHint` + `severityAxes` overrides
 */

import { describe, expect, it } from 'vitest';

import {
  ClassificationError,
  classifyFailure,
  computeSeverity,
  validateVendorNamespace,
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

// ── §5 classification ─────────────────────────────────────────────────

describe('classifyFailure', () => {
  // OQ-1: default to ambiguous
  it('returns ambiguous when signal is inconclusive (OQ-1 default)', () => {
    const result = classifyFailure(signal('some random stderr output') as FailureSignal);
    expect(result.class).toBe('ambiguous');
    expect(result.captureRecord).toBeNull();
  });

  // External dependency failures
  it('classifies Anthropic API rate-limit as external-dependency-failed', () => {
    const result = classifyFailure(
      signal('Anthropic Claude: rate-limited, please retry') as FailureSignal,
    );
    expect(result.class).toBe('external-dependency-failed');
    expect(result.captureRecord).toBeNull();
  });

  it('classifies network timeout as external-dependency-failed', () => {
    const result = classifyFailure(signal('ECONNRESET: connection reset by peer') as FailureSignal);
    expect(result.class).toBe('external-dependency-failed');
  });

  it('classifies GitHub API outage as external-dependency-failed', () => {
    const result = classifyFailure(
      signal('GitHub API error: service unavailable') as FailureSignal,
    );
    expect(result.class).toBe('external-dependency-failed');
  });

  // Operator-under-decided failures
  it('classifies missing AC as operator-under-decided', () => {
    const result = classifyFailure(
      signal('AC list missing the case the failure exposed') as FailureSignal,
    );
    expect(result.class).toBe('operator-under-decided');
    expect(result.captureRecord).toBeNull();
  });

  it('classifies DoR failed as operator-under-decided', () => {
    const result = classifyFailure(signal('DoR failed: open question unanswered') as FailureSignal);
    expect(result.class).toBe('operator-under-decided');
  });

  // Framework contract violations
  it('classifies developer prose return as framework-contract-violated', () => {
    const result = classifyFailure(
      signal('developer subagent returned prose instead of JSON envelope', 1) as FailureSignal,
    );
    expect(result.class).toBe('framework-misbehaved');
    expect(result.subclass).toBe('framework-contract-violated');
    expect(result.captureRecord).not.toBeNull();
    expect(result.captureRecord?.triage).toBe('framework-bug');
  });

  it('classifies SyntaxError JSON as framework-contract-violated', () => {
    const result = classifyFailure(
      signal(
        'SyntaxError: JSON parse failed — developer return was not valid JSON',
      ) as FailureSignal,
    );
    expect(result.class).toBe('framework-misbehaved');
    expect(result.subclass).toBe('framework-contract-violated');
  });

  // Framework sweep incomplete
  it('classifies cleanup failure as framework-sweep-incomplete', () => {
    const result = classifyFailure(
      signal('cleanup fail: worktree left after failure') as FailureSignal,
    );
    expect(result.class).toBe('framework-misbehaved');
    expect(result.subclass).toBe('framework-sweep-incomplete');
  });

  // Framework silent failure
  it('classifies pre-dispatch filter throw as framework-silent-failure', () => {
    const result = classifyFailure(
      signal('pre-dispatch filter throw caught — silently dispatch attempted') as FailureSignal,
    );
    expect(result.class).toBe('framework-misbehaved');
    expect(result.subclass).toBe('framework-silent-failure');
  });

  // Caller-provided subclass hint
  it('respects caller-provided subclassHint for framework-misbehaved', () => {
    const result = classifyFailure(
      signal('tick completed but DorConfig schema not registered') as FailureSignal,
      {
        subclassHint: 'framework-gate-faulty',
      },
    );
    expect(result.class).toBe('framework-misbehaved');
    expect(result.subclass).toBe('framework-gate-faulty');
    expect(result.captureRecord).not.toBeNull();
  });

  // Vendor-namespace enforcement via subclassHint
  it('throws ClassificationError when subclassHint is un-namespaced custom subclass', () => {
    expect(() =>
      classifyFailure(signal('some error') as FailureSignal, {
        subclassHint: 'my-custom-subclass',
      }),
    ).toThrow(ClassificationError);
  });

  it('accepts a valid vendor-namespaced custom subclass hint', () => {
    const result = classifyFailure(signal('billing system timeout') as FailureSignal, {
      subclassHint: 'acme-corp:billing-timeout',
    });
    expect(result.class).toBe('framework-misbehaved');
    expect(result.subclass).toBe('acme-corp:billing-timeout');
  });

  // Capture record audit trail
  it('populates captureRecord with auditTrail for framework-misbehaved', () => {
    const stderr = 'developer returned prose instead of JSON envelope';
    const result = classifyFailure(signal(stderr, 1) as FailureSignal, {
      taskId: 'AISDLC-123',
      workerId: 'worker-abc',
    });
    expect(result.captureRecord?.taskId).toBe('AISDLC-123');
    expect(result.captureRecord?.workerId).toBe('worker-abc');
    expect(result.captureRecord?.auditTrail.originalFailure.stderr).toContain('prose');
    expect(result.captureRecord?.auditTrail.originalFailure.exitCode).toBe(1);
  });

  // AISDLC-270 PR #481 review fix: regression for circular reference.
  // Before the fix, `result.captureRecord.auditTrail.classificationResult`
  // pointed back at `result`, creating a cycle. JSON.stringify(captureRecord)
  // threw and appendFrameworkCapture's catch swallowed it, silently dropping
  // every framework-misbehaved capture. The fix snapshots the classification
  // before assigning captureRecord. This test pins the contract: the returned
  // captureRecord MUST be JSON-serialisable.
  it('captureRecord is JSON-serialisable (no circular reference)', () => {
    const stderr = 'developer returned prose instead of JSON envelope';
    const result = classifyFailure(signal(stderr, 1) as FailureSignal, {
      taskId: 'AISDLC-123',
      workerId: 'worker-abc',
    });
    expect(result.captureRecord).not.toBeNull();
    // Reverting the snapshot fix would make this throw
    // 'Converting circular structure to JSON'.
    expect(() => JSON.stringify(result.captureRecord)).not.toThrow();
    // The auditTrail.classificationResult must be a snapshot — captureRecord
    // on the snapshot stays null (otherwise the cycle would re-form).
    const serialized = JSON.parse(JSON.stringify(result.captureRecord));
    expect(serialized.auditTrail.classificationResult.captureRecord).toBeNull();
  });

  // Severity axes override
  it('respects caller-provided severityAxes override', () => {
    const result = classifyFailure(signal('developer returned prose', 1) as FailureSignal, {
      subclassHint: 'framework-contract-violated',
      severityAxes: { operatorTimeCost: 'high', blastRadius: 'high', frequency: 'high' },
    });
    expect(result.severity.composite).toBe('high');
    expect(result.severity.axes.frequency).toBe('high');
  });
});
