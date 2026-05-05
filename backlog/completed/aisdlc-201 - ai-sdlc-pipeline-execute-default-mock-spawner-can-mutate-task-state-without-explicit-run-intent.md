---
id: AISDLC-201
title: >-
  ai-sdlc-pipeline execute default mock spawner can mutate task state without
  explicit run intent
status: Done
assignee: []
created_date: '2026-05-05 18:02'
labels:
  - bug
  - pipeline-cli
  - developer-experience
  - safety
dependencies: []
references:
  - pipeline-cli/src/cli/execute.ts
  - pipeline-cli/src/cli/execute.test.ts
  - pipeline-cli/README.md
  - >-
    backlog/completed/aisdlc-182 -
    CLI-add-ai-sdlc-pipeline-execute-umbrella-subcommand-for-end-to-end-Step-0-13-dispatch.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`ai-sdlc-pipeline execute <task-id>` defaults to `--spawner mock` while `--dry-run` defaults to false. The mock spawner is documented as a plumbing fixture, but the default command path still enters the real pipeline and can create worktrees or flip task status before failing through the mock developer result.

## Impact

An operator or assistant can accidentally mutate backlog/worktree state by running the umbrella command with no flags, even though the default spawner cannot perform real development work. This is a usability footgun for the new issue-processing path introduced by AISDLC-182.

## Implementation notes

Make the safe path the default. Options include requiring an explicit `--run` flag for non-dry-run execution, making `--dry-run` the default when `--spawner mock`, or refusing `--spawner mock` unless `--dry-run` is true. Preserve testability for plumbing checks without allowing accidental state mutation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Running `ai-sdlc-pipeline execute <task-id>` with default options does not mutate task files, create worktrees, or push branches.
- [x] #2 A real execution requires explicit operator intent, such as `--run` plus a real spawner or `--spawner api-key`.
- [x] #3 `--spawner mock` is limited to dry-run/plumbing behavior or otherwise clearly refuses before filesystem mutation.
- [x] #4 CLI help and README document the safe default and the explicit real-run invocation.
- [x] #5 Regression test covers default invocation and asserts the executor/worktree setup is not called.
<!-- AC:END -->

## Final Summary

Implemented a safe-by-default `ai-sdlc-pipeline execute` path: no `--run` now performs only validation/plan output, real execution requires `--run` with a real spawner, and `--run --spawner mock` refuses before validation or filesystem mutation. Updated CLI help, README examples, and regression tests for default non-mutation plus mock refusal.
