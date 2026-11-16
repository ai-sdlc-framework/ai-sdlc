---
id: AISDLC-1270
title: 'Verdict check: a verdict record counts only for the pull request it was issued for'
status: Done
assignee: []
created_date: '2026-11-13'
labels:
  - pipeline-cli
  - merge-gate
  - security
dependencies: []
references:
  - pipeline-cli/src/attestation/verdict-check.ts
  - pipeline-cli/src/attestation/verdict-check.test.ts
  - pipeline-cli/src/attestation/verdict-record.ts
  - pipeline-cli/src/next-step/verdict-ref-push.ts
  - .github/workflows/ai-sdlc-gate.yml
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
priority: medium
dispatchable: true
dispatchableReason: 'Internal audit 2026-11-13 (finding C1). The planner verified that verdict-check.ts compares the head sha only and never reads the PR number. Operator decision 2026-11-13: file openly now. One check, one field, unit tests.'
---

## Description

**Gap.** The merge gate reads a verdict record from `refs/ai-sdlc/verdicts/*` (RFC-0061). `pipeline-cli/src/attestation/verdict-check.ts` accepts a record when `subject.headSha` equals the head of the PR being checked. It does not compare the PR number, although the record carries one.

Two PRs can share a head commit: a second PR opened from the same commit, or a fork PR whose branch points at the head of an internal PR. A record issued for one then satisfies the check for the other. The audit also reports, unverified, that the carry-forward path accepts a record whose PR number is 0; the developer confirms or refutes that first.

**Shape.** The verdict check receives the number of the PR under test and fails with a distinct reason when the record's `subject.pullRequest` differs or is missing. `ai-sdlc-gate.yml` passes the PR number it already has. Records written before this change that lack a usable PR number are treated as no record; the review round writes a fresh one.

RFC-0061 already defines `subject.pullRequest`; this task makes the check read it and resolves no open question.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: RFC-0061 binds a verdict to what was reviewed; a commit alone does not identify the PR, so the binding is incomplete. 2. Deleted: acceptance of a record with PR number 0, if the developer confirms it exists. 3. Simplified or optimised: one extra comparison beside the existing head-sha comparison. 4. Accelerated: n/a. 5. Automated: unit tests for the mismatch, the missing number and the match.

## Acceptance Criteria

- [ ] #1 The PR body states whether a record with PR number 0 was accepted before this change, with the code path.
- [ ] #2 The verdict check fails with a reason distinct from `subject-mismatch` when the record's PR number differs from the PR under test, with the head sha equal.
- [ ] #3 The verdict check treats a record with a missing or zero PR number as no record.
- [ ] #4 A record whose head sha and PR number both match passes as before; existing passing tests keep their expectations apart from the added PR number input.
- [ ] #5 `ai-sdlc-gate.yml` passes the PR number to the verdict check through `node pipeline-cli/bin/...`, in the existing step.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
