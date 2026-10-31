---
id: AISDLC-1141
title: 'Fix-on-PR enqueue resolves a task file in backlog/completed; a completed task without fixesPr is refused with a reason'
status: In Progress
assignee: []
created_date: '2026-10-31'
labels:
  - pipeline-cli
  - hierarchy
  - dispatch
dependencies: []
references:
  - pipeline-cli/src/cli/dispatch.ts
  - pipeline-cli/src/cli/dispatch.test.ts
  - pipeline-cli/src/dispatch/enqueue.ts
  - pipeline-cli/src/dispatch/enqueue.test.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

On 2026-10-31 main was RED on the plugin runtime pin drift check and PR #2209 (branch `chore/sync-runtime-pins-0.34.0`, task AISDLC-574) was the one-commit fix. Dispatch could not enqueue the ready fix-on-PR brief (`fixesPr: 2209`, `prHeadRef`) because `enqueueTasks` threw `no backlog task file found for AISDLC-574`. The resolver `findTaskFile` in `pipeline-cli/src/cli/dispatch.ts` (around line 1687) is case-insensitive but scans only `backlog/tasks`; AISDLC-574 is a finished task in `backlog/completed`. Every fix-on-PR entry for a completed task hits the same wall, so the fix-on-PR lane cannot repair a PR that a bot or the release workflow opened for a task that is already done. `pipeline-cli/src/dor/dispatch-readiness.ts` `findTaskFile` and `steps/01-validate.ts` (`includeCompleted`) already scan both directories.

**Five-step review (requirements first).**
1. Requirement questioned: must a fix-on-PR entry name a backlog task at all? Yes: the manifest's `spec.taskFile` drives the developer prompt and the verify commands, and the completed task file is the only record of the acceptance criteria. A rename of the task file (the first proposed fix) was wrong: the resolver lowercases both sides already.
2. Delete: the private `findTaskFile` in `cli/dispatch.ts` duplicates `dor/dispatch-readiness.ts findTaskFile` minus the completed scan and plus the `<id>-<slug>.md` shape; keep one resolver that accepts both shapes and scans both directories, delete the other.
3. Simplify: `enqueueTasks` refuses a resolved `backlog/completed` file when the entry has no `fixesPr`, with the reason `task <id> is completed; fix-on-PR entries need fixesPr`, so a plain re-enqueue of finished work still fails closed.
4. Accelerate: nothing; one `readdirSync` per directory.
5. Automate: tests for both cases; `docs/operations/cli-hierarchy.md` fix-on-PR section names the rule.

Velocity impact: a red main caused by a bot PR on a finished task is repairable through the pipeline without a planner or operator push.

## Acceptance Criteria

- [ ] AC-1: `cli-hierarchy` brief enqueue and `cli-dispatch enqueue` of an entry with `fixesPr` and `prHeadRef` whose task file lives only in `backlog/completed/` (any filename case, both `<id> - <title>.md` and `<id>-<slug>.md` shapes) writes a queue manifest whose `spec.taskFile` points at that completed file.
- [ ] AC-2: The same entry without `fixesPr` is refused with a message naming the task id and that `fixesPr` is required; an open task in `backlog/tasks/` enqueues as before.
- [ ] AC-3: One task-file resolver remains for the dispatch and hierarchy CLIs (the `dor/dispatch-readiness.ts` one or a shared module), unit-tested for both directories and both shapes; `docs/operations/cli-hierarchy.md` documents the rule; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## Notes

Origin: planner diagnosis 2026-10-31 of dispatch's #2209 blocker (operator ruling: pipeline route, no manual push). Unblocks the ready brief `.ai-sdlc/dispatch/briefs/tasks-aisdlc-574-fix-2209.md`. Sibling PR-pressure tasks: AISDLC-1137, AISDLC-1138, AISDLC-1139, AISDLC-1140.
