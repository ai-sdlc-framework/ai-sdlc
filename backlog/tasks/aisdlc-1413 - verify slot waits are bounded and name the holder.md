---
id: AISDLC-1413
title: 'Verify slot waits are bounded and name the holder'
status: To Do
assignee: []
created_date: '2026-11-25'
labels:
  - bug
  - pipeline-cli
  - pre-push
dependencies: []
references:
  - pipeline-cli/src/runtime/verify-slots.ts
  - pipeline-cli/src/steps/verify-commands.ts
  - scripts/pre-push-patch-coverage.mjs
priority: high
---

## Description

**Five-step review (requirements first).** The requirement: a push or a verify run never waits silently and without limit for another process.

Found on 2026-11-25 while investigating a `cli-file task --pr` run that waited over 10 minutes and was cancelled by the operator. That wait was most likely `cli-file`'s own 15-minute filing spacing (AISDLC-1414 makes it visible), not a verify slot: the run started a few minutes after the previous filing PR, and the investigation did not show the push reaching the coverage step. The slot defects below are real independently of that run: any verify run started while they held would have waited without limit.

What the board showed:

- `verify-slots/exclusive/pid` held pid 46461, the `next-step --task AISDLC-1392` process of an executor stuck for two days (started 2026-11-23 09:51). A full-scope run takes the exclusive marker; while it is held, `acquireVerifySlot` admits no one. The process is alive but its run is not progressing, so the marker is never released.
- `verify-slots/slot-1/pid` held pid 90586. The slot directory dates from 2026-11-21; pid 90586 is now an unrelated Playwright MCP process started 2026-11-23. The pid was reused, so the dead holder looks alive and the slot is never reclaimed.
- `scripts/pre-push-patch-coverage.mjs` sets `SLOT_WAIT_MS = Infinity` and logs one "waiting for a verify slot" line without naming the holder.

While those markers held, every verify run on this checkout, including the pre-push coverage step, would have waited for as long as the AISDLC-1392 executor stayed stuck.

- **Delete:** the unbounded wait. No caller waits forever.
- **Simplify:** a holder is identified by pid plus process start time, so liveness is one check. A reused pid fails it.
- **Accelerate:** a wait that cannot succeed fails fast with the holder's identity, so the operator acts in seconds, not after a timeout.
- **Automate:** reclaiming a dead holder is automatic; a live but stuck holder is reported, never killed.

## Fix

- Write the holder's process start time next to its pid in each slot and in the exclusive marker. Liveness requires both to match the running process; otherwise the slot is reclaimed as dead.
- Give the exclusive marker and each slot a heartbeat (mtime touched while the holder runs). A holder past a stale threshold with no heartbeat is reported as stale. It is not reclaimed automatically while its process is alive.
- Replace `SLOT_WAIT_MS = Infinity` with a finite default, overridable by env. On timeout, refuse with a message that names the holder: slot, pid, command line, task id when known, held-for duration.
- While waiting, log the holder once at the start and then every 30 seconds with the elapsed wait.
- `cli-hierarchy status`: show each slot and the exclusive marker with pid, start time, command, held-for, and `stale` or `pid reused` when applicable.

## Acceptance Criteria

- [ ] #1 A slot whose pid belongs to a different process than the one that took it (start time mismatch) is reclaimed by the next caller.
- [ ] #2 No caller waits longer than the configured limit; on timeout the refusal names the holder's slot, pid, command, task id (when known) and held-for duration.
- [ ] #3 While waiting, the holder is logged at the start and at least every 30 seconds with the elapsed wait.
- [ ] #4 A live holder with no heartbeat past the stale threshold is reported as stale and is not killed or reclaimed.
- [ ] #5 `cli-hierarchy status` shows the exclusive marker and every slot with pid, start time, command and held-for, flagging stale and reused pids.
- [ ] #6 Tests cover pid reuse, a stale live holder, the timeout refusal text and the periodic wait log.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
