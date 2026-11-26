---
id: AISDLC-1416
title: Delete the heartbeat-age reap that AISDLC-1226 put back against DEC-0392
status: To Do
priority: high
created_date: '2026-11-26 01:40'
updated_date: '2026-11-26 01:50'
assignee: []
labels:
  - pipeline-cli
  - bug
  - hierarchy
dependencies: []
references:
  - pipeline-cli/src/hierarchy/stall.ts
  - pipeline-cli/src/next-step/next-step.ts
  - docs/operations/cli-hierarchy.md
---

## Description

**Five-step review (requirements first).**
1. Question: a claim must be released when its executor is dead, wedged or finished (DEC-0392). That requirement stands. A heartbeat age was never part of it, and DEC-0392 rejected both the age rule ("patch-proxy") and hand-refreshed heartbeats ("status-quo").
2. Delete: branch (b) of `reapStalledClaims`, which reaps when `lastHeartbeat` is older than `DEFAULT_STALL_MS`, together with `DEFAULT_STALL_MS` and `StallDeps.stallMs`.
3. Simplify: liveness comes only from the signals DEC-0392 names, all of which already exist.
   - Pane death requeues the claim at once (AISDLC-1217).
   - A terminal phase (`done`/`aborted`) with no verdict is reaped after the terminal grace (AISDLC-1226 (a), AISDLC-1230).
   - A wedged developer round ends on its step-owned budget (AISDLC-1219, `next-step.ts:569`), which reports `iterate-needed` and keeps the worktree.
4. Accelerate: none.
5. Automate: none added.

**Regression.**
- DEC-0392, answered 2026-11-07, chose event-driven liveness. AISDLC-1218 (#2499) deleted the heartbeat-age reap.
- The next day, AISDLC-1226 (#2512) correctly removed the lossy hook-published `executorState`. Its Fix step 4 then added "(b) `lastHeartbeat` is older than a stall window (default 20 min)" as the replacement signal. That is the age rule DEC-0392 rejected.
- No decision record authorized it. The 1226 review did not check it against DEC-0392.

**Incident (2026-11-26, AISDLC-1407).**
- The executor started its developer subagent at 00:18:56Z. The pipeline writes the heartbeat only at step boundaries, so the last one was 00:18:59Z.
- At 00:39:03Z the dispatch tick reaped the claim through branch (b) and typed `/exit` into the pane while the subagent was still writing.
- PR #3004 was left as a draft with no owner. The same branch would have reaped AISDLC-1407.1 at 01:49Z.
- Planner stopgap: `dev-keepalive.sh` refreshes the heartbeat while the subagent writes, which is DEC-0392's rejected status-quo option. It is removed when this lands.

## Acceptance Criteria
- [ ] #1 `reapStalledClaims` never reaps a non-terminal claim on heartbeat age. A test asserts that a claim in `awaiting-developer` with a heartbeat 3 hours old and no live `next-step` is not reaped.
- [ ] #2 The terminal-phase reap (with the AISDLC-1230 grace) and the `next-step` spare are unchanged. Their existing tests pass.
- [ ] #3 `DEFAULT_STALL_MS` and `stallMs` are gone. `pnpm dark-code:check` passes with no growth in the baseline.
- [ ] #4 The stall paragraph in `docs/operations/cli-hierarchy.md` and the `stall.ts` header describe the three DEC-0392 signals and cite DEC-0392. Neither mentions a stall window.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
