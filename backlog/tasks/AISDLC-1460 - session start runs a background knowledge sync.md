---
id: AISDLC-1460
title: Session start runs a background knowledge sync when the backend supports it
status: To Do
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
- [ ] #1 A non-files backend triggers one detached `cli-context sync` per interval at session start; a second start inside the interval does not (tests).
- [ ] #2 The session-start line shows queued, rejected, last sync time and the last error when present (test).
- [ ] #3 The files backend: no spawn, no output (test).
- [ ] #4 A failing sync or status never blocks or fails the session start (test).
- [ ] #5 `knowledge.syncIntervalMinutes` (default 15) is documented in `docs/operations/knowledge-store.md`.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
