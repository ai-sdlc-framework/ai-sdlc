---
id: AISDLC-169
title: 'RFC-0015: Autonomous Pipeline Orchestrator'
status: To Do
assignee: []
created_date: '2026-05-03'
labels:
  - rfc-0015
  - orchestrator
  - autonomous
  - parent
milestone: m-3
dependencies: []
references:
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - pipeline-cli/src/
priority: high
blocked:
  reason: 'Soaking + prerequisites — all 5 sub-tasks (169.1–169.5) Done. AC #2 (AI_SDLC_AUTONOMOUS_ORCHESTRATOR flag promotion from experimental → default-on) gated on (a) AISDLC-223 BlockedFilter so the orchestrator can skip blocked tasks, (b) AISDLC-224 stale-branch auto-cleanup, (c) corpus-driven soak per docs/operations/orchestrator-promotion.md (95%+ tasks complete unattended, no quota-burn surprise).'
  unblockedBy:
    - AISDLC-223
    - AISDLC-224
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Parent task for the RFC-0015 implementation. Splits the 5-phase plan from RFC §11 into trackable sub-tasks (AISDLC-169.1 through 169.5). All phases ship behind feature flag `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental` (default off). Total wall-clock ~4 weeks for Phase 1-4; Phase 5 soak duration is corpus-driven, not calendar-driven.

## Scope

RFC-0015 closes the "outer loop" gap between the parallelism primitives (RFC-0010), admission gate (RFC-0011), pipeline library (RFC-0012), and dependency-aware priority (RFC-0014). It defines a **single-sandbox** long-running Node process (per RFC §13 Q11=A) that:

1. Polls the dispatch frontier (`cli-deps frontier`) every tick (default 30s).
2. Filters candidates by DoR readiness (RFC-0011), dependency-blocker emptiness, and external-deps clearance (RFC-0014 Q3).
3. Dispatches up to `parallelism.maxConcurrent` workers via `executePipeline()` (RFC-0012 Tier 2).
4. Routes known failure signals through a deterministic 8-mode playbook (§5.1) instead of human judgment.
5. Emits an event stream at every state transition for `cli-status --orchestrator` and downstream observability consumers.

Multi-sandbox coordination is a non-goal (deferred to a future RFC). `/ai-sdlc execute` continues to work unchanged for interactive use; orchestrator and slash command share the worktree pool via per-worktree sentinels.

## Phase breakdown (per RFC §11)

| Sub-task | Phase | Wall-clock | Depends on |
|---|---|---|---|
| AISDLC-169.1 | Phase 1: Bare orchestrator loop | 1 wk | — |
| AISDLC-169.2 | Phase 2: Failure playbook | 1.5 wk | 169.1 |
| AISDLC-169.3 | Phase 3: Pre-dispatch filters | 0.5 wk | 169.2 |
| AISDLC-169.4 | Phase 4: Observability hooks | 1 wk | 169.3 |
| AISDLC-169.5 | Phase 5: Hardening + soak | corpus-driven | 169.4 |

Critical path is strictly linear (Phase 1 → 2 → 3 → 4 → 5) per RFC §11.

## Dependencies

- **RFC-0010 — Parallel Execution and Worktree Pooling.** Shipped. Provides `WorktreePoolManager`, port allocator, subscription scheduler, and the `parallelism.maxConcurrent` budget the orchestrator respects.
- **RFC-0011 — Definition-of-Ready Gate.** Enforce mode live. Provides the `RefinementVerdict` schema the pre-dispatch admission filter consumes.
- **RFC-0012 — Two-Tier Pipeline Architecture.** Shipped. Provides `executePipeline()` library + `SubagentSpawner` injection — the orchestrator IS the third tier built on top.
- **RFC-0014 — Dependency Graph Composition.** All 5 phases shipped (167.1-167.5). Provides composite priority (`effectivePriority DESC → criticalPathLength DESC → recency DESC`), the snapshot artifact, and `externalDependencies:` frontmatter.
- **AISDLC-117 — `cli-deps` foundation.** Provides `frontier`, `blockers`, `validate` commands.

## Open-question resolutions worth carrying forward

