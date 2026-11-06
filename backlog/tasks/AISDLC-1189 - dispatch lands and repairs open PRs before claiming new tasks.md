---
id: AISDLC-1189
title: 'Dispatch lands and repairs open PRs before claiming new tasks'
status: To Do
assignee: []
created_date: '2026-11-04'
labels:
  - dispatch
  - hierarchy
  - fix
dependencies: []
references:
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/ephemeral-tick.ts
  - pipeline-cli/src/hierarchy/executor-cap.ts
  - pipeline-cli/src/hierarchy/land-eligible.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/dispatch/board.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

**Source.** Operator in the planner session, 2026-11-04: dispatch starts new tasks before it merges the open PRs, and each new PR adds conflict risk to the open ones. Decision: DEC-0373.

**Today.** `runDispatchTick` (`hierarchy/dispatch-loop.ts`) runs verdicts, then the executor steps, whose last step is `spawnForEligibleClaims`, and only at the end of the tick `landEligible`. Landing runs only on a fresh GitHub read (at most every 5 minutes, or after a webhook wake) and only merges or arms. Repairs come from `cli-dispatch reconcile --watch`, a separate process on a 60 s timer; a repair manifest sorts ahead of brief entries (`resumeDone` deletes `wave`), but only if it is queued before the spawn step runs. The executor cap (`hierarchy/executor-cap.ts`) is `min(executors.max, board ceiling, pacer allowance, load headroom)` and counts no open PRs. `docs/operations/cli-hierarchy.md` ("Claim order and reprioritize") says a resume manifest has no special rank, which the code contradicts.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the goal is fewer unmerged PRs in flight at once, so conflicts stay rare; throughput only matters as landed work. 2. Deleted: nothing. 3. Simplified: reuse the landing records for the open-PR count; no new store, no extra GitHub call. 4. Accelerated: landing and the reconcile pass move ahead of spawning in the same tick. 5. Automated: tests below.

1. **Land first.** In `runDispatchTick`, run mark-ready and `landEligible` before the executor steps, under the same conditions as today (fresh GitHub read, `land-eligible-prs` granted). A hold still blocks spawning only.
2. **Repairs first.** Before the spawn step, the tick runs one reconcile pass (the same function `reconcile --watch` calls) when GitHub was read this tick, so repair manifests are queued before new claims take the slots. The watch process stays; a single-flight lock keeps the two from running the same pass at once.
3. **Open-PR limit (DEC-0373).** `spawnForEligibleClaims` claims a new-task entry (no `fixesPr`, no `resume`) only while open task PRs plus in-flight new-task executors are below the limit. Open task PRs are landing records with `kind: task`, no `landed`, no `closedUnlanded`. The limit resolves from `AI_SDLC_MAX_OPEN_PRS`, else `<board>/config.json` `executors.maxOpenPrs`, else the resolved `executors.max`. Repair entries are never counted and never blocked. Each blocked claim prints one line naming the open PRs.
4. **Visibility.** `cli-hierarchy status` prints the open-PR count and the limit next to the executor cap line.
5. **Docs.** Fix "Claim order and reprioritize" to say repairs sort first (wave 0), and document the limit and the new tick order.

## Acceptance Criteria

- [ ] AC-1: In one tick, landing runs before any spawn. A tick test with injected deps asserts the call order.
- [ ] AC-2: With a repair needed and a free slot, the in-tick reconcile queues the repair and the same tick spawns it ahead of a queued brief task. Tested.
- [ ] AC-3: At the limit, a new-task entry is not claimed and the reason line names the open PRs; a repair entry is still claimed. Tested for both.
- [ ] AC-4: The limit resolves env, then config, then `executors.max`; invalid values fall back. Tested.
- [ ] AC-5: Records with `landed` or `closedUnlanded`, and non-task kinds (docs, decisions-sync, deps), do not count. Tested.
- [ ] AC-6: The in-tick reconcile and the watch process never run a pass concurrently. Tested with the lock.
- [ ] AC-7: `status` prints the open-PR count and limit; docs updated as in Fix step 5.
