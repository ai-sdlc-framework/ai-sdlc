---
id: AISDLC-663
title: >-
  RFC-0051 OQ-2: allowForcePush leaseOnOwnBranch, own-branch enforcement, governance.operational list and render
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0051
  - governance
  - hooks
  - plugin
  - security
dependencies: []
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - spec/schemas/agent-role.schema.json
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/session-start.js
  - ai-sdlc-plugin/hooks/subagent-start.js
  - .ai-sdlc/agent-role.yaml
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-09-30 an executor session could not rebase a conflicting PR: its governance
resolved to "never force-push" (`allowForcePush` unset), and the operator's
confirmation typed in another session could not reach it, because a peer message is
not a permission grant. The repo's git flow already prescribes
`git push --force-with-lease` after rebasing a feature branch. This task makes that
routine action policy, scoped to the branch a worktree owns. RFC-0051 section 10 and
the OQ-2 resolution. This touches trust-chain rules; every floor below has its own
acceptance criterion.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest for packages; `node --test`
  for plugin hooks and scripts; 80% line coverage on new code.
- Tests never start a real Claude Code session, never call tmux against the user's
  real server (inject the command runner), and never read the real home directory.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Scope
1. **Schema** (`spec/schemas/agent-role.schema.json`): `spec.governance.allowForcePush`
   accepts the enum `never` | `leaseOnOwnBranch` in addition to the existing boolean;
   `true` is read as `leaseOnOwnBranch`, `false` as `never`. Default stays `never`.
   New `spec.governance.operational`: a list of strings from a closed set
   (`rebase-own-branch`, `lease-push-own-branch`, `retrigger-ci`, `requeue`,
   `file-subid-followups`, `answer-operational-decisions`, `clear-executor-context`)
   granted to the dispatch role. Regenerate any generated schema output.
2. **Resolver** (`ai-sdlc-plugin/hooks/lib/governance-resolver.js`): resolve the enum
   and the list with strict defaults; malformed values fail closed to `never` and an
   empty list. The policy is read from the trusted base branch or operator
   filesystem as today, never from a PR tree.
3. **Enforcement** (`ai-sdlc-plugin/hooks/enforce-blocked-actions.js`): with
   `leaseOnOwnBranch`, allow a `git push` that carries `--force-with-lease` when the
   target ref is the current worktree's own branch and that branch is not `main`,
   `master` or any branch listed as protected in the policy. Block `--force` without
   lease, any lease push to another branch, and any force push to a protected branch,
   regardless of the setting. The permanently fixed integrity rules from RFC-0048 are
   untouched.
4. **Render**: `session-start.js` and `subagent-start.js` render the force-push rule
   from the resolved value ("force-with-lease permitted on this worktree's own branch
   only; never on main") and render the `operational` list for sessions whose roster
   role is `operator-dispatch` (the roster is defined in AISDLC-664; until it exists,
   render the list when the env var `AI_SDLC_HIERARCHY_ROLE` is `operator-dispatch`).
5. **This repository:** set `allowForcePush: leaseOnOwnBranch` and the full
   `operational` list in `.ai-sdlc/agent-role.yaml`.
6. **Docs:** update the governance section of the relevant operator runbook to
   describe the enum, the own-branch rule and the operational list.

## Acceptance Criteria
- [x] The schema accepts `never`, `leaseOnOwnBranch`, `true` and `false` for `allowForcePush` and rejects any other value; `pnpm validate-schemas` passes.
- [x] With `leaseOnOwnBranch`, `git push --force-with-lease origin <own-branch>` is allowed in a worktree checked out on that branch.
- [x] With `leaseOnOwnBranch`, a lease push to a branch other than the worktree's own is blocked.
- [x] With `leaseOnOwnBranch`, a lease push to `main`, `master` or a protected branch is blocked, and plain `--force` is blocked everywhere.
- [x] With `never`, unset, or a malformed value, every force push is blocked exactly as before this change (existing tests pass unchanged).
- [x] The policy is resolved from the base branch; a worktree copy of `agent-role.yaml` setting `leaseOnOwnBranch` has no effect.
- [x] The injected rule text reflects the resolved value in both hooks, and the `operational` list is rendered only for the dispatch role.
- [x] CI-skip tokens, attestation and verdict edits, and governance relaxation from a PR tree remain blocked under every setting (regression tests).
- [ ] This repository's `.ai-sdlc/agent-role.yaml` carries the new values and resolves without warnings.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
`allowForcePush` now accepts `never` or `leaseOnOwnBranch` (`true` reads as the lease mode, `false` as never), with a closed `operational` list for the dispatch role. The PreToolUse hook allows exactly one allow-listed shape, `git push --force-with-lease origin HEAD:refs/heads/<own>`, from a genuine task worktree bound to its task branch, and denies every other force push, including under `never`. Banners render the resolved rule from the same trusted policy the hook enforces.

## Changes
- `spec/schemas/agent-role.schema.json`, Go SDK copy, `reference/src/core/generated-schemas.ts`: enum + `operational` + `protectedBranches`
- `ai-sdlc-plugin/hooks/lib/{governance-resolver,lease-push-guard,trusted-policy}.js` and `enforce-blocked-actions.js`, `session-start.js`, `subagent-start.js`
- `ai-sdlc-plugin/commands/{rebase,execute}.md`, `agents/{rebase-resolver,ci-conflict-resolver,developer}.md`, `skills/ai-sdlc-governance/SKILL.md`: one accepted push spelling
- `docs/api-reference/governance.md`, node test files wired into the governance gate

## Design decisions
- **Own branch** means the task branch: the sentinel id, the worktree directory name and the `ai-sdlc/<id>-` branch prefix must agree, and the worktree must be a genuine one under the main checkout's `.worktrees/`.
- **Destination** must be exactly `refs/heads/<own>`, because git resolves other spellings against remote tags and refs.
- **Policy** is read only from the trusted main checkout; a worktree copy can only tighten the lease grant.
- **AC 9** is an operator step: the YAML is in the PR body and is committed by the operator after merge.

## Verification
- `pnpm build`, lint, `format:check`, `dark-code:check`, validate-schemas, reference suite and the governance gate (483 tests) pass
- AC 10 (root `pnpm test`): not fully green locally; the known environmental pipeline-cli failures (verify-runtime, bin-invocation pnpm-exec probes) are the only failures; CI to confirm
- 3 parallel reviews approved after 4 rounds (security found and the rounds closed two protected-branch bypass variants)

## Follow-up
- declined: hook-level block on writes to `.active-task`; the worktree-authenticity checks bound the exposure and a separate task can add it if wanted
- declined: parse `bash -c` and `sh -c` payloads and config-injected `+` refspecs and aliases under `never`; pre-existing gaps, documented as residual
- declined: wire `scripts/check-skip-ci-marker.sh` into a hook or workflow; pre-existing gap, out of scope for this change
- declined: make `rebase.md` Step 2 guard against resetting an orphaned local branch with unpushed commits, and align `docs/operations/auto-rebase-stale-prs.md` and a script hint with the canonical push spelling; minor review notes
- declined: add schema negative tests for malformed or duplicate `protectedBranches`; minor suggestion
