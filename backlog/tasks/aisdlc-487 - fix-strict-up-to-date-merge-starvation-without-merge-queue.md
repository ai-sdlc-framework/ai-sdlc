---
id: AISDLC-487
title: >-
  fix: strict up-to-date branch protection causes merge starvation for
  slow-CI PRs when main is active (no-queue race)
status: To Do
assignee: []
created_date: '2026-05-31 00:00'
labels:
  - bug
  - ci
  - merge
  - branch-protection
  - dispatch
dependencies: []
references: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

## Context

On 2026-05-31, PR #789 (AISDLC-474) had all required checks green (Backlog Drift, ai-sdlc/pr-ready, attestation) but kept showing `mergeStateStatus=BLOCKED` because branch protection on `main` is configured `strict: true` (require branches up-to-date before merging) while there is NO merge queue (the queue was dropped in AISDLC-400). With several PRs merging in parallel, main advanced under #789 faster than its ~5-6 minute CI matrix could complete, so each time #789 finished CI it was already 1 commit behind and had to be rebased and re-signed again. It took multiple rebase/re-sign cycles before it landed during a brief lull. This is a starvation race: strict-up-to-date + slow per-PR CI + an active main with no serialization means a PR can be perpetually one-behind.

## Impact

Slow-CI PRs (especially code PRs needing the full build/test/coverage matrix + attestation) can stall indefinitely when main is busy, each rebase invalidating up-to-date-ness again. For autonomous/parallel dispatch this is acute: multiple sessions landing PRs concurrently is exactly the condition that triggers the race. Wastes CI minutes (re-runs the full matrix every rebase) and demands repeated operator/agent intervention to push through.

## Proposed Fix

Evaluate and choose (this is an architectural decision to route to the operator / Decision Catalog):

- **(a) Re-introduce a GitHub merge queue** so PRs serialize and auto-rebase without the up-to-date race.
- **(b) Relax `strict` to false on `main`** and rely on the post-merge `main-health-monitor` (AISDLC-406) to catch cross-PR skew reactively (the original AISDLC-400 trade-off — document the risk).
- **(c) Keep strict but add an auto-rebase-on-behind automation** that rebases and re-signs a PR the moment it falls behind, bounded to avoid infinite loops.

Capture the decision and rationale in the Decision Catalog.

## Acceptance Criteria

- [ ] #1 The branch-protection posture for `main` is decided (merge-queue vs strict=false vs auto-rebase automation) and documented with the trade-off rationale, routed through the operator/Decision Catalog since it is an architectural/security-posture choice.
- [ ] #2 The chosen mechanism is implemented so a slow-CI PR with all required checks green does not starve when main is active.
- [ ] #3 A runbook entry in docs/operations explains the merge model and how to land a PR caught in the race (e.g. admin-merge criteria) until/unless the automation handles it.
- [ ] #4 The fix composes with parallel dispatch (multiple concurrent execute-parallel PRs can all land without manual rebase chasing).

## Notes

Surfaced live by PR #789 during the 2026-05-31 execute-parallel test. Relates to AISDLC-400 (merge-queue drop) and AISDLC-406 (main-health-monitor).

<!-- SECTION:DESCRIPTION:END -->
