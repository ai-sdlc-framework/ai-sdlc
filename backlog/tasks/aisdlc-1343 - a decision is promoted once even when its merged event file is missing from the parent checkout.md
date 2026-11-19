---
id: AISDLC-1343
title: 'A decision is promoted once, even when its merged event file is missing from the parent checkout'
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
  - pipeline-cli/src/decisions/escalation-chain.ts
  - pipeline-cli/src/decisions/escalation-chain-promote.test.ts
  - pipeline-cli/src/decisions/projection.ts
  - pipeline-cli/src/steps/00-5-sync-parent.ts
  - pipeline-cli/src/steps/00-5-sync-parent.test.ts
priority: high
dispatchable: true
dispatchableReason: 'Bounded to the promotion read, one Step 0.5 cleanup rule and their tests.'
---

## Description

**Gap.** An escalated decision moves up one tier when its timebox lapses, and each move is written as a `routing-changed` event. If the file of a move that already merged is missing from the parent checkout, the decision looks as if it never moved. The next tick moves it again and writes a new event. Each new event goes into its own sync pull request, which merges, which removes the local copy, which starts the next round. Nothing stops the loop.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-19, project `amplified-career-site`): decision DEC-0001 ("Webhook health down: receiver process is not running") got a `routing-changed` event about every 2.5 minutes from 02:20Z to 15:27Z. Each event became its own `chore(decisions): sync decision catalog event log` pull request with one file, and each merged itself: about 240 pull requests (#7 to #250), each opened about 20 seconds after the previous one merged. The local `main` ended 237 commits behind.

**Cause (read from the source).** The loop is inferred from the code; there was no access to the adopter checkout to confirm the missing HEAD move.

- `promoteExpiredDecisions` (`pipeline-cli/src/decisions/escalation-chain.ts:391-427`) is the only writer of `routing-changed`. The dispatch tick calls it through `promoteExpired` (`pipeline-cli/src/hierarchy/dispatch-loop.ts:1310-1313`, wired at `pipeline-cli/src/cli/hierarchy.ts:1605-1617`).
- `findDueDecisions` (`escalation-chain.ts:319-336`) takes the tier and the time it was entered from `tierEnteredAt` (`escalation-chain.ts:298-304`), which reads the last `routing-changed` event of the decision. Those events come only from local files (`listDecisions` in `pipeline-cli/src/decisions/projection.ts:312`, `readDecisionEvents` in `pipeline-cli/src/decisions/event-log.ts:306`). Neither looks at `origin/main` or at the sync branch.
- `removeUntrackedIdenticalToMain` (`pipeline-cli/src/steps/00-5-sync-parent.ts:276-301`) deletes an untracked event file once it is byte-identical on `origin/main`. If the parent HEAD is then not moved to `origin/main`, the event is in neither the working tree nor HEAD. The tier falls back, the decision is due again, and `makeRoutingChangedEvent` (`event-log.ts:573-586`) writes a new event with a new timestamp and so a new file name.
- The parent HEAD can stay behind. On 0.42.0 the upkeep script was not found in an adopter repository (fixed by AISDLC-1328 in 0.43.0). It is still possible on `main`: `ai-sdlc-plugin/scripts/check-orchestrator-state.sh:249-255` exits 0 without resetting when any tracked change outside `backlog/tasks` and `backlog/completed` exists.
- The existing test covers only a second pass with the file still present (`pipeline-cli/src/decisions/escalation-chain-promote.test.ts:87-100`).

**Shape.** A merged `routing-changed` event counts even when its file is not in the local tree. Promotion reads the events of a decision from `origin/main` and from the open sync branch as well as from local files, and a decision that already moved to a tier is not moved to it again. Step 0.5 never leaves the event log with fewer events than `origin/main` holds.

**Control.** No control changes. Escalation timeboxes and tiers stay as they are; the change only stops a repeat of a move that already happened.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: should a decision move up a tier twice for the same lapse? No; one move per lapse is the rule, and the loop breaks it. 2. Deleted: nothing in the tier model; the repeat comes from a lost read, not from a missing rule. 3. Simplified or optimised: read the events through one merged view (local, `origin/main`, sync branch) in the one place that decides a decision is due, rather than guard each caller. 4. Accelerated: the loop stops at the first repeat instead of after hundreds of pull requests. 5. Automated: a test deletes the merged event locally, keeps the HEAD stale, ticks twice and counts the events.

- **Promotion read.** Make the due check use the decision's events from `origin/main` and from the sync branch together with the local files, deduplicated by event content hash as `readDecisionEvents` already does.
- **Step 0.5.** In `removeUntrackedIdenticalToMain`, delete an identical untracked event file only when the parent HEAD will hold it, so the event log never has fewer events than `origin/main`.
- **Tests.** In `escalation-chain-promote.test.ts`, delete the merged event locally with a stale HEAD and check that a second promotion writes no event. In `00-5-sync-parent.test.ts`, check the file stays when HEAD does not hold it.

Out of scope: the batching and rate limit of sync pull requests, the webhook health decision itself, and repairing logs that already hold duplicate events.

## Acceptance Criteria

- [ ] #1 A test promotes a due decision, deletes the merged event file from the working tree with HEAD left stale, promotes again, and finds exactly one `routing-changed` event for that lapse.
- [ ] #2 A test shows promotion counts a `routing-changed` event that exists only on `origin/main`, and one that exists only on the sync branch.
- [ ] #3 A test shows an identical untracked event file is not deleted when the parent HEAD does not hold it, and is deleted when it does.
- [ ] #4 The existing second-pass test still passes unchanged.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
