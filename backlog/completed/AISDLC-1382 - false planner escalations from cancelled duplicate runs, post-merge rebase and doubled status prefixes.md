---
id: AISDLC-1382
title: 'False planner escalations from cancelled duplicate runs, post-merge rebase and doubled status prefixes'
status: Done
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

- [x] #1 A test: a cancelled run plus a newer in-progress run for the same head classifies as pending, not `real-failure`.
- [x] #2 A test: late rebase on a merged PR returns success with the merge sha.
- [x] #3 A test: a status line with a doubled sender prefix classifies as a verdict/status, not unclassified.
- [x] #4 A test: an inflight PR with a live heartbeat and no verdict for its head is not routed to the planner.
- [x] #5 A test: an identical escalation older than the window gets a new file; the tick failure message names exit code or signal and duration.
- [x] #6 A test: the same failed verdict seen on many ticks, with the board held and not held, produces one escalation file; a later verdict with a different head sha or outcome produces one more.
- [x] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
Fixed all six causes of false planner escalations. A cancelled duplicate run with a newer run in progress now classifies as pending. A late rebase on an already-merged PR returns success with the merge sha and pushes nothing. An executor status line with a doubled sender prefix is classified as a verdict. A no-match head on a task the executor still holds is not routed to the planner. An identical escalation older than 1 h gets a new file, and a failed tick's message names its exit code or signal and how long it ran. A failed verdict seen on every tick while the board is held is escalated once. Draft PR #3001 is open.

## Changes
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/hierarchy/pr-state.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/hierarchy/pr-state.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/hierarchy/reconcile.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/hierarchy/reconcile.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/hierarchy/escalation-file.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/hierarchy/escalation-file.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/hierarchy/dispatch-loop.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/hierarchy/dispatch-loop.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/steps/11-late-rebase.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/steps/11-late-rebase.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/steps/land-prep.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/steps/land-prep.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/steps/11-push-and-pr.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/steps/11-push-and-pr.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/pipeline-cli/src/types.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/ai-sdlc-plugin/mods/tests/hierarchy-dispatch.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1382/backlog/tasks/AISDLC-1382 - false planner escalations from cancelled duplicate runs, post-merge rebase and doubled status prefixes.md

## Design decisions
1) After the board is resumed, the playbook still runs for a verdict that was escalated while held, and can send its own escalation (for example 'retries exhausted'). I left that in because it is new information. 2) When the PR has already merged, pushAndPr returns pushed:true with the PR URL, so execute-pipeline treats the run as delivered. Its gh pr ready and arm calls fail on a merged PR, but both are non-fatal. 3) The merged check only runs after the rebase hits a conflict it cannot resolve. It uses 'gh pr view' for the current branch, and if GitHub cannot be read the conflict is reported as before. 4) The scope 'hierarchy' was rejected by commitlint, so the commit uses scope 'pipeline-cli'. 5) The pre-push patch-coverage check reported 94/94 changed lines covered (100%).

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 reviews approved (harness: code-reviewer=claude-code, test-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

