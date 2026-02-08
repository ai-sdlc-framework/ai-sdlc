/**
 * CEL-like expression evaluator.
 * Implements a subset of Common Expression Language for policy evaluation.
 * Supports property access, comparisons, macros (.exists, .all), and logical operators.
 * <!-- Source: PRD Section 10.3 -->
 */

import type { ExpressionEvaluator } from './expression.js';

/**
 * Resolve a dotted property path on an object.
 */
function resolvePath(path: string, context: Record<string, unknown>): unknown {
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

function parseCELValue(token: string, context: Record<string, unknown>): unknown {
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
  // Property path or method chain — resolve the value part
  return resolveCELExpr(trimmed, context);
}

/**
 * Resolve a CEL expression that may include method calls.
 * E.g., `resource.name.startsWith("ai-")` or `findings.size()`
 */
function resolveCELExpr(expr: string, context: Record<string, unknown>): unknown {
  const trimmed = expr.trim();

  // Check for method calls: find the last `.methodName(args)` pattern
  // Walk backwards to find `.method(` at the top level
  let parenDepth = 0;
  let methodStart = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const ch = trimmed[i];
    if (ch === ')') parenDepth++;
    else if (ch === '(') {
      parenDepth--;
      if (parenDepth === 0) {
        // Found the opening paren of the outermost method call
        // Find the dot before the method name
        const beforeParen = trimmed.slice(0, i);
        const lastDot = beforeParen.lastIndexOf('.');
        if (lastDot !== -1) {
          methodStart = lastDot;
        }
        break;
      }
    }
  }

  if (methodStart !== -1) {
    const receiver = trimmed.slice(0, methodStart);
    const rest = trimmed.slice(methodStart + 1);
    const parenIdx = rest.indexOf('(');
    const methodName = rest.slice(0, parenIdx);
    const argsStr = rest.slice(parenIdx + 1, rest.length - 1).trim();

    const receiverVal = resolveCELExpr(receiver, context);
    return evaluateCELMethod(receiverVal, methodName, argsStr, context);
  }

  // Check for `has()` function
  const hasMatch = /^has\((.+)\)$/.exec(trimmed);
  if (hasMatch) {
    const val = resolvePath(hasMatch[1], context);
    return val !== undefined && val !== null;
  }

  // Check for `size()` on a plain call (without receiver)
  const sizeMatch = /^size\((.+)\)$/.exec(trimmed);
  if (sizeMatch) {
    const val = parseCELValue(sizeMatch[1], context);
    if (Array.isArray(val)) return val.length;
    if (typeof val === 'string') return val.length;
    if (val && typeof val === 'object') return Object.keys(val).length;
    return 0;
  }

  // `x in list` operator
  const inMatch = /^(.+?)\s+in\s+(.+)$/.exec(trimmed);
  if (inMatch) {
    const element = parseCELValue(inMatch[1], context);
    const collection = parseCELValue(inMatch[2], context);
    if (Array.isArray(collection)) return collection.includes(element);
    if (collection && typeof collection === 'object') {
      return Object.prototype.hasOwnProperty.call(collection, String(element));
    }
    return false;
  }

  // Simple property path
  return resolvePath(trimmed, context);
}

function evaluateCELMethod(
  receiver: unknown,
  method: string,
  argsStr: string,
  context: Record<string, unknown>,
): unknown {
  switch (method) {
    case 'size':
      if (Array.isArray(receiver)) return receiver.length;
      if (typeof receiver === 'string') return receiver.length;
      if (receiver && typeof receiver === 'object') return Object.keys(receiver).length;
      return 0;

    case 'startsWith': {
      const prefix = parseCELValue(argsStr, context);
      return (
        typeof receiver === 'string' && typeof prefix === 'string' && receiver.startsWith(prefix)
      );
    }

    case 'endsWith': {
      const suffix = parseCELValue(argsStr, context);
      return (
        typeof receiver === 'string' && typeof suffix === 'string' && receiver.endsWith(suffix)
      );
    }

    case 'contains': {
      const sub = parseCELValue(argsStr, context);
      if (typeof receiver === 'string' && typeof sub === 'string') return receiver.includes(sub);
      if (Array.isArray(receiver)) return receiver.includes(sub);
      return false;
    }

    case 'matches': {
      const pattern = parseCELValue(argsStr, context);
      if (typeof receiver === 'string' && typeof pattern === 'string') {
        try {
          return new RegExp(pattern).test(receiver);
        } catch {
          return false;
        }
      }
      return false;
    }

    case 'exists': {
      // `.exists(x, predicate)` — any element satisfies predicate
      if (!Array.isArray(receiver)) return false;
      const { varName, body } = parseMacroArgs(argsStr);
      return receiver.some((item) => {
        const localCtx = { ...context, [varName]: item };
        return evaluateCELAtomic(body, localCtx);
      });
    }

    case 'all': {
      // `.all(x, predicate)` — all elements satisfy predicate
      if (!Array.isArray(receiver)) return false;
      const { varName, body } = parseMacroArgs(argsStr);
      return receiver.every((item) => {
        const localCtx = { ...context, [varName]: item };
        return evaluateCELAtomic(body, localCtx);
      });
    }

    case 'filter': {
      // `.filter(x, predicate)` — return matching elements
      if (!Array.isArray(receiver)) return [];
      const { varName, body } = parseMacroArgs(argsStr);
      return receiver.filter((item) => {
        const localCtx = { ...context, [varName]: item };
        return evaluateCELAtomic(body, localCtx);
      });
    }

    case 'map': {
      // `.map(x, expr)` — transform elements
      if (!Array.isArray(receiver)) return [];
      const { varName, body } = parseMacroArgs(argsStr);
      return receiver.map((item) => {
        const localCtx = { ...context, [varName]: item };
        return parseCELValue(body, localCtx);
      });
    }

    default:
      return undefined;
  }
}

