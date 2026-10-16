---
id: AISDLC-874
title: 'fix(decisions): events never land untracked in the parent; the ff step removes copies identical to main'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [decisions, hierarchy, reliability]
dependencies: []
references:
  - pipeline-cli/src/decisions/event-log.ts
  - pipeline-cli/src/decisions/catalog-root.ts
  - scripts/check-orchestrator-state.sh
  - pipeline-cli/src/steps/00-5-sync-parent.ts
  - docs/operations/release-and-plugin-reference.md
priority: high
dispatchable: true
---

## Context

Source: 24h PR-drain review 2026-10-14 (planner + operator). Operator constraint: stability before unsupervised spend — fixes must be deterministic code or settings, spend zero tokens on their own, and never relaunch or drive sessions.

Executors and `cli-decisions` wrote DEC-0212..0218 opened/answered events into the PARENT's `.ai-sdlc/_decisions/events/` (AISDLC-825 behaviour). Those untracked files (a) dirty the parent so Step 0.5 and `check-orchestrator-state` abort ticks, and (b) blocked `git pull --ff-only` the moment the record PR (#1529) landed, because the same paths became tracked ("untracked working tree files would be overwritten"). Event store path resolution is in `pipeline-cli/src/decisions/event-log.ts` and `catalog-root.ts` (there is no single "event store" module; these are the nearest real ones). DEC-0218 defines what dispatch runs for the parent ff; the implementer must read it and cover that path.

## Fix

**Five-step review (requirements first).** Requirement questioned: "events must be written where the CLI runs". In Pattern C the parent is read-only, so the requirement is wrong for the parent. Delete: writes to the parent. Simplify: resolve the store to the active task worktree and refuse otherwise. Accelerate: the ff no longer aborts on paths that already match main. Automate: the ff step removes byte-identical untracked copies itself.

1. `cli-decisions` resolves the event store to the active task worktree (`AI_SDLC_ACTIVE_TASK_ID` / `.active-task`) and refuses (naming the next step) to write into a Pattern-C parent.
2. The parent ff path (`scripts/check-orchestrator-state.sh` and the DEC-0218 dispatch ff step, with `00-5-sync-parent.ts` checked for the same case) deletes an untracked file whose content is byte-identical to the same path on `origin/main` before pulling. A differing untracked file is left alone and reported.
3. Update `docs/operations/release-and-plugin-reference.md`.

## Acceptance Criteria

- [x] #1 Run from a Pattern-C parent with no active task, `cli-decisions add` and `answer` refuse and write nothing.
- [x] #2 With an active task, events land in that task's worktree store.
- [x] #3 An untracked file identical to origin/main is removed and the ff succeeds; an untracked file that differs is not deleted and the step reports it (tests for both).
- [x] #4 Only untracked files are ever deleted; tracked or modified files are never touched, and no hard reset is introduced.
- [x] #5 Docs describe the refusal and the ff cleanup.

## Out of scope

- Changing the event file format or hashing (AISDLC-719).
- Re-deciding the AISDLC-825 behaviour for non-Pattern-C checkouts.
- Cleaning other untracked paths in the parent.
