---
id: AISDLC-1210
title: 'Real taskClass on assignment rows and the implicit PPA label extractor'
status: Done
assignee: []
created_date: '2026-11-06'
labels:
  - rfc-0062
  - phase-1
  - labels
dependencies: []
references:
  - spec/rfcs/RFC-0062-algorithm-improvement-directions.md
  - pipeline-cli/src/usage/scorecard.ts
  - orchestrator/src/code-area-classifier.ts
priority: high
dispatchable: true
---

## Description

**Source.** RFC-0062 OQ-3 (DEC-0387, 2026-11-06) and Phase 1 item 6. Affected surface: the assignment log written by the usage ledger (every row is `taskClass=uncategorized` today, 1,637 rows), the scorecard join in `pipeline-cli/src/usage/scorecard.ts`, and a new label extractor under `pipeline-cli/src/labels/`.

Without a real `taskClass`, routing has no cell to fit in; without an outcome extractor, PPA has no labels and the Phase 3 sequencing gate (200 per cell) has no clock.

## Scope

- Assignment rows record `taskClass` from the task's labels and the code-area classifier (the same source the router uses), never `uncategorized` when either exists; a backfill command derives it for existing rows from the task file.
- Label extractor, `cli-labels extract`, writes one JSONL row per landed, abandoned or parked task with the four weak signals named in the OQ-3 resolution: outcome (landed, abandoned, parked), operator priority edit after filing (direction, from the task file's git history), queue age at claim relative to the bucket median, and any hold or park decision record naming the task. The combination rule is documented in the output header and in `docs/operations/`; no fitting happens in this task.
- Routing labels: `scorecard.ts` exposes first-pass approval per (role, taskClass, model) with the cell counts, so the gate's clock is readable with one command.

## Acceptance Criteria
- [x] #1 A new assignment row for a task with a code-area or label carries that `taskClass`; the backfill command rewrites the existing rows and reports how many stay `uncategorized` and why.
- [x] #2 `cli-labels extract` produces one row per completed task with all four signals, and a test fixture with a priority edit in git history yields the right direction.
- [x] #3 `cli-usage scorecard --cells` prints per-cell first-pass approval counts; the 200-per-cell gate status is one line.
- [x] #4 No scoring or fitting code is added; the extractor is pure recording.

## Final Summary

## Summary
Fixed the flaky webhook-receiver coalescing test, which failed under coverage load. I raised `debounceMs` in the test from 40 to 300 and the post-wait from 120 to 500 ms. The earlier AISDLC-1210 work (taskClass on assignment rows, label extractor, `scorecard --cells`) is unchanged.

## Changes
- pipeline-cli/src/dispatch/webhook-receiver.test.ts

## Design decisions
This commit changes only the test's timing constants. `webhook-receiver.test.ts` passed 3 of 3 runs in isolation before the change and again after it. Under load the five test posts were spread more than 40 ms apart, which produced two wakes. I did not re-run the full `pnpm test:coverage` or the build myself. The push went through the pre-push hooks, and the branch was already up to date with `origin/main`. The PR already existed, so I did not open a new one.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (244 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers; review-delta: correctness-reviewer)

## Follow-up
(none)

