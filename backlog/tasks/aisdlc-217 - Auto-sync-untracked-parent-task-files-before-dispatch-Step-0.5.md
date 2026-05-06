---
id: AISDLC-217
title: Auto-sync untracked parent task files before dispatch (Step 0.5)
status: To Do
assignee: []
created_date: '2026-05-06 14:11'
labels:
  - enhancement
  - pipeline-cli
  - drift-prevention
  - framework-bug
dependencies:
  - AISDLC-216
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Step 0 of `/ai-sdlc execute` self-heals the parent (resets HEAD to `origin/main`) ONLY if the working tree is clean. If parent has untracked files in `backlog/tasks/` (e.g. from prior MCP `task_create` calls that bypassed Pattern C), the self-heal refuses to reset.

Result: parent stays dirty across the whole session, untracked task files never make it to origin, and a `git reset --hard` would silently drop them. Operator had to manually file PR #354 tonight to sync 4 such files.

## Fix

Insert a new pipeline step (Step 0.5) between the existing Step 0 sweep and Step 1 validation:

1. **Detect**: scan parent for untracked files matching `backlog/{tasks,completed}/aisdlc-N*.md`
2. **Verify each is NEW** (not duplicate of an existing on-origin file): `git ls-tree origin/main <path>` returns nothing
3. **If genuinely new**: create a new sync worktree on a generated branch (e.g., `chore/sync-tasks-<sha>`), copy the files there, commit, push, open a docs-only PR titled `chore: sync N untracked task files`, exit Step 0.5 letting the operator handle the sync PR (it'll auto-merge as docs-only)
4. **After sync PR opens**: parent's untracked files get reaped by the next Step 0 self-heal (they're now on origin → no longer "untracked vs origin" semantically; operator can just `git clean -f backlog/tasks/aisdlc-N*.md` or wait for next pull)

## Composes with

- **AISDLC-216 (Pattern-C-aware MCP tools)** is the source-side fix — most untracked files won't appear in the first place. AISDLC-217 is the backstop for cases #216 misses (e.g. external tooling, operator-pasted files).

## Implementation notes

The sync PR should be:
- docs-only (only adds files under `backlog/tasks/`) so paths-ignore + docs-only fallback handle attestation
- auto-mergeable (no required reviews on docs-only)
- non-blocking (Step 0.5 should NOT wait for the sync PR to merge — it just kicks it off and proceeds with main dispatch)

Optional: if the parent has untracked files that AREN'T in `backlog/tasks/` (e.g. orphan attestation envelopes, build artifacts), Step 0.5 should refuse to proceed and surface the manual-cleanup-needed signal to the operator (don't auto-sync arbitrary files).

## Acceptance Criteria
- [ ] #1 New Step 0.5 in pipeline-cli (`pipeline-cli/src/steps/00-5-sync-parent.ts`) detects untracked backlog task files in parent
- [ ] #2 For each genuinely-new file (not on origin/main), opens a sync PR on a fresh worktree
- [ ] #3 Step 0.5 does NOT block — it logs the sync PR URL and proceeds to Step 1 (the sync PR auto-merges in parallel)
- [ ] #4 If non-backlog untracked files exist in parent, Step 0.5 EXITS with operator-attention message (don't auto-sync arbitrary content)
- [ ] #5 Wired into `ai-sdlc-plugin/commands/execute.md` Step 0 section
- [ ] #6 Hermetic test: parent with 3 untracked task files → Step 0.5 opens 1 sync PR with all 3
- [ ] #7 Hermetic test: parent with 1 untracked random file (not in backlog/) → Step 0.5 surfaces error
- [ ] #8 Hermetic test: parent with 1 untracked file matching an already-on-origin path → skipped (already there)
- [ ] #9 Documentation in `ai-sdlc-plugin/commands/execute.md` updated to describe Step 0.5
<!-- SECTION:DESCRIPTION:END -->
