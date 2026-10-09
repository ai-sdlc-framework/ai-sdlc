---
id: AISDLC-760
title: >-
  Dispatch idle hibernation and self-clear on every wake path
status: Done
assignee: []
created_date: '2026-10-08'
labels:
  - hierarchy
  - token-cost
dependencies: []
references:
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - pipeline-cli/src/hierarchy/clear.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - docs/operations/cli-hierarchy.md
priority: critical
dispatchable: true
updated_date: '2026-10-09 18:25'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

The ai-sdlc-io dispatch session (Opus, 690k context) spent $1,320 of API weight in 24 h polling an empty board every 60 s, 40% of the day. The installed 0.24.0 body never clears; the repo body clears but has no idle interval. Full evidence: `docs/audits/2026-10-08-token-leak-loop-and-prose-automation-audit.md`.

## Scope

1. `cli-hierarchy tick` returns `nextWakeSec`: 30 when a brief or verdict is pending, 1800 when the board is empty and nothing is inflight, with an event-driven wake on a new brief or verdict via fs.watch where possible.
2. The no-TMUX_PANE fallback must still clear: document how, or refuse to run without tmux.
3. Fold identity, handoff-file read and mark-ready-after-CodeQL into the tick so operator-dispatch.md shrinks below 120 lines.

Sequencing: none. Model: per DEC-0068 the `--dispatch-model` default in cli-hierarchy up changes from opus to sonnet with this task, and to haiku once the tick is one deterministic call.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] AC-1: An empty-board dispatch session makes at most 2 LLM calls per 30 minutes.
- [x] AC-2: Every wake path starts from the context floor.
- [x] AC-3: operator-dispatch.md is below 120 lines.
- [x] AC-4: Hermetic tests cover nextWakeSec and the no-tmux path.
<!-- AC:END -->

## Final Summary

## Summary
`cli-hierarchy tick` now returns `nextWakeSec` (30 when a brief, verdict, escalation or mark-ready action was handled; 300 when tasks are queued or inflight; 1800 when the board is empty), plus the caller's identity, the handoff file text and the mark-ready-after-CodeQL result. `clear --self` takes the wake interval, wakes early when a brief or verdict file lands, and refuses without tmux. operator-dispatch.md shrank from 312 to 119 lines. The `cli-hierarchy up --dispatch-model` default is now sonnet (DEC-0068).

## Changes
- `ai-sdlc-plugin/commands/operator-dispatch.md` (modified): slimmed to 119 lines, each bash block self-contained.
- `pipeline-cli/src/hierarchy/dispatch-loop.ts` (modified): computeNextWake, handoff and identity in tick.
- `pipeline-cli/src/hierarchy/clear.ts` (modified): wake interval, early board-file wake, no-tmux refusal.
- `pipeline-cli/src/hierarchy/mark-ready.ts` (new): mark-ready-after-CodeQL pass.
- `pipeline-cli/src/cli/hierarchy.ts` (modified): tick output, dispatch-model default.
- `docs/operations/cli-hierarchy.md` (modified): documented.
- Tests for each of the above.

## Design decisions
- **300 s middle tier** for queued/inflight work (not in the task text).
- **Early wake** is a shell poll loop in the detached clear script, not fs.watch.
- **failedAnalyze** does not force the 30 s wake, so a standing failed PR cannot defeat idle hibernation.

## Verification
- `pnpm lint`, `pnpm format:check`, tsc, hierarchy and operator-dispatch tests pass; some bin-invocation, no-bare-paths and execute tests fail identically on main.
- Three reviewers approved (code after one iteration).

## Follow-up
declined: reviewer minor findings (fork/author filter and exact Analyze name match in mark-ready, SAFE_NAME check on planner name, behavioural test of the shell wake loop) are non-blocking hardening; to be raised with dispatch.
