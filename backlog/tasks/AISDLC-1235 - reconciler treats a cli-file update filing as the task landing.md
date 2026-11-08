---
id: AISDLC-1235
title: 'Reconciler treats a cli-file --update filing PR (ai-sdlc/update-<id>) as the task''s own PR and marks the task landed'
status: In Progress
assignee: []
created_date: '2026-11-08'
labels:
  - dispatch
  - reconciler
  - bug
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
priority: high
dispatchable: true
dispatchableReason: 'Backlog-pressure fix: a filing PR that only edits a task file closed AISDLC-1179.1 on the board with a success verdict and no code; planner filed 2026-11-08 under DEC-0399.'
---

## Description

**Observed 2026-11-08.** `cli-file task --update --pr` on AISDLC-1179.1 opened PR #2546 on branch `ai-sdlc/update-aisdlc-1179.1` (title `chore(docs): file backlog task AISDLC-1179.1 ...`). When it merged (27afc606), the reconciler wrote a landing record `kind: task, state: merged, action: mark-landed, taskId: AISDLC-1179.1` and rewrote the task's `failed/` verdict into `done/` with `outcome: success`, `landedSha: 27afc606`, `prUrl: null`. No worktree, code PR or AC-4 work existed. The task file stayed in `backlog/tasks/`.

**Cause.** `detectKind()` in `pipeline-cli/src/hierarchy/reconcile.ts` classifies a PR as `docs` only when the head branch starts with one of `DOCS_BRANCH_PREFIXES` (`ai-sdlc/file-`, `docs/`). The `--update` filing branch `ai-sdlc/update-<id>` is not listed, `taskIdFrom()` still finds the task id (from the title), so the PR is `task` and its merge is the task's landing.

## Fix

**Five-step review (requirements first).**
1. Question: must a filing PR ever land a task? No: landing means the task's code PR merged (CLAUDE.md "Done semantics").
2. Delete: nothing to delete.
3. Simplify: one prefix added to `DOCS_BRANCH_PREFIXES` (`ai-sdlc/update-`), so `detectKind()` returns `docs` for update filings; the docs lane already lands them.
4. Accelerate: none needed.
5. Automate: a test that a merged `ai-sdlc/update-aisdlc-1234.1` PR with a task id in the title yields kind `docs` and action `none`/docs-lane, never `mark-landed` for the task.

Also check `mark-ready.ts` (`TASK_BRANCH_RE = /^ai-sdlc\//`) and `superseded.ts` for the same over-match and tighten them only where a filing branch would be treated as a task branch.

## Acceptance Criteria

- [ ] AC-1: `detectKind({ headBranch: 'ai-sdlc/update-aisdlc-1179.1', title: 'chore(docs): file backlog task AISDLC-1179.1', taskId: 'AISDLC-1179.1' })` returns `docs`; a unit test covers it beside the existing `ai-sdlc/file-` case.
- [ ] AC-2: a merged update filing PR produces no `mark-landed` action and never writes or rewrites a `done/` verdict for the task; test at the classify/landing level.
- [ ] AC-3: `cli-file task --update` and the reconciler share the branch prefix from one exported constant, so the two cannot drift.
- [ ] AC-4: `mark-ready.ts` and `superseded.ts` either exclude `ai-sdlc/update-` and `ai-sdlc/file-` branches or the PR body states why their current match is harmless.
- [ ] AC-5 (reversal path): `cli-dispatch remove-verdict --task-id <id> --from done --with-manifest --unland --reason <text>` (or an equivalent sanctioned subcommand) removes a completion marker written by a false `mark-landed`, logs a board event with the reason, and refuses while the task has a merged code PR; today no CLI removes `.completed.json` and the id stays taken forever (DEC-0399 had to move the work to AISDLC-1236).
- [ ] AC-6: `docs/operations/cli-hierarchy.md` reconciler section names the update filing as a docs-lane PR.
