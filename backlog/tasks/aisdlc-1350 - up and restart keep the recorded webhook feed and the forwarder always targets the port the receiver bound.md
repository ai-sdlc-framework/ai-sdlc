---
id: AISDLC-1350
title: 'Up and restart keep the recorded webhook feed, and the forwarder always targets the port the receiver bound'
status: In Progress
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - hierarchy
  - webhook
  - adopter
dependencies:
  - AISDLC-1348
references:
  - pipeline-cli/src/hierarchy/webhook.ts
  - pipeline-cli/src/hierarchy/webhook.test.ts
  - pipeline-cli/src/hierarchy/webhook-forwarder.ts
  - pipeline-cli/src/hierarchy/webhook-repair.ts
  - pipeline-cli/src/hierarchy/webhook-repair.test.ts
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/restart.ts
  - pipeline-cli/src/hierarchy/hierarchy.test.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
dispatchableReason: 'Bounded to the feed record across restarts, the order of bind and forwarder install, the pinned-port restart, the legacy label, the port wording and their tests.'
---

## Description

**Gap.** On a machine with several boards, an ordinary restart can leave a board's forwarder posting to a port that this board no longer listens on, and that port may by then belong to another board. The board also forgets that it has a feed, so its self-repair never corrects the forwarder. Three smaller faults sit on the same path: the forwarder is installed before the receiver has bound its port, `restart --all` fails on its own port, and a state file that still names the old machine-wide launch agent is acted on as this board's.

Operator requirement (2026-11-19): the webhook implementation must be aware of several instances on one machine, select its port, know which port it uses, and never mix health status between boards.

**Cause (read from the source on main).** The failure sequences are inferred from the code; they were not reproduced (unverified).

- **Feed record lost.** Plain `up` and a dispatch restart call `webhookUp(deps)` with no feed (`pipeline-cli/src/hierarchy/up.ts:711`, `pipeline-cli/src/hierarchy/restart.ts:357`). After a receiver crash or a reboot, `selectPort` rescans from the recorded port and may take another one (`pipeline-cli/src/hierarchy/webhook.ts:170-192`); `serve` is spawned with no feed and rewrites `webhook.json` without `feed.agent` (`webhook.ts:475-492`, `:549-552`). The launch agent (RunAtLoad, KeepAlive) keeps posting to the old port. Repair is eligible only with a recorded agent (`pipeline-cli/src/hierarchy/webhook-repair.ts:117-123`), so the plist is never rewritten.
- **Install before bind.** The scanned port is written to `webhook-port` before `serve` binds (`webhook.ts:186`), and with `--feed gh-forward` the forwarder is installed against it before the receiver is spawned (`webhook.ts:454-457`, then `:475-492`). When the bind then fails with EADDRINUSE (`webhook.ts:539-543`), the agent stays installed and aimed at the process that won the port. The free-port probe also counts a failed probe as free (`webhook.ts:146-147`).
- **Pinned restart.** `restart --all` passes the recorded port as a pin (`restart.ts:379-386`), so a port still held (also by its own receiver just after SIGTERM at `restart.ts:380`) is a hard failure, not a rescan (`webhook.ts:177-181`). A pinned port is never written to `webhook-port`.
- **Legacy label.** Before AISDLC-1256 the launch agent label was the machine-wide `io.ai-sdlc.webhook-forward`. A `webhook.json` that still records it is read, kickstarted and booted out as this board's (`webhook.ts:303`, `:510`; `webhook-repair.ts:114`, `:152`), while a reinstall writes the per-board label (`pipeline-cli/src/hierarchy/webhook-forwarder.ts:245`). Nothing removes the old plist.
- **Repair port.** Repair rebuilds the plist from `readState(...)?.port ?? 0` (`webhook-repair.ts:127`), which would write port 0 when the record is missing.
- **Wording.** The `webhook` help says "default 8765" with no mention of the scan (`pipeline-cli/src/cli/hierarchy.ts:294`); `docs/operations/cli-hierarchy.md:433`, `:440`, `:457` and `:486` name 8765 where the selected port applies.

What already holds and must stay: the port scan moves to the next free port (`webhook.ts:183-190`), the per-board launch agent label (`webhook-forwarder.ts:26-35`), and state files under the board directory.

