---
id: AISDLC-591
title: >-
  RFC-0046 Phase 4 — requiredTier policy + gate-topology-agnostic enforcement
status: To Do
assignee: []
created_date: '2026-09-06'
labels:
  - attestation
  - pipeline-cli
  - rfc-0046
  - phase-4
dependencies:
  - AISDLC-589
  - AISDLC-590
references:
  - spec/rfcs/RFC-0046-attested-reviewer-independence.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0046 Phase 4 — the rollout/enforcement layer (OQ-5). Independence ships opt-in + informational by default; this phase adds the per-repo policy knob that lets an adopter REQUIRE a minimum tier, enforced identically on branch-protection and procedural-gate topologies.

## Scope
- Add a per-repo policy config (e.g. `.ai-sdlc/independence-policy.yaml`: `requiredTier: none | attested | isolated`, default `none`).
- Enforcement compares `requiredTier` against the envelope's `overallIndependenceTier` (AISDLC-588):
  - **Branch-protection repos:** feed the result into the `ai-sdlc/pr-ready` rollup so a shortfall blocks merge.
  - **Procedural-gate repos (no branch protection, e.g. local-trades):** the ship-skill enforces the same comparison before ship. One comparison, two enforcement surfaces.
- Surface the tier + policy outcome in the PR/attestation output regardless of enforcement (informational when `requiredTier: none`).
- Docs: operator-runbook page on the policy knob + how it degrades for procedural adopters.

## Acceptance Criteria
- [ ] `requiredTier` policy read from repo config; default `none` (no behavior change for existing adopters).
- [ ] Shortfall (`overallIndependenceTier < requiredTier`) blocks via `ai-sdlc/pr-ready` on branch-protection repos AND via the ship-skill on procedural-gate repos — same comparison, verified by hermetic tests for both surfaces.
- [ ] Tier + policy outcome surfaced in output even when `requiredTier: none`.
- [ ] Operator-runbook doc added.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## References
RFC-0046 §Proposal (Rollout), OQ-5. Depends on AISDLC-589 (attested) + AISDLC-590 (isolated) so all tiers exist to enforce against.
<!-- SECTION:DESCRIPTION:END -->
