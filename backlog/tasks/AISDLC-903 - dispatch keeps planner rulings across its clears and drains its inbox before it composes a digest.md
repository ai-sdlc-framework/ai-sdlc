---
id: AISDLC-903
title: 'fix: dispatch keeps planner rulings across its clears and drains its inbox before it composes a digest'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [hierarchy, dispatch, velocity]
references: [ai-sdlc-plugin/commands/operator-dispatch.md, pipeline-cli/src/hierarchy/handoff.ts, pipeline-cli/src/cli/dispatch.ts]
priority: high
dispatchable: true
---

## Description

During the night of 2026-10-14/15 the dispatch session asked the planner the same question four times in a row ("PRs X, Y, Z are red on Build & Test for a shared cause; is there a main-side fix or should I resume?") although the planner had answered it after the first digest, with the fix task named and the hold instruction given. Each re-ask cost a planner turn and, twice, led dispatch to resume tasks the planner had told it to hold. Two mechanisms are missing:

1. A ruling the planner sends by message lives only in dispatch's context. Dispatch self-clears after every tick (`operator-dispatch.md` Step 5), so the ruling is gone before the next tick, and nothing in the regenerated dispatch handoff carries it. Dispatch's next tick re-derives "red PR, unknown cause, ask the planner".
2. Dispatch composes and sends its digest at the start of a wake-up, before it reads the messages that arrived while it slept. The planner's answer to digest N is read only after digest N+1 is already sent, so every answer looks one tick late and the same item is re-reported.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that a planner ruling needs a human-readable message at all. The ruling is operational state about a task or PR ("held until task T lands", "fix round, note N", "not a bug, rerun after T"); state belongs on the board, where the tick reads it, not in a chat message that a clear erases. 2. Deleted: nothing in the CLI; the re-ask loop itself is what goes away. The prose step "ask the planner when a red PR has no classifier match" is replaced by "look up the board ruling first". 3. Simplified: one new board field, `ruling`, on a queue/failed/done manifest (`{ text, by, at, until?: <task-id> }`), written by `cli-dispatch rule <task> --text ... [--until <task-id>]`, and the tick reports a red PR as `held: <ruling.text>` instead of `route-to-planner` while the ruling's `until` task is not on main. The planner's reply becomes one CLI command instead of a message dispatch must remember. 4. Accelerated: `operator-dispatch.md` Step 2 drains the inbox (reads every pending message and applies any ruling it contains by running the `rule` command) BEFORE it runs the tick and composes the digest, so answers land in the same wake-up they arrive in. 5. Automated: the dispatch handoff (`handoff.ts`, role `operator-dispatch`) renders a "Rulings in force" section from the board's `ruling` fields, so even a cleared dispatch sees them without any message, and the digest never lists an item whose ruling is still in force.

## Acceptance Criteria

- [ ] `cli-dispatch rule <task-id> --text "<ruling>" [--until <task-id>] [--by <name>]` writes a `ruling` object onto the task's manifest in `queue/`, `failed/` or `done/` and refuses on `inflight/`; `cli-dispatch rule <task-id> --clear` removes it. Tests cover all four locations.
- [ ] The tick's PR classification reports a red or no-match PR whose task carries a ruling as `held` with the ruling text, not as `route-to-planner` or `real-failure`; when `until` is set and that task's PR has merged, the tick clears the ruling and reports the task as `ready-to-requeue`. Tests cover both branches.
- [ ] `handoff write --role operator-dispatch` renders a "Rulings in force" section listing every task with a ruling (`task, text, until, by, at`); `handoff read` shows it. Test covers an empty and a populated board.
- [ ] `ai-sdlc-plugin/commands/operator-dispatch.md` Step 2 begins with "drain the inbox: read every pending message; apply each ruling it carries with `cli-dispatch rule` before the tick"; Step 3 says the digest never repeats an item that carries a ruling in force. The command's test (`operator-dispatch.test.mjs`) asserts both sentences.
- [ ] `docs/operations/cli-hierarchy.md` documents the `rule` command and the held classification in one short section.
- [ ] Task file moved to `backlog/completed/` in the PR.
