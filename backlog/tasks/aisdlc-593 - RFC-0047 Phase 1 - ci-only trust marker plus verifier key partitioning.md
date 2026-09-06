---
id: AISDLC-593
title: >-
  RFC-0047 Phase 1 — ci-only trust marker + verifier key partitioning
status: To Do
assignee: []
created_date: '2026-09-06'
labels:
  - attestation
  - pipeline-cli
  - rfc-0047
  - phase-1
dependencies: []
references:
  - spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md
  - spec/rfcs/RFC-0046-attested-reviewer-independence.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0047 Phase 1 (OQ-1). Introduce the `ci-only` signing-key trust class so the verifier can distinguish a Merkle root signed by the CI-held key from one signed by the operator's own key. This is the foundational seam the `isolated` tier's re-derivable anchor rests on: the security of `isolated` is "the root was signed by a key the same-machine coordinator cannot reach," and this task teaches the trust store + verifier to represent that.

## Scope
- Extend `.ai-sdlc/trusted-reviewers.yaml` entry schema with an OPTIONAL `ciOnly: true` flag (default false/absent = operator key, unchanged). Update the hand-rolled YAML loader in `verify-core.mjs` (~line 587) + `validateTrustedReviewers` (~line 2430) to parse and carry it. The strict single-quoted-scalar format the loader requires MUST be preserved.
- Verifier partitions trusted keys into two sets: operator keys and `ci-only` keys. Expose a helper (e.g. `isCiOnlyKey(pubkey)` / a partitioned trusted-key structure) that Phase 3's `isolated` re-derivation will consume.
- Do NOT yet change any tier-crediting logic (that is Phase 3) — this task only makes the `ci-only` distinction *available* to the verifier without altering existing verdicts. A root signed by an operator key must verify exactly as today.
- Document the `ciOnly` flag in the trusted-reviewers.yaml header comment + the operator runbook (how to register a CI-only key, why its private half must live only in a protected GH Actions environment).

## Acceptance Criteria
- [ ] `trusted-reviewers.yaml` accepts an optional `ciOnly: true` per entry; the loader parses it; an entry without it defaults to operator (not ci-only).
- [ ] Verifier exposes a partitioned trusted-key view (operator vs. ci-only); a hermetic test asserts a `ciOnly` entry lands in the ci-only set and a plain entry does not.
- [ ] No change to existing verification outcomes: an envelope signed by an operator key verifies byte-for-byte as before (regression test over an existing v6 envelope).
- [ ] trusted-reviewers.yaml header comment + operator runbook updated.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## References
RFC-0047 §Design Details (1) + OQ-1 resolution. Foundational for AISDLC-595/596.
<!-- SECTION:DESCRIPTION:END -->