**Shape.** The receiver binds first; only then is the port recorded and the forwarder installed or re-pointed at the bound port. Every start path carries the recorded feed forward, so a board that had a feed still has it, on the right port, after any restart. A restart waits for its own receiver to release the port and rescans when another process holds it. A recorded machine-wide label is replaced by the per-board one.

**Control.** No control changes.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must the forwarder be installed before the receiver listens? No; it has nothing to post to until the bind. 2. Deleted: the feed-less restart, the port record written before the bind, the pin on `restart --all`, the port 0 fallback. 3. Simplified or optimised: one start path for `up`, dispatch restart and `restart --all` that reads the recorded feed and ends with the forwarder checked against the bound port. 4. Accelerated: a moved port is corrected at start, not after a webhook-health decision. 5. Automated: tests cover the restart sequences below.

- **Carry the feed.** `up` and the dispatch restart pass the recorded feed (kind and agent) into `webhookUp`, as `restart --all` already does. A receiver start never drops `feed` from `webhook.json`.
- **Bind, then record, then feed.** Write `webhook-port` and install the forwarder only after the receiver reports that it bound. On a bind failure, rescan (unless the port is pinned) and install nothing for the failed port. A failed free-port probe counts as busy.
- **Re-point.** After every receiver start with a recorded `gh-forward` feed, compare the installed plist address with the bound port and reinstall when they differ (the comparison at `webhook-repair.ts:79-105` already exists).
- **Restart.** `restart --all` prefers the recorded port but does not pin it: it waits for its own receiver to exit, then rescans from the recorded port. A pin from `--port` or `AI_SDLC_WEBHOOK_PORT` is unchanged, and a pinned port is recorded in `webhook-port` too.
- **Legacy label.** When the recorded agent is `io.ai-sdlc.webhook-forward`, boot it out once, install the per-board label and record that; status, repair and down never act on the machine-wide label afterwards.
- **Repair port.** Repair does nothing and reports the reason when no port is recorded.
- **Wording.** The help and the four docs lines say the receiver takes the first free port from the configured one (default 8765) and that `status` prints the port in use.
- **Tests.** In the test files listed in the references.

Out of scope: the repository filter and listener identity (AISDLC-1349), the no-feed message and the liveness lookup (AISDLC-1348), the decision text port (AISDLC-1345).

**Open question for the operator (not decided here).** Two boards for the same repository on one machine (two clones, or a moved board directory). Today every install, repair reinstall and `webhook down` deletes every `cli` hook on the repository without checking whose it is (`webhook-forwarder.ts:141-160`, `:243`, `:296`; `webhook-repair.ts:149`), and GitHub allows one forwarder per repository hook, so the two boards remove each other's feed. Proposal only: refuse, not support. The second board's `webhook up --feed gh-forward` fails with a message naming the other board's launch agent. This task does not change the hook deletion.

## Acceptance Criteria

- [ ] #1 A test shows that after a receiver exit, plain `up` on a board with a recorded `gh-forward` feed leaves `webhook.json` with the same feed kind and agent.
- [ ] #2 A test shows the same for a dispatch restart.
- [ ] #3 A test shows that when the recorded port is held by another process at start, the receiver binds the next free port, `webhook.json` and `webhook-port` name it, and the forwarder plist address names it.
- [ ] #4 A test shows a bind failure after the scan installs no forwarder and writes no `webhook-port` for the failed port, and the start retries on the next port.
- [ ] #5 A test shows a failed free-port probe counts the port as busy.
- [ ] #6 A test shows `restart --all` with the recorded port held by another process starts on the next free port, and with the port free reuses it.
- [ ] #7 A test shows a port pinned by `--port` or `AI_SDLC_WEBHOOK_PORT` that is held still fails with the collision message, and a pinned port that binds is written to `webhook-port`.
- [ ] #8 A test shows a `webhook.json` recording `io.ai-sdlc.webhook-forward` ends with the per-board label recorded and installed and one bootout of the old label.
- [ ] #9 A test shows repair with no recorded port installs nothing and reports the reason.
- [ ] #10 The `webhook` help and the docs name the scan from the configured port, and the docs parity test passes.
- [ ] #11 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
