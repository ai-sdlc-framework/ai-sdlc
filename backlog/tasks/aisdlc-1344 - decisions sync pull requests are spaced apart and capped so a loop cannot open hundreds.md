---
id: AISDLC-1344
title: 'Decisions sync pull requests are spaced apart and capped, so a loop cannot open hundreds'
status: To Do
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - hierarchy
  - decisions
  - adopter
dependencies: []
references:
  - pipeline-cli/src/decisions/remote-persist.ts
  - pipeline-cli/src/decisions/remote-persist.test.ts
  - pipeline-cli/src/decisions/decisions-config.ts
  - pipeline-cli/src/decisions/event-log.ts
  - pipeline-cli/src/hierarchy/escalation-file.ts
priority: high
dispatchable: true
dispatchableReason: 'Bounded to the sync pull request path, one config key pair, one write-time check and their tests.'
---

## Description

**Gap.** Every batch of decision events is sent as a pull request on the branch `ai-sdlc/decisions-sync`. The only rule is that one such pull request may be open at a time. There is no minimum gap between two of them, no ceiling per day and no alarm. Each costs a CI run and a merge, so any fault that writes events in a loop turns into a flood of pull requests.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-19, project `amplified-career-site`): about 240 sync pull requests (#7 to #250) in 13 hours, each with one file and each opened about 20 seconds after the previous one merged. Nobody was told. The cause of that loop is the subject of the task that makes promotion read merged events; this task limits the damage of any such loop.

**Cause (read from the source).**

- `persistDecisionLog` (`pipeline-cli/src/decisions/remote-persist.ts:363-497`) pushes the ledger to the sync branch and then calls `openSyncPr` (`remote-persist.ts:499-528`). `openSyncPr` lists open pull requests on that branch, reuses one if there is one, and otherwise creates one.
- The reconciler arms the pull request for merge (`pipeline-cli/src/hierarchy/reconcile.ts:504-520`).
- Nothing in either place looks at how long ago the last sync pull request was opened, or how many were opened today.
- Nothing refuses a `routing-changed` event that repeats the same `from` and `to` tier for one decision (`makeRoutingChangedEvent`, `pipeline-cli/src/decisions/event-log.ts:573-586`).

**Shape.** Sync pull requests are spaced and capped. Events written inside the gap wait locally and on the branch and go out in the next pull request, so nothing is dropped. When the daily ceiling is reached, dispatch stops opening sync pull requests and reports that once to the planner through an escalation file, never silently. A `routing-changed` event with the same `from` and `to` tier as the decision's latest one is refused at write time.

**Open question for the operator (not decided here).** The interval and the daily ceiling. Proposal only: a minimum interval of 15 minutes and a ceiling of 24 sync pull requests per day, both configurable. The operator may choose other values; the task does not fix them.

**Control.** No control changes to who may merge a sync pull request. The change adds a limit on opening them and a write-time refusal of an exact repeat. Both only tighten.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must every event travel in its own pull request the moment it is written? No; the ledger is append-only and a short delay loses nothing. 2. Deleted: the one-event-one-pull-request habit, not any event. 3. Simplified or optimised: one check on the open path, reading a stored time and a count, instead of a new scheduler. 4. Accelerated: a loop is cut at the ceiling in a day at most, not left to run for 13 hours. 5. Automated: tests drive the open path with a fake clock and a fake `gh`.

- **Spacing.** In `persistDecisionLog`, when the last sync pull request was opened less than the configured interval ago, push the branch but do not open a new pull request; the next call after the interval opens one that carries everything waiting.
- **Ceiling.** Count sync pull requests opened per day; at the ceiling, stop opening them and write one escalation file for the planner (`pipeline-cli/src/hierarchy/escalation-file.ts`). Report it once per day, not per tick.
- **Config.** Add the interval and the ceiling to `pipeline-cli/src/decisions/decisions-config.ts`, with the proposed values above as the defaults until the operator answers.
- **Repeat refusal.** Refuse to append a `routing-changed` event whose `fromTier` and `toTier` equal those of the decision's latest `routing-changed` event.
- **Tests.** In `remote-persist.test.ts`, cover the gap, the ceiling, the single report and the carry into the next pull request. Add a case for the repeat refusal next to the event log tests.

Out of scope: the cause of any particular loop, the webhook health decision, the merge path of sync pull requests, and cleaning up pull requests already opened.

## Acceptance Criteria

- [ ] #1 A test shows a second `persistDecisionLog` inside the interval pushes the branch and opens no pull request.
- [ ] #2 A test shows the first call after the interval opens one pull request that holds the events written during the gap.
- [ ] #3 A test shows that at the daily ceiling no pull request is opened and exactly one escalation file is written for that day.
- [ ] #4 A test shows a `routing-changed` event with the same `from` and `to` tier as the latest one is refused at write time, and a different tier is accepted.
- [ ] #5 The interval and ceiling are read from the decisions config, and a test shows a configured value replaces the default.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
