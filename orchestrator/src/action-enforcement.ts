/**
 * Action enforcement — checks shell commands against blockedActions
 * patterns from AgentRole constraints. Prevents agents from executing
 * dangerous operations like merging PRs, force-pushing, or dismissing reviews.
 */

import type { AuditLog } from '@ai-sdlc/reference';

export interface ActionEnforcementResult {
  allowed: boolean;
  /** The pattern that matched, if blocked. */
  matchedPattern?: string;
  /** The full command that was checked. */
  command: string;
}

/**
 * Convert a glob-like blocked action pattern to a regex.
 * Supports * (any characters) anywhere in the pattern.
 */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${regexStr}$`, 'i');
}

/**
 * Check if a shell command is allowed by the blocked actions policy.
 */
export function checkAction(command: string, blockedActions: string[]): ActionEnforcementResult {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: true, command: trimmed };

  for (const pattern of blockedActions) {
    const regex = patternToRegex(pattern);
    if (regex.test(trimmed)) {
      return {
        allowed: false,
        matchedPattern: pattern,
        command: trimmed,
      };
    }
  }

  return { allowed: true, command: trimmed };
}

/**
 * Check an action and record the result in the audit log if blocked.
 */
export function enforceAction(
  command: string,
  blockedActions: string[],
  auditLog?: AuditLog,
  agentName?: string,
): ActionEnforcementResult {
  const result = checkAction(command, blockedActions);

  if (!result.allowed && auditLog) {
    auditLog.record({
      actor: agentName ?? 'agent',
      action: 'execute',
      resource: `command/${result.command.slice(0, 100)}`,
      decision: 'denied',
      details: {
        reason: 'blocked-action',
        pattern: result.matchedPattern,
        command: result.command,
      },
    });
  }

  return result;
}

/**
 * Default blocked actions for all agents.
 */
export const DEFAULT_BLOCKED_ACTIONS: string[] = [
  'gh pr merge*',
  'git merge*',
  'git push --force*',
  'git push -f*',
  'gh pr close*',
  'gh issue close*',
  'gh api */reviews/*/dismissals*',
  'git branch -D*',
  'git branch -d*',
  'git reset --hard*',
  'git checkout -- .',
  'git restore .',
];