function parseMacroArgs(argsStr: string): { varName: string; body: string } {
  const commaIdx = argsStr.indexOf(',');
  if (commaIdx === -1) {
    return { varName: 'it', body: argsStr.trim() };
  }
  return {
    varName: argsStr.slice(0, commaIdx).trim(),
    body: argsStr.slice(commaIdx + 1).trim(),
  };
}

/**
 * Find a comparison operator at the top level (not inside parens or quotes).
 * Returns the index of the space before the operator, or -1.
 */
function findTopLevelOperator(expr: string, op: string): number {
  const target = ` ${op} `;
  let parenDepth = 0;
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '\\') {
      i++; // skip escaped char
      continue;
    }
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (inDouble || inSingle) continue;
    if (ch === '(') parenDepth++;
    if (ch === ')') parenDepth--;
    if (parenDepth > 0) continue;

    if (expr.slice(i, i + target.length) === target) {
      return i;
    }
  }
  return -1;
}

function evaluateCELAtomic(expression: string, context: Record<string, unknown>): boolean {
  const trimmed = expression.trim();

  // Negation
  if (trimmed.startsWith('!')) {
    return !evaluateCELAtomic(trimmed.slice(1), context);
  }

  // Ternary: `cond ? a : b` — evaluate to boolean
  const ternaryIdx = findTopLevelOperator(trimmed, '?');
  if (ternaryIdx !== -1) {
    const cond = evaluateCELAtomic(trimmed.slice(0, ternaryIdx), context);
    const rest = trimmed.slice(ternaryIdx + 3);
    const colonIdx = rest.indexOf(' : ');
    if (colonIdx !== -1) {
      const trueBranch = rest.slice(0, colonIdx).trim();
      const falseBranch = rest.slice(colonIdx + 3).trim();
      return cond
        ? Boolean(parseCELValue(trueBranch, context))
        : Boolean(parseCELValue(falseBranch, context));
    }
  }

  // Comparison operators (only at top level, not inside parens or quotes)
  for (const op of ['>=', '<=', '!=', '==', '>', '<']) {
    const opIdx = findTopLevelOperator(trimmed, op);
    if (opIdx !== -1) {
      const leftExpr = trimmed.slice(0, opIdx).trim();
      const rightExpr = trimmed.slice(opIdx + op.length + 2).trim();

      const leftVal = resolveCELExpr(leftExpr, context);
      const rightVal = parseCELValue(rightExpr, context);

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

  // Boolean result from expression (method call, `in`, `has()`)
  const val = resolveCELExpr(trimmed, context);
  return Boolean(val);
}

/**
 * Create a CEL-like expression evaluator.
 *
 * Supported syntax:
 * - Property access: `resource.metadata.name`
 * - Comparisons: `==`, `!=`, `>=`, `<=`, `>`, `<`
 * - Methods: `.size()`, `.startsWith()`, `.endsWith()`, `.contains()`, `.matches()`
 * - Macros: `.exists(x, pred)`, `.all(x, pred)`, `.filter(x, pred)`, `.map(x, expr)`
 * - Functions: `has(path)`, `size(expr)`
 * - Operators: `in`, `!`, `? :`
 * - Logical: `&&` (AND), `||` (OR)
 */
export function createCELEvaluator(): ExpressionEvaluator {
  return {
    evaluate(expression: string, context: Record<string, unknown>): boolean {
      // Handle || (OR) — lowest precedence
      if (expression.includes('||')) {
        const parts = expression.split('||');
        return parts.some((p) => this.evaluate(p.trim(), context));
      }

      // Handle && (AND)
      if (expression.includes('&&')) {
        const parts = expression.split('&&');
        return parts.every((p) => this.evaluate(p.trim(), context));
      }

      return evaluateCELAtomic(expression, context);
    },

    validate(expression: string): { valid: boolean; error?: string } {
      if (!expression || expression.trim().length === 0) {
        return { valid: false, error: 'Expression is empty' };
      }
      return { valid: true };
    },
  };
}
