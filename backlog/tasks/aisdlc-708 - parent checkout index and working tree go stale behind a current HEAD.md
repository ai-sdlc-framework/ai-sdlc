---
id: AISDLC-708
title: >-
  Parent checkout index and working tree go stale behind a current HEAD
status: To Do
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
- [ ] The step that leaves the index and working tree behind HEAD is identified with a reproduction (which command sequence, which script and line), written into the task notes and turned into a test.
- [ ] The parent auto-sync either completes fully (HEAD, index and working tree all at origin/main) or changes nothing and reports why; it never moves HEAD alone.
- [ ] The sync refuses and reports when the parent has local changes it did not create, instead of resetting over them.
- [ ] `/ai-sdlc doctor` (or the existing orchestrator-state check) reports a parent checkout whose index or working tree differs from HEAD, with the count of paths.
- [ ] Tests use temp repos created with `mkdtemp`, never a shared /tmp path.
- [ ] The parent's stale `pipeline-cli/dist` after a sync is handled or reported (rebuild, or a warning naming the stale package).

## Out of scope
- Changing the parent-is-read-only contract.
- Worktree cleanup.
<!-- SECTION:DESCRIPTION:END -->
