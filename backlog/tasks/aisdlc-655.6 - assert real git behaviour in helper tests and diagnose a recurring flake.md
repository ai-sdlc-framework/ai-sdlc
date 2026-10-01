---
id: AISDLC-655.6
title: >-
  Assert real git behaviour in the git-env helper tests and capture a diagnostic if the replay flake recurs
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - ci
  - flaky-test
dependencies:
  - AISDLC-655.5
references:
  - pipeline-cli/src/__test-helpers/git-env.test.ts
  - orchestrator/src/__test-helpers/git-env.test.ts
  - pipeline-cli/src/usage/replay.test.ts
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The helper tests in `pipeline-cli/src/__test-helpers/git-env.test.ts` and `orchestrator/src/__test-helpers/git-env.test.ts`, added with the replay flake fix, only check that the two git options appear as strings in the environment, so a typo in a key name or the count would pass. Assert real git behaviour instead, and give the cleanup in `pipeline-cli/src/usage/replay.test.ts` a way to identify the real writer if the intermittent cleanup failure recurs.

## Acceptance Criteria
- [ ] Each helper test runs git with the helper environment in a temporary repository and asserts that gc.auto reads 0 and maintenance.auto reads false.
- [ ] The replay test asserts the same for its fixture repository, through both the environment and the repository-local configuration.
- [ ] When fixture removal still fails after its retries, the replay test's cleanup prints the processes holding files under the directory (ps or lsof output) before rethrowing.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
