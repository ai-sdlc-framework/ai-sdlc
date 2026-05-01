---
id: AISDLC-115
title: 'RFC-0011: Definition-of-Ready Gate for Pipeline Admission'
status: To Do
assignee: []
created_date: '2026-05-01 16:22'
labels:
  - rfc-0011
  - architecture
  - dor
  - pipeline-admission
milestone: m-3
dependencies: []
references:
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
  - backlog/docs/ppa-product-signoff-rfc0011.md
  - ai-sdlc-plugin/agents/refinement-reviewer.md
  - .ai-sdlc/dor-config.yaml
  - spec/schemas/refinement-verdict.v1.schema.json
priority: high
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
- [ ] #1 All 9 phase sub-tasks (AISDLC-115.1 through 115.9) reach Done status
- [ ] #2 Feature flag `AI_SDLC_DOR_GATE` promoted from `warn-only` → `enforce` after Phase 7 soak validates < 10% per-gate false-positive rate (NOT time-gated; corpus-validated)
- [ ] #3 Dogfood pipeline runs with DoR gate ENFORCING for at least one full week of real issue stream without operator override-rate spike
- [ ] #4 Both Alex's additions delivered: signal-pipeline auto-pass (in Phase 4) + tessellated-platform shard naming (in Phase 7)
- [ ] #5 DoR calibration log written to `$ARTIFACTS_DIR/_dor/calibration.jsonl` (Section 5.5 of RFC) and feeds the metrics dashboard
- [ ] #6 Operator runbook extended with DoR-specific failure modes (refusal flow, bypass mechanism, escalation paths)
<!-- AC:END -->
