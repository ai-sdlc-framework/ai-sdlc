---
id: AISDLC-414
title: 'feat(orchestrator-tick): Step 5b — in-session bg Agent(developer) dispatch (AISDLC-396 follow-up)'
status: To Do
labels: [orchestrator, plugin, autonomous-loop, follow-up-aisdlc-396]
references:
  - ai-sdlc-plugin/commands/orchestrator-tick.md
priority: high
permittedExternalPaths: []
---

## Description

AISDLC-396 was supposed to make `/ai-sdlc orchestrator-tick` self-dispatch background `Agent(developer)` per emitted manifest so Pattern X v2 (single-session autonomy) actually works. The CLAUDE.md table claims this is shipped, but reading the live `ai-sdlc-plugin/commands/orchestrator-tick.md` skill body shows only the reviewer fan-out is wired (Step 3) and Step 5 only writes manifests to `.ai-sdlc/dispatch/queue/`. There is no Conductor-side dev dispatch.

Concrete operational gap (observed 2026-05-23 during 5-wide autonomous drain):

1. Operator runs `/ai-sdlc orchestrator-tick`
2. Conductor writes N manifests to queue
3. **No Worker session exists** to claim the manifests (operator-of-one is the common case)
4. Manifests sit in queue forever; nothing happens
5. The operator (or me, the conducting CC session) has to manually spawn `Agent(developer, run_in_background=true)` per manifest as a side-channel bridge
6. The Conductor never actually orchestrates the dispatch — it only orchestrates the reconcile

This breaks the documented Pattern X v2 contract.

## Acceptance criteria

- [ ] AC-1: `ai-sdlc-plugin/commands/orchestrator-tick.md` Step 5 gets a new sub-step 5b that, immediately after `write-manifest`, spawns `Agent(developer, run_in_background=true)` with the manifest's task body as the brief. Brief follows the standard developer contract (worktree create + commit + push DRAFT PR) per `ai-sdlc-plugin/agents/developer.md`.
- [ ] AC-2: Skip dispatch when `peek.queued + peek.inflight >= inSessionAgentMaxSessions` (existing backpressure).
- [ ] AC-3: Mark manifest as inflight before dispatching (move from queue/ to inflight/ atomically) so a sibling Worker session running `dispatch-worker` doesn't double-claim. Reuse existing `cli-dispatch claim --worker-kind in-session-agent` for the atomic move.
- [ ] AC-4: Heartbeat writer — each spawned bg Agent writes a heartbeat every 60s to its inflight manifest's heartbeat file. Existing `cli-dispatch heartbeat` CLI handles the write; brief instructs dev to call it periodically (or wire a per-spawn watchdog).
- [ ] AC-5: After dev returns (`<task-notification>`), Conductor's next tick collects the dev's return JSON into a verdict file at `done/<task-id>.verdict.json` and proceeds with the existing Step 3 reconcile flow (reviewer fan-out + sign + push + flip-ready).
- [ ] AC-6: CLAUDE.md "Canonical execution paths" Pattern X v2 row updated to accurately reflect what's shipped.
- [ ] AC-7: Hermetic test: invoke the orchestrator-tick skill body end-to-end against a fixture with 2 frontier tasks; verify 2 bg Agents spawn, 2 manifests move to inflight/, and the test driver can simulate dev returns + verify reconcile fires.

## Out of scope

- Multi-session Pattern Z (sibling Workers via `dispatch-worker`) — unchanged.
- The `cli-orchestrator tick --spawner claude` headless shell path — unchanged.
- Refactoring the dispatch board schema — keep as-is.

## Why this matters

Without this fix, the orchestrator-tick protocol is a fiction in single-session operator-of-one mode (the dominant case). The Conductor writes manifests that no one claims. The conducting CC session has to manually side-channel-bridge to make the autonomous loop function. This was directly observed during the 5-wide dispatch on 2026-05-23 (PRs #648 / #649 / #650 / #651 / #652 → AISDLC-375/318/337/325/350) where the Conductor wrote 5 manifests + I spawned 5 bg Agents inline.

## Estimated effort

30-60 min. Mostly markdown-skill-body diff + one new test case + CLAUDE.md doc update.
