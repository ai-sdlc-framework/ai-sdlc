---
id: AISDLC-1357
title: 'Up and status name every missing piece in one line each, and the scheduler is reported as running only when it is'
status: Done
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - hierarchy
  - adopter
  - bootstrap
dependencies:
  - AISDLC-1350
  - AISDLC-1358
references:
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/hierarchy.test.ts
  - pipeline-cli/src/hierarchy/reconcile-scheduler.ts
  - pipeline-cli/src/hierarchy/host-liveness.ts
  - pipeline-cli/src/hierarchy/host-liveness.test.ts
  - pipeline-cli/src/hierarchy/tick-watchdog.ts
  - pipeline-cli/src/hierarchy/status.ts
  - pipeline-cli/src/hierarchy/module-health.ts
  - pipeline-cli/src/hierarchy/module-health.test.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - ai-sdlc-plugin/mods/tests/hierarchy-dispatch.test.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
dispatchableReason: 'Bounded to the up output lines, the scheduler start check, the stall limit, and the failure line in status, with tests in the files listed.'
---

## Description

**Gap.** `cli-hierarchy up` can finish with a board that only polls, a scheduler that died a second after it was spawned, and a dispatch module whose reconcile and sweep fail every tick, and it says nothing about any of the three. `status` then prints `scheduler: STALLED` for a scheduler that is behaving as designed.

Operator requirement (2026-11-19): bootstrap a new repository once and have everything configured and running automatically; anything not working says so loudly.

