---
id: AISDLC-871
title: 'feat(hierarchy): alert-only stall notice (zero token spend)'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [hierarchy, reliability, feature]
dependencies: []
references:
  - pipeline-cli/src/hierarchy/stall.ts
  - pipeline-cli/src/hierarchy/status.ts
  - pipeline-cli/src/hierarchy/roster.ts
  - pipeline-cli/src/dispatch/board.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Context

Source: 24h PR-drain review 2026-10-14 (planner + operator). Operator constraint: stability before unsupervised spend — fixes must be deterministic code or settings, spend zero tokens on their own, and never relaunch or drive sessions.

The hierarchy was stopped 03:35Z-15:49Z on 2026-10-14 (about 36 executor-hours lost, 0 verdicts for 13h) and nothing noticed. The existing stall check (`pipeline-cli/src/hierarchy/stall.ts`) runs inside the dispatch tick, so it dies with the dispatch session. Nothing outside the hierarchy watches it. Board readers live in `pipeline-cli/src/dispatch/board.ts` (there is no separate reader module for `.ai-sdlc/dispatch`; `board.ts` is the nearest real one), the roster in `pipeline-cli/src/hierarchy/roster.ts`, and status in `pipeline-cli/src/hierarchy/status.ts`.

## Fix

**Five-step review (requirements first).** Requirement questioned: "the hierarchy should heal itself when stalled". That drives relaunch logic, which the operator ruled out for now; the only requirement that is real today is that a human finds out. Delete: any relaunch, message or model path; the watcher is read-only. Simplify: one deterministic check, one notification, one digest line. Accelerate: it runs from launchd/cron outside any Claude session, so it still fires when every session is dead. Automate: a scheduled run replaces the operator noticing by chance.

1. Add a `cli-hierarchy stall-alert` subcommand (new file next to `stall.ts`, reusing the board readers and roster) that reads `.ai-sdlc/dispatch/{queue,inflight,done}` and the roster.
2. When the queue holds eligible work, no verdict landed in `done/` and no inflight claim heartbeat moved for N minutes (default 45, `--minutes` flag), send ONE operator notification: a macOS notification (`osascript`, skipped where unavailable) plus one line appended to `.ai-sdlc/dispatch/planner-digest.md`.
3. De-duplicate: record the alert in a small state file so the same stall alerts once and re-arms only after progress is seen.
4. Document a launchd/cron example (every 10 minutes) in `docs/operations/cli-hierarchy.md`.

## Acceptance Criteria

- [ ] #1 With eligible queued work and no verdict or heartbeat movement for N minutes, one notification and one digest line are produced; a second run for the same stall produces none.
- [ ] #2 With progress (new verdict or moved heartbeat) or an empty queue, nothing is sent.
- [ ] #3 The command never relaunches, never sends keys or messages to a session, and never spawns a model (asserted by a test that stubs the process runner and fails on any call other than the notifier).
- [ ] #4 `--minutes` overrides the default 45; the clock is injected so tests do not sleep.
- [ ] #5 `docs/operations/cli-hierarchy.md` documents the command and a launchd/cron entry.

## Out of scope

- Relaunching, restarting or nudging any session; auto-healing of any kind.
- Changing the in-tick stall handling in `stall.ts`.
- Notification channels other than a macOS notification and the digest line.
