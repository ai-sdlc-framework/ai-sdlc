/**
 * AI-SDLC Governance Resolver (RFC-0048 Phase 1 / AISDLC-601)
 *
 * Single source-of-truth resolver for the per-repo `spec.governance` block in
 * `.ai-sdlc/agent-role.yaml`. Consumed by `session-start.js` and
 * `subagent-start.js` so the injected hard-rule banners RENDER from the
 * resolved policy instead of hard-coded string constants.
 *
 * Schema (`.ai-sdlc/agent-role.yaml` `spec.governance`), all keys optional:
 *
 *   governance:
 *     preset: strict | operator-trusted   # sugar layer, see below
 *     allowMerge: never | onGreenClean    # default: never
 *     allowForcePush: never | leaseOnOwnBranch | bool   # default: never
 *                                         # (true = leaseOnOwnBranch, false = never)
 *     operational: [..closed set..]       # default: [] (dispatch-role grants)
 *     protectedBranches: [..names..]      # default: [] (adds to main/master)
 *     allowClosePrIssue: bool             # default: false
 *     allowBranchDelete: bool             # default: false
 *     allowResetHard: bool                # default: false
 *
 * An ABSENT `governance` section resolves to the strict defaults below —
 * existing adopters with no governance block are byte-for-byte unchanged
 * (RFC-0048 Backward Compatibility).
 *
 * Presets (OQ-5) are pure sugar: `operator-trusted` expands to the exact same
 * resolved shape granular keys could produce
 * (`{ allowMerge: 'onGreenClean', ...strict defaults for the rest }`).
 * Explicit granular keys in the YAML override the preset's expansion. A
 * preset can NEVER set anything the granular schema itself couldn't — so the
 * OQ-3 permanently-fixed integrity rules (CI-skip tokens, editing
 * `.ai-sdlc/attestations|verdicts`, relaxing governance from a PR tree) are
 * not representable here at all; they are not part of this schema and never
 * will be configurable through it.
 *
 * Fail-closed (OQ-1/OQ-3 requirement): any unknown key, unknown preset name,
 * or malformed value (wrong type / not in the enumerated set) is IGNORED —
 * the resolved value falls back to whatever the preset/default already
 * produced. Malformed input never relaxes a rule; at worst it is a no-op.
 *
 * Trust boundary (OQ-2): this module only RESOLVES a policy object handed to
 * it — it does not decide WHERE that policy is read from. Both
 * `session-start.js` and `subagent-start.js` read `.ai-sdlc/agent-role.yaml`
 * from the on-disk worktree (`CLAUDE_PROJECT_DIR` / `git rev-parse
 * --show-toplevel`), which for the developer/reviewer/session flows in this
 * repo is always the trusted base-branch checkout — never a PR-diff-supplied
 * override. Do not add a code path here or in the hooks that reads
 * governance from untrusted PR content (e.g. a file fetched from a PR head
 * ref); that would let the governed party relax its own rules.
 */

'use strict';

const STRICT_DEFAULTS = Object.freeze({
  allowMerge: 'never',
  allowForcePush: false,
  allowClosePrIssue: false,
  allowBranchDelete: false,
  allowResetHard: false,
});

/** Closed set of operational actions grantable to the dispatch role. */
const OPERATIONAL_ACTIONS = Object.freeze([
  'rebase-own-branch',
  'lease-push-own-branch',
  'retrigger-ci',
  'requeue',
  'file-subid-followups',
  'answer-operational-decisions',
  'clear-executor-context',
]);

const KNOWN_PRESETS = new Set(['strict', 'operator-trusted']);
const LIST_KEYS = new Set(['operational', 'protectedBranches']);
const BOOLEAN_KEYS = ['allowForcePush', 'allowClosePrIssue', 'allowBranchDelete', 'allowResetHard'];

