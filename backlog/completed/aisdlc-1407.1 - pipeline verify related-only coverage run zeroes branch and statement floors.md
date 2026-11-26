---
id: AISDLC-1407.1
title: Pipeline verify related-only coverage run zeroes branch and statement floors
status: Done
priority: high
created_date: '2026-11-26 01:23'
updated_date: '2026-11-26 01:23'
assignee: []
labels:
  - pipeline-cli
  - bug
dependencies: []
references:
  - pipeline-cli/src/steps/verify-commands.ts
  - scripts/pre-push-patch-coverage.mjs
---

## Description

**Five-step review (requirements first).** Requirement: the related-only verify run must not fail on package-wide floors it cannot meet; CI's full run and the 90% patch gate keep enforcing coverage (question: kept). Delete nothing; simplify: zero the two remaining floors exactly as lines and functions already are. No automation added.

**Gap (found 2026-11-25 running AISDLC-1407).** `coverageCommand` in `pipeline-cli/src/steps/verify-commands.ts` (line 184) runs a related-only vitest coverage run and zeroes only `--coverage.thresholds.lines` and `--coverage.thresholds.functions`. The orchestrator's vitest config also sets global floors for branches (70) and statements (80), and a related-only run can never meet them. So next-step's verify step marks every change touching `orchestrator/` red ("Coverage for statements (28.73%) does not meet global threshold (80%)") and sends it back to the developer. The developer cannot fix this inside the task branch, because next-step runs the main checkout's pipeline-cli build.

The same defect in `scripts/pre-push-patch-coverage.mjs` is fixed on the AISDLC-1407 branch (PR #3004, commit 84e9d2d71). This task fixes the pipeline copy.

## Acceptance Criteria
- [ ] #1 `coverageCommand` with related files also passes `--coverage.thresholds.branches=0` and `--coverage.thresholds.statements=0`; the test in `verify-commands.test.ts` asserts all four.
- [ ] #2 CI's full coverage run and the 90% patch gate are unchanged.
- [ ] #3 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

Unblocks AISDLC-1407 (PR #3004), whose verify step is red only because of this.
