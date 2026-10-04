---
id: AISDLC-706
title: >-
  Backlog drift gate scans tasks the branch does not change; local and CI disagree
status: To Do
assignee: []
created_date: '2026-10-03'
labels:
  - ci
  - bug
dependencies: []
references:
  - scripts/check-backlog-drift-on-push.sh
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`check-backlog-drift-on-push.sh` evaluates task files a new branch does not touch, so an
unrelated stale task can fail a push, and the local run and the CI "Backlog Drift" check
reach different results for the same commit.

## Conventions
- Hermetic `node --test` tests; temporary directories come from `mkdtemp`, never a shared
  `/tmp` path.

## Acceptance Criteria
- [ ] A reproduction is written down first (the exact branch state where local and CI differ) and turned into a test.
- [ ] The gate evaluates only task files changed relative to the merge base with origin/main, unless a documented full-scan flag is passed.
- [ ] The local hook and the CI job call the same entry point with the same inputs and produce the same verdict for the same commit.
- [ ] Tests use temp dirs created with `mkdtemp`, never a shared /tmp path.

## Out of scope
- Changing what counts as drift.
<!-- SECTION:DESCRIPTION:END -->
