---
id: AISDLC-1319
title: 'Budget pacer lifts its hold when usage is back inside the margin and status shows the hold'
status: To Do
assignee: []
created_date: '2026-11-18'
labels:
  - hierarchy
  - budget-pacer
dependencies: []
references:
  - pipeline-cli/src/hierarchy/budget.ts
  - pipeline-cli/src/hierarchy/budget.test.ts
  - pipeline-cli/src/hierarchy/executor-cap.ts
  - pipeline-cli/src/hierarchy/executor-cap.test.ts
  - pipeline-cli/src/hierarchy/hold.ts
  - pipeline-cli/src/hierarchy/status.ts
  - pipeline-cli/src/hierarchy/hierarchy.test.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.test.ts
  - pipeline-cli/src/hierarchy/drain-stall.ts
  - pipeline-cli/src/hierarchy/executor-start.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
dispatchableReason: "Operator order of 2026-11-18: 'file the task for the pacer hold'."
---

## Description

**Gap.** A hold set by the budget pacer stopped every claim for about six hours and 47 minutes on 2026-11-17/18 while usage was back inside the margin, and `cli-hierarchy status` did not say the board was held.

What was seen (board `.ai-sdlc/dispatch`):

- The pacer wrote `.hold` at 2026-11-17T20:30:16Z: `budget: sevenDay 3% is 2 points above the line 1% (margin 2)`, `by: pacer`. `hold-events.jsonl` then has a run of `hold` events with the same `since` and the reason counting down to `sevenDay 4% is 2 points above the line 2%`.
- At 2026-11-18T03:16Z `status` printed `BUDGET 7d 6% (line 4.9%, ahead 1.1 points)`: inside the margin of 2. `.hold` was still there, `usage.json` was fresh, 11 tasks were queued, none inflight, and nothing had been claimed since about 21:13Z.
- `status` printed `EXECUTOR CAP 1 (... limited by pacer allowance)` and no line about a hold. The hold was visible only in the idle executor's pane (`BOARD HELD: budget: ...`).
- The planner ran `cli-hierarchy resume` at 03:17:08Z. A task was claimed within a minute and the pacer did not set the hold again.
- It happened again the same day: the pacer set a hold at 04:04:17Z (`sevenDay 8% is 2.6 points above the line 5.4%`) and lifted it itself at 13:28:49Z, nine hours and 24 minutes later.

**Cause (read from the source).** The hold is set and lifted at two different points, by design:

- Set: a window is over when `p.ahead > p.margin` (`pipeline-cli/src/hierarchy/budget.ts:393`).
- Lift: only when every window is under the line by more than the margin, `paces.every((p) => p.ahead < -p.margin)` (`budget.ts:412`). Between the two the hold stays. The file header (`budget.ts:6-9`), `docs/operations/cli-hierarchy.md` (section `usage`: "between the two the hold stays as it is") and the test "keeps the hold between the margins" (`budget.test.ts:142`) all state this.

The seven-day line rises 100 points in 168 hours, about 0.6 points an hour. With the default margin of 2 the hold must cross a band of 4 points, so every seven-day hold lasts at least 6.7 hours with no use at all, and longer when other sessions use the account. That is the six to nine hours seen.

The executor cap contradicts it. `pacerAllowance` gives 0 over the line, 1 inside the band and no limit when clearly behind (`executor-cap.ts:43-49`), and the runbook says the same. After a hold, the state "one executor inside the band" cannot be reached, because the hold refuses every claim until usage is under the band. `status` printed cap 1 while no claim was possible.

**Why nothing alerted.**

- `status` has no line for a board hold: `status.ts` never reads `.hold`. Its `held:` lines are tasks waiting on a dependency (AISDLC-1244).
- The drain-stall detector is silent while the board is held, by design (`drain-stall.ts:157-159`, `!deps.held`). The unchanged counts in `drain-stall.json` are the expected result, not a second defect.
- The tick reports `budget pacer: board held (...)` once when the hold is set (`dispatch-loop.ts:1194-1195`) and puts `held: <reason>` in `blockers` (`dispatch-loop.ts:404`). Whether those reached the planner that night was not checked.
- Whether `cli-hierarchy stall-notice` ran that night was not determined; `stall-digest.log` has no "Drain stalled" line for it. It is not part of this task.

**The executor.** `executor-start` under a hold claims nothing, prints `BOARD HELD: <reason>` and returns `taskId: null` (`executor-start.ts:181-189`). The tick reports `holdLifted` on the first tick after a hold is gone (`dispatch-loop.ts:1085`) and the hooks module then wakes idle executors (runbook, section `hold`). The executor that sat idle for 6 h 48 m behaved as designed; it was the hold that was late. No change to the executor.

