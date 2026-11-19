---
id: AISDLC-1349
title: "The webhook receiver accepts only its own repository's events, and status proves the listener is this board's"
status: In Progress
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - hierarchy
  - webhook
  - adopter
dependencies:
  - AISDLC-1345
references:
  - pipeline-cli/src/dispatch/webhook-receiver.ts
  - pipeline-cli/src/dispatch/webhook-receiver.test.ts
  - pipeline-cli/src/hierarchy/webhook.ts
  - pipeline-cli/src/hierarchy/webhook.test.ts
  - pipeline-cli/src/hierarchy/webhook-health.ts
  - pipeline-cli/src/hierarchy/webhook-health.test.ts
  - pipeline-cli/src/hierarchy/pr-snapshot.ts
  - pipeline-cli/src/hierarchy/pr-snapshot.test.ts
  - reference/src/adapters/webhook-server.ts
  - reference/src/adapters/webhook-server.test.ts
priority: high
dispatchable: true
dispatchableReason: 'Bounded to the receiver repository filter, the health endpoint identity, the ownership check in status and health, the notice text and their tests.'
---

## Description

**Gap.** Several boards (one per project repository) run on one machine, each with its own webhook receiver on its own port. A receiver accepts a signed delivery for any repository, and the readers match events to pull requests by number only. A forwarder of another board that posts to this board's port therefore makes this board read healthy, stores the other project's events in this board's `events/` folder and wakes its dispatch, while the other board reads silent. Nothing proves that the process on the recorded port is this board's receiver, and the degraded notice does not name the board.

Operator requirement (2026-11-19): the webhook implementation must be aware of several instances on one machine, know which port it uses, and never mix health status between boards. Seen the same day in an adopter setup with three boards on ports 8765, 8766 and 8767.

**Cause (read from the source on main).** The cross-talk path is inferred from the code; it was not reproduced (unverified).

- `extractTarget` checks only the format of the repository name (`pipeline-cli/src/dispatch/webhook-receiver.ts:96-97`). Every verified delivery is written to `<boardDir>/events` and wakes dispatch (`webhook-receiver.ts:173`, `:218-219`).
- The readers ignore the repository: `eventEntries` parses only the pull request number (`pipeline-cli/src/hierarchy/pr-snapshot.ts:92`, also `:147`), and `webhookHealth` matches events to pull requests by number (`pipeline-cli/src/hierarchy/webhook.ts:343-344`). The last event time is the newest mtime in `events/` (`webhook.ts:332-334`).
- The signing secret is one environment variable, `AI_SDLC_WEBHOOK_SECRET` (`webhook.ts:25`), so boards started from the same shell share it and a foreign delivery passes verification.
- "Receiver up" is `process.kill(recordedPid, 0)` only (`webhook.ts:99-100`, `:328`, `:448`, `:465-469`); the port check is a TCP connect (`webhook.ts:276-286`, `:330`). Neither shows that the listener is a receiver or belongs to this board. The `/health` endpoint returns `{status:'ok', providers:N}` with no board or repository (`reference/src/adapters/webhook-server.ts:69-71`), and nothing calls it.
- The degraded notice text is `Webhook <class>: <reasons>` (`pipeline-cli/src/hierarchy/webhook-health.ts:194`, desktop notice at `:286`), with no repository or board.

**Shape.** A receiver knows its repository and its board directory. It refuses a delivery for another repository and records the refusal with the repository named, so the misdirected forwarder is visible. Health and status ask the listener on the recorded port who it is and count the receiver as up only when it answers with this board's identity. Notices name the repository.

**Control.** No control is loosened. The receiver accepts less than before.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must a board's receiver take events for other repositories? No; one board serves one repository. 2. Deleted: acceptance of foreign deliveries and the bare pid check as proof of "up". 3. Simplified or optimised: one identity (repository and board directory) recorded once in `webhook.json` and reused by the filter, the endpoint and the notice. 4. Accelerated: a misdirected forwarder shows in status at the first delivery, not after a webhook-health decision on the other board. 5. Automated: tests run two boards against each other.

- **Identity.** At start the receiver is given the repository (`owner/name`, the same lookup the forwarder uses at `pipeline-cli/src/hierarchy/webhook-forwarder.ts:128-135`) and its absolute board directory, and records the repository in `webhook.json` next to `pid` and `port`.
- **Filter.** A verified delivery whose repository is not this board's is not written to `events/`, does not wake dispatch and does not count as a last event. It is added to the existing refused record (`webhook-refused.json`) with the foreign repository name. When the repository lookup failed at start, the receiver accepts as today and status says the repository is unknown; it never refuses everything.
- **Endpoint.** `/health` also returns the repository and the board directory.
- **Ownership.** `webhookStatus` and `webhookHealth` call `/health` on the recorded port (1 s timeout) and treat the receiver as up only when the answer names this board directory. A live pid with a foreign or missing answer reads as a distinct non-healthy reason, and `webhookUp` does not skip the start on it.
- **Status and notice.** `cli-hierarchy status` prints the count of refused foreign deliveries with the repository when there are any. The degraded notice and the webhook-health decision summary name the repository.
- **Tests.** In the test files listed in the references.

Out of scope: a per-board signing secret (see the open question), port selection, the feed record and the forwarder (AISDLC-1350), and the decision text port (AISDLC-1345).

**Open question for the operator (not decided here).** Whether each board should also get its own signing secret, stored in the board directory, in place of the shared environment variable. Proposal only: not in this task; the repository filter and the identity check already stop the cross talk, and a per-board secret changes how the GitHub hook is created.

## Acceptance Criteria

- [ ] #1 A test with two receivers, A for repository `o/a` and B for `o/b` sharing one secret, shows a signed delivery for `o/b` posted to A writes nothing to A's `events/`, does not wake A's dispatch and is recorded as refused with `o/b` named.
- [ ] #2 A test shows that after that delivery A's `webhookHealth` last event time is unchanged.
- [ ] #3 A test shows a delivery for `o/a` posted to A is accepted as before.
- [ ] #4 A test shows a receiver started with no resolvable repository accepts deliveries and status reads the repository as unknown.
- [ ] #5 A test shows `/health` returns the repository and the board directory.
- [ ] #6 A test shows a recorded pid that is alive while the recorded port answers with another board's identity (or does not answer `/health`) reads as not up with a named reason, and `webhookUp` starts a receiver.
- [ ] #7 A test shows the degraded notice text and the decision summary contain the repository name.
- [ ] #8 A test shows `status` prints the refused foreign delivery count and repository, and prints nothing extra when there are none.
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
