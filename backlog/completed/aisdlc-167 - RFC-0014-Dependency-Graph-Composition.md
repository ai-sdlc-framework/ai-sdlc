---
id: AISDLC-167
title: 'RFC-0014: Dependency Graph Composition'
status: Done
assignee: []
created_date: '2026-05-03'
labels:
  - rfc-0014
  - dependency-graph
  - composition
  - parent
milestone: m-3
dependencies: []
references:
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - pipeline-cli/src/deps/
priority: high
finalSummary: |
  ## Summary
  All 5 sub-tasks (AISDLC-167.1 through 167.5) shipped. Operator decision 2026-05-10: feature stays opt-in via `AI_SDLC_DEPS_COMPOSITION=1`; default-on promotion (AC #2) is intentionally deferred — composition is a nice-to-have ranking enhancement, not a regression risk if left off, and the promotion runbook (`docs/operations/deps-composition-promotion.md`) remains the path for any future flip.

  ## Decision
  - **AC #1** ✅ all 5 sub-tasks Done.
  - **AC #2** rejected by operator — flag stays opt-in; runbook preserved for adopter teams that want to flip per-project.
  - **AC #3, #5, #6** rejected as a consequence of AC #2 (soak/runbook extension/docs only matter once we're driving toward default-on).
  - **AC #4** ✅ all 6 RFC §12 v3 Q-resolutions cross-referenced in shipped phases.

  ## Follow-up
  None. Adopters opt in via `AI_SDLC_DEPS_COMPOSITION=1` per `docs/operations/deps-composition.md`.
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Parent task for the RFC-0014 implementation. Splits the 5-phase plan from RFC §11 into trackable sub-tasks (AISDLC-167.1 through 167.5). All phases ship behind feature flag `AI_SDLC_DEPS_COMPOSITION`. Total wall-clock ~3 weeks (Phase 5 soak duration is corpus-driven, not calendar-driven per maintainer directive 2026-05-01).

## Scope

RFC-0014 promotes the dependency graph (AISDLC-117 `cli-deps` foundation) to a first-class pipeline object and composes it with three existing subsystems:

1. **PPA × Graph** (Phase 2) — depth-aware priority. A high-PPA task whose blocker is a low-PPA task auto-bumps the blocker via `effectivePriority = priority(task) + maxDownstreamPriority(task)` so critical-path leaves bubble to the top.
2. **DoR × Graph** (Phase 3) — blast-radius surfacing. The DoR clarification comment + calibration log gain blast-radius fields so authors see "this gates N downstream tasks" and the calibration loop distinguishes false-positives on leaves vs chain roots.
3. **Graph × Observability** (Phase 4) — critical-path digest in Slack weekly digest + interactive operator dashboard.

## Phase breakdown (per RFC §11)

| Sub-task | Phase | Wall-clock | Depends on |
|---|---|---|---|
| AISDLC-167.1 | Phase 1: Snapshot artifact | 0.5 wk | — |
| AISDLC-167.2 | Phase 2: PPA composition | 1 wk | 167.1 |
| AISDLC-167.3 | Phase 3: DoR composition | 0.5 wk | 167.2 |
| AISDLC-167.4 | Phase 4: Slack + dashboard digest | 1 wk | 167.2 |
| AISDLC-167.5 | Phase 5: Soak + flag promotion | corpus-driven | 167.3, 167.4 |

Critical path: 167.1 → 167.2 → 167.3/167.4 (parallelizable) → 167.5.

## In-flight cross-reference

AISDLC-166 is doing the **Phase 1 work in flight** (developer was dispatched directly against AISDLC-166 before this parent task tree was created). When AISDLC-166's PR merges, it satisfies AISDLC-167.1 — close 167.1 then with a back-pointer to 166.

## Dependencies

- AISDLC-117 (`cli-deps` foundation) — DONE. Provides the in-memory graph computer + `frontier|blockers|impact|validate|graph` CLI surface this RFC's compositions consume.
- RFC-0008 PPA scoring (Phase 2 composes with the dispatcher's priority comparator).
- RFC-0011 DoR gate (Phase 3 composes with the comment template + calibration log).
- RFC-0010 cli-status (Phase 4 composes with the existing Slack/dashboard digest pattern).

## Soak policy — corpus-driven, NOT calendar-driven

Per maintainer directive (2026-05-01): RFC-0014 Phase 5 ships when:
- Dispatch correctness > 95% measured against the pipeline corpus, AND
- No operator override-rate spike vs PPA-only baseline.

Whichever comes first. Calendar duration is a side-effect, not a gate.

## Open-question resolutions worth carrying forward

All 6 open questions resolved at v3 (RFC §12). The implementations below MUST honor:
- Q1: dispatcher sort = `effectivePriority DESC → criticalPathLength DESC → recency DESC` (Phase 2).
- Q2: snapshot retention = 30d rolling + event-tagged permanent; ship `cli-deps gc` + `cli-deps inspect --tag <name>` (Phase 1).
- Q3: `externalDependencies:` frontmatter array — surfaced in snapshot/DoR comment/blockers, NOT a dispatch gate in v1 (Phase 1 + Phase 3).
- Q4: no cache; recompute graph every dispatch (Phase 2).
- Q5: `dor-bypass` admission with high blast radius posts a maintainer-tone FYI variant of the blast-radius comment (Phase 3).
- Q6: per-task atomic read; "best-effort consistency, validated by consumer" contract documented in `pipeline-cli/docs/deps.md` (Phase 1).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All 5 phase sub-tasks (AISDLC-167.1 through 167.5) reach Done status
- [ ] #2 Feature flag `AI_SDLC_DEPS_COMPOSITION` promoted from `off` (default) → `on` after Phase 5 soak validates dispatch correctness > 95% with no operator-override-rate spike
- [ ] #3 Dogfood pipeline runs end-to-end with composition ENABLED for at least one full corpus window (issue → PPA × graph → DoR × graph → dispatch → critical-path digest)
- [ ] #4 All 6 open-question resolutions from RFC §12 v3 honored in shipped phases (Q1-Q6 cross-referenced in sub-task ACs)
- [ ] #5 Operator runbook extended with composition-specific failure modes (snapshot validation failures, dispatch ordering anomalies, blast-radius callout misfires)
- [ ] #6 `pipeline-cli/docs/deps.md` documents the snapshot artifact contract, the per-task atomic-read consistency model (Q6), and the `cli-deps gc` / `inspect --tag` retention story (Q2)
<!-- AC:END -->
