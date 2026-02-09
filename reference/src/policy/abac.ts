/**
 * Attribute-Based Access Control (ABAC) authorization.
 * Extends the existing authorization hook with expression-based
 * policy evaluation using Rego or CEL evaluators.
 * <!-- Source: PRD Section 10 -->
 */

import type {
  AuthorizationContext,
  AuthorizationHook,
  AuthorizationResult,
} from './authorization.js';
import type { ExpressionEvaluator } from './expression.js';

export interface ABACPolicy {
  /** A human-readable name for this policy. */
  name: string;
  /** The expression to evaluate. Must return truthy for access to be granted. */
  expression: string;
  /** Effect when the expression matches: 'allow' grants access, 'deny' blocks it. */
  effect: 'allow' | 'deny';
}

export interface ABACContext {
  /** The agent or user requesting access. */
  subject: Record<string, unknown>;
  /** The resource being accessed. */
  resource: Record<string, unknown>;
  /** The action being performed. */
  action: string;
  /** Additional environment attributes (time, IP, etc.). */
  environment?: Record<string, unknown>;
}

/**
 * Provider that maps an AuthorizationContext to a rich ABAC evaluation context.
 * This allows the hook to evaluate expressions with attributes beyond
 * the basic agent/action/target triple.
 */
export type ABACContextProvider = (ctx: AuthorizationContext) => Record<string, unknown>;

function defaultContextProvider(ctx: AuthorizationContext): Record<string, unknown> {
  return {
    subject: { name: ctx.agent },
    resource: { name: ctx.target },
    action: ctx.action,
    environment: {},
  };
}

/**
 * Create an ABAC authorization hook.
 *
 * Evaluates a set of policies using the provided expression evaluator.
 * Policies are evaluated in order. The first matching 'deny' policy
 * blocks access. If no 'deny' matches and at least one 'allow' matches,
 * access is granted. If no policies match, access is denied by default.
 *
 * The expression context includes:
 * - `subject.*` — agent/user attributes
 * - `resource.*` — resource attributes
 * - `action` — the requested action
 * - `environment.*` — environmental attributes
 */
export function createABACAuthorizationHook(
  evaluator: ExpressionEvaluator,
  policies: ABACPolicy[],
  contextProvider?: ABACContextProvider,
): AuthorizationHook {
  const getContext = contextProvider ?? defaultContextProvider;

  return (ctx: AuthorizationContext): AuthorizationResult => {
    const evalContext = getContext(ctx);
    let anyAllow = false;

    for (const policy of policies) {
      try {
        const matches = evaluator.evaluate(policy.expression, evalContext);
        if (matches) {
          if (policy.effect === 'deny') {
            return {
              allowed: false,
              reason: `Denied by ABAC policy "${policy.name}"`,
            };
          }
          if (policy.effect === 'allow') {
            anyAllow = true;
          }
        }
      } catch {
        // Expression evaluation errors are treated as non-matching
      }
    }

    if (anyAllow) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: 'No ABAC policy matched — default deny',
    };
  };
}
