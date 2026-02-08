import { describe, it, expect } from 'vitest';
import { createRegoEvaluator } from './rego-evaluator.js';
import { evaluateExpressionRule } from './expression.js';

describe('createRegoEvaluator', () => {
  const evaluator = createRegoEvaluator();

  describe('property access', () => {
    it('dot notation', () => {
      expect(evaluator.evaluate('input.name == "test"', { input: { name: 'test' } })).toBe(true);
    });

    it('bracket notation with string key', () => {
      expect(
        evaluator.evaluate('input.labels["env"] == "prod"', {
          input: { labels: { env: 'prod' } },
        }),
      ).toBe(true);
    });

    it('nested property access', () => {
      expect(
        evaluator.evaluate('input.metadata.labels.team == "backend"', {
          input: { metadata: { labels: { team: 'backend' } } },
        }),
      ).toBe(true);
    });

    it('missing property returns false', () => {
      expect(evaluator.evaluate('input.missing == "value"', { input: {} })).toBe(false);
    });
  });

  describe('comparisons', () => {
    it('numeric >=', () => {
      expect(evaluator.evaluate('input.coverage >= 80', { input: { coverage: 85 } })).toBe(true);
      expect(evaluator.evaluate('input.coverage >= 80', { input: { coverage: 70 } })).toBe(false);
    });

    it('numeric <', () => {
      expect(evaluator.evaluate('input.errors < 5', { input: { errors: 3 } })).toBe(true);
    });

    it('string equality', () => {
      expect(evaluator.evaluate('input.status == "active"', { input: { status: 'active' } })).toBe(
        true,
      );
    });

    it('inequality', () => {
      expect(evaluator.evaluate('input.phase != "Failed"', { input: { phase: 'Running' } })).toBe(
        true,
      );
    });
  });

  describe('functions', () => {
    it('count on array', () => {
      expect(evaluator.evaluate('count(input.items) > 0', { input: { items: [1, 2, 3] } })).toBe(
        true,
      );
    });

    it('count on empty array', () => {
      expect(evaluator.evaluate('count(input.items) == 0', { input: { items: [] } })).toBe(true);
    });

    it('startswith', () => {
      expect(
        evaluator.evaluate('startswith(input.name, "ai-")', { input: { name: 'ai-agent' } }),
      ).toBe(true);
    });

    it('endswith', () => {
      expect(
        evaluator.evaluate('endswith(input.file, ".ts")', { input: { file: 'index.ts' } }),
      ).toBe(true);
    });

    it('contains on string', () => {
      expect(
        evaluator.evaluate('contains(input.desc, "security")', {
          input: { desc: 'security review' },
        }),
      ).toBe(true);
    });

    it('lower', () => {
      expect(evaluator.evaluate('lower(input.name) == "hello"', { input: { name: 'HELLO' } })).toBe(
        true,
      );
    });

    it('upper', () => {
      expect(evaluator.evaluate('upper(input.name) == "HELLO"', { input: { name: 'hello' } })).toBe(
        true,
      );
    });
  });

  describe('negation', () => {
    it('not operator', () => {
      expect(evaluator.evaluate('not input.disabled', { input: { disabled: false } })).toBe(true);
      expect(evaluator.evaluate('not input.disabled', { input: { disabled: true } })).toBe(false);
    });
  });

  describe('quantifier', () => {
    it('some x in collection (non-empty)', () => {
      expect(evaluator.evaluate('some x in input.items', { input: { items: [1] } })).toBe(true);
    });

    it('some x in empty collection', () => {
      expect(evaluator.evaluate('some x in input.items', { input: { items: [] } })).toBe(false);
    });
  });

  describe('conjunction with semicolons', () => {
    it('AND via semicolon', () => {
      expect(evaluator.evaluate('input.a >= 1; input.b >= 2', { input: { a: 5, b: 10 } })).toBe(
        true,
      );
    });

    it('fails if any clause fails', () => {
      expect(evaluator.evaluate('input.a >= 1; input.b >= 20', { input: { a: 5, b: 10 } })).toBe(
        false,
      );
    });
  });

  describe('validation', () => {
    it('rejects empty expression', () => {
      expect(evaluator.validate!('')).toEqual({ valid: false, error: 'Expression is empty' });
    });

    it('accepts valid expression', () => {
      expect(evaluator.validate!('input.x >= 1')).toEqual({ valid: true });
    });
  });

  describe('integration with evaluateExpressionRule', () => {
    it('passes with Rego syntax', () => {
      const result = evaluateExpressionRule(
        { expression: 'count(input.findings) == 0' },
        { input: { findings: [] } },
        evaluator,
      );
      expect(result.passed).toBe(true);
    });

    it('fails with Rego syntax', () => {
      const result = evaluateExpressionRule(
        { expression: 'input.coverage >= 80' },
        { input: { coverage: 50 } },
        evaluator,
      );
      expect(result.passed).toBe(false);
      expect(result.message).toContain('Expression failed');
    });
  });
});
