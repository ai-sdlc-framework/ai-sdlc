---
id: AISDLC-596
title: >-
  RFC-0047 Phase 4 — isolated producer + CI workflow (protected ci-only clean-room signer, commit envelope to PR branch)
status: To Do
assignee: []
created_date: '2026-09-06'
labels:
  - attestation
  - pipeline-cli
  - rfc-0047
  - rfc-0043
  - phase-4
dependencies:
  - AISDLC-593
  - AISDLC-594
  - AISDLC-595
references:
  - spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0047 Phase 4 (OQ-1/OQ-4). The load-bearing producer: run the internal reviewers in the RFC-0043 sandbox, and sign the `isolated` envelope in a SEPARATE, protected CI job that materializes the **ci-only** signing key (never the operator key, never inside the sandbox), then COMMIT the attestation-only envelope to the PR branch so the offline verifier finds it. This is the piece AISDLC-590 got wrong (self-asserted anchor, operator key, discarded envelope) — re-engineered per the RFC-0047 walkthrough.

## Scope (compose RFC-0043 substrate; do NOT reimplement the sandbox/proxy)
- Reuse RFC-0043's `SandboxDriver` + `inference.local` proxy for the reviewer fan-out (as the held AISDLC-590 did) — the sandbox emits the UNSIGNED report.
- Clean-room signer runs in a **separate CI job** in a **protected GitHub Actions environment** that injects the `ci-only` private key (`AISDLC_CI_SIGNING_KEY_CONTENT`, distinct from the operator key). The signer mints the v6 envelope stamped `independenceTier: 'isolated'` with `anchorEvidence: { runId, workflowRef, signerKeyId }` (from AISDLC-594). The `ci-only` key's pubkey MUST be registered in `trusted-reviewers.yaml` with `ciOnly: true` (AISDLC-593).
- **Durability (OQ-4):** the signing job COMMITS `.ai-sdlc/attestations/<patch-id>.v6.dsse.json` + the leaf file as an attestation-only commit and pushes to the PR branch (`contents: write`, scoped to this protected job). Covered by the AISDLC-419 attestation-only-descendant relaxation. NEVER discard the envelope on the runner.
- Opt-in per-PR trigger (label/config) so routine PRs stay on `attested`/`none` (cost). Same-repo internal PRs only (fork PRs can't push back).
- The clean-room signer's isolation invariant (signing key resolved OUTSIDE the sandbox) MUST hold; extend `resolveSigningKeyPath()` / the signer to accept the ci-only key path in CI without ever exposing it to the sandbox job.

## Security-critical (operator-composed verdicts on reconcile)
This is trust-chain-critical. The negative that MUST hold: a coordinator running `clean-room-sign --independence-tier isolated` LOCALLY (operator key, no ci-only secret) cannot produce an envelope the AISDLC-595 verifier credits as `isolated` — it downgrades. Prove it end-to-end.

## Acceptance Criteria
- [ ] Opt-in isolated review runs the 3 reviewers in the RFC-0043 sandbox; the separate protected CI job signs with the ci-only key and stamps `independenceTier: isolated` + `anchorEvidence`.
- [ ] The signed envelope is COMMITTED to the PR branch (attestation-only) and found by the patch-id verifier; NOT discarded.
- [ ] Reuses RFC-0043 `SandboxDriver` + `clean-room-signer` (no reimplementation); signing key never enters the sandbox job.
- [ ] **Security negative (end-to-end):** a local operator-key `clean-room-sign --independence-tier isolated` yields a leaf the AISDLC-595 verifier DOWNGRADES (not credited isolated).
- [ ] `.github/workflows/` isolated-review workflow uses `node pipeline-cli/bin/cli-*.mjs` invocation, no CI-skip markers, protected environment on the signing job.
- [ ] Hermetic/integration tests for the isolated produce→sign→commit→verify loop + the negative case.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## References
RFC-0047 §Design Details (4) + OQ-1/OQ-4. Largest phase; reconcile + sign with operator-composed verdicts. Frontmatter `dependencies` (AISDLC-593, AISDLC-594, AISDLC-595) is authoritative.
<!-- SECTION:DESCRIPTION:END -->
