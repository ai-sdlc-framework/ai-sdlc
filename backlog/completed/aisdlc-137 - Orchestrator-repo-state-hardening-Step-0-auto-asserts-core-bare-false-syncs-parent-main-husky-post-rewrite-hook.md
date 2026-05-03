---
id: AISDLC-137
title: >-
  Orchestrator repo state hardening — Step 0 auto-asserts core.bare=false +
  syncs parent main; husky post-rewrite hook
status: Done
assignee: []
created_date: '2026-05-02 16:46'
labels:
  - ci
  - infrastructure
  - orchestrator
  - follow-up
dependencies: []
references:
  - ai-sdlc-plugin/commands/execute.md
  - .husky/post-rewrite
  - scripts/check-orchestrator-state.sh
priority: high
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists: memory:
      project_orchestrator_repo_layout.md
    resolution: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Caught when the parent repo at `` was found 10 commits behind origin/main and `core.bare=true` (preventing `git status`).** This is the recurring problem the operator flagged 2026-05-02: every few sessions, an editor extension or external tool flips `core.bare` back to `true`, the parent's working tree falls out of sync, and worktree creation starts from a stale base.

**Contract** (saved as memory `project_orchestrator_repo_layout.md`): the parent dir at the orchestrator root uses Pattern C — non-bare with worktrees, parent's working tree on main is **read-only**. All edits happen in `.worktrees/<task-id>/`. This makes it safe to auto-sync the parent's working tree to current `origin/main` because nobody edits there directly.

**Three pieces to ship:**

1. **`scripts/check-orchestrator-state.sh`** (new) — runs the assertion + auto-correction:
   - If `core.bare=true`: log warning, set `core.bare=false`
   - `git fetch origin main`
   - `git update-ref refs/heads/main origin/main`
   - If the working tree is CLEAN (no uncommitted modifications and no untracked files outside `.worktrees/` + `backlog/tasks/`): `git reset --hard origin/main`
   - If working tree is DIRTY: log a clear warning naming the dirty files but DO NOT reset (operator-protective; they may have intentional work-in-progress)
   - Idempotent; safe to run repeatedly
   - Hermetic test at `scripts/check-orchestrator-state.test.mjs`

2. **`ai-sdlc-plugin/commands/execute.md` Step 0 update** — invoke `scripts/check-orchestrator-state.sh` before the existing worktree sweep so every dispatch self-heals the parent state.

3. **`.husky/post-rewrite` hook** — fires after any rebase in a worktree (which is the moment the worktree consumed the latest `origin/main`). The hook calls `git -C "$(git rev-parse --git-common-dir)/.." update-ref refs/heads/main origin/main` to keep the parent's local `main` ref current. Non-blocking: failures (e.g. parent unreachable, ref already up-to-date) log but don't fail the rebase.

