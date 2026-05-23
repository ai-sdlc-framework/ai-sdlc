---
id: AISDLC-405
title: 'fix(test): clean up test suite drift from AISDLC-398 (patch-id) + AISDLC-400 (queue drop)'
status: To Do
labels: [test, ci, operator-merge]
references:
  - .github/workflows/__tests__/ai-sdlc-review.test.mjs
  - scripts/verify-attestation.test.mjs
priority: high
permittedExternalPaths: []
---

## Description

AISDLC-398 (content-addressed envelopes) and AISDLC-400 (drop merge queue) merged but the test suite still has assertions that reference the OLD behavior:
1. `verify-attestation.test.mjs` has tests asserting `valid` outcome but now getting `invalid: contentHashV4 mismatch` (the patch-id verifier doesn't match the old test expectations)
2. `.github/workflows/__tests__/ai-sdlc-review.test.mjs` has tests for docs-only merge_group short-circuit (AISDLC-214) that test for merge_group event handling — but merge_group is gone post-400

Every open PR (#524, #626, #636, #637, #638) is failing Build & Test on these test suite drift issues.

## Acceptance criteria

- [ ] AC-1: Run `node --test scripts/verify-attestation.test.mjs` locally. Identify which test(s) fail with `contentHashV4 mismatch`. Fix or update test expectations to match the post-398 patch-id-aware verifier behavior. If a test was testing v3/v4 legacy verification, the test should still work; only update if the test's invariant has genuinely changed.
- [ ] AC-2: Run `node --test .github/workflows/__tests__/ai-sdlc-review.test.mjs` locally. Identify docs-only short-circuit tests that reference removed merge_group behavior. Remove or update those tests to assert the new pull_request-only + paths-ignore behavior.
- [ ] AC-3: All affected tests pass locally.
- [ ] AC-4: Reference PRs #524, #626, #636, #637, #638 as immediate beneficiaries.

## Out of scope

- Adding NEW tests for the post-398/400 behavior (those should be in the respective shipped PRs)
- Refactoring the test suites structurally

## Estimated effort

30 min - 1 hour. Test cleanup only, no production code changes.
