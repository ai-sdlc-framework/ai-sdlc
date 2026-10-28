---
id: AISDLC-1103
title: >-
  Ephemeral executors are not reaped on heartbeat age alone during a developer pass (stall reaper uses holder state, not the 10-minute grace)
status: To Do
assignee: []
created_date: '2026-10-28'
labels:
  - hierarchy
  - dispatch
  - stability
dependencies: []
references:
  - pipeline-cli/src/hierarchy/stall.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Since the ephemeral executors landed (PRs #2022 and #2027), the stall reaper in `pipeline-cli/src/hierarchy/stall.ts` treats an ephemeral worker's claim as `stale-heartbeat` as soon as its heartbeat is older than `graceMs` (10 minutes by default, `.ai-sdlc/pr-lifecycle.yaml` `stall.graceMs: 600000`), while a roster executor gets `staleMs` (30 minutes). The inflight heartbeat is written at step transitions, and the developer pass (`05-dev-running`) routinely runs longer than 10 minutes without a step change. On 2026-10-28 three dynamic executors were reaped mid-developer pass with diagnostics `cause: stale-worker, lastStep: 05-dev-running` and heartbeat ages of 621 s, 673 s and 2413 s (AISDLC-656.2, AISDLC-940, AISDLC-1096); their sessions were busy and their branches were half-built. Only tasks whose developer pass finishes inside 10 minutes survive, so the ephemeral path cannot drain the backlog.

**Five-step review (requirements first).** The requirement questioned is "an ephemeral worker is stale after the grace period": the grace period exists to catch a holder that is `idle`, `gone` or `unknown`, which the reaper already evaluates from the session state (the `holder-not-busy` branch), and a busy ephemeral session is as alive as a busy roster one. Deletion: remove the `isEphemeral` short-circuit from the `stale-heartbeat` condition, so an ephemeral worker is reaped by `holder-not-busy` when its session is really gone or idle after `graceMs`, and by `stale-heartbeat` only after `staleMs` like every other worker. Simplified: one liveness rule for both worker kinds. Accelerated: nothing to accelerate. Automated: a unit test that pins the rule (busy ephemeral holder at 11 minutes is kept; gone ephemeral holder at 11 minutes is reaped).

Fix: in `reapStalledClaims`, drop the `|| (ageMs > graceMs && deps.isEphemeral?.(worker) === true)` clause; keep the `holder-not-busy` branch as the ephemeral path. Document the two thresholds in `docs/operations/cli-hierarchy.md` in one sentence each. No new config knob.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] A busy ephemeral worker whose heartbeat is older than `graceMs` but younger than `staleMs` is not reaped (test in `stall.test.ts`).
- [ ] An ephemeral worker whose session state is `gone`, `idle` or `unknown` is still reaped after `graceMs` with reason `holder-not-busy` (test).
- [ ] Any worker is reaped with reason `stale-heartbeat` after `staleMs` (existing behaviour, test kept green).
- [ ] `docs/operations/cli-hierarchy.md` states the two thresholds and when each applies.
- [ ] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Notes

Evidence: `.ai-sdlc/dispatch/failed/AISDLC-656.2.diagnostic.json`, `AISDLC-940.diagnostic.json`, `AISDLC-1096.diagnostic.json` (2026-10-28). The reaped tasks were re-entered by the planner ruling of 20:25Z.
