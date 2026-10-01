---
id: AISDLC-655.5
title: >-
  Replay test flake: disable git auto maintenance and retry temp repo cleanup in tests
status: Done
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0050
  - ci
  - flaky-test
dependencies:
  - AISDLC-655
references:
  - pipeline-cli/src/usage/replay.test.ts
  - pipeline-cli/src/__test-helpers/git-env.ts
  - orchestrator/src/__test-helpers/git-env.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A CI flake in the reviewer replay test failed PR checks with `ENOTEMPTY: directory not empty, rmdir '/tmp/replay-repo-XXXX/.git'` from the shared `afterEach` that removes the temporary git repository, reported against whichever test happened to be running. The inferred cause is a detached git maintenance process still writing into `.git` while the directory is removed on a loaded runner. The flake was not reproduced, so the cause is unproven. This change makes the fixtures stop git from running automatic maintenance and makes fixture cleanup retry. It changes no production code.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Every git call in the replay test fixtures runs with automatic gc and maintenance disabled, through the environment and through the fixture repository's local configuration
- [x] #2 The shared git environment helpers in pipeline-cli and orchestrator set the same two options, each with a unit test
- [x] #3 Fixture cleanup in the replay test and in the other tests that use the shared helpers retries removal (five retries, 50 ms apart)
- [x] #4 The other tests that create temporary git repositories were audited and the ones left unchanged are listed with a reason
- [x] #5 No production code changes
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Replay and other git-fixture tests now disable git's automatic gc and maintenance and retry removal of their temporary repositories, to stop an intermittent ENOTEMPTY failure in test cleanup.

## Changes
- `pipeline-cli/src/usage/replay.test.ts`: the fixture git environment sets `gc.auto=0` and `maintenance.auto=false`, the same two options are written into the fixture repository's local config right after `git init` (so git processes spawned by the code under test are covered), and every fixture removal retries.
- `pipeline-cli/src/__test-helpers/git-env.ts` and `orchestrator/src/__test-helpers/git-env.ts`: the shared helper environment sets the same two options, each with a new unit test.
- Retrying removal in the seven test files that use those helpers: loop.sweep, checkpoint, loop.resume, execute.head-restore, execute.push-rebase, worktree-pool.integration, git-utils.cross-repo.

## Design decisions
- The cause is inferred, not demonstrated: with about ten commits per fixture, git's automatic gc threshold (thousands of loose objects) is far away, so the retrying removal is the more likely real fix. The configuration change is cheap and harmless, and a follow-up adds a stronger test and a diagnostic to run if the flake recurs.
- Left unchanged on purpose: tests whose fixtures make at most two commits (worktree-mutex, usage-config, rfc, ucvg, attestation, recovery-flows, harness-transcript, patch-id and its sibling tests, reviewer-cache); tests with a bespoke inline git environment and no shared helper (execute.local-branch, orchestrator, the production git-env test, prepush-sign-snippet, init-workspace and its quarantined flaky sibling, the quarantined worktree-pool flaky sibling, claude-code adapter); and the many small, independent script, plugin hook and mcp-server tests, which would need per-file edits for little value. The reference and dogfood packages have no matching git fixtures.

## Verification
- `pnpm build` — passed
- `pnpm test` — replay test and the touched pipeline-cli test files passed (142 tests), the touched orchestrator test files passed (29 tests); the full root suite was not run
- `pnpm lint` — passed
- `pnpm format:check` — passed on touched files
- 3 parallel reviews approved (Claude-native reviewers); reviewer leaves carry no transcript binding because the session produced no subagent start markers

## Follow-up
- AISDLC-655.6: assert real git behaviour in the helper tests and add a diagnostic if the flake recurs.
- declined: converting the remaining small git-fixture tests, because each makes too few commits to reach the maintenance threshold and the retrying cleanup is needed only where removal races a git process.
<!-- SECTION:FINAL_SUMMARY:END -->
