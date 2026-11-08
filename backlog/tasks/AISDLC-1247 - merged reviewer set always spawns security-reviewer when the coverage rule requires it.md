---
id: AISDLC-1247
title: 'The review spawn list always includes security-reviewer when the coverage rule requires it, so the merged set never fails its own coverage gate'
status: In Progress
assignee: []
created_date: '2026-11-08'
labels:
  - review
  - pipeline-cli
  - bug
dependencies: []
references:
  - pipeline-cli/src/next-step/review-prepare.ts
  - pipeline-cli/src/next-step/staged-round.ts
  - pipeline-cli/src/next-step/review-finalize.ts
  - pipeline-cli/src/next-step/resume-decision.ts
priority: high
dispatchable: true
dispatchableReason: 'Planner wake 2026-11-08 18:0xZ (DEC-0401 keep-and-automate): AISDLC-506 (#2580) failed at the 2-iteration cap because both rounds spawned only correctness-reviewer while the Step 8 coverage gate required security-reviewer; the defect is in code the executor cannot work around, so 506 re-enters only after this lands.'
---

## Description

**Gap.** Two rules decide which reviewers run. The spawn list (`review-prepare.ts` `selectByClassifier` lines 115-133 and `selectForReview` lines 141-150) follows the narrowing classifier and keeps `security-reviewer` only when the classifier answers `security`; the "always keep" floor applies only when `requiredReviewerKind` is `three`. The Step 8 coverage gate (`review-finalize.ts` `enforceReviewerCoverage`, lines 501-540) follows the path-based rule, which for the merged set includes `security-reviewer` (AISDLC-1220, `resume-decision.ts` 156-157). When the classifier drops security, the gate raises a critical `coverage-gate` finding that no later round can satisfy, because every round re-runs the same narrowed selection. AISDLC-506 hit the cap this way on 2026-11-08 (PR #2580, verdict in `failed/`). The staged path has the same shape: `review-prepare.ts` 454-466 builds `security` separately, then `staged-round.ts` line 461 writes `spawned: beside.length > 0 ? beside : [security]`, replacing security with the narrowed list instead of adding it.

**Shape.** The spawn list is a superset of what the coverage gate will require: compute `coverage.required` once, before selection, and force every required reviewer into the spawned set regardless of the classifier answer; in the staged path append `security` to `beside` when it is missing. The classifier still narrows optional reviewers.

## Fix

**Five-step review (requirements first).**
1. Question: should the classifier be allowed to drop a reviewer the gate requires? No; a gate that cannot be satisfied by any round is a dead end, not a control.
2. Delete: nothing; the classifier narrowing stays for optional reviewers.
3. Simplify: one source of truth for the required set, consumed by both selection and the gate.
4. Accelerate: none.
5. Automate: unit tests pin the superset property for `merged` and `staged` kinds.

## Acceptance Criteria

- [ ] AC-1: for the merged reviewer kind, a classifier answer of `['testing','critic']` on a diff whose paths require security still spawns `security-reviewer`; test.
- [ ] AC-2: in the staged path, a non-empty `beside` list is extended with `security` rather than replacing it; test on `staged-round.ts`.
- [ ] AC-3: a property test over the reviewer kinds asserts `spawned ⊇ coverage.required` for every classifier answer.
- [ ] AC-4: `docs/operations/quality-gate.md` reviewer-set section states in one sentence that the spawn list always covers the coverage rule.
- [ ] AC-5: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
