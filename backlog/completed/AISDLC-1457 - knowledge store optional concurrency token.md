---
id: AISDLC-1457
title: Knowledge store reads and writes carry an optional concurrency token
status: Done
priority: medium
labels:
  - pipeline-cli
  - knowledge
  - enterprise
dependencies:
  - AISDLC-1456
references:
  - pipeline-cli/src/knowledge/knowledge-store.ts
  - pipeline-cli/src/knowledge/human.ts
  - pipeline-cli/src/knowledge/promote.ts
---

## Description

**Five-step review (requirements first).**
1. Question: DEC-0443 option a (operator, 2026-11-27) includes the enterprise's optional opaque concurrency token: two sessions editing the same entry on a shared server must not silently overwrite each other.
2. Delete: nothing.
3. Simplify: `StoredEntry` gains `version?: string` (opaque); `WriteResult` gains `version?: string`; `write` accepts `expectedVersion?: string`. A backend that supports it returns `status: 'conflict'` (add to the status union) when `expectedVersion` does not match. The files backend may ignore the token (returns no `version`, never `conflict`). The core write helpers in `human.ts` and `promote.ts` pass the version they read; on `conflict` they re-read the entry, re-run their own decision and retry, at most 3 attempts in total, then fail with the conflict reported.
4. Accelerate: none.
5. Automate: a test backend that returns `conflict` once proves the re-read and retry; a second that always conflicts proves the bounded failure.

## Acceptance Criteria
- [x] #1 `version`, `expectedVersion` and the `conflict` status exist and are documented as optional for backends.
- [x] #2 Helpers re-read, re-run and retry on `conflict`, max 3 attempts, then fail with the conflict (tests with a stub backend).
- [x] #3 The files backend's behaviour is unchanged (no version, never conflict).
- [x] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary

Knowledge-store entries and write results can now carry an optional opaque version, `write` takes an optional `expectedVersion`, and a backend can answer `status: 'conflict'`. The six core write helpers (confirm, correct, supersede, promote, reobserve, refute) pass the version they read. On a conflict they re-read the entry, recompute the change and retry, up to 3 attempts in total, then return the conflict. The files backend ignores the token, so its behaviour is unchanged.

## Changes

- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1457/pipeline-cli/src/knowledge/knowledge-store.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1457/pipeline-cli/src/knowledge/human.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1457/pipeline-cli/src/knowledge/promote.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1457/pipeline-cli/src/knowledge/index.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1457/pipeline-cli/src/knowledge/ingest-write.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1457/pipeline-cli/src/cli/context.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1457/pipeline-cli/src/knowledge/knowledge-store-conflict.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1457/backlog/tasks/AISDLC-1457 - knowledge store optional concurrency token.md

## Design decisions

1) `expectedVersion` is passed in the write options (a new `WriteOptions` type), not in the `WriteOp` operation itself. 2) The retry loop lives in one shared function, `retryOnConflict`, in knowledge-store.ts. 3) Two changes go slightly beyond the listed files so a conflict is never reported as success: the CLI's `reportWrite` prints `conflict: &lt;reason&gt;` and exits 1, and `countIngestWrite` counts a conflict as rejected instead of updated. 4) The commit includes the orchestrator's claim edit to the task file (status To Do to In Progress). 5) Full build, test, lint and format:check passed locally; the pre-push patch-coverage check showed 100%.

## Verification

- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (rejected: canonical requires a human; agent role refused)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)

- 2 reviews approved (harness: correctness-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up

(none)
