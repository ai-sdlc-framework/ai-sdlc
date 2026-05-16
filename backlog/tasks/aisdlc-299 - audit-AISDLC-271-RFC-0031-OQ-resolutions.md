---
id: AISDLC-299
title: 'audit: AISDLC-271 / RFC-0031 OQ resolutions for operator approval (revert candidate)'
status: To Do
assignee: []
created_date: '2026-05-15'
labels:
  - audit
  - rfc-0031
  - revert-candidate
  - governance-gap
  - critical
dependencies: []
references:
  - spec/rfcs/RFC-0031-calibration-driven-did-revision-proposal.md
  - orchestrator/src/sa-scoring/revision-proposal.ts
  - orchestrator/src/sa-scoring/revision-proposal.test.ts
  - backlog/completed/aisdlc-271 - chore-complete-RFC-0031-DIDRevisionProposal-mechanism.md
priority: critical
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0031 was implemented in a single development iteration (AISDLC-271) with all 5 OQs resolved inline by the dev subagent — without operator walkthrough. This task retroactively walks through the §12 OQ resolutions; the operator confirms or revises each. If revisions are needed, this task either files a Refit chain (per the AISDLC-320 / 321 + 275-278 RFC-0024 pattern) OR triggers reversion of the merged code.

## Why this matters

The user's reaction to the same pattern in AISDLC-269 / RFC-0024: "if they were implemented in a single development iteration then I would question the implementation". RFC-0031 has the same shape — Product author (Alexander Kline) + operator dispatch + dev subagent decides 5 OQs while writing the code. There was no cross-pillar review on the resolutions.

## Scope

- Operator walkthrough on each of RFC-0031 §12 OQs (5 total: OQ-12.1 confidence threshold, OQ-12.2 single-field-per-proposal scope, OQ-12.3 lockNoProposal opt-out, OQ-12.4 expiry semantics, OQ-12.5 rejection learnings).
- For each OQ: full-format walkthrough (problem / industry research / 3-4 options / recommendation + counter-argument) — same standard as RFC-0024 / RFC-0035 OQ walkthroughs.
- Compare each operator-affirmed resolution against the shipped implementation in `revision-proposal.ts`.
- Decision matrix:
  - **All 5 match shipped code** → no action; record operator approval in RFC-0031 §12 + add v0.X revision history entry.
  - **1-2 minor diffs** → file targeted refit task(s).
  - **3+ major diffs OR foundational disagreement** → file revert task; revert AISDLC-271's commits from main; re-implement against operator-resolved OQs.

## Linked decisions

- AISDLC-269 / RFC-0024 had the same pattern; user has already decided to refit (AISDLC-320 / 321 + 275-278). This task asks the same question for RFC-0031.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Operator walkthrough completed for each of RFC-0031 §12 OQs (5 total)
- [ ] #2 Each operator-affirmed resolution compared against shipped `revision-proposal.ts`
- [ ] #3 Decision matrix outcome documented (no action / refit / revert) per OQ
- [ ] #4 If "no action": RFC-0031 v0.X revision history entry records operator approval
- [ ] #5 If "refit": file targeted refit tasks
- [ ] #6 If "revert": file revert task + re-implementation plan
<!-- AC:END -->