An adopter on plugin 0.43.0 saw `scheduler: STALLED (last tick 64s to 91s ago)` on four reads while the board kept moving (reported 2026-11-19; the checkout was not available, so the adopter's own cause is unverified).

**Cause (read from the source on main).** Each line below was read on the current checkout.

- **No secret, no line.** `up` starts the webhook receiver only when `AI_SDLC_WEBHOOK_SECRET` is set and prints nothing otherwise (`pipeline-cli/src/hierarchy/up.ts:708-715`). The comment calls it "not an error" (AISDLC-880). It is a valid mode, but the operator is never told the board polls only or how to change that.
- **Swallowed error.** The context-size warnings are read inside a `try` whose `catch` is empty (`up.ts:722-726`, comment "a context read must never fail up"). The right rule is that it never fails `up`; today it also never says it was skipped.
- **Scheduler start is trusted.** `schedulerUp` spawns detached, writes the pid and logs "scheduler starting" (`pipeline-cli/src/hierarchy/reconcile-scheduler.ts:97-123`). It returns `up` as soon as the spawn returned a pid, with no check that the process is still alive a moment later. `up` only warns when the spawn throws (`up.ts:683-687`). A process that exits at once (a bad bin path, a missing module) leaves a pid file and a log line that says it started. A later `status` calls `isAlive` and reports `off`, which is truthful but late and silent.
- **Failures are pane notes.** In the dispatch module a failed reconcile writes the note `reconcile failed` (`ai-sdlc-plugin/hooks/hierarchy/dispatch.ts:392`) and a failed sweep writes `cli-ci sweep failed` (`dispatch.ts:400`). The notes are the last ten pane lines (`dispatch.ts` `note()`); `status` and `doctor` never read them. The note has no error text.
- **Stall limit shorter than the carry time.** The stall limit is `AI_SDLC_TICK_STALL_MINUTES` or twice the host tick interval (`pipeline-cli/src/hierarchy/tick-watchdog.ts:63-66`), so 60 s at the default 30 s (`pipeline-cli/src/hierarchy/host-liveness.ts:22`, `:70-73`). `schedulerStatus` marks the scheduler `STALLED` when work is queued and the last tick is older than that limit (`reconcile-scheduler.ts:73-80`). The scheduler itself only steps in when the host has missed three intervals, 90 s (`host-liveness.ts:24`, `:27-30`), checked every 30 s (`host-liveness.ts:118-120`), so 90 to 120 s in practice. Between 60 s and 90 s of silence `status` therefore prints `STALLED` for a scheduler that is waiting by design. A normal interval can exceed the threshold: yes. The adopter's 64 s to 91 s fits this window exactly. A host tick that itself runs longer than 30 s reaches the same state, because ticks do not overlap.
- **Boot persistence (fact only).** The scheduler has no launchd or boot entry: `reconcile-scheduler.ts` and `up.ts` contain no `launchctl`, plist or `RunAtLoad`; only the webhook forwarder installs one (`pipeline-cli/src/hierarchy/webhook-forwarder.ts:117-118`). After a reboot the scheduler is gone until the next `up`. `status` shows `scheduler: off` then.

**Shape.** `up` ends with one line per missing piece, each naming the command that fixes it: no webhook secret, scheduler not alive after the liveness check, dispatch module failures recorded. The scheduler is reported running only after it passed a liveness check a short time after the spawn. `STALLED` appears only when the scheduler is later than its own step-in time. A failing reconcile or sweep reaches `status` with the first line of the error.

**Control.** Does not change a control. It adds output and corrects a status reading; no gate reads either.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: is "STALLED" at 60 s correct when the scheduler is designed to wait 90 s? No. 2. Deleted: the empty `catch` at `up.ts:725`, the trust in a bare pid, the pane-only note. 3. Simplified: one stall limit that is the larger of the watchdog limit and the step-in time, in one place (`hostStallMs`), instead of a second constant. 4. Accelerated: the liveness check runs inside `up`, so a dead scheduler is named in the same command that started it. 5. Automated: tests cover each line and the stall window (60 s, 90 s and 120 s).

- **Webhook line.** After the scheduler step, when no secret is set, print `webhook: off, no AI_SDLC_WEBHOOK_SECRET (the board polls only); set it and run cli-hierarchy webhook up --feed gh-forward for events`. This is distinct from the no-feed line of AISDLC-1348, which applies when a secret is set.
- **Swallowed error.** Keep the rule that the read never fails `up`; print `warning: context size not read: <first line>` when it throws.
- **Liveness after spawn.** After `schedulerUp` spawns, wait a short bounded time (injected sleep, as `up` already injects `deps.sleep`) and check `isAlive` once. When dead, throw so the existing warning prints, with the first lines of the scheduler log (`reconcileLogPath`), and do not write the pid record as up.
- **Failure to status.** The dispatch module records the first line of each failed reconcile and sweep as a failure entry in the same heartbeat record that AISDLC-1358 extends (`ai-sdlc-plugin/hooks/hierarchy/dispatch.ts`, `writeModuleHealth`). `readModuleHealth` returns it and `status` prints it in the MODULE column; a later success clears it.
- **Stall limit.** The age-based `STALLED` test in `schedulerStatus` uses a limit above the scheduler's own step-in time (`MISSED_TICKS` intervals plus one check interval, 120 s at defaults). The limit for killing a running tick (`checkRunningTick`) is unchanged. An explicit `AI_SDLC_TICK_STALL_MINUTES` still wins.
- **Docs.** `docs/operations/cli-hierarchy.md` names the three `up` lines and the stall rule.
- **Tests.** In the test files listed in the references.

**Open question for the operator (not decided here).** Whether the scheduler should survive a reboot. Today it does not, and the operator must run `up` again. Proposal only: out of this task; a later task could install a launch agent like the forwarder's. Nothing here depends on the answer.

Out of scope: the launchd or boot entry for the scheduler, the feed record and port (AISDLC-1348, AISDLC-1349, AISDLC-1350), the dispatch heartbeat state and the module's CLI paths (AISDLC-1358), the doctor checks (AISDLC-1356).

## Acceptance Criteria

- [ ] #1 A test shows `up` with no `AI_SDLC_WEBHOOK_SECRET` prints exactly one `webhook: off` line that names the secret variable and the `webhook up` command, and with the secret set prints none.
- [ ] #2 A test shows a throw from the context-size read prints one `warning: context size not read` line and `up` still returns normally.
- [ ] #3 A test with a spawner whose process is dead at the liveness check shows `up` prints the scheduler warning with the log tail and `status` reads `off`.
- [ ] #4 A test with a live spawned process shows no warning and `scheduler: up (pid N)`.
- [ ] #5 A test with queued work shows the scheduler is not `STALLED` at 61 s, 90 s and 119 s since the last tick, and is `STALLED` at 125 s.
- [ ] #6 A test shows `AI_SDLC_TICK_STALL_MINUTES=1` still sets the limit and the running-tick kill limit is unchanged at twice the interval.
- [ ] #7 A test of the dispatch module shows a failed reconcile and a failed sweep each write a failure entry with the first error line, and a later success clears it.
- [ ] #8 A test shows `status` prints the recorded failure in the MODULE column and `readModuleHealth` returns it.
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
