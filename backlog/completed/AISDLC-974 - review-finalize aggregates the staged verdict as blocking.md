---
id: AISDLC-974
title: 'review-finalize aggregates the staged verdict as blocking; DEC-0149 made staged advisory'
status: Done
assignee: []
created_date: '2026-10-20'
labels:
  - review
  - attestation
dependencies: []
references:
  - pipeline-cli/src/next-step/review-finalize.ts
  - docs/operations/reviewer-set-flag.md
priority: high
dispatchable: true
---

## Description

`pipeline-cli/src/next-step/review-finalize.ts:203` seeds the round's verdict list with the staged verdict (`const verdicts: ReviewerVerdict[] = review.staged?.verdict ? [review.staged.verdict] : [];`), the classic reviewers' verdicts are appended at `:231` (a reviewer that never reported) and `:246` (a reported verdict), and the whole list goes through `aggregateRound` at `:334`, which calls `aggregateVerdicts` at `:349`. Nothing distinguishes the staged entry from a classic one, so a staged CHANGES_REQUESTED blocks the round even when every classic reviewer approved.

DEC-0149 (event `.ai-sdlc/_decisions/events/2026-10-12T20-38-08.672Z__DEC-0149__operator-answered__5be7ae89307a.json`, chosen option `drop-verifier`) made the staged pipeline advisory until RFC-0052 OQ-2 has its precision evidence: the staged leaves never count toward reviewer-set coverage and the classic set always runs. The verifier side of that decision landed; the aggregation side did not. `docs/operations/reviewer-set-flag.md:97` even states the opposite ("Step 8 aggregates the staged verdict together with the normal set's verdicts by the same blocking rules as any other set") while citing DEC-0149 in the same paragraph.

Fix: the staged verdict is still persisted to the ledger and its leaf is still emitted (the OQ-2 measure needs the staged findings next to the classic verdict), and it is still reported in the aggregate output as an advisory section, but it is excluded from the list that decides APPROVED versus CHANGES_REQUESTED. The doc paragraph is corrected to say advisory. A test proves a staged CHANGES_REQUESTED next to classic APPROVED verdicts does not block, and that a classic CHANGES_REQUESTED still does.

**Five-step review (requirements first).**
1. Requirement questioned: does the staged verdict need to block at all before OQ-2 closes? No; DEC-0149 says advisory, and a blocking advisory verdict is a contradiction that costs an iteration round per false positive.
2. Delete: the staged seed at `:203` leaves the blocking list; nothing else is deleted.
3. Simplify: one list for blocking verdicts, one field for the advisory staged verdict, instead of a flag on each entry.
4. Accelerate: a staged false positive no longer triggers a fix round, so the review loop ends one iteration sooner.
5. Automate: the unit test on `aggregateRound` input shape pins the behaviour so a future refactor cannot reseed the list.

## Acceptance Criteria

- [ ] `review-finalize.ts` no longer seeds `verdicts` with `review.staged.verdict`; the staged verdict is carried on the aggregate result as an advisory field and still written to `aggregate.json`.
- [ ] The staged leaf is still emitted and the staged verdict still persisted exactly as before (no change to attestation output).
- [ ] A test proves a staged CHANGES_REQUESTED with all classic reviewers APPROVED yields `decision: APPROVED`, and a classic CHANGES_REQUESTED still yields CHANGES_REQUESTED.
- [ ] `docs/operations/reviewer-set-flag.md` paragraph on the staged set says the staged verdict is advisory and does not block, citing DEC-0149.
