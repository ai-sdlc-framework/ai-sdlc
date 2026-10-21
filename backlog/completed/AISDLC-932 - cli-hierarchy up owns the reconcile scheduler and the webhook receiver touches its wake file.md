---
id: AISDLC-932
title: 'fix: cli-hierarchy up owns the reconcile scheduler and the webhook receiver touches its wake file'
status: Done
assignee: []
created_date: '2026-10-15'
labels: [hierarchy, pipeline-cli, velocity]
dependencies: []
references: [pipeline-cli/src/hierarchy/up.ts, pipeline-cli/src/hierarchy/down.ts, pipeline-cli/src/hierarchy/webhook.ts, pipeline-cli/src/hierarchy/scheduler.ts, pipeline-cli/src/cli/dispatch.ts, docs/operations/cli-hierarchy.md]
priority: high
dispatchable: true
---

## Description

The RFC-0054 webhook path is wired on the ingest side only. Observed 2026-10-15 22:10Z with the receiver and `gh webhook forward` running: 1655 event records in `.ai-sdlc/dispatch/events/`, and nothing consumed them.

Two gaps:

1. Nothing starts the consumer. `cli-dispatch reconcile --watch` (the scheduler of `pipeline-cli/src/hierarchy/scheduler.ts`: one reconcile at start, one within 2 s of a wake touch, then every 60 s while a PR is open) has to be started by hand as a detached process. `cli-hierarchy up` starts the webhook receiver when `AI_SDLC_WEBHOOK_SECRET` is set but never the scheduler, and `down` does not stop one. The dispatch session cannot start it either: a detached long-running process is not in its operational list, so the switch stalls on the operator every time the hierarchy is relaunched.
2. The receiver never touches the wake file. `docs/operations/cli-hierarchy.md` says that after a record is written, deliveries for the same `(pr, headSha)` are debounced 5 s and then the wake file is touched once; `webhook.ts` only writes the event record. The scheduler polls `<board>/.reconcile-wake`, which no code writes. With both running, a delivery still only takes effect on the 60 s timer.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: "the operator starts the scheduler and keeps it alive". The requirement is that the receiver and the scheduler run whenever the hierarchy runs, with no hand step. 2. Deleted: the hand-start of `reconcile --watch` and its log file as an operator procedure; nothing in code to delete. 3. Simplified: `up` starts the scheduler as one detached child (`node <cli-dispatch> reconcile --watch --board-dir <board>`, stdout and stderr to `<board>/reconcile-watch.log`) and records its pid next to the receiver's (`<board>/reconcile.json`, same shape as `webhook.json`); `down` stops it; `status` adds one line `reconcile: up (pid N)` or `reconcile: off`. The scheduler runs with or without the secret: without the receiver it is the 60 s timer, which already replaces the model-turn polling. The receiver touches `<board>/.reconcile-wake` after a record is written, debounced 5 s per `(pr, headSha)`, matching the documented contract and the scheduler's file name. 4. Accelerated: a delivery turns into a reconcile within ~7 s instead of the next model tick (30 s to 15 min), and a relaunch needs no operator step. 5. Automated: tests for `up` starting and `down` stopping the scheduler (same pattern as the receiver's), for `status` reporting it, and for the receiver's touch (once per debounce window, no touch on a replay or a 401).

## Acceptance Criteria

- [ ] `cli-hierarchy up` starts `reconcile --watch` as a detached child and records its pid; a second `up` with a live scheduler does not start another (same guard as the receiver).
- [ ] `cli-hierarchy down` stops it; `cli-hierarchy status` (text and `--json`) reports it.
- [ ] The receiver touches `<board>/.reconcile-wake` after writing a record, debounced 5 s per `(pr, headSha)`; a replayed delivery id or a failed signature touches nothing.
- [ ] `scheduler.ts` and `dispatch.ts` keep `.reconcile-wake`; the docs name the same file in the `webhook`, `up`, `down` and `status` sections and in the reconciler paragraph.
- [ ] Tests cover the four points above.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Until this lands the operator starts the scheduler by hand from a shell with the secret: `nohup node pipeline-cli/bin/cli-dispatch.mjs reconcile --watch --board-dir .ai-sdlc/dispatch >> ~/.config/ai-sdlc/reconcile-watch.log 2>&1 & disown`. The per-tick one-shot `reconcile` of the dispatch command stays; both are idempotent over the landing records.
