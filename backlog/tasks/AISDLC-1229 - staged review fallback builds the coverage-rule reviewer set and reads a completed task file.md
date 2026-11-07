---
id: AISDLC-1229
title: staged review fallback builds the coverage-rule reviewer set and reads a completed task file
status: To Do
priority: high
labels: [bug, pipeline-cli, review]
dependencies: []
dispatchable: true
---

## Problem

Observed twice on AISDLC-707 / PR #2508 (08:12Z and 20:08Z, 2026-11-07), on a resumed review round under `reviewerSet: staged` (main since AISDLC-1222, 1cb5626d). Code, test and security reviewers all approved, and `next-step` still refused with `coverage short: missing correctness-reviewer; not approved` and asked for a developer iteration that has nothing to fix. Two defects combine:

1. `pipeline-cli/src/cli/staged-review.ts` (`prepare`) calls `findTaskFile(taskId, workDir)` from `steps/01-validate.ts` without `includeCompleted`. A resumed round runs after Step 10 moved the task file to `backlog/completed/`, so the task reads as unreadable and the staged round falls back (`.ai-sdlc/artifacts/_staged-review/AISDLC-707/dispatch.json`: `reason: task-unreadable`, `fallbackSet: three`). Reproduced by hand with `cli-staged-review prepare --task-id AISDLC-707 --work-dir .worktrees/aisdlc-707 --source-kind backlog`; the file parses with five acceptance criteria.
2. `pipeline-cli/src/steps/07-build-review-prompts.ts` builds the `three` prompts whenever the mode is `staged` (`selected = [...THREE_REVIEWER_SET]`), but the coverage rule the gate enforces (`computeRequiredReviewers` in `attestation/review-coverage.ts`, via `enforceReviewerCoverage` in `next-step/review-finalize.ts`, AISDLC-1197) classifies the same diff as `two` (`correctness-reviewer`, `security-reviewer`) when it touches no trust-chain path. The fallback path (`review-prepare.ts`, `prepareReview(..., { noStaged: true })`) therefore runs code and test reviewers that can never satisfy a requirement for `correctness-reviewer`. Every staged fallback on a non-trust-chain diff is wedged the same way; while the staged round succeeds the gate is skipped (`review.staged ? [] : ...`), which is why the defect only shows on fallback.

## Fix

**Five-step review (requirements first).**
1. Question: the coverage gate (one rule for the gate and the CI verifier) stands; the staged set running beside the classifier's set stands (DEC-0149). What does not stand is a prompt builder that picks a different set from the rule the gate enforces.
2. Delete: the `staged` special case in `07-build-review-prompts.ts` that hard-codes `THREE_REVIEWER_SET`. The staged mode builds the same prompts the classifier would build for the non-staged modes (`reduceForReviewScope` over `selection.reviewers`), so a fallback reviews with exactly the set the coverage rule requires. The stderr line about `/ai-sdlc execute` driving the staged pipeline stays.
3. Simplify: `staged-review.ts prepare` looks the task file up with `{ includeCompleted: true }`, the same lookup `isTaskFileCompleted` already uses for resumed rounds (AISDLC-738).
4. Accelerate: the coverage-short warning names the set that ran and the set the rule required (`ran: code-reviewer, test-reviewer, security-reviewer; required: correctness-reviewer, security-reviewer`), so the next mismatch is read from the verdict notes without a trace.
5. Automate last: nothing new.

## Acceptance Criteria

- [ ] #1 Test: `buildReviewPrompts` in `staged` mode for a diff with no trust-chain path builds the `correctness-reviewer` and `security-reviewer` prompts; for a trust-chain diff it builds the three; both equal what `computeRequiredReviewers` returns for the same paths.
- [ ] #2 Test: `cli-staged-review prepare` finds a task file under `backlog/completed/` and does not record `task-unreadable`; a task with no file in either directory still records it.
- [ ] #3 Test: a resumed round in `staged` mode whose staged round falls back ends with an approved aggregate when the reviewers the rule requires approve (no `coverage short` warning).
- [ ] #4 The coverage-short warning text names both sets (ran, required).
- [ ] #5 `docs/operations/quality-gate.md` (or the reviewer-set section it points to) states in one sentence that the staged mode builds the classifier's set and that a fallback reviews with that set.

## Notes

Live state: AISDLC-707 / #2508 sits in `failed/` with this cause and waits for this task to land; the planner re-enters it afterwards with a review-round note. The developer in the 20:08Z round also pushed head 2ffa9597 itself after a rebase despite the resume note; that is the AISDLC-1227 gap, not this task.
