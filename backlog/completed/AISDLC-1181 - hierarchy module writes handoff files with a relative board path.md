---
id: AISDLC-1181
title: 'Hierarchy module writes handoff files with a relative board path that follows the session cwd'
status: Done
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

- [x] AC-1: With `boardDir` undefined and the process cwd set to a subdirectory of the project, `recordReceivedSender` and `writeModuleHealth` write under `<projectDir>/.ai-sdlc/dispatch/handoff/`. A test covers both writers.
- [x] AC-2: No hierarchy module writer passes a relative board path to `process.run`; a test or a single resolver function shared by the writers enforces it.
- [x] AC-3: Existing hierarchy module tests pass unchanged.

## Final Summary

## Summary
Fixed the git-env-hygiene failure in the hierarchy board-dir test. The checker was flagging the `process.env.CLAUDE_PROJECT_DIR` read (reported as line 463/464), not a git spawn. That read is now a destructure: `const { CLAUDE_PROJECT_DIR: prevEnv } = process.env`. I also passed `env: makeGitEnv()`, imported from pipeline-cli's test helper, to the real `git rev-parse` spawn, which scrubs inherited GIT_* variables.

## Changes
- ai-sdlc-plugin/mods/tests/hierarchy.test.ts

## Design decisions
The full `pnpm test`, including `git-env-hygiene:check`, exited 0 after the fix. The branch was rebased onto origin/main (now 3 commits) and pushed with force-with-lease. The PR already existed as #2359. Build, lint and format:check were re-run before the final destructure edit; lint and format:check were re-run after it, build was not.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (246 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

