---
id: AISDLC-1453
title: "Reconciler land-prep and resume re-entry is refused by the caller check when the host runs it"
status: To Do
priority: high
labels:
  - dispatch
  - reconciler
  - adopter-facing
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/dispatch-caller.ts
  - pipeline-cli/src/hierarchy/caller-identity.ts
---

## Description

**Five-step review (requirements first).**
1. Question: the requirement stands. A PR that turns conflicted after a sibling lands must be re-entered automatically. The `behind-or-dirty` state maps to `land-prep` (`reconcile.ts:45`). Today that action can never succeed when the host runs it.
   - Checked in this repo: PR #3097 at head ec0e950b, 2026-11-27, when sibling PR 3098 had just landed. `.ai-sdlc/dispatch/log/reconcile.log` shows `land-prep@ec0e950b… failed x2, no more retries`, with the refusal "reenter: the calling session is not a running session in the roster; run it from the dispatch session in the main checkout, or ask the dispatch session to run it".
   - Reported by ai-sdlc-enterprise on 0.46.0 (not checked here): PR #38 (ENT-19, head 13f85c41), 2026-11-27T04:30:34Z to 04:30:38Z, when sibling PR 37 had just landed. Same refusal, failed twice, routed to the planner.
   - Checked:
     - `actionCommands` maps `land-prep` and `review-resume` to `cli-dispatch reenter <pr>`, run as a child process (`reconcile.ts:493`, `507-509`). `push-only-reenter` and the developer-round re-entry spawn the same command.
     - `checkDispatchCaller` skips the "caller is the dispatch session" check only when `skipCallerIdentity` is set. That flag is set for the scheduler-driven tick (AISDLC-1096, `dispatch-caller.ts:97`, `164`).
     - The spawned `reenter` runs the full `requireDispatchCaller` (`caller-identity.ts:127-140`). It walks the parent processes looking for a claude process that matches a roster session, finds none from the host, and refuses.
2. Delete: no retry. The refusal is deterministic, and the two retries only delay the route to the planner.
3. Simplify: the re-entry the reconciler starts carries the same trust the tick already has. Either the reconciler calls the re-entry in-process with the location checks it already passed, or the child is told it runs under that tick. It must not become a flag, environment variable or file that any other caller can set to skip the identity check. The location checks (main checkout, trusted board, install location) still run.
4. Accelerate: a PR that is simply conflicted or behind is rebased on the next tick, with no planner round.
5. Automate: a regression test drives the real host path from tick to land-prep to reenter, not a stubbed `execute`.

## Acceptance Criteria
- [ ] #1 A reconcile pass the host runs, whether that is the scheduler tick or the dispatch hooks module, executes `land-prep`, `review-resume`, `push-only-reenter` and the developer-round re-entry without the "not a running session in the roster" refusal. Test: a `behind-or-dirty` PR, a pass run with the host's identity inputs (no claude ancestor), and re-entry runs, with no refusal and no `actionFailed`.
- [ ] #2 A manual `cli-dispatch reenter` from a process that is neither the dispatch session nor the reconciler's own call is still refused, with today's message. The test shows no caller can reach the bypass by setting a flag, an environment variable or a file.
- [ ] #3 The location checks (main checkout, trusted board, install location) still apply to the reconciler-started re-entry. Test: a re-entry started from a board outside the main checkout is refused.
- [ ] #4 Replay of #3097: the landing record goes from `behind-or-dirty` to `land-prep` and the re-entry runs, with no route to the planner.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Notes
- Source: ai-sdlc-enterprise planner, 2026-11-27 (defect 1 of 2). The same failure hit #3097 in this repo; the planner fixed it with a manual rebase-resolver run.
- Related: AISDLC-1454 (after this route, nobody can push under `leaseOnOwnBranch`).
