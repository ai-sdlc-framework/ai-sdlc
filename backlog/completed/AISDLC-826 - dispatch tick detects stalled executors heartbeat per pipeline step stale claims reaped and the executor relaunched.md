---
id: AISDLC-826
title: >-
  Dispatch tick detects stalled executors: heartbeat per pipeline step, stale claims reaped, executor relaunched
status: Done
assignee: []
created_date: '2026-10-12'
labels:
  - dispatch
  - hierarchy
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/status.ts
  - pipeline-cli/src/dispatch/board.ts
  - ai-sdlc-plugin/commands/executor.md
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (verified 2026-10-12 23:20Z).** `inflight/AISDLC-799.state.json` shows `lastHeartbeat == startedAt`, 170 minutes old, held by executor alpha; the roster shows alpha `busy` and gamma `unknown`, and dispatch reported "the executor did not report back in time" and left it alone. Nothing detects this. The board has a stale-heartbeat sweep (`sweepStaleHeartbeats` in `pipeline-cli/src/dispatch/board.ts`, RFC-0041 OQ-3, 30 min default) but only the `claude-p-shell` supervisor and `cli-dispatch` call it; the hierarchy dispatch tick (`dispatch-loop.ts`) never does. The executor writes one heartbeat at claim; the instruction to "refresh the claim between steps" in `executor.md` is prose for an LLM in the middle of a single long `/ai-sdlc execute` turn, and it never runs. `status.ts` already computes per-session liveness (`busy|idle|starting|gone|unknown`) and knows which session holds which claim, so every signal needed exists; they are not joined.

**Operator instruction (Dominique, 2026-10-12):** fix the agent stall by having the dispatch loop check for it.

**Five-step review (requirements first).** Delete: the executor-side manual heartbeat prose and the claim-time-only heartbeat (step 2).
1. Requirement questioned: "a stalled worker is reaped after 30 minutes without a heartbeat" (RFC-0041 OQ-3). Kept; it was never wired to the hierarchy, and heartbeats were never refreshed, so the threshold could never fire for a hierarchy executor.
2. Delete: the `executor.md` prose asking the executor to heartbeat between steps (an instruction no session follows), and the `heartbeat at claim` as the only heartbeat.
3. Simplify: (a) the pipeline writes the heartbeat itself: `next-step` (and the MCP step tools) call `writeHeartbeat` with `currentStep` on every step transition when a board claim exists for the task, so a live executor heartbeats every few minutes without being told to. (b) The dispatch tick, which already wakes every 300 s while work is in flight, runs one stall check: an inflight claim is stalled when its heartbeat is older than the threshold OR the roster shows its holder `idle`, `gone` or `unknown` for longer than a short grace (an executor that ended its turn without writing a verdict). A stalled claim moves to `failed/` with cause `stale-worker` and the executor's last known step; the holder is cleared and relaunched with `/ai-sdlc:executor`; the task is re-queued with a resume note naming the step it stalled at (no developer re-run when a PR already exists). One decision class only: this is operational, no planner round trip.
4. Accelerate: a stall costs at most one tick plus the grace instead of hours; dispatch reports each reap in its progress line.
5. Automate: the check runs inside the existing tick, so no new loop, cron or session.

**Velocity impact.** Positive: today three executors sat on claims for hours with no signal; the fix recovers them in minutes with no operator action.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `next-step` writes the inflight heartbeat (`lastHeartbeat`, `currentStep`) on every step transition when `inflight/<task>.state.json` exists for the task; hermetic test in pipeline-cli
- [ ] #2 The dispatch tick calls one stall check each wake: heartbeat older than the configured threshold (default 30 min, `.ai-sdlc/dispatch` config or env), or holder session `idle`/`gone`/`unknown` beyond a grace (default 10 min) with no verdict in `done/` or `failed/`
- [ ] #3 A stalled claim is moved to `failed/` with `cause: stale-worker`, `lastStep` and `heartbeatAgeMs`; the claim is released; the holder is cleared and relaunched through the existing clear/relaunch path; the task is re-queued with a resume note that names the stalled step and existing PR number
- [ ] #4 The tick result and the dispatch progress line report each reap (`task`, `worker`, `age`, `step`); the planner is NOT asked
- [ ] #5 `executor.md` no longer instructs the executor to heartbeat by hand; `docs/operations/cli-hierarchy.md` describes the stall check and its two thresholds
- [ ] #6 Hermetic tests in `dispatch-loop.test.ts`: stale heartbeat reaped; idle holder with no verdict reaped after grace; busy holder with fresh heartbeat untouched; a reap is recorded once (no double clear)
- [ ] #7 The unblocking playbook recognises `cause: stale-worker` (and the `stale-heartbeat` cause the board sweep writes) as a re-queue-with-resume-note shape; it no longer escalates them to the planner as `unrecognised failure shape` (observed 2026-10-12 on AISDLC-549)
- [ ] #8 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`
- `pnpm lint && pnpm format:check`
