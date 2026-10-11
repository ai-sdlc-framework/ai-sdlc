---
id: AISDLC-795.1
title: >-
  secret-redact ReDoS canary: replace the wall-clock quadratic-pattern test with a structural check
status: In Progress
assignee: []
created_date: '2026-10-11'
labels:
  - ci
  - flake
  - test
  - security
dependencies: []
references:
  - reference/src/security/secret-redact.test.ts
  - reference/src/security/secret-redact.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The test `flags a known-quadratic pattern (the growth-ratio check can fail)` in `reference/src/security/secret-redact.test.ts` decides pass or fail from elapsed wall-clock time (`growthRatio()` using `performance.now()`). It flaked the Integration Tests check on PR #1350 (AISDLC-711) on 2026-10-11 and gates every PR on runner load; main-health issue #1304 was the same class. AISDLC-795 hardened the canary (min-of-reps ratio) but kept a timing assertion, so the flake class remains.

Five-step review (requirements first):

1. **Question the requirement.** The requirement is "prove the redactor's regexes cannot go quadratic" (the security reviewer's ask on the redactor, kept by AISDLC-795). The property is real; measuring it with a stopwatch on a shared runner is not a valid way to check it.
2. **Delete.** Remove the wall-clock assertion, `growthRatio()`, `LINEAR_GROWTH_LIMIT`, and any timing threshold, repetition or retry around them.
3. **Simplify.** Assert the property structurally: every regex in the exported `SECRET_PATTERNS` list passes a safe-regex style check (no nested unbounded quantifiers, no overlapping alternations under a quantifier), and `redactSecrets` caps input length before matching. One unit test over the exported regex list, plus one for the cap. The redactor currently has no explicit length cap; adding the minimal cap needed for the assertion is in scope for this task and must be called out in the PR body.
4. **Accelerate.** Not applicable.
5. **Automate.** Not applicable beyond the test itself running in the normal suite.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] No test in the repo measures elapsed time to decide pass or fail for the redactor: `grep -nE "performance\.now|Date\.now|hrtime" reference/src/security/secret-redact.test.ts` returns nothing.
- [ ] A structural test iterates every exported redaction regex (`SECRET_PATTERNS`) and fails on a deliberately nested-quantifier fixture (the fixture proves the checker can fail).
- [ ] The input length cap is asserted by a test.
- [ ] `pnpm --filter @ai-sdlc/reference test` passes twice in a row locally, and `pnpm lint && pnpm format:check` pass.
- [ ] The task body names the five steps (done above: questioned, deleted, simplified, accelerate and automate marked not applicable).
<!-- AC:END -->

## Notes

Supersedes the timing approach of AISDLC-795. Related: PR #1350 flake (2026-10-11), main-health issue #1304. Confirm the owning package name from `reference/package.json` before running the filter command.
