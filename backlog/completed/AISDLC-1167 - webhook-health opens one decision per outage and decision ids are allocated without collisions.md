---
id: AISDLC-1167
title: 'Webhook health opens one decision per outage, and decision ids are allocated without collisions'
status: Done
assignee: []
created_date: '2026-11-03'
labels:
  - pipeline-cli
  - hierarchy
  - decisions
dependencies: []
references:
  - pipeline-cli/src/hierarchy/webhook-health.ts
  - pipeline-cli/src/decisions/remote-persist.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/cli/file.ts
priority: medium
dispatchable: true
---

## Description

On 2026-11-03 one webhook outage, with no event for about 10 hours and no forwarder running, produced four decision records: DEC-0292 twice, then DEC-0293 and DEC-0294. Two of them shared an id.

**1. One outage opens several records.** `catalogWebhookEscalation().escalate` in `pipeline-cli/src/hierarchy/webhook-health.ts` (around lines 121-152) opens a decision with scope `webhook-health:<since>`. The scope includes a timestamp, so every episode has a fresh scope. Nothing reads the decision log for an open `webhook-health:` record before opening. The only guard is the board state file `webhook-health.json` (around lines 64-105). `readState` falls back to `healthy` on any error, so a flap, a lost state file or two ticks that read it before either writes all open another record. On recovery, `closeEpisode` (around lines 94-97 and 153-164) answers only the id held in the state file. The other records stay open, and the operator is asked the same question twice (DEC-0293 and DEC-0294 were opened 70 seconds apart with the same signals).

**2. Two ticks 11 seconds apart got the same id.** `nextDecisionIdDurable` in `pipeline-cli/src/decisions/remote-persist.ts` (around lines 324-341) takes the max over local events plus remote ids, then adds one, with no lock. Allocation and append are separate steps, and the push that makes the id visible remotely runs later and is best-effort. Two distinct `decision-opened` events, at 15:53:56.796Z and 15:54:07.999Z, both claimed DEC-0292. The duplicate then made `assertNoDuplicatePairs` in `pipeline-cli/src/cli/file.ts` (around line 179) refuse every `cli-decisions ... --file` call, which blocked the operator's answer to DEC-0293 until the planner set the leftover event aside by hand, with operator go.

**Five-step review (requirements first).**
1. Requirement questioned: the operator needs one question per outage, and a decision id must name exactly one decision.
2. Delete: the timestamp in the webhook-health scope; the episode belongs in the body, not the dedup key.
3. Simplify: before opening, look up an open `webhook-health` record in the store and reuse it, updating its body if the signals changed; recovery answers every open `webhook-health` record, not only the one in the state file.
4. Accelerate: allocate and append under one exclusive lock on the local event directory, for example an exclusive-create lock file or creating the event file with an exclusive flag and retrying with the next id on conflict.
5. Automate: tests pin both races.

## Acceptance Criteria

- [x] AC-1: With an open `webhook-health` record in the store, a tick that sees the outage, including after the state file is deleted, opens no new record. Unit test.
- [x] AC-2: Recovery answers every open `webhook-health` record, so none is left open after the feed comes back. Unit test with two open records.
- [x] AC-3: Two concurrent `nextDecisionIdDurable`-plus-append calls against the same work dir produce two distinct ids. Test that runs both with no remote and interleaves allocation before append.
- [x] AC-4: `cli-decisions` refuses to append a `decision-opened` event for an id that already has one, so a collision fails at write time instead of blocking a later filing.

## Notes

Found by the planner on 2026-11-03 while recording the operator's restart-feed answer to DEC-0293 and DEC-0294. The leftover DEC-0292 event (hash d36812444ad7) was moved to the planner scratchpad, not deleted. Related: AISDLC-1157 added the webhook health class.

## Final Summary

## Summary
Fixed the reviewer's major finding. The open-record lookup for `webhook-health` decisions now runs inside `withEventLogLock`, in the same critical section as id allocation and append. Two ticks can no longer both see an empty list and each open a record. The branch is rebased onto origin/main and pushed, and the existing draft PR #2321 is updated.

## Changes
- pipeline-cli/src/hierarchy/webhook-health.ts

## Design decisions
I added no new test for the lock-ordering change; the existing tests still pass. The first push attempt was blocked by the governance hook because I piped it to `tail`. I re-ran it as a standalone command and it went through. The pre-push patch-coverage gate passed.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (246 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

