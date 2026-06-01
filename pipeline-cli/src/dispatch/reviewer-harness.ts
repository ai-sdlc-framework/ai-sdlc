/**
 * Reviewer-harness selection logic (AISDLC-483).
 *
 * Maps a reviewer role to the canonical agent name and model given the
 * current environment, honouring the `AI_SDLC_REVIEWER_HARNESS` override.
 *
 * Default routing (no override):
 *   - code-review   → code-reviewer-codex   (Codex plan, zero Claude tokens)
 *   - test-review   → test-reviewer-codex   (Codex plan, zero Claude tokens)
 *   - security      → security-reviewer     (Claude-native, opus)
 *   - developer     → developer             (Claude-native, sonnet)
 *
 * Override: set `AI_SDLC_REVIEWER_HARNESS=claude` to force all three review
 * roles onto the Claude-native agents (e.g. when Codex is not installed).
 * Developer dispatch is never affected by this override.
 */

/** The four dispatchable roles. */
export type ReviewerRole = 'code' | 'test' | 'security' | 'developer';

/** The harness override value that forces Claude-native agents for all reviewers. */
export const CLAUDE_HARNESS_OVERRIDE = 'claude' as const;

/** Env-var name that overrides the default harness. */
export const REVIEWER_HARNESS_ENV = 'AI_SDLC_REVIEWER_HARNESS' as const;

/**
 * The resolved agent name + model for a given role.
 */
export interface ResolvedReviewer {
  /** The agent name as it appears in ai-sdlc-plugin/agents/<name>.md */
  agentName: string;
  /**
   * The billing harness — 'codex' means Codex plan (zero Claude tokens),
   * 'claude-code' means Claude-native session.
   */
  harness: 'codex' | 'claude-code';
  /**
   * The model the agent should use.
   * 'inherit' means the agent frontmatter governs (used when the agent already
   * pins its model, e.g. security-reviewer = opus, developer = sonnet).
   */
  model: 'inherit' | 'sonnet' | 'opus';
}

/**
 * Resolve the agent name + harness for a reviewer role.
 *
 * @param role       - The role to resolve.
 * @param overrideHarness - Explicit override value (defaults to
 *                          `process.env.AI_SDLC_REVIEWER_HARNESS`).
 *                          Pass `'claude'` to force Claude-native agents.
 *                          Pass `undefined` or `''` to use Codex defaults.
 */
export function resolveReviewer(role: ReviewerRole, overrideHarness?: string): ResolvedReviewer {
  // Developer dispatch is never affected by the reviewer-harness override.
  if (role === 'developer') {
    return { agentName: 'developer', harness: 'claude-code', model: 'sonnet' };
  }

  // Security review always stays on Claude-native opus — reasoning-heavy work
  // that Codex does not handle reliably.
  if (role === 'security') {
    return {
      agentName: 'security-reviewer',
      harness: 'claude-code',
      model: 'opus',
    };
  }

  // Determine whether the caller has requested a Claude-native override.
  const envVal = overrideHarness ?? process.env[REVIEWER_HARNESS_ENV] ?? '';
  const forceClaudeNative = envVal.toLowerCase() === CLAUDE_HARNESS_OVERRIDE;

  if (role === 'code') {
    if (forceClaudeNative) {
      return { agentName: 'code-reviewer', harness: 'claude-code', model: 'sonnet' };
    }
    return { agentName: 'code-reviewer-codex', harness: 'codex', model: 'inherit' };
  }

  // role === 'test'
  if (forceClaudeNative) {
    return { agentName: 'test-reviewer', harness: 'claude-code', model: 'sonnet' };
  }
  return { agentName: 'test-reviewer-codex', harness: 'codex', model: 'inherit' };
}

/**
 * Map the classifier output name (`testing`, `critic`, `security`) to a
 * `ReviewerRole`, then call `resolveReviewer`.
 *
 * This is the entry point used by the `/ai-sdlc execute` and
 * `/ai-sdlc orchestrator-tick` command bodies where classifier names are used.
 *
 * @param classifierName - One of 'testing' | 'critic' | 'security'
 * @param overrideHarness - Explicit override (defaults to env var).
 */
export function resolveReviewerByClassifierName(
  classifierName: string,
  overrideHarness?: string,
): ResolvedReviewer {
  switch (classifierName) {
    case 'testing':
      return resolveReviewer('test', overrideHarness);
    case 'critic':
      return resolveReviewer('code', overrideHarness);
    case 'security':
      return resolveReviewer('security', overrideHarness);
    default:
      // Unknown classifier name — fall back to claude-native with sonnet so
      // the pipeline doesn't silently drop an unknown reviewer.
      return { agentName: classifierName, harness: 'claude-code', model: 'sonnet' };
  }
}
