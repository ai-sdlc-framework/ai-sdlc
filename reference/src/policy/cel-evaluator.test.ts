import { describe, it, expect } from 'vitest';
import { createCELEvaluator } from './cel-evaluator.js';
import { evaluateExpressionRule } from './expression.js';

describe('createCELEvaluator', () => {
  const evaluator = createCELEvaluator();

  describe('property access', () => {
    it('dot notation', () => {
      expect(evaluator.evaluate('resource.name == "test"', { resource: { name: 'test' } })).toBe(
        true,
      );
    });

    it('nested property', () => {
      expect(
        evaluator.evaluate('resource.metadata.labels.env == "prod"', {
          resource: { metadata: { labels: { env: 'prod' } } },
        }),
      ).toBe(true);
    });

    it('missing property returns false', () => {
      expect(evaluator.evaluate('resource.missing == "x"', { resource: {} })).toBe(false);
    });
  });

  describe('comparisons', () => {
    it('>=', () => {
      expect(evaluator.evaluate('resource.coverage >= 80', { resource: { coverage: 85 } })).toBe(
        true,
      );
    });

    it('<', () => {
      expect(evaluator.evaluate('resource.errors < 5', { resource: { errors: 2 } })).toBe(true);
    });

    it('== with strings', () => {
      expect(
        evaluator.evaluate('resource.status == "active"', { resource: { status: 'active' } }),
      ).toBe(true);
    });

    it('!=', () => {
      expect(
        evaluator.evaluate('resource.phase != "Failed"', { resource: { phase: 'Running' } }),
      ).toBe(true);
    });
  });

  describe('methods', () => {
    it('.size() on array', () => {
      expect(evaluator.evaluate('resource.items.size() > 0', { resource: { items: [1, 2] } })).toBe(
        true,
      );
    });

    it('.size() on string', () => {
      expect(evaluator.evaluate('resource.name.size() == 5', { resource: { name: 'hello' } })).toBe(
        true,
      );
    });

    it('.startsWith()', () => {
      expect(
        evaluator.evaluate('resource.name.startsWith("ai-")', { resource: { name: 'ai-agent' } }),
      ).toBe(true);
    });

    it('.endsWith()', () => {
      expect(
        evaluator.evaluate('resource.file.endsWith(".ts")', { resource: { file: 'index.ts' } }),
      ).toBe(true);
    });

    it('.contains() on string', () => {
      expect(
        evaluator.evaluate('resource.desc.contains("security")', {
          resource: { desc: 'security review' },
        }),
      ).toBe(true);
    });

    it('.matches() with regex', () => {
      expect(
        evaluator.evaluate('resource.version.matches("^v\\d+\\.\\d+")', {
          resource: { version: 'v1.2' },
        }),
      ).toBe(true);
    });
  });

  describe('macros', () => {
    it('.exists() finds matching element', () => {
      expect(
        evaluator.evaluate('resource.items.exists(x, x.severity == "critical")', {
          resource: { items: [{ severity: 'low' }, { severity: 'critical' }] },
        }),
      ).toBe(true);
    });

    it('.exists() returns false when no match', () => {
      expect(
        evaluator.evaluate('resource.items.exists(x, x.severity == "critical")', {
          resource: { items: [{ severity: 'low' }, { severity: 'medium' }] },
        }),
      ).toBe(false);
    });

    it('.all() checks all elements', () => {
      expect(
        evaluator.evaluate('resource.scores.all(s, s >= 80)', {
          resource: { scores: [85, 90, 95] },
        }),
      ).toBe(true);
    });

    it('.all() fails when element mismatches', () => {
      expect(
        evaluator.evaluate('resource.scores.all(s, s >= 80)', {
          resource: { scores: [85, 70, 95] },
        }),
      ).toBe(false);
    });
  });

  describe('functions', () => {
    it('has() returns true for existing path', () => {
      expect(evaluator.evaluate('has(resource.name)', { resource: { name: 'test' } })).toBe(true);
    });

    it('has() returns false for missing path', () => {
      expect(evaluator.evaluate('has(resource.missing)', { resource: {} })).toBe(false);
    });

    it('size() as function', () => {
      expect(
        evaluator.evaluate('size(resource.items) == 3', { resource: { items: [1, 2, 3] } }),
      ).toBe(true);
    });
  });

  describe('in operator', () => {
    it('element in list', () => {
      expect(
        evaluator.evaluate('"admin" in resource.roles', {
          resource: { roles: ['user', 'admin'] },
        }),
      ).toBe(true);
    });

    it('element not in list', () => {
      expect(
        evaluator.evaluate('"admin" in resource.roles', {
          resource: { roles: ['user', 'guest'] },
        }),
      ).toBe(false);
    });
  });

  describe('logical operators', () => {
    it('AND (&&)', () => {
      expect(
        evaluator.evaluate('resource.a >= 1 && resource.b >= 2', { resource: { a: 5, b: 10 } }),
      ).toBe(true);
    });

    it('OR (||)', () => {
      expect(
        evaluator.evaluate('resource.a >= 100 || resource.b >= 2', { resource: { a: 1, b: 10 } }),
      ).toBe(true);
    });

    it('negation (!)', () => {
      expect(evaluator.evaluate('!resource.disabled', { resource: { disabled: false } })).toBe(
        true,
      );
    });
  });

  describe('ternary', () => {
    it('true branch', () => {
      expect(
        evaluator.evaluate('resource.enabled ? resource.value : false', {
          resource: { enabled: true, value: 42 },
        }),
      ).toBe(true);
    });

    it('false branch', () => {
      expect(
        evaluator.evaluate('resource.enabled ? resource.value : false', {
          resource: { enabled: false, value: 42 },
        }),
      ).toBe(false);
    });
  });

  describe('validation', () => {
    it('rejects empty expression', () => {
      expect(evaluator.validate!('')).toEqual({ valid: false, error: 'Expression is empty' });
    });

    it('accepts valid expression', () => {
      expect(evaluator.validate!('resource.x >= 1')).toEqual({ valid: true });
    });
  });

  describe('integration with evaluateExpressionRule', () => {
    it('passes with CEL syntax', () => {
      const result = evaluateExpressionRule(
        { expression: 'resource.findings.size() == 0' },
        { resource: { findings: [] } },
        evaluator,
      );
      expect(result.passed).toBe(true);
    });

    it('fails with CEL syntax and exists macro', () => {
      const result = evaluateExpressionRule(
        { expression: 'resource.items.exists(x, x.severity == "critical")' },
        { resource: { items: [{ severity: 'low' }] } },
        evaluator,
      );
      expect(result.passed).toBe(false);
    });
  });
});
