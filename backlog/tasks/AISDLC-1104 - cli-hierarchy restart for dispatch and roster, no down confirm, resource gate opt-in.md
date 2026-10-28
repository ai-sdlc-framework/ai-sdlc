---
id: AISDLC-1104
title: >-
  cli-hierarchy: restart any session or the whole roster in one command, drop the down confirmation, make the resource gate opt-in
status: To Do
assignee: []
created_date: '2026-10-28'
labels:
  - hierarchy
  - dispatch
  - stability
dependencies: []
references:
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/hierarchy/restart.ts
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/preflight.ts
  - ai-sdlc-plugin/scripts/hierarchy-dispatch.mjs
  - ai-sdlc-plugin/commands/hierarchy.md
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator findings from the 2026-10-28 drain (three stalls, each needing a hand restart):

1. `cli-hierarchy restart` (`pipeline-cli/src/hierarchy/restart.ts`) restarts one executor only and is dispatch-session only. Restarting the dispatch session, the planner, or the whole roster still takes `down` followed by `up` (`docs/operations/cli-hierarchy.md`, "restart" section), which returns every inflight manifest to the queue and loses the executors' work in progress.
2. The plugin wrapper `ai-sdlc-plugin/scripts/hierarchy-dispatch.mjs` refuses `down` without `--role` until the skill asks the operator and re-runs with `--confirmed` (exit 3). The operator is always the one typing `down`; the question blocks a routine action and has never changed an outcome.
3. `evaluateResourceGate()` in `pipeline-cli/src/hierarchy/preflight.ts` refuses `up` when available memory is below 4 GiB or the one-minute load average is at or above the core count. On the operator's machine it refuses `up` far more often than a launch actually fails: a machine running five executors sits at that load as a matter of course, and the refusal has blocked relaunches during stalls (the only override is the env var `AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE=1`, documented as a testing escape hatch). The gate was carried over from the retired execute-parallel feature with the first `up` commit and has no decision record.

**Five-step review (requirements first).** Requirement questioned: "launching sessions must be guarded by a confirmation and a machine-resource check". Neither guard protects a trust-chain or governance control; both protect the operator from themselves, and the operator has asked for them to go. Deletion: delete the `down` confirmation from the wrapper and the skill; delete the resource gate from the default `up` path. Simplified: `restart` takes any roster name (executor, dispatch, planner) or `--all`, reusing the recorded model, mode and env; `--all` restarts dispatch and every idle executor and leaves busy executors to `--after-task`. Accelerated: a dispatch restart no longer drains the board. Automated: the gate stays available as an opt-in for the dynamic-executor path (`spawn`) behind a config key `hierarchy.resourceGate: true` in `.ai-sdlc/pr-lifecycle.yaml` (default false), where bursts of starts are the realistic risk.

Fix:
- `restart <name>|--all`: accept `operator-dispatch` and `planner` roster names; restarting dispatch keeps inflight manifests on the board (no requeue) and re-registers the webhook/scheduler; `--all` = dispatch + idle executors now, busy executors after their task. Planner-session callers may restart dispatch (today restart is dispatch-only, which is a deadlock when dispatch itself is the stuck session).
- Remove the `--confirmed` check and the exit-3 notice from `hierarchy-dispatch.mjs` and the question from `commands/hierarchy.md`; `down` runs at once.
- `up` no longer calls `evaluateResourceGate()` unless `hierarchy.resourceGate` is true; `spawn` honours the same key. Drop the `AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE` env var and its doc line.
- Update `docs/operations/cli-hierarchy.md` (restart section, resource gate paragraph, down section).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `cli-hierarchy restart operator-dispatch` restarts the dispatch session with its recorded model/mode/env and leaves inflight manifests on the board (test in `restart.test.ts`).
- [ ] `cli-hierarchy restart --all` restarts dispatch and every idle executor, and defers busy executors as `--after-task` does (test).
- [ ] The planner session may run `restart operator-dispatch`; executors still may not run `restart` (test).
- [ ] `hierarchy-dispatch.mjs down` runs without `--confirmed`; the exit-3 notice and the skill question are gone (node --test in `ai-sdlc-plugin/`).
- [ ] `up` and `spawn` call the resource gate only when `hierarchy.resourceGate: true`; the env override is removed (test in `up.test.ts`).
- [ ] `docs/operations/cli-hierarchy.md` documents the three changes.
- [ ] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Notes

Operator request 2026-10-28 22:40Z in the planner session. Velocity impact: removes two operator interrupts per relaunch and one full board drain per dispatch restart.
