---
id: AISDLC-1047
title: 'cli-dispatch reprioritize --note must never overwrite resume.note on a queued manifest'
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - dispatch
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/dispatch/reprioritize.ts
  - pipeline-cli/src/dispatch/types.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

**Context (dispatch finding, 2026-10-23 ~02:40Z).** Dispatch ran `cli-dispatch reprioritize AISDLC-1033 --priority 0 --note ...` on a queued manifest that already carried a `resume` block. The resume note held the executor's instructions for the next attempt: worktree cleanup steps first, then the "developer round required" note with the two-part fix. `reprioritizeQueued` (`pipeline-cli/src/dispatch/reprioritize.ts`, line 37: `resume = { ...existing, note }`) replaced that note with the reorder text, wiping the instructions. Dispatch caught it by reading the manifest back and restored it by dequeue plus write-manifest before any executor claimed. Had an executor claimed first, the resume would have run without its instructions and reproduced the same red.

**Root cause.** The design chosen under the earlier reprioritize fix (store the note in `resume.note` when a resume block exists, else in `reorderNote`) still lets an audit note overwrite an execution instruction. The two fields have different owners: `resume.note` belongs to the reconciler and the reenter path, `reorderNote` belongs to reprioritize. Reprioritize must write only its own field.

**Five-step review (requirements first).**
1. Requirement questioned: does reprioritize need a `--note` flag at all? Kept: the audit trail of why a task was reordered is useful, but it is metadata and never an execution signal.
2. Delete: the branch that writes `resume.note` (the `existing ? {...existing, note} : reorderNote` split). `--note` always lands in `reorderNote`; an existing `resume` block is copied through untouched.
3. Simplify: one code path, one field; the `note` option comment and the module header describe `reorderNote` only.
4. Accelerate: `cli-dispatch reprioritize` prints the manifest's `resume.note` first line after the write when a resume block exists, so dispatch sees in the command output that the instructions survived instead of reading the file back.
5. Automate: a unit test for `reprioritizeQueued` with a manifest that has a `resume` block and a note, asserting the note is byte-identical after `--note` and that `reorderNote` holds the new text; a second test for the never-started case keeps the earlier fix covered.

**Velocity impact.** Positive: a reorder can no longer silently destroy a reenter note, which otherwise costs a wasted executor round and a manual manifest rewrite.

## Acceptance Criteria

- [ ] `reprioritizeQueued` never writes `resume.note`; with `--note` on a manifest that carries a `resume` block, the block is unchanged and `reorderNote` holds the new text.
- [ ] Unit tests cover both the resume-present and the never-started cases, with the resume note asserted byte-identical.
- [ ] The command output names the surviving resume note (first line) when a resume block exists.
- [ ] `docs/operations/cli-hierarchy.md` reprioritize entry states that `--note` is audit metadata stored in `reorderNote` and never touches `resume`.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
