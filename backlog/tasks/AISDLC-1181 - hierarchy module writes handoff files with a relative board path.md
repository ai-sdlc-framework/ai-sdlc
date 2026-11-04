---
id: AISDLC-1181
title: 'Hierarchy module writes handoff files with a relative board path that follows the session cwd'
status: In Progress
assignee: []
created_date: '2026-11-04'
labels:
  - hierarchy
  - plugin
  - bug
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - ai-sdlc-plugin/hooks/hierarchy/register.tsx
priority: medium
---

## Description

**Source.** Planner finding, 2026-11-04 (planner class a). The dispatch tick reported that parent upkeep refused on every tick: "Step 0.5: non-backlog untracked files detected in parent", naming `.claude/memory/.ai-sdlc/dispatch/handoff/received-ai-sdlc-planner.json`.

**Problem.** `recordReceivedSender` and `writeModuleHealth` in `ai-sdlc-plugin/hooks/hierarchy/dispatch.ts` fall back to the relative path `.ai-sdlc/dispatch` when `boardDir` is undefined. The path is resolved against the cwd of the process the module runs, which follows the session's shell. The planner session had worked in `.claude/memory`, so the received-sender list landed at `.claude/memory/.ai-sdlc/dispatch/handoff/` in the parent checkout. That untracked file blocks parent upkeep (Step 0.5) for every tick until someone removes it, and the reply list `cli-hierarchy send` reads is silently missing from the real board.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the writers need a board directory; AISDLC-1080 and AISDLC-1061 set the fallback, and the requirement stands because sessions start without `AI_SDLC_DISPATCH_BOARD_DIR`. 2. Deleted: the relative fallback string. 3. Simplified: resolve the fallback once, as an absolute path from the project root (the same rule `session-start.js` and `context-budget.js` use: `AI_SDLC_DISPATCH_BOARD_DIR`, else `<projectDir>/.ai-sdlc/dispatch`), and pass it to every writer. 4. Accelerated: no stalled upkeep ticks from stray files. 5. Automated: a test pins that the written path is absolute and under the project root whatever the cwd.

## Acceptance Criteria

- [ ] AC-1: With `boardDir` undefined and the process cwd set to a subdirectory of the project, `recordReceivedSender` and `writeModuleHealth` write under `<projectDir>/.ai-sdlc/dispatch/handoff/`. A test covers both writers.
- [ ] AC-2: No hierarchy module writer passes a relative board path to `process.run`; a test or a single resolver function shared by the writers enforces it.
- [ ] AC-3: Existing hierarchy module tests pass unchanged.
