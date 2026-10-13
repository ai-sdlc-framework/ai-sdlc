---
id: AISDLC-829
title: >-
  Dispatch tick sweeps open PRs: a red required check or a conflict becomes a board event and is re-queued with the matching note
status: To Do
assignee: []
created_date: '2026-10-13'
labels:
  - dispatch
  - hierarchy
  - velocity
  - root-cause
dependencies:
  - AISDLC-826
references:
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/playbook.ts
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (operator, 2026-10-13 00:50Z).** 22 PRs were open with only one being worked, and a planner filing PR (#1447) sat red for an hour with nothing noticing. Nothing in the system owns "open PR with a red required check": the dispatch tick (`dispatch-loop.ts`) watches board verdicts, not PRs; planner filing PRs never touch the board; the AISDLC-460 ci-failure-watcher is code behind a manual command (`/ai-sdlc resolve-conflicts`); `auto-enable-auto-merge.yml` arms and then does nothing. The drain's definition of done is a PR on main (DEC-0127), yet the only component that reacts to a red PR is a person reading the PR page. Today's red PRs fell into a handful of shapes that dispatch already knows how to resume: orphaned attestation after a rebase (DEC-0142 hand-review path), Step 10.5 dirty-tree stop (DEC-0153 clean-and-resume), `node --test` regressions in named files, cancelled superseded runs, a drift error, a one-file conflict.

**Five-step review (requirements first).** Delete: the AISDLC-460 ci-failure-watcher runtime and the `/ai-sdlc resolve-conflicts` command as the only PR-failure path (step 2).
1. Requirement questioned: "a task is done when its executor writes a verdict" (RFC-0051 board design). Wrong for the drain: done is merged. A red PR must be a board event, otherwise every gate added to `ai-sdlc/pr-ready` is invisible to the drain until a human looks.
2. Delete: `pipeline-cli/src/runtime/ci-failure-watcher.*` and the `resolve-conflicts` command body that imports it (keep a one-paragraph pointer, as the retired commands have); the sweep below replaces them inside the loop that already runs.
3. Simplify: one PR sweep in the existing dispatch tick (same 300 s wake, no new loop, no new session). For every open non-draft PR against main whose required rollup is red, whose head is `CONFLICTING`, or whose checks are all from a cancelled superseded run: resolve the task id from the branch name or title (`AISDLC-N`; a filing PR with no task id is reported, not re-queued), classify by the failing job or state with a small fixed table — `Verify attestation`/`Attestation gate` → DEC-0142 hand-review note; `rebase-conflict`/`CONFLICTING` → rebase-first prefix; `Build & Test` with a `node --test` summary → note naming the failing test files parsed from the log; cancelled superseded run → re-push note; anything else → failed verdict whose `cause` is the job name — and `cli-dispatch resume` it with that note when the task has no inflight claim and is not already queued. Idempotent: a PR already queued or inflight is skipped; a PR re-queued by the sweep is recorded in the loop state with its head sha, so the same head is never re-queued twice.
4. Accelerate: a red PR is back on the board within one tick instead of hours; the planner is not consulted.
5. Automate: nothing beyond the sweep; the notes are the existing templates.

**Velocity impact.** Positive: closes the blind spot that left 22 PRs open; every future gate added to the rollup is drained automatically or shows up as a named failed verdict.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 The dispatch tick runs a PR sweep each wake: open, non-draft, base main, required check red or `mergeable == CONFLICTING` or all checks from a cancelled run; one `gh` list call plus one view per candidate; tolerant of `gh` failures (sweep skipped, reported in the tick result)
- [ ] #2 Classification table with hermetic tests for each shape: attestation red → DEC-0142 note; conflict → rebase-first prefix; `node --test` failure → note naming the failing files; cancelled superseded → re-push note; unknown → failed verdict with `cause: <job name>`
- [ ] #3 `cli-dispatch resume` is called with the note only when the task is neither queued nor inflight; a `(head sha, task)` pair is re-queued at most once (loop state), covered by a test
- [ ] #4 A PR with no task id in branch or title (filing PRs) is listed in the tick result's progress line as `unowned red PR #N <job>`; never re-queued
- [ ] #5 `pipeline-cli/src/runtime/ci-failure-watcher.*` is deleted and `/ai-sdlc resolve-conflicts` becomes a one-paragraph pointer to the sweep; `pnpm dark-code:check` passes
- [ ] #6 `docs/operations/cli-hierarchy.md` documents the sweep, the table and the idempotency rule
- [ ] #7 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test && pnpm dark-code:check`
- `pnpm lint && pnpm format:check`
