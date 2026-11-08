---
id: AISDLC-1204
title: 'A landed task leaves blocked without being requeued'
status: Done
assignee: []
created_date: '2026-11-06'
labels:
  - dispatch defect triage
dependencies: []
references:
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/cli/dispatch.ts
priority: low
dispatchable: true
dispatchableReason: 'Unparked 2026-11-07 by operator ruling (planner critical-path review).'
---

## Description

**Source.** Planner session 2026-11-06; filed on operator go (decision rubric, same day). Triaged; Unparked 2026-11-07 by operator ruling (planner critical-path review).

AISDLC-1191 landed at 2cd45a9f (#2411), but its board record stays in `blocked/` with reason "awaiting gate re-run". The only exit, `cli-dispatch unblock`, moves the task back to the queue, which would re-dispatch landed work. `cli-hierarchy status` keeps listing it as blocked.

## Acceptance Criteria
- [x] #1 The landing reconciler (or a `cli-dispatch` subcommand) moves a blocked task whose PR merged to done, recording the merge sha.
- [x] #2 A test covers a blocked task whose PR merged.

## Final Summary

## Summary
A task parked in blocked/ whose PR merged now moves to done/ with a success verdict that records the merge sha and PR number. The landing reconciler does this on every merged PR, and the `cli-dispatch retire-landed` sweep applies it to landing records that already exist.

## Changes
- pipeline-cli/src/dispatch/retire-landed.ts
- pipeline-cli/src/dispatch/retire-landed.test.ts
- pipeline-cli/src/hierarchy/reconcile.ts
- backlog/tasks/AISDLC-1204 - a landed task leaves blocked without being requeued.md

## Design decisions
The first full `pnpm test` run had one node:test failure that I did not identify. A second full run was clean, so I assume it was flaky. Docs-branch and non-task PRs are skipped, matching the existing `retireFailedVerdict` guard. The task file status change to In Progress is committed with the branch.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

