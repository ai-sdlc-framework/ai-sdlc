---
id: AISDLC-564.1
title: Wire cli-dispatch record-agent into the current executor dispatch path
status: In Progress
priority: medium
created_date: '2026-10-11 03:06'
updated_date: '2026-10-11 03:06'
assignee: []
labels: []
dependencies:
  - AISDLC-564
references:
  - pipeline-cli/src/cli/dispatch.ts
  - ai-sdlc-plugin/commands/executor.md
---

AISDLC-564 added `cli-dispatch record-agent` (persists agentId, worktree and transcript path in the session record). Its dispatch-time call sites lived in `orchestrator-tick.md` and `dispatch-worker.md`, which main retired to pointers (AISDLC-763), so nothing calls it now. Add the call to the current dispatch path (executor/dispatch session) so a killed subagent's recovery key is persisted. Raised by code review of the AISDLC-564 rebase.

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 The current executor/dispatch path (`ai-sdlc-plugin/commands/executor.md`) calls `cli-dispatch record-agent` at dispatch time, persisting agentId, worktree and transcript path in the session record.
- [ ] #2 A killed subagent's recovery key is readable from the session record after the kill (hermetic test covering the record-agent call on the executor path).
- [ ] #3 No call site remains in the retired `orchestrator-tick.md` or `dispatch-worker.md` pointers.
<!-- AC:END -->
