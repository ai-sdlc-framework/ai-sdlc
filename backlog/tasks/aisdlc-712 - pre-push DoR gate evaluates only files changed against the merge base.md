---
id: AISDLC-712
title: >-
  The pre-push readiness gate and the local backlog-drift checks are deleted, not repaired
status: To Do
assignee: []
created_date: '2026-10-04'
labels:
  - ci
  - bug
  - governance
dependencies: []
references:
  - scripts/check-dor-gate.sh
priority: high
dispatchable: true
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
