---
id: AISDLC-541
title: >-
  chore(rfc): lifecycle sweep — schedule ratify-or-retire walkthroughs for the
  22 Draft-lifecycle RFCs so spec authority matches spec surface
status: To Do
assignee: []
labels:
  - rfc
  - governance
  - adoption
  - ci:no-issue-required
priority: medium
dependencies: []
references:
  - spec/rfcs/README.md
dispatchable: false
dispatchableReason: >-
  Lifecycle promotion requires operator OQ walkthroughs and sign-off — not
  LLM-dispatchable; this task tracks the sweep schedule and its bookkeeping.
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The 2026-06-12 repo review counted 22 of 40 RFCs still in Draft lifecycle
(10 Implemented, 5 Approved, 3 Final by status field). The spec surface is
growing roughly twice as fast as it is being ratified, which dilutes the
authority of the spec exactly when external adopters are starting to evaluate
it: a prospective adopter cannot tell which Draft documents are load-bearing
design contracts versus parked ideas.

Deliverable: an operator-driven sweep over every Draft-lifecycle RFC, deciding
per RFC one of: (a) walk through open questions and promote toward Signed
Off/Implemented, (b) mark Superseded/Withdrawn with a pointer to what replaced
it, or (c) explicitly park it with a Reserved-style annotation in the registry
so its non-normative status is visible. The existing open-question walkthrough
workflow (per-RFC operator sessions) is the mechanism for bucket (a); this task
is the umbrella that tracks the schedule and records the per-RFC disposition in
the registry table of `spec/rfcs/README.md`.

Suggested cadence: batch the sweep into operator sessions of 2-3 RFCs each,
highest-leverage first (RFCs referenced by open backlog tasks or by the
adoption-facing docs get priority). Each session's dispositions land as their
own docs PR.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Registry table in `spec/rfcs/README.md` carries an explicit disposition (promote / supersede / park) for every RFC that was in Draft lifecycle at sweep start
- [ ] #2 Bucket (b) and (c) RFCs updated: lifecycle field set to Superseded/Withdrawn or a registry annotation marks them parked, with a one-line rationale each
- [ ] #3 Bucket (a) RFCs have a scheduled walkthrough order recorded in this task's notes, highest-leverage first, and at least the first batch completed
- [ ] #4 `pnpm rfc:check` and `pnpm rfc:lifecycle-check` pass after every disposition PR
<!-- AC:END -->
