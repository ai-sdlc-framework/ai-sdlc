---
id: AISDLC-956
title: 'The release workflow updates the release-please branch with one push per merge to main instead of two'
status: To Do
assignee: []
created_date: '2026-10-16'
labels:
  - ci
  - release
  - cost
dependencies: []
references:
  - .github/workflows/release.yml
  - docs/operations/release-flow.md
priority: medium
dispatchable: true
---

## Description

Every merge to main makes `release.yml` push the `release-please--branches--main` branch twice with the operator PAT: release-please force-pushes its regenerated commit, then the plugin runtime-deps sync step pushes a second commit about fifteen seconds later. Each push is a `synchronize` event on the release PR: a gate run (the first one cancelled by the second), CodeQL, the issue-link check and, for the completed one, an attestation-post run. In 3.6 hours on 2026-10-16 the release branch alone produced 115 gate runs, 98 of them cancelled.

**Five-step review (requirements first).**
1. Requirement questioned: must the deps sync be a separate push? No; its only job is to keep the plugin manifest in step with the version release-please wrote, which is known before the push.
2. Delete: the second push.
3. Simplify: run the sync against the release-please commit and amend or squash before one push (or write the manifest through the release-please `extra-files` mechanism so the bot commit already carries it).
4. Accelerate: half the release-branch gate runs disappear; combined with the attestation-post staging fix the per-merge cost on the Actions bucket drops to a few calls.
5. Automate: a test on the workflow asserts a single push step targets the release branch; the release-flow doc describes the single-push shape.

## Acceptance Criteria

- [ ] One merge to main produces exactly one push event on the release-please branch (repository activity log).
- [ ] The plugin manifest version still matches the release-please version on that single commit.
- [ ] `docs/operations/release-flow.md` updated.
