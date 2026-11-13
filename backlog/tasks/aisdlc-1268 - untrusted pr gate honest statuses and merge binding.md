---
id: AISDLC-1268
title: 'Untrusted PR gate: no green status without a review, and the merge gate requires the gate verdict for fork PRs'
status: To Do
assignee: []
created_date: '2026-11-13'
labels:
  - ci
  - ucvg
  - merge-gate
dependencies: []
references:
  - .github/workflows/untrusted-pr-gate.yml
  - .github/workflows/__tests__/untrusted-pr-gate.test.mjs
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/verdict-writer.yml
  - pipeline-cli/src/attestation/verdict-check.ts
  - pipeline-cli/src/attestation/verdict-check.test.ts
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: high
dispatchable: true
dispatchableReason: 'Internal audit 2026-11-13 (findings A4, A5, C2, C6). The green flag-off status and the unconsumed gate context were verified by the planner on PRs #2623 and #2634 and in branch protection. Workflow and verdict-check changes with tests.'
---

## Description

**Gap.**

- With the feature flag off, the `flag-off-status` job posts a success on the gate's status context for every fork PR. `trusted-author-status` does the same for a trusted author. Both #2623 and #2634 show the gate as green although no review ran.
- Nothing reads the gate's context. It is not a required check, and making it required would hang same-repo PRs, which never report it. The only gate output that reaches the merge decision is the verdict record.
- Reported by the audit: the verdict check in `ai-sdlc-gate.yml` and `verdict-check.ts` does not require a clean-room record for a fork head, so a fork PR is not held to the gate's result.
- Reported by the audit: `verdict-writer.yml` takes `contents: write` and fails on every fork PR run that produced no artifact, and its concurrency group is keyed on the fork's branch name.

**Shape.**

1. `flag-off-status` and `trusted-author-status` stop posting success on the gate context. They post under a separate context whose description says no review ran, or post nothing.
2. In the `ai-sdlc/pr-ready` rollup, a PR whose head is in a fork passes the verdict check only with a record written by the gate's clean-room path for that head. A same-repo PR is unchanged.
3. `verdict-writer.yml` checks for the artifact in a job without write permission and starts the writing job only when it exists; concurrency is keyed on the run id.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: RFC-0043 and RFC-0061 require that a fork PR merges only on the gate's verdict; that stands. A separate required check for the gate is not needed, the rollup is the one merge gate (AISDLC-727). 2. Deleted: the success statuses of the flag-off and trusted-author jobs on the gate context. 3. Simplified or optimised: one extra condition in the existing verdict check; no new required check. 4. Accelerated: the writer no longer runs and fails on runs with nothing to write. 5. Automated: workflow tests and verdict-check unit tests.

## Acceptance Criteria

- [ ] #1 With the flag off, a fork PR shows no success on the gate's status context. A workflow test asserts that neither `flag-off-status` nor `trusted-author-status` posts `success` on that context.
- [ ] #2 The verdict check fails for a fork head that has no clean-room record, and for a fork head whose only record came from another tier. Unit tests in `verdict-check.test.ts`.
- [ ] #3 The verdict check result for a same-repo head is unchanged; existing tests pass without edits to their expectations.
- [ ] #4 `verdict-writer.yml` holds `contents: write` only in a job that starts after an artifact check succeeded; a run with no artifact ends green without that job. Concurrency is keyed on the run id.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
