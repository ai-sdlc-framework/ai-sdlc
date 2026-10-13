---
id: AISDLC-823
title: Dispatch tick is a scheduled PR and board state machine
status: To Do
assignee: []
created_date: '2026-10-12'
labels:
  - hierarchy
  - dispatch
  - velocity
dependencies: []
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
priority: critical
dispatchable: true
---

## Context

The operator-dispatch session (RFC-0051) runs "one tick per wake-up, then sleep" and nothing wakes it: no cadence and no PR/CI event source. On 2026-10-12 the drain idled for two hours after its blocking PR (#1433, DEC-0142) merged, and for the whole day every tick was triggered by a planner message, which in turn needed an operator ping. Seven escalations that day were all mechanical (push non-fast-forward x2, rebase/patch-id moved x3, reviewer set short x1, manifest branch mismatch x2) and each maps to a fixed action. Dispatch also refused to act on stale claims because it did not know `cli-dispatch reap`, `release`, `requeue` and `write-resume-signal` were on its list. Decision authority for the mechanical actions is already on main: DEC-0127 (drain), DEC-0142 (post-rebase hand review path), AISDLC-821 (push-only resume).

## Five-step review (requirements first)

**Five-step review (requirements first).** Deleted: the planner round trip for every mechanical PR stop and the "dispatch acts only when woken by a message" assumption (details in the numbered steps below). Scope note 2026-10-13: AISDLC-826 (stall detection) and AISDLC-829 (PR sweep in the tick) now carry two slices of this task; this task keeps the scheduled tick and the board state machine.

1. Requirement questioned: "dispatch acts only when woken by a message" (RFC-0051 design assumption that the planner or operator supplies wakes; set by the planner 2026-10-06). Deleted: the dispatch tick schedules itself.
2. Deleted: the planner round trip for every mechanical PR stop; the "operator pings planner pings dispatch" chain.
3. Simplified: one classification table in the existing tick, no new watcher process (the dormant ci-failure-watcher, AISDLC-460, stays dormant or is folded in, not duplicated).
4. Accelerated: a 15-minute REST poll (no GraphQL) of the roster's open PRs.
5. Automated last: GitHub webhook to local wake is explicitly out of scope.

## Requirements

- The operator-dispatch command body schedules its own next tick (ScheduleWakeup or equivalent) every 15 minutes while the board has queued/inflight/failed-eligible work or any task PR is open; it stops when both are empty. A tick with nothing to do is a no-op.
- Each tick classifies every open task PR in the roster (REST: `gh api repos/{owner}/{repo}/pulls` plus check-runs/status for the head) into exactly one state and takes the one action in the table below; a classifier helper in pipeline-cli (`pipeline-cli/src/hierarchy/pr-state.ts` or similar) does the classification deterministically with unit tests, and the command body only calls it.

| PR state | Action |
|---|---|
| merged | mark task done, sync parent (ff + pipeline-cli build), start next task in the recorded order |
| checks green, CLEAN, auto-merge armed | none |
| checks green, draft, approved verdict | flip ready via REST (`PATCH pulls/<n>` draft=false) |
| BEHIND or DIRTY | requeue with the hand-review-path resume note (DEC-0142, docs/operations/hand-review-path.md) |
| red `ai-sdlc/attestation` content-hash mismatch | push-only re-sign resume (`git fetch origin` first; AISDLC-821) |
| red `ai-sdlc/pr-ready` with a real test/lint/coverage failure | full fix resume with the failing line in the note |
| CANCELLED / infra | rerun the workflow, no resume |
| pending, no run started | none |
| stale inflight claim (no heartbeat > 30 min) | `cli-dispatch reap`, then `write-resume-signal` on claim |
| manifest branch != PR head branch | `write-manifest` with the PR head ref, requeue (DEC-0143/0144 class) |

- `cli-dispatch reap` runs every tick.
- The command body lists dispatch's own board commands with one line each (peek, claim, reap, release, requeue, enqueue, write-manifest, write-resume-signal, complete, remove-verdict) so the session never has to ask which is sanctioned.
- `cli-dispatch reap --help` prints help and does not run (today it runs; AC).
- Events: each classification+action is written to the orchestrator events file (one event type, fields: prNumber, taskId, state, action) so per-role KPIs can count escalations per landed PR.
- No new decision record is opened for any state in the table; a PR that fits no row is the only thing routed to the planner, with the REST payload summary.

## Acceptance Criteria

- [ ] AC-1: Classifier helper with unit tests covering every row of the table plus the no-match case.
- [ ] AC-2: operator-dispatch command body: self-scheduled 15-minute tick with the stop condition; calls the classifier; lists its board commands.
- [ ] AC-3: `cli-dispatch reap --help` is a no-op help print (test).
- [ ] AC-4: Event written per classification; test asserts the shape.
- [ ] AC-5: docs/operations/cli-hierarchy.md gains a "Dispatch tick: PR and board state machine" section with the table.
- [ ] AC-6: Soak evidence in the PR body: one drain hour with zero planner messages for mechanical stops.

## Velocity impact

Positive: removes the planner/operator from every mechanical PR stop (seven of seven on 2026-10-12) and the idle gaps between merges. Token cost: a REST poll every 15 minutes, no model call on a no-op tick.

## Out of scope

GitHub webhooks; changes to the executor loop; the reviewer-set classifier defect (separate post-drain item).