All 12 open questions resolved at v1 (RFC §13). The implementations below MUST honor:
- **Q1** (human-attention surface): three-layer — PR label `needs-human-attention` (durable truth) + `cli-status --needs-attention` view + Slack push (Phase 4).
- **Q2** (resume semantics): stateless + idempotent finalize. Each finalize step short-circuits if already done. No resume code path; startup IS recovery (Phase 1).
- **Q3** (peak-blocked sleep): exponential backoff 30s → 5min cap; reset on off-peak transition or new task arrival (Phase 3).
- **Q4** (parallel remediation): per-worker, no global locks. Phase 2 implementers MUST audit each new handler for hidden global-state mutations.
- **Q5** (no-work backoff): same curve as Q3; distinguished only by event type (`OrchestratorIdleNoWork` vs `OrchestratorIdleWaitingForOffPeak`).
- **Q6** (long-running PR): park after 2h, no auto-rebase, no nag (composes with Q12).
- **Q7** (per-project config): `.ai-sdlc/orchestrator-config.yaml` with `failureBudgets` overrides per mode (Phase 4).
- **Q8** (unknown failure mode): conservative fall-through — emit `UnknownFailureMode`, tag PR `needs-human-attention`, do NOT attempt remediation (Phase 1 schema; Phase 2 wires it).
- **Q9** (pattern versioning): `.ai-sdlc/orchestrator-failure-patterns.yaml` validated against `orchestrator-failure-patterns.v1.schema.json`. 9 default patterns (8 from §5.1 + `StackedPRBaseSquashed`) ship as the committed catalogue (Phase 2).
- **Q10** (PR drift detection): periodic poll via `gh pr list --json number,mergeStateStatus,headRefOid` per tick; webhook-driven deferred to Phase 4 only on measured pain (Phase 1).
- **Q11** (process model): pure Node process. `node ai-sdlc-plugin/orchestrator/run.mjs` packaged with systemd unit + Docker template + GH Actions self-hosted runner config (Phase 1).
- **Q12** (auto-merge): defense-in-depth. Workflow side (`auto-enable-auto-merge.yml` re-fires on synchronize/reopened) SHIPPED via AISDLC-130. Orchestrator side adds `gh pr merge --auto --rebase` to finalize sequence + `AutoMergeFlagSet` event (Phase 1).

## Soak policy — corpus-driven, NOT calendar-driven

Per maintainer directive (consistent with RFC-0014 Phase 5): RFC-0015 Phase 5 ships when:

- **95%+ of tasks complete without human intervention** on a real-issue queue (≥20 tasks across ≥3 RFCs), AND
- **No quota-burn surprise** vs SubscriptionLedger projections (per RFC-0010 §14).

Whichever comes first. Calendar duration is a side-effect, not a gate.

## Promotion mechanics

- Default `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=off` (Phase 1-4 ship behind it).
- Operators opt-in via env override (per-session) during soak.
- When promotion criteria met, flip default to `experimental` → `on` in a single, reviewable PR. Document the corpus measurement that justified promotion.
- Hybrid corpus-OR-operator-override promotion model available (matches RFC-0011 / AISDLC-161 / RFC-0014 pattern).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All 5 phase sub-tasks (AISDLC-169.1 through 169.5) reach Done status
- [ ] #2 Feature flag `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` promoted from `off` (default) → `experimental` → default-on after Phase 5 corpus validates 95%+ unattended completion AND no quota-burn surprise vs SubscriptionLedger projections
- [ ] #3 Real-issue queue (≥20 tasks across ≥3 RFCs) runs autonomously without human intervention for 1 full corpus window (corpus-driven, not calendar-gated)
- [ ] #4 8-mode failure playbook (§5.1) ships with per-mode test coverage; each mode has detection signal, remediation handler, retry budget, and escalation path covered by hermetic tests
- [ ] #5 `events.jsonl` event stream + `cli-status --orchestrator` surface live for operator visibility; 13 event types from §7.1 are emitted at the documented state transitions
- [ ] #6 RFC-0015 v2 entry added to revision history when promoted (records the corpus measurement + promotion-PR SHA)
- [ ] #7 All 12 open-question resolutions from RFC §13 honored in shipped phases (Q1-Q12 cross-referenced in sub-task ACs)
- [ ] #8 Operator runbook (`docs/operations/operator-runbook.md`) extended with orchestrator-specific failure modes (UnknownFailureMode escalation, parked-worker investigation, OrchestratorStuckCandidate triage)
<!-- AC:END -->
