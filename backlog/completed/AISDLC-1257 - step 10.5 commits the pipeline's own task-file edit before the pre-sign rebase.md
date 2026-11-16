---
id: AISDLC-1257
title: step 10.5 commits the pipeline's own task-file edit before the pre-sign rebase
status: Done
assignee: []
created_date: '2026-11-09'
labels:
  - fix
  - pipeline-cli
  - execute
dependencies: []
priority: high
dispatchable: true
---

## Description

Reported 2026-11-09 by the ai-sdlc-io planner (IO-42 PR 160, IO-53): after both reviewers approve and verification is green, Step 10.5 (`pipeline-cli/src/next-step/ship.ts`, the pre-sign rebase) fails with `rebase refused (dirty-worktree)`. The dirty path is the task file under `backlog/tasks/`, whose status step 4 (`04-flip-status` in `execute-pipeline.ts`) rewrote from `To Do` to `In Progress` and never committed. The message also lists untracked `.active-task`, `.ai-sdlc/.last-build-sha` and `.ai-sdlc/review-state/`; those do not block `git rebase` (untracked files only block when the rebase would overwrite them) and are gitignored in this repo, but an adopter repo whose `.gitignore` lacks the entries sees them in the dirty list and cannot tell which path is the real refusal.

The monorepo rarely hits this because the developer usually moves the task file to `backlog/completed/` in its own commit, absorbing the flip. When the developer leaves the task file alone, a correct run fails deterministically after a successful review.

## Five-step review (requirements first)

1. **Question the requirement.** The pre-sign rebase must run on a clean index so the patch-id it signs is what lands. Required. The status flip itself is pipeline bookkeeping; nothing requires it to stay uncommitted.
2. **Delete.** Nothing deleted; the refusal path stays (it protects against real developer residue).
3. **Simplify.** One rule: before the rebase, Step 10.5 commits the pipeline's own task-file edit the same way it already commits the review ledger (AISDLC-848/951 pattern, `chore: commit task status (<id>)`), scoped to `backlog/tasks/<id>*.md`. Any other dirty tracked path still refuses, and the dirty list names only tracked paths (`git status --porcelain --untracked-files=no`), with untracked runtime files listed separately as a hint ("not gitignored in this repo").
4. **Accelerate.** No new git round trips beyond the one `status` already run.
5. **Automate last.** No new gate.

## Acceptance Criteria

- [x] Step 10.5 commits an uncommitted modification to the task's own file under `backlog/tasks/` before `git rebase`, using the same commit path as the review ledger; the commit is omitted when the file is clean or already moved.
- [x] A dirty tracked path that is not the task file or the ledger still fails with `dirty-worktree`, and the `Dirty paths:` list contains tracked paths only.
- [x] Untracked `.active-task`, `.ai-sdlc/.last-build-sha` and `.ai-sdlc/review-state/` are reported in a separate `Untracked runtime files (add to .gitignore):` note, never as the cause.
- [x] Unit tests in `pipeline-cli/src/next-step/__tests__/` cover: flip-only dirt (rebase proceeds, one chore commit), flip plus foreign dirt (refuses, names the foreign path only), task file already moved to `backlog/completed/` (no commit).
- [x] `docs/operations/backlog-and-execution-reference.md` Step 10.5 paragraph names the task-file commit next to the ledger commit.

## Notes

- Alternative considered: committing the flip in step 4 (begin-task). Rejected for now: step 4 runs before the developer, and a commit there changes the base every developer round sees and the push-count assumptions of AISDLC-1227 (Step 11 is the sole pusher). Step 10.5 already owns "commit pipeline residue before the rebase".
- Adopter-side: the io repo `.gitignore` lacks the three runtime entries. Whether `ai-sdlc init` should scaffold them is a separate question for the io planner; not in scope here.
- Source: cross-session message from ai-sdlc-io-planner 2026-11-09 ~15:4xZ (IO-42 round 2 commit 2150f8b, IO-53 dev commit af0c0a7).

## Final Summary

## Summary
Step 10.5 now commits an uncommitted task-file edit under backlog/tasks/ together with the review ledger before the pre-sign rebase. No commit is made when the file is clean or already under backlog/completed/. The dirty-worktree note lists tracked paths only, and the untracked runtime files go in a separate 'Untracked runtime files (add to .gitignore):' note.

## Changes
- pipeline-cli/src/next-step/ship.ts
- pipeline-cli/src/next-step/ship.test.ts
- docs/operations/backlog-and-execution-reference.md

## Design decisions
The three new tests run against real git: flip-only, flip plus foreign dirt, and task file already moved to backlog/completed/. The pipeline's own In Progress status flip of the AISDLC-1257 task file is not in the pushed commit. It is a local uncommitted change, which the pipeline can commit under the new behaviour, so the branch has 1 commit. The git add runs once per path, because a single pathspec matching nothing (no ledger yet) fails the whole add. The push has to be run as a bare git -C <worktree> push --force-with-lease ... command, because the hook rejects it when it follows cd && or a pipe.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

