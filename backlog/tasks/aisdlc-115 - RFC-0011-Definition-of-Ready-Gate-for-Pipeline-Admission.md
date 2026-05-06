---
id: AISDLC-115
title: 'RFC-0011: Definition-of-Ready Gate for Pipeline Admission'
status: To Do
assignee: []
created_date: '2026-05-01 16:22'
updated_date: '2026-05-03 17:00'
labels:
  - rfc-0011
  - architecture
  - dor
  - pipeline-admission
milestone: m-3
dependencies: []
references:
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
  - ai-sdlc-plugin/agents/refinement-reviewer.md
  - .ai-sdlc/dor-config.yaml
  - spec/schemas/refinement-verdict.v1.schema.json
priority: high
blocked:
  reason: 'Soaking — 8/9 sub-tasks Done (115.1–7 + 115.9); 115.8 partial-shipped; AC #3 soak window opened 2026-05-03 (re-evaluate 2026-05-10); ACs #5 + #6 in flight via AISDLC-162 / 163. AISDLC-223 first user.'
  unblockedBy:
    - AISDLC-115.8
    - AISDLC-162
    - AISDLC-163
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      backlog/docs/ppa-product-signoff-rfc0011.md
    resolution: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Parent task for RFC-0011 implementation. Splits the 9-phase plan from RFC §12 into trackable sub-tasks (AISDLC-115.1 through 115.9). Sequential phases; each ships behind feature flag `AI_SDLC_DOR_GATE`. Total wall-clock ~5-6 weeks (Phase 7 soak duration is corpus-driven, not calendar-driven per maintainer directive).

## Sign-off status

- ✅ Engineering owner — Dom (2026-04-30, RFC v3)
- ✅ Operator owner — Dom (2026-04-30, RFC v3)
- ✅ Product owner — Alex (2026-05-01, see backlog/docs/ppa-product-signoff-rfc0011.md)

Two non-blocking additions requested by Product:
1. Auto-pass for signal-pipeline-generated issues (defer to Phase 4)
2. Shard naming for tessellated platforms (defer to Phase 7)

## Phase breakdown (per RFC §12)

| Sub-task | Phase | Wall-clock | Depends on |
|---|---|---|---|
| AISDLC-115.1 | Phase 1: Schema + status | 1 wk | — |
| AISDLC-115.2 | Phase 2a: Deterministic Stage A + corpus | 1 wk | 115.1 |
| AISDLC-115.3 | Phase 2b: Refinement-reviewer agent (Stage B) | 1-2 wk | 115.2 |
| AISDLC-115.4 | Phase 3: Orchestration + comment loop | 1 wk | 115.3 |
| AISDLC-115.5 | Phase 4: PPA composition + execute refusal + signal-pipeline auto-pass (Alex's Addition 1) | 0.5 wk | 115.4 |
| AISDLC-115.6 | Phase 5: Metrics + observability | 1 wk | 115.5 |
| AISDLC-115.7 | Phase 6: Bypass mechanism + escalation | 0.5 wk | 115.6 |
| AISDLC-115.8 | Phase 7: Soak + tune + tessellated-platform shard naming (Alex's Addition 2) | corpus-driven, target ≤2 wk | 115.7 |
| AISDLC-115.9 | Phase 8: Enforce | — | 115.8 |

Critical path: 115.1 → 115.2 → 115.3 → 115.4 → 115.5 → 115.6 → 115.7 → 115.8 → 115.9. Sequential because each phase consumes the prior phase's artifacts.

## Soak policy — corpus-driven, NOT calendar-driven

Per maintainer directive (2026-05-01): RFC-0011 phases must NOT be gated by arbitrary calendar windows. Phase 7 (soak) ships when:
- False-positive rate < 10% per gate against test corpus + shadow-mode eval, AND
- No outstanding override-rate anomalies in the calibration log.

Whichever comes first. Calendar duration is a side-effect, not a gate.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All 9 phase sub-tasks (AISDLC-115.1 through 115.9) reach Done status — 115.1–115.7 + 115.9 are Done; 115.8 partial-shipped (tessellated-platform shard naming committed for Gate 5; soak/tune work continues post-flip and 115.8 closes after the 1-week soak window validates ACs #1, #2, #5)
- [x] #2 Feature flag `AI_SDLC_DOR_GATE` promoted from `warn-only` → `enforce` — DONE in AISDLC-115.9 via operator-override path (per `docs/operations/dor-promotion.md`); calendar-driven gate dropped per maintainer directive 2026-05-01, replaced by hybrid corpus-OR-operator-override model (AISDLC-161)
- [ ] #3 Dogfood pipeline runs with DoR gate ENFORCING for at least one full week of real issue stream without operator override-rate spike — soak window opens 2026-05-03 (the day this PR merges); re-evaluate 2026-05-10
- [x] #4 Both Alex's additions delivered: signal-pipeline auto-pass (in Phase 4 / AISDLC-115.5) + tessellated-platform shard naming (Gate 5 regex bundle, AISDLC-115.8 partial-ship)
- [ ] #5 DoR calibration log written to `$ARTIFACTS_DIR/_dor/calibration.jsonl` (Section 5.5 of RFC) and feeds the metrics dashboard — calibration log writes (AISDLC-115.6); CI persistence + aggregator CLI shipped in AISDLC-161; metrics dashboard ships in AISDLC-162 (parallel work, in flight)
- [ ] #6 Operator runbook extended with DoR-specific failure modes (refusal flow, bypass mechanism, escalation paths) — ships in AISDLC-163 (parallel work, in flight); the override-promotion runbook itself is at `docs/operations/dor-promotion.md` (AISDLC-161)
<!-- AC:END -->
