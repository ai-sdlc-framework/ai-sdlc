---
id: AISDLC-167.5
title: 'Phase 5: Soak + flag promotion'
status: To Do
assignee: []
created_date: '2026-05-03'
labels:
  - rfc-0014
  - phase-5
  - soak
  - flag-promotion
milestone: m-3
dependencies:
  - AISDLC-167.3
  - AISDLC-167.4
parent_task_id: AISDLC-167
references:
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - docs/operations/operator-runbook.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 of RFC-0014. Run with `AI_SDLC_DEPS_COMPOSITION=off` (default) → operators opt in via env override → measure dispatch quality vs PPA-only baseline → promote flag to default-on when corpus criteria are met. Per RFC §11 Phase 5.

## Soak policy — corpus-driven, NOT calendar-driven

Per maintainer directive (2026-05-01): this phase ships when:
- **Dispatch correctness > 95%** measured against the pipeline corpus (composition vs PPA-only baseline; "correctness" = dispatcher's top pick matches an operator's manual top pick on a held-out corpus slice), AND
- **No operator override-rate spike** vs PPA-only baseline (override-rate metric from RFC-0011 §7.4 framework, repurposed for dispatch overrides).

Whichever comes first. Calendar duration is a side-effect, not a gate.

## Promotion mechanics

- Default `AI_SDLC_DEPS_COMPOSITION=off` until corpus criteria met.
- Operators opt-in via env override (per-session) during soak.
- When promotion criteria met, flip default to `on` in a single, reviewable PR. Document the corpus measurement that justified promotion.
- Hybrid corpus-OR-operator-override promotion model available (matches RFC-0011 / AISDLC-161 pattern) if the corpus is too small for statistical confidence within reasonable wall-clock.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Soak harness measures dispatch correctness for composition vs PPA-only baseline against a held-out corpus slice; "correctness" = dispatcher's top pick matches an operator's manual top pick
- [ ] #2 Soak harness measures operator override-rate (dispatch overrides), composing with the existing RFC-0011 §7.4 override-rate framework where reusable
- [ ] #3 Operator opt-in path documented: per-session `AI_SDLC_DEPS_COMPOSITION=on` env override; runbook entry in `docs/operations/operator-runbook.md` covering opt-in, observation, and revert
- [ ] #4 Promotion criteria gate: dispatch correctness > 95% AND no operator-override-rate spike vs PPA-only baseline; both metrics published to the existing dashboard surface
- [ ] #5 Default-on flip is a separate, reviewable PR that links to the corpus measurement justifying promotion; rollback procedure documented (flip env back to `off`, single-line revert)
- [ ] #6 Operator runbook (`docs/operations/operator-runbook.md`) extended with composition-specific failure modes: snapshot validation failures, dispatch ordering anomalies, blast-radius callout misfires
- [ ] #7 Parent AISDLC-167 ACs #2, #3, #5 closed by the work in this sub-task (flag promoted, dogfood pipeline running with composition end-to-end, runbook extended)
- [ ] #8 Soak measurement methodology + the promotion decision documented in `pipeline-cli/docs/deps.md` so future phases can reuse the corpus-driven pattern
<!-- AC:END -->
