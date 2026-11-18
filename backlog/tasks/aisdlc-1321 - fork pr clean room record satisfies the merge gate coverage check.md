---
id: AISDLC-1321
title: 'Fork PR clean-room record satisfies the merge gate coverage check, both sides read one required-reviewer rule'
status: To Do
assignee: []
created_date: '2026-11-18'
labels:
  - ucvg
  - merge-gate
  - attestation
dependencies: []
references:
  - pipeline-cli/src/attestation/review-coverage.ts
  - pipeline-cli/src/attestation/verdict-check.ts
  - pipeline-cli/src/attestation/verdict-check.test.ts
  - pipeline-cli/src/attestation/verdict-untrusted.ts
  - pipeline-cli/src/attestation/verdict-untrusted.test.ts
  - pipeline-cli/src/attestation/verdict-cli.ts
  - docs/operations/untrusted-pr-gate.md
priority: high
dispatchable: true
dispatchableReason: 'A fork PR cannot pass ai-sdlc/pr-ready today; the fix is bounded to the verdict code and its tests.'
---

## Description

**Gap.** A fork PR that passes the untrusted-PR gate still fails the PR Ready Gate, so no fork PR can land through the clean-room path.

What was seen on fork PR #2634 (head `c9c3dfb51ce5fff3ea759a89787a334c1f4dfd3d`):

- The untrusted-PR gate (run 44356420699, Stage 4) wrote a verdict record at `refs/ai-sdlc/verdicts/c9c3dfb51...` with `issuedBy.principal: ci-clean-room`, `verdict: approved`, three reviewers (`code-reviewer`, `test-reviewer`, `security-reviewer`, harness `ucvg-sandbox`, all approved), `coverage.required` of those same three, and `coverage.satisfied: true`.
- The PR Ready Gate (run 44356423104, job "Review verdict (code PRs)") then ran `cli-attestation verdict-check ... --require-clean-room` and failed with `coverage-short required reviewers not all approving: correctness-reviewer, security-reviewer`.

**Cause (read from the source).** The two sides compute the required reviewers by different rules.

- The writer, `buildCleanRoomVerdict` (`pipeline-cli/src/attestation/verdict-untrusted.ts:40-80`), always records the three-reviewer set. It passes `changedPaths: null` (`:53`), which the classifier turns into three, and its comment says the sandbox matrix always runs three (`:52`). The reviewer names are fixed at `:24-28`.
- The checker, `checkVerdict` (`pipeline-cli/src/attestation/verdict-check.ts:121`), derives the set from the real changed paths of the PR with `computeRequiredReviewers({ changedPaths })`. A diff with no trust-chain path gets the two-reviewer set, `correctness-reviewer` and `security-reviewer`. The classifier is `classifyReviewerSet` (`pipeline-cli/src/steps/reviewer-set.ts:129-147`), which maps two to `CODE_TEST_MERGED_REVIEWER_SET` (`:107-110`, set in AISDLC-617 and made the diff-derived default in AISDLC-722).
- The test at `verdict-check.ts:123-125` then finds `correctness-reviewer` missing from the record's `coverage.required`. The test at `:125` also finds it is not among the approving names. Coverage is a plain name match in `evaluateCoverage` (`pipeline-cli/src/attestation/review-coverage.ts:51-67`); a code plus test pair does not count as a correctness review there.
- The refusal prints the whole required set (`verdict-check.ts:136`), not the missing names. That is why `security-reviewer` appears in the message although the record has it approved. The message misleads, but the cause is only `correctness-reviewer`.

So a clean-room record can never pass for a fork PR that touches no trust-chain path. A fork PR that touches one (three required) would pass.

**Why no test caught it.** `verdict-untrusted.test.ts` builds and validates the record but never calls `checkVerdict`. The `requireCleanRoom` tests in `verdict-check.test.ts:308-338` take a hand-built three-reviewer record and pass `changedPaths: null` (`:323`), which also requires three, so the two sides agree there by accident. No test feeds the real writer output to the checker with real changed paths.

**Shape.** The required reviewers for a head depend on where the review ran. A clean-room review always runs the three UCVG reviewers, so for a clean-room head the required set is the three-reviewer set, whatever the paths. The writer and the checker ask one function for it.

