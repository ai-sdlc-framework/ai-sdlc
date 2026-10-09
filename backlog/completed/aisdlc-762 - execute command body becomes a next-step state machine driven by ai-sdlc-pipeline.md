---
id: AISDLC-762
title: >-
  Execute command body becomes a next-step state machine driven by ai-sdlc-pipeline.md
status: Done
assignee: []
created_date: '2026-10-08'
labels:
  - pipeline
  - token-cost
dependencies: []
references:
  - ai-sdlc-plugin/commands/execute.md
  - pipeline-cli/src/steps/
  - pipeline-cli/src/cli/index.ts
  - pipeline-cli/README.md
priority: high
dispatchable: true
updated_date: '2026-10-09 23:42'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

execute.md is 2,041 lines (142 KB, about 35k tokens loaded per executor session); about 1,300 lines re-narrate steps that pipeline-cli/src/steps already implements. A task costs about 160 LLM round-trips of orchestration (about $29 API weight) against about $25 of developer and reviewer work. Full evidence: `docs/audits/2026-10-08-token-leak-loop-and-prose-automation-audit.md`.

## Scope

1. Add `ai-sdlc-pipeline next-step --task <id> --state <file>` that runs every deterministic step itself and returns a small JSON instruction only when an LLM action is needed (spawn developer with prompt file X; spawn reviewer set Y with prompt files; iterate; done with PR url).
2. The slash body becomes a loop of: call next-step, perform the one instruction, report the result, in under 250 lines.
3. The review-prepare and review-finalize wrappers (classifier gate, incremental-review gate, leaf emission, transcript persistence) are part of this.

Sequencing: none, but AISDLC-761 is cheaper to land first (related: AISDLC-761).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] AC-1: execute.md is 250 lines or fewer.
- [x] AC-2: One task run makes 15 or fewer orchestration LLM calls plus the agents.
- [x] AC-3: Step tests cover the state machine.
- [x] AC-4: Attestation and governance behaviour are unchanged; existing verify tests pass.
<!-- AC:END -->

## Final Summary

## Summary
Added `ai-sdlc-pipeline next-step`, a TypeScript state machine that runs the deterministic Steps 0-15 (validate, worktree, review-prepare/finalize wrappers, rebase, signing, push, draft PR, ready, cleanup) and returns one JSON instruction only when an agent call is needed. `execute.md` shrank from 2,041 to ~122 lines and is now a loop over it.

## Changes
- `pipeline-cli/src/next-step/*` (new): state machine, init, review-prepare, review-finalize, ship, task-done, gh-issue, session, args, types.
- `pipeline-cli/src/cli/next-step.ts`, `cli/index.ts` (new/modified): CLI wiring.
- `ai-sdlc-plugin/commands/execute.md` (modified): short loop body; agent output passed via `--result <file>`.
- Tests: `next-step/*.test.ts`, `execute.test.mjs`, `heartbeat.test.mjs`.

## Design decisions
- **Governance in code**: hard rules stay in execute.md; ship.ts never force-pushes or merges (tested).
- **Round-2 fixes**: Step 10.6 signer receives iteration/harness env; throws route through fail() with sentinel cleanup; empty staged diff skips chore commit; heredoc end-marker removed.

## Verification
- `pnpm build` — clean
- `pnpm test` — next-step vitest 182/182; two pre-existing plugin command tests fail on untouched files
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up
declined: raise plugin runtimeDependencies floor for @ai-sdlc/pipeline-cli once a release containing `next-step` exists (version comes from release-please).
