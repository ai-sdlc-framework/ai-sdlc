---
id: AISDLC-1036
title: 'Hierarchy mod phase 3: planner role (rotation with handoff write first, roster-name send wrapper, $.store last reply); delete LAST_MESSAGE.md persistence and the Stop-hook auto-clear'
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - rfc-0058
  - phase-3
  - plugin
  - hierarchy
dependencies:
  - AISDLC-1034
references:
  - spec/rfcs/RFC-0058-session-hierarchy-on-mods.md
  - ai-sdlc-plugin/hooks/context-auto-clear.js
  - ai-sdlc-plugin/commands/planner.md
  - pipeline-cli/src/hierarchy/auto-clear.ts
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

RFC-0058 phase 3 (Signed Off 2026-10-22). The planner role joins the module; the Stop-hook transcript parser and the last-message file are retired.

**Scope.**
1. Planner role in `register.tsx`: `session.measure` rotation at 150k tokens per OQ-1 (handoff write with `--role planner` first, then clear with `$.store`, compact fallback, relaunch last); the last reply of each turn is stored in `$.store` under the roster name and printed by the planner command after a rotation, replacing `LAST_MESSAGE.md`.
2. `session.receive` passes planner-addressed rulings and escalations (including the phase 2 escalation files announced by dispatch) through to the model unchanged and consumes status noise.
3. Roster guard: a send wrapper that refuses a `to` not listed by `cli-hierarchy status` for this project, with the reason; the "only your own roster" rule in the planner command points at the wrapper instead of restating it.
4. Delete `auto-clear.ts`, the `context-auto-clear.js` Stop hook entry and the `LAST_MESSAGE.md` write and read paths (AISDLC-914); the planner and executor commands drop their "print your section of LAST_MESSAGE.md" step.
5. Rotation for the planner never fires mid-turn: the module waits for `turn.complete` of the main thread.

**Five-step review (requirements first).**
1. Requirement questioned: must a Stop hook parse the transcript to know the token count? No; `session.measure` pushes it after every turn.
2. Delete: `auto-clear.ts`, the Stop-hook entry, `LAST_MESSAGE.md` persistence and the command steps that read it.
3. Simplify: one rotation function shared by all three roles, differing only in threshold and handoff role.
4. Accelerate: rotation fires on the pushed measure, not on a hook reading a growing transcript.
5. Automate: `claude plugin test` fixtures for the 150k rotation, the `$.store` last reply round trip and the roster-guard refusal.

## Acceptance Criteria

- [x] At 150k tokens the planner role writes the handoff, then rotates clear > compact > relaunch, and the stored last reply is readable after the clear (tests).
- [x] A send to a name outside this project's roster is refused with a reason naming the roster source (test).
- [x] Planner-addressed rulings and escalations reach the model unchanged; status noise is consumed (tests).
- [x] `auto-clear.ts`, the Stop-hook entry and the `LAST_MESSAGE.md` paths are deleted; no command text still references the file; `pnpm dark-code:check` passes.
- [x] `docs/operations/cli-hierarchy.md` and the planner command describe the module's planner role and the roster wrapper.
