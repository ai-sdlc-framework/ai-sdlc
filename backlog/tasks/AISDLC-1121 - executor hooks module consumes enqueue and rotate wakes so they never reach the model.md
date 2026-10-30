---
id: AISDLC-1121
title: executor hooks module consumes every enqueue and rotate wake, and a refused executor start never costs a model turn
status: To Do
assignee: []
created_date: '2026-10-30'
labels:
  - hierarchy
  - velocity
priority: high
references:
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - docs/operations/cli-hierarchy.md
---

## Description

A token audit of 2026-10-27 to 2026-10-30 found two executor costs that the hierarchy design says should not exist. First, 394 `enqueue` and `rotate` wake messages on 2026-10-29 reached the executor model as user turns (531 turns), although the executor hooks module is meant to consume them in its receive handler and run the executor command itself. Second, 128 executor sessions were spawned whose start was refused ("not a running executor in the roster" 104 times, "cannot claim: not in queue or not eligible" 123 times across the window, board empty 56, already holds a claim 29), each one costing a session start, a skill-body injection and an idle reply (939 turns in four days). Together these are about a third of the week's remaining avoidable spend after the Oct 23 idle loop was fixed.

**Five-step review (requirements first).** Requirement questioned: should an executor ever answer a wake with a model turn? No: a wake is a signal to run a deterministic command; only the task itself needs a model. Deletion: delete the path where a wake falls through to the prompt; delete the spawn of an executor whose claim the tick can already see will be refused. Simplified: one receive handler, one consume decision, one pre-spawn eligibility check in the tick. Accelerated: a refused claim is known before a session exists. Automated: the tick decides; no session decides.

## Fix

1. `ai-sdlc-plugin/hooks/hierarchy/executor.ts`: the receive handler consumes every `enqueue` and `rotate` wake regardless of the executor's phase (the current guard that lets a wake through after a verdict so the next one runs the command must run the command itself instead of surfacing the text). Log `hierarchy:enqueue consumed` with the action taken. Add a unit test that feeds a wake in each phase and asserts no prompt submit.
2. `pipeline-cli/src/hierarchy/dispatch-loop.ts`: before spawning an ephemeral executor for a task, run the same eligibility check `executor-start` would run (roster entry present, task queued and eligible, no live holder) and skip the spawn with one board log line when it would be refused. Count skipped spawns in the tick summary.
3. `docs/operations/cli-hierarchy.md`: one paragraph on wake consumption and the pre-spawn check.

## Velocity impact

Removes about 900 to 1,500 model turns a week at current load; no change to how fast an eligible task is claimed.

## Acceptance Criteria

- [ ] A unit test sends `enqueue` and `rotate` wakes to the executor module in idle, running and post-verdict phases; none produces a prompt submit, and each is logged as consumed with its action.
- [ ] A tick with a task that no roster executor may claim spawns nothing and logs the reason once.
- [ ] A live hierarchy run of one docs-only task shows no user turn in the executor transcript whose text starts with `enqueue` or `rotate`.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## Out of scope

- The stall reaper and heartbeat (AISDLC-1103) and orphan tmux reaping (AISDLC-1117).
