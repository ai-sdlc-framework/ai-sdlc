---
id: AISDLC-1106
title: >-
  cli-hierarchy down: a bare session name is dropped and the call stops the whole hierarchy, killing the dispatch session that ran it (prefer restart)
status: In Progress
assignee: []
created_date: '2026-10-28'
labels:
  - hierarchy
  - dispatch
  - stability
dependencies: []
references:
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/hierarchy/down.ts
  - pipeline-cli/src/hierarchy/restart.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-10-28 at 22:57Z the dispatch session ran the `down` subcommand with a bare executor name (`down ai-sdlc-executor-aisdlc-1101`) to tear down an idle dynamic executor. The `down` case in `pipeline-cli/src/cli/hierarchy.ts` reads only `--role` and silently drops the positional argument, so `hierarchyDown` in `pipeline-cli/src/hierarchy/down.ts` received no target and selected every roster session. It stopped the planner first (clean exit), then typed `/exit` into the dispatch pane it was itself running in, killed that pane after the grace period, and died with it (exit 137). The executors and the scheduler were never reached. The hierarchy ran without a planner or a dispatch session for 37 minutes until the operator relaunched it by hand.

Two defects: (1) a positional target is accepted by `clear`, `restart` and `register` but ignored by `down`, so the most natural spelling of "stop this one session" means "stop everything"; (2) nothing stops a roster session from stopping itself, and nothing orders the planner and dispatch last, so a full teardown issued from inside the hierarchy orphans the executors.

Operator direction (2026-10-28 23:40Z): `restart` is the safer verb inside the hierarchy because the session comes back; `down` is an operator action from outside the roster.

**Five-step review (requirements first).** Requirement questioned: "a dispatch session can stop any session, including the whole hierarchy". Dispatch only ever needs to remove or recycle an executor; a full teardown is an operator action. Deletion: the silent no-target-means-all path when the caller is a roster session (a roster session with no target gets a refusal naming the correct spelling). Simplified: `down` takes the same positional-or-flag target as `clear` and `restart` (one `firstPositional` call, shared with them), so the three verbs read alike. Accelerated: the refusal is immediate, no grace period and no pane polling before the mistake is visible. Automated: `down` and `restart` refuse a target that is the calling session (detected from the roster entry whose pane matches the caller, the same lookup `dispatchCaller` already does), and a full `down` from outside the roster stops executors first and the planner and dispatch last so an interrupted run never orphans the executors.

Fix: in `hierarchy.ts` resolve the `down` target as `firstPositional(argv) ?? flags.role`; when the caller is a roster session (`dispatchCaller`-style lookup) and no target is given, refuse with exit 2 and a message naming `down <name>` and `restart <name>`; in `down.ts` refuse a target equal to the calling session and order the full-teardown list executors first, dispatch second, planner last; in `docs/operations/cli-hierarchy.md` state that inside the hierarchy an idle or stuck executor is recycled with `restart <name>` and that a dynamic executor is removed with `down <name>`, never with a bare `down`; the `operator-dispatch` command prose follows the same wording.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `down <name>` and `down --role <name>` select the same single session (test in `down.test.ts` or the CLI test for `hierarchy.ts`).
- [ ] `down` with no target from a roster session refuses with exit 2 and a message naming `down <name>` and `restart <name>`; from outside the roster it still stops everything (test).
- [ ] `down <name>` and `restart <name>` refuse when `<name>` is the calling session (test).
- [ ] A full `down` stops executors before dispatch and the planner (test asserts the order).
- [ ] `docs/operations/cli-hierarchy.md` and the `operator-dispatch` command prose name `restart <name>` as the in-hierarchy recycle verb and `down <name>` as the dynamic-executor removal verb.
- [ ] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Notes

Evidence: orchestrator events 2026-10-28 (`HierarchySessionStarted` at 22:25Z for planner and dispatch, nothing until the new `up` at 23:34Z); the dispatch transcript's last two entries are the `down` call at 22:57:08Z and its exit 137 at 22:57:32Z; the planner transcript ends cleanly at 22:55Z. The dist rebuilt at 23:35Z behaves the same as the source, so the stale build is not a factor. The tmux session of the targeted dynamic executor was gone afterwards although `down` never reached it; the developer should check whether `up` or the roster rewrite removed it and note the finding in the PR body.

Verification (developer): `pnpm build && pnpm test && pnpm lint && pnpm format:check`. Build, lint and format are clean. `pnpm test`: every suite passes including `pipeline-cli/src/hierarchy/demo.test.ts`, after repointing the demo scenario (which named this task and so failed once it left `To Do`) to AISDLC-1108. The added down tests in `hierarchy.test.ts` (both files) pass.
