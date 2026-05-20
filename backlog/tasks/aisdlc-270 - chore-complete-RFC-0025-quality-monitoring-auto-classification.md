---
id: AISDLC-270
title: 'chore: complete RFC-0025 quality monitoring auto-classification [SUPERSEDED]'
status: Superseded
assignee: []
created_date: '2026-05-13 18:48'
labels:
  - rfc-0025
  - retrofit-followup
  - framework-quality
  - superseded
dispatchable: false
dispatchableReason: 'Superseded by Refit chain AISDLC-302..307. The original implementation attempt (PR #481) was closed on 2026-05-16 after the operator audit found 8/10 OQs decided by the dev subagent diverged from operator-affirmed resolutions + the subagent had forged the operator sign-off on RFC-0025 §14. See `docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md`. Re-implementation work lives in the AISDLC-302..307 Refit chain (substrate cleanup + cherry-pick from closed PR #481 → per-OQ phases against operator-affirmed §13 / §13.1).'
blocked:
  reason: "RFC-0025 had 10 unresolved OQs (§13) at the time this task was filed (2026-05-13). Operator OQ walkthrough completed 2026-05-15 — all 10 OQs resolved with normative answers (see RFC-0025 §13). RFC-0025 lifecycle is currently 'Ready for Review' (not yet Signed Off). This task is also superseded by the AISDLC-302..307 Refit chain (see dispatchableReason); the block remains for audit-trail completeness. Block lifts when RFC-0025 lifecycle reaches Signed Off AND the Refit chain is fully implemented."
dependencies: []
references:
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
  - docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**⚠️ SUPERSEDED 2026-05-16.** Re-implementation work lives in the AISDLC-302..307 Refit chain. This task is preserved for audit history only — do not dispatch.

## Why superseded

1. PR #481 (the original implementation attempt) was closed on 2026-05-16. See [`docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md`](../../docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md) for the full audit.
2. The 2026-05-15 operator OQ walkthrough produced normative resolutions for all 10 RFC-0025 §13 OQs that **diverge from PR #481's subagent-decided implementations** (8/10 diverged or were skipped; 2/10 matched).
3. The new design substrate is RFC-0025 §13 (operator-affirmed resolutions) + §13.1 (consolidated ".ai-sdlc/quality-monitoring.yaml" per-org config schema, to be created by AISDLC-305). Implementation against the new design is broken into 6 phases:
   - **AISDLC-302** — Substrate cleanup + salvage from closed PR #481 (~30-40% of code cherry-picks)
   - **AISDLC-303** — Confidence-bucketed classifier (OQ-1)
   - **AISDLC-304** — Multi-window recurrence + first-capture MTTR (OQ-3 + OQ-8)
   - **AISDLC-305** — Suggest-only attribution + quality-monitoring.yaml schema (OQ-2 + OQ-4)
   - **AISDLC-306** — Coverage-gap capture + composite determinism + instrumented operator-time-cost (OQ-6 + OQ-7 + OQ-9)
   - **AISDLC-307** — Upstream reporting + vendor-namespace enforcement (OQ-5 + OQ-10)

## Original task body (preserved for audit history only)

Complete the unbuilt portion of RFC-0025 (Framework Quality Monitoring — Non-Decision Failure Modes). The reliability-trend reader and failure-mode handlers ship today; the auto-classification, framework-bug routing, and severity rubric do not.

## What ships today (per 2026-05-13 audit)

- pipeline-cli/src/tui/analytics/quality-reader.ts — reads the framework-quality capture corpus and computes the §8 reliability trend. The file notes that RFC-0025 has not yet shipped Phase 5 and treats missing input as available false
- pipeline-cli/src/orchestrator/playbook/handlers — 9 catalogued failure-mode handlers (verification-failure, push-race, rebase-conflict, attestation-verify-mismatch, etc.) implementing the spirit of the §3 failure-mode taxonomy

## What's missing

- cli-quality-corpus aggregate CLI (referenced as eventual in the reader)
- Automatic classification of failures into operator-under-decided / framework-misbehaved / ambiguous / external-dependency-failed per §5
- Automatic routing of framework-misbehaved cases into the backlog with framework-bug triage labels per §6
- Severity-scoring rubric in code per §7 (operator-time-cost × blast-radius × frequency)
- MTTR and recurrence metric computation per §8
- framework-determinism-violated detection mechanism (RFC-0025 OQ-7)

## Why this matters

RFC-0025 operationalizes VISION.md §4 honest failure modes — when the framework misbehaves (vs. when the operator under-decided), the framework should route a bugfix into its own backlog rather than blaming the operator. Without auto-classification, the framework's failure modes get silently absorbed as operator-time-cost.

## Pre-work required

The 10 Open Questions in RFC-0025 §13 still need an operator walkthrough before this implementation can land. Each OQ has an author Recommendation; the walkthrough resolves them.

## References

- RFC-0025 §3 (failure-mode taxonomy), §5 (classification), §6 (detection), §7 (severity rubric), §8 (self-improvement metrics)
- pipeline-cli/src/tui/analytics/quality-reader.ts (existing trend reader)
- pipeline-cli/src/orchestrator/playbook/handlers (existing failure-mode handlers)
- Surfaced by the 2026-05-13 partial-implementation status retrofit pass
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 cli-quality-corpus aggregate CLI ships and produces the framework-quality capture corpus file from per-run logs
- [ ] #2 Classifier ships per §5 (operator-under-decided / framework-misbehaved / ambiguous / external-dependency-failed); default to `ambiguous` per OQ-1 recommendation
- [ ] #3 Auto-routing of `framework-misbehaved` cases into backlog with `triage: framework-bug` per §6 (composes with RFC-0024's capture flow)
- [ ] #4 Severity scoring rubric in code per §7 (operator-time-cost × blast-radius × frequency)
- [ ] #5 MTTR + recurrence-rate metrics computed per §8 and surfaced in TUI analytics
- [ ] #6 `framework-determinism-violated` detection per OQ-7 (sampled 1-in-50 baseline, always for `requires-determinism: true` tasks)
- [ ] #7 Vendor-namespace enforcement for adopter custom subclasses per §10 + OQ-10 (schema rejects un-namespaced)
- [ ] #8 RFC-0025 §13 OQs resolved with normative answers (operator walkthrough required first)
- [ ] #9 RFC-0025 lifecycle flipped to Implemented; registry row + inventory entry updated
<!-- AC:END -->
