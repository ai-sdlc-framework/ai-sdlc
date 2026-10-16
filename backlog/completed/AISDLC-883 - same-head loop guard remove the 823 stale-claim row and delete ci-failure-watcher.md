---
id: AISDLC-883
title: 'feat(dispatch): same-head loop guard for PR follow-ups; remove the 823 stale-claim row in favour of 826; delete ci-failure-watcher as a duplicate poller'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [rfc-0054, phase-1, dispatch]
dependencies: [AISDLC-829]
references:
  - spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md
  - pipeline-cli/src/dispatch/requeue.ts
  - pipeline-cli/src/hierarchy/pr-state.ts
  - pipeline-cli/src/hierarchy/stall.ts
  - pipeline-cli/src/runtime/ci-failure-watcher.ts
priority: high
dispatchable: true
---

## Context

RFC-0054 OQ-3 and OQ-9 (resolved 2026-10-14). AISDLC-847 bypasses the retry cap when the failed task has an open PR; that bypass is unbounded, so a rebase-red-rebase loop runs forever and costs a reviewer round each pass. AISDLC-823's classifier has a `stale-claim` row at the same 30-minute threshold as AISDLC-826's stall detector, so a stalled claim has two owners. `ci-failure-watcher` (AISDLC-460) is a second 60-second `gh` poller with its own classification and its own spawner, beside the state machine.

## Fix

**Five-step review (requirements first).** Requirement questioned: "a retry count bounds PR follow-ups". No: unlike failures must not add up; the loop signature is an action that did not change the head. Deleted: the `stale-claim` row of `pr-state.ts` (826 owns it), `ci-failure-watcher.ts` and its spawner wiring in `runtime/index.ts` and `cli/orchestrator.ts`. Simplified: one poller (the 829 reconciler), one stall owner. Accelerated: nothing; this is a deletion and a guard. Automated last: the guard parks to the planner with the `(state, action, headSha)` pair as the note.

1. Loop guard: before any machine action on a PR, read `landing/<pr>.json` history; if the same `(action, headSha)` was already taken, do not act; write `route-to-planner` with the pair and the count as the note. A new head SHA resets the guard. The count cap in `requeue.ts` stays for PR-less failures (847's `prUrl`/`prNumber` bypass is kept and the guard sits beside it).
2. Remove `stale-claim` from `PR_STATES`/`PR_ACTIONS` and its tests; `stall.ts` is the only stale-claim path.
3. Delete `pipeline-cli/src/runtime/ci-failure-watcher.ts`, its test, and the `isRebaseFixable` import in `playbook.ts` (move the function next to the classifier if 829 still needs it); remove the watcher from the runtime index and the orchestrator CLI; `ci-conflict-resolver` agent is reached only through the state machine's actions.
4. `docs/operations/cli-hierarchy.md`: document the guard and the single-poller rule.

**Configuration (operator ruling 2026-10-14).** Every repository convention this task uses (docs-only paths, no-task branch prefixes, timers, ports, thresholds) is read from `.ai-sdlc/pr-lifecycle.yaml` (RFC-0054, Design Details, Configuration) with the documented defaults; nothing is hard-coded in TypeScript, workflow YAML or command prose. The first of these tasks to land creates the file with the defaults; the others read it.

## Acceptance Criteria

- [x] Config: no convention value (path pattern, branch prefix, timer, port, threshold) appears as a literal in source, workflow or command body touched by this task; each is read from `.ai-sdlc/pr-lifecycle.yaml`, and one test shows that changing a config value changes the behaviour.
- [x] A fixture where `rebase` on head H leaves the PR DIRTY twice: the second classification yields `route-to-planner` with note `rebase@H x2` and no second rebase runs; after a push to head H2 the guard allows one rebase again.
- [x] A PR-less task still parks after the configured retry count (847 behaviour preserved for `prUrl: null`).
- [x] `pr-state.ts` has no `stale-claim` state; `stall.ts` tests cover the 30-minute and 10-minute-idle cases alone.
- [x] `ci-failure-watcher.ts` is gone; `grep -r ci-failure-watcher pipeline-cli/src orchestrator/src` returns only the docs and this task; the dark-code gate passes without a baseline addition.
- [x] `docs/operations/cli-hierarchy.md` describes the guard.

## Verification

`pnpm build && pnpm test && pnpm lint && pnpm format:check` (dark-code check included).

## Out of scope

The `reenter` command (AISDLC-882); webhook ingest (AISDLC-880).
