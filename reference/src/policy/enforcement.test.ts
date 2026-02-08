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

  it('tool-based gate stubs as fail', () => {
    const gate: Gate = {
      name: 'security-scan',
      enforcement: 'hard-mandatory',
      rule: { tool: 'semgrep', maxSeverity: 'medium' },
    };
    const result = evaluateGate(gate, makeCtx());
    expect(result.verdict).toBe('fail');
    expect(result.message).toContain('adapter');
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
