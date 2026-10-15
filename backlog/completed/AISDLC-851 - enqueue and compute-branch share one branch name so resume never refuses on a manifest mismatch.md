---
id: AISDLC-851
title: >-
  enqueue and compute-branch share one branch name so resume never refuses on a manifest mismatch
status: Done
assignee: []
created_date: '2026-10-13'
labels:
  - dispatch
  - reliability
dependencies: []
references:
  - pipeline-cli/src/dispatch/enqueue.ts
  - pipeline-cli/src/steps/02-compute-branch.ts
  - pipeline-cli/src/hierarchy/playbook.ts
  - pipeline-cli/src/cli/dispatch.ts
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`cli-dispatch enqueue` writes the manifest branch as `ai-sdlc/<lower task id>` (`pipeline-cli/src/dispatch/enqueue.ts`, the `branch:` field), while Step 2 of the execute pipeline (`pipeline-cli/src/steps/02-compute-branch.ts`) checks out `ai-sdlc/<lower task id>-<title slug>` and opens the PR on that long name. The resume path (`pipeline-cli/src/hierarchy/playbook.ts`, "the recorded branch differs from the one checked out in the worktree") then refuses every resume of a task that was enqueued with the short name. On 2026-10-13 this parked AISDLC-840 (PR #1469) and AISDLC-846 (PR #1477) and cost two dispatch escalations and the standing decision DEC-0183 (dispatch corrects the manifest to the PR head with `write-manifest`). Two writers of the same fact drift; the fix removes one.

**Five-step review (requirements first).** Requirement questioned: "the manifest must carry the branch name at enqueue time". It does not: nothing before claim reads it, and the name is fully derived from the task id and title. Deletion: `enqueue` stops inventing a branch name; the manifest `branch` is written by the same function Step 2 uses (export the slug builder from `02-compute-branch.ts` and call it from `enqueue.ts`), so there is one source of the name. Simplified: the resume check in `playbook.ts` compares against that one function's output, and when a worktree is checked out on a branch that an open PR head already uses, it accepts that branch and rewrites the manifest instead of refusing (the PR head is the ground truth, per DEC-0182/DEC-0183). Accelerated: no resume ever parks on this shape again, no dispatch escalation, no planner ruling. Automated: a test that enqueues a task and runs Step 2 on it asserts the two names are equal; a second test resumes a manifest with a stale short name against a worktree on the long name and asserts the manifest is corrected rather than refused.

## Fix

1. `pipeline-cli/src/steps/02-compute-branch.ts`: export the pure branch-name function (task id + title → `ai-sdlc/<id>-<slug>`), no behaviour change.
2. `pipeline-cli/src/dispatch/enqueue.ts`: replace the inline `ai-sdlc/${lower}` with that function (the title is in the task file the enqueue already reads).
3. `pipeline-cli/src/hierarchy/playbook.ts`: on a branch mismatch, when the worktree's checked-out branch exists on `origin` (or an open PR's head names it), rewrite the manifest `branch` to it and continue, logging the correction; refuse only when neither side can be verified.
4. Tests as named in the Five-step paragraph (`02-compute-branch.test.ts`, a new enqueue test, a playbook resume test).
5. Note in `docs/operations/decision-authority.md` under the dispatch operational list that DEC-0183's manual `write-manifest` correction is superseded once this lands.

## Acceptance Criteria

- [x] #1 Enqueuing a task and running Step 2 on it yields the same branch name (test in `02-compute-branch.test.ts` or a new enqueue test).
- [x] #2 A resume whose manifest carries the pre-fix short name against a worktree on the long name succeeds and leaves the manifest `branch` rewritten to the long name (playbook test).
- [x] #3 A resume where neither the manifest branch nor the worktree branch exists on origin still refuses (playbook test).
- [x] #4 No new field, flag or CLI subcommand is added.
- [x] #5 `docs/operations/decision-authority.md` notes that DEC-0183 is superseded by this task.

**Velocity impact.** Positive: removes a recurring park-and-escalate loop (two tasks on 2026-10-13 alone).

Authority: class (a) under `docs/operations/decision-authority.md` (reversible, non-weakening, narrow blast radius). Standing manual workaround until it lands: DEC-0183.
<!-- SECTION:DESCRIPTION:END -->
