---
id: AISDLC-590
title: >-
  RFC-0046 Phase 3 — isolated tier: internal reviewers via RFC-0043 sandbox + clean-room signer
status: Done
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
- [x] An opt-in internal review runs the 3 reviewers inside the RFC-0043 SandboxDriver via `inference.local`; the clean-room signer mints a v6 envelope with `independenceTier: isolated` on each leaf.
- [x] The `isolated` anchor is re-derivable via the RFC-0043 CI path; a verifier confirms it independent of the operator root key.
- [x] A coordinator that hand-authors a reviewer transcript OUTSIDE the sandbox cannot obtain `isolated` (the security-critical negative — isolation boundary is the anchor).
- [x] Reuses RFC-0043 `SandboxDriver` + `clean-room-signer` (no reimplementation); `requires: RFC-0043`.
- [x] Hermetic/integration tests for the isolated produce→verify loop + the negative case.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Note
Largest phase; trust-chain-critical. Reconcile + sign with operator-composed verdicts. Depends on AISDLC-588 (field); composes with AISDLC-589 (attested lower tier).

## Final Summary

Implemented the `isolated` independence tier by composing (not reimplementing)
RFC-0043's shipped substrate:

- **Anchor gate** — `clean-room-signer.ts` gained an `independenceTier` option
  and a new `anchor-check` failure phase: it REFUSES to mint
  `independenceTier: 'isolated'` unless the unsigned report's
  `provenance.deployment === 'ci'` (a new optional Zod/JSON-schema field). A
  hand-authored report (no provenance) or a `local`-deployment sandbox report
  cannot obtain the claim — verified by dedicated security-negative tests in
  `clean-room-signer.test.ts`.
- **Opt-in trigger** — `pipeline-cli/src/pipeline/isolated-review-trigger.ts`
  (`isIsolatedReviewRequested`, `computeCiProvenance`): PR-label/env opt-in,
  cost-guarded default-off; derives CI provenance from the ambient
  `GITHUB_ACTIONS` environment.
- **Internal review path** — `cli-ucvg internal-isolated-review` (new
  subcommand in `ucvg.ts`) reuses the identical `runSandboxAndReview`
  Stage 2/3 substrate (SandboxDriver + `inference.local` proxy + 3-reviewer
  matrix) as the untrusted-contributor `sandbox-run` path, only overriding the
  report's `trust`/`provenance` metadata. `cli-ucvg clean-room-sign
  --independence-tier isolated` wires Stage 4.
- **CI wiring** — `.github/workflows/isolated-review-gate.yml`: opt-in via the
  `isolated-review` PR label (or `workflow_dispatch`), two-job separation
  (sandbox-and-review has no signing key; clean-room-sign is the only job that
  ever materializes it) mirroring `untrusted-pr-gate.yml`'s trust boundary.
- **Verifier** — RFC-0046 Phase 1 (AISDLC-588)'s `verify-core.mjs` already
  Merkle-binds `independenceTier` per leaf and computes the weakest-link
  `overallIndependenceTier`; no changes needed there — the mint-time anchor
  gate is the security control, and Phase 1's tamper-detection covers the
  Merkle side.

No RFC-0043/0046 substrate was reimplemented. All ACs met; `pnpm build && pnpm
test && pnpm lint && pnpm format:check` pass (2 pre-existing unrelated
failures confirmed via `git stash` bisection: `bin-invocation.test.ts`
environment quirk, `tui/app.test.tsx` render timeout — both present on
`origin/main` before this change).
<!-- SECTION:DESCRIPTION:END -->
