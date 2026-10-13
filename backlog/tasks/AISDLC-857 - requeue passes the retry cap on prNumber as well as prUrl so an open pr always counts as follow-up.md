---
id: AISDLC-857
title: >-
  requeue passes the retry cap on prNumber as well as prUrl so an open PR always counts as follow-up
status: To Do
assignee: []
created_date: '2026-10-13'
labels:
  - dispatch
  - reliability
dependencies: []
references:
  - pipeline-cli/src/dispatch/requeue.ts
  - pipeline-cli/src/dispatch/complete.ts
  - pipeline-cli/src/cli/dispatch.ts
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

AISDLC-847 made `cli-dispatch requeue` pass the retry cap when the failed task has an open PR. The reader in `pipeline-cli/src/dispatch/requeue.ts` accepts only `verdict.prUrl`; executors that fail before Step 11 record `prNumber` (the `complete --pr <number>` path in `pipeline-cli/src/dispatch/complete.ts`) and no `prUrl`. On 2026-10-13 AISDLC-840 (#1469) and AISDLC-837 (#1466) both had an open PR, both verdicts carried `prNumber`, and both requeues were refused at the cap, which cost two dispatch escalations and the standing workaround DEC-0187 (re-enqueue through `remove-verdict` + `write-manifest`).

**Five-step review (requirements first).** Requirement questioned: "the follow-up check needs a URL". It does not: the repo is known, so a PR number identifies the PR as well as a URL does, and `gh pr view <number>` accepts it. Deletion: nothing to delete. Simplified: one helper in `requeue.ts` derives the PR reference from `prUrl`, else from `prNumber`, and the `OPEN` check runs on whichever exists; `complete` keeps writing `prNumber` only (no second field to keep in sync). Accelerated: a cap refusal on a task with an open PR cannot happen again, so no escalation and no manual re-enqueue. Automated: a requeue test with a verdict that has `prNumber` and no `prUrl`, retryCount at the cap and an `OPEN` PR state stub asserts the requeue is accepted as follow-up; a sibling test with no PR at all asserts the cap still refuses.

## Fix

1. `pipeline-cli/src/dispatch/requeue.ts`: read `prUrl ?? prNumber` into one PR reference (string or number); pass it to the `prState` reader; `ghPrState` calls `gh pr view <ref> --json state`.
2. Tests as named above in `requeue.test.ts`.
3. `docs/operations/decision-authority.md`: note that DEC-0187's manual re-enqueue is superseded once this lands.

## Acceptance Criteria

- [ ] #1 A failed verdict with `prNumber` only, retryCount at the cap and PR state `OPEN` is requeued as follow-up without consuming a retry (test).
- [ ] #2 A failed verdict with neither `prUrl` nor `prNumber` at the cap is still refused (test).
- [ ] #3 A failed verdict with `prUrl` behaves exactly as before (existing test unchanged).
- [ ] #4 `docs/operations/decision-authority.md` records that DEC-0187 is superseded by this task.

**Velocity impact.** Positive: removes a recurring park-and-escalate loop (two tasks on 2026-10-13).

Authority: class (a) under `docs/operations/decision-authority.md` (reversible, non-weakening, narrow blast radius). Standing manual workaround until it lands: DEC-0187.
<!-- SECTION:DESCRIPTION:END -->
