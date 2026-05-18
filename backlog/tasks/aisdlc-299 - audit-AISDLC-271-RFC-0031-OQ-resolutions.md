---
id: AISDLC-299
title: 'audit: AISDLC-271 / RFC-0031 OQ resolutions for operator approval (revert candidate)'
status: Done
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
finalSummary: |
  ## Summary
  Operator walkthrough of all 5 RFC-0031 §12 OQs (AISDLC-271 subagent-inline resolutions) completed 2026-05-16. Outcome: **not a revert candidate** — shipped code is operator-aligned at the foundation. RFC-0031 v1.2 revision history entry records operator approval. Two OQs (12.1 + 12.5) get additive per-org config exposure via Refit AISDLC-310; three OQs (12.2, 12.3, 12.4) affirmed unchanged.

  ## Changes
  - `spec/rfcs/RFC-0031-calibration-driven-did-revision-proposal.md` (modified, on main): v1.2 revision history entry added; §12 rewritten to preserve original question + first-pass + resolution per OQ; §12.6 added consolidating the per-org calibration.yaml schema.
  - `backlog/tasks/aisdlc-310 - feat-RFC-0031-refit-per-org-calibration-config.md` (new, on main): Refit task filed for OQ-12.1 + OQ-12.5 per-org config exposure.
  - `backlog/tasks/aisdlc-299 - audit-AISDLC-271-RFC-0031-OQ-resolutions.md` (this file): ACs marked complete, finalSummary added, status → Done.

  ## Decision matrix per OQ

  | OQ | Subject | Operator verdict | Action |
  |---|---|---|---|
  | 12.1 | Confidence calibration thresholds | Affirmed shipped defaults (≥20 / <5); add per-org config exposure | Refit AISDLC-310 |
  | 12.2 | Multi-field bundling deferral | Affirmed — shipped matches Alex's position exactly | No action |
  | 12.3 | lockNoProposal opt-out (lock-precedes-trigger) | Affirmed — JSON-path / deny-precedes-allow pattern correct | No action |
  | 12.4 | Cross-pillar approval routing graduation | Affirmed — `deriveApprovalPath()` already graduates per §8 (core→triad, evolving→pillarLead); initial misread corrected, AISDLC-309 retracted | No action |
  | 12.5 | Rejection learnings (weights + flat-mean) | Affirmed shipped defaults (0.8/0.5/0.2, floor 0.2); add per-org config exposure + document recency-decay gap | Refit AISDLC-310 |

  ## Design decisions
  - **Not a revert candidate**: shipped code is operator-aligned at the foundation; additive per-org config is the correct refinement path.
  - **AISDLC-309 retracted**: initial audit pass mis-framed OQ-12.4 behavior as "uniform 2-approver"; re-read of `deriveApprovalPath()` confirmed shipped graduation matches operator intent.
  - **Governance pattern documented**: RFC-0031 §12 rewritten preserving original-question + subagent-first-pass + resolution, same pattern as RFC-0025 §13 walkthrough. `docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md` cross-referenced.

  ## Verification
  - `pnpm build` — clean
  - `pnpm test` — clean
  - `pnpm lint` — clean
  - `pnpm format:check` — clean

  ## Follow-up
  - AISDLC-310: expose `confidenceThresholds` + `rejectionPrecedent` in `.ai-sdlc/calibration.yaml` (per-org config for OQ-12.1 + OQ-12.5)
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
- [x] #1 Operator walkthrough completed for each of RFC-0031 §12 OQs (5 total)
- [x] #2 Each operator-affirmed resolution compared against shipped `revision-proposal.ts`
- [x] #3 Decision matrix outcome documented (no action / refit / revert) per OQ
- [x] #4 If "no action": RFC-0031 v0.X revision history entry records operator approval
- [x] #5 If "refit": file targeted refit tasks
- [x] #6 If "revert": file revert task + re-implementation plan
<!-- AC:END -->
