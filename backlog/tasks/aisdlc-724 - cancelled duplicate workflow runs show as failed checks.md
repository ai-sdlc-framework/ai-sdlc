---
id: AISDLC-724
title: >-
  Cancelled duplicate workflow runs show as failed checks
status: To Do
assignee: []
created_date: '2026-10-04'
labels:
  - ci
dependencies: []
references:
  - .github/workflows/verify-attestation.yml
  - .github/workflows/ai-sdlc-review.yml
priority: low
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`verify-attestation.yml` and `ai-sdlc-review.yml` run on both `pull_request` and
`pull_request_target`, in one per-pull-request concurrency group with cancel-in-progress.
A push starts both; one cancels the other; the cancelled run appears as a red check next
to a passing check of the same name. Required checks are unaffected, but status surveys,
executors and operators read pull requests as failing (seen on the release pull request
and on two task pull requests on 2026-10-04).

## Conventions
- Workflow edits are authorized for this task. Hermetic tests; temporary directories come
  from `mkdtemp`, never a shared `/tmp` path.
- The security reason for using `pull_request_target` is preserved.

## Acceptance Criteria
- [ ] A push produces one result per check name: either only one event runs each job, or the two events use separate concurrency groups, or the superseded run exits neutral instead of cancelled. The pull request states which and why.
- [ ] Workflow tests cover the trigger and concurrency configuration.
- [ ] The status tooling (`cli-status` or the survey helpers, where present) treats a cancelled run with a passing sibling of the same name as passing.
- [ ] The pull request body carries a "Velocity impact" section.

## Out of scope
- Changing required checks.
<!-- SECTION:DESCRIPTION:END -->
