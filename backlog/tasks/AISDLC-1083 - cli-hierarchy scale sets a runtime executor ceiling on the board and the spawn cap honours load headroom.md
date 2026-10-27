---
id: AISDLC-1083
title: 'cli-hierarchy scale: planner or dispatch sets a runtime executor ceiling on the board, and the spawn cap honours machine load headroom so the pool grows and shrinks with dispatch load'
status: To Do
assignee: []
created_date: '2026-10-27'
labels:
  - pipeline-cli
  - hierarchy
  - enhancement
priority: high
dispatchable: true
dependencies:
  - AISDLC-1076
references:
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/hold.ts
  - pipeline-cli/src/hierarchy/preflight.ts
  - pipeline-cli/src/hierarchy/status.ts
  - docs/operations/cli-hierarchy.md
  - spec/rfcs/RFC-0059-ephemeral-executors.md
rfc: RFC-0059
---

## Description

RFC-0059 makes the executor pool elastic: the dispatch tick spawns one executor per eligible claim and downs it on its verdict, under a cap of `min(executors.max, budget allowance)`. Two inputs the operator asked for on 2026-10-27 are still missing, so the pool cannot be scaled by the planner or dispatch at run time, nor by the machine:

1. **No runtime ceiling.** `executors.max` lives in `.ai-sdlc/` config, which the planner and dispatch sessions never edit. During the 2026-10-26 token-containment day the cap of 2 was enforced by prose rulings and manual counting. The only runtime lever today is `cli-hierarchy hold`, which is all-or-nothing.
2. **Load is a gate, not an input.** `preflight.ts` refuses `up` when the one-minute load average reaches the core count or memory is under 4 GiB, and it is bypassable only by an env var. The tick has no view of load, so a pool that fits at spawn time keeps spawning as the machine saturates, and the only recovery is a refusal at the next `up`.

## Fix

**Five-step review (requirements first).** The requirement questioned is "the pool size is a config value": it is a run-time quantity, so the authoritative number must live where the tick reads every cycle, the board. Deleted: the env-var override of the resource gate as the way to run under load (it stays only for the operator, documented as such); prose cap rulings in briefs. Simplified: one cap formula with four inputs, `min(executors.max, board ceiling, budget allowance, load headroom)`, computed once per tick and printed by `status`; the planner and dispatch change one number with one command. Accelerated: the cap reacts on every tick in both directions, so a load spike shrinks the pool within one interval and a freed machine grows it back without a relaunch. Automated: the load input is deterministic (no model call), and the ceiling command is a CLI the dispatch module can run from its tick on a ruling, never a prose instruction.

1. `cli-hierarchy scale --max <n> --reason <text>` (and `--clear`) writes `<board>/scale.json` `{ max, reason, by, at }` through the same append-only event pattern as `hold.ts` (`scale-events.jsonl`), so the roster name of the caller and the reason are kept. It refuses `n` above `executors.max` from config: the board ceiling can only tighten the configured maximum, never loosen it (a loosening is a config change through a PR).
2. The dispatch tick's spawn cap becomes `min(executors.max, scale.json max if present, budget allowance, load headroom)`.
3. Load headroom: `headroom = max(0, floor((cpus * loadFactor - loadAvg1) / loadPerExecutor))` plus a memory term `floor((availableBytes - reserveBytes) / bytesPerExecutor)`, with the four constants as documented config keys under `executors.load` and defaults measured from the 2026-10 runs (an executor at work costs roughly one core of load and 1.5 GiB). The snapshot function already in `preflight.ts` is reused; the tick never calls `os` directly.
4. Scale-down: when the computed cap drops below the number of running executors, the tick stops spawning and, if the gap persists for two ticks, downs idle executors first (no inflight task), then nothing else; an executor with an inflight task is never downed for load (its verdict downs it).
5. `status` prints a `CAP` line naming each input and the winner, e.g. `cap 2 (board ceiling 2 by ai-sdlc-planner: token containment; config 5; budget 4; load 3)`, and `handoff write` for dispatch includes it.
6. The hierarchy runbook gets a "Scaling the pool" section: the formula, the command, the config keys, and the rule that the board ceiling only tightens.

## Acceptance Criteria

- [ ] `cli-hierarchy scale --max 2 --reason x` writes the board ceiling and a `scale-events.jsonl` entry with the caller's roster name; `--clear` removes it; `--max` above the config maximum is refused with a message naming the config key.
- [ ] The tick never spawns above `min(executors.max, board ceiling, budget allowance, load headroom)`, proven by unit tests over the dispatch loop with a stubbed snapshot and pacer, one test per input being the minimum.
- [ ] With a stubbed load snapshot at saturation the tick spawns nothing, and after two ticks with the cap below the running count it downs only executors with no inflight task.
- [ ] `status` prints the CAP line with all four inputs and the winner.
- [ ] The runbook documents the formula, the command, the config keys and the tighten-only rule.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
