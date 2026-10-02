---
id: AISDLC-682
title: >-
  Failure classifier heuristics: bound the input length and remove polynomial regular expressions (CodeQL high)
status: To Do
assignee: []
created_date: '2026-10-02'
labels:
  - security
  - pipeline-cli
  - rfc-0025
dependencies: []
references:
  - pipeline-cli/src/tui/analytics/quality-classifier.ts
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
CodeQL reports one high-severity alert on `main`, surfaced by PR analysis on #1136 and
#1149 against a moved base: "Polynomial regular expression used on uncontrolled data"
at `pipeline-cli/src/tui/analytics/quality-classifier.ts:445`, where `countMatches`
runs each heuristic `RegExp` (keyed on words such as developer, returned, swallowed,
timeout) over failure text that comes from agent and tool output. A crafted failure
message can make classification take polynomial time. Pre-existing from RFC-0025
phases 2 and 4; not introduced by either PR. Operator-filed 2026-10-02.

## Conventions
- TypeScript strict, ESM, Vitest, 80% line coverage on new code.
- Classification results on the existing fixture corpus are unchanged (snapshot the
  current outputs before touching the patterns).

## Scope
1. **Bound the input:** `classifyFailure` and `countMatches` operate on at most the
   first 16 KiB of the failure text (constant, documented), so no pattern ever sees
   unbounded input.
2. **Linearise the patterns:** rewrite each heuristic `RegExp` flagged by CodeQL so it
   has no nested or overlapping quantifiers (anchor with word boundaries, replace
   `.*`-style bridges with bounded character classes); keep the matched vocabulary
   identical.
3. **Regression test:** a test feeds a 1 MiB pathological input (repeated near-matches)
   and asserts classification completes within 100 ms and returns the same class as the
   truncated input.
4. **CodeQL:** the alert closes on the next analysis of `main`; the PR body quotes the
   alert id.

## Acceptance Criteria
- [ ] Classification outputs on the existing fixture corpus are byte-identical before and after (snapshot test).
- [ ] A 1 MiB pathological input classifies in under 100 ms.
- [ ] No heuristic pattern in the file contains nested or overlapping unbounded quantifiers; CodeQL reports no polynomial-regex alert on the branch.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
