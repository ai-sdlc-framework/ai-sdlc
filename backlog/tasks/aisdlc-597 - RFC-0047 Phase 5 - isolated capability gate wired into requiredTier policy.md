---
id: AISDLC-597
title: >-
  RFC-0047 Phase 5 — isolated capability gate wired into RFC-0046 requiredTier policy
status: To Do
assignee: []
created_date: '2026-09-06'
labels:
  - attestation
  - pipeline-cli
  - rfc-0047
  - rfc-0046
  - phase-5
dependencies:
  - AISDLC-596
references:
  - spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md
  - spec/rfcs/RFC-0046-attested-reviewer-independence.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0047 Phase 5 (OQ-5). Flip `requiredTier: isolated` from unsatisfiable to satisfiable now that the `isolated` tier is producible (AISDLC-596) and verifiable (AISDLC-595). This is the seam between RFC-0047 and RFC-0046's `requiredTier` policy engine (AISDLC-591): a single capability source of truth the engine consults.

## Scope
- Add a single `isolatedTierAvailable()` capability check (one source of truth) that returns true once the isolated producer + ci-only verifier path is present/configured (RFC-0046's `requiredTier` policy engine from AISDLC-591 consumes it).
- Before this task ships (i.e. in AISDLC-591's engine), `requiredTier: isolated` MUST warn/reject (unsatisfiable). This task flips the capability true and REMOVES the warn/reject for `isolated`, so a repo can now require it. `requiredTier: none | attested` behavior is unchanged (already shipped in 591).
- Enforcement parity (inherited from RFC-0046 OQ-5): the `requiredTier: isolated` shortfall must block via `ai-sdlc/pr-ready` on branch-protection repos AND via the ship-skill on procedural-gate repos — the same comparison, both surfaces.
- Operator-runbook page: how to set `requiredTier: isolated`, what infra it presupposes (a registered ci-only key + the isolated-review workflow), and the downgrade-with-reason behavior when the anchor is missing.

## Replacement semantics (load-bearing)
This REMOVES the `requiredTier: isolated` unsatisfiability warn/reject that AISDLC-591 shipped as a placeholder. Single source of truth for "isolated available" — do not scatter the capability check (AISDLC-421-class drift risk).

## Acceptance Criteria
- [ ] `isolatedTierAvailable()` single source of truth; `requiredTier: isolated` is satisfiable when it returns true and warns/rejects when false — verified by a test asserting BOTH states.
- [ ] `requiredTier: isolated` shortfall blocks via `ai-sdlc/pr-ready` (branch-protection) AND the ship-skill (procedural-gate) — hermetic tests for both surfaces.
- [ ] `requiredTier: none | attested` behavior unchanged (regression).
- [ ] Operator-runbook doc added.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## References
RFC-0047 §Design Details (5) + OQ-5. Composes with RFC-0046 AISDLC-591 (the policy engine). Depends on AISDLC-596.
<!-- SECTION:DESCRIPTION:END -->
