---
id: AISDLC-1220
title: Resumed review round keeps the two-reviewer set and scopes the earlier head to the PR
status: In Progress
assignee: []
created_date: '2026-11-06'
labels:
  - fix
  - review-verdict
  - backlog-pressure
dependencies: []
references:
  - pipeline-cli/src/next-step/resume-decision.ts
  - pipeline-cli/src/next-step/review-prepare.ts
  - pipeline-cli/src/attestation/verdict-cli.ts
  - pipeline-cli/src/next-step/verdict-ref-push.ts
priority: high
dispatchable: true
---

## Description

**Source.** Planner root-cause look on 2026-11-06 (wake 21:19Z) at the "coverage-short required reviewers not all approving: correctness-reviewer, security-reviewer" failures on #2413 (AISDLC-1189, head 787253b9) and #2464 (AISDLC-1210, head dcc7e793). Both were resumed rounds. Their verdict records hold only `correctness-reviewer`, so the merge gate refuses them, and `verdict-ref-push.ts:61-67` never replaces an existing record for the same head, so the PR stays red until a new head commit exists.

**Root cause.** In `resume-decision.ts` the `delta` branch narrows the reviewer set to `['correctness-reviewer']` whenever `requiredReviewerKind(deltaPaths)` is not `three`. The merge gate computes coverage over the whole PR and always requires correctness plus security in the two-reviewer mode, so a delta round can never satisfy it. `review-prepare.ts` then maps that set to the `['testing','critic']` classifier and the three-reviewer fallback in `selectForReview` does not apply, so `security-reviewer` is dropped. Secondary: the earlier head comes from `listEarlierSubjects(runner, dir, head, undefined)`, which is not scoped to the PR and records carry `pullRequest: 0`, so the newest approved ref from any PR whose commit exists locally can become the delta baseline.

AISDLC-1197 (#2444) rejects such an approval at aggregation (symptom) but does not touch the resume decision, so every resumed round would still spend one wasted review round. This task removes the cause.

## Fix

**Five-step review (requirements first).**
1. *Question the requirement.* The delta round exists to spend less on re-review, not to lower the required reviewer set. The merge gate's coverage rule is the requirement; the executor must never produce a record it cannot pass.
2. *Delete.* The `['correctness-reviewer']`-only arm in the delta branch. Two-reviewer mode on a delta means `['correctness-reviewer','security-reviewer']`; three-reviewer mode keeps the three.
3. *Simplify.* Derive the delta reviewer set from the same function the gate uses for the whole-PR coverage check, so the two cannot drift. Pass the PR number into `listEarlierSubjects` so only this PR's earlier approved heads are candidates; with no PR number, return FULL.
4. *Accelerate.* None.
5. *Automate.* Unit tests on `resume-decision` for both modes and for the cross-PR baseline; a `review-prepare` test asserting the classifier keeps security on a delta round.

## Acceptance Criteria
- [ ] #1 A resumed round in two-reviewer mode runs correctness and security reviewers and its verdict record satisfies the gate's coverage check for the whole PR.
- [ ] #2 Three-reviewer mode on a delta still runs code, test and security reviewers.
- [ ] #3 The delta baseline is chosen only among earlier approved heads of the same PR; a record from another PR is never used; with no PR number the decision is FULL.
- [ ] #4 Tests cover #1 to #3; `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
- [ ] #5 The PR body names the two red PRs (#2413, #2464) as the motivating failures and states that existing coverage-short records need a new head commit (no record replacement is introduced here).
