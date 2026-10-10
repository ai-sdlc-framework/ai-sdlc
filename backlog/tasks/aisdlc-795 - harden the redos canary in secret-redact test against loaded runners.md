---
id: AISDLC-795
title: >-
  Harden the ReDoS canary in secret-redact.test.ts so a loaded runner cannot fail it while a quadratic pattern still does
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - ci
  - flake
  - test
  - security
  - dec-0082
dependencies: []
references:
  - reference/src/security/secret-redact.test.ts
  - reference/src/security/secret-redact.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implements the second half of DEC-0082 (operator ruling 2026-10-10, supersedes PR #1280). The amendment that attached this scope to AISDLC-790 (PR #1325) could not land before AISDLC-790 shipped in #1334, so it is filed on its own.

`reference/src/security/secret-redact.test.ts` > `ReDoS … flags a known-quadratic pattern` asserts a measured slowdown ratio `> 8`. It read 7.65 on the #1308 run and 7.67 on the 0.29.0 publish job, so a loaded CI runner fails it while the redactor is correct. Take #1280's 3-line change (branch `fix/redact-redos-canary-flake`, head c6636170, `git show c6636170 -- reference/src/security/secret-redact.test.ts`) as the starting point and make the canary robust: compare against a same-process baseline measured inside the test, use the median of several runs, and keep a bound that still fails on a genuinely quadratic regex. Verify the bound once by temporarily weakening the redactor's pattern locally (not committed).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] The ReDoS canary in `reference/src/security/secret-redact.test.ts` passes 50 consecutive runs under a concurrent CPU-burner loop on the developer machine.
- [ ] With the redactor's pattern deliberately made quadratic (local only), the canary still fails.
- [ ] No production change in `reference/src/security/secret-redact.ts`; the test is the only functional diff.
- [ ] PR body states that this supersedes #1280 and cites DEC-0082.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Notes

Decision: DEC-0082. Related: AISDLC-790 (#1334) covered the review-plan executor width flake from the same ruling. The operator closes #1280 and #1325; agents never close PRs.
