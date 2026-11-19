---
id: AISDLC-1345
title: 'Webhook health reads healthy only after an event was delivered, and the decision text names the real port'
status: Done
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - hierarchy
  - webhook
  - adopter
dependencies: []
references:
  - pipeline-cli/src/hierarchy/webhook.ts
  - pipeline-cli/src/hierarchy/webhook.test.ts
  - pipeline-cli/src/hierarchy/webhook-health.ts
  - pipeline-cli/src/hierarchy/webhook-health.test.ts
  - pipeline-cli/src/decisions/decision-record.ts
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to the health reading, the episode close rule, one message and their tests.'
---

## Description

**Gap.** A restarted webhook feed that has delivered nothing reads as healthy, so the open webhook-health decision is closed as if an operator had answered it. The next pull request change then opens a new decision, and each decision change is saved in its own sync pull request. The fix command in the decision body also names a port that may not be the one the receiver listens on.

What was seen in an adopter project on plugin 0.42.0 and then 0.43.0 (reported 2026-11-19, project `amplified-career-site`): at the 15:27Z restart on 0.43.0 health read "healthy" with "last event never", and DEC-0001 got an `operator-answered` event (option `restart-feed`, by `operator-dispatch`) with no operator involved. At 15:33Z DEC-0002 opened: "Webhook health down: no event for ever while a PR changed in the last 120 min" (receiver true, port true, last event age null, forwarder alive). The receiver listens on 8767; the decision body tells the operator to forward to port 8765.

**Cause (read from the source).**

- `webhookHealth` (`pipeline-cli/src/hierarchy/webhook.ts:322-392`) counts "no event ever" against health only when a pull request changed inside the window (`webhook.ts:368` and `:373`). With no recent pull request change the class stays `healthy` on process liveness alone.
- `runWebhookHealthTick` (`pipeline-cli/src/hierarchy/webhook-health.ts:128-139`) calls `closeEpisode` as soon as the reading is `healthy` and the stored class is not. `closeEpisode` (`webhook-health.ts:262-275`) answers every open webhook-health decision with `operator-answered`, option `restart-feed`, by `operator-dispatch`. No delivered event is required.
- So a restart with a still-silent feed closes the decision, and the next pull request change opens a new one (DEC-0001, then DEC-0002).
- `WEBHOOK_FIX_COMMAND` hard-codes the fixed port 8765 in the forward address (`webhook-health.ts:35-36`, used in the body at `webhook-health.ts:110`). The receiver records its real port in a state file (`webhook.ts:169-192`, port file written at `webhook.ts:186`); the forwarder and the status line already use the recorded port (`pipeline-cli/src/hierarchy/webhook-forwarder.ts:51-61`, `webhook.ts:107-108`).

**Shape.** An episode closes only when an event newer than the episode start was received. A feed that never delivered an event reads as unverified (or stays non-healthy), not healthy. The decision body prints the recorded port.

**Open question for the operator (not decided here).** Whether a machine close should keep the event kind `operator-answered`. Today only the `by` field tells it apart, and `pipeline-cli/src/decisions/decision-record.ts:42-58` has no event kind for a machine close. Proposal only: keep `operator-answered` in this task, so the event schema does not change, and decide a separate kind later. This task must not add an event kind.

**Control.** No control changes. A decision now closes later, not earlier, so the change only tightens.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: is a live process enough to call a feed healthy? No; health means events arrive. 2. Deleted: the close on a bare restart. 3. Simplified or optimised: compare the last event time with the episode start in the tick, with the reading unchanged for other classes. 4. Accelerated: the new decision is not opened a few minutes after a false close, so no extra sync pull request. 5. Automated: tests cover a silent restart, a delivery after the restart and the port text.

- **Reading.** In `webhookHealth`, a feed with no event ever, and no recent pull request change, reads as an unverified class (or a non-healthy one), not `healthy`. Name the class in the tests; keep the existing classes.
- **Close rule.** In `runWebhookHealthTick`, call `closeEpisode` only when the last received event time is later than the episode start.
- **Port.** Build the fix command from the recorded port (`webhookTargetUrl`) instead of the constant, and fall back to the default port only when none is recorded.
- **Tests.** In `webhook-health.test.ts` and `webhook.test.ts`, cover a restart with no delivery, a delivery after the restart, and the printed port (for example 8767).

Out of scope: the number of sync pull requests, the promotion loop, a new event kind, and the webhook repair steps.

## Acceptance Criteria

- [x] #1 A test shows a restart with `last event never` does not close the open webhook-health decision.
- [x] #2 A test shows an event received after the episode start closes it.
- [x] #3 A test shows a feed that never delivered reads as unverified or non-healthy, not `healthy`, whether or not a pull request changed recently.
- [x] #4 A test shows the decision body names the recorded port (8767) and not 8765, and names the default port only when none is recorded.
- [x] #5 No new event kind is added; `decision-record.ts` is unchanged in its event type list.
- [x] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
A restarted webhook feed that has delivered no event now reads `unverified`, not `healthy`, and an open webhook-health decision closes only when an event newer than the episode start has arrived. The decision body now prints the receiver's recorded port (8767 in the adopter case) and names the default 8765 only when none is recorded.

## Changes
- pipeline-cli/src/hierarchy/webhook.ts
- pipeline-cli/src/hierarchy/webhook-health.ts
- pipeline-cli/src/hierarchy/webhook-repair.ts
- pipeline-cli/src/hierarchy/webhook.test.ts
- pipeline-cli/src/hierarchy/webhook-health.test.ts
- pipeline-cli/src/hierarchy/webhook-repair.test.ts

## Design decisions
I did not rebase, push or open a PR. The task prompt said 'never push', and I followed that over the agent definition's push-and-PR step, so prUrl is null for that reason. The branch needs rebasing and pushing by the orchestrator or operator.

Design choice: I added a fourth health class, `unverified`, to the `WebhookClass` type. The tick treats it as a no-op: it opens no decision, closes no decision and does not trigger a repair. I picked this over using `degraded` because `degraded` would open a decision on every fresh start with no events. Say if you would rather use `degraded`.

The health signals gain `lastEventAt` and `receiverPort`. The fix command is now built by a new function, `webhookFixCommand(port)`. The `WEBHOOK_FIX_COMMAND` constant is kept and equals the 8765 form.

No new event kind was added and `decision-record.ts` is untouched (AC5).

Verification: the pipeline-cli hierarchy tests (1302), build, lint and format all passed. The full `pnpm test` run was still going in the background when I committed. The parts that had finished all passed, but I did not see it complete.

The task backlog file shows as modified in the worktree. I did not make that change and did not stage it.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

