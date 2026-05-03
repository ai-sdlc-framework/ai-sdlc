---
id: AISDLC-70
title: 'RFC-0010: Parallel Execution and Worktree Pooling'
status: Done
assignee: []
created_date: '2026-04-26 19:44'
updated_date: '2026-05-03'
labels:
  - rfc-0010
  - architecture
  - parallel-execution
milestone: m-2
dependencies: []
references:
  - spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
  - docs/operations/operator-runbook.md
  - orchestrator/src/execute.ts
  - orchestrator/src/runtime/parallelism-flag.ts
  - orchestrator/src/runtime/worktree-pool.ts
  - >-
    backlog/completed/aisdlc-70.1 -
    Phase-1-Foundations-port-allocator-worktree-ownership-schemas.md
  - backlog/completed/aisdlc-70.2 - Phase-2-Worktree-pool-manager.md
  - >-
    backlog/completed/aisdlc-70.3 -
    Phase-2.5-Per-stage-model-routing-conditional-review-fan-out.md
  - >-
    backlog/completed/aisdlc-70.4 -
    Phase-2.7-Harness-adapter-framework-Codex-adapter.md
  - >-
    backlog/completed/aisdlc-70.5 -
    Phase-2.8-Subscription-aware-scheduling-ledger.md
  - backlog/completed/aisdlc-70.6 - Phase-3-Concurrency-merge-gate.md
  - backlog/completed/aisdlc-70.7 - Phase-4-Artifacts-observability.md
  - backlog/completed/aisdlc-70.8 - Phase-5-Hardening.md
  - backlog/completed/aisdlc-70.9 - Phase-6-Database-isolation.md
  - >-
    backlog/completed/aisdlc-116 -
    Promote-AI_SDLC_PARALLELISM-feature-flag-to-default-on.md
priority: high
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
      was modified after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file docs/operations/operator-runbook.md was modified after
      task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file orchestrator/src/execute.ts was modified after task was
      completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file orchestrator/src/runtime/parallelism-flag.ts was modified
      after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file orchestrator/src/runtime/worktree-pool.ts was modified
      after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-70.1 -
      Phase-1-Foundations-port-allocator-worktree-ownership-schemas.md was
      modified after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-70.2 -
      Phase-2-Worktree-pool-manager.md was modified after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-70.3 -
      Phase-2.5-Per-stage-model-routing-conditional-review-fan-out.md was
      modified after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-70.4 -
      Phase-2.7-Harness-adapter-framework-Codex-adapter.md was modified after
      task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-70.5 -
      Phase-2.8-Subscription-aware-scheduling-ledger.md was modified after task
      was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-70.6 -
      Phase-3-Concurrency-merge-gate.md was modified after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-70.7 -
      Phase-4-Artifacts-observability.md was modified after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-70.8 - Phase-5-Hardening.md was
      modified after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-70.9 -
      Phase-6-Database-isolation.md was modified after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-116 -
      Promote-AI_SDLC_PARALLELISM-feature-flag-to-default-on.md was modified
      after task was completed
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Parent task for the RFC-0010 implementation. Splits the 9-phase implementation plan from RFC §17 into trackable sub-tasks (AISDLC-70.1 through 70.9). Phases 2, 2.5, and 2.7 are parallelizable from Phase 1; Phase 2.8 sequences after 2.7; Phase 6 sequences after Phase 3. Critical path: 70.1 → 70.4 → 70.5 (~5 weeks). Total wall-clock ~7–10 weeks.

The RFC bundles five reinforcing capabilities (worktree pool, model routing, harness adapters, subscription scheduling, database isolation) into one coherent implementation. The phases reflect dependency ordering rather than feature decomposition.