/**
 * Extracts the raw `spec.governance` block from agent-role.yaml text as a
 * plain object of scalar values (strings/booleans), without a YAML library —
 * consistent with this codebase's existing hand-rolled `parseListField`
 * approach in session-start.js / subagent-start.js.
 *
 * Returns `null` when no `governance:` key is found (absent section).
 * Malformed entries (nested maps/lists, unparsable lines) are silently
 * skipped — `resolveGovernance` fails closed on anything it doesn't
 * recognize regardless.
 */
function parseGovernanceBlock(yamlText) {
  if (typeof yamlText !== 'string') return null;
  const lines = yamlText.split('\n');
  let govIndent = null;
  const raw = {};
  let found = false;
  let listKey = null;

  for (const line of lines) {
    if (govIndent === null) {
      const m = line.match(/^(\s*)governance:\s*$/);
      if (m) {
        govIndent = m[1].length;
        found = true;
      }
      continue;
    }

    if (/^\s*$/.test(line)) continue; // blank lines don't end the block
    // Comment-only lines (any indent) never end the block or a list: a comment
    // between list items must not drop the later entries.
    if (/^\s*#/.test(line)) continue;

    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch[1].length;
    if (indent <= govIndent) break; // dedent — end of the governance block

    const item = line.match(/^\s*-\s+(.*)$/);
    if (item) {
      if (listKey) {
        const v = item[1]
          .replace(/\s+#.*$/, '')
          .trim()
          .replace(/^['"]/, '')
          .replace(/['"]$/, '');
        raw[listKey].push(v);
      }
      continue;
    }
    listKey = null;

    const kv = line.match(/^\s*([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;

    const key = kv[1];
    let value = kv[2].replace(/\s+#.*$/, '').trim();
    if (value === '') {
      // Block list for the two list-valued keys; any other nested map/list is
      // not part of this schema and is skipped.
      if (LIST_KEYS.has(key)) {
        raw[key] = [];
        listKey = key;
      }
      continue;
    }
    if (LIST_KEYS.has(key)) {
      const inline = value.match(/^\[(.*)\]$/);
      raw[key] = inline
        ? inline[1]
            .split(',')
            .map((x) => x.trim().replace(/^['"]/, '').replace(/['"]$/, ''))
            .filter((x) => x !== '')
        : [value]; // scalar where a list belongs: malformed, fails closed later
      continue;
    }

    value = value.replace(/^['"]/, '').replace(/['"]$/, '');

    if (value === 'true') raw[key] = true;
    else if (value === 'false') raw[key] = false;
    else raw[key] = value;
  }

  return found ? raw : null;
}

/**
 * Merges a raw (already-parsed) governance object over the strict defaults.
 * `rawGovernance` may be `null`/`undefined` (absent section) or a malformed
 * object (unknown keys/values) — both fail closed to strict per key.
 *
 * @param {Record<string, unknown> | null | undefined} rawGovernance
 * @returns {{allowMerge: 'never'|'onGreenClean', allowForcePush: boolean, allowClosePrIssue: boolean, allowBranchDelete: boolean, allowResetHard: boolean}}
 */
function resolveGovernance(rawGovernance) {
  const resolved = { ...STRICT_DEFAULTS };

  if (!rawGovernance || typeof rawGovernance !== 'object') {
    return resolved;
  }

  // Preset applies first (sugar); explicit granular keys below override it.
  if (typeof rawGovernance.preset === 'string' && KNOWN_PRESETS.has(rawGovernance.preset)) {
    if (rawGovernance.preset === 'operator-trusted') {
      resolved.allowMerge = 'onGreenClean';
    }
    // 'strict' preset is a no-op — resolved already holds the defaults.
  }
  // Unknown preset name: fail closed — ignore, leave defaults/preset as-is.

  if (typeof rawGovernance.allowMerge === 'string') {
    const v = rawGovernance.allowMerge;
    if (v === 'never' || v === 'onGreenClean') {
      resolved.allowMerge = v;
    }
    // malformed value: fail closed — ignore, keep whatever preset/default set.
  }

  for (const key of BOOLEAN_KEYS) {
    if (typeof rawGovernance[key] === 'boolean') {
      resolved[key] = rawGovernance[key];
    }
    // malformed value (non-boolean): fail closed — ignore.
  }

  // allowForcePush also accepts the enum: leaseOnOwnBranch reads as truthy
  // (the boolean stays the back-compat view), `never` as false.
  if (typeof rawGovernance.allowForcePush === 'string') {
    if (rawGovernance.allowForcePush === 'leaseOnOwnBranch') resolved.allowForcePush = true;
    else if (rawGovernance.allowForcePush === 'never') resolved.allowForcePush = false;
  }

  return resolved;
}

/**
 * Resolves the force-push mode. `leaseOnOwnBranch` and boolean `true` →
 * 'leaseOnOwnBranch'; everything else (absent, `never`, `false`, malformed)
 * → 'never' (fail closed). Presets never influence it.
 */
function resolveForcePushMode(rawGovernance) {
  if (!rawGovernance || typeof rawGovernance !== 'object') return 'never';
  const v = rawGovernance.allowForcePush;
  return v === true || v === 'leaseOnOwnBranch' ? 'leaseOnOwnBranch' : 'never';
}

/**
 * Resolves the `operational` list against the CLOSED set: unknown entries and
 * non-string entries are dropped (never granted); a non-array value yields [].
 * De-duplicated, order-preserving.
 */
function resolveOperational(rawGovernance) {
  if (!rawGovernance || typeof rawGovernance !== 'object') return [];
  const list = rawGovernance.operational;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (typeof entry === 'string' && OPERATIONAL_ACTIONS.includes(entry) && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Resolves additional protected branch names (adds to the always-protected
 * main/master). Only well-formed branch-name strings are kept; a trailing `*`
 * means prefix match. Malformed input yields [] — which can only ever mean
 * LESS protection than configured, never a relaxation of main/master.
 */
function resolveProtectedBranches(rawGovernance) {
  if (!rawGovernance || typeof rawGovernance !== 'object') return [];
  const list = rawGovernance.protectedBranches;
  if (!Array.isArray(list)) return [];
  return list.filter((b) => typeof b === 'string' && /^[A-Za-z0-9._/-]+\*?$/.test(b));
}

/**
 * Resolves the force-push mode, operational list and protected branches from
 * raw agent-role.yaml text. Kept separate from `resolveGovernance` so that
 * function's resolved shape (and its callers) stay unchanged.
 */
function resolveGovernanceExtrasFromYaml(yamlText) {
  const raw = parseGovernanceBlock(yamlText);
  return {
    forcePushMode: resolveForcePushMode(raw),
    operational: resolveOperational(raw),
    protectedBranches: resolveProtectedBranches(raw),
  };
}

/** Convenience: parse + resolve in one call, given raw agent-role.yaml text. */
function resolveGovernanceFromYaml(yamlText) {
  return resolveGovernance(parseGovernanceBlock(yamlText));
}

// ── Render helpers — shared text so session-start and subagent-start never
// drift from each other or from the resolved policy. ─────────────────────

const ONGREENCLEAN_MERGE_TEXT =
  '**Merge:** allowed once ALL required CI checks are green AND `mergeStateStatus == CLEAN`, ' +
  'but only for trusted-tier (internal backlog) work items — external GitHub-sourced work still ' +
  'requires a human to merge (`.ai-sdlc/agent-role.yaml` governance: `allowMerge: onGreenClean`).';

const STRICT_MERGE_TEXT = '**NEVER merge PRs. Only humans merge.**';

function renderMergeRuleText(resolved) {
  return resolved.allowMerge === 'onGreenClean' ? ONGREENCLEAN_MERGE_TEXT : STRICT_MERGE_TEXT;
}

function renderClosePrIssueRuleText(resolved) {
  return resolved.allowClosePrIssue
    ? '**PRs/issues may be closed per repo policy** (`.ai-sdlc/agent-role.yaml` governance: `allowClosePrIssue: true`).'
    : '**NEVER close issues or PRs.**';
}

const LEASE_FORCE_PUSH_TEXT =
  '**Force-push is allowed per repo policy** (`.ai-sdlc/agent-role.yaml` governance: `allowForcePush: leaseOnOwnBranch`) — ' +
  "force-with-lease permitted on this task's own branch only; never on main.";

function renderForcePushRuleText(resolved) {
  return resolved.allowForcePush ? LEASE_FORCE_PUSH_TEXT : '**NEVER force push.**';
}

/**
 * Renders the `operational` grants for the dispatch role. Returns '' when the
 * session is not the dispatch role or nothing is granted, so every other
 * session's banner is unchanged.
 *
 * @param {string[]} operational resolved (closed-set) list
 * @param {string | undefined} hierarchyRole value of AI_SDLC_HIERARCHY_ROLE
 */
function renderOperationalRules(operational, hierarchyRole) {
  if (hierarchyRole !== 'operator-dispatch') return '';
  if (!Array.isArray(operational) || operational.length === 0) return '';
  return (
    '**Operational actions granted to this dispatch role** (`.ai-sdlc/agent-role.yaml` governance: `operational`): ' +
    operational.map((a) => `\`${a}\``).join(', ') +
    '. Each is permitted only within the permanently fixed integrity rules.'
  );
}

function renderBranchDeleteRuleText(resolved) {
  return resolved.allowBranchDelete
    ? '**Branch deletion is allowed per repo policy** (`.ai-sdlc/agent-role.yaml` governance: `allowBranchDelete: true`).'
    : '**Never delete branches** (`git branch -D`/`-d`)';
}

function renderResetHardRuleText(resolved) {
  return resolved.allowResetHard
    ? '**`git reset --hard` is allowed per repo policy** (`.ai-sdlc/agent-role.yaml` governance: `allowResetHard: true`).'
    : '**Never run destructive git** (`git reset --hard`, `git checkout -- .`, `git restore .`)';
}

/**
 * Renders the three hard-rule lines used in the SessionStart governance
 * banner (`session-start.js`). Kept to the historical three rules
 * (merge/close/force-push) that this banner has always surfaced, so the
 * strict-default output stays byte-identical to pre-AISDLC-601 text.
 */
function renderSessionStartHardRules(resolved) {
  return [
    renderMergeRuleText(resolved),
    renderClosePrIssueRuleText(resolved),
    renderForcePushRuleText(resolved),
  ].join('\n');
}

/**
 * Renders the five "Hard rules — NEVER violate" bullets used in the
 * SubagentStart governance banner (`subagent-start.js`).
 */
function renderSubagentHardRules(resolved) {
  const mergeLine =
    resolved.allowMerge === 'onGreenClean'
      ? `- ${ONGREENCLEAN_MERGE_TEXT}`
      : '- **Never merge PRs** (`gh pr merge`)';
  const forcePushLine = resolved.allowForcePush
    ? `- ${renderForcePushRuleText(resolved)}`
    : '- **Never force-push** (`git push --force`/`-f`)';
  const closeLine = resolved.allowClosePrIssue
    ? `- ${renderClosePrIssueRuleText(resolved)}`
    : '- **Never close PRs or issues** (`gh pr close`, `gh issue close`)';
  const branchDeleteLine = resolved.allowBranchDelete
    ? `- ${renderBranchDeleteRuleText(resolved)}`
    : '- **Never delete branches** (`git branch -D`/`-d`)';
  const resetHardLine = resolved.allowResetHard
    ? `- ${renderResetHardRuleText(resolved)}`
    : '- **Never run destructive git** (`git reset --hard`, `git checkout -- .`, `git restore .`)';

  return [mergeLine, forcePushLine, closeLine, branchDeleteLine, resetHardLine].join('\n');
}

module.exports = {
  STRICT_DEFAULTS,
  parseGovernanceBlock,
  resolveGovernance,
  resolveGovernanceFromYaml,
  OPERATIONAL_ACTIONS,
  resolveForcePushMode,
  resolveOperational,
  resolveProtectedBranches,
  resolveGovernanceExtrasFromYaml,
  renderOperationalRules,
  renderSessionStartHardRules,
  renderSubagentHardRules,
};
