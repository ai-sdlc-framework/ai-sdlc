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
 * @module decisions/governance-fallback
 */

export type GovernanceChangeKind = 'weakening' | 'tightening';

export interface GovernanceChange {
  kind: GovernanceChangeKind;
  /** Option ids that weaken a control. Required and non-empty when kind is `weakening`. */
  weakeningOptionIds: string[];
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
  return change?.kind === 'weakening' && change.weakeningOptionIds.includes(optionId);
}
