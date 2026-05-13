---
id: AISDLC-271
title: 'chore: complete RFC-0031 DIDRevisionProposal mechanism'
status: To Do
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
