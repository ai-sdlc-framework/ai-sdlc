---
id: AISDLC-1272
title: 'cli-hierarchy restart --all restarts the reconcile scheduler and the webhook receiver'
status: Done
assignee: []
created_date: '2026-11-13'
labels:
  - pipeline-cli
  - hierarchy
  - reliability
dependencies: []
references:
  - pipeline-cli/src/hierarchy/restart.ts
  - pipeline-cli/src/hierarchy/reconcile-scheduler.ts
  - pipeline-cli/src/hierarchy/webhook.ts
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
dispatchableReason: 'Reported by the ai-sdlc-io planner 2026-11-13 (operator standing order 2026-11-09: file every io-planner report). The monorepo planner verified that reRegisterDispatchServices in restart.ts only calls schedulerUp and webhookUp, and that both log "already running" and return when a process exists. One function and its tests.'
---

## Description

**Gap.** `cli-hierarchy restart --all` restarts the sessions but not the two long-running processes. `reRegisterDispatchServices` in `pipeline-cli/src/hierarchy/restart.ts` calls `schedulerUp` and `webhookUp`; each logs "already running" and returns when its process is alive (`reconcile-scheduler.ts:83`, `webhook.ts:431`). The scheduler's command line carries the path of the pipeline-cli it was started from, so after a plugin or pipeline-cli update it keeps running the old code until someone kills it by hand.

On 2026-11-13 the ai-sdlc-io scheduler kept running pipeline-cli 0.41.0 through a full `restart --all`. Its tick went on killing the ai-sdlc board's executors until the scheduler was killed and started again, and the webhook receiver was cycled with `webhook down` then `webhook up`.

**Shape.** `restart --all` stops and starts the scheduler and, when `AI_SDLC_WEBHOOK_SECRET` is set, the webhook receiver, so one command puts every process of the hierarchy on the installed code. Restarting a single session keeps the present behaviour. The webhook port and forwarder settings are read as on a normal `webhook up`.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: an operator who runs `restart --all` after an update expects no process to stay on the old code; "make sure they run" was the narrower requirement that was built. 2. Deleted: the by-hand kill of the scheduler and the `webhook down` and `up` pair after an update. 3. Simplified or optimised: reuse the existing stop and start functions; no version comparison of running processes is added. 4. Accelerated: n/a. 5. Automated: tests for the stop-then-start order and for the single-session case.

## Acceptance Criteria

- [ ] #1 `restart --all` stops a running reconcile scheduler and starts a new one; a test asserts the stop precedes the start and that the new pid is recorded.
- [ ] #2 `restart --all` stops and starts the webhook receiver when `AI_SDLC_WEBHOOK_SECRET` is set, and leaves it alone when the secret is unset.
- [ ] #3 `restart <name>` for one session does not restart the scheduler or the webhook receiver.
- [ ] #4 A failure to stop or start either process is logged as a warning naming the process and does not abort the session restarts.
- [ ] #5 `docs/operations/cli-hierarchy.md` states that `restart --all` restarts both processes.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
