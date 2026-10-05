---
id: AISDLC-735
title: >-
  Run the plugin command tests in CI
status: To Do
assignee: []
created_date: '2026-10-05'
labels:
  - ci
  - tests
dependencies: []
references:
  - ai-sdlc-plugin/commands/executor.test.mjs
  - ai-sdlc-plugin/commands/planner.test.mjs
  - package.json
  - .github/workflows/ci.yml
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Test files under `ai-sdlc-plugin/commands/*.test.mjs` (for example `executor.test.mjs`, `planner.test.mjs`) exist, but on origin/main neither the root `package.json` test scripts nor any file under `.github/workflows` runs them (checked 2026-10-05 by grep). A regression in a command body therefore reaches main unnoticed. This task removes that gap and adds no new gate on the happy path.

This task edits a workflow, so it needs the blockedPaths change (the operator's agent-role.yaml edit that the planner tracks as the second item of DEC-0057; it has no task file on main yet, so it is not listed in `dependencies`) applied first.

## Acceptance Criteria
- [ ] The command tests run in the required PR test job on Linux (wired through a `package.json` script that the existing test job calls).
- [ ] Known portability traps handled: reading `/dev/stdin` returning EAGAIN, and very large environments causing E2BIG.
- [ ] A failing command test fails the PR (shown in the PR with a deliberate failing run, then removed).

## Velocity impact
Prevents command-body regressions merging unseen. The happy path gets zero new prompts and a small CI time increase; tests that fail only on Linux are fixed in this task. When the job fails, the output names the test file, and the agent fixes the test or the command.
<!-- SECTION:DESCRIPTION:END -->
