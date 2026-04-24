---
id: AISDLC-60
title: Composite SA-1/SA-2 with Phase Weights + w_structural Floor
status: Done
assignee: []
created_date: '2026-04-24 17:26'
updated_date: '2026-04-24 19:22'
labels:
  - sa-scoring
  - composite
  - M5
milestone: m-1
dependencies:
  - AISDLC-57
  - AISDLC-58
  - AISDLC-59
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
New `orchestrator/src/sa-scoring/composite.ts`.

**SA-1 per §B.7.1:**
```
hard gate: if scopeGate failed with core match → SA-1 = 0.0, STOP
coreConflictPenalty = min(0.8, coreViolationCount × 0.4)
evolvingConflictPenalty = min(0.3, evolvingViolationCount × 0.1)
conflictPenalty = 1.0 - coreConflictPenalty - evolvingConflictPenalty
blended = w_structural × domainRelevance + w_llm × domainIntent × (0.5 if high-sev subtle conflict else 1.0)
SA-1 = blended × conflictPenalty
```

**SA-2 per corrected §B.7.2 (CR-1 — no self-multiplication):**
```
computableScore = 0.3 × tokenCompliance + 0.2 × catalogHealth
designConflictPenalty = 1.0 - min(0.6, coreAp × 0.3 + evolvingAp × 0.1)
llmTerm = w_llm × principleAlignment × (0.5 if high-sev else 1.0)
blendedScore = w_structural × principalCoverage + llmTerm
llmComponent = blendedScore × designConflictPenalty
SA-2 = computableScore + 0.5 × llmComponent
```

**Phase weights (§B.7.3):**
- 2a shadow: (0, 0) — both computed, neither used in ranking
- 2b blended: (0.20, 0.80)
- 2c calibrating: (0.35, 0.65)
- 3 calibrated: flywheel-driven, floor 0.20

**CR-2 enforcement**: `w_structural ≥ 0.20` floor on both dimensions independently.

Worked example from §B.7.2 table reproduces SA-2 = 0.840 exactly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Worked example from §B.7.2 table exactly: tc=0.88, ch=0.95, principalCoverage=0.72, principleAlignment=0.80 → SA-2 = 0.840
- [x] #2 w_structural < 0.20 in Phase 3 calibration output clamped to 0.20
- [x] #3 Hard gate produces SA-1 = 0 regardless of other scores
- [x] #4 Phase 2a does not affect the composite used in ranking (feature flag at scorer entry)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
SA-1/SA-2 composite landed. `computeSoulAlignment(input)` combines Layer 1 + Layer 2 + Layer 3 outputs per §B.7.1/2, applies phase weights with CR-2 floor on `w_structural`, and reproduces the §B.7.2 worked example bit-exactly (SA-2 = 0.840).

## Changes
- `orchestrator/src/sa-scoring/composite.ts` (new):
  - `getPhaseWeights(phase, calibrated?)`: Phase 2a=(0,0), 2b=(0.2,0.8), 2c=(0.35,0.65), 3=calibrated-with-floor `W_STRUCTURAL_FLOOR=0.2`.
  - `computeSa1(inputs, weights)` — hard-gate short-circuit to 0, then `conflictPenalty = 1 − coreConflictPenalty − evolvingConflictPenalty` with caps (0.8 core / 0.3 evolving), subtleMult 0.5 on high-severity, blended = `w_s × domainRelevance + w_l × domainIntent × subtleMult`, SA-1 = `blended × conflictPenalty` clamped to [0, 1].
  - `computeSa2(inputs, weights)` — per corrected §B.7.2 (CR-1): `computableScore = 0.3 × tc + 0.2 × ch`, `designConflictPenalty = 1 − min(0.6, coreAp×0.3 + evolvingAp×0.1)`, `blendedScore = w_s × principleCoverage + w_l × principleAlignment × subtleMult`, `llmComponent = blendedScore × designConflictPenalty`, `SA-2 = computableScore + 0.5 × llmComponent`. No self-multiplication.
  - `computeSoulAlignment(input)` entry point returning `{phase, weights, shadowMode, sa1, sa2}`.
- `orchestrator/src/sa-scoring/composite.test.ts` (new): 25 tests — phase-weight table, Phase 3 floor clamp (AC #2), hard-gate forces SA-1=0 (AC #3), Phase 2a weights produce SA-1=0, core/evolving violation penalty caps, high-severity halving on both SA-1 and SA-2 (low-severity does not), SA-1 clamp, §B.7.2 worked example to 6 decimal places (AC #1), anti-pattern penalty caps, joint core+evolving penalty, percentage input acceptance (0-100), CR-1 no-self-multiplication (blended=0 ⇒ SA-2=computable), SA-2 clamp, Phase 2a shadowMode=true flag (AC #4), Phase 3 below-floor clamp end-to-end.

## Design decisions
- **CR-1 correction embedded in code structure**: SA-2 = `computableScore + 0.5 × blendedScore × designConflictPenalty`. The `+` (not `×`) prevents the `(computable × blended)` self-multiplication the v3 draft accidentally had. Comment explains the invariant.
- **CR-2 floor applied only in Phase 3**: Phases 2a/2b/2c have fixed weights from the spec; only Phase 3 is calibrated from feedback (AISDLC-66) and can drift below 0.20. Clamp only there preserves the spec'd weights in earlier phases.
- **`wLlm = 1 − wStructural` after floor clamp**: keeps the pair summing to 1.0, which matters for the blended score to stay in [0, 1]. If a future calibration produces weights that don't sum to 1, we renormalize via the wStructural path.
- **SA-1 hard gate short-circuits** — returning `{sa1: 0, hardGated: true, ...}` with zero-valued contributions. Downstream composites can check `result.sa1.hardGated` without re-computing the scope check.
- **SA-2 has NO hard gate** — principle alignment is orthogonal to scope. A core-scope violation shouldn't zero SA-2 (which measures whether the thing, once admitted, actually expresses the design principles). The admission composite separately combines SA-1 and SA-2 → hard gate on SA-1 still stops admission.
- **`tokenCompliance` and `catalogHealth` accept both percentage (0-100) and ratio (0-1) inputs** via the shared `normalizeCoverage` pattern. Consumers reading from DSB status can pass whatever shape the DSB uses.
- **Phase 2a returns `shadowMode: true`** on the result envelope so admission-composite consumers can check one flag rather than hard-coding "if phase == '2a'" everywhere. In shadow mode, SA-1 and SA-2 are still computed (for feedback comparison) but never fed into ranking.
- **Subtle conflicts pre-filtered**: Layer 3 removes <0.5 confidence entries; `computeSa1`/`computeSa2` just check `severity === 'high'` without re-filtering. Single responsibility.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/sa-scoring/composite.test.ts` — 25/25 pass
- `pnpm vitest run` (full orchestrator) — 2152/2152 pass (+25)
- `pnpm lint` — clean
- §B.7.2 worked example reproduces SA-2 = 0.840 at 6 decimal precision

## Follow-up
AISDLC-61 (pattern-test CLI) is the Phase 2a deliverable — runs Layer 1 only against a single issue text + DID for pre-production calibration. AISDLC-63 (SA scoring orchestration) wires `computeSoulAlignment` into the admission composite, replacing the label-based soulAlignment fallback.
<!-- SECTION:FINAL_SUMMARY:END -->
