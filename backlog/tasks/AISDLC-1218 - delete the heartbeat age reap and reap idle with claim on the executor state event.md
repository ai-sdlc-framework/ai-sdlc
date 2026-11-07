---
id: AISDLC-1218
title: 'Delete the heartbeat-age reap; reap idle-with-claim on the executor state event'
status: In Progress
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
- [ ] #1 A claim in `background-agent-running` with a heartbeat 3 hours old is not reaped (test replaces the AISDLC-1103/1124 threshold tests).
- [ ] #2 A claim in `idle-awaiting-clear` with no verdict is reaped with `cause: idle-with-claim` and requeued through the existing requeue path; one in `idle-awaiting-clear` with a verdict in `done/` is skipped.
- [ ] #3 `staleMs`, `graceMs`, their env vars, the `stall` config block and `endsWithQuestion` no longer exist; `refreshClaimHeartbeat` is removed and the dark-code gate is green.
- [ ] #4 The lease-push binding tests (`enforce-lease-push.test.mjs`, `trusted-policy.test.mjs`) still pass with `lastHeartbeat` written once at claim.
- [ ] #5 RFC-0041, RFC-0051 and `docs/operations/cli-hierarchy.md` describe the state-based rule and cite DEC-0392.
