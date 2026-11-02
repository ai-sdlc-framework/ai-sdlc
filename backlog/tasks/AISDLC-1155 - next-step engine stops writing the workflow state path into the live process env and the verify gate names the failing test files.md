---
id: AISDLC-1155
title: 'next-step engine stops writing the workflow state path into the live process env, and the verify gate names the failing test files: the env leak behind AISDLC-1153 is closed at its source and a red verify is diagnosable from the verdict'
status: In Progress
assignee: []
created_date: '2026-11-02'
labels:
  - pipeline
  - verify
  - hierarchy
dependencies:
  - AISDLC-1153
references:
  - pipeline-cli/src/workflow/execute-host.ts
  - pipeline-cli/src/cli/attestation.ts
  - pipeline-cli/src/steps/verify-commands.ts
  - pipeline-cli/src/hierarchy/session-env.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

AISDLC-1153 (#2282) unblocked the drain by stripping `AI_SDLC_WORKFLOW_STATE` from the verify gate's child env and from the vitest setup. The leak it papered over is still there: `workflowNextStep` (`pipeline-cli/src/workflow/execute-host.ts` line 662) assigns `ctx.env.AI_SDLC_WORKFLOW_STATE = ctx.statePath`, and `ctx.env` is the live `process.env` in production, so every child the engine spawns afterwards (verify, hooks, `gh`) inherits the state path. Only one consumer needs it: the pre-push signing hook, which reads the run's digest through `cli/attestation.ts` line 530. Seven attestation test files read the same variable through `verifyV6Envelope` and failed under the executor until 1153 stripped it; any future consumer of `process.env` in a verify command would fail the same way, and the strip list would grow again.

The second half is diagnosability. The verify gate (`verify-commands.ts`, `VERIFY_TAIL_LINES = 60`) stores only the last 60 lines of combined output and a one-line summary. With vitest's reporter the tail is the per-file timing table, so a red `pnpm test` names none of the failing files; the planner reproduced 1153's cause by running the suite by hand. Both failures (the five session vars, then the sixth) were misdiagnosed once each for that reason.

**Five-step review (requirements first).**
1. Requirement questioned: must the state path be an ambient env var? Only for the one child that signs, and only for the duration of that push. Everything else is accidental inheritance.
2. Delete: the `process.env` mutation in `workflowNextStep`. The engine passes the state path explicitly in the `env` of the one spawn that needs it (the push whose pre-push hook signs), and the strip-list entry for `AI_SDLC_WORKFLOW_STATE` added by 1153 becomes a regression guard rather than the fix.
3. Simplify: the verify result gains a `failures` list: for a `pnpm test` command, the failing test file paths parsed from the output (vitest `FAIL <path>` / `×` lines and the node --test `not ok` lines); the verdict and the fix-round feedback print that list first, the tail second.
4. Accelerate: a `pnpm test` verify failure now reaches the developer with the file names, so a fix round starts on the right file instead of re-running the suite to find it.
5. Automate: a test that runs `workflowNextStep` with a recording `ctx.env` and asserts the variable is not set on it after the call; a test that feeds a captured vitest failure output through the parser and asserts the file list.

Velocity impact: closes the leak class permanently (no further strip-list growth) and removes a manual reproduce step from every red verify.

## Acceptance Criteria

- [ ] AC-1: `workflowNextStep` no longer assigns to `ctx.env`; the state path reaches the signing hook through the explicit `env` of the push spawn (or an equivalent argument), and `cli/attestation.ts` keeps its env fallback for hand-run signing. A test asserts `ctx.env` is unchanged after `workflowNextStep` returns.
- [ ] AC-2: The 1153 strip list keeps `AI_SDLC_WORKFLOW_STATE`; its comment names this task and says the entry is a guard, not the fix.
- [ ] AC-3: `VerifyCommandResult` gains `failures: string[]` (file paths or test names) filled for `pnpm test` and node `--test` output; the verify verdict and the fix-round instruction render it before the tail. Empty when the command passes or the output has no recognisable failure lines.
- [ ] AC-4: A parser test covers vitest and node --test failure output captured from this repo; a verify-commands test asserts the field is populated on a failing run.
- [ ] AC-5: `docs/operations/cli-hierarchy.md` executor section: the stripped-env paragraph from 1153 gains one sentence that the engine no longer sets the state var ambiently, and the verify section names the `failures` field.

## Notes

Origin: planner correction of 2026-11-02 ~07:30Z (items 2 and 4 of the 1153 re-entry instructions, recorded in `.ai-sdlc/dispatch/briefs/tasks-aisdlc-1153-plus-2.md`); the developer round delivered items 1 and 3 only. Operator go to file 2026-11-02 ~15:50Z. Depends on AISDLC-1153 landing (its strip list is the baseline this task tightens).
