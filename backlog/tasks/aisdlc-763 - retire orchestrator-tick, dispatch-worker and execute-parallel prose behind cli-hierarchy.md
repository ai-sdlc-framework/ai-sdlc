---
id: AISDLC-763
title: >-
  Retire orchestrator-tick, dispatch-worker and execute-parallel prose behind cli-hierarchy.md
status: To Do
assignee: []
created_date: '2026-10-08'
labels:
  - plugin
  - token-cost
  - rfc-0051
dependencies: []
references:
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - ai-sdlc-plugin/commands/dispatch-worker.md
  - ai-sdlc-plugin/commands/execute-parallel.md
  - ai-sdlc-plugin/commands/execute-parallel-status.md
  - ai-sdlc-plugin/commands/execute-parallel-cleanup.md
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

2,588 lines of superseded loop prose still ship in the plugin and in the command listing: execute-parallel says it is superseded in its own description, orchestrator-tick duplicates dispatch, and dispatch-worker is Pattern Z. Full evidence: `docs/audits/2026-10-08-token-leak-loop-and-prose-automation-audit.md`.

## Scope

1. Reduce each of the five commands to a one-paragraph pointer to cli-hierarchy, or delete it.
2. Update the CLAUDE.md canonical-paths table and the docs that reference them.
3. Keep `cli-orchestrator tick --spawner` (the shell path) intact.

Sequencing: none.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] AC-1: The five command files are pointers of a paragraph or deleted, and the command listing shrinks accordingly.
- [ ] AC-2: CLAUDE.md canonical-paths table and docs no longer present them as primary paths.
- [ ] AC-3: `cli-orchestrator tick --spawner` tests still pass.
<!-- AC:END -->
