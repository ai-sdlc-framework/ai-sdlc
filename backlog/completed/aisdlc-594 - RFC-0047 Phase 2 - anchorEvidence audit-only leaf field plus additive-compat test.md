---
id: AISDLC-594
title: >-
  RFC-0047 Phase 2 — anchorEvidence audit-only leaf field + additive-compat hash test
status: To Do
assignee: []
created_date: '2026-09-06'
labels:
  - attestation
  - pipeline-cli
  - rfc-0047
  - phase-2
dependencies: []
references:
  - spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0047 Phase 2 (OQ-2). Add an OPTIONAL trailing `anchorEvidence` object to the v6 transcript leaf carrying `{ runId, workflowRef, signerKeyId }`. This is **audit-only** context (it makes "which CI run produced this" tamper-evident and re-derivable) — it is NOT the security anchor. The security anchor is the `ci-only` root signature (Phase 1/3). This closes the AISDLC-590 MAJOR where `runId`/`workflowRef` were documented as verification evidence but never bound or checked.

## Scope
- Append `anchorEvidence?: { runId, workflowRef, signerKeyId }` as the LAST key in the canonical hashed leaf `ordered` object in `pipeline-cli/attestation-core/merkle-core.mjs` `hashLeaf`. **Fixed internal key order** for the nested object (mirror the existing `findings` sub-object precedent). The value MUST be `undefined` when absent (never `null`/`{}`), following the `independenceTier` precedent — so a leaf omitting it hashes BYTE-IDENTICALLY to a pre-field leaf (the AISDLC-588 additive-compat invariant).
- Mirror the field into the `TranscriptLeaf` interface (`pipeline-cli/src/attestation/merkle.ts`), the `V6TranscriptLeafSummary` shape + envelope summary (`pipeline-cli/src/attestation/sign-v6.ts`), and the v6 JSON schema (`spec/schemas/attestation-envelope-v6.schema.json`) + regenerate `reference/src/core/generated-schemas.ts` (git-add the regenerated file; register any new `$ref` in getAjv()).
- emit-leaf / clean-room-signer accept an optional anchorEvidence and carry it as-is (never default it). Do NOT couple this to producing `isolated` here — that is Phase 4.

## Replacement semantics
This ADDS a trailing field; it does not replace anything. The AISDLC-588 hashing-boundary rule is load-bearing: **do not write anchorEvidence for leaves that don't have it** (an explicit empty object would change the hash and break older verifiers — see the AISDLC-588 base-verifier-boundary lesson).

## Acceptance Criteria
- [ ] `anchorEvidence?` added to the hashed leaf, TranscriptLeaf, envelope summary, and v6 schema; `generated-schemas.ts` regenerated in sync (zero-diff on re-run).
- [ ] Hermetic hash-identity test (mirror the AISDLC-568/588 backward-compat test): a leaf omitting `anchorEvidence` hashes identically to a pre-field leaf; a leaf WITH it hashes differently and stably (fixed nested key order).
- [ ] The nested object serializes with a fixed key order regardless of construction order (test with keys inserted in a different order).
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## References
RFC-0047 §Design Details (2) + OQ-2 resolution. Foundational for AISDLC-595/596.
<!-- SECTION:DESCRIPTION:END -->
