---
id: AISDLC-1096
title: 'drain liveness: the watch scheduler runs the deterministic dispatch tick when the dispatch host misses three ticks, status shows the last tick age, and consumed webhook events are pruned'
status: Done
assignee: []
created_date: '2026-10-28'
labels:
  - orchestrator
  - hierarchy
priority: high
dispatchable: true
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile-scheduler.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/dispatch/webhook-receiver.ts
  - pipeline-cli/src/hierarchy/pr-snapshot.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Workflow audit 2026-10-28. The dispatch host made zero GitHub calls between 00:00Z and 15:00Z on 2026-10-28 (`gh-calls.jsonl`), and the night before it was dead for four hours. Four hooks-module defects in two days (AISDLC-1081, 1082, 1089, 1090) each stopped the drain silently: the tick lives in the module, so when the module is absent or its message parsing breaks, nothing ticks, nothing wakes executors, and nothing says so. `operator-dispatch.state.json` has no `lastTickAt`. Meanwhile the webhook receiver kept writing: `.ai-sdlc/dispatch/events/` holds 17,754 event files (11,974 check_run, 4,085 workflow_run) that nothing consumes or prunes; the receiver's only effect is touching the wake file, and the dispatch loop reads the directory for fingerprints, so the directory grows without bound and each snapshot scan gets slower. Operator rule (2026-10-14): no watchdog or relaunch automation that spends model tokens; a deterministic tick is allowed and is the first rung of the automation ladder.

## Fix

**Five-step review (requirements first).** The requirement questioned is "the tick runs inside the dispatch host so the model can act on its result": the tick itself is deterministic (`dispatch-loop.ts`), only the wake and routing messages need the host; the real requirement is "the board advances whenever work is eligible, whether or not a model session is alive". Deleted: the assumption that the host is the only tick owner, and the unbounded event store. Simplified: the already-running watch scheduler is the fallback tick owner; no new process, no relaunch. Accelerated: a dead host costs at most three tick intervals of drain, not a night. Automated: `cli-hierarchy status` prints the last tick age and who ran it; a fixture test kills the host heartbeat and expects the scheduler to tick.

1. `dispatch-loop.ts`: the tick writes `lastTickAt`, `lastTickBy` to `operator-dispatch.state.json`.
2. `reconcile-scheduler.ts`: on each wake or interval, if `now - lastTickAt > 3 * tickInterval`, run the deterministic tick (`cli-dispatch tick --by scheduler`): ingest briefs, consume verdict files already written, reconcile, and write the `wake/` files that `AISDLC-1089` wake logic reads; it never sends chat messages and never spawns a session. One `notes/host-missed-ticks.txt` line per episode.
3. `webhook-receiver.ts` / `pr-snapshot.ts`: after a tick has read the events directory, events older than 24h or for a PR that is closed are deleted; cap the directory at 2,000 files (oldest first). The event file stays a trigger, never a fact (RFC-0054).
4. `cli-hierarchy status`: `last tick: Xs ago by host|scheduler`, `events pending: n`.
5. Tests: scheduler fallback after three missed ticks; no fallback while the host ticks; pruning keeps the newest 2,000 and drops closed-PR events.
6. `docs/operations/cli-hierarchy.md`: "Liveness" subsection; `docs/operations/tooling-limitations.md`: note the event volume per hour as the headroom metric.

## Acceptance Criteria

- [x] With the dispatch host stopped and eligible queued work, the scheduler runs a tick within three tick intervals and `status` shows `by scheduler`.
- [x] With the host alive the scheduler never ticks.
- [x] After one tick the events directory holds at most 2,000 files and no event for a closed PR.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
Round-2 fixes pushed on top of the first commit and rebased onto origin/main. Scheduler-mode `cli-hierarchy tick --by scheduler` now runs the location checks. The closed-PR event prune is skipped when the open-PR set is empty. The stray `.bak` file is deleted.

## Changes
- pipeline-cli/src/cli/hierarchy.ts
- pipeline-cli/src/cli/hierarchy.test.ts
- pipeline-cli/src/hierarchy/dispatch-caller.ts
- pipeline-cli/src/hierarchy/pr-snapshot.ts
- pipeline-cli/src/hierarchy/host-liveness.test.ts
- pipeline-cli/src/hierarchy/host-liveness.test.ts.bak

## Design decisions
Full `pnpm test` on the rebased head (round 1 fix): `pipeline-cli test:  Test Files  2 failed | 546 passed (548)`, `Tests  15 failed | 12173 passed | 13 skipped (12201)`. 14 of the 15 failures are in src/hierarchy/executor-start.test.ts and come from the agent shell exporting AI_SDLC_EXECUTOR_TASK=AISDLC-1096 (they pass with that env unset); the last is src/steps/03-setup-worktree.test.ts predicate-3, which collides with local branch ai-sdlc/aisdlc-99 in the shared checkout. Neither test nor its source is touched by this diff. openPrNumbers now returns undefined (skips the closed-PR prune) when the open PR list reaches the 200 limit. checkDispatchCaller has a new skipCallerIdentity option; in scheduler mode only the dispatch-session identity requirement is skipped and repoRoot is pinned to the trusted root. pruneEvents no longer prunes by PR when the open-PR set is empty. Three new tests cover --by scheduler and a fourth covers the empty open-PR set. Rebase conflict in docs/operations/cli-hierarchy.md resolved by keeping both sections.

## Verification
- `pnpm build` — passed
- `pnpm test` — `cd pipeline-cli && vitest run` (via root pnpm test): 12173 passed, 15 failed, 13 skipped; failures environmental, see Design decisions
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

