---
id: AISDLC-760
title: >-
  Dispatch idle hibernation and self-clear on every wake path
status: To Do
assignee: []
created_date: '2026-10-08'
labels:
  - hierarchy
  - token-cost
dependencies: []
references:
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - pipeline-cli/src/hierarchy/clear.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - docs/operations/cli-hierarchy.md
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

The ai-sdlc-io dispatch session (Opus, 690k context) spent $1,320 of API weight in 24 h polling an empty board every 60 s, 40% of the day. The installed 0.24.0 body never clears; the repo body clears but has no idle interval. Full evidence: `docs/audits/2026-10-08-token-leak-loop-and-prose-automation-audit.md`.

## Scope

1. `cli-hierarchy tick` returns `nextWakeSec`: 30 when a brief or verdict is pending, 1800 when the board is empty and nothing is inflight, with an event-driven wake on a new brief or verdict via fs.watch where possible.
2. The no-TMUX_PANE fallback must still clear: document how, or refuse to run without tmux.
3. Fold identity, handoff-file read and mark-ready-after-CodeQL into the tick so operator-dispatch.md shrinks below 120 lines.

Sequencing: none. Model: per DEC-0068 the `--dispatch-model` default in cli-hierarchy up changes from opus to sonnet with this task, and to haiku once the tick is one deterministic call.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] AC-1: An empty-board dispatch session makes at most 2 LLM calls per 30 minutes.
- [ ] AC-2: Every wake path starts from the context floor.
- [ ] AC-3: operator-dispatch.md is below 120 lines.
- [ ] AC-4: Hermetic tests cover nextWakeSec and the no-tmux path.
<!-- AC:END -->
