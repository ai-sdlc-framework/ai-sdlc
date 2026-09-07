---
id: AISDLC-602
title: >-
  Governance hard-rules: render resolved policy into execute/execute-parallel hard-rules + reconcile enforce-blocked-actions (fix gh-pr-merge drift)
status: To Do
assignee: []
created_date: '2026-09-07'
labels:
  - plugin
  - governance
  - agent-role
  - execute
  - adopter
dependencies:
  - AISDLC-601
  - AISDLC-603
references:
  - spec/rfcs/RFC-0048-per-repo-configurable-governance.md
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/execute-parallel.md
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Triage 2026-09-07 (local-trades adopter, plugin 0.19.0).** Second half of the
governance-configurability fix (Option 1). AISDLC-601 established the per-repo
governance source of truth in `agent-role.yaml` + the resolver + rendering into the
two hooks. This task makes the remaining governance surfaces agree with that same
resolved policy and fixes the narration/enforcement drift.

**Two surfaces still hard-code the rules:**
- `ai-sdlc-plugin/commands/execute.md` + `execute-parallel.md` — the "Hard rules
  (NEVER violate)" block (Never merge any PR / Never force-push / Never close / Never
  delete branches / Never `git reset --hard` / …) is literal prose in the command
  body.
- `enforce-blocked-actions.js` — enforces `blockedActions` patterns against Bash
  commands, but the injected prose asserts "NEVER merge PRs" while
  `blockedActions: git merge*` only matches a LOCAL `git merge`, NOT `gh pr merge`.
  So the rule the prose asserts most loudly isn't actually enforced by the hook.

## Scope
- Render the execute / execute-parallel "Hard rules" block FROM the resolved
  governance policy (AISDLC-601's resolver), so a repo that opts into
  `allowMerge: onGreenClean` (or removes the merge rule) gets a consistent hard-rule
  block, and a repo with no governance section is unchanged (strict).
- Reconcile `enforce-blocked-actions.js` so the merge rule is actually ENFORCED
  consistently with the narration: when the resolved policy forbids agent merge, the
  hook must block `gh pr merge` (and `gh pr merge --auto` vs. the arming case — note
  arming `--auto` is NOT merging and must stay allowed under strict, per current
  CLAUDE.md); when the policy permits merge-on-green, the hook allows it. Fix the
  existing `git merge*`-doesn't-cover-`gh pr merge` gap either way.
- **Route all merges through the AISDLC-603 `merge-if-eligible` helper (OQ-4
  resolution):** the hook blocks raw `gh pr merge`; the helper owns the
  green+CLEAN+trusted-`sourceKind` check. So the reconciled hook's job is (a) block
  raw `gh pr merge` under strict, and (b) permit ONLY the helper invocation when the
  policy allows merge — the green+CLEAN logic itself lives in 603, not here or in
  command-body prose. Arming `--auto` is NOT merging and stays allowed under strict.
- Keep defaults STRICT: with no governance section, execute's hard rules + the hook
  behave exactly as today (never-merge/never-force-push/never-close/etc.).
- Hermetic coverage: strict default (merge blocked incl. `gh pr merge`); opted-in
  merge-on-green (merge allowed only when green+CLEAN, blocked otherwise); arming
  `--auto` stays allowed under strict.

## Acceptance Criteria
- [ ] execute.md + execute-parallel.md hard-rule blocks render from the resolved
  governance policy; no governance section ⇒ current strict text unchanged.
- [ ] `enforce-blocked-actions.js` enforces the merge rule consistently with the
  narration — blocks `gh pr merge` under strict (closing the `git merge*` gap),
  allows it under an opted-in merge-on-green policy, and still allows arming
  `--auto`.
- [ ] Merge-on-green is gated on "all required checks green AND CLEAN" (the repo's
  real gates), documented and un-skippable.
- [ ] Defaults strict end-to-end across SessionStart banner (601), SubagentStart
  banner (601), execute hard-rules (this task), and the PreToolUse hook (this task).
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

## Notes
The frontmatter `dependencies` field is authoritative (shares AISDLC-601's resolver;
composes with AISDLC-603's helper). Together these fix the existing
inconsistency where the injected prose and `agent-role.yaml` can already disagree,
and give an adopter one per-repo policy source of truth rendered into every surface.
Trust boundary from 601 applies: policy honored only from trusted base-branch config.
