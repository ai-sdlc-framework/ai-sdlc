---
id: AISDLC-1383
title: 'A verify slot or exclusive marker without a pid is reclaimed after a grace period, and a long wait names its holder'
status: Done
assignee: []
created_date: '2026-11-22'
labels:
  - bug
  - pipeline-cli
  - verify
dependencies:
  - AISDLC-1378
references:
  - pipeline-cli/src/runtime/verify-slots.ts
  - scripts/pre-push-patch-coverage.mjs
priority: high
---

## Description

**Gap.** AISDLC-1378 (PR #2932) added an exclusive marker, `<boardDir>/verify-slots/exclusive/`, so at most one full verify suite runs per machine. While the marker is held, every other verify and every pre-push waits. `exclusiveHeld()` in `verify-slots.ts` treats a marker directory with no readable `pid` file as held ("pid still being written") forever. `listVerifySlots()` already did the same for `slot-<n>/` directories with no pid (`alive: pid === null ? true : ...`). None of the wait loops has a deadline.

**Failure.** A process killed between the atomic `mkdir` and the `pid` write leaves a directory with no pid. Kills happen under load: on 2026-11-22 dispatch ticks exited with empty output at load average 20+. After such a kill, every verify run and every `git push` on the machine waits forever, with no message saying why. Before AISDLC-1378 an orphaned slot only cost one of the slots; the exclusive marker turns it into a full stall. The AISDLC-1378 reviewers flagged this as minor ("pid-less exclusive marker never reclaimed, pre-push wait is now unbounded"), and it shipped unfixed.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: a pid-less directory is a legitimate state only for the microseconds between `mkdir` and `writeFileSync`, so "held forever" is not a requirement. 2. Deleted: the unconditional `return true` for a pid-less marker, and `alive: true` for a pid-less slot. 3. Simplified: one rule for both, a pid-less directory older than a grace period (directory mtime, 30 s) is stale and reclaimed exactly like a dead holder. 4. Accelerated: none. 5. Automated: regression tests below.

- `verify-slots.ts`: a slot or exclusive directory with no readable pid whose mtime is older than `PIDLESS_GRACE_MS` (30 000) counts as dead and is reclaimed by the next caller (remove, then retry the atomic `mkdir`; losing the race to another caller is fine). Inside the grace period it still counts as held.
- Each wait loop (`acquireVerifySlot` shared wait, `acquireExclusive` phases 1 and 2) logs one line naming the holder pid and the directory once it has waited 60 s, then keeps waiting. A live holder is never reclaimed or timed out: a full suite can legitimately run for many minutes.
- `scripts/pre-push-patch-coverage.mjs`: the same waiting line reaches the pushing terminal (stderr) so a stuck push says what it waits on.

## Acceptance Criteria

- [ ] #1 A test: an `exclusive/` directory with no pid and mtime older than the grace period is reclaimed; a shared acquirer and an exclusive acquirer both proceed.
- [ ] #2 A test: a `slot-<n>/` directory with no pid older than the grace period is reclaimed.
- [ ] #3 A test: a pid-less directory inside the grace period still counts as held.
- [ ] #4 A test: a live holder is never reclaimed, and after 60 s of waiting one log line names its pid and directory.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
