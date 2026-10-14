---
id: AISDLC-864
title: >-
  developer return carries a waived test status with evidence so a DEC-0202 waiver no longer hard-stops next-step
status: To Do
assignee: []
created_date: '2026-10-14'
labels:
  - pipeline
  - reliability
  - dispatch
dependencies: []
references:
  - pipeline-cli/src/steps/06-parse-dev-return.ts
  - pipeline-cli/src/steps/05-build-dev-prompt.ts
  - pipeline-cli/src/next-step/ship.ts
  - ai-sdlc-plugin/agents/developer.md
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

DEC-0202 waives a locally failing test when (1) it passes when re-run alone and (2) the task diff touches neither the test nor the source it exercises; the not-ok lines go in the PR body and CI stays the single gate (AISDLC-726). The pipeline has no carrier for that waiver: `parse-dev-return` accepts only `passed`, `failed` or `skipped` for `verifications.test`, and `failed` hard-stops the run (developer-failed). On 2026-10-14 AISDLC-833 (#1480) stopped this way with `bin-invocation.test.ts` and `usage-views.test.ts` red in the full suite and green alone, which cost a planner decision (DEC-0210) and held AISDLC-834/835 behind it. DEC-0210 named the interim carrier (`skipped` plus evidence in the developer notes and the PR body); `skipped` is honest but carries no structure, so nothing checks that the evidence is present.

**Five-step review (requirements first).** Requirement questioned: "the developer must report the full local suite green". Local verification is not a trust-chain control; CI is. What must hold is that a waived test is evidenced (passes alone, diff untouched) and visible in the PR. Delete: the per-task escalation for this shape. Simplify: one new status `waived` for `verifications.test` whose value must carry evidence fields (`tests`: names, `passesAlone`: the re-run command and summary, `untouched`: true); a `waived` return without complete evidence is rejected with a precise reason, exactly like a malformed return today. Accelerate: next-step continues to review and ship with the waiver block rendered into the PR body automatically. Automate: the developer prompt tells the developer when and how to use `waived`, so no human or planner names the carrier again.

## Fix

1. `pipeline-cli/src/steps/06-parse-dev-return.ts`: add `waived` to the accepted statuses for `verifications.test` only, with a required `testWaiver` object `{ tests: string[], passesAlone: string, untouched: true }`; reject `waived` without it (`developer return verifications.test = waived requires testWaiver {tests, passesAlone, untouched}`); `build`, `lint` and `format` keep passed/failed/skipped.
2. `pipeline-cli/src/next-step/ship.ts` (or wherever the PR body is finalised): render a `## Local verification waiver (DEC-0202)` section listing the tests and the passes-alone evidence when `testWaiver` is present.
3. `pipeline-cli/src/steps/05-build-dev-prompt.ts` and `ai-sdlc-plugin/agents/developer.md`: one paragraph on when `waived` applies (both DEC-0202 conditions) and that any other failure stays `failed`.
4. Tests for the parser (accept with evidence, reject without, reject `waived` on build/lint/format) and for the PR-body rendering.

## Acceptance Criteria

- [ ] #1 A developer return with `verifications.test: waived` and a complete `testWaiver` is accepted and the run proceeds to the reviewers.
- [ ] #2 The same return without `testWaiver`, or with an empty `tests` list, or `untouched` not `true`, is rejected with the reason naming the missing field.
- [ ] #3 `waived` on `build`, `lint` or `format` is rejected.
- [ ] #4 The shipped PR body contains the waiver section with the test names and the passes-alone evidence.
- [ ] #5 The developer prompt and agent doc state the two DEC-0202 conditions verbatim.

**Velocity impact.** Positive: removes one planner decision and one held wave per flaky-suite occurrence; CI remains the only gate.

Authority: class (a) under `docs/operations/decision-authority.md` (reversible; CI gate unchanged; the waiver is DEC-0202's existing rule given a checked carrier).
<!-- SECTION:DESCRIPTION:END -->
