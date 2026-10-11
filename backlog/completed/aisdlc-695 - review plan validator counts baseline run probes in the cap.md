---
id: AISDLC-695
title: >-
  RFC-0052: review plan validator caps run probes at two in total, baseline included
status: To Do
assignee: []
created_date: '2026-10-03'
labels:
  - rfc-0052
  - review
  - pipeline-cli
dependencies:
  - AISDLC-675
references:
  - pipeline-cli/src/review-plan/validate.ts
  - pipeline-cli/src/review-plan/baseline.ts
  - pipeline-cli/src/review-plan/fallback.ts
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The plan validator (AISDLC-673) limits only the run probes a planner adds:
`DEFAULT_MAX_RUN_PROBES` is 2 and the baseline's own run probe is not counted. The
review executor (AISDLC-675) caps all run probes at 2, baseline included, because it
cannot trust a plan's baseline flag. A plan with the baseline run probe and two added
ones therefore validates and then always has one probe skipped.

Operator decision, 2026-10-03 (decision rubric): **two run probes in total, and the
validator is aligned to the executor**, chosen over exempting the baseline in the
executor (up to three full test runs per review and more logic on a trust boundary)
and over leaving the mismatch (every maximal plan loses a probe).

## Conventions
- TypeScript strict, ESM, Vitest, 80% line coverage on new code.
- The limit is one value read by both the validator and the executor; no second
  constant.

## Scope
1. `validatePlan` counts every run probe in the plan, baseline included, against
   `maxRunProbes`. The rejection message states the total, the limit and how many of
   them are baseline probes.
2. The fallback plan builder never produces a plan over the limit; when the baseline
   alone exceeds it, the existing fail-closed path applies.
3. The executor and the validator read the same exported default.
4. The planner prompt contract (AISDLC-674) is told how many run probes it may add,
   computed as the limit minus the baseline's run probes; when AISDLC-674 has merged,
   update its prompt builder in this task, otherwise note the requirement in the PR
   body for that task.

## Acceptance Criteria
- [ ] A plan with one baseline run probe and one added run probe validates; with two added it is rejected with the total and the limit in the message.
- [ ] A plan the validator accepts is never reduced by the executor's run cap (property-style test over generated plans with 0 to 4 run probes).
- [ ] The validator and the executor import the same default limit (asserted by a test on the exports).
- [ ] The fallback plan builder's output always validates against the same limit.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
