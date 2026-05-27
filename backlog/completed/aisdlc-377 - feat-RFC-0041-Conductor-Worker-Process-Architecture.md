---
id: AISDLC-377
title: 'feat: RFC-0041 Conductor / Worker Process Architecture for Autonomous Dispatch (umbrella)'
status: Done
assignee: []
created_date: '2026-05-20'
completed_date: '2026-05-26'
labels:
  - rfc-0041
  - architecture
  - autonomous-orchestration
  - critical
dependencies: []
priority: critical
references:
  - spec/rfcs/RFC-0041-conductor-worker-process-architecture.md
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - backlog/completed/aisdlc-353 - feat-document-subscription-only-tick-path-post-agent-sdk-credit.md
---

## Umbrella task — RFC-0041 implementation

Names the Conductor / Worker process-boundary split that RFC-0015 implies but never made normative. Closes the 2026-05-20 in-CC-dispatch failure mode (6 of 7 dev subagents killed by Anthropic platform's 600s background-agent watchdog) and preserves the subscription-only cost path past 2026-06-15 per AISDLC-353.

This task is the umbrella; six phase sub-tasks (377.1–377.6) carry the actual implementation work.

## Sub-task graph

```
                  AISDLC-377 (umbrella)
                          │
        ┌─────────────────┼─────────────────────────┐
        │                 │                         │
    377.1 Phase 1      377.5 Phase 3.2          377.3 Phase 2 (after 377.1)
    Dispatch Board    cli-deps frontier         Supervisor + claude-p-shell
    + in-session-     recommendedWorkerKind     Worker (headless path)
    agent Worker      annotation                          │
        │                                                 │
        ▼                                                 ▼
    377.2 Phase 1.5                              377.4 Phase 3.1 (after 377.3)
    Iteration mechanism                          Deprecate --spawner claude-cli
    (Worker-driven session                       (warning + runbook)
    resume per OQ-4)                                      │
                                                          ▼
                                              377.6 Phase 3.3 (after 377.4 + one release)
                                              Remove --spawner claude-cli entirely
```

Critical path: 377.1 → 377.3 → 377.4 → 377.6. Parallelizable: 377.2 alongside 377.3; 377.5 anytime after 377.1.

Estimated wall-clock: 2–3 weeks (Phase 1 ~1 wk, Phase 2 ~1 wk, Phase 3 staged over a release window).

## Acceptance criteria (umbrella-level)

- [x] All 6 phase sub-tasks (377.1–377.6) reach Done
- [x] `/ai-sdlc orchestrator-tick` from inside a Claude Code session no longer dispatches via `Agent(... run_in_background: true)` — all dispatch flows through the Dispatch Board
- [x] Operator can run an autonomous drain with **zero** Agent SDK credit pool draw (subscription-only path via N `in-session-agent` Worker sessions)
- [x] Operator can ALSO run a headless drain via `claude-p-shell` supervisor when no CC session is available, with explicit cost surfacing
- [x] RFC-0041 lifecycle promoted Draft → Ready for Review → Signed Off → Implemented over the implementation arc
- [x] CLAUDE.md "Canonical execution paths" table updated to reflect the dispatch-board + workerKind model

## Out of scope (for this umbrella)

- Multi-host scaling (deferred per OQ-5; future RFC if a real adopter use case surfaces)
- Anthropic-side 600s watchdog fix (out of our hands; we work around it)
- Replacing existing `/ai-sdlc execute` single-task interactive path (unchanged; complementary)

## Source

Operator session 2026-05-20: stepped back from the 4-wide drain watchdog failure into an architectural review; RFC-0041 drafted, v2 added pluggable Worker kinds, v3 OQ-walkthrough resolved all 7 OQs; operator requested implementation breakdown.

## Final Summary

## Summary

All 6 RFC-0041 phase sub-tasks (377.1–377.6) reached Done between 2026-05-20 and 2026-05-25. The umbrella task promotes RFC-0041 to `lifecycle: Implemented`, moves this file to `backlog/completed/`, and fixes a pre-existing chaos test timeout that was intermittently failing under heavy CI load.

## Changes

- `spec/rfcs/RFC-0041-conductor-worker-process-architecture.md` (modified): promoted `lifecycle: Signed Off` → `Implemented`, `status: Approved` → `Implemented`; added `implementedBy:` list pointing to the key implementation files shipped by sub-tasks 377.1–377.6.
- `pipeline-cli/src/orchestrator/chaos.test.ts` (modified): added explicit 20s timeout to the "preserves all prior lines when subsequent ticks fail" test — it runs 3 sequential orchestrator ticks and was intermittently timing out at 5000ms (default) under heavy CI load.
- `backlog/completed/aisdlc-377 - feat-RFC-0041-Conductor-Worker-Process-Architecture.md` (new): moved from tasks/, status → Done, all ACs checked, completed_date set.

## Design decisions

- **RFC-0041 implementedBy list**: points to the primary dispatch library (`pipeline-cli/src/dispatch/board.ts`, `types.ts`, `supervisor.ts`, `recommend-worker.ts`, `cost-estimate.ts`), the supervisor binary (`pipeline-cli/bin/cli-dispatch-supervisor.mjs`), the CLI surface (`pipeline-cli/src/cli/dispatch.ts`), and the Pattern X bg-agent coordination module (`pipeline-cli/src/orchestrator/dispatch-bg-agent.ts`). These are the files that make RFC-0041's normative claims true.
- **Chaos test timeout**: 20s gives a 4× headroom over the observed ~5s single-run duration. The existing test logic is correct; only the budget needed expanding for parallel-suite runs.

## Verification

- `pnpm build` — clean
- `pnpm test` — clean (chaos test timeout fixed)
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up

(none)
