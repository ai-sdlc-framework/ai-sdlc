---
id: AISDLC-564.1
title: Wire cli-dispatch record-agent into the current executor dispatch path
status: To Do
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
