---
id: AISDLC-1222
title: 'Enable staged review shadow on main: add .ai-sdlc/review-config.yaml with reviewerSet staged (starts the RFC-0052 50-PR window)'
status: To Do
assignee: []
created_date: '2026-11-07'
labels:
  - rfc-0052
  - review
  - config
dependencies: []
creates:
  - .ai-sdlc/review-config.yaml
references:
  - pipeline-cli/src/steps/reviewer-set.ts
  - pipeline-cli/src/review-plan/config.ts
  - pipeline-cli/src/next-step/review-prepare.ts
  - pipeline-cli/src/cli/reviews.ts
  - docs/operations/staged-review.md
  - docs/operations/reviewer-set-flag.md
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
priority: high
dispatchable: true
---

## Description

**Source.** Operator ruling 2026-11-07 on AISDLC-679. The staged review pipeline (RFC-0052, AISDLC-677) has run as advisory-only with no comparison data because the switch that starts the shadow run was never set on `main`. `.ai-sdlc/review-config.yaml` does not exist in this repository. The shipped switch is the `reviewerSet:` key read from the base ref by `pipeline-cli/src/steps/reviewer-set.ts` (`MODE_PATTERN`, values `three | code-test-merged | staged`); when it is `staged`, `pipeline-cli/src/next-step/review-prepare.ts` runs the classifier's normal gating set and starts the staged round beside it, and the staged leaf is written to the reviews ledger with `gating: false` (DEC-0149). The `staged:` block parsed by `pipeline-cli/src/review-plan/config.ts` holds limits only (`executorCommandAllowlist`, `riskThreshold`, `maxProbes`, `maxTargetBytes`, `evidenceBudgetBytes`); no `staged.shadow` key exists in code, so the `staged.shadow: true` wording of AISDLC-677 and AISDLC-679 maps to `reviewerSet: staged` (`docs/operations/staged-review.md`, "Shadow comparison").

## Scope

Create `.ai-sdlc/review-config.yaml` on `main` with exactly:

```yaml
# RFC-0052 shadow window (AISDLC-1222, operator ruling 2026-11-07).
# The gating set is unchanged; the staged pipeline runs beside it with gating: false.
reviewerSet: staged
```

Nothing else changes. The PR body states that this starts the head-to-head window for AISDLC-679, that `cli-reviews compare --bar` reports progress against 50 compared PRs and 95 percent act-band precision, and that the planner removes the key by PR once 50 trusted PRs are compared (or earlier on a drain hold). The file is under `.ai-sdlc/`, a trust-chain path, so the PR itself is reviewed by the three-reviewer set.

## Acceptance Criteria

- [ ] #1 `.ai-sdlc/review-config.yaml` exists on `main` with `reviewerSet: staged` and the two comment lines above; the diff touches no other file.
- [ ] #2 On the first backlog-sourced PR after the merge, the reviews ledger carries a `staged` row with `gating: false` beside the gating reviewers' rows for the same commit, and the PR's attestation still verifies on the classifier's normal set.
- [ ] #3 `node pipeline-cli/bin/cli-reviews.mjs compare --bar` reports at least one compared PR after that merge.
- [ ] #4 The PR body names AISDLC-679, the 50-PR / 95 percent bar, and the planner's off switch (remove the key by PR).

## Ruling 2026-11-07 (operator, decision rubric)

Option A of the 2026-11-07 ruling on AISDLC-679: staged review has been advisory with no data because shadow was never enabled; shadow deployment with a predefined bar (RFC-0052 OQ-2: 50 PRs, 95 percent precision, DEC-0149) is the standard way to validate a replacement judge. Counter-argument (budget week, shadow adds load) rebutted: the 7-day line is under target and a drain hold pauses shadow with it. Chosen over an auto-off code change (adds a task before any data) and over parking.

## References

- `pipeline-cli/src/steps/reviewer-set.ts` (`MODE_PATTERN`, `STAGED_SET_SOURCE_KINDS`), `pipeline-cli/src/next-step/review-prepare.ts` (staged round beside the gating set), `pipeline-cli/src/review-plan/config.ts` (`staged:` limits block).
- `docs/operations/staged-review.md` "Shadow comparison" and "The two switches"; RFC-0052 section 6 and OQ-2.
