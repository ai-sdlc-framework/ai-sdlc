/**
 * Auto-pass rule resolution (RFC-0011 §6.4 + Phase 4 / AISDLC-115.5).
 *
 * `applyAutoPass()` matches a single `IssueInput` against the configured
 * `autoPassRules` (loaded from `.ai-sdlc/dor-config.yaml`) and returns the
 * set of gate IDs that should be skipped during evaluation.
 *
 * Match semantics (per Alex's Addition 1):
 *
 *   - First-match-wins. Rules are evaluated in array order; the first rule
 *     whose `sources` (and optional `titlePattern` / `maxBodyDiffLines`)
 *     match the issue determines the skip set.
 *   - When a rule has both `gatesSkipped` and `gatesRetained` populated,
 *     `gatesSkipped` wins for the skip set — `gatesRetained` is the
 *     positive complement (kept for documentation + schema-level intent).
 *   - When `gatesSkipped` is empty AND `gatesRetained` is empty, the
 *     legacy "full skip" semantics apply: every gate (1-7) is skipped
 *     (matches the pre-Phase-4 RFC §6.4 shortcut for dependency bumps).
 *
 * Returning `[]` means the issue does NOT match any auto-pass rule and
 * the full Stage A / Stage B pipeline runs as normal.
 */

import type { AutoPassRule } from './dor-config.js';
import type { GateId, IssueInput } from './types.js';

export const ALL_GATES: GateId[] = [1, 2, 3, 4, 5, 6, 7];

/**
 * Resolve the `gatesSkipped` set for an issue against the project's
 * configured auto-pass rules. Returns the gate IDs that should short-
 * circuit to `verdict: 'skip'` with `finding: 'auto-pass: <kind>'`.
 *
 * Tier-1 callers (the CLI subcommand) read the config off disk and pass
 * `cfg.autoPassRules` here; tests construct the rule list inline.
 */
export function applyAutoPass(
  input: IssueInput,
  rules: AutoPassRule[],
): { matched?: AutoPassRule; gatesSkipped: number[] } {
  for (const rule of rules) {
    if (!matches(rule, input)) continue;
    return { matched: rule, gatesSkipped: resolveGatesSkipped(rule) };
  }
  return { gatesSkipped: [] };
}

/**
 * Per-rule predicate. Conservative — every declared filter must match.
 * `sources` is required by the schema; `titlePattern` and
 * `maxBodyDiffLines` are optional refinements.
 */
function matches(rule: AutoPassRule, input: IssueInput): boolean {
  if (!rule.sources || rule.sources.length === 0) return false;
  const author = input.authorIdentity ?? '';
  if (!rule.sources.includes(author)) return false;

  if (rule.titlePattern) {
    let re: RegExp;
    try {
      re = new RegExp(rule.titlePattern);
    } catch {
      // Invalid regex in config — fail closed (don't auto-pass).
      return false;
    }
    if (!re.test(input.title)) return false;
  }

  if (typeof rule.maxBodyDiffLines === 'number') {
    const lines = input.body.split('\n').length;
    if (lines > rule.maxBodyDiffLines) return false;
  }

  return true;
}

/**
 * Resolve the actual skip set for a matched rule.
 *
 *   - Non-empty `gatesSkipped` ⇒ that set verbatim.
 *   - Empty `gatesSkipped` but non-empty `gatesRetained` ⇒ everything NOT
 *     in `gatesRetained` (the inverse — useful when authors prefer to
 *     declare what stays).
 *   - Both empty ⇒ all 7 gates skipped (legacy shortcut).
 */
export function resolveGatesSkipped(rule: AutoPassRule): number[] {
  const skipped = rule.gatesSkipped ?? [];
  const retained = rule.gatesRetained ?? [];
  if (skipped.length > 0) {
    return [...new Set(skipped)].filter((g) => g >= 1 && g <= 7);
  }
  if (retained.length > 0) {
    const retainedSet = new Set(retained);
    return ALL_GATES.filter((g) => !retainedSet.has(g));
  }
  return [...ALL_GATES];
}

/**
 * Default Phase 4 rule for `signal-pipeline-generated` issues
 * (Alex's Addition 1 — Product sign-off). Exposed as a constant so the
 * dispatcher and tests can reference the same shape without re-typing it.
 *
 * Skip rationale (per Alex's note):
 *   - Gate 1 (AC testable): signal-pipeline asserts `fixes the failing test` style ACs.
 *   - Gate 4 (scope): signal-pipeline tasks are minimal-scope by construction.
 *   - Gate 5 (surface): the failure already names the file/line — surface is implicit.
 *   - Gate 6 (done-state): "the test passes" is the implicit done-state.
 *
 * Retain rationale:
 *   - Gate 2 (markers): TBD/FIXME tokens still indicate generator drift.
 *   - Gate 3 (references): broken file links would still trip developer.
 *   - Gate 7 (deps): blocked-by-X dependencies still need explicit linking.
 */
export const SIGNAL_PIPELINE_AUTOPASS_RULE: AutoPassRule = {
  kind: 'signal-pipeline-generated',
  sources: ['ai-sdlc/signal-pipeline'],
  gatesSkipped: [1, 4, 5, 6],
  gatesRetained: [2, 3, 7],
};