**Control.** No merge control is loosened. Nothing new is accepted: the required set for a clean-room head is the full three, which is equal to or stricter than what the checker asks for today. A same-repo head keeps the diff-derived set. The checker still reads the clean-room flag from its own input (the workflow, run from the base tree), never from the record.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: "the checker derives the set from the diff for every head" (AISDLC-722) was set for reviews the pipeline runs itself; no decision asks a clean-room review, which always runs three reviewers, to also produce a merged correctness review, and the writer already states it is a three-reviewer set. 2. Deleted: the second, separate derivation of the clean-room set (the hard-coded `changedPaths: null` at `verdict-untrusted.ts:53`, which only works by accident). 3. Simplified or optimised: one function, `requiredReviewersFor`, that both the writer and the checker call; the clean-room case is one branch in it. 4. Accelerated: no change to the UCVG matrix, no new reviewer run, no extra cost; the failing fork PRs pass on the next gate run. 5. Automated: an end-to-end test that feeds the writer output to the checker, so a drift between the two fails in CI.

- **Shared rule.** In `review-coverage.ts` add `requiredReviewersFor(origin, changedPaths)` where `origin` is `clean-room` or `pipeline`. For `pipeline` it returns exactly what `computeRequiredReviewers({ changedPaths })` returns today. For `clean-room` it returns the three-reviewer set (call `computeRequiredReviewers` with `requireThree: true`) with a reason that says the clean-room matrix runs three.
- **Writer.** `buildCleanRoomVerdict` calls `requiredReviewersFor('clean-room', null)` instead of its own `computeRequiredReviewers({ changedPaths: null })` and keeps the comment accurate.
- **Checker.** `checkVerdict` calls `requiredReviewersFor(opts.requireCleanRoom ? 'clean-room' : 'pipeline', opts.changedPaths)`. The origin comes from the `requireCleanRoom` option only.
- **Refusal text.** For `coverage-short`, list the reviewers that are missing from the record or not approving, not the whole required set. Keep the code `coverage-short` and the existing `verdict is not approved` text.
- **Docs.** In `docs/operations/untrusted-pr-gate.md`, state that a fork head needs all three clean-room reviewers approving, and that a same-repo head keeps the diff-derived set.

Out of scope: running a correctness reviewer in the UCVG matrix; letting a code plus test pair count as a correctness review (that would change what the gate accepts and is a separate decision); the `reviewerSet` setting in `.ai-sdlc/review-config.yaml` (the checker does not read it today, and that is not changed here); tier and carry-forward rules.

## Acceptance Criteria

- [ ] #1 A test in `review-coverage.test.ts`: `requiredReviewersFor('clean-room', paths)` returns `code-reviewer`, `test-reviewer`, `security-reviewer` for a non-trust-chain path list, for a trust-chain path list and for `null`; `requiredReviewersFor('pipeline', paths)` returns the same as `computeRequiredReviewers({ changedPaths: paths })` for the same three inputs.
- [ ] #2 An end-to-end test in `verdict-check.test.ts` (or a new test file beside it): a record produced by the real `buildCleanRoomVerdict` from an all-approved UCVG report is served to `checkVerdict` with `requireCleanRoom: true` and `changedPaths` that touch no trust-chain path (for example `['pipeline-cli/src/foo.ts']`); the result is `ok`. The same test with a trust-chain path list also returns `ok`.
- [ ] #3 A test: a clean-room record built from a report where one reviewer is not approved, and a hand-edited clean-room record that lacks `test-reviewer`, are each refused by `checkVerdict` with `coverage-short` for the same non-trust-chain paths.
- [ ] #4 A test: the `coverage-short` detail names only the reviewers that are missing or not approving (for example `test-reviewer`), and does not name a reviewer that is present and approved.
- [ ] #5 The existing `requireCleanRoom` tests (no record, wrong issuer, same-repo head unchanged) and the existing coverage tests for a same-repo head pass unchanged, and a same-repo head with a non-trust-chain diff still needs `correctness-reviewer` and `security-reviewer`.
- [ ] #6 `buildCleanRoomVerdict` and `checkVerdict` both call `requiredReviewersFor`; neither calls `computeRequiredReviewers` directly (a test or a grep-based test asserts it, so the two cannot drift again).
- [ ] #7 `docs/operations/untrusted-pr-gate.md` states the fork-head required set and the same-repo rule.
- [ ] #8 The diff does not touch `.ai-sdlc/review-config.yaml`, `classifyReviewerSet`, the UCVG workflow or the reviewer matrix.
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
