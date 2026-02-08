/**
 * Policy expression evaluator.
 * Provides a simple expression language for gate rule evaluation.
 * For Rego/CEL, users implement the ExpressionEvaluator interface.
 */

export interface ExpressionEvaluator {
  /** Evaluate an expression against a context. Returns true/false. */
  evaluate(expression: string, context: Record<string, unknown>): boolean;
  /** Optionally validate an expression before runtime. */
  validate?(expression: string): { valid: boolean; error?: string };
}

import type { ExpressionRule } from '../core/types.js';
export type { ExpressionRule } from '../core/types.js';

export interface ExpressionVerdict {
  passed: boolean;
  message?: string;
}

/**
 * Resolve a dotted property path on an object.
 * E.g., "ctx.metrics.coverage" resolves context.metrics.coverage.
 */
function resolveProperty(path: string, context: Record<string, unknown>): unknown {
  const parts = path.split('.');
  let current: unknown = context;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}

function resolveValue(token: string, context: Record<string, unknown>): unknown {
  // String literal
  if (
    (token.startsWith("'") && token.endsWith("'")) ||
    (token.startsWith('"') && token.endsWith('"'))
  ) {
    return token.slice(1, -1);
  }
  // Boolean literals
  if (token === 'true') return true;
  if (token === 'false') return false;
  // Number literal
  const num = Number(token);
  if (!isNaN(num) && token.trim() !== '') return num;
  // Property path
  return resolveProperty(token, context);
}

/**
 * Evaluate a simple comparison expression.
 * Supports: >=, <=, ==, !=, >, <
 */
function evaluateComparison(
  left: string,
  operator: string,
  right: string,
  context: Record<string, unknown>,
): boolean {
  const lVal = resolveValue(left.trim(), context);
  const rVal = resolveValue(right.trim(), context);

  const lNum = toNumber(lVal);
  const rNum = toNumber(rVal);

  switch (operator) {
    case '>=':
      return lNum !== undefined && rNum !== undefined && lNum >= rNum;
    case '<=':
      return lNum !== undefined && rNum !== undefined && lNum <= rNum;
    case '>':
      return lNum !== undefined && rNum !== undefined && lNum > rNum;
    case '<':
      return lNum !== undefined && rNum !== undefined && lNum < rNum;
    case '==':
      return lVal === rVal || (lNum !== undefined && rNum !== undefined && lNum === rNum);
    case '!=':
      if (lNum !== undefined && rNum !== undefined) return lNum !== rNum;
      return lVal !== rVal;
    default:
      return false;
  }
}

/**
 * Evaluate a "contains" expression: `collection contains value`
 */
function evaluateContains(
  collectionPath: string,
  valuePath: string,
  context: Record<string, unknown>,
): boolean {
  const collection = resolveValue(collectionPath.trim(), context);
  const value = resolveValue(valuePath.trim(), context);
  if (Array.isArray(collection)) {
    return collection.includes(value);
  }
  if (typeof collection === 'string' && typeof value === 'string') {
    return collection.includes(value);
  }
  return false;
}

/**
 * Evaluate a single atomic expression (no logical operators).
 */
function evaluateAtomic(expression: string, context: Record<string, unknown>): boolean {
  const trimmed = expression.trim();

  // Negation
  if (trimmed.startsWith('!')) {
    return !evaluateAtomic(trimmed.slice(1), context);
  }

  // Contains
  const containsIdx = trimmed.indexOf(' contains ');
  if (containsIdx !== -1) {
    return evaluateContains(
      trimmed.slice(0, containsIdx),
      trimmed.slice(containsIdx + ' contains '.length),
      context,
    );
  }

  // Comparison operators (longest first to avoid partial matches)
  for (const op of ['>=', '<=', '!=', '==', '>', '<']) {
    const opIdx = trimmed.indexOf(op);
    if (opIdx !== -1) {
      return evaluateComparison(
        trimmed.slice(0, opIdx),
        op,
        trimmed.slice(opIdx + op.length),
        context,
      );
    }
  }

  // Truthiness check
  const val = resolveValue(trimmed, context);
  return Boolean(val);
}

/**
 * Create a simple expression evaluator.
 * Handles comparisons (>=, <=, ==, !=, >, <), logical (&&, ||, !),
 * property access (ctx.metrics.coverage), and set membership (contains).
 */
export function createSimpleExpressionEvaluator(): ExpressionEvaluator {
  return {
    evaluate(expression: string, context: Record<string, unknown>): boolean {
      // Handle || (OR) — lowest precedence
      if (expression.includes('||')) {
        const parts = expression.split('||');
        return parts.some((part) => this.evaluate(part.trim(), context));
      }

      // Handle && (AND)
      if (expression.includes('&&')) {
        const parts = expression.split('&&');
        return parts.every((part) => this.evaluate(part.trim(), context));
      }

      return evaluateAtomic(expression, context);
    },

    validate(expression: string): { valid: boolean; error?: string } {
      if (!expression || expression.trim().length === 0) {
        return { valid: false, error: 'Expression is empty' };
      }
      // Basic validation: check for balanced structure
      const hasOperator =
        expression.includes('>=') ||
        expression.includes('<=') ||
        expression.includes('==') ||
        expression.includes('!=') ||
        expression.includes('>') ||
        expression.includes('<') ||
        expression.includes('contains') ||
        expression.includes('&&') ||
        expression.includes('||') ||
        expression.startsWith('!');

      if (!hasOperator) {
        // Could be a simple truthiness check — still valid
        return { valid: true };
      }
      return { valid: true };
    },
  };
}

/**
 * Evaluate an expression rule and return a gate verdict.
 */
export function evaluateExpressionRule(
  rule: ExpressionRule,
  context: Record<string, unknown>,
  evaluator: ExpressionEvaluator,
): ExpressionVerdict {
  try {
    const passed = evaluator.evaluate(rule.expression, context);
    return {
      passed,
      message: passed ? undefined : `Expression failed: ${rule.expression}`,
    };
  } catch (err) {
    return {
      passed: false,
      message: `Expression error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
