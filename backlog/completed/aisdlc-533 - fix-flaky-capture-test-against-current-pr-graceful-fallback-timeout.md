---
id: AISDLC-533
title: >-
  fix(test): de-flake capture.test.ts against-current-pr graceful-fallback
  (5000ms timeout in CI)
status: Done
assignee: []
labels:
  - bug
  - test
  - flaky
  - ci:no-issue-required
priority: medium
dependencies: []
references:
  - pipeline-cli/src/cli/capture.test.ts
  - pipeline-cli/src/cli/capture.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The test `pipeline-cli/src/cli/capture.test.ts` > `against-current-pr subcommand` > `files a capture with a null PR when git/gh are not available (graceful fallback)` (around line 524) intermittently fails with `Error: Test timed out in 5000ms`. It has bitten CI repeatedly: e.g. the 2026-06-10 main-push Coverage run and the AISDLC-531/532 sync PR's PR-Ready-Gate Build-and-Test, while the SAME commit passed in the main CI workflow's Build-and-Test — the hallmark of a flake, not a real regression.

Likely root cause: the test exercises the null-PR branch of `detectCurrentPrNumber` "when git/gh are not available", but instead of injecting a fake/stubbed git+gh runner it appears to let the code actually shell out to real `git`/`gh`. In CI those can block (e.g. `gh` waiting on auth/network, or `git` on an unexpected state) past the 5000ms vitest default, producing the timeout. The "graceful fallback" path should be exercised with the external commands STUBBED to fail/return-not-available deterministically and instantly — never by relying on the ambient environment lacking git/gh.

Fix direction (implementer confirms against the code):
- Inject a stub command-runner (or mock the git/gh invocation seam) so the "not available" path returns immediately and deterministically, with no real subprocess.
- If the production code has no injection seam for the git/gh calls, add one (small refactor) so the test can drive the fallback without real subprocesses — this also makes the test hermetic.
- As a secondary safety net (not the primary fix), an explicit per-test timeout is acceptable, but the real fix is removing the real-subprocess dependency so the test is deterministic and fast.
- Audit sibling tests in the same file that shell out to git/gh for the same flake class and apply the same stubbing.

This is the same cli-capture flake family seen earlier in the session (decisions.test.ts / capture.test.ts shared-/tmp + real-subprocess issues). Keep the fix scoped to making the test hermetic; do not weaken what it asserts (the null-PR fallback must still be verified).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The `against-current-pr ... graceful fallback` test no longer depends on real `git`/`gh` subprocesses — the "not available" path is driven by an injected stub/mock that returns deterministically and instantly
- [ ] #2 If needed, a git/gh invocation seam is added to the production code so the fallback is testable without real subprocesses (small, behavior-preserving refactor)
- [ ] #3 The test still asserts the same behavior (a capture is filed with a null PR when git/gh are unavailable) — assertion not weakened
- [ ] #4 Other tests in capture.test.ts that shell out to real git/gh are audited and stubbed for the same flake class
- [ ] #5 `pnpm --filter @ai-sdlc/pipeline-cli test` and `test:coverage` pass consistently across repeated local runs; lint + format clean
<!-- AC:END -->
