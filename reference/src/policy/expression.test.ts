import { describe, it, expect } from 'vitest';
import { createSimpleExpressionEvaluator, evaluateExpressionRule } from './expression.js';

describe('createSimpleExpressionEvaluator', () => {
  const evaluator = createSimpleExpressionEvaluator();

  describe('comparisons', () => {
    it('evaluates >= correctly', () => {
      expect(evaluator.evaluate('coverage >= 80', { coverage: 90 })).toBe(true);
      expect(evaluator.evaluate('coverage >= 80', { coverage: 70 })).toBe(false);
      expect(evaluator.evaluate('coverage >= 80', { coverage: 80 })).toBe(true);
    });

    it('evaluates <= correctly', () => {
      expect(evaluator.evaluate('score <= 5', { score: 3 })).toBe(true);
      expect(evaluator.evaluate('score <= 5', { score: 7 })).toBe(false);
    });

    it('evaluates == correctly', () => {
      expect(evaluator.evaluate("status == 'active'", { status: 'active' })).toBe(true);
      expect(evaluator.evaluate("status == 'active'", { status: 'inactive' })).toBe(false);
    });

    it('evaluates != correctly', () => {
      expect(evaluator.evaluate("env != 'production'", { env: 'staging' })).toBe(true);
      expect(evaluator.evaluate("env != 'production'", { env: 'production' })).toBe(false);
    });

    it('evaluates > and < correctly', () => {
      expect(evaluator.evaluate('count > 0', { count: 1 })).toBe(true);
      expect(evaluator.evaluate('count > 0', { count: 0 })).toBe(false);
      expect(evaluator.evaluate('count < 10', { count: 5 })).toBe(true);
    });
  });

  describe('logical operators', () => {
    it('evaluates && (AND)', () => {
      expect(evaluator.evaluate('a >= 1 && b >= 2', { a: 1, b: 2 })).toBe(true);
      expect(evaluator.evaluate('a >= 1 && b >= 2', { a: 1, b: 1 })).toBe(false);
    });

    it('evaluates || (OR)', () => {
      expect(evaluator.evaluate('a >= 10 || b >= 10', { a: 5, b: 15 })).toBe(true);
      expect(evaluator.evaluate('a >= 10 || b >= 10', { a: 5, b: 5 })).toBe(false);
    });

    it('evaluates ! (NOT)', () => {
      expect(evaluator.evaluate('!disabled', { disabled: false })).toBe(true);
      expect(evaluator.evaluate('!disabled', { disabled: true })).toBe(false);
    });
  });

  describe('property access', () => {
    it('resolves nested properties', () => {
      const ctx = { metrics: { coverage: 85 } };
      expect(evaluator.evaluate('metrics.coverage >= 80', ctx)).toBe(true);
    });

    it('handles missing properties as undefined/falsy', () => {
      expect(evaluator.evaluate('missing.path >= 80', {})).toBe(false);
    });
  });

  describe('contains', () => {
    it('checks array membership', () => {
      expect(evaluator.evaluate("tags contains 'important'", { tags: ['important', 'bug'] })).toBe(
        true,
      );
      expect(evaluator.evaluate("tags contains 'missing'", { tags: ['important', 'bug'] })).toBe(
        false,
      );
    });
  });

  describe('validation', () => {
    it('rejects empty expressions', () => {
      const result = evaluator.validate!('');
      expect(result.valid).toBe(false);
    });

    it('accepts valid expressions', () => {
      const result = evaluator.validate!('coverage >= 80');
      expect(result.valid).toBe(true);
    });
  });
});

describe('evaluateExpressionRule', () => {
  const evaluator = createSimpleExpressionEvaluator();

  it('returns pass for truthy expression', () => {
    const result = evaluateExpressionRule({ expression: 'score >= 80' }, { score: 90 }, evaluator);
    expect(result.passed).toBe(true);
  });

  it('returns fail with message for falsy expression', () => {
    const result = evaluateExpressionRule({ expression: 'score >= 80' }, { score: 50 }, evaluator);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('Expression failed');
  });
});
