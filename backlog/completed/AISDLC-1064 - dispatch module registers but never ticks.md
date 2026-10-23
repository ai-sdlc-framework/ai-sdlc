---
id: AISDLC-1064
title: 'hierarchy dispatch module registers but never ticks: register the tick timer before any awaited UI or status call and log every registration step'
status: Done
assignee: []
created_date: '2026-10-23'
labels:
  - plugin
  - hierarchy
  - rca-2026-10-23
priority: critical
dispatchable: true
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/register.tsx
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Smoke test after the 0.36.x release and `cli-hierarchy down && up` (2026-10-23, 17:35Z to 18:20Z). The module now passes the version guard in every role: the plugin store log holds one `role=operator-dispatch tier=managed identity=...` line for the dispatch session and matching lines for the planner and five executors. Yet nothing the dispatch branch does after that line is observable: the store has no `hierarchy/dispatch-board` key although `refreshPane` writes it at registration and on every tick; the rotate request `cli-hierarchy clear ai-sdlc-executor-alpha` wrote at 17:59Z sits unconsumed in `.ai-sdlc/dispatch/handoff/` twenty minutes later (the dispatch tick is what forwards it, so `clear` timed out with "no hooks module consumed it"); the planner and beta rotate requests from before the restart are also untouched. The dispatch model session is still draining by hand.

The dispatch branch of the `session.start` handler in `ai-sdlc-plugin/hooks/hierarchy/register.tsx` runs, in order and each awaited: `wire(true)`, `$.ui.open({id:'board'})`, `$.clock.every(...)`, `refreshPane` (which runs `cli-hierarchy status`). Every call is wrapped in `safe`, so a primitive that rejects is silent, and a primitive that never resolves (a UI open in a session nobody is attached to is the first suspect) blocks the timer registration behind it forever. Nothing after the identity line is logged, so the failing step cannot be told from outside.

Fix: (1) register the `$.clock.every` tick first, before any UI or status call, so a slow or hanging pane never costs the tick; (2) log one line per step to the store log through the existing `log(p, ...)` helper: `tick registered every <ms>`, `ui.open ok|failed <reason>`, `first tick ran at <iso>`, `refreshPane ok|failed <reason>`; (3) run `$.ui.open` and the initial `refreshPane` without awaiting them on the registration path (fire and log the outcome), and bound `refreshPane` by a timeout so a hung `cli-hierarchy status` cannot wedge the pane; (4) make the first tick fire at once (not after the first 30 s interval) so a pending rotate request is consumed within seconds of `up`. Mirror the step logging in the planner and executor branches (one `registered role=<role>` line at the end). Unit tests in `mods/tests/hierarchy.test.ts` (or beside the module, as the existing hook tests do) cover: a `ui.open` that never resolves still leaves `clock.every` registered and the tick running; a rejecting `store.set` is logged, not swallowed; the log lines appear in order. Update the "no module loaded" runbook entry in `docs/operations/cli-hierarchy.md` with the new lines and what each missing one means. Coordinate with the module-health file of the sibling task that adds a `MODULE` column to `status` (same RCA label): if it has landed, write the first-tick heartbeat through its file too; if not, keep the store log and let that task read the same facts.

**Five-step review (requirements first).** Requirement questioned: must registration open the pane at all before the tick runs? No: the pane is a view, the tick is the function; the function comes first. Deletion: the sequential `await` chain between the guard and the timer is deleted. Simplified: one ordered list of logged steps, tick first. Accelerated: an immediate first tick instead of a 30 s wait, and a timeout on the status call. Automated last: tests pin the ordering with a never-resolving `ui.open` double.

## Acceptance Criteria

- [x] With a `ui.open` double that never resolves and a `clock.every` double that records its callback, registering the dispatch role leaves the tick callback registered and runs it once at registration; with a rejecting `store.set` double the failure is logged and registration completes.
- [ ] After `cli-hierarchy down && up`, within 60 s the plugin store log shows `tick registered`, `first tick ran` and `refreshPane ok` for the dispatch session, the store holds `hierarchy/dispatch-board`, and a `cli-hierarchy clear ai-sdlc-executor-<idle>` from the dispatch session is acknowledged (rotate request file deleted) within one tick.
- [x] Runbook entry updated; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.

## Final Summary

## Summary
The dispatch branch of the hierarchy hooks module now registers the tick timer first. It then logs `tick registered`, `ui.open`, `first tick ran` and `refreshPane` lines, and runs the first tick at registration. `ui.open` and the first `refreshPane` run without blocking registration, and `refreshPane` has a 20 s timeout. The capability probes in `exists()` are also bounded at 2 s, because a never-resolving `ui.open` probe was the first thing to hang registration.

## Changes
- ai-sdlc-plugin/hooks/hierarchy/register.tsx
- ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
- ai-sdlc-plugin/hooks/hierarchy/executor.ts
- ai-sdlc-plugin/mods/tests/hierarchy-dispatch.test.ts
- docs/operations/cli-hierarchy.md
- backlog/tasks/AISDLC-1064 - dispatch module registers but never ticks.md

## Design decisions
I did not check AC2 (the live check after `cli-hierarchy down && up`). It needs a restart, which the operator ruled out, so someone needs to run it after merge. The module-health sibling task had not landed, so the heartbeat goes to the store log only. I ran `pnpm test` twice: the first run showed only noisy output with no failures, the second exited 0. Coverage was not run locally. The planner and executor branches now end with a `registered role=<role>` line. The commit scope is `ci` because commitlint rejects `hooks`. The task file in the commit changes only its status to In Progress; I did not move it to `backlog/completed/` (the pre-push task-move step found nothing to move). The new unit tests are in `hierarchy-dispatch.test.ts` rather than `hierarchy.test.ts`. The never-resolving `ui.open` test takes about 2 s because it waits out the probe timeout.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