**Shape.** The pacer lifts its own hold on the first tick where no window is above its line by more than its margin. Inside the band the existing cap of one executor paces the drain. `status` names an active hold.

**Control.** The point at which the hold is set, the margins and the override do not change. The point at which the hold is lifted moves from "under the line minus the margin" to "not above the line plus the margin", which is where the executor cap already says one executor may run.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: is the second, lower lift point needed? It was there to stop the hold from being set and lifted in turn. The executor cap, added later (AISDLC-1076), already does that job inside the band by allowing one executor, and a hold blocks only new claims, so a hold that is set and lifted in turn costs nothing but log lines. The lower lift point costs 6.7 hours of drain per hold at the least. 2. Deleted: the lift condition `ahead < -margin`. 3. Simplified or optimised: one rule, the hold exists exactly while a window is over; `runBudgetPacer` and `pacerAllowance` then agree. 4. Accelerated: the drain restarts on the first tick inside the margin. 5. Automated: the lift is already in the tick; no new process.

- **Lift rule.** In `runBudgetPacer` (`budget.ts`), when a `budget` hold exists and no window that is not overridden has `ahead > margin`, clear the hold. Leave line 393 (the set rule), `resolveMargins`, `overrideBudget` and the rule that a hold set by anything else is never touched as they are.
- **Resume event.** The `resume` event the pacer logs carries `by: "pacer"` and the reading of each window at the lift (utilization, line, ahead, margin), beside the reason of the hold it lifts. Add the reading as a field of the event; do not change `clearHold` for other callers beyond an optional argument.
- **Tests.** Replace the test "keeps the hold between the margins" (`budget.test.ts:142`) with one that sets the hold at more than 2 points over, then on a later tick with usage inside the margin expects the hold gone, `lifted` returned and a `resume` event by `pacer` in `hold-events.jsonl`. Keep a test that the hold stays while a window is still over. Add a tick test: on the tick where the pacer lifts, the result has `holdLifted: true`.
- **Status line.** `status` reads `.hold` and, when it exists, prints one line: `HOLD by <by> since <since>: <reason>`. The JSON form of `status` carries the same three fields. Place the line beside the `BUDGET` and `EXECUTOR CAP` lines in both branches of `formatStatus`.
- **Docs.** In `docs/operations/cli-hierarchy.md`: the lift rule in section `usage`, the `HOLD` line in the description of `status`, and the comment at the top of `budget.ts`. Update the header comment of `executor-cap.ts` only if it no longer reads true.
- **Stop rule.** If a test shows the hold being set and lifted more than once per usage sample (5 minutes) under a steady reading, stop and report in the verdict notes; do not add a second threshold.

Out of scope: the margins and their defaults; `budget-override.json`; the priority floor; the drain-stall detector and `stall-notice`; the executor loop; any file under `.ai-sdlc/`. Also out of scope: the `by: "unresolved"` on the planner's `resume` event of 03:17:08Z. It comes from caller resolution (`cli/hierarchy.ts:1121`, `caller-identity.ts`), which returns nothing for a shell that is not matched to a roster session; that is not a cheap change and is not made here.

## Acceptance Criteria

- [ ] #1 A unit test in `budget.test.ts` sets a `budget` hold with a window more than its margin above the line, then runs the pacer with every window at or inside its margin and finds no `.hold`, `lifted` in the outcome, and a `resume` event with `by: "pacer"` in `hold-events.jsonl`.
- [ ] #2 That `resume` event carries the utilization, line, ahead and margin of each window at the lift.
- [ ] #3 A unit test shows the hold stays while any window that is not overridden is above its line by more than its margin, and that a hold not set by the pacer is not lifted.
- [ ] #4 The condition that sets the hold (`p.ahead > p.margin`), `DEFAULT_SEVEN_DAY_MARGIN`, `DEFAULT_FIVE_HOUR_MARGIN` and `pacerAllowance` are unchanged in the diff.
- [ ] #5 A test of `runDispatchTick` shows `holdLifted: true` on the tick where the pacer lifts its hold.
- [ ] #6 With a `.hold` file on the board, `cli-hierarchy status` prints exactly one line that starts with `HOLD` and names who set it, since when and the reason; with no `.hold` it prints no such line; the JSON output carries the same fields. A test covers both cases.
- [ ] #7 `docs/operations/cli-hierarchy.md` states the new lift rule and the `HOLD` line, and no longer says the hold stays between the two margins.
- [ ] #8 The diff changes no file under `.ai-sdlc/` and at most 10 files.
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
