---
id: AISDLC-224
title: >-
  Orchestrator Step 3 should auto-cleanup stale worktree branches before
  retrying dispatch
status: In Progress
assignee: []
created_date: '2026-05-06 19:49'
labels:
  - enhancement
  - orchestrator
  - framework-bug
  - rfc-0015
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

When `cli-orchestrator tick` dispatches a task and Step 3 (`git worktree add`) fails because a branch with the target name already exists from a prior session, the orchestrator returns `{ outcome: 'aborted', notes: 'Likely cause: branch already exists. Run `/ai-sdlc cleanup AISDLC-N` first or pick a different task.' }` and moves on.

That's correct behavior in the manual `/ai-sdlc execute` path (operator runs cleanup, retries). In the **autonomous orchestrator** path the same task gets re-picked every tick and re-fails with the same error — the orchestrator can't make progress on it without operator intervention.

Witnessed empirically 2026-05-06: end-to-end test of `cli-orchestrator tick` against AISDLC-115 hit this exact failure mode at Step 3 because a prior session's worktree branch was still on disk.

## Proposed design

The autonomous orchestrator path should detect the "branch already exists" failure mode and self-heal by invoking the same cleanup logic `/ai-sdlc cleanup` would run. Two design options:

### Option A — Auto-cleanup on stale-branch failure (recommended)

In `pipeline-cli/src/steps/03-setup-worktree.ts`, when `git worktree add` fails with the specific "branch already exists" stderr pattern AND the orchestrator-context flag is set (e.g., `opts.autonomousMode === true`):

1. Check if the existing branch has an OPEN PR. If yes → abort (don't clobber operator's in-flight work).
2. Check if the existing worktree directory exists at `.worktrees/<task-id>/`. If yes:
   - Verify HEAD has no uncommitted/unstaged changes
   - Run `git worktree remove --force .worktrees/<task-id>/`
3. Run `git branch -D <branch>` to delete the stale local branch.
4. Retry the original `git worktree add` once.
5. If retry also fails → abort with the original error (don't loop infinitely).

### Option B — Pre-tick sweep

`cli-orchestrator tick` runs an extended Step 0-style sweep BEFORE picking from the frontier:

- For each task ID in the frontier, check if a `.worktrees/<task-id>/` exists with a branch that has NO open PR.
- If yes → assume it's stale state from a prior session that aborted before Step 11 → clean it up.

Option B is more proactive but does work for tasks not at the front of the queue. Option A is more focused and fires only when needed.

**Recommendation:** Option A. The cost is one stderr-pattern match in Step 3; the win is autonomous orchestration unblocked for the common stale-state case.

## Safety constraints

- NEVER auto-clean a worktree with an open PR (operator's in-flight work)
- NEVER auto-clean a worktree with uncommitted changes (potential lost work)
- NEVER auto-clean if the branch is checked out somewhere else
- Feature-flagged: `AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP=1` for opt-in until soak proves safe

## Acceptance Criteria

- [ ] #1 `pipeline-cli/src/steps/03-setup-worktree.ts` detects "branch already exists" stderr from `git worktree add` and, when `opts.autonomousMode === true`, attempts the cleanup-then-retry path
- [ ] #2 Cleanup safety predicates implemented: open-PR check, uncommitted-changes check, branch-checked-out-elsewhere check — all 3 must pass before cleanup proceeds
- [ ] #3 Feature flag `AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP` (canonical truthy values per CLAUDE.md feature-flag conventions) gates the auto-cleanup path; default OFF
- [ ] #4 New `WorktreeAutoCleaned` event emitted to `_events.jsonl` per RFC-0015 §observability when cleanup fires (taskId, reason, branch, hadOpenPR=false, hadUncommittedChanges=false)
- [ ] #5 Hermetic test: fixture worktree with stale branch + no open PR + clean working tree → cleanup succeeds + retry succeeds + WorktreeAutoCleaned event present
- [ ] #6 Negative test: stale branch + open PR → cleanup refuses + original error returned
- [ ] #7 Negative test: stale branch + uncommitted changes → cleanup refuses + original error returned
- [ ] #8 `cli-orchestrator tick`/`start` set `autonomousMode: true` when invoking the pipeline (manual `/ai-sdlc execute` path leaves it false → no behavior change)
- [ ] #9 `docs/operations/orchestrator-runbook.md` documents the auto-cleanup behavior + the safety predicates + the feature flag

## Composes with

- **AISDLC-223** (BlockedFilter): the two together unblock unattended orchestrator operation. AISDLC-223 prevents wasted ticks on tasks that need an external signal; this task prevents wasted ticks on tasks whose worktree state needs reset.
- **RFC-0015 Phase 5** (hardening / soak): this is a hardening item — could ride along with the chaos-test harness work.

## References

- `pipeline-cli/src/steps/03-setup-worktree.ts` (where the change goes)
- `ai-sdlc-plugin/commands/cleanup.md` (mirror the cleanup logic)
- `pipeline-cli/src/orchestrator/loop.ts` (where `autonomousMode` flag would propagate)
- AISDLC-115 (the canonical witness — orchestrator hit this 2026-05-06)
<!-- SECTION:DESCRIPTION:END -->
