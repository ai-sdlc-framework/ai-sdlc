---
id: AISDLC-1218
title: 'Delete the heartbeat-age reap; reap idle-with-claim on the executor state event'
status: Done
assignee: []
created_date: '2026-11-07'
labels:
  - dispatch
  - rfc-0051
  - rfc-0041
  - dec-0392
dependencies:
  - AISDLC-1216
  - AISDLC-1217
references:
  - pipeline-cli/src/hierarchy/stall.ts
  - pipeline-cli/src/hierarchy/stall.test.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/next-step/session.ts
  - pipeline-cli/src/hierarchy/pr-lifecycle-config.ts
  - spec/rfcs/RFC-0041-conductor-worker-process-architecture.md
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

**Source.** DEC-0392, part 3 of 4. `reapStalledClaims` (`stall.ts`) fails a claim when `lastHeartbeat` is older than 30 minutes (`staleMs`, RFC-0041 OQ-3) and, for an idle holder, when the pane tail ends with `?` (AISDLC-948). The heartbeat is written only at step transitions (`next-step/session.ts` `refreshClaimHeartbeat`), so any step longer than 30 minutes is reaped: AISDLC-1209 at 2026-11-06T19:45Z. With AISDLC-1216 the board carries the executor's real state and with AISDLC-1217 death is an event, so the age rule has no remaining purpose.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: RFC-0041 OQ-3 and the RFC-0051 stall paragraph set "no heartbeat beyond the limit" as the liveness rule; DEC-0392 replaces it with the executor's own state. 2. Deleted: the `stale-heartbeat` branch, `staleMs`, `AI_SDLC_DISPATCH_STALE_MS`, the `stall` thresholds in `hierarchy/pr-lifecycle-config.ts`, the `endsWithQuestion` pane scrape (AISDLC-948), and `refreshClaimHeartbeat` calls in `next-step.ts`, `ship.ts` and `workflow/execute-host.ts`. `lastHeartbeat` stays written once at claim because `trusted-policy.js` binds the lease push to the file; rename nothing. 3. Simplified: one rule remains: a claim whose `executorState` is `idle-awaiting-clear` and that has no verdict in `done/` or `failed/` is reaped with `cause: idle-with-claim`, on the tick that sees the state (the executor stopped without `cli-dispatch complete`, which covers the AISDLC-948 question case). A claim in `turn-running` or `background-agent-running` is never reaped by dispatch, whatever its age. 4. Accelerated: no false reap of long rounds; the question case is caught on the `turn.complete` event instead of pane text. 5. Automated: `docs/operations/cli-hierarchy.md` threshold section replaced by the state table; RFC-0041 OQ-3 and RFC-0051 stall paragraph get an amendment note pointing to DEC-0392 (no `**Resolution:**` marker is added or changed).

## Acceptance Criteria
- [x] #1 A claim in `background-agent-running` with a heartbeat 3 hours old is not reaped (test replaces the AISDLC-1103/1124 threshold tests).
- [x] #2 A claim in `idle-awaiting-clear` with no verdict is reaped with `cause: idle-with-claim` and requeued through the existing requeue path; one in `idle-awaiting-clear` with a verdict in `done/` is skipped.
- [x] #3 `staleMs`, `graceMs`, their env vars, the `stall` config block and `endsWithQuestion` no longer exist; `refreshClaimHeartbeat` is removed and the dark-code gate is green.
- [x] #4 The lease-push binding tests (`enforce-lease-push.test.mjs`, `trusted-policy.test.mjs`) still pass with `lastHeartbeat` written once at claim.
- [x] #5 RFC-0041, RFC-0051 and `docs/operations/cli-hierarchy.md` describe the state-based rule and cite DEC-0392.

## Final Summary

## Summary
The stall reap now keys on the executor state published to the claim. It reaps only `idle-awaiting-clear` claims with no verdict, using cause `idle-with-claim`, then clears the holder and requeues the task through `requeueFailed`. The heartbeat-age rule, `staleMs`, the stall config block, `endsWithQuestion` and `refreshClaimHeartbeat` are removed, and RFC-0041, RFC-0051, RFC-0054 and `cli-hierarchy.md` now describe the state-based rule and cite DEC-0392.

## Changes
- pipeline-cli/src/hierarchy/stall.ts
- pipeline-cli/src/hierarchy/stall.test.ts
- pipeline-cli/src/hierarchy/dispatch-loop.test.ts
- pipeline-cli/src/hierarchy/dispatch-loop-ephemeral.test.ts
- pipeline-cli/src/hierarchy/index.ts
- pipeline-cli/src/hierarchy/pr-lifecycle-config.ts
- pipeline-cli/src/hierarchy/pr-lifecycle-config.test.ts
- pipeline-cli/src/cli/hierarchy.ts
- pipeline-cli/src/next-step/session.ts
- pipeline-cli/src/next-step/session.test.ts
- .ai-sdlc/pr-lifecycle.yaml
- docs/operations/cli-hierarchy.md
- spec/rfcs/RFC-0041-conductor-worker-process-architecture.md
- spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
- spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md

## Design decisions
The task's single stall-check commit was rebased onto origin/main and pushed; the pre-push patch-coverage gate passed at 100% on stall.ts. AISDLC-1219 had made the stall reap NOT requeue; AC2 asks for requeue on idle-with-claim, so I reinstated requeue for this cause only. If `requeueFailed` refuses (retry limit or a queue conflict), the failed record stays and the progress line says 'not re-queued'. Because a successful requeue removes the failed record, the diagnostic is only visible through the `onReaped` callback in that case. The live next-step spare (AISDLC-1198) is kept for idle holders, so a backgrounded verification is not reaped. `graceMs` and its env var were already gone via AISDLC-1217. For AC4, the lease-push binding tests were not edited and no code under them changed. The full `pnpm test` run, which includes those test directories, showed no failures after I fixed one ephemeral stall test. I did not run those two test files on their own. I could not record the commit SHA from this session. The task file's status moved to In Progress in the same commit.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

