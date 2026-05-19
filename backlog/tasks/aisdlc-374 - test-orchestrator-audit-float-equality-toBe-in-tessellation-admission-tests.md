---
id: AISDLC-374
title: 'test(orchestrator): audit + fix float-equality .toBe() in tessellation-admission tests'
status: To Do
assignee: []
created_date: '2026-05-19'
labels:
  - test
  - flaky
  - tech-debt
dependencies: []
priority: medium
references:
  - orchestrator/src/tessellation-admission.test.ts
---

## Problem

AISDLC-313 (PR #558, merged) introduced `orchestrator/src/tessellation-admission.test.ts` which uses `.toBe()` for float-equality assertions on `computeAdmissionComposite` outputs. The floats accumulate from weighted sums across multiple sub-scores and produce runner-to-runner ulp differences (~1e-9). The assertions passed on 558's CI by luck but failed deterministically on PR #550's queue probe with:

```
expected 0.14519032775057875 to be 0.1451903277627315
```

PR #550 inline-patched the single offending assertion at line 362-363 to `.toBeCloseTo(value, 8)`. This task audits the rest of the test file (and any other tests against `composite` / `breakdown.soulAlignment` / similar weighted-sum outputs) and converts all float `.toBe()` calls to `.toBeCloseTo(value, 8)`.

## Acceptance criteria

- [ ] All `.toBe()` calls in `orchestrator/src/tessellation-admission.test.ts` against float-valued properties (composite, soulAlignment, sub-scores) use `.toBeCloseTo(value, precision)` with precision 8
- [ ] Grep for other `expect(...).toBe(...)` on float values in `orchestrator/src/**/*.test.ts` and convert
- [ ] Tests still pass; no behavior change to `computeAdmissionComposite`

## Out of scope

- Fixing the underlying non-determinism in `computeAdmissionComposite` (real bug — file separately if pursued)
- Audit of `pipeline-cli/` or `reference/` test suites (separate scope)

## Source

PR #550 (AISDLC-302) queue probe failure 2026-05-19; operator authorized inline 1-line fix in #550 + this follow-up task.
