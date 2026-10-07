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
 *     allowForcePush: never | leaseOnOwnBranch | bool   # default: leaseOnOwnBranch
 *                                         # (true = leaseOnOwnBranch, false = never;
 *                                         # AISDLC-710: lease push on the agent's OWN
 *                                         # task branch is the default, an explicit
 *                                         # `never` always wins, malformed = never)
 *     operational: [..closed set..]       # default: [] (dispatch-role grants)
 *     protectedBranches: [..names..]      # default: [] (adds to main/master)
 *     mergeAuthors: [..github logins..]   # default: [] (empty = nobody; the
 *                                         # merge-if-eligible gate then refuses)
 *     allowClosePrIssue: bool             # default: false
 *     allowBranchDelete: bool             # default: false
 *     allowResetHard: bool                # default: false
 *
 * An ABSENT `governance` section resolves to the defaults below. Every default is
 * strict EXCEPT `allowForcePush`, which defaults to `leaseOnOwnBranch`
 * (AISDLC-710): rebasing a task branch and lease-pushing it is the framework's
 * own required workflow, so refusing it by default blocked the documented happy
 * path for every adopter. The grant is still scoped to the dispatched task's own
 * branch by the PreToolUse hook (see lib/lease-push-guard.js).
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

const fs = require('fs');
const path = require('path');

