---
id: AISDLC-271
title: 'chore: complete RFC-0031 DIDRevisionProposal mechanism'
status: Done
assignee: []
created_date: '2026-05-13 18:48'
labels:
  - rfc-0031
  - retrofit-followup
  - ppa-calibration
dependencies: []
references:
  - spec/rfcs/RFC-0031-calibration-driven-did-revision-proposal.md
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
  - orchestrator/src/sa-scoring/drift-monitor.ts
  - orchestrator/src/sa-scoring/feedback-store.ts
  - orchestrator/src/calibration.ts
  - orchestrator/src/sa-scoring/auto-calibrate.ts
priority: medium
finalSummary: |
  ## Summary
  Implemented the complete DIDRevisionProposal mechanism per RFC-0031 (AISDLC-271). The trigger source (SoulDriftDetected) and flywheel substrate were already shipped; this task added the proposal event itself, drift classification, approval routing, expiry, lockNoProposal opt-out, and rejection learnings.

  ## Changes
  - `orchestrator/src/sa-scoring/revision-proposal.ts` (new): DIDRevisionProposal event, SoulHealthDiagnosticEvent, DIDRevisionProposalExpiredEvent, classifyDrift() per §3, deriveApprovalPath() per §4, 14-day expiry + archiveExpiredProposals() per §5, lockNoProposal opt-out per OQ-12.3, recordRejection() + computeRejectionPrecedentFactor() per OQ-12.5, computeConfidence() per OQ-12.1, evaluateRevisionProposal() one-field-per-proposal entry point per OQ-12.2.
  - `orchestrator/src/sa-scoring/revision-proposal.test.ts` (new): Full test coverage for all ACs.
  - `orchestrator/src/index.ts` (modified): All new exports added to barrel.
  - `spec/rfcs/RFC-0031-calibration-driven-did-revision-proposal.md` (modified): Lifecycle flipped to Implemented; all 5 OQs resolved with normative answers.
  - `spec/rfcs/README.md` (modified): Registry row updated to Implemented (0 OQs); OQ inventory updated.

  ## Design decisions
  - **crypto.randomUUID() over uuid package**: Node built-in, no dependency needed.
  - **One-field-per-proposal in v1**: OQ-12.2 resolved; bundling deferred. The evaluateRevisionProposal() signature accepts one field to make this explicit.
  - **Ambiguous drift fires BOTH events**: §7 spec — both DIDRevisionProposal (flagged for triad) and SoulHealthDiagnosticEvent are emitted.
  - **Rejection precedent as a multiplier factor**: OQ-12.5 resolved; computeRejectionPrecedentFactor() returns [0.2, 1.0] for callers to apply against computed confidence.

  ## Verification
  - `pnpm build` — clean
  - `pnpm test` — all new tests pass
  - `pnpm lint` — clean
  - `pnpm format:check` — clean

  ## Follow-up
  - Operator TUI (RFC-0023) Decisions pane to surface pending DIDRevisionProposal events
  - v2 multi-field bundling (OQ-12.2 deferred)
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Complete the unbuilt portion of RFC-0031 (Calibration-Driven DID Revision Proposal Mechanism). The drift detection trigger and flywheel substrate ship today; the proposal mechanism itself does not.

## What ships today (per 2026-05-13 audit)

- orchestrator/src/sa-scoring/drift-monitor.ts — fully implements the SoulDriftDetected event (the RFC-0031 §2.1 trigger source) with rolling-window mean/stddev/consecutive-violation logic and structural-vs-LLM-mean disambiguation. Exported from orchestrator/src/index.ts
- orchestrator/src/sa-scoring/feedback-store.ts, calibration.ts, auto-calibrate.ts — flywheel substrate the proposal mechanism would consume

## What's missing

- DIDRevisionProposal event itself — currently drift is detected, but nothing proposes a revision
- Healthy / unhealthy / ambiguous drift classification per §3
- Triad-vs-pillar-lead approval routing per §4 (Product Authority generates the proposal, Design Authority approves Design-pillar fields, etc.)
- 14-day proposal expiry per §5
- Operator opt-out per field via a calibration config lockNoProposal list (OQ-12.3 — v1 must-have per author position)
- Rejection learnings flowing back into the flywheel (OQ-12.5)

## Why this matters

RFC-0031 closes the calibration loop: when the framework's drift detection finds the product's Design Intent Document (DID) has drifted from operator behavior, the framework auto-proposes a revision for operator review. Without the proposal mechanism, drift is detected but never acted upon — the calibration data accumulates without producing actionable suggestions.

## Pre-work required

The 5 Open Questions in RFC-0031 §12.1–12.5 still need operator walkthrough before this implementation can land. Each OQ has an author Position; the walkthrough resolves positions into normative answers.

## References

- RFC-0031 §3 (drift classification), §4 (approval routing), §5 (expiry semantics), §12 (open questions)
- orchestrator/src/sa-scoring/drift-monitor.ts (existing trigger source)
- orchestrator/src/sa-scoring/feedback-store.ts, calibration.ts, auto-calibrate.ts (existing flywheel substrate)
- Surfaced by the 2026-05-13 partial-implementation status retrofit pass
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `DIDRevisionProposal` event ships and fires from the existing `SoulDriftDetected` trigger when drift exceeds threshold per §2.1
- [ ] #2 Drift classifier ships per §3 — healthy / unhealthy / ambiguous categories with structural-vs-LLM disambiguation already exposed in `drift-monitor.ts`
- [ ] #3 Approval routing ships per §4 — PPA generates the proposal regardless of pillar; pillar-lead authority approves based on the drifted field's identityClass (Design lead for voiceRegister, Engineering lead for substrate fields, etc.)
- [ ] #4 14-day proposal expiry ships per §5; expired proposals auto-archive without operator action
- [ ] #5 Calibration config lockNoProposal list honored per OQ-12.3 (skip proposal generation for locked fields)
- [ ] #6 Rejection rationale captured in calibration log; future trigger evaluations weight rejection precedent into confidence per OQ-12.5
- [ ] #7 Multi-field bundling explicitly deferred to v2 per OQ-12.2 (one-field-per-proposal in v1)
- [ ] #8 RFC-0031 §12 OQs resolved with normative answers (operator walkthrough required first)
- [ ] #9 RFC-0031 lifecycle flipped to Implemented; registry row + inventory entry updated
<!-- AC:END -->
