/**
 * Authorization enforcement from PRD Sections 15.1-15.2.
 *
 * 3-layer defense model:
 * 1. Permissions — level-based read/write/execute glob matching
 * 2. Constraints — agent-specific blockedPaths, allowedLanguages
 * 3. Guardrails — approval requirements, line limits, etc.
 */

import type {
  Permissions,
  AgentConstraints,
  AutonomyPolicy,
  AutonomyLevel,
} from '../core/types.js';

export interface AuthorizationContext {
  agent: string;
  action: 'read' | 'write' | 'execute';
  target: string;
}

export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
  layer?: 'permissions' | 'constraints';
}

export type AuthorizationHook = (context: AuthorizationContext) => AuthorizationResult;

/**
 * Simple glob matching: supports `*` (any segment) and `**` (any path).
 */
function globMatch(pattern: string, target: string): boolean {
  // Exact match
  if (pattern === target) return true;
  // Convert glob to regex
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${regex}$`).test(target);
}

/**
 * Check if a permission set allows the given action on the target.
 */
export function checkPermission(
  permissions: Permissions,
  action: 'read' | 'write' | 'execute',
  target: string,
): AuthorizationResult {
  const patterns = permissions[action];
  if (!patterns || patterns.length === 0) {
    return { allowed: false, reason: `No ${action} permissions defined`, layer: 'permissions' };
  }
  const matched = patterns.some((p) => globMatch(p, target));
  if (!matched) {
    return {
      allowed: false,
      reason: `Target "${target}" not matched by ${action} permissions`,
      layer: 'permissions',
    };
  }
  return { allowed: true };
}

/**
 * Language extension mapping for allowedLanguages constraint.
 */
const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py', '.pyi'],
  rust: ['.rs'],
  go: ['.go'],
  java: ['.java'],
  ruby: ['.rb'],
  csharp: ['.cs'],
  cpp: ['.cpp', '.cc', '.cxx', '.h', '.hpp'],
  c: ['.c', '.h'],
};

/**
 * Check if agent constraints allow the target.
 */
export function checkConstraints(
  constraints: AgentConstraints,
  target: string,
): AuthorizationResult {
  // Check blockedPaths
  if (constraints.blockedPaths) {
    for (const blocked of constraints.blockedPaths) {
      if (globMatch(blocked, target)) {
        return {
          allowed: false,
          reason: `Target "${target}" matches blocked path "${blocked}"`,
          layer: 'constraints',
        };
      }
    }
  }

  // Check allowedLanguages (file extension)
  if (constraints.allowedLanguages && constraints.allowedLanguages.length > 0) {
    const ext = target.includes('.') ? `.${target.split('.').pop()}` : '';
    if (ext) {
      const allowedExtensions = constraints.allowedLanguages.flatMap(
        (lang) => LANGUAGE_EXTENSIONS[lang.toLowerCase()] ?? [],
      );
      if (allowedExtensions.length > 0 && !allowedExtensions.includes(ext)) {
        return {
          allowed: false,
          reason: `File extension "${ext}" not in allowed languages`,
          layer: 'constraints',
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Composite authorization: checks permissions then constraints.
 */
export function authorize(
  permissions: Permissions,
  constraints: AgentConstraints | undefined,
  action: 'read' | 'write' | 'execute',
  target: string,
): AuthorizationResult {
  // Layer 1: Permission check
  const permResult = checkPermission(permissions, action, target);
  if (!permResult.allowed) return permResult;

  // Layer 2: Constraint check (only for write actions)
  if (constraints && action === 'write') {
    const constraintResult = checkConstraints(constraints, target);
    if (!constraintResult.allowed) return constraintResult;
  }

  return { allowed: true };
}

/**
 * Create an authorization hook that can be injected into the executor.
 *
 * Resolves the agent's current autonomy level to its permissions,
 * then checks against the agent's constraints.
 */
export function createAuthorizationHook(
  policy: AutonomyPolicy,
  agentLevels: Map<string, number>,
  agentConstraints: Map<string, AgentConstraints>,
): AuthorizationHook {
  return (ctx: AuthorizationContext): AuthorizationResult => {
    const level = agentLevels.get(ctx.agent);
    if (level === undefined) {
      return {
        allowed: false,
        reason: `Agent "${ctx.agent}" has no assigned autonomy level`,
        layer: 'permissions',
      };
    }

    const levelDef = policy.spec.levels.find((l: AutonomyLevel) => l.level === level);
    if (!levelDef) {
      return {
        allowed: false,
        reason: `Autonomy level ${level} not defined in policy`,
        layer: 'permissions',
      };
    }

    const constraints = agentConstraints.get(ctx.agent);
    return authorize(levelDef.permissions, constraints, ctx.action, ctx.target);
  };
}
