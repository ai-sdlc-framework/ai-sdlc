/**
 * Action enforcement — checks shell commands against blockedActions
 * patterns from AgentRole constraints. Prevents agents from executing
 * dangerous operations like merging PRs, force-pushing, or dismissing reviews.
 */

export interface ActionEnforcementResult {
  allowed: boolean;
  /** The pattern that matched, if blocked. */
  matchedPattern?: string;
  /** The full command that was checked. */
  command: string;
}

/**
 * Convert a glob-like blocked action pattern to a regex.
 * Supports * (any characters) at the end of a pattern.
 *
 * Examples:
 *   "gh pr merge*" → matches "gh pr merge 42 --squash"
 *   "git push --force*" → matches "git push --force origin main"
 *   "git push -f*" → matches "git push -f origin main"
 */
function patternToRegex(pattern: string): RegExp {
  // Escape regex special chars except *
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // Replace * with .* for glob matching
  const regexStr = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${regexStr}$`, 'i');
}

/**
 * Check if a shell command is allowed by the blocked actions policy.
 */
export function checkAction(command: string, blockedActions: string[]): ActionEnforcementResult {
  const trimmed = command.trim();

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
 * Default blocked actions for all agents.
 * These prevent agents from performing operations that require human approval.
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
