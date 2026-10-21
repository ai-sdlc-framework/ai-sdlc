---
id: AISDLC-1002
title: 'main is red: executor.test.ts pins a sonnet default while model-routing.yaml routes review-executor to haiku'
status: In Progress
assignee: []
created_date: '2026-10-21'
labels:
  - pipeline-cli
  - ci
dependencies: []
references:
  - pipeline-cli/src/review-plan/executor.test.ts
  - pipeline-cli/src/review-plan/executor.ts
  - .ai-sdlc/model-routing.yaml
priority: high
dispatchable: true
---

## Description

Since 5c28f1c40 (model-routing.yaml is the single source for role to model) landed, `review-executor` resolves to `haiku` from `.ai-sdlc/model-routing.yaml:35`, but `pipeline-cli/src/review-plan/executor.test.ts:804-808` ("passes the routed model, defaulting to sonnet, and the repository as cwd") still asserts `model: 'sonnet'`. On `main` the test fails (`expected { agent: 'review-executor', … } to match object { model: 'sonnet' }`), so Build & Test is red on every open PR's merge ref: #1802 (AISDLC-998) failed on it at c1d3081ed (run 39530783238) with 1 failed / 11797 passed, and every PR that rebases will fail the same way until this lands.

Fix: align the test with the routed default. The expectation for `review-executor` with no explicit model becomes the value the routing table gives it (`haiku`), read through the same resolver `executor.ts` uses rather than a literal, so the next table change does not break the test again; rename the case to say "defaulting to the routed model". Nothing in `executor.ts` changes unless the resolver is not what the test can reach, in which case expose it.

Also record in the PR body why the 982 PR run was green while `main` is red (whether the branch run predated the table change, or the test was skipped), so the gate can be tightened if a PR can land with a test it breaks.

Out of scope: any other routing change; the model pins gate.

**Five-step review (requirements first).**
1. Requirement questioned: should a unit test pin a model name at all? No: the table is the source (982), so the test reads the table.
2. Delete: the literal `'sonnet'` expectation.
3. Simplify: one resolver call in the test, no duplicated default.
4. Accelerate: main goes green in one small PR, unblocking every open PR's merge-ref run.
5. Automate: the test follows the table, so a future routing change needs no test edit.

## Acceptance Criteria

- [ ] `pnpm --filter @ai-sdlc/pipeline-cli test` passes on `main` with this change, including `executor.test.ts`.
- [ ] The test derives the expected default model from the routing resolver, not a literal.
- [ ] The PR body states why the 982 PR run did not catch the break.
