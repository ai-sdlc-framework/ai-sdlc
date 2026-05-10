---
id: AISDLC-246
title: Harden worktree-mutex AC #7 integration test (currently `describe.skip`)
status: Done
assignee: []
created_date: '2026-05-08 14:42'
labels:
  - test
  - orchestrator
  - tech-debt
dependencies:
  - AISDLC-241
priority: medium
references:
  - pipeline-cli/src/runtime/worktree-mutex.test.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

AISDLC-241's AC #7 integration test (`withWorktreeMutex — real git worktree
add — 3 concurrent calls succeed with no .git/config.lock collision`) was
marked `describe.skip` to unblock the parent PR push. The test is genuinely
environment-sensitive — under V8 coverage instrumentation it fails on the
fixture's `git commit -m "init"` step, even with `--no-verify` and
`-c commit.gpgsign=false`. Suspected cause: parent shell env vars
(GIT_DIR, CLAUDE_PROJECT_DIR, husky overrides) leak into the test's
execSync child.

## Acceptance Criteria

- [ ] #1 Identify the env-var or config that's bleeding into the test fixture's `execSync` calls
- [ ] #2 Make the test hermetic — set explicit `env: {}` (or a known-clean subset) in execSync options, OR use `simple-git` library instead of shelling out
- [ ] #3 Re-enable the test (remove `describe.skip` → `describe`)
- [ ] #4 Run `pnpm --filter @ai-sdlc/pipeline-cli test:coverage` 5x consecutively to verify no flake
- [ ] #5 Document the env-var hygiene pattern in test-authoring docs so future integration tests don't hit this
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Identify env-var leak source
- [ ] #2 Make test hermetic via explicit env: {} or simple-git
- [ ] #3 Re-enable test (remove .skip)
- [ ] #4 5x consecutive coverage runs pass
- [ ] #5 Document env-hygiene pattern
<!-- SECTION:ACCEPTANCE:END -->