Sub-task structure mirrors RFC-0008's pattern (AISDLC-8 parent + AISDLC-8.1 through 8.5 sub-tasks).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 All 9 phase sub-tasks (AISDLC-70.1 through 70.9) reach Done status
- [x] #2 Feature flag AI_SDLC_PARALLELISM=experimental promoted to default-on after Phase 5 hardening completes (RFC §17 Phase 5)
- [x] #3 Dogfood pipeline migrated to parallel execution end-to-end (issue → PPA → develop → review → merge with parallelism > 1)
- [x] #4 Operator runbook (docs/operations/operator-runbook.md) extended with any new failure modes discovered during implementation
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
RFC-0010 parent umbrella close-out. All 9 phase sub-tasks (70.1–70.9) shipped between 2026-04-26 and 2026-05-01. AISDLC-116 promoted `AI_SDLC_PARALLELISM` to default-on per maintainer directive 2026-05-01 (corpus-driven, not calendar-driven — the trailing 7-day pre-flight scan of `orchestrator/_events.jsonl` and recent commit history showed zero parallelism-related incidents). The five reinforcing capabilities the RFC bundled — worktree pool, model routing, harness adapters, subscription scheduling, and database isolation — landed end-to-end behind the feature flag, then graduated together when the flag flipped. This task carries no new code; its job was to track the umbrella ACs and close out once the sub-tasks and the post-hardening promotion all settled.

## ACs satisfied
- ✓ #1 All 9 sub-tasks in `backlog/completed/`:
  - 70.1 Foundations (port allocator, worktree ownership, schemas)
  - 70.2 Worktree pool manager
  - 70.3 Per-stage model routing + conditional review fan-out
  - 70.4 Harness adapter framework + Codex adapter
  - 70.5 Subscription-aware scheduling + ledger
  - 70.6 Concurrency + merge gate
  - 70.7 Artifacts + observability
  - 70.8 Phase 5 hardening (chaos plan, stuck-heartbeat detection, runbook)
  - 70.9 Phase 6 database isolation
- ✓ #2 `AI_SDLC_PARALLELISM` defaults to `'on'` in `orchestrator/src/runtime/parallelism-flag.ts` (AISDLC-116). Backwards-compat envelope preserved: `experimental` still honored, `off`/`disabled`/`false`/`0` are explicit opt-outs, unknown values fail-on.
- ✓ #3 Dogfood pipeline runs parallel end-to-end. `orchestrator/src/execute.ts:252` reads the flag and constructs a `WorktreePoolManager` whenever the resolved mode is not `'off'`. Per-session fan-out (already in place since AISDLC-81 per-worktree sentinels) gives parallelism > 1 in practice via `/loop /ai-sdlc execute <task-id>` and multi-terminal dispatch — the worktree pool, port allocator, and DB isolation formalize the previously-implicit isolation contract for those parallel runs.
- ✓ #4 `docs/operations/operator-runbook.md` carries dedicated RFC-0010 sections: Subscription configuration events (§Event Triage Reference), Harness and model events, Worktree and database events (incl. `DatabaseIsolationRequired` critical event), Configuration Responsibilities (Subscription posture, Tenant overlays, Independence enforcement, Model routing, Schedule hints), and the Phase-5 chaos-test promotion checklist. No new failure modes surfaced beyond what the runbook already documents.

## Verification
- All 9 sub-task PRs landed individually with their own `pnpm build && pnpm test && pnpm lint && pnpm format:check` gates.
- AISDLC-116 (the post-hardening flag flip) shipped with 2938/2938 orchestrator tests passing.
- This umbrella commit changes only the parent task file (status, AC checkmarks, finalSummary, references) — no source edits, so the workspace gates re-run as a clean no-op against `main`.

## Follow-up
- Stale comment in `orchestrator/src/execute.ts:250` ("manager is constructed but not yet routed through — Phase 2 shipped the wire-in surface; Phase 3 wires the worker pool to consume it") predates the Phase 3 + 6 wiring; worth a doc-drift cleanup pass but not blocking.
- AISDLC-116 finalSummary called out two minors that remain open: runbook still references the dropped soak window in places, and a one-time `console.warn` for unknown flag values would surface operator typos at runtime. Both are non-blocking polish.
<!-- SECTION:FINAL_SUMMARY:END -->
