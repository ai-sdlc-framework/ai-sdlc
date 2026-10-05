/**
 * Governance-change fallback rule (AISDLC-703, DEC-0053).
 *
 * A decision tagged as a governance change that WEAKENS a control (removes or
 * loosens a hook, gate, required check, review or attestation requirement,
 * merge restriction or role restriction, or moves a governance default in the
 * permissive direction) must not apply a weakening option on its own. Its
 * `--autonomous-fallback`, when present, has to be a non-weakening option, so a
 * lapsed timebox resolves to "control stays".
 *
 * Tightening decisions are unaffected.
 *
 * The tag is also DERIVED (AISDLC-703): `cli-decisions add` applies it when the
 * decision's scope, context-ref or body names a governance surface (see
 * `GOVERNANCE_SURFACES`). An author can add the tag but cannot remove a derived
 * one. A derived tag with no declared weakening option cannot tell which option
 * loosens the control, so it refuses any `--autonomous-fallback` and `auto-expire`
 * never applies one: the control stays until the planner or dispatch session answers.
 *
 * @module decisions/governance-fallback
 */

export type GovernanceChangeKind = 'weakening' | 'tightening';

export interface GovernanceChange {
  kind: GovernanceChangeKind;
  /** Option ids that weaken a control. Required and non-empty when kind is `weakening`. */
  weakeningOptionIds: string[];
  /** Set when `cli-decisions add` applied the tag itself. Such a tag cannot be removed. */
  derived?: boolean;
  /** Names of the governance surfaces the derivation matched. Only present with `derived`. */
  surfaces?: string[];
}

/** The one list of governance surfaces. A decision naming any of them is tagged. */
export const GOVERNANCE_SURFACES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: 'plugin hooks',
    pattern: /ai-sdlc-plugin\/hooks\b|\bPreToolUse\b|enforce-blocked-actions|\.husky\//i,
  },
  {
    name: 'governance resolver and schema defaults',
    pattern: /governance[-\s/]?(resolver|schema)|resolved-governance|agent-role\.schema/i,
  },
  {
    name: 'agent-role config and templates',
    pattern: /agent-role(\.yaml|\.schema|[-\s](config|template))/i,
  },
  {
    name: 'required checks and rulesets',
    pattern: /required[-\s]checks?|branch[-\s]protection|\brulesets?\b|ai-sdlc\/pr-ready/i,
  },
  { name: 'workflow gates', pattern: /\.github\/workflows\/|workflow gates?/i },
  { name: 'CLAUDE.md rule sections', pattern: /CLAUDE\.md/ },
  {
    name: 'merge and role restrictions',
    pattern:
      /allowForcePush|blockedActions|blocked[-\s]actions|merge restrictions?|role restrictions?|only humans merge/i,
  },
];

/** Names of the governance surfaces mentioned in the given texts (scope, context-ref, body). */
export function detectGovernanceSurfaces(...texts: Array<string | undefined>): string[] {
  const haystack = texts.filter((t): t is string => typeof t === 'string').join('\n');
  return GOVERNANCE_SURFACES.filter((s) => s.pattern.test(haystack)).map((s) => s.name);
}

/**
 * Merges an author-supplied tag with the derived one. A derived tag is always
 * present when a surface matches, and its kind is always `weakening`: an author
 * cannot declare `tightening` to neutralise it. The author's `--weakens` ids are
 * kept so a fallback can still be checked against them. With none declared the
 * derived tag cannot tell which option loosens the control.
 */
export function deriveGovernanceChange(
  authored: GovernanceChange | undefined,
  surfaces: string[],
): GovernanceChange | undefined {
  if (surfaces.length === 0) return authored;
  return {
    kind: 'weakening',
    weakeningOptionIds: authored?.weakeningOptionIds ?? [],
    derived: true,
    surfaces,
  };
}

/** Returns an error message naming the rule and the ways forward, or null when the input is fine. */
export function checkGovernanceFallback(
  change: GovernanceChange | undefined,
  optionIds: string[],
  fallback: string | undefined,
): string | null {
  if (!change) return null;
  const unknown = change.weakeningOptionIds.filter((id) => !optionIds.includes(id));
  if (unknown.length > 0) {
    return `--weakens must reference declared option ids (unknown: ${unknown.join(', ')}; declared: ${optionIds.join(', ')})`;
  }
  if (change.kind === 'tightening') {
    return change.weakeningOptionIds.length > 0
      ? '--weakens is only valid with --governance-change weakening'
      : null;
  }
  if (change.derived && change.weakeningOptionIds.length === 0) {
    if (fallback === undefined) return null;
    return (
      `governance-fallback rule: this decision names a governance surface (${(change.surfaces ?? []).join(', ')}) so it is tagged automatically, ` +
      `and --autonomous-fallback "${fallback}" cannot be checked against a declared weakening option. ` +
      'Either declare --governance-change weakening --weakens <option-id> so the fallback can be checked, or add the decision with no fallback so it stays open until the planner or dispatch session answers it.'
    );
  }
  if (change.weakeningOptionIds.length === 0) {
    return '--governance-change weakening needs at least one --weakens <option-id> naming the option that weakens the control';
  }
  if (fallback !== undefined && change.weakeningOptionIds.includes(fallback)) {
    return (
      `governance-fallback rule: --autonomous-fallback "${fallback}" weakens a control, and a timebox lapse must leave the control in place. ` +
      'Either pick a non-weakening option as the fallback, or add the decision with no fallback so it stays open until the planner or dispatch session answers it.'
    );
  }
  return null;
}

/** True when applying `optionId` on timebox expiry would weaken a control. */
export function fallbackWeakensControl(
  change: GovernanceChange | undefined,
  optionId: string,
): boolean {
  if (change?.kind !== 'weakening') return false;
  if (change.derived && change.weakeningOptionIds.length === 0) return true;
  return change.weakeningOptionIds.includes(optionId);
}
