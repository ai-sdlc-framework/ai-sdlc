---
id: AISDLC-1450
title: "Dependency preflight reads a just-merged dependency as done"
status: In Progress
priority: high
labels:
  - dispatch
  - dependencies
  - race
  - adopter-facing
dependencies: []
references:
  - pipeline-cli/src/next-step/init.ts
  - pipeline-cli/src/deps/dependency-graph.ts
  - pipeline-cli/src/dispatch/retire-landed.ts
---

## Description

**Five-step review (requirements first).**
1. Question: the requirement stands. A dependent must not start before its dependency has landed. But the preflight must read "landed" from the same source the board uses, not from a checkout that lags behind it. ai-sdlc-enterprise hit this twice:
   - **Case 1**, pipeline-cli 0.44.0, 2026-11-25. ENT-13 (after ENT-12) was dispatched at 18:46:44.784Z. ENT-12's PR #18 merged at 18:48:26Z, and `done/ENT-12.verdict.json` got its landed field at 18:48:27.255Z. ENT-13's preflight refused at 18:48:39.199Z. The board's mark-landed came at 18:48:39.827Z.
   - **Case 2**, pipeline-cli 0.45.0, 2026-11-26. ENT-16 (after ENT-15). PR #26 merged at 16:24:20Z, the landed field was written at 16:24:21.826Z, the preflight refused at 16:24:33.508Z, and mark-landed came at 16:24:33.519Z.

   The refusal from `pipeline next-step`: action `stop`, outcome `aborted`, reason `dependency preflight failed for ENT-13: { "ok": false, "reason": "1 dependency(ies) not yet Done: ENT-12", "blockers": [ { "id": "ENT-12", ..., "status": "open" } ], "dangling": [] }`. No escalation file was written for either refusal.

   Checked:
   - Step 1.5 runs `cli-deps preflight <id> --work-dir <workDir>` (`next-step/init.ts:122-134`). It builds the graph from the backlog files in that checkout (`deps/dependency-graph.ts:809-818`), so a dependency whose completed file is on `origin/main` but not yet in the checkout reads as open.
   - AISDLC-1428 already added `completedTaskIdsOnMain` and `fetchedCompletedOnMain` (`dispatch/retire-landed.ts:311`), which read `backlog/completed/` on `origin/main` after a fetch.
2. Delete: no retry loop with sleeps. A blind wait hides the real inconsistency.
3. Simplify: when the local graph reports open blockers, the preflight treats a blocker as done if its id is in `fetchedCompletedOnMain(workDir)`. The function from AISDLC-1428 is reused, not copied. The local read stays first, so the fetch runs only when a blocker is found.
4. Accelerate: a dependent dispatched just before its dependency lands starts on the first claim after the merge.
5. Automate: a refusal that still stands after the `origin/main` read is a real block. It is written as an escalation, not dropped silently.

## Acceptance Criteria
- [ ] #1 `cli-deps preflight` treats a blocker as done when it is open in the local checkout but completed on `origin/main` after a fetch. Fail closed: when `origin/main` cannot be read, the local result stands. Tests cover:
  - a blocker completed on `origin/main` only (passes);
  - a blocker open on both (refused);
  - a failed fetch (refused, as today);
  - no blockers (the fetch is not run).
- [ ] #2 The completed-on-main read comes from `retire-landed.ts`'s `fetchedCompletedOnMain` / `completedTaskIdsOnMain`, not a second implementation.
- [ ] #3 When the dependency preflight still refuses after the origin/main read in AC 1, the executor's stop writes one escalation file (the same writer and de-dup window as AISDLC-1382) naming the task, its blockers and the refusal reason. The task returns to the queue, not to `failed/`. Test: a refused preflight produces exactly one escalation and a queued manifest.
- [ ] #4 A replay test of case 1 passes: the dependent dispatched, the dependency merged and its completed file on `origin/main`, mark-landed not yet recorded on the board. The preflight passes.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Notes
- Source: ai-sdlc-enterprise planner, O2 in the 2026-11-26 consolidated request (facts sent 2026-11-27). Filing id AISDLC-1429 was reserved for this and never used.
