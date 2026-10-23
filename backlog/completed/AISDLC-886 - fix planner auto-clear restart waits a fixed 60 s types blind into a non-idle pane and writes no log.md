---
id: AISDLC-886
title: >-
  fix(hierarchy): planner auto-clear restart waits a fixed 60 s, types blind
  into a non-idle pane with text in the prompt, writes no log, and the handoff
  lands in a stale dated file
status: Done
assignee: []
created_date: '2026-10-14'
labels:
  - hierarchy
  - planner
  - bug
  - velocity
dependencies: []
references:
  - pipeline-cli/src/hierarchy/clear.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/hierarchy/handoff.ts
priority: high
dispatchable: true
drift_log:
  - date: '2026-10-23'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      ai-sdlc-plugin/hooks/context-auto-clear.sh
    resolution: flagged
  - date: '2026-10-23'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      ai-sdlc-plugin/hooks/context-auto-clear.js
    resolution: flagged
drift_checked: '2026-10-23'
---

## Context

Operator report 2026-10-14: "the command /ai-sdlc:planner doesn't run after auto clear". Trace (planner transcripts, two occurrences the same day): the Stop hook schedules `cli-hierarchy auto-clear`, which calls `clearSelf` (`clear.ts:311-394`); that spawns a detached `sh -c` that sleeps 20 s, types `/clear`, sleeps a fixed 60 s (`SELF_CLEAR_RESUME_SECONDS`, `clear.ts:250`, `:367`), then types `/ai-sdlc:planner`. Keys are sent with `tmux send-keys -l` and Enter, with no idle check and no clearing of the input line, so (a) nothing visible happens for a minute and the operator types the command by hand, after which the scheduled one arrives as a duplicate; (b) if a turn is running (a background agent's task notification started one both times), `/clear` and the resume queue behind it for up to minutes; (c) if the operator is mid-message, the text is appended to their prompt and never runs as a command. The hook wrapper sends all output to `/dev/null` (`context-auto-clear.sh:16`) and `clearSelf` never checks that the session came back, so failures are silent. Separately, `writeHandoff` (`handoff.ts:190-198`) writes to the newest existing dated file (`project_planner_handoff_2026_10_10.md` on 10-14), so the post-clear orientation read a file it reported as stale. Dispatch's own clear passes `wakeOnBoardDir` and resumes on a board change (`hierarchy.ts:545-553`); the planner path passes neither `wakeOnBoardDir` nor `resumeAfterSeconds` (`hierarchy.ts:852-863`). No test covers delivery: `clear.test.ts:517-535` asserts only the argv of the detached process.

## Fix

**Five-step review (requirements first).** Requirement questioned: "wait 60 s after /clear before typing the command". No: the only requirement is that the command runs once the pane is idle after the clear; a fixed sleep is a guess at that. Deleted: the fixed 60 s sleep and the blind second `send-keys`. Simplified: one idle-wait primitive shared with `clearExecutor` (which already polls, `clear.ts:193-198`). Accelerated: the planner is back in seconds, not a minute plus queueing. Automated last: a wake-up check that reports when the session did not come back.

1. `clearSelf`: before each `send-keys`, wait until the pane is idle (same predicate `clearExecutor` uses) with a bounded timeout, and clear the input line first (`send-keys C-u` or Escape then C-u) so nothing is appended to operator text; type the resume command as soon as the pane is idle after `/clear`, no fixed sleep.
2. Confirm the session came back (the role command's first output or the roster state) and, if not within the timeout, write a line to the board's `handoff/` log and the hook log instead of silence.
3. `context-auto-clear.sh`: keep a log (`$BOARD_DIR/handoff/auto-clear.log`, appended, rotated at a small size) instead of `/dev/null`; the Node hook prints the decision and the scheduled command.
4. `writeHandoff`: write the file dated today (`project_planner_handoff_YYYY_MM_DD.md`), creating it from the previous dated file's outside-the-markers text so operator notes carry over; update `MEMORY.md`'s pointer.
5. Tests: a fake tmux in `clear.test.ts` that records the sequence (input clear, `/clear`, idle wait, resume command) and a non-idle pane case where the resume is deferred until idle; a `handoff.test.ts` case for the dated-file rollover.

## Acceptance Criteria

- [x] With a running turn in the pane, the resume command is delivered only after the pane is idle (fake-tmux test), never appended to existing prompt text (input is cleared first).
- [x] After `/clear`, `/ai-sdlc:planner` runs within 10 s of the pane becoming idle, with no fixed sleep in the code path (grep for `SELF_CLEAR_RESUME_SECONDS` returns nothing).
- [x] If the session does not come back within the timeout, one line naming the session and the command is written to `handoff/auto-clear.log`; the hook wrapper no longer redirects to `/dev/null`.
- [x] `handoff write --role planner` on 2026-10-15 creates `project_planner_handoff_2026_10_15.md`, carries over the text outside the markers, and `MEMORY.md` points at it.
- [x] `clear.test.ts` covers the delivery sequence and the non-idle case; `pnpm test` passes.

## Verification

`pnpm build && pnpm test && pnpm lint && pnpm format:check`; one real auto-clear of the planner observed to come back without operator typing.

## Out of scope

The executor and dispatch clear paths beyond sharing the idle-wait primitive; the 150k threshold itself.
