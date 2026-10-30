---
id: AISDLC-1120
title: 'cli-hierarchy demo: ship the home-page scenario against AISDLC-1106, retire the two scenarios whose tasks are Done, and document that a scenario task is reserved until its demo runs'
status: Done
assignee: []
created_date: '2026-10-30'
labels: [hierarchy, demo, docs]
dependencies: []
references: [pipeline-cli/demo/scenarios/queue-age.json, pipeline-cli/demo/scenarios/context-pressure.json, pipeline-cli/src/hierarchy/demo.test.ts, docs/operations/cli-hierarchy.md, backlog/tasks]
priority: high
dispatchable: true
---

## Description

`cli-hierarchy demo` (AISDLC-1079) drives one real hierarchy run from a scenario file and refuses, at preflight, a scenario whose `task` is not a dispatchable To Do task. Both shipped scenarios are now permanently refused: `context-pressure.json` names AISDLC-1066 and `queue-age.json` names AISDLC-1085, and both tasks landed through the normal flow before any demo ran against them. The consumer, ai-sdlc.io task IO-42 (now split into IO-42 and IO-48 by its DEC-0079), has been blocked on this twice in one week; its wrapper defaults to `pipeline-cli/demo/scenarios/home-page.json`, which does not exist yet.

The root cause is not the scenarios but the missing rule: a scenario pins a task, so that task must be held out of the normal briefs until the demo run consumes it, and a scenario whose task is no longer To Do must be retired rather than left to fail. This task ships the scenario the site needs, removes the two dead ones, and writes the rule down where planners read it.

**Five-step review (requirements first).** Requirement questioned: should the demo accept a Done task and replay its history instead, so scenarios never rot? No: the clip's claim is that the run happened live (the honesty rule of AISDLC-1079), and a replay would make the clip a canned transcript. Deletion: `context-pressure.json` and `queue-age.json` are deleted, with the loader test's references to them. Simplified: one scenario file, named for its consumer (`home-page.json`) rather than for its subject, so the site's wrapper default never changes when the subject does. Accelerated: the planner learns from the docs that a scenario task is reserved before briefing it, instead of the site learning at preflight after a one-hour setup. Automated last: the loader test asserts that every shipped scenario's `task` resolves to a task file under `backlog/tasks/` with `status: To Do` and `dispatchable: true`, so a scenario rots in CI, not in a demo run.

Subject task: AISDLC-1106 (`cli-hierarchy down` with a bare session name is dropped and the call stops the whole hierarchy). It is To Do, dispatchable, has no open PR and no dependencies, and it tells a story a viewer follows in 45 seconds: one wrong spelling took the hierarchy down for 37 minutes. It stays reserved for the demo from the moment this task is filed: no monorepo brief includes AISDLC-1106 until IO-48 has run, and this task's PR body says so.

## Scope

1. Add `pipeline-cli/demo/scenarios/home-page.json`: `request` is one sentence a leader would type (for example "Stop `cli-hierarchy down <name>` from tearing down the whole hierarchy when a session name is given."); `task` and `brief.tasks` are AISDLC-1106; `author` is `dominique`; at least two `decisions` drawn from the real choices in AISDLC-1106's Fix, each with two or three options, an `answer` and a one-line `rationale` (for example: what a bare `down` from a roster session does, refuse with exit 2 versus stop everything as today; teardown order for a full `down`, executors first and planner last versus roster order). `timeoutMinutes` 90, `pollSeconds` 10.
2. Delete `pipeline-cli/demo/scenarios/context-pressure.json` and `pipeline-cli/demo/scenarios/queue-age.json`; update the loader test so it validates every file under `pipeline-cli/demo/scenarios/` and additionally asserts, for each, that `task` names a file under `backlog/tasks/` whose front matter has `status: To Do` and `dispatchable: true`. The test reads the backlog from the repository root; it does not hard-code task ids.
3. In `docs/operations/cli-hierarchy.md`, the `### demo` section gains a short "Scenario tasks are reserved" paragraph: the task a scenario names is held out of every brief until the demo run consumes it (the run is what lands it); when a scenario's task has landed by another path, the scenario is retired in the same PR, and the loader test fails until it is. One sentence names the current scenario and its consumer (ai-sdlc.io, `shorts/scripts/render-demo.mjs`).
4. Out of scope: any change to the demo stages or preflight; running the demo (IO-48 in ai-sdlc.io does that); any change to AISDLC-1106 itself.

## Acceptance Criteria

- [x] `pipeline-cli/demo/scenarios/home-page.json` exists, validates with the loader, names AISDLC-1106 as `task` and in `brief.tasks`, and carries at least two decisions each with at least two options and an `answer` that is one of them.
- [x] `context-pressure.json` and `queue-age.json` are gone from `pipeline-cli/demo/scenarios/`.
- [x] The loader test validates every file under `pipeline-cli/demo/scenarios/` and fails, naming the scenario and the task, when a scenario's `task` is not a `status: To Do`, `dispatchable: true` file under `backlog/tasks/` (test proves the failure with a fixture scenario naming a Done task).
- [x] `docs/operations/cli-hierarchy.md` `### demo` states the reservation rule and the retire-in-the-same-PR rule; `docs-parity.test.ts` passes.
- [x] The PR body states that AISDLC-1106 is reserved for the ai-sdlc.io demo run (IO-48) and is not to be briefed before it.
- [x] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Verification

`pnpm --filter @ai-sdlc/pipeline-cli test` (executor env vars unset): `Test Files  564 passed (564)`, `Tests  12398 passed | 13 skipped (12411)`. Other packages passed in the full `pnpm test`.

## Final Summary

## Summary
Shipped home-page.json (AISDLC-1106, 3 decisions), deleted the two dead scenarios, added a loader test that checks every scenario's task is a To Do, dispatchable task (with a Done-task fixture proving the failure), and documented the reservation and retire-in-the-same-PR rules in `### demo`. A draft PR is open.

## Changes
- pipeline-cli/demo/scenarios/home-page.json
- pipeline-cli/demo/scenarios/context-pressure.json
- pipeline-cli/demo/scenarios/queue-age.json
- pipeline-cli/src/hierarchy/demo.test.ts
- docs/operations/cli-hierarchy.md
- backlog/tasks/AISDLC-1120 - home-page demo scenario against a reserved To Do task.md

## Design decisions
The implementation was already staged in the worktree when I started; I checked it against the ACs and committed it. I re-ran build, lint, format:check and demo.test.ts (23 passed) myself. The full-suite result in the task file and PR body (pipeline-cli test: Test Files 564 passed (564), Tests 12398 passed | 13 skipped (12411)) comes from the staged task-file text, not from a run of mine. The task file status is left at In Progress.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers; review-full)

## Follow-up
(none)

