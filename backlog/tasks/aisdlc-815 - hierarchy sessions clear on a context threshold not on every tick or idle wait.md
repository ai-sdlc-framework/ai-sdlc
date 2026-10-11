---
id: AISDLC-815
title: >-
  Hierarchy sessions clear on a context threshold, not on every dispatch tick or every idle executor wait
status: To Do
assignee: []
created_date: '2026-10-11'
labels:
  - hierarchy
  - cost
  - rfc-0051
dependencies: []
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - ai-sdlc-plugin/commands/executor.md
  - pipeline-cli/src/hierarchy/
priority: critical
dispatchable: true
---

## Description

Operator instruction 2026-10-11 (Dominique): after the 24-hour usage report (444M weighted units in one day, 29% of the week's use; 640 sessions for 90 tasks) the operator asked that the executor and dispatch self-clear be re-evaluated and bound to a context-token limit instead of a tick.

**Observed.** In the 24 h to 2026-10-11 04:30Z the ledger recorded 292 operator-dispatch sessions and 328 executor sessions. 375 sessions were task-less, main-session-only and under 300k weighted units each: 49M units (11% of the day) spent on nothing but re-reading the fixed prefix (CLAUDE.md, the command body, hooks output, handoff) after a clear. Two rules cause it:

- `operator-dispatch.md` Step 5: "Every wake-up ends with a clear". One clear per tick, 30-minute cadence or faster when woken by messages, so the dispatch session re-orients hundreds of times a day with a context that was rarely above 40k tokens.
- `executor.md` "Nothing eligible": an idle executor runs `cli-hierarchy clear --self --resume-after 30` and re-enters `/ai-sdlc executor`; with five idle executors and an empty queue that is a re-orientation roughly every 30 s per executor.

AISDLC-766 already installed the threshold mechanism (Stop hook clears past 120k tokens for dispatch and executors, 150k for the planner, never mid-task). The per-tick and per-idle clears predate it and are now redundant with it. AISDLC-667.1 (dispatch self-clear after a brief, tick markers) overlaps; this task supersedes its self-clear half.

**Five-step review (requirements first).**
1. Requirement questioned: "clear after every tick / every idle wait" came from the 2026-10-08 token audit (PR #1278), when nothing cleared on a threshold. Set by the operator then; superseded by the same operator now that the threshold hook exists.
2. Delete: the per-tick clear in operator-dispatch.md Step 5 and the idle-wait clear in executor.md. Delete the `--resume-after` idle loop for executors.
3. Simplify: one rule for every role: a session clears when its context passes its role threshold (AISDLC-766 hook), or when its task finishes (executor verdict written, one task per context stays). An idle executor blocks on the queue without a model turn (`cli-dispatch claim --wait` or equivalent long-poll in TypeScript); it does not re-enter the command.
4. Accelerate: not applicable until 2 and 3 land.
5. Automate: the thresholds are already config in `.ai-sdlc/dispatch`; expose them per role if not already, no new mechanism.

Velocity impact: positive. Fewer re-orientations means fewer wasted turns and no change to task throughput.

## Acceptance Criteria

- [ ] AC-1: `operator-dispatch.md` no longer clears at the end of a tick; it ends a tick by sleeping (ScheduleWakeup or waiting for a message) with context intact. The Stop-hook threshold (AISDLC-766) remains the only clear trigger between ticks.
- [ ] AC-2: `executor.md` no longer clears on "nothing eligible"; the executor waits on the queue without a model call (a blocking CLI wait with a long timeout, re-issued by the hook, not by the model) and only clears on verdict or on the threshold.
- [ ] AC-3: The per-role thresholds (planner 150k, dispatch 120k, executor 120k) are read from one config location in `.ai-sdlc/dispatch` and reported by `cli-hierarchy status`.
- [ ] AC-4: Hermetic tests for the two command bodies assert the absence of the per-tick and idle clears (`ai-sdlc-plugin/commands/*.test.mjs`), and a test for the blocking wait path.
- [ ] AC-5: `docs/operations/cli-hierarchy.md` documents the single clear rule and the measurement that motivated it (375 task-less sessions / 49M units in 24 h).
- [ ] AC-6: AISDLC-667.1 is updated to drop its self-clear item and reference this task.

## Notes

Measurement source: `cli-usage report --since 2026-10-10T04:30:00Z --group-by role` and a per-session transcript classification (planner session 2026-10-11). Related: AISDLC-651.2 (cut the fixed prefix), AISDLC-742 (condense CLAUDE.md) reduce the cost of each re-orientation; this task reduces the count.