4. **`.gitignore`** — add `.worktrees/` defensively (it's currently NOT in .gitignore; a future careless `git add .` could try to track worktree directories).

**Why this is high-priority:**
The recurring bare-flip + main-staleness has now caused 3 visible incidents (PR #172 conflict from a stale-base race, today's "main 10↓" status, and earlier worktree creation from stale main). Auto-healing eliminates the manual re-correction every time it recurs.

**Out of scope for this task:**
- Identifying which editor extension flips `core.bare` (operator-machine-specific; can investigate per-machine if it persists)
- Pattern B → Pattern A migration documentation (the contract is already saved as memory)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 scripts/check-orchestrator-state.sh exists; runs from any cwd inside the project; idempotent on a clean state
- [x] #2 Script auto-corrects core.bare=true → false with a warning log line
- [x] #3 Script updates refs/heads/main to origin/main after fetch
- [x] #4 Script runs git reset --hard origin/main ONLY when working tree is clean (no uncommitted tracked changes; only known-untracked items like .worktrees/ allowed)
- [x] #5 Script aborts gracefully with a clear warning when working tree is dirty (lists what's dirty)
- [x] #6 Hermetic test at scripts/check-orchestrator-state.test.mjs covers: clean reset path, dirty-abort path, bare-correction path, ref-already-current no-op
- [x] #7 .husky/post-rewrite hook fires after every rebase in a worktree and updates parent's refs/heads/main to origin/main (non-blocking)
- [x] #8 ai-sdlc-plugin/commands/execute.md Step 0 invokes the new script before the worktree sweep
- [x] #9 .worktrees/ added to .gitignore
- [x] #10 pnpm test passes including the new hermetic test
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Three pieces of orchestrator-state hardening shipped: a `scripts/check-orchestrator-state.sh` self-heal script (auto-corrects core.bare, syncs parent main, never destroys dirty work), a husky `post-rewrite` hook that updates the parent's main ref after every worktree rebase, and `.gitignore` defensive add for `.worktrees/`. Step 0 of `/ai-sdlc execute` invokes the new script before the worktree sweep.

## Changes
- `scripts/check-orchestrator-state.sh` (new) — self-heal: bare-correction + fetch + reset-if-clean / warn-if-dirty
- `scripts/check-orchestrator-state.test.mjs` (new) — 8 hermetic tests covering all branches
- `.husky/post-rewrite` (new) — non-blocking parent main-ref update after worktree rebase
- `.gitignore` — added `.worktrees/`
- `ai-sdlc-plugin/commands/execute.md` — Step 0 now invokes the new script first
- `package.json` — wired `test:orchestrator-state-gate` into `pnpm test`

## Design decisions
- **Reset --hard ONLY when working tree is clean** (operator-protective; never destroy in-progress work). Dirty = warn + skip with file list.
- **`reset --hard origin/main` instead of `update-ref + reset HEAD`** — single op, atomic, also moves refs/heads/main since HEAD is the symref. Simpler logic.
- **post-rewrite uses `git -C "$PARENT_ROOT" update-ref`** — non-blocking: ref-update failure logs but doesn't fail the rebase. Operator's rebase always succeeds even if the parent ref update races.
- **Untracked files ALWAYS preserved** by `reset --hard` (it only touches tracked files). `.worktrees/` + in-flight task drafts survive.

## Verification
- `pnpm test:orchestrator-state-gate` — 8/8 pass (hermetic temp-repo tests)
- `pnpm test` (full workspace) — green
- Real-world verified earlier today via the same pattern (running the script's logic by hand corrected the parent state from 10 commits behind + core.bare=true to current main, no destruction)

## Follow-up (deferred)
- Identify which editor extension flips `core.bare` back (operator-machine-specific; not in any committed file per grep)
- Optionally: add the same self-heal to a daily cron via GitHub Action (low priority; the per-dispatch invocation handles the common case)
<!-- SECTION:FINAL_SUMMARY:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Three pieces of orchestrator-state hardening shipped: a `scripts/check-orchestrator-state.sh` self-heal script (auto-corrects core.bare, syncs parent main, never destroys dirty work), a husky `post-rewrite` hook that updates the parent's main ref after every worktree rebase, and `.gitignore` defensive add for `.worktrees/`. Step 0 of `/ai-sdlc execute` invokes the new script before the worktree sweep.

## Changes
- `scripts/check-orchestrator-state.sh` (new) — bare-correction + fetch + reset-if-clean / warn-if-dirty
- `scripts/check-orchestrator-state.test.mjs` (new) — 8 hermetic tests covering all branches
- `.husky/post-rewrite` (new) — non-blocking parent main-ref update after worktree rebase
- `.gitignore` — added `.worktrees/`
- `ai-sdlc-plugin/commands/execute.md` — Step 0 invokes the new script first
- `package.json` — wired `test:orchestrator-state-gate` into `pnpm test`

## Design decisions
- Reset --hard ONLY when working tree is clean (operator-protective; never destroy in-progress work). Dirty = warn + skip with file list.
- `reset --hard origin/main` instead of `update-ref + reset HEAD` — single op, atomic, also moves refs/heads/main since HEAD is the symref.
- post-rewrite uses `git -C parent update-ref` non-blocking — failures log but don't fail the rebase.
- Untracked files always preserved by reset --hard (only touches tracked files).

## Verification
- `pnpm test:orchestrator-state-gate` — 8/8 pass
- `pnpm test` — green
- Real-world verified earlier today: same script logic corrected the parent state from 10-commits-behind + core.bare=true to current main without destruction

## Follow-up (deferred)
- Identify which editor extension flips core.bare back (operator-machine-specific; not in any committed file per grep)
- Optionally: daily cron via GH Action (low priority; per-dispatch handles common case)
<!-- SECTION:FINAL_SUMMARY:END -->
