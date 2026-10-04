---
id: AISDLC-712
title: >-
  Pre-push DoR gate evaluates only files changed against the merge base
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

## Acceptance Criteria
- [ ] The gate evaluates only task files changed between the merge base with origin/main and the local head (three-dot diff), for normal pushes and for lease pushes after a rebase.
- [ ] A regression test reproduces the failure: branch from main, add a violating task file on "main" in the fixture, rebase the branch, simulate the pre-push input with the old remote sha, and assert the gate passes because the branch did not change that file.
- [ ] The same range logic is checked in the other pre-push gates that take the push range (list them in the PR with their verdict: correct, fixed here, or follow-up filed), since the defect class is shared.
- [ ] The refusal message, when the gate does fail on the branch's own file, names the file, the failed gate, and what to add, so an agent can fix it without help.
- [ ] Local gate and the CI check "Evaluate backlog tasks changed by PR" use the same file selection and agree for the same commit.
- [ ] Tests use temp repos from mkdtemp.
- [ ] PR body carries a "Velocity impact" section (DEC-0048).

## Out of scope
- Changing what the DoR gates require.
<!-- SECTION:DESCRIPTION:END -->
