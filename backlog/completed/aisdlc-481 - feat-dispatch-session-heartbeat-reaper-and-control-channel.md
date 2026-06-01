---
id: AISDLC-481
title: 'feat: dispatch-session heartbeat liveness reaper + back-channel for parallel-execute sessions'
status: To Do
assignee: []
created_date: '2026-05-30 09:14'
labels:
  - dispatch
  - observability
  - parallelism
  - ipc
  - rfc-0041
dependencies: []
references:
  - spec/rfcs/RFC-0041-conductor-worker-process-architecture.md
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The 2026-05-30 audit found that IPC between the orchestrator and dispatched tmux/parallel sessions is one-way only. Dispatched `/ai-sdlc execute` sessions write `.ai-sdlc/dispatch/sessions/<task>.session.json` with currentStep plus lastHeartbeat (via execute.md update_session_state), and execute-parallel-status reads it for a status table. But two gaps remain.

First, no reaper consumes lastHeartbeat to detect a dead session. The only stale-heartbeat sweeper operates on the separate Dispatch Board inflight/*.state.json substrate, not the tmux session files — the two substrates are unconnected, so a tmux worker can die while its session file shows it alive.

Second, there is no back-channel. Nothing the orchestrator writes is read by a running session, so there is no pause, cancel, or answer capability once a session is in flight.

Goal: add liveness detection for the tmux session-file substrate and a minimal control back-channel, so a running dispatched session can be cancelled and can pick up an operator answer. This pairs directly with AISDLC-480's decision routing: AISDLC-480 surfaces the question, this task carries the answer back.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->

- [ ] AC-1: A reaper detects sessions whose lastHeartbeat is older than a configurable threshold and marks them failed in the session file; execute-parallel-status surfaces the failed state.
- [ ] AC-2: The reaper reconciles the two substrates: a tmux session-file death and the Dispatch Board inflight state are kept consistent, with no orphan in one substrate while the other still shows the session alive.
- [ ] AC-3: A minimal back-channel lets the orchestrator write a control signal (cancel) that a running `/ai-sdlc execute` session reads at its step boundaries and honors — performing a clean abort and marking the session file cancelled.
- [ ] AC-4: The control channel composes with AISDLC-480: an operator decision answer can be delivered to a paused session so it resumes; if resume is out of scope for v1, the session instead fails cleanly while emitting the decision id. This task scopes the back-channel to cancel-only for v1 and defers full pause/resume to a follow-up; AC-4 is satisfied by the clean-fail-with-decision-id path under that v1 scope.
- [ ] AC-5: Hermetic tests cover three cases — a stale heartbeat is reaped; a cancel signal is honored at the next step boundary; two-substrate consistency holds after a reap.
- [ ] AC-6: Docs: update docs/operations/parallel-dispatch.md with the liveness and cancel semantics.

<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Build on execute.md's update_session_state writer plus the Dispatch Board sweeper in pipeline-cli/src/dispatch/board.ts. Keep the implementation mechanism-agnostic where possible. Scope decision for v1, stated explicitly: the back-channel is cancel-only; full pause/resume of a running session is a deliberate follow-up, not part of this task. AC-4's resume path is therefore satisfied in v1 by the clean-fail-with-decision-id behavior, with true resume tracked separately.
<!-- SECTION:NOTES:END -->

## References

- spec/rfcs/RFC-0041-conductor-worker-process-architecture.md (conductor/worker IPC this task makes bidirectional)
- spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md (autonomous-orchestrator liveness expectations)
- pipeline-cli/src/dispatch/board.ts (Dispatch Board stale-heartbeat sweeper to reconcile against)
- ai-sdlc-plugin/commands/execute.md (update_session_state writer + step boundaries where cancel is read)
- .ai-sdlc/dispatch/sessions/ (the tmux session-file substrate the reaper operates on)
- AISDLC-480 (decision routing the back-channel delivers answers for)
