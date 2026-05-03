---
id: AISDLC-148
title: Bulk-clean backlog-drift references — unblock stuck PRs
status: Done
assignee: []
created_date: '2026-05-02 17:30'
labels:
  - spec
  - drift
  - unblock
dependencies: []
references:
  - .backlog-drift.yml
  - .github/workflows/ci.yml
  - scripts/check-backlog-drift.sh
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Backlog Drift CI gate has been red on every open PR for weeks. Although the
job has `continue-on-error: true` in `.github/workflows/ci.yml` (so it doesn't
formally block merges), the failing red check creates noise that demoralises the
team and masks real CI failures. As of 2026-05-02 there are 5 PRs in flight
(#162 confirmed live, plus the open queue) where the only red badge is the drift
gate.

`npx backlog-drift report` (against the pinned `0.1.3` CI version) flags 297
issues across 100+ tasks:

- 101 errors (`✗`): refs whose target file is gone (deleted, renamed, never
  existed). Many are `(new workspace)` placeholders that the auto-fix can drop.
- 192 warnings (`⚠`): `post-complete-change` — completed tasks with refs to
  source files that have been edited since completion. These warnings are
  intrinsic and would re-accumulate forever for any healthy codebase. The cleanest
  fix is to strip those refs from completed tasks once the task is done — they're
  historical "where was this implemented?" pointers, not living refs.
- 4 info (`ℹ`): dep-resolved notes, harmless.

The CLI exits 1 on ANY issue (warning or error), so the only way to make the
gate exit 0 is to clean up both errors AND warnings.

This task is a one-shot data cleanup. The previous attempt (AISDLC-125) was
deferred too long; this lands the cleanup so future PRs see a clean drift gate.

Out of scope (deferred to follow-ups):
- Promoting the drift gate from advisory (`continue-on-error: true`) to required.
- Changing `backlog-drift` source to make `post-complete-change` info-level
  instead of warning (the upstream tool's behaviour).
- Suppressing URL refs in the checker (`https://...` URLs are flagged as missing
  files; the workaround is to keep PR/issue URLs out of `references:` and put
  them in the task description body).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `npx backlog-drift check` exits 0 on this branch (no errors, no warnings)
- [x] #2 No edits outside `backlog/tasks/` and `backlog/completed/` (per task brief)
- [x] #3 `pnpm lint` and `pnpm format:check` pass
- [x] #4 Open PR; verify drift gate goes GREEN on this PR's CI run
<!-- AC:END -->
