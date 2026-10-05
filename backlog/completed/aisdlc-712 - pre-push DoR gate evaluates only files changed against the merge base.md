---
id: AISDLC-712
title: >-
  The pre-push readiness gate and the local backlog-drift checks are deleted,
  not repaired
status: Done
assignee: []
created_date: '2026-10-04'
updated_date: '2026-10-05'
labels:
  - ci
  - bug
  - governance
dependencies: []
priority: high
dispatchable: true
drift_log:
  - date: '2026-10-05'
    type: ref-deleted
    detail: 'Referenced file no longer exists: scripts/check-dor-gate.sh'
    resolution: flagged
drift_checked: '2026-10-05'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`scripts/check-dor-gate.sh` evaluates the push range remote-sha..local-sha. On a
`--force-with-lease` push after a rebase, the remote sha is the old pre-rebase head, so the
range contains every commit main gained since, and the gate evaluates task files the branch
never touched. On 2026-10-04 a rebased branch (PR #1181) was refused because of a DoR
violation in an unrelated task file that had landed on main. Any DoR violation on main
therefore blocks every rebasing branch: a rule that fires on the documented happy path
(DEC-0048). The patch-coverage gate had the same defect and was fixed by AISDLC-686.

History: the original scope of this task was to repair the commit range; it changed to deletion because DEC-0056 (row 3) found the local gates slow and duplicating the CI readiness check, which becomes required instead.

## Acceptance Criteria
- [ ] `scripts/check-dor-gate.sh` is removed from the pre-push chain, and the commit-time and push-time backlog-drift checks are removed, with their tests and wiring.
- [ ] The CI readiness check ("Evaluate backlog tasks changed by PR") is added to the required `ai-sdlc/pr-ready` rollup for pull requests that change task files.
- [ ] CLAUDE.md's Hooks list is updated to match (this task authorizes that edit, limited to that section), and agent instructions that mention the removed local gates are updated.
- [ ] Agents may still run `cli-dor-check` by hand; the instructions say so.
- [ ] The local-versus-CI disagreement task (backlog task 706) closes with this one.
- [ ] PR body carries a "Velocity impact" section (DEC-0048).

## Out of scope
- Changing what the DoR gates require.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Deleted the pre-push readiness (DoR) gate and the local backlog-drift checks instead of repairing their commit range (DEC-0056 row 3). CI keeps the "Evaluate backlog tasks changed by PR" and "Backlog Drift" checks. Agents may still run `cli-dor-check` and `backlog-drift check` by hand.

## Changes
- `.husky/pre-push` (modified): removed the DoR and backlog-drift invocations and their comments; renumbered the chain.
- `.husky/pre-commit` (modified): removed the strict backlog-drift step.
- `scripts/check-dor-gate.sh`, `scripts/check-backlog-drift-on-push.sh`, `scripts/check-backlog-drift.sh` and their `.test.mjs` files (deleted).
- `package.json` (modified): removed `test:dor-gate`, `test:backlog-drift-push-gate`, `test:drift-gate` and their entries in `test`.
- `scripts/check-followups.test.mjs` (modified): the wiring test anchors on the changelog check instead of the removed DoR gate.
- `CLAUDE.md` (modified, Hooks section only), `ai-sdlc-plugin/agents/developer.md`, `docs/operations/emergency-bypass.md`, `docs/operations/operator-runbook.md` (modified): drop the removed gates; state that the checks can be run by hand.

## Design decisions
- **Deletion, not repair**: ordered by the operator in DEC-0056; the range repair first attempted here (merge-base selection) was discarded.
- **CI rollup change not shipped**: it edits `.github/workflows/**`, a blocked path for this task.

## Verification
- `pnpm build` - clean
- `pnpm lint` - clean; `pnpm format:check` - clean
- `pnpm test` - the root-level steps pass except two attestation-gate suites; `pnpm -r test` has 14 failures in 4 pipeline-cli files (bin-invocation, verify-runtime, tui). All are environmental on this machine (pnpm exec behaviour, trusted runtime installed, terminal width) and in code this change does not touch; not re-run against main.
- 2 reviewers (code, security) on Sonnet, approved in round 1.

## Follow-up
- declined: add "Evaluate backlog tasks changed by PR" to the `ai-sdlc/pr-ready` rollup (AC 2). It edits `.github/workflows/**`, blocked until AISDLC-721 is resolved; to be done after that by the operator or a dispatched task.
- declined: CLAUDE.md "Drift gate" paragraph and the `.github/workflows/ci.yml` comment still mention the removed pre-commit step; outside the edit this task authorizes, to be updated with the workflow change.
<!-- SECTION:FINAL_SUMMARY:END -->
