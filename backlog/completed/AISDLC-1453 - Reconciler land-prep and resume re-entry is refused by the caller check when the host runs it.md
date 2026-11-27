---
id: AISDLC-1453
title: "Reconciler land-prep and resume re-entry is refused by the caller check when the host runs it"
status: Done
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
- [x] #1 A reconcile pass the host runs, whether that is the scheduler tick or the dispatch hooks module, executes `land-prep`, `review-resume`, `push-only-reenter` and the developer-round re-entry without the "not a running session in the roster" refusal. Test: a `behind-or-dirty` PR, a pass run with the host's identity inputs (no claude ancestor), and re-entry runs, with no refusal and no `actionFailed`.
- [x] #2 A manual `cli-dispatch reenter` from a process that is neither the dispatch session nor the reconciler's own call is still refused, with today's message. The test shows no caller can reach the bypass by setting a flag, an environment variable or a file.
- [x] #3 The location checks (main checkout, trusted board, install location) still apply to the reconciler-started re-entry. Test: a re-entry started from a board outside the main checkout is refused.
- [x] #4 Replay of #3097: the landing record goes from `behind-or-dirty` to `land-prep` and the re-entry runs, with no route to the planner.
- [x] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Notes
- Source: ai-sdlc-enterprise planner, 2026-11-27 (defect 1 of 2). The same failure hit #3097 in this repo; the planner fixed it with a manual rebase-resolver run.
- Related: AISDLC-1454 (after this route, nobody can push under `leaseOnOwnBranch`).

## Final Summary

## Summary

When the host runs a reconcile pass (the scheduler tick or the dispatch hooks module, both through `cli-dispatch reconcile`), the pass now runs re-entry in its own process instead of starting a child `cli-dispatch reenter` that always refused. This covers land-prep, review-resume, push-only and developer-round re-entry. A code-only argument tells the shared re-entry code which trust applies. A manual `cli-dispatch reenter` still gets the full caller check. The main-checkout, trusted-board and install-location checks and the requeue grant still apply to the reconciler's re-entry.

## Changes

- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1453/pipeline-cli/src/cli/dispatch.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1453/pipeline-cli/src/cli/dispatch-reconcile-reenter.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1453/backlog/tasks/AISDLC-1453 - Reconciler land-prep and resume re-entry is refused by the caller check when the host runs it.md

## Design decisions

How it works: the body of the `reenter` subcommand is now one function, `runReenter(argv, flags, boardDir, deps, startedBy)`, where `startedBy` is `'session' | 'reconciler'`. It is a TypeScript argument only and is never read from argv, an environment variable or a file. The value `'reconciler'` is passed only by `reconcilerRunner`. The reconcile case wraps its action executor's runner with `reconcilerRunner`, which handles only the exact argv that `actionCommands` builds (`node <cliBin>/cli-dispatch.mjs reenter ...`) and sends every other command to the base runner. Reconciler mode calls `checkDispatchCaller` with `skipCallerIdentity: true` (the same trust the scheduler tick already has) and never passes `identity`, so the location checks always run. Production keeps the full caller check for any `cli-dispatch reenter` started from a shell or session. For tests, the reconcile case now uses `deps.ghRun` for its gh and git reads, so the regression test drives the real `cli-dispatch reconcile` path, not a stubbed execute. Two behaviour notes: in-process re-entries record `reenteredBy: 'reconciler'`, and the default work directory of the shared code is now `deps.cwd ?? process.cwd()`, which is the same as before in production. Running `cli-dispatch reconcile` by hand can still re-enter PRs through this path, because that is the reconciler's own call; it still passes the location checks and the requeue grant. I also committed the orchestrator's `In Progress` status change on the task file so the rebase could run. The full `pnpm test` run exited 0, and patch coverage on `dispatch.ts` is 100%.

## Verification

- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (fatal: not a git repository (or any of the parent directories): .git)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)

- 2 reviews approved (harness: correctness-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up

(none)
