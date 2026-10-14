---
id: AISDLC-829
title: >-
  RFC-0054 Phase 1 core: coded reconciler and scheduler, landing/ records, one action table (task and docs action sets) replacing the dispatch tick's prose PR sweep
status: To Do
assignee: []
created_date: '2026-10-13'
updated_date: '2026-10-14'
labels:
  - dispatch
  - hierarchy
  - velocity
  - root-cause
  - rfc-0054
  - phase-1
dependencies:
  - AISDLC-826
references:
  - spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/pr-state.ts
  - pipeline-cli/src/hierarchy/stall.ts
  - pipeline-cli/src/cli/dispatch.ts
  - docs/operations/cli-hierarchy.md
priority: critical
dispatchable: true
---

## Description

Amended in place 2026-10-14 under RFC-0054 OQ-9 (id kept; the original scope, "tick sweeps open PRs and re-queues red ones with a note", is now one row of this task). This is the Phase 1 core of RFC-0054, resolved 2026-10-14: the PR lifecycle is one state machine, owned by the dispatch session's code, not by its prose.

Today (AISDLC-823) the classifier is code (`pr-state.ts`, `cli-dispatch classify-prs`) but the facts it classifies are gathered by the dispatch *model* following `operator-dispatch.md` Step 2b (REST calls written into `.pr-facts.json`), on a 15-minute self-clear cadence, and the actions are prose instructions to the same model. Under OQ-1 the webhook receiver (AISDLC-880) wakes a reconciler; under OQ-6 ownership and history live in `landing/<pr>.json`; under OQ-2, OQ-4 and OQ-11 the action table has a task set (post-ready PRs, takeover on executor death) and a docs set (no-task PRs, owned from birth); under OQ-8 everything runs locally.

**Five-step review (requirements first).** Requirement questioned: "the dispatch model must look at PRs". No: the facts are REST JSON and the decision is a table; a model adds latency, cost and a 15-minute floor. Deleted: Step 2b of `operator-dispatch.md`, `.pr-facts.json`, the model-driven cadence for PR handling. Simplified: one reconciler, one record per PR, one table. Accelerated: reaction time drops from the tick interval to the reconciler's run time after an event. Automated last: the reconciler runs itself on wake, on event, and on a timer.

1. **Reconciler** (`pipeline-cli/src/hierarchy/reconcile.ts`, `cli-dispatch reconcile [--pr <n>]`): lists open PRs over REST (task PRs by branch or title id; docs PRs by the docs-only detector and branch prefixes `ai-sdlc/file-*`, `ai-sdlc/decisions-sync*`, `docs/*`), reads checks and merge state, classifies with `pr-state.ts`, writes or updates `landing/<pr>.json` (owner, state, last action history, delivered and landed timestamps), and executes the action. Idempotent: the same facts twice produce the same record and no second action.
2. **Scheduler**: runs on (a) a wake file touched by the webhook receiver, (b) session start and machine wake, (c) a timer (default 60 s while any task or docs PR is open, else 15 min). Deterministic code in the dispatch loop, not a model turn; `cli-hierarchy clear --self --resume-after` is no longer how PR handling is paced.
3. **Action table** (replaces prose in `operator-dispatch.md`): task set per the RFC's ownership table from `ready` on (`merged` → mark landed, write `done/`, sync parent, release dependants; skew → `land-prep` (AISDLC-881, until it exists: the existing rebase path); flake → retrigger once; real red → `reenter` (AISDLC-882, until it exists: requeue with the failing line); `ready-to-flip` only for takeover after executor death post-sign); docs set (`rebase-in-place` via `cli-file rebase`, `rerun-dor`, `arm` via `cli-merge-if-eligible --source-kind docs`, `route-to-planner` for a real docs check failure). The release-please PR is reported, never acted on.
4. **Ownership**: `landing/<pr>.json.owner` is `executor:<name>` until `delivered`, then `machine`; docs PRs are `machine` from creation. `cli-dispatch peek` and the brief-progress loop read `done/` only (OQ-5).
5. **Docs**: `docs/operations/cli-hierarchy.md` documents the reconciler, the scheduler, the record and the table; `operator-dispatch.md` Step 2b is deleted and replaced by one line that runs the reconciler.

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `cli-dispatch reconcile` over a fixture of PR facts produces one `landing/<pr>.json` per PR with owner, state, action and history; running it again on the same facts changes no file and runs no action (idempotency test).
- [ ] #2 Every state in `PR_STATES` maps to exactly one action in the task set or the docs set, with a hermetic test per row; a docs-only PR with `mergeStateStatus: DIRTY` yields `rebase-in-place`, a task PR with a real red yields the re-entry action carrying the failing check line and head SHA.
- [ ] #3 The scheduler fires on wake-file touch, on session start and on the timer; a test shows a touched wake file causes one reconcile within the debounce window and no model turn is involved (no `claude` invocation in the trace).
- [ ] #4 A PR with no task id (filing PR) gets `owner: machine` at first sight and is never listed as unowned; the tick result's progress line shows docs PRs with their state.
- [ ] #5 `operator-dispatch.md` has no Step 2b and no `.pr-facts.json` reference; the reconciler is invoked by one line; `ai-sdlc-plugin/commands/operator-dispatch.test.mjs` is updated.
- [ ] #6 `docs/operations/cli-hierarchy.md` documents the reconciler, scheduler, record format and both action sets.
- [ ] #7 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate).
<!-- AC:END -->

## Verification

`pnpm build && pnpm test && pnpm lint && pnpm format:check`; one drain hour with the reconciler as the only PR handler and zero planner messages for mechanical states (the AISDLC-823.1 soak criterion applies to this task).

## Out of scope

The webhook receiver (AISDLC-880); the loop guard, stale-claim row removal and `ci-failure-watcher` deletion (AISDLC-883); the `land-prep` runner (AISDLC-881); the `reenter` command (AISDLC-882).
