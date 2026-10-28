---
id: AISDLC-1089
title: 'hierarchy hooks module wakes idle executors on every tick that finds eligible queued work and idle executors, and after a hold is lifted, not only on a tick that ingests'
status: In Progress
assignee: []
created_date: '2026-10-28'
labels:
  - orchestrator
  - hierarchy
priority: high
dispatchable: true
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/hold.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Observed 2026-10-28 09:00Z, the first run with the hooks module loaded on dispatch and all five executors (after the tick timer fix landed). The board held 77 queued tasks, 0 inflight, and all five executors sat idle after reporting `[executor] idle` because a board hold had refused their first claim. `cli-hierarchy resume` lifted the hold and later ticks ingested new briefs, yet no executor was woken: the module's `tick` function in `ai-sdlc-plugin/hooks/hierarchy/dispatch.ts` calls `wakeIdleExecutors` only when the tick result's `ingested` list is non-empty, and an executor that is already idle when an `enqueue` arrives for a task it cannot claim (hold, DoR refusal, slot lock) stays idle until the next ingest. The planner cannot kick executors (`cli-hierarchy clear` is dispatch-only), so the drain stalls until a person intervenes. This is the main gap between "module loaded" and an unattended drain.

## Fix

**Five-step review (requirements first).** The requirement questioned is "wake only on ingest, to keep idle executors from polling": the budget concern was the model polling `executor-start`; a module-sent `enqueue` to an idle executor costs one claim attempt, so the real requirement is "one claim attempt per idle executor per tick while eligible work exists", which the ingest-only rule under-delivers. Deleted: nothing (the ingest wake stays, it becomes a special case). Simplified: one wake rule, computed from the tick result instead of from the ingest list. Accelerated: an idle executor claims within one tick (30 s) of work becoming eligible or a hold being lifted, instead of after the next brief. Automated: a module test and a `tick` result field make the rule observable from `cli-hierarchy status`.

1. `pipeline-cli/src/hierarchy/dispatch-loop.ts`: the tick result gains `eligibleQueued` (count of queued entries with satisfied `after`, not held, not blocked) and `idleExecutors` (roster names in state idle with no inflight), and `holdLifted: true` on the first tick after `cli-hierarchy resume` (read from the hold file's cleared timestamp in `pipeline-cli/src/hierarchy/hold.ts`).
2. `ai-sdlc-plugin/hooks/hierarchy/dispatch.ts`: after a successful tick, call `wakeIdleExecutors` when `ingested.length > 0` OR (`eligibleQueued > 0` AND `idleExecutors.length > 0`); send one `enqueue` per idle executor, at most `min(eligibleQueued, idleExecutors.length)` per tick; record `woke <name>` notes as today. Do not wake an executor that was woken in the previous tick and is still idle (one tick of back-off) so a refused claim does not re-wake every 30 s.
3. `ai-sdlc-plugin/hooks/hierarchy/executor.ts`: an `enqueue` received while idle runs the executor command exactly as a first wake; confirm no "muted after idle" state survives.
4. Tests: module fixtures for (a) ingest-free tick with eligible work and idle executors wakes them, (b) back-off skips an executor woken last tick, (c) hold lifted wakes; dispatch-loop test for the three new result fields.
5. `docs/operations/cli-hierarchy.md`: update the "Executor wake" bullet of the dispatch module section.

## Acceptance Criteria

- [ ] With 5 idle executors, 0 inflight and eligible queued work, the module sends `enqueue` to every idle executor within one tick, with no new brief ingested.
- [ ] After `cli-hierarchy resume`, the next tick wakes idle executors.
- [ ] An executor whose claim was refused is not re-woken on the very next tick (one-tick back-off), and is re-woken after.
- [ ] `cli-hierarchy tick` JSON carries `eligibleQueued`, `idleExecutors` and `holdLifted`.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
