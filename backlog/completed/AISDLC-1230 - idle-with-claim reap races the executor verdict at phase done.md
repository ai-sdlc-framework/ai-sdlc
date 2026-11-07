---
id: AISDLC-1230
title: idle-with-claim reap races the executor verdict at phase done
status: Done
priority: high
labels: [bug, pipeline-cli, dispatch]
dependencies: []
dispatchable: true
---

## Problem

AISDLC-515.1 / PR #2496, round 5, 2026-11-07: `next-step` finished the ship step (verdict ref for head b6167bea pushed 20:43Z) and returned `done` at 20:45:16.2Z; the dispatch tick reaped the claim at 20:45:16.4Z as `idle-with-claim` with "no verdict at step done", 250 ms later, before the executor's model turn could run `cli-dispatch complete` (Step 3 of `commands/executor.md`). The task landed in `failed/` with a diagnostic and no verdict, the reconciler's own `reenter` then failed twice, and a successful pipeline run was recorded as a failure. The same shape reaped AISDLC-1225 on 2026-11-07 00:29Z.

Cause: `workflow/execute-host.ts` writes `phase: 'done'` to the inflight state when `next-step` returns its final result; `hierarchy/stall.ts` (`reapStalledClaims`, AISDLC-1226) treats `phase === 'done' || 'aborted'` as terminal and reaps at once when no verdict exists, with no grace, while the verdict is written by a separate process (the executor session's next turn) that necessarily runs after the phase flips. Round 4 of the same task escaped only because its verdict landed before the next tick. With the tick now event-driven on state publication (DEC-0392), the race is the common case, not the exception.

## Fix

**Five-step review (requirements first).**
1. Question: the executor must not hold a claim forever after the pipeline ends (AISDLC-1218, DEC-0392); that stands. What does not stand is a liveness reap that fires inside the window the design itself needs to deliver the verdict.
2. Delete: the second writer. When `next-step` returns `done` (or aborts) it already knows the outcome, PR and notes; the host writes the board verdict itself in the same step that flips the phase (the `cli-dispatch complete` payload, same file, same guards), so phase `done` and the verdict become one event and the reap condition "terminal and no verdict" cannot be observed in between. The executor's Step 3 `complete` becomes a confirmation: it accepts an existing verdict with the same outcome as a no-op and refuses a conflicting one.
3. Simplify: if writing the verdict from the host is refused by the board guards (worker name, claim ownership), keep the executor as writer and instead give the terminal reap a grace window (`terminalGraceMs`, default 5 minutes, from the phase flip) so the reap only fires when the executor had the chance and did not report; name the chosen branch in the PR body.
4. Accelerate: the diagnostic names the gap it saw (`phase done at <ts>, reaped at <ts>, verdict expected from <worker>`), so the next race is read from the diagnostic.
5. Automate last: tests below.

## Acceptance Criteria

- [x] #1 Test: a claim whose inflight state flips to `phase: 'done'` carries a board verdict in the same write (or, on the fallback branch, is not reaped within `terminalGraceMs` of the flip and is reaped after it).
- [x] #2 Test: `cli-dispatch complete` after a host-written verdict with the same outcome exits 0 without a second file; with a different outcome it refuses and names both.
- [x] #3 Test: `reapStalledClaims` still reaps `phase: 'aborted'` with no verdict, and a non-terminal heartbeat older than the stall window, unchanged.
- [x] #4 The idle-with-claim diagnostic names the phase-flip time, the reap time and the expected worker.
- [x] #5 `commands/executor.md` Step 3 and `docs/operations/cli-hierarchy.md` state in one sentence who writes the verdict and what `complete` does afterwards.

## Notes

Evidence: `.ai-sdlc/dispatch/failed/AISDLC-515.1.diagnostic.json` (completedAt 20:45:16.456Z, heartbeatAgeMs 222, lastStep done), `.ai-sdlc/dispatch/sessions/aisdlc-515.1.session.json` (lastHeartbeat 20:45:16.206Z, status done), verdict ref commit 4fc22076 by ai-sdlc-step-11 at 20:43:13Z. Related: AISDLC-1227 (the developer pushed the same head itself at 20:35Z, eight minutes before the verdict ref).

## Final Summary

## Summary
I re-ran `pnpm --filter ./pipeline-cli test:coverage` in the worktree as a single foreground run, with no other vitest process live. It exited 0 and the coverage thresholds were met. The earlier failure came from a stray coverage run in the same coverage directory. I made no code change and no new commit. The branch is unchanged at HEAD 234ff9ef, and the working tree is clean. I did not rebase, push or open a PR in this round, and did not check whether earlier rounds already did. I left no background processes running.

## Changes
- (none)

## Design decisions
Only the pipeline-cli coverage run was re-checked. Overall coverage was Lines 94.15%, Statements 92.85%, Branches 85.95%, Functions 93.53%. I did not inspect the per-file figures for pipeline-cli/src/hierarchy/stall.ts or pipeline-cli/src/dispatch/complete.ts. prUrl is null only because this round pushed and opened nothing. The orchestrator should use the PR from the earlier round.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

