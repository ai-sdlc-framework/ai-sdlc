---
id: AISDLC-1202
title: 'PR is not armed before its reviewers sign'
status: To Do
assignee: []
created_date: '2026-11-06'
labels:
  - pipeline-cli hierarchy defect triage
dependencies: []
references:
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/hierarchy/pr-state.ts
priority: medium
dispatchable: false
---

## Description

**Source.** Planner session 2026-11-06; filed on operator go (decision rubric, same day). Non-dispatchable until triaged.

The PR is opened and armed at 06-dev-done, before reviewers sign. The dispatch reconciler then sees failing checks on a live round and counts them as failures (seen on #2411, #2413, #2415), pushing tasks toward the two-failure limit for work still in progress.

**Affected surface.** `pipeline-cli/src/next-step/ship.ts` (opens and arms the PR at 06-dev-done) and `pipeline-cli/src/hierarchy/pr-state.ts` (reconciler failure counting).

## Acceptance Criteria
- [ ] #1 Either the PR opens as draft or unarmed until the verdict ref is pushed, or the reconciler ignores failures on a PR whose task has a live round.
- [ ] #2 A test asserts a live round's failing checks do not count toward the failure limit.
