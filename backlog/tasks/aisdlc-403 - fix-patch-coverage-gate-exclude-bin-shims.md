---
id: AISDLC-403
title: 'fix(ci): patch-coverage gate excludes bin/*.mjs CLI shims (AISDLC-376 follow-up)'
status: To Do
labels: [ci, coverage-gate, operator-merge]
references:
  - scripts/check-pr-patch-coverage.mjs
priority: high
permittedExternalPaths: []
---

## Description

AISDLC-376 (PR #627) shipped the server-side patch-coverage gate but its `NON_INSTRUMENTED_PATTERNS` list excludes `src/cli-*.ts` shims but NOT `bin/*.mjs` shims. PR #524 (AISDLC-284) hit this on 2026-05-23: a new bin file `pipeline-cli/bin/cli-estimate-classes.mjs` has 12 changed lines, no coverage data (correctly — bin shims just delegate to library code), gate reports MISSING + fails with exit 1. Same gap will hit every future PR that adds a new bin shim.

The fix: extend `NON_INSTRUMENTED_PATTERNS` to also exclude `bin/.+\.mjs`. Bin shims are entrypoint thunks that parse argv and call into libraries; the libraries are unit-tested directly, the shim is exercised end-to-end via subprocess invocation which istanbul can't see.

## Acceptance criteria

- [ ] AC-1: `scripts/check-pr-patch-coverage.mjs` `NON_INSTRUMENTED_PATTERNS` includes a pattern matching `bin/<anything>.mjs` (e.g. `/(^|\/)bin\/.+\.mjs$/`).
- [ ] AC-2: `scripts/check-pr-patch-coverage.test.mjs` adds a test case: a changed file at `pkg/bin/cli-foo.mjs` is correctly identified as non-instrumentable and skipped from enforcement.
- [ ] AC-3: Inline comment on the new pattern entry explains the rationale (bin shims are subprocess-tested, istanbul can't see them) — mirrors existing pattern comments.
- [ ] AC-4: Run the existing hermetic tests to confirm no regression (`node --test scripts/check-pr-patch-coverage.test.mjs`).
- [ ] AC-5: Document in PR body that PR #524 (AISDLC-284) is the immediate beneficiary — its Coverage check will pass on rebase once this lands.

## Out of scope

- Adding `bin/*.cjs` or `bin/*.js` (only `.mjs` is currently used; can extend if/when needed).
- Rewriting the bin shims to be testable (they're intentionally thin).

## References

- AISDLC-376 (PR #627) — original patch-coverage gate
- PR #524 (AISDLC-284) — first PR to hit the gap

## Estimated effort

15-30 min.
