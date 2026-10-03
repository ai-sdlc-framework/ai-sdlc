---
id: AISDLC-689
title: >-
  secret-redact ReDoS test: assert a growth ratio instead of an absolute wall-clock bound (flakes under coverage)
status: To Do
assignee: []
created_date: '2026-10-03'
labels:
  - test
  - flake
dependencies: []
references:
  - reference/src/security/secret-redact.test.ts
  - reference/src/security/secret-redact.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`reference/src/security/secret-redact.test.ts` has three ReDoS tests that assert
`Date.now() - start < 5000` over adversarial inputs of 200k characters:
"ReDoS: changed regexes stay linear on adversarial input" > "handles 200k-char
secret/whitespace/bracket/backtick runs", "registry hardening" > "stays fast on long
adversarial inputs (no catastrophic backtracking)", and "ReDoS: round 3 regexes stay
linear on adversarial input" > "handles 200k-char newline, bracket, star, backslash and
timestamp runs". Under `test:coverage` (v8 instrumentation) and on a loaded machine the
first took 6809 ms, so it fails without any regex regression; the other two share the
same assertion and the same risk. The tests entered with AISDLC-630.2 (PR #1143,
"close redactSecrets gaps"). The stop hook's coverage check reports the failure as
"tests failed in @ai-sdlc/reference" on a busy machine.

An absolute wall-clock bound measures the machine, not the regex. The ReDoS intent
(a quadratic regex must fail) is better expressed as a growth ratio.
<!-- SECTION:DESCRIPTION:END -->

## Conventions
- TypeScript strict, ESM, Vitest; the change is test-only (no change to `secret-redact.ts`).

## Scope
1. In each of the three tests, remove the absolute millisecond assertion. Time the same
   adversarial input set at size n and at 4n, each as the minimum over a few
   repetitions (the minimum discards GC pauses and CPU contention), and assert that
   t(4n) / t(n) stays under a linear-ish limit between linear (about 4) and quadratic
   (about 16) growth, using one shared helper. Keep each old test name in a one-line
   comment so a grep for it still finds the test.
2. Prove the check can fail: a test feeds a deliberately quadratic pattern through the
   same ratio helper and asserts the ratio exceeds the limit.

## Acceptance Criteria
- [ ] The three converted tests pass under `test:coverage` and under load.
- [ ] A known-quadratic regex fails the ratio check.
- [ ] No absolute millisecond bound remains in those three tests (none in the file).
