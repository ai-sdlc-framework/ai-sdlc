---
id: AISDLC-708
title: >-
  Parent checkout index and working tree go stale behind a current HEAD
status: Done
assignee: []
created_date: '2026-10-04'
labels:
  - bug
  - orchestrator
dependencies: []
references:
  - scripts/check-orchestrator-state.sh
  - ai-sdlc-plugin/hooks/check-plugin-version.js
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-10-03 the orchestrator's parent checkout was on main at the release commit while
its index and working tree held older versions of 119 tracked paths (staged
modifications and staged deletions, no unstaged changes), including plugin and
pipeline-cli sources. `plugin.json` read the new version while the code on disk was old,
so anything consuming the local checkout got mismatched files, and
`git merge --ff-only origin/main` refused.

The reflog showed repeated `reset: moving to HEAD` entries followed by fast-forward pulls
(`pull --tags origin main`, `pull -q --ff-only`, `merge origin/main`). Candidates not yet
confirmed: `scripts/check-orchestrator-state.sh`,
`ai-sdlc-plugin/hooks/check-plugin-version.js`, and the pipeline's parent auto-sync.

The stale state was backed up at `refs/backup/parent-index-2026-10-03` and the checkout
was reset to origin/main by hand.

## Conventions
- Hermetic `node --test` tests; temporary directories come from `mkdtemp`, never a shared
  `/tmp` path.

## Acceptance Criteria
- [x] The step that leaves the index and working tree behind HEAD is identified with a reproduction (which command sequence, which script and line), written into the task notes and turned into a test.
- [x] The parent auto-sync either completes fully (HEAD, index and working tree all at origin/main) or changes nothing and reports why; it never moves HEAD alone.
- [x] The sync refuses and reports when the parent has local changes it did not create, instead of resetting over them.
- [x] `/ai-sdlc doctor` (or the existing orchestrator-state check) reports a parent checkout whose index or working tree differs from HEAD, with the count of paths.
- [x] Tests use temp repos created with `mkdtemp`, never a shared /tmp path.
- [x] The parent's stale `pipeline-cli/dist` after a sync is handled or reported (rebuild, or a warning naming the stale package).

## Out of scope
- Changing the parent-is-read-only contract.
- Worktree cleanup.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

**Root cause (reproduced).** `.husky/post-rewrite` (AISDLC-137) fires after every `git rebase` in any worktree. Its lines 45-48 ran `git -C "$PARENT_ROOT" update-ref refs/heads/main "$ORIGIN_MAIN"`. The parent has `main` checked out, so this moves the branch ref (HEAD) alone: index and working tree stay at the old commit and `git status` in the parent lists every path between old and new main as a staged modification or deletion (no unstaged changes), the 119-path symptom. It also had no ancestry check despite its "fast-forward only" comment.

Reproduction: temp parent repo on main + linked worktree + bare origin that advances; `cd <worktree> && bash .husky/post-rewrite rebase`, then `git -C <parent> status --porcelain` is non-empty. Turned into `scripts/post-rewrite-hook.test.mjs` (fails on the old hook, passes now).

Evidence in the live parent: `git reflog show refs/heads/main` had empty-message entries (the signature of a bare update-ref) at 12:18, 12:32, 12:43, 12:45, 12:50 on 2026-10-06 with no matching HEAD-reflog entries, and `git diff --cached --stat` showed ~69 files staged against HEAD.

**Fix.**
- `.husky/post-rewrite`: does nothing when the parent has main checked out; otherwise fast-forwards main only when local main is an ancestor of origin/main.
- `scripts/check-orchestrator-state.sh` (+ plugin copy, which had drifted and is now back in lockstep and wired into `test:orchestrator-state-gate`): reports a stale index/tree under a current HEAD with a path count and never auto-resets it; the AISDLC-369 backlog auto-reset now proceeds only when every dirty path already equals origin/main, otherwise it refuses and names the paths; after a reset it warns when `pipeline-cli/dist` or `orchestrator/dist` is stale (rebuild command named, no auto-build).
- `ai-sdlc doctor`: new report-only `parent-checkout-state` check (diverged path count, quiet when not on main or clean).
