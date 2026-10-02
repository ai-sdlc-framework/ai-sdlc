---
id: AISDLC-679
title: >-
  RFC-0052 operator task: run the head-to-head over 50 trusted PRs, review flagged cases, replay, decide the two switches
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0052
  - review
  - operator
dependencies:
  - AISDLC-677
references:
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - docs/operations/reviewer-dispatch-defaults.md
priority: high
dispatchable: false
dispatchableReason: "Operator-only: needs the live comparison window, judgment on flagged cases, and the two switch decisions"
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-run. The comparison window and the two decisions it feeds.

## Scope
1. Enable `staged.shadow: true` on `main` (operator config PR, per RFC-0052) when the head-to-head shadow run from the preceding task is in place.
2. Let the head-to-head run over at least 50 trusted PRs. Review every flagged case as
   it appears and record, per case, which side was right.
3. Run `cli-usage replay --set staged` over the reviews-ledger corpus and record the
   per-set figures.
4. Run `cli-reviews compare --bar`. If met, decide the first switch: the staged
   verdict and the Opus security verdict become the gates and the code and test
   reviewers retire (`reviewerSet: staged` on `main`, citing the evidence).
5. From the security subset of the same record, decide the second switch, or decide
   to keep the standalone security reviewer and say why.
6. Record per-set units per review from the usage ledger before and after the first
   switch.
7. Write a results note: compared PRs, flagged cases and who was right, both bar
   checks, both decisions with reasons, and cost before and after.

## Acceptance Criteria
- [ ] Shadow was enabled by an operator config PR and at least 50 trusted PRs were compared.
- [ ] Every flagged case has a recorded judgment of which side was right.
- [ ] The replay figures and both `--bar` results are recorded.
- [ ] Both switch decisions are recorded with reasons, and any switch applied is a base-branch config change citing the evidence file.
- [ ] Units per review per set are recorded before and after the first switch.
- [ ] A results note exists with the items in step 7.
<!-- SECTION:DESCRIPTION:END -->
