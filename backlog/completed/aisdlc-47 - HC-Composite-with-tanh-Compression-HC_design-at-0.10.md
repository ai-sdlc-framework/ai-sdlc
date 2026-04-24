---
id: AISDLC-47
title: HC Composite with tanh Compression + HC_design at 0.10
status: Done
assignee: []
created_date: '2026-04-24 17:23'
updated_date: '2026-04-24 18:17'
labels:
  - hc
  - admission
  - M3
milestone: m-1
dependencies:
  - AISDLC-46
references:
  - orchestrator/src/admission-score.ts
  - orchestrator/src/priority.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extract `deriveHcExplicit`, `deriveHcConsensus`, `deriveHcDecision` helpers from existing HC logic in `orchestrator/src/admission-score.ts`.

Replace current ad-hoc HC with §A.6 tanh formula per Amendment 4:
```
hcRaw = 0.2 × hcExplicit + 0.45 × hcConsensus + 0.25 × hcDecision + 0.10 × hcDesign
hcComposite = tanh(hcRaw)
```

HC_design flows through tanh, NOT as direct SA modifier (Amendment 5 correction to v3).

Preserve `override` short-circuit. HC_override remains a bypass mechanism (PPA v1.0 §6), NOT a weighted term. Weights sum to 1.0 exactly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 hcComposite bounded in [-1, 1] (tanh guarantee)
- [x] #2 Weight sum = 1.0 (0.2 + 0.45 + 0.25 + 0.10)
- [x] #3 Snapshot test: known inputs produce tanh(…) exactly
- [x] #4 HC_override still triggers position-1 bypass
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Admission HC composite landed in a dedicated module with exact §A.6 weights, tanh compression, and HC_design as a first-class fourth component. HC_override's position-1 bypass is preserved upstream — the new module never reads `override`.

## Changes
- `orchestrator/src/admission-hc.ts` (new): exports `HC_WEIGHTS` (`{explicit:0.2, consensus:0.45, decision:0.25, design:0.10}`), `HC_WEIGHT_SUM` (=1.0), per-component derivers (`deriveHcExplicit`, `deriveHcConsensus`, `deriveHcDecision`, `deriveHcDesign`), and `computeAdmissionHumanCurve` returning `{hcExplicit, hcConsensus, hcDecision, hcDesign, hcRaw, hcComposite}`.
- `orchestrator/src/admission-hc.test.ts` (new): 25 tests — weight-sum identity, each deriver's table, bounded-in-(-1,1), exact tanh(weighted sum) snapshot, HC_design-not-an-SA-modifier regression, symmetry test, override-phantom-field bypass regression.

## Design decisions
- **HC_design passes through `computeDesignAuthorityWeight`** (already signed, clamped to [-1, 1]). Matches Amendment 5 — the design signal enters the HC through the standard tanh path, not as a parallel SA multiplier.
- **`deriveHcDecision` returns 0 today**: AdmissionInput has no meeting-decision field yet. Left as an explicit deriver so a future `/decide` comment parser plugs in without changing the composite signature.
- **Trusted-author consensus floor at 0.5 before centering**: preserves the existing PPA trust heuristic (OWNER/MEMBER/COLLABORATOR carry implicit team consensus) — centered output is 0 for a trusted author with zero reactions, vs. -1 for an untrusted one.
- **HC_explicit pulls from labels only** — `high|P0|critical` → +1, `low|backlog` → -1, else 0. Keeps the signal crisp and deterministic; no scaling from reaction counts (those feed HC_consensus).
- **New module instead of extending `priority.ts`**: the legacy PPA HC (`computeHumanCurve`) is used by non-admission callers. Replacing it in-place would regress their behavior. AISDLC-48's composite will call `computeAdmissionHumanCurve` directly without touching `computePriority`.

## Verification
- `pnpm build` — clean
- `pnpm vitest run src/admission-hc.test.ts` — 25/25 pass
- `pnpm vitest run` (full orchestrator) — 1971/1971 pass (+25 over baseline)
- `pnpm lint` — clean

## Follow-up
AISDLC-48 uses `computeAdmissionHumanCurve(input).hcComposite` in `composite = SA × D-pi × ER × (1 + HC)`, with override bypass staying at position-1 (before HC is even computed).
<!-- SECTION:FINAL_SUMMARY:END -->
