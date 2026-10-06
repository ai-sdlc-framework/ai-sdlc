---
id: AISDLC-731
title: >-
  Untrusted runs: pipeline push runs worktree code with operator privileges; .git hooks and config are unprotected
status: To Do
assignee: []
created_date: '2026-10-05'
labels:
  - security
dependencies:
  - AISDLC-720
references:
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - .husky/pre-push
  - docs/api-reference/governance.md
priority: low
dispatchable: false
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Parked (planner, 2026-10-06): do not start without a planner go.

Parked: do not start without a planner go.

Two limits that predate AISDLC-720 and were disclosed in PR #1211:

- (a) An untrusted run's pipeline `git push` executes code from the worktree (hooks such as `.husky/pre-push`, scripts) with the operator's privileges.
- (b) `.git/hooks` and `.git/config` (for example `remote.origin.push`) are not protected from an untrusted run.

## Acceptance Criteria
- [ ] Threat write-up first, in the PR or in `docs/api-reference/governance.md`: what an outside-triggered run can reach today through (a) and (b).
- [ ] Then the smallest controls that close it, each with its own velocity paragraph (below) and a test.
- [ ] Local operator and executor sessions keep pushing with zero new prompts (regression test).

## Velocity impact
Each control must state: the harm it prevents, that the happy path (trusted operator and executor pushes) gets zero new prompts, and what the agent does when refused (stop and report the blocked action; no retry with a changed environment). A control that cannot meet all three is dropped from the task.
<!-- SECTION:DESCRIPTION:END -->
