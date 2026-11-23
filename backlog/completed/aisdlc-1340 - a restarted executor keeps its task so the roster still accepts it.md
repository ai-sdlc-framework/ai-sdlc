---
id: AISDLC-1340
title: 'A restarted executor keeps its task so the roster still accepts it'
status: Done
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - hierarchy
  - adopter
dependencies: []
references:
  - pipeline-cli/src/hierarchy/restart.ts
  - pipeline-cli/src/hierarchy/hierarchy.test.ts
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to one launch call in the restart code and its tests.'
---

## Description

**Gap.** The dispatch tick starts one executor per task and names it after the task, for example `ai-sdlc-executor-acs-4`. When that executor is later restarted, its roster entry comes back without the task id. The next read of the roster no longer accepts the entry, so `status` warns that it is ignored and the tick stops counting it as a dynamic executor.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-19, task prefix `ACS`, project `amplified-career-site`): `cli-hierarchy status` warned that roster entry `ai-sdlc-executor-acs-4` is ignored because its tmux name is not a default hierarchy name, although dispatch itself had created it. It could not be confirmed from the adopter files that a restart caused that entry; the code path below is read from the source.

**Cause (read from the source).**

- `pipeline-cli/src/hierarchy/spawn.ts:54` and `pipeline-cli/src/hierarchy/validate.ts:35-47` name a dynamic executor `ai-sdlc-executor-<task id lowercase>`, whatever the project or task prefix. `spawn.ts:126` stores the entry with `taskId`.
- `pipeline-cli/src/hierarchy/roster.ts:121-131` accepts an `ai-sdlc-executor-...` name only when the entry carries `taskId`. Without it the entry falls to the default-name check and is refused with "not one of the default hierarchy session names".
- `pipeline-cli/src/hierarchy/restart.ts:287-299` relaunches the session without passing the task, and `restart.ts:310-311` writes back the launched entry as is. The launch drops `taskId` from the entry and also drops `AI_SDLC_EXECUTOR_TASK` from the session environment (`pipeline-cli/src/hierarchy/up.ts:269`).
- The dispatch tick calls the restart for stalled and rotating executors (`pipeline-cli/src/cli/hierarchy.ts:1040`, `:1360`, `:1392`).

**Shape.** Restarting an executor that has a `taskId` keeps it: the new session starts with `AI_SDLC_EXECUTOR_TASK` set to the task, and the new roster entry carries the same `taskId`. The restarted entry passes the roster check. Restarting a standing executor is unchanged.

**Control.** No control changes. The roster name check stays as strict as it is.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: should the roster accept a task-named entry without a task? No; the check is a safety rule and stays. 2. Deleted: nothing; the entry only needs to stop losing a field. 3. Simplified or optimised: pass the existing `taskId` through the launch and copy it onto the new entry, in one place. 4. Accelerated: the executor stays counted and downable after a restart instead of waiting for the orphan sweep. 5. Automated: a test restarts a dynamic executor and reads the roster back.

- **Restart.** Give the launch the entry's `taskId` when it has one, and put it on the entry written back.
- **Tests.** In `hierarchy.test.ts`, restart a dynamic executor with a task other than an `AISDLC` one (for example `ACS-4`) and check the entry, the session environment and a clean roster read.

Out of scope: repairing roster entries already written without a task, changing the executor naming rule, and any change to the roster name check.

## Acceptance Criteria

- [ ] #1 A test restarts a dynamic executor for `ACS-4` and the new roster entry has `taskId` equal to `ACS-4`.
- [ ] #2 The same test reads the roster again and gets no rejected entry for it.
- [ ] #3 The same test checks that the relaunch command sets `AI_SDLC_EXECUTOR_TASK` to `ACS-4`.
- [ ] #4 A test restarts a standing executor and its entry still has no `taskId`.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
