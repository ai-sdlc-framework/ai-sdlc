---
id: AISDLC-1015
title: >-
  cli-dispatch reprioritize must not synthesize a resume block on a never-started queued task
status: To Do
assignee: []
created_date: '2026-10-21'
labels:
  - dispatch
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/dispatch/reprioritize.ts
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/execute-pipeline.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (dispatch finding, 2026-10-21 ~18:35Z).** The planner ruled a claim order and dispatch pinned it with `cli-dispatch reprioritize --priority ... --note ...` on three queued tasks that had never been claimed. `reprioritizeQueued` (`pipeline-cli/src/dispatch/reprioritize.ts`) attaches the note by synthesizing a `resume` block (`resumedBy: reprioritize`) when the manifest has none. The executor's `next-step` then treats the manifest as a resume, looks for the task branch, finds none (the task never ran), and refuses the claim. Three first claims failed; dispatch recovered by dequeuing and rewriting the manifests by hand without the block. A plain `requeue` keeps the block, so the only recovery was manual.

**Root cause.** A reorder note is audit metadata; a `resume` block is an execution signal that means "a previous attempt left a branch". Reprioritize conflates the two.

**Five-step review (requirements first).**
1. Requirement questioned: "a reorder may carry a note". Kept, but the note must never change how the task executes.
2. Delete: the branch in `reprioritizeQueued` that fabricates a `resume` object when none exists.
3. Simplify: when a `resume` block already exists, update only its `note` (today's behaviour); when none exists, store the note in a plain audit field on the manifest (`reorderNote`, or drop it and let `--note` refuse on a never-started task with a clear message). Pick the first unless the manifest schema makes it costly; the task's PR body states the choice.
4. Accelerate: `next-step` rejects a `resume` block whose branch does not exist with a message naming the manifest field, so a bad manifest is diagnosed in one line instead of a failed claim per executor.
5. Automate: a unit test in `reprioritize` covering the never-started case, and one in the claim path covering "resume block, no branch" (refusal text asserted).

**Velocity impact.** Positive: a planner reorder no longer costs one failed claim per task plus a manual manifest rewrite.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `reprioritizeQueued` on a queued manifest with no `resume` block never writes one; the note (if kept) lands in a non-execution field and `next-step` ignores it
- [ ] #2 `reprioritizeQueued` on a manifest with an existing `resume` block updates only `resume.note` (regression test)
- [ ] #3 The claim path refuses a `resume` manifest whose branch is missing with a message that names the manifest and field, and leaves the manifest queued (no silent failed claim)
- [ ] #4 `docs/operations/cli-hierarchy.md` reprioritize section states that `--note` does not create a resume
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli test -- reprioritize` and the claim-path tests
- `pnpm build && pnpm test && pnpm lint && pnpm format:check`
