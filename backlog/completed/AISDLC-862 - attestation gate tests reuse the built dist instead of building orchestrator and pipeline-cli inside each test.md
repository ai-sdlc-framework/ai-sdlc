---
id: AISDLC-862
title: >-
  attestation gate tests reuse the built dist instead of building orchestrator and pipeline-cli inside each test
status: Done
assignee: []
created_date: '2026-10-13'
labels:
  - tests
  - reliability
dependencies: []
references:
  - ai-sdlc-plugin/scripts/sign-attestation.test.mjs
  - ai-sdlc-plugin/scripts/verify-attestation.test.mjs
  - scripts/verify-attestation.test.mjs
  - scripts/run-gate-tests.mjs
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`ai-sdlc-plugin/scripts/sign-attestation.test.mjs`, `ai-sdlc-plugin/scripts/verify-attestation.test.mjs` and `scripts/verify-attestation.test.mjs` each run a full `orchestrator` (and `pipeline-cli`) build inside the test to obtain a runtime to resolve, and fail with `failed to build orchestrator: ` (empty stderr) when the build exceeds the subtest timeout. On a machine where several executors build and test at once this happens on `main` itself (44 `not ok` in `pnpm test:gates` on d2b6bbcb at 2026-10-13 20:00Z); the same failures blocked the verification step of AISDLC-828, 833 and 840 that day, each costing a planner ruling and a re-enqueue, while CI (one job per runner) stays green. The tests measure build speed under load, not attestation behaviour.

**Five-step review (requirements first).** Requirement questioned: "every attestation test builds its own runtime". Not needed: the runtime under test is the repository's own `dist`, which `pnpm build` (always run before `pnpm test`) has already produced. Deletion: the in-test `pnpm build` invocations are deleted. Simplified: the tests resolve the already-built `orchestrator/dist` and `pipeline-cli/dist`; when a dist is missing they fail fast with a message saying to run `pnpm build` (a precondition, not a timeout); the few tests that intentionally exercise a *hostile* or *adopter* runtime copy the built dist into their temp layout instead of rebuilding it. Accelerated: `pnpm test:gates` loses several minutes and its load sensitivity; task verification no longer fails for reasons outside the diff. Automated: `scripts/run-gate-tests.mjs` asserts the dists exist before starting and prints the precondition once.

## Fix

1. In the three test files, replace each in-test build with a helper `requireBuiltDist(pkg)` that returns the dist path or throws the precondition message.
2. Tests that need a runtime in a temp repo (adopter runtime resolution AISDLC-554, hostile repoRoot AISDLC-566, node_modules walk-up AISDLC-575) copy `orchestrator/dist` and `pipeline-cli/dist` (plus `package.json`) into the temp layout.
3. `scripts/run-gate-tests.mjs`: precondition check for the dists.
4. Remove any now-unused timeout bumps.

## Acceptance Criteria

- [ ] #1 No test under `ai-sdlc-plugin/scripts/` or `scripts/` spawns `pnpm build`, `pnpm -r build` or `tsc` (grep in a test asserts it).
- [ ] #2 With dists present, `pnpm test:gates` passes while another `pnpm build` runs concurrently on the same machine (documented manual check in the PR body, plus the test suite itself under `node --test`).
- [ ] #3 With `orchestrator/dist` removed, the affected tests fail fast with the precondition message, not a timeout.
- [ ] #4 The adopter, hostile-repoRoot and walk-up scenarios still pass against the copied dist.

**Velocity impact.** Positive: removes the most frequent false-red in task verification on the operator's machine.

Authority: class (a) under `docs/operations/decision-authority.md` (test-only, reversible, no control weakened: the gate still runs the same assertions).
<!-- SECTION:DESCRIPTION:END -->
