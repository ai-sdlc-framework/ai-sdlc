/**
 * Rego-like expression evaluator.
 * Implements a subset of OPA Rego syntax for policy evaluation.
 * Supports property access (dot/bracket), comparisons, functions, and negation.
 * <!-- Source: PRD Section 10.3 -->
 */

import type { ExpressionEvaluator } from './expression.js';

/**
 * Resolve a property path that may include bracket notation.
 * E.g., `input.labels["env"]` or `input.items[0].name`
 */
function resolveRegoPath(path: string, context: Record<string, unknown>): unknown {
  // Tokenize: split on dots but handle bracket access
  const tokens: string[] = [];
  let current = '';
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '.') {
      if (current) tokens.push(current);
      current = '';
    } else if (ch === '[') {
      if (current) tokens.push(current);
      current = '';
      const end = path.indexOf(']', i);
      if (end === -1) return undefined;
      let key = path.slice(i + 1, end);
      // Strip quotes from string keys
      if (
        (key.startsWith('"') && key.endsWith('"')) ||
        (key.startsWith("'") && key.endsWith("'"))
      ) {
        key = key.slice(1, -1);
      }
      tokens.push(key);
      i = end;
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  let value: unknown = context;
  for (const token of tokens) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      const idx = parseInt(token, 10);
      if (!isNaN(idx)) {
        value = value[idx];
        continue;
      }
    }
    if (typeof value === 'object') {
      value = (value as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return value;
}

function parseRegoValue(token: string, context: Record<string, unknown>): unknown {
  const trimmed = token.trim();
  // String literals
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  // Boolean
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  // Null
  if (trimmed === 'null') return null;
  // Number
  const num = Number(trimmed);
  if (!isNaN(num) && trimmed !== '') return num;
  // Property path
  return resolveRegoPath(trimmed, context);
}

/** Built-in Rego functions. */
function evaluateFunction(name: string, args: string[], context: Record<string, unknown>): unknown {
  switch (name) {
    case 'count': {
      const val = parseRegoValue(args[0], context);
      if (Array.isArray(val)) return val.length;
      if (typeof val === 'string') return val.length;
      if (val && typeof val === 'object') return Object.keys(val).length;
      return 0;
    }
    case 'startswith': {
      const str = parseRegoValue(args[0], context);
      const prefix = parseRegoValue(args[1], context);
      return typeof str === 'string' && typeof prefix === 'string' && str.startsWith(prefix);
    }
    case 'endswith': {
      const str = parseRegoValue(args[0], context);
      const suffix = parseRegoValue(args[1], context);
      return typeof str === 'string' && typeof suffix === 'string' && str.endsWith(suffix);
    }
    case 'contains': {
      const str = parseRegoValue(args[0], context);
      const sub = parseRegoValue(args[1], context);
      if (typeof str === 'string' && typeof sub === 'string') return str.includes(sub);
      if (Array.isArray(str)) return str.includes(sub);
      return false;
    }
    case 'trim': {
      const str = parseRegoValue(args[0], context);
      return typeof str === 'string' ? str.trim() : str;
    }
    case 'lower': {
      const str = parseRegoValue(args[0], context);
      return typeof str === 'string' ? str.toLowerCase() : str;
    }
    case 'upper': {
      const str = parseRegoValue(args[0], context);
      return typeof str === 'string' ? str.toUpperCase() : str;
    }
    default:
      return undefined;
  }
}

/** Extract function call: `funcName(arg1, arg2)` */
function tryParseFunction(expr: string): { name: string; args: string[] } | null {
  const match = /^([a-z_]+)\((.+)\)$/s.exec(expr.trim());
  if (!match) return null;
  // Split args on top-level commas (not inside quotes or parens)
  const argsStr = match[2];
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of argsStr) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return { name: match[1], args };
}

function evaluateRegoAtomic(expression: string, context: Record<string, unknown>): boolean {
  const trimmed = expression.trim();

  // Negation: `not <expr>`
  if (trimmed.startsWith('not ')) {
    return !evaluateRegoAtomic(trimmed.slice(4), context);
  }

  // `some x in collection` quantifier (simplified: checks non-empty)
  const someMatch = /^some\s+\w+\s+in\s+(.+)$/.exec(trimmed);
  if (someMatch) {
    const val = parseRegoValue(someMatch[1], context);
    if (Array.isArray(val)) return val.length > 0;
    return val !== null && val !== undefined;
  }

  // Comparison operators
  for (const op of ['>=', '<=', '!=', '==', '>', '<']) {
    const opIdx = trimmed.indexOf(` ${op} `);
    if (opIdx !== -1) {
      const leftExpr = trimmed.slice(0, opIdx).trim();
      const rightExpr = trimmed.slice(opIdx + op.length + 2).trim();

      // Check if left side is a function call
      let leftVal: unknown;
      const fnCall = tryParseFunction(leftExpr);
      if (fnCall) {
        leftVal = evaluateFunction(fnCall.name, fnCall.args, context);
      } else {
        leftVal = parseRegoValue(leftExpr, context);
      }

      let rightVal: unknown;
      const rightFn = tryParseFunction(rightExpr);
      if (rightFn) {
        rightVal = evaluateFunction(rightFn.name, rightFn.args, context);
      } else {
        rightVal = parseRegoValue(rightExpr, context);
      }

      const lNum = typeof leftVal === 'number' ? leftVal : Number(leftVal);
      const rNum = typeof rightVal === 'number' ? rightVal : Number(rightVal);
      const numericOk = !isNaN(lNum) && !isNaN(rNum);

      switch (op) {
        case '>=':
          return numericOk && lNum >= rNum;
        case '<=':
          return numericOk && lNum <= rNum;
        case '>':
          return numericOk && lNum > rNum;
        case '<':
          return numericOk && lNum < rNum;
        case '==':
          if (numericOk) return lNum === rNum;
          return leftVal === rightVal;
        case '!=':
          if (numericOk) return lNum !== rNum;
          return leftVal !== rightVal;
      }
    }
  }

  // Boolean function call: `startswith(name, "ai-")`
  const fnCall = tryParseFunction(trimmed);
  if (fnCall) {
    const result = evaluateFunction(fnCall.name, fnCall.args, context);
    return Boolean(result);
  }

  // Truthiness
  const val = parseRegoValue(trimmed, context);
  return Boolean(val);
}

/**
 * Create a Rego-like expression evaluator.
 *
 * Supported syntax:
 * - Property access: `input.metadata.name`, `input.labels["env"]`
 * - Comparisons: `==`, `!=`, `>=`, `<=`, `>`, `<`
 * - Functions: `count()`, `startswith()`, `endswith()`, `contains()`, `lower()`, `upper()`, `trim()`
 * - Negation: `not <expr>`
 * - Quantifier: `some x in collection` (checks non-empty)
 * - Logical: `;` (AND)
 */
export function createRegoEvaluator(): ExpressionEvaluator {
  return {
    evaluate(expression: string, context: Record<string, unknown>): boolean {
      // Rego uses `;` for AND (rule body conjunction)
      if (expression.includes(';')) {
        const parts = expression.split(';');
        return parts.every((p) => evaluateRegoAtomic(p.trim(), context));
      }
      return evaluateRegoAtomic(expression, context);
    },

    validate(expression: string): { valid: boolean; error?: string } {
      if (!expression || expression.trim().length === 0) {
        return { valid: false, error: 'Expression is empty' };
      }
      return { valid: true };
    },
  };
}
