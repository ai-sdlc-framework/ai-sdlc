---
id: AISDLC-1382
title: 'False planner escalations from cancelled duplicate runs, post-merge rebase and doubled status prefixes'
status: To Do
assignee: []
created_date: '2026-11-22'
labels:
  - bug
  - hierarchy
  - pipeline-cli
dependencies: []
references:
  - pipeline-cli/src/hierarchy/pr-state.ts
  - pipeline-cli/src/steps/11-late-rebase.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - pipeline-cli/src/hierarchy/escalation-file.ts
priority: medium
---

## Description

**Gap.** On 2026-11-22 the planner received six escalations in an hour that needed no action. Each costs a planner turn.

**Observed.**

1. **Cancelled duplicate gate runs counted as failures.** PR #2919 head 746e5000 got two `AI-SDLC PR Ready Gate` runs at 00:54:38Z; 44968906316 was cancelled by concurrency while 44968907253 was in progress. The reconciler routed "reenter failed x2" to the planner. PR #2917 (head 6896479d) had the same pair, one success, one failure. In `pr-state.ts:216-218` a failed `ai-sdlc/pr-ready` returns `real-failure` before the `cancelled-or-infra` check at `:219`, and the check list includes the cancelled run's rollup.
2. **Late rebase after the PR merged.** AISDLC-1374's executor reported `failed (rebase-conflict)`: Step 10.5 (`11-late-rebase.ts`) rebased onto a main that already held its own squash commit `cd53eb237` (PR #2919 merged at 746e5000), and conflicted on its own task file. Dispatch later retired it as landed.
3. **Unclassified executor status lines.** `dispatch.ts:550` escalated `ai-sdlc-executor-aisdlc-1374: AISDLC-1374 success, PR 2919, decisions none` (sender name repeated in the text) as "unclassified message"; the verdict itself was recorded.
4. **No-match while the executor is mid-round.** PR #2915 (AISDLC-1373) head a79a41fd was routed `no-match` to the planner while its executor was live (`inflight/AISDLC-1373.state.json` phase `awaiting-developer`, fresh heartbeat) and review had not yet written a verdict for the new head (`ai-sdlc/attestation`: "no verdict ref for this head").
5. **Live tick failure announced with a stale file.** `dispatch.ts:392` escalates `cli-hierarchy tick did not return a result: ` (empty output, the tick failed under load average 20+), and `writeEscalationFile` (`escalation-file.ts:58-82`, AISDLC-1200) returns the oldest identical file, `TICK-1793415154023.json` from 2026-10-30, so the planner sees a month-old createdAt and an empty message for a live failure. The escalations folder holds 5,096 files, 737 of them `TICK-*`.
6. **One escalation file per tick for the same failed verdict while the board is held.** Reported by the enterprise planner on 2026-11-25: with the board held, dispatch wrote a new file in `.ai-sdlc/dispatch/escalations/` for the same failed verdict of ENT-5 on every tick, 33+ files in about 15 minutes. Holding the board stops claims, not the failed-verdict escalation, so each tick re-escalates a failure the planner already has.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the planner must hear about failures that need a decision, not states the machine resolves. 2. Deleted: the three false routes. 3. Simplified: classify on the newest run per workflow per head. 4. Accelerated: none. 5. Automated: one regression test per shape.

- `pr-state.ts`: when several runs of the same workflow exist for one head sha, use only the newest; a cancelled run superseded by a newer one is ignored, and an in-progress newer run means `pending`.
- `11-late-rebase.ts`: before rebasing, check whether the PR is merged (or main already contains the PR's head tree); if so return success with the merge sha, not `rebase-conflict`.
- `dispatch.ts` classifier: strip a leading `<sender>:` prefix (repeated or not) before matching the status tables.
- Reconciler: a PR whose task is inflight with a live heartbeat and no verdict for the current head is `pending` (owner executor), not `no-match`.
- Tick escalation: capture the exit code, signal and duration of the failed tick in the message (empty stderr says nothing); `writeEscalationFile` dedup reuses a file only within `ESCALATION_NOTIFY_WINDOW_MS`, otherwise writes a new one.
- Failed-verdict escalation: key it on task id plus the verdict (its head sha and outcome). A key already escalated writes no new file on a later tick, whether or not the board is held; a new verdict for the task escalates once.

## Acceptance Criteria

- [ ] #1 A test: a cancelled run plus a newer in-progress run for the same head classifies as pending, not `real-failure`.
- [ ] #2 A test: late rebase on a merged PR returns success with the merge sha.
- [ ] #3 A test: a status line with a doubled sender prefix classifies as a verdict/status, not unclassified.
- [ ] #4 A test: an inflight PR with a live heartbeat and no verdict for its head is not routed to the planner.
- [ ] #5 A test: an identical escalation older than the window gets a new file; the tick failure message names exit code or signal and duration.
- [ ] #6 A test: the same failed verdict seen on many ticks, with the board held and not held, produces one escalation file; a later verdict with a different head sha or outcome produces one more.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
