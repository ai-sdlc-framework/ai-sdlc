---
id: AISDLC-1000
title: 'Executor clear handshake polls until the identity line appears instead of a fixed 8 s settle'
status: Done
assignee: []
created_date: '2026-10-20'
labels:
  - hierarchy
dependencies: []
references:
  - pipeline-cli/src/hierarchy/clear.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - docs/operations/cli-hierarchy.md
priority: low
dispatchable: true
---

## Description

`pipeline-cli/src/hierarchy/clear.ts` sends `/clear`, sleeps the whole `DEFAULT_SETTLE_MS = 8000` (`:39`, `:185`), sends `/ai-sdlc executor`, then polls every 500 ms (`:41`) for the identity line for another 8 s (`:194-197`). When the restarted session takes longer than that to print its identity line, `dispatch-loop.ts:453` reports "degraded: the executor did not report back in time" although the executor recovers on its own moments later. A consumer repo (ai-sdlc-io) saw it on every clear of two executors on 2026-10-20 (three each) with no effect on the drain; this repo's dispatch has seen the same. The only knob is `--settle-ms` on `clear` and `tick` (`cli/hierarchy.ts:686,769`), which a session must remember to pass.

Fix: the first wait polls for the cleared prompt instead of sleeping the full settle, and the second wait polls for the identity line up to a longer ceiling (30 s) that is read from the hierarchy config, not only from a flag. The "degraded" notice is emitted only when the ceiling passes without the identity line, and it names the ceiling and the last pane line seen so the reader can tell a slow start from a dead session.

Out of scope: the relaunch logic and what a dispatch session does after a degraded clear.

**Five-step review (requirements first).**
1. Requirement questioned: does a fixed 8 s sleep carry information? No: the signal is the identity line, so wait for it.
2. Delete: the unconditional sleep before the restart command.
3. Simplify: one poll loop with one ceiling for both waits.
4. Accelerate: a fast executor restarts in under a second instead of after 8 s; a slow one is not reported dead at 8 s.
5. Automate: the ceiling lives in config, so no session passes `--settle-ms` by hand.

## Acceptance Criteria

- [ ] `clear.ts` polls for the cleared prompt and then for the identity line, each up to a configurable ceiling (default 30 s), with no unconditional sleep.
- [ ] The degraded notice appears only when the ceiling passes, and includes the ceiling and the last line seen.
- [ ] Unit tests cover a fast restart (returns before 2 s), a slow restart (returns at 20 s, not degraded) and a dead session (degraded at the ceiling).
- [ ] `docs/operations/cli-hierarchy.md` documents the config key.
