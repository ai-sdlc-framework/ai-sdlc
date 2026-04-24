---
id: AISDLC-45
title: C4 Autonomy Factor via AutonomyPolicy.status.currentLevel
status: Done
assignee: []
created_date: '2026-04-24 17:22'
updated_date: '2026-04-24 17:58'
labels:
  - enrichment
  - c4
  - M2
milestone: m-1
dependencies:
  - AISDLC-42
references:
  - orchestrator/src/admission-enrichment.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extend `enrichAdmissionInput` to populate `autonomyContext` from the team's AutonomyPolicy.

Implement `complexityToAutonomyLevel(complexity)` per §A.4 mapping:
- `complexity <= 3` → level 1
- `complexity <= 6` → level 2
- `else` → level 3

Read `currentLevel` from `autonomyPolicy.status.currentLevel`.

Wire `autonomyFactor` in `mapIssueToPriorityInput`:
- `gap = requiredLevel - currentEarnedLevel`
- If `gap > 0`: `autonomyFactor = max(0.1, 1.0 - gap × 0.4)` (gap=1→0.6, gap=2→0.2, gap=3→0.1 floor)
- Else: `autonomyFactor = 1.0`

Default to 1.0 when no AutonomyPolicy available.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 gap=0 → 1.0; gap=1 → 0.6; gap=2 → 0.2; gap=3 → 0.1 (floor)
- [x] #2 No AutonomyPolicy → autonomyFactor = 1.0
- [x] #3 Tests verify each band
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
C4 autonomy factor landed. Enrichment reads `AutonomyPolicy.status.agents[].currentLevel`, picks an agent (named or most-permissive), and surfaces `autonomyContext` with earned vs. required levels. Compute helper applies the gap→factor formula with floor 0.1.

## Changes
- `orchestrator/src/admission-enrichment.ts`: added `autonomyPolicy`, `agentName`, `complexity` to `EnrichmentContext`; new helpers `complexityToAutonomyLevel()`, `computeAutonomyFactor()`, `buildAutonomyContext()` (private). `enrichAdmissionInput` now attaches `autonomyContext` alongside the other C2/C3 fields.
- `orchestrator/src/admission-enrichment.test.ts`: +26 tests — level mapping table, gap→factor table (AC #1 bands verbatim), policy-agents selection semantics, missing-policy fallback (AC #2), over-earned (gap<0) case.

## Design decisions
- **Agent selection**: named agent wins if present; otherwise pick the most-permissive (highest `currentLevel`) agent. At admission time the issue hasn't been routed, so the optimistic pick mirrors real routing — any agent *could* take it. Explicit `agentName` in context is the escape hatch when the caller has routing info.
- **`complexity` on context is optional**: when omitted, `requiredLevel = currentEarnedLevel` → gap 0 → factor 1.0. This makes C4 a no-op until the caller can supply complexity. AISDLC-48 will thread the complexity from `mapIssueToPriorityInput`.
- **`complexityToAutonomyLevel` and `computeAutonomyFactor` exported separately**: AISDLC-48 consumes `computeAutonomyFactor` directly in the composite; having the mapping exported lets routing & other callers reuse the band logic without duplicating the thresholds.
- **Floor via `Math.max(0.1, ...)` on the positive-gap branch only**: gap ≤ 0 returns a hard `1.0`, avoiding Infinity-style calculations.

## Verification
- `pnpm build` — clean
- `pnpm vitest run src/admission-enrichment.test.ts` — 59/59 pass
- `pnpm vitest run` (full orchestrator) — 1918/1918 pass (+26 over baseline)
- `pnpm lint` — clean

## Follow-up
- AISDLC-46 populates `designAuthoritySignal` (C5, last M2 task)
- AISDLC-48 consumes `computeAutonomyFactor` in `ER = min(base × autonomyFactor, designSystemReadiness)`.
<!-- SECTION:FINAL_SUMMARY:END -->
