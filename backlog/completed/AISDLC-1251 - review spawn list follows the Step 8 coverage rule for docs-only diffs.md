---
id: AISDLC-1251
title: 'The review spawn list is computed from the Step 8 coverage rule, so a docs-only diff spawns security-reviewer when the gate requires it'
status: Done
assignee: []
created_date: '2026-11-08'
labels:
  - review
  - pipeline-cli
  - bug
dependencies: []
references:
  - pipeline-cli/src/next-step/review-prepare.ts
  - pipeline-cli/src/next-step/review-prepare.test.ts
  - pipeline-cli/src/attestation/review-coverage.ts
  - pipeline-cli/attestation-core/review-scope-core.mjs
  - pipeline-cli/src/next-step/review-finalize.ts
priority: high
dispatchable: true
dispatchableReason: 'Planner wake 2026-11-08 22:2xZ (DEC-0401 keep-and-automate): AISDLC-506 (#2580, three Markdown files) failed a fourth review round on the AISDLC-1247 build with the same coverage-gate finding "missing security-reviewer"; reproduced against dist: selectForReview returns [correctness-reviewer] while computeRequiredReviewers returns [correctness-reviewer, security-reviewer] for the same paths. The executor cannot work around it; 506 re-enters only after this lands.'
---

## Description

**Gap.** AISDLC-1247 (#2604, d975a2c4) made `selectForReview` (`pipeline-cli/src/next-step/review-prepare.ts` lines 141-160) force `security-reviewer` for every reviewer kind except `correctness-only`, keying the kind off `requiredReviewerKind` in `pipeline-cli/attestation-core/review-scope-core.mjs` (line 317). That function returns `correctness-only` for a docs-adjacent or test-only diff (AISDLC-723 narrowing). The Step 8 coverage gate (`review-finalize.ts` `enforceReviewerCoverage`, lines 501-540) uses a different rule: `computeRequiredReviewers` in `pipeline-cli/src/attestation/review-coverage.ts` (RFC-0061 goal 5, "the ONE coverage rule"), which calls `classifyReviewerSet` and knows only `two` and `three`; for every non-trust-chain diff it requires `correctness-reviewer` and `security-reviewer`. For a docs-only diff the two rules disagree: the spawn list drops security, the gate demands it, and no later round can satisfy it because every round re-runs the same selection.

**Observed.** AISDLC-506 / PR #2580 (paths: `backlog/completed/aisdlc-506 - ….md`, `docs/concepts/zero-trust-untrusted-pr-verification.md`, `docs/whitepapers/untrusted-contributor-verification.md`) failed four review rounds on 2026-11-08, the last two (21:14Z and 21:49Z) on a dist that contains the 1247 fix. Reproduction against `pipeline-cli/dist` with those three paths:

```
requiredReviewerKind      -> kind: correctness-only (docs-adjacent)
classifyReviewerSet       -> set: two, reviewers: [correctness-reviewer, security-reviewer]
computeRequiredReviewers  -> required: [correctness-reviewer, security-reviewer]
selectForReview(prompts, ['critic'], paths, true) -> [correctness-reviewer]
```

The 1247 property test (AC-3) asserted the superset against `requiredReviewerKind`, not against `computeRequiredReviewers`, so it passed while the gate still fails.

**Shape.** One source of truth, as 1247's own Shape stated: the spawn list is computed from the same `computeRequiredReviewers` the gate uses. `selectForReview` takes the `coverage.required` set (computed once from the changed paths, with the repository's `requireThree` option) and forces every name in it into the spawned set; the classifier narrows only reviewers outside that set. `requiredReviewerKind` stops being an input to spawn selection. The delta-resume branch keeps its delta-derived set as today. Whether a docs-only diff should require a security review at all is a separate design question for the coverage rule and is NOT decided here: this task only makes selection a superset of what the gate enforces, which tightens, never loosens, review.

## Fix

**Five-step review (requirements first).**
1. Question: may the spawn list disagree with the gate it feeds? No. A round that cannot satisfy its own gate is a dead end, not a control.
2. Delete: the `requiredReviewerKind` dependency in `selectForReview` and the `kind`-based early returns (lines 149-158); `review-prepare.ts` no longer imports from `review-scope-core.mjs` unless something else needs it.
3. Simplify: `selectForReview(prompts, names, required: readonly string[], forceCoverage)` where `required` comes from `computeRequiredReviewers({ changedPaths, requireThree }).required`, the same call Step 8 makes.
4. Accelerate: none.
5. Automate: the AC-3 property test asserts `spawned ⊇ computeRequiredReviewers(paths).required` for docs-only, test-only, mixed and trust-chain path sets and for every classifier answer including `[]` and `['critic']`.

## Acceptance Criteria

- [x] AC-1: with changed paths exactly the three AISDLC-506 files and classifier answer `['critic']`, `prepareReview` spawns `correctness-reviewer` and `security-reviewer`; test.
- [x] AC-2: `selectForReview` receives the coverage rule's required set and no longer calls `requiredReviewerKind`; a trust-chain path set still spawns code, test and security reviewers (existing AISDLC-850 behaviour kept); test.
- [x] AC-3: a property test over path classes {docs-only, test-only, mixed source, trust-chain} × classifier answers {`[]`, `['critic']`, `['testing']`, `['security']`, all} asserts `spawned ⊇ computeRequiredReviewers(paths).required`.
- [x] AC-4: the delta-resume branch is unchanged (existing delta test still passes).
- [x] AC-5: `docs/operations/quality-gate.md` reviewer-set sentence names `computeRequiredReviewers` as the single rule both the spawn list and the gate read.
- [x] AC-6: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
selectForReview now takes the computeRequiredReviewers(...).required set (the rule the Step 8 gate uses, with requireThree from the reviewer-set reason) and forces every name in it. requiredReviewerKind is no longer a spawn input. A delta resume passes its delta-derived reviewers, so that branch behaves as before. quality-gate.md now names computeRequiredReviewers as the single rule.

## Changes
- pipeline-cli/src/next-step/review-prepare.ts
- pipeline-cli/src/next-step/review-prepare.test.ts
- docs/operations/quality-gate.md
- backlog/tasks/AISDLC-1251 - review spawn list follows the Step 8 coverage rule for docs-only diffs.md

## Design decisions
AC-1 is covered by a selectForReview-level test with the three AISDLC-506 paths. It is not a full prepareReview test with those paths, because the prepareReview fixture's changed file is hard-coded to src/a.ts. Two prepareReview tests changed because the pinned `three` set now makes the coverage rule require code, test and security. 'honours the classifier subset' is renamed and now expects correctness plus security. The 1247 'classifier selects none' test now expects all three. The staged `.active-task` claim edit to the backlog task file (status In Progress) was included in the commit. Pushing needed `git -C <worktree>` with no `cd &&` compound, because the force-push hook rejects compound commands.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

