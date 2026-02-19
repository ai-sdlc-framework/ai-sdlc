import { describe, it, expect } from 'vitest';
import { evaluateGate, enforce } from './enforcement.js';
import type { EvaluationContext } from './enforcement.js';
import type { Gate, QualityGate } from '../core/types.js';
import { API_VERSION } from '../core/types.js';

function makeCtx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    authorType: 'ai-agent',
    repository: 'org/repo',
    metrics: {},
    ...overrides,
  };
}

function makeMetricGate(overrides: Partial<Gate> = {}): Gate {
  return {
    name: 'test-gate',
    enforcement: 'hard-mandatory',
    rule: { metric: 'coverage', operator: '>=', threshold: 80 },
    ...overrides,
  };
}

function makeQualityGate(gates: Gate[]): QualityGate {
  return {
    apiVersion: API_VERSION,
    kind: 'QualityGate',
    metadata: { name: 'test-qg' },
    spec: { gates },
  };
}

describe('evaluateGate()', () => {
  it('passes when metric meets threshold', () => {
    const result = evaluateGate(makeMetricGate(), makeCtx({ metrics: { coverage: 85 } }));
    expect(result.verdict).toBe('pass');
  });

  it('fails when metric is below threshold', () => {
    const result = evaluateGate(makeMetricGate(), makeCtx({ metrics: { coverage: 70 } }));
    expect(result.verdict).toBe('fail');
  });

  it('fails at exact boundary for >= operator', () => {
    const result = evaluateGate(makeMetricGate(), makeCtx({ metrics: { coverage: 80 } }));
    expect(result.verdict).toBe('pass');
  });

  it('fails when metric is missing', () => {
    const result = evaluateGate(makeMetricGate(), makeCtx({ metrics: {} }));
    expect(result.verdict).toBe('fail');
    expect(result.message).toContain('not available');
  });

  describe('all 6 comparison operators', () => {
    const operators = [
      { op: '>=', value: 80, threshold: 80, expected: 'pass' },
      { op: '>=', value: 79, threshold: 80, expected: 'fail' },
      { op: '<=', value: 80, threshold: 80, expected: 'pass' },
      { op: '<=', value: 81, threshold: 80, expected: 'fail' },
      { op: '==', value: 80, threshold: 80, expected: 'pass' },
      { op: '==', value: 81, threshold: 80, expected: 'fail' },
      { op: '!=', value: 81, threshold: 80, expected: 'pass' },
      { op: '!=', value: 80, threshold: 80, expected: 'fail' },
      { op: '>', value: 81, threshold: 80, expected: 'pass' },
      { op: '>', value: 80, threshold: 80, expected: 'fail' },
      { op: '<', value: 79, threshold: 80, expected: 'pass' },
      { op: '<', value: 80, threshold: 80, expected: 'fail' },
    ] as const;

    for (const { op, value, threshold, expected } of operators) {
      it(`${value} ${op} ${threshold} → ${expected}`, () => {
        const gate = makeMetricGate({
          rule: { metric: 'x', operator: op, threshold },
        });
        const result = evaluateGate(gate, makeCtx({ metrics: { x: value } }));
        expect(result.verdict).toBe(expected);
      });
    }
  });

  describe('tool-based rules', () => {
    function makeToolGate(overrides: Partial<Gate> = {}): Gate {
      return {
        name: 'security-scan',
        enforcement: 'hard-mandatory',
        rule: { tool: 'semgrep', maxSeverity: 'medium' },
        ...overrides,
      };
    }

    it('passes when no findings exceed max severity', () => {
      const ctx = makeCtx({
        toolResults: {
          semgrep: { findings: [{ severity: 'low' }, { severity: 'medium' }] },
        },
      });
      expect(evaluateGate(makeToolGate(), ctx).verdict).toBe('pass');
    });

    it('fails when findings exceed max severity', () => {
      const ctx = makeCtx({
        toolResults: {
          semgrep: { findings: [{ severity: 'high' }] },
        },
      });
      const result = evaluateGate(makeToolGate(), ctx);
      expect(result.verdict).toBe('fail');
      expect(result.message).toContain('exceed max severity');
    });

    it('fails when tool results are missing', () => {
      const result = evaluateGate(makeToolGate(), makeCtx());
      expect(result.verdict).toBe('fail');
      expect(result.message).toContain('not available');
    });

    it('passes when no maxSeverity is set and results exist', () => {
      const gate: Gate = {
        name: 'lint',
        enforcement: 'hard-mandatory',
        rule: { tool: 'eslint' },
      };
      const ctx = makeCtx({
        toolResults: { eslint: { findings: [{ severity: 'critical' }] } },
      });
      expect(evaluateGate(gate, ctx).verdict).toBe('pass');
    });

    it('fails when tool name does not match results', () => {
      const ctx = makeCtx({
        toolResults: { eslint: { findings: [] } },
      });
      const result = evaluateGate(makeToolGate(), ctx);
      expect(result.verdict).toBe('fail');
      expect(result.message).toContain('semgrep');
    });

    it('passes with empty findings array', () => {
      const ctx = makeCtx({
        toolResults: { semgrep: { findings: [] } },
      });
      expect(evaluateGate(makeToolGate(), ctx).verdict).toBe('pass');
    });

    it('critical exceeds high maxSeverity', () => {
      const gate: Gate = {
        name: 'scan',
        enforcement: 'hard-mandatory',
        rule: { tool: 'snyk', maxSeverity: 'high' },
      };
      const ctx = makeCtx({
        toolResults: { snyk: { findings: [{ severity: 'critical' }] } },
      });
      expect(evaluateGate(gate, ctx).verdict).toBe('fail');
    });

    it('high does not exceed high maxSeverity', () => {
      const gate: Gate = {
        name: 'scan',
        enforcement: 'hard-mandatory',
        rule: { tool: 'snyk', maxSeverity: 'high' },
      };
      const ctx = makeCtx({
        toolResults: { snyk: { findings: [{ severity: 'high' }] } },
      });
      expect(evaluateGate(gate, ctx).verdict).toBe('pass');
    });
  });

  describe('reviewer-based rules', () => {
    function makeReviewerGate(overrides: Partial<Gate> = {}): Gate {
      return {
        name: 'review-gate',
        enforcement: 'hard-mandatory',
        rule: { minimumReviewers: 2 },
        ...overrides,
      };
    }

    it('passes when reviewer count meets minimum', () => {
      const ctx = makeCtx({ reviewerCount: 2 });
      expect(evaluateGate(makeReviewerGate(), ctx).verdict).toBe('pass');
    });

    it('fails when reviewer count is below minimum', () => {
      const ctx = makeCtx({ reviewerCount: 1 });
      const result = evaluateGate(makeReviewerGate(), ctx);
      expect(result.verdict).toBe('fail');
      expect(result.message).toContain('Requires 2');
    });

    it('fails when reviewer count is missing (defaults to 0)', () => {
      const result = evaluateGate(makeReviewerGate(), makeCtx());
      expect(result.verdict).toBe('fail');
    });

    it('requires extra reviewer for AI author', () => {
      const gate = makeReviewerGate({
        rule: { minimumReviewers: 1, aiAuthorRequiresExtraReviewer: true },
      });
      // AI author needs 1+1=2 reviewers
      const ctx = makeCtx({ authorType: 'ai-agent', reviewerCount: 1 });
      expect(evaluateGate(gate, ctx).verdict).toBe('fail');

      const ctx2 = makeCtx({ authorType: 'ai-agent', reviewerCount: 2 });
      expect(evaluateGate(gate, ctx2).verdict).toBe('pass');
    });

    it('does not require extra reviewer for human author', () => {
      const gate = makeReviewerGate({
        rule: { minimumReviewers: 1, aiAuthorRequiresExtraReviewer: true },
      });
      const ctx = makeCtx({ authorType: 'human', reviewerCount: 1 });
      expect(evaluateGate(gate, ctx).verdict).toBe('pass');
    });
  });

  describe('documentation-based rules', () => {
    function makeDocGate(overrides: Partial<Gate> = {}): Gate {
      return {
        name: 'doc-gate',
        enforcement: 'hard-mandatory',
        rule: { changedFilesRequireDocUpdate: true },
        ...overrides,
      };
    }

    it('passes when code changes have matching doc changes', () => {
      const ctx = makeCtx({
        changedFiles: ['src/foo.ts'],
        docFiles: ['docs/foo.md'],
      });
      expect(evaluateGate(makeDocGate(), ctx).verdict).toBe('pass');
    });

    it('fails when code changes have no doc changes', () => {
      const ctx = makeCtx({
        changedFiles: ['src/foo.ts'],
        docFiles: [],
      });
      const result = evaluateGate(makeDocGate(), ctx);
      expect(result.verdict).toBe('fail');
      expect(result.message).toContain('documentation');
    });

    it('passes when no code changes are present', () => {
      const ctx = makeCtx({ changedFiles: [], docFiles: [] });
      expect(evaluateGate(makeDocGate(), ctx).verdict).toBe('pass');
    });

    it('passes when flag is false', () => {
      const gate = makeDocGate({
        rule: { changedFilesRequireDocUpdate: false },
      });
      const ctx = makeCtx({ changedFiles: ['src/foo.ts'], docFiles: [] });
      expect(evaluateGate(gate, ctx).verdict).toBe('pass');
    });
  });

  describe('provenance-based rules', () => {
    function makeProvGate(overrides: Partial<Gate> = {}): Gate {
      return {
        name: 'prov-gate',
        enforcement: 'hard-mandatory',
        rule: { requireAttribution: true },
        ...overrides,
      };
    }

    it('passes when attribution is present', () => {
      const ctx = makeCtx({ provenance: { attribution: true } });
      expect(evaluateGate(makeProvGate(), ctx).verdict).toBe('pass');
    });

    it('fails when attribution is missing', () => {
      const ctx = makeCtx({ provenance: { attribution: false } });
      const result = evaluateGate(makeProvGate(), ctx);
      expect(result.verdict).toBe('fail');
      expect(result.message).toContain('Attribution');
    });

    it('fails when human review is required but missing', () => {
      const gate = makeProvGate({
        rule: { requireAttribution: true, requireHumanReview: true },
      });
      const ctx = makeCtx({ provenance: { attribution: true, humanReviewed: false } });
      const result = evaluateGate(gate, ctx);
      expect(result.verdict).toBe('fail');
      expect(result.message).toContain('Human review');
    });

    it('passes when both attribution and human review are present', () => {
      const gate = makeProvGate({
        rule: { requireAttribution: true, requireHumanReview: true },
      });
      const ctx = makeCtx({ provenance: { attribution: true, humanReviewed: true } });
      expect(evaluateGate(gate, ctx).verdict).toBe('pass');
    });
  });

  describe('cost-based rules', () => {
    function makeCostGate(overrides: Partial<Gate> = {}): Gate {
      return {
        name: 'cost-gate',
        enforcement: 'hard-mandatory',
        rule: { cost: { metric: 'total-execution-cost', operator: '<=', threshold: 10 } },
        ...overrides,
      };
    }

    it('passes when cost metric meets threshold', () => {
      const ctx = makeCtx({ metrics: { 'total-execution-cost': 5 } });
      expect(evaluateGate(makeCostGate(), ctx).verdict).toBe('pass');
    });

    it('fails when cost metric exceeds threshold', () => {
      const ctx = makeCtx({ metrics: { 'total-execution-cost': 15 } });
      const result = evaluateGate(makeCostGate(), ctx);
      expect(result.verdict).toBe('fail');
    });

    it('fails when cost metric not available', () => {
      const result = evaluateGate(makeCostGate(), makeCtx());
      expect(result.verdict).toBe('fail');
      expect(result.message).toContain('not available');
    });

    it('works with all 6 operators via cost rule path', () => {
      const operators = [
        { op: '>=', value: 10, threshold: 10, expected: 'pass' },
        { op: '>=', value: 9, threshold: 10, expected: 'fail' },
        { op: '<=', value: 10, threshold: 10, expected: 'pass' },
        { op: '<=', value: 11, threshold: 10, expected: 'fail' },
        { op: '==', value: 10, threshold: 10, expected: 'pass' },
        { op: '==', value: 11, threshold: 10, expected: 'fail' },
        { op: '!=', value: 11, threshold: 10, expected: 'pass' },
        { op: '!=', value: 10, threshold: 10, expected: 'fail' },
        { op: '>', value: 11, threshold: 10, expected: 'pass' },
        { op: '>', value: 10, threshold: 10, expected: 'fail' },
        { op: '<', value: 9, threshold: 10, expected: 'pass' },
        { op: '<', value: 10, threshold: 10, expected: 'fail' },
      ] as const;

      for (const { op, value, threshold, expected } of operators) {
        const gate = makeCostGate({
          rule: { cost: { metric: 'x', operator: op, threshold } },
        });
        const result = evaluateGate(gate, makeCtx({ metrics: { x: value } }));
        expect(result.verdict).toBe(expected);
      }
    });
  });

  describe('override fix — works for non-metric rules', () => {
    it('allows override for tool rule soft-mandatory gate', () => {
      const gate: Gate = {
        name: 'tool-gate',
        enforcement: 'soft-mandatory',
        rule: { tool: 'semgrep', maxSeverity: 'low' },
        override: { requiredRole: 'eng-manager' },
      };
      const ctx = makeCtx({
        toolResults: { semgrep: { findings: [{ severity: 'high' }] } },
        overrideRole: 'eng-manager',
      });
      const result = evaluateGate(gate, ctx);
      expect(result.verdict).toBe('override');
    });

    it('allows override for reviewer rule soft-mandatory gate', () => {
      const gate: Gate = {
        name: 'review-gate',
        enforcement: 'soft-mandatory',
        rule: { minimumReviewers: 3 },
        override: { requiredRole: 'lead' },
      };
      const ctx = makeCtx({ reviewerCount: 1, overrideRole: 'lead' });
      const result = evaluateGate(gate, ctx);
      expect(result.verdict).toBe('override');
    });

    it('allows override for provenance rule soft-mandatory gate', () => {
      const gate: Gate = {
        name: 'prov-gate',
        enforcement: 'soft-mandatory',
        rule: { requireAttribution: true },
        override: { requiredRole: 'director' },
      };
      const ctx = makeCtx({ provenance: {}, overrideRole: 'director' });
      const result = evaluateGate(gate, ctx);
      expect(result.verdict).toBe('override');
    });
  });
});

