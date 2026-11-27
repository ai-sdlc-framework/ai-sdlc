---
id: AISDLC-1460
title: Session start runs a background knowledge sync when the backend supports it
status: Done
priority: medium
labels:
  - ai-sdlc-plugin
  - hooks
  - knowledge
  - enterprise
dependencies:
  - AISDLC-1459
references:
  - ai-sdlc-plugin/hooks/lib/context-surface.js
  - ai-sdlc-plugin/hooks/context-surface.sh
  - ai-sdlc-plugin/hooks/usage-ingest.js
  - ai-sdlc-plugin/.claude-plugin/plugin.json
---

## Description

**Five-step review (requirements first).**
1. Question: Enterprise N3 (RFC-0002 OQ-J). Operator ruled 2026-11-27 through the decision rubric: DEC-0444 option a, session start only, not every stop: a write already reaches the server at once, so sync only refreshes the local replica, and a per-stop sync would rebuild the whole index after every turn.
2. Delete: the per-stop sync the enterprise asked for (not built).
3. Simplify: in the existing `context-surface.sh sessionStart` path (`plugin.json:46`), when the configured backend is not `files`, start `cli-context sync` detached (never awaited, never blocks the session), at most once per interval using the stamp-file debounce pattern of `usage-ingest.js:30,66-80`; interval from `knowledge.syncIntervalMinutes` in `.ai-sdlc/context.yaml`, default 15 (assumption: reversible default, documented). Print one session-start line from `cli-context status`: queued and rejected counts plus the last sync time and, if any, its error. With the files backend the hook does nothing and prints nothing. Fails open: any error is swallowed after one line.
4. Accelerate: the sync runs detached.
5. Automate: `node --test` hook tests.

## Acceptance Criteria
- [x] #1 A non-files backend triggers one detached `cli-context sync` per interval at session start; a second start inside the interval does not (tests).
- [x] #2 The session-start line shows queued, rejected, last sync time and the last error when present (test).
- [x] #3 The files backend: no spawn, no output (test).
- [x] #4 A failing sync or status never blocks or fails the session start (test).
- [x] #5 `knowledge.syncIntervalMinutes` (default 15) is documented in `docs/operations/knowledge-store.md`.
- [x] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary

The sessionStart context-surface hook now checks the knowledge backend. If it is not `files`, the hook starts a detached `cli-context sync` at most once per `knowledge.syncIntervalMinutes` (default 15, debounced by a stamp file) and shows one `systemMessage` line from `cli-context status`: queued, rejected, last sync time and the last error. The files backend does nothing. Every failure is caught and gives one line at most.

## Changes

- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1460/ai-sdlc-plugin/hooks/lib/knowledge-sync.js
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1460/ai-sdlc-plugin/hooks/lib/knowledge-sync.test.mjs
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1460/ai-sdlc-plugin/hooks/lib/context-surface.js
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1460/ai-sdlc-plugin/hooks/context-surface.js
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1460/ai-sdlc-plugin/plugin.json
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1460/ai-sdlc-plugin/.claude-plugin/plugin.json
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1460/docs/operations/knowledge-store.md
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1460/backlog/tasks/AISDLC-1460 - session start runs a background knowledge sync.md

## Design decisions

The status line is emitted as the hook's `systemMessage`, merged into the existing sessionStart JSON output so stdout stays a single JSON object. The sessionStart context-surface hook timeout went from 5s to 10s in both plugin manifests, because the query (4s cap) and the status read (3s cap) now run back to back. The debounce stamp is `.ai-sdlc/state/knowledge-sync-launch`; that directory is gitignored. The hook reads context.yaml with a minimal line reader that only looks at the direct children of the top-level `knowledge:` block, because the hooks have no YAML dependency. The task file's status change to In Progress is part of the commit.

## Verification

- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)

- 3 reviews approved (harness: code-reviewer=claude-code, test-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up

(none)
