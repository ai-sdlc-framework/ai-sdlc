---
id: AISDLC-1379
title: 'Dispatch polls on the RFC-0054 slow interval while the webhook is healthy'
status: To Do
assignee: []
created_date: '2026-11-22'
labels:
  - performance
  - hierarchy
  - pipeline-cli
  - webhook
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - pipeline-cli/src/hierarchy/scheduler.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/pr-snapshot.ts
  - pipeline-cli/src/dispatch/webhook-receiver.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/status.ts
  - spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md
  - docs/operations/cli-hierarchy.md
priority: high
---

## Description

**Gap.** With the webhook healthy (port 8765, feed gh-forward, last event 0m), dispatch made about 1,700 gh calls an hour on 2026-11-22 (`.ai-sdlc/dispatch/gh-calls.jsonl`), core quota fell to 59 before the hourly reset, and each call is another short-lived node/gh process on a machine at load 15 to 21. RFC-0054 OQ-1 Option D (`spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md:383-390`) says: when the listener is healthy, poll about every 15 minutes and treat webhook events as hints.

**Facts read in code** (main at cd53eb237).

- `ai-sdlc-plugin/hooks/hierarchy/dispatch.ts:21` `DEFAULT_TICK_MS` 30s; each fire runs `cli-hierarchy tick`, an unconditional `cli-dispatch reconcile` (`:427`), `cli-ci sweep`, and `cli-hierarchy status --json` (`refreshPane`, `:449`, again `:463`).
- `pipeline-cli/src/hierarchy/scheduler.ts:10`: the separate `reconcile --watch` scheduler uses a 60s timer whenever PRs are open.
- Webhook health is read only for display (`status.ts:389`, `dispatch-loop.ts:1253`); reconcile, the scheduler and the merge gate never consult it.
- `webhook-receiver.ts:250` touches `.reconcile-wake` for every (pr, headSha) including `pr=none` main-branch events; 269 of ~486 events an hour were main check/workflow runs with no PR.
- Every such event invalidates `pr-snapshot.ts` `quietSince` (`:166`) and the 5-minute `githubReadFresh` in `dispatch-loop.ts:909-921`, so the caches meant to save calls rarely survive.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: dispatch must react to PR changes within seconds and catch a missed event within minutes; it does not need a full GitHub read every 30s when events are arriving. 2. Deleted: the unconditional 30s reconcile in the hooks module and the wake for events that name no open PR. 3. Simplified: one rule, Option D, applied by both the hooks timer and the scheduler. 4. Accelerated: event-driven wakes stay immediate. 5. Automated: tests per wake source and health state.

- While webhook health is `healthy`, the hooks module and the scheduler run reconcile only on a `.reconcile-wake` touch or on the slow interval (15 minutes, a named constant); when health is anything else they keep today's cadence.
- The receiver does not touch `.reconcile-wake` for events that name no open PR, except a `push` to main (main-health and landing need it).
- `quietSince` and `githubReadFresh` ignore events with no PR.
- The closed-unmerged KPI (`kpi/closed-unmerged.ts:130`) runs on its own slow timer, not on every GitHub read.
- `docs/operations/cli-hierarchy.md`: describe the healthy and degraded cadences.

Out of scope: per-call caching (AISDLC-1380).

## Acceptance Criteria

- [ ] #1 A test: with health `healthy` and no wake, the hooks timer fire does not run reconcile until the slow interval passes.
- [ ] #2 A test: with health `down`, reconcile runs at today's cadence.
- [ ] #3 A test: a check_run event with no PR neither touches `.reconcile-wake` nor invalidates the PR snapshot; a push to main does wake.
- [ ] #4 A measurement in the PR body: gh calls per hour from `gh-calls.jsonl` for dispatch before and after, webhook healthy.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
