---
id: AISDLC-1297
title: "Failed verdict is retired only when the task's own code landed"
status: Done
assignee: []
created_date: '2026-11-17'
labels:
  - dispatch
  - bug
dependencies: []
references:
  - pipeline-cli/src/dispatch/retire-landed.ts
  - pipeline-cli/src/dispatch/retire-failed-landed.test.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/filing-branches.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
dispatchableReason: 'Bug with a recorded reproduction on this board: four failed verdicts (AISDLC-506, AISDLC-1262, AISDLC-1285, AISDLC-1286) were moved to `retired/` about 20 seconds after they were written, with the reason "task landed <sha>" where the sha is the merge commit of the pull request that FILED the task, not of its code. The board then showed no failure and nothing rerouted the task; on 2026-11-17 the board stalled for hours until the planner requeued both tasks by hand. No design choice is open: a filing pull request never lands a task.'
---

## Description

**Gap.** The tick step `retireFailedLanded` (`pipeline-cli/src/dispatch/retire-landed.ts`) moves a verdict from `failed/` to `retired/` when the task "landed". It reads two signals: the task file under `backlog/completed/` on `origin/main`, and any landing record with `landed` set and `kind` `task` or absent. The second signal is wrong in two ways:

1. Landing records of filing pull requests carry `kind: "task"` and the task id although their head branch is `ai-sdlc/file-<id>`. Evidence on this board: `.ai-sdlc/dispatch/landing/2693.json` (head branch `ai-sdlc/file-aisdlc-1285`), `2695.json`, `2737.json`. `detectKind` in `reconcile.ts` returns `docs` for that branch when it is given the head branch, so at least one path that writes a landing record classifies without it.
2. `retireFailedLanded` does not compare the pull request of the landing record with `prNumber` of the verdict. The sibling `retireFailedVerdict` in the same file has that guard (AISDLC-1177); the tick step does not.

Recorded case: the executor of AISDLC-1285 wrote a failed verdict (`cause: push-failed`, `prNumber: 2706`) at 2026-11-16T21:01:21Z; `board-events.jsonl` shows `retire-failed-landed` for it at 21:01:42Z with reason `task landed c26b8241...`, the merge commit of filing pull request #2693. Pull request #2706 was still open.

**Shape.** A failed verdict leaves `failed/` through this step only when the task's own code is on `main`. A merged filing or docs pull request never retires a verdict, whatever kind its landing record carries.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: is the landing-record signal needed at all, given `backlog/completed/` on `origin/main`? Keep it only for a task pull request that merged before the completed-file read catches up; if the developer finds no such window in the tick order, deleting the signal is the preferred fix and satisfies every criterion below. 2. Deleted: the unguarded "any landed task record" rule. 3. Simplified or optimised: one shared predicate decides "this landing record is the task's code pull request", used by `retireFailedVerdict`, `retireBlockedManifest` and `retireFailedLanded`. 4. Accelerated: not applicable. 5. Automated: tests replay the recorded case.

- **Guard in the tick step.** `retireFailedLanded` accepts a landing record for a task only when all hold: `kind` is `task`; its head branch, when recorded, is not a filing branch (`isFilingBranch`); and when the verdict carries a numeric `prNumber`, the record's `pr` equals it. A verdict without `prNumber` is retired by a landing record only when that record has a head branch and it is not a filing branch; otherwise only the `backlog/completed/` signal retires it.
- **Classification at the source.** Find the path that wrote `kind: "task"` for a head branch starting with `ai-sdlc/file-` and make it pass the head branch into `detectKind`, so new landing records of filing pull requests read `docs`. Landing records store `headBranch` when it is known. State the path found in the PR body.
- **Existing records.** Do not rewrite landing records on disk. The guard must be correct against the existing records that have `kind: "task"` and no head branch: for those, the `prNumber` comparison or the completed-file signal decides.
- **Docs.** The paragraph of `docs/operations/cli-hierarchy.md` that describes retiring a failed verdict states the rule in one or two sentences.

Out of scope: moving the four wrongly retired verdicts back; the load-sensitive `claim-wait.test.ts`; any change to how a failed verdict is routed.

## Acceptance Criteria

- [ ] #1 A test places a failed verdict with `prNumber: 2706` in `failed/` and a landing record `{ pr: 2693, kind: 'task', taskId, landed }` with no head branch; `retireFailedLanded` retires nothing and the verdict stays in `failed/`.
- [ ] #2 A test with the same verdict and a landed record `{ pr: 2706, kind: 'task' }` retires it, and a test where the task id is in the `completedOnMain` map retires it with no landing record at all.
- [ ] #3 A test with a verdict that has no `prNumber` and a landed record whose head branch is `ai-sdlc/file-aisdlc-1285` retires nothing.
- [ ] #4 A reconciler test shows that a merged pull request with head branch `ai-sdlc/file-aisdlc-1285` and a title naming the task id produces a landing record whose `kind` is `docs`, and that the record stores the head branch.
- [ ] #5 `retireFailedVerdict`, `retireBlockedManifest` and `retireFailedLanded` call one shared predicate for "the task's own code pull request"; the existing tests of the first two pass unchanged.
- [ ] #6 `docs/operations/cli-hierarchy.md` states when a failed verdict is retired.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
