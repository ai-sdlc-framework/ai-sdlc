---
id: AISDLC-590
title: >-
  RFC-0046 Phase 3 — isolated tier: internal reviewers via RFC-0043 sandbox + clean-room signer
status: To Do
assignee: []
created_date: '2026-09-06'
labels:
  - attestation
  - pipeline-cli
  - rfc-0046
  - rfc-0043
  - phase-3
dependencies:
  - AISDLC-588
references:
  - spec/rfcs/RFC-0046-attested-reviewer-independence.md
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0046 Phase 3 — the load-bearing `isolated` independence tier. Generalize RFC-0043's sandbox-isolated reviewer fan-out + clean-room signer (built for untrusted contributors) to the INTERNAL review path, so an opt-in internal review can be produced in an isolation boundary the coordinator process cannot reach. This is the tier that actually satisfies RFC-0046 OQ-1 (defend against a determined same-machine coordinator) with an OQ-2 re-derivable anchor.

## Scope
- Add an opt-in `isolated`-tier reviewer path that runs the code/test/security reviewers inside RFC-0043's `SandboxDriver` boundary (Docker v1 reference) connected via the `inference.local` credential-withholding proxy — reuse RFC-0043's substrate (`requires: RFC-0043`), do NOT reimplement the sandbox or the proxy.
- The sandbox emits the UNSIGNED reviewer report; the RFC-0043 clean-room signer (Stage 4, signing key never in the sandbox) mints the v6 envelope and stamps each leaf `independenceTier: 'isolated'` (from AISDLC-588's field).
- **Re-derivable anchor (OQ-2 hybrid):** the `isolated` anchor MUST be CI-re-derivable via RFC-0043's `deployment: ci` path (different infra). The sandbox's unsigned report is the informational, sign-time context — not the claim.
- The verifier (AISDLC-588) must confirm the `isolated` tier's clean-room/CI anchor where present; downgrade (never over-claim) if the anchor can't be established.
- Wire the opt-in trigger (per-PR label/config) so routine PRs stay on the `attested`/`none` tiers (cost — do NOT sandbox every internal review).

## Acceptance Criteria
- [ ] An opt-in internal review runs the 3 reviewers inside the RFC-0043 SandboxDriver via `inference.local`; the clean-room signer mints a v6 envelope with `independenceTier: isolated` on each leaf.
- [ ] The `isolated` anchor is re-derivable via the RFC-0043 CI path; a verifier confirms it independent of the operator root key.
- [ ] A coordinator that hand-authors a reviewer transcript OUTSIDE the sandbox cannot obtain `isolated` (the security-critical negative — isolation boundary is the anchor).
- [ ] Reuses RFC-0043 `SandboxDriver` + `clean-room-signer` (no reimplementation); `requires: RFC-0043`.
- [ ] Hermetic/integration tests for the isolated produce→verify loop + the negative case.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Note
Largest phase; trust-chain-critical. Reconcile + sign with operator-composed verdicts. Depends on AISDLC-588 (field); composes with AISDLC-589 (attested lower tier).
<!-- SECTION:DESCRIPTION:END -->
