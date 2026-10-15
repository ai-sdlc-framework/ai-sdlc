---
id: AISDLC-930
title: 'fix: a filed task reaches the dispatch board without a hand-written brief'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [hierarchy, dispatch, pipeline-cli, velocity]
dependencies: []
references: [pipeline-cli/src/hierarchy/dispatch-loop.ts, pipeline-cli/src/hierarchy/dispatch-loop.test.ts, pipeline-cli/src/cli/file.ts, docs/operations/cli-hierarchy.md]
priority: medium
dispatchable: true
---

## Description

The board is fed only by briefs (`ingestBriefs` in `dispatch-loop.ts`). A task filed with `cli-file task --pr` lands on `main` as a backlog file and then waits for the planner to remember it in a brief. Today AISDLC-924, AISDLC-605.1 and AISDLC-613 sat on `main` for hours or days, dispatchable and unblocked, while dispatch ran out of eligible work and the planner answered the repeat reports that 924 fixes. The planner is a model session with a context clear every 150k tokens; "remember to brief it later" is exactly the kind of state it loses.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that every task needs a planner-authored brief before dispatch may see it. A brief adds waves, sequence groups and holds; a single independent task with no dependencies needs none of those. 2. Deleted: the planner's manual "brief the task I just filed" step for the common case. 3. Simplified: `cli-file task --pr` writes a one-task brief (`tasks-<id>.md`, same shape `cli-hierarchy brief --tasks <id>` produces, priority from the task frontmatter) next to the filing PR, so the normal ingest picks it up on the first tick after the PR lands; `--no-brief` opts out for tasks the planner will sequence by hand. Ingest already skips a task that is on the board, so a later hand-written brief naming the same task is harmless. 4. Accelerated: a filed task is claimable on the tick after it lands instead of after the next planner pass. 5. Automated: tests that `cli-file task` writes the brief, that `--no-brief` does not, and that ingest queues it; a `cli-hierarchy doctor`-style listing of dispatchable tasks on `main` that are on no brief and not on the board, printed in the planner orientation so nothing is invisible.

## Acceptance Criteria

- [ ] `cli-file task --pr` writes `.ai-sdlc/dispatch/briefs/tasks-<id>.md` with a one-entry `dispatchBrief` block (no `after`, wave 1, priority from frontmatter); `--no-brief` skips it.
- [ ] A `dispatchable: false` task or one with `blocked.reason` gets no brief.
- [ ] `cli-hierarchy status` (or the planner orientation) lists dispatchable tasks on `main` that are on no brief and not on the board.
- [ ] Tests in `file.test.ts` and `dispatch-loop.test.ts` cover the brief write, the opt-out, the blocked skip and the ingest.
- [ ] `docs/operations/cli-hierarchy.md` describes the auto-brief and when a hand-written brief is still needed (dependencies, sequence groups, holds).
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Observed 2026-10-15: AISDLC-924 (filed in the morning, PR #1620 landed) and AISDLC-605.1 (filed 2026-10-10) were on `main` but on no brief and not on the board until the planner noticed while answering an ai-sdlc-io friction report.