const STRICT_DEFAULTS = Object.freeze({
  allowMerge: 'never',
  // AISDLC-710: boolean view of the `leaseOnOwnBranch` default (see resolveForcePushMode).
  allowForcePush: true,
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
const LIST_KEYS = new Set(['operational', 'protectedBranches', 'mergeAuthors']);
const BOOLEAN_KEYS = ['allowClosePrIssue', 'allowBranchDelete', 'allowResetHard'];

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
      const m = line.match(/^(\s*)governance:(.*)$/);
      if (m) {
        govIndent = m[1].length;
        found = true;
        // Anything after the key other than a trailing comment (`governance: {..}`,
        // `governance: *anchor`) cannot be parsed here: fail closed, never default.
        if (m[2].replace(/^\s*(#.*)?$/, '') !== '') {
          raw.allowForcePush = '<unparseable governance block>';
          break;
        }
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
    if (value === '' && key === 'allowForcePush') {
      // A present-but-empty value is malformed, not absent: resolves to `never`.
      raw[key] = '';
      continue;
    }
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

  // allowForcePush is the boolean view of resolveForcePushMode: absent keeps the
  // `leaseOnOwnBranch` default (AISDLC-710), an explicit value wins, and any
  // present-but-malformed value fails closed to false (`never`).
  resolved.allowForcePush = resolveForcePushMode(rawGovernance) === 'leaseOnOwnBranch';

  return resolved;
}

/**
 * Resolves the force-push mode. ABSENT (no governance block, or no
 * `allowForcePush` key) -> 'leaseOnOwnBranch' (AISDLC-710 default). An explicit
 * `leaseOnOwnBranch` / boolean `true` -> 'leaseOnOwnBranch'; an explicit `never`
 * / boolean `false` -> 'never'; any other PRESENT value (malformed) fails closed
 * to 'never'. Presets never influence it.
 */
function resolveForcePushMode(rawGovernance) {
  return describeForcePushPolicy(rawGovernance).mode;
}

/**
 * Same resolution as resolveForcePushMode, plus where the value came from, so
 * `/ai-sdlc doctor` and refusal messages can say why a mode is in effect.
 *
 * @returns {{mode: 'never'|'leaseOnOwnBranch', source: 'default'|'explicit'|'malformed', raw: unknown}}
 */
function describeForcePushPolicy(rawGovernance) {
  const v =
    rawGovernance && typeof rawGovernance === 'object' ? rawGovernance.allowForcePush : undefined;
  if (v === undefined) return { mode: 'leaseOnOwnBranch', source: 'default', raw: undefined };
  if (v === true || v === 'leaseOnOwnBranch') {
    return { mode: 'leaseOnOwnBranch', source: 'explicit', raw: v };
  }
  if (v === false || v === 'never') return { mode: 'never', source: 'explicit', raw: v };
  return { mode: 'never', source: 'malformed', raw: v };
}

/** Parse + describe the force-push policy from raw agent-role.yaml text (null/'' = nothing set). */
function describeForcePushPolicyFromYaml(yamlText) {
  return describeForcePushPolicy(parseGovernanceBlock(yamlText));
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
 * Resolves the `mergeAuthors` allow-list: GitHub logins whose PRs the
 * `merge-if-eligible` gate may merge. Only well-formed logins are kept
 * (alphanumerics and single hyphens, max 39 chars, as GitHub allows; a trailing
 * `[bot]` is not accepted). Absent / non-array / malformed yields [] and an
 * empty list trusts nobody, so malformed input can only refuse more.
 * Read ONLY from the verified main checkout by the merge gate.
 */
function resolveMergeAuthors(rawGovernance) {
  if (!rawGovernance || typeof rawGovernance !== 'object') return [];
  const list = rawGovernance.mergeAuthors;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (
      typeof entry === 'string' &&
      /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(entry) &&
      !out.some((x) => x.toLowerCase() === entry.toLowerCase())
    ) {
      out.push(entry);
    }
  }
  return out;
}

/** Parse + resolve the `mergeAuthors` allow-list from raw agent-role.yaml text. */
function resolveMergeAuthorsFromYaml(yamlText) {
  return resolveMergeAuthors(parseGovernanceBlock(yamlText));
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

/**
 * AISDLC-720: is this run marked untrusted?
 *
 * Signals come from the hook PROCESS ENVIRONMENT only. No file, config key,
 * sentinel (`.active-task` is NOT a trust marker: issue-triggered pipeline runs
 * have one too) or tool input is consulted, so nothing an agent can write can
 * downgrade untrusted to internal.
 *
 * Untrusted when either:
 *  1. `AI_SDLC_UNTRUSTED_RUN` is any non-empty value other than 0/false/no/off, or
 *  2. `GITHUB_ACTIONS=true` and there is no explicit internal marker
 *     (`AI_SDLC_INTERNAL_RUN` truthy). Fail closed in CI: the issue workflow and
 *     the external-PR review workflow do not go through executePipeline and set
 *     no signal. Until the workflow half sets the marker on trusted jobs
 *     (post-AISDLC-721), every CI run is untrusted for protected-path writes.
 *
 * 3. (AISDLC-730) a marker file `<gitdir>/ai-sdlc-untrusted` exists for ANY checkout
 *    enclosing `cwd` (every `.git` up to the filesystem root). Checked first and independent of the environment, so a child
 *    agent that clears its env is still untrusted. The marker lives outside the
 *    working tree and the hook refuses an untrusted run's writes to it.
 *
 * A local run with no signal stays internal (trusted by default, no prompts).
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ untrusted: boolean, reason: string }}
 */
const FALSY = ['0', 'false', 'no', 'off'];
function norm(v) {
  return String(v || '')
    .trim()
    .toLowerCase();
}

// Fail closed: non-empty and not explicitly falsy.
function isTruthy(v) {
  const n = norm(v);
  return n !== '' && !FALSY.includes(n);
}

// AISDLC-730: marker file the producer (pipeline-cli/src/runtime/untrusted-env.ts,
// UNTRUSTED_MARKER_FILE) writes into the worktree's git dir. It lives outside the
// process environment, so a descendant that clears its env is still untrusted.
const UNTRUSTED_MARKER_FILE = 'ai-sdlc-untrusted';

/**
 * Read `<gitDir>/ai-sdlc-untrusted`. Returns the reason string when present,
 * null when absent; any other read error fails closed (treated as marked).
 */
function readMarker(gitDir) {
  try {
    return fs.readFileSync(path.join(gitDir, UNTRUSTED_MARKER_FILE), 'utf8').trim() || 'marker';
  } catch (e) {
    return e && e.code === 'ENOENT' ? null : 'untrusted marker unreadable (fail closed)';
  }
}

/**
 * Collect markers from EVERY enclosing `.git` from `startDir` up to the filesystem
 * root (not only the nearest one: the run can create or overwrite the nearest `.git`,
 * e.g. `git init x && cd x`). Returns the first marker reason found, else null.
 *
 * A `.git` pointer file whose gitdir is missing or not a directory is treated as
 * INCONCLUSIVE, never as untrusted by itself (a broken pointer in an ordinary trusted
 * checkout must not lock that session out). Instead the marker is recovered through
 * git's own back-pointer: each enclosing repo's `.git/worktrees/<id>/gitdir` names the
 * worktree `.git` file it belongs to, so a worktree whose pointer was overwritten still
 * resolves to its admin dir and marker. Residual: a worktree outside every enclosing
 * repo with an overwritten pointer cannot be recovered (best-effort; see governance docs).
 */
function findUntrustedMarker(startDir) {
  if (!startDir) return null;
  let cur = path.resolve(startDir);
  const enclosingGitDirs = [];
  const brokenPointers = [];
  for (;;) {
    const dotGit = path.join(cur, '.git');
    try {
      const st = fs.statSync(dotGit);
      let gitDir = null;
      if (st.isDirectory()) {
        gitDir = dotGit;
        enclosingGitDirs.push(dotGit);
      } else {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (m) {
          const target = path.resolve(cur, m[1].trim());
          let ok = false;
          try {
            ok = fs.statSync(target).isDirectory();
          } catch (e) {
            if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) {
              return 'untrusted marker lookup failed (fail closed)';
            }
          }
          if (ok) gitDir = target;
          else brokenPointers.push(dotGit);
        } else {
          brokenPointers.push(dotGit);
        }
      }
      if (gitDir) {
        const marker = readMarker(gitDir);
        if (marker !== null) return marker;
      }
    } catch (e) {
      if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) {
        return 'untrusted marker lookup failed (fail closed)';
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const broken of brokenPointers) {
    for (const gd of enclosingGitDirs) {
      const wtRoot = path.join(gd, 'worktrees');
      let ids = [];
      try {
        ids = fs.readdirSync(wtRoot);
      } catch {
        continue;
      }
      for (const id of ids) {
        try {
          const back = fs.readFileSync(path.join(wtRoot, id, 'gitdir'), 'utf8').trim();
          if (path.resolve(back) !== broken) continue;
        } catch {
          continue;
        }
        const marker = readMarker(path.join(wtRoot, id));
        if (marker !== null) return marker;
      }
    }
  }
  return null;
}

function isUntrustedRun(env = process.env, cwd = null) {
  const marker = findUntrustedMarker(cwd);
  if (marker !== null) {
    return { untrusted: true, reason: `untrusted marker file: ${marker}` };
  }
  const raw = norm(env && env.AI_SDLC_UNTRUSTED_RUN);
  // Fail closed: any non-empty value that is not explicitly falsy is untrusted.
  if (raw !== '' && !FALSY.includes(raw)) {
    return { untrusted: true, reason: String((env && env.AI_SDLC_UNTRUSTED_REASON) || '').trim() };
  }
  const internal = norm(env && env.AI_SDLC_INTERNAL_RUN);
  const hasInternalMarker = isTruthy(internal);
  if (isTruthy(env && env.GITHUB_ACTIONS) && !hasInternalMarker) {
    return {
      untrusted: true,
      reason: 'GitHub Actions run without an internal-run marker (AI_SDLC_INTERNAL_RUN)',
    };
  }
  return { untrusted: false, reason: '' };
}

module.exports = {
  isUntrustedRun,
  findUntrustedMarker,
  UNTRUSTED_MARKER_FILE,
  STRICT_DEFAULTS,
  parseGovernanceBlock,
  resolveGovernance,
  resolveGovernanceFromYaml,
  OPERATIONAL_ACTIONS,
  resolveForcePushMode,
  describeForcePushPolicy,
  describeForcePushPolicyFromYaml,
  resolveOperational,
  resolveProtectedBranches,
  resolveMergeAuthors,
  resolveMergeAuthorsFromYaml,
  resolveGovernanceExtrasFromYaml,
  renderOperationalRules,
  renderSessionStartHardRules,
  renderSubagentHardRules,
};
