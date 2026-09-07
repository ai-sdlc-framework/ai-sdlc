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
references:
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
- **Preserve the green+CLEAN guardrail:** the merge-on-green policy must be
  expressible/enforced as "all required CI checks green AND mergeStateStatus CLEAN"
  (including the repo's real gates: verify-attestation, migration-mutation-gate,
  workflow-secret-scope-gate, ci), so opting into agent-merge removes only the
  "human must click" step, not any safety gate. Decide + document where the
  green+CLEAN check lives (command-body precondition vs. a helper) so it can't be
  skipped.
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
Depends on [[AISDLC-601]] (shares its resolver). Together these fix the existing
inconsistency where the injected prose and `agent-role.yaml` can already disagree,
and give an adopter one per-repo policy source of truth rendered into every surface.
Trust boundary from 601 applies: policy honored only from trusted base-branch config.