describe('enforce()', () => {
  it('allows when all gates pass', () => {
    const qg = makeQualityGate([makeMetricGate()]);
    const result = enforce(qg, makeCtx({ metrics: { coverage: 90 } }));
    expect(result.allowed).toBe(true);
  });

  it('blocks when hard-mandatory gate fails', () => {
    const qg = makeQualityGate([makeMetricGate({ enforcement: 'hard-mandatory' })]);
    const result = enforce(qg, makeCtx({ metrics: { coverage: 50 } }));
    expect(result.allowed).toBe(false);
  });

  it('allows when advisory gate fails', () => {
    const qg = makeQualityGate([makeMetricGate({ enforcement: 'advisory' })]);
    const result = enforce(qg, makeCtx({ metrics: { coverage: 50 } }));
    expect(result.allowed).toBe(true);
  });

  it('blocks soft-mandatory fail without override', () => {
    const gate = makeMetricGate({
      enforcement: 'soft-mandatory',
      override: { requiredRole: 'eng-manager' },
    });
    const qg = makeQualityGate([gate]);
    const result = enforce(qg, makeCtx({ metrics: { coverage: 50 } }));
    expect(result.allowed).toBe(false);
  });

  it('allows soft-mandatory fail with valid override', () => {
    const gate = makeMetricGate({
      enforcement: 'soft-mandatory',
      override: { requiredRole: 'eng-manager' },
    });
    const qg = makeQualityGate([gate]);
    const result = enforce(qg, makeCtx({ metrics: { coverage: 50 }, overrideRole: 'eng-manager' }));
    expect(result.allowed).toBe(true);
    expect(result.results[0].verdict).toBe('override');
  });

  it('blocks soft-mandatory fail with wrong override role', () => {
    const gate = makeMetricGate({
      enforcement: 'soft-mandatory',
      override: { requiredRole: 'eng-manager' },
    });
    const qg = makeQualityGate([gate]);
    const result = enforce(qg, makeCtx({ metrics: { coverage: 50 }, overrideRole: 'junior' }));
    expect(result.allowed).toBe(false);
  });

  it('handles mixed gates correctly', () => {
    const gates: Gate[] = [
      makeMetricGate({ name: 'pass-gate', enforcement: 'hard-mandatory' }),
      makeMetricGate({
        name: 'advisory-fail',
        enforcement: 'advisory',
        rule: { metric: 'docs', operator: '>=', threshold: 100 },
      }),
    ];
    const qg = makeQualityGate(gates);
    const result = enforce(qg, makeCtx({ metrics: { coverage: 90, docs: 0 } }));
    expect(result.allowed).toBe(true);
    expect(result.results).toHaveLength(2);
  });
});
