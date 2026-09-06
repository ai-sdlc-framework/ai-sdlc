---
id: AISDLC-588
title: >-
  RFC-0046 Phase 1 — independenceTier leaf schema + verifier dual-read + deprecate verdictClass
status: Done
assignee: []
created_date: '2026-09-06'
labels:
  - attestation
  - pipeline-cli
  - rfc-0046
  - phase-1
dependencies: []
references:
  - spec/rfcs/RFC-0046-attested-reviewer-independence.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0046 Phase 1. Introduce the new `independenceTier` property that supersedes RFC-0042's `verdictClass` as the independence signal, and wire the verifier to read it with a legacy dual-read fallback. This is the foundational schema phase — Phases 2/3/4 populate the `attested` and `isolated` tiers on top of it.

## Scope
- Add an OPTIONAL per-v6-leaf field `independenceTier: 'none' | 'attested' | 'isolated'` in `pipeline-cli/src/attestation/merkle.ts` (additive, mirroring the AISDLC-568 `verdictClass` additive precedent so legacy leaves hash unchanged — a leaf with the field absent MUST hash identically to today's, and MUST be treated as `none`).
- Verifier (`verify-core.mjs` / `verifyV6Envelope`): cross-check the envelope's declared `independenceTier` against the Merkle-proved leaf value (tamper ⇒ reject). Emit per-leaf tiers + an `overallIndependenceTier` computed as the **weakest link** (any `none` ⇒ `none`; all `≥ attested` ⇒ `attested`; all `isolated` ⇒ `isolated`).
- **Dual-read migration:** `overallIndependenceTier` reads `independenceTier` when present, else falls back to legacy `verdictClass` (`independent` → `attested`; `self-authored`/absent → `none`). No historical envelope is re-interpreted.
- **Deprecate `verdictClass`:** mark it frozen/legacy-read in code comments + RFC-0042 status note is NOT edited (RFC-0046 owns the deprecation record; do NOT amend RFC-0042). `emit-leaf` continues to emit `verdictClass` for one release for back-compat but ALSO emits `independenceTier` (set from the same signal at this phase: `attested` where `verdictClass` would be `independent`, else `none`).

## Acceptance Criteria
- [x] `independenceTier` added to the v6 leaf type + JSON schema; a leaf omitting it hashes identically to a pre-field leaf (hermetic Merkle test, mirroring the 568 backward-compat test).
- [x] Verifier emits per-leaf `independenceTier` + weakest-link `overallIndependenceTier`; tamper (declared ≠ Merkle-proved) is rejected.
- [x] Dual-read: a legacy envelope with only `verdictClass` yields the correct `overallIndependenceTier` via fallback; a new envelope with `independenceTier` ignores `verdictClass`.
- [x] `emit-leaf` emits both fields this phase (independenceTier from the existing signal).
- [x] Hermetic tests for the enum, aggregation, dual-read, and tamper-reject paths.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## References
RFC-0046 §Design Details (Schema Changes, Migration Path). Foundational for AISDLC-589/590/591.
<!-- SECTION:DESCRIPTION:END -->
