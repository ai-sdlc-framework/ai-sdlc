---
id: AISDLC-1095
title: 'reconciler observability: the watch scheduler logs to the board, every PR row in pr-snapshot carries lane, action, reason, owner and lastActionAt, status prints the table, and the planner receives each new routing line once'
status: To Do
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
  - pipeline-cli/src/hierarchy/scheduler.ts
  - pipeline-cli/src/hierarchy/pr-snapshot.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/cli/dispatch.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Workflow audit 2026-10-28. The `reconcile --watch` scheduler started by `cli-hierarchy up` has stdout and stderr on `/dev/null` (checked with `lsof` on pid 67056), so forty-eight minutes of reconciling left no record of what it decided. `.ai-sdlc/dispatch/pr-snapshot.json` lists the 15 open PRs with their merge state only: no lane, action, reason or owner, so "why is #1663 still open" cannot be answered from the board. On the other side the dispatch module forwards the whole reconcile stdout to the planner whenever it contains the substring `route-to-planner` (`ai-sdlc-plugin/hooks/hierarchy/dispatch.ts`), which bypasses the `routeOnce` dedupe and repeats every stored record each tick. Dispatch state that matters is also kept in prose files (`pending-resumes.md`, `pending-arm.md`, `rerun-plan.md`) whose newest entries date from 2026-10-15 and 2026-10-17; nothing reads them.

## Fix

**Five-step review (requirements first).** The requirement questioned is "the scheduler is a background helper, its output does not matter": a reconciler that decides the fate of every PR is the control loop, and a control loop with no log is unverifiable; the real requirement is "every decision about a PR is one readable row with a reason". Deleted: the three prose state files (their open items are re-expressed as board records or dropped with a note in the task PR), and the stdout-substring forwarding. Simplified: one row shape shared by the scheduler log, `pr-snapshot.json`, `cli-hierarchy status` and the planner routing. Accelerated: the operator answers "why is this PR open" from one status line. Automated: a routing line is sent once per `(pr, head, action)` by `routeOnce`, on both the host and the scheduler path.

1. `reconcile-scheduler.ts` / `scheduler.ts`: stdout and stderr go to `.ai-sdlc/dispatch/log/reconcile.log` (append, 5 MB rotate); each run writes one JSON line per PR: `{at, pr, head, lane, state, action, reason, owner, lastActionAt, attempts}`.
2. `pr-snapshot.ts`: the per-PR entry gains the same fields; `cli-hierarchy status` prints `PRs: n open` and a table sorted by age with those columns; `--json` includes them.
3. `ai-sdlc-plugin/hooks/hierarchy/dispatch.ts`: replace the substring forward with `routeOnce` over the structured rows; one `SendMessage` line per new `(pr, head, action)`.
4. `cli/dispatch.ts`: `reconcile` prints the structured rows; the free-text report moves behind `--verbose`.
5. Delete `pending-resumes.md`, `pending-arm.md`, `rerun-plan.md`, `pending-676.md` from the board template and the dispatch command prose; the task PR lists any item from them that is still live and where it now lives.
6. Tests: scheduler log line shape; status table; routeOnce on the host path (same row twice sends once).
7. `docs/operations/cli-hierarchy.md`: the row shape and the log path.

## Acceptance Criteria

- [ ] After `cli-hierarchy up`, `.ai-sdlc/dispatch/log/reconcile.log` receives one row per open PR per run.
- [ ] `cli-hierarchy status` prints every open PR with lane, action, reason, owner and age.
- [ ] A reconcile run repeated with unchanged facts sends the planner nothing; a new routing sends exactly one line.
- [ ] The four prose state files are gone from the board and from every command prose that named them.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
