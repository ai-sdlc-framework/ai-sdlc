---
id: AISDLC-1285
title: 'Webhook forwarder agent starts under launchd, and health stops calling a crash-looping forwarder healthy'
status: In Progress
assignee: []
created_date: '2026-11-16'
labels:
  - pipeline-cli
  - hierarchy
  - bug
dependencies: []
references:
  - pipeline-cli/src/hierarchy/webhook-forwarder.ts
  - pipeline-cli/src/hierarchy/webhook.ts
  - pipeline-cli/src/hierarchy/webhook-health.ts
  - pipeline-cli/src/hierarchy/webhook.test.ts
  - pipeline-cli/src/hierarchy/webhook-health.test.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
dispatchableReason: 'Observed live by the planner and the operator on 2026-11-16 at main e4ca2e2a: `cli-hierarchy webhook up --feed gh-forward` printed "forwarder agent ... loaded", the agent exited 126 on every start, no hook was registered, and `webhook status` printed `healthy` and `persisted: launchd`, which closed DEC-0402 while no event had arrived for a week. The operator ordered the filing on 2026-11-16.'
---

## Description

**Gap.** On 2026-11-16 the webhook feed had delivered nothing since 2026-11-08. The operator ran `cli-hierarchy webhook up --feed gh-forward`. Three things went wrong, all in our code.

1. **The agent cannot start `gh`.** `installForwarder` (`pipeline-cli/src/hierarchy/webhook-forwarder.ts`) writes the plist with `ProgramArguments` `/usr/bin/env gh webhook forward ...` and copies the session's `PATH` into `EnvironmentVariables`. In a hierarchy session the first `PATH` entry is the board's `bin/` directory, which holds the `gh` call-counting wrapper (a shell script). The board directory is inside the repository checkout, here under `~/Documents`, and macOS does not let a launchd job read a script there. The log (`webhook-forward.log` in the board directory) shows on every start:

   ```
   /bin/sh: <board-dir>/bin/gh: Operation not permitted
   ```

   launchd reports `last exit code = 126`, `state = spawn scheduled`, and retries every 30 seconds for ever. No `cli` hook is created on the repository.

2. **"Loaded" is read as "alive".** `forwarderAgentAlive` returns true when `launchctl print` exits 0, which is true for a job that is loaded and crash-looping. So:
   - `installForwarder` logs `forwarder agent <label> loaded` and `webhook up` exits 0;
   - `forwarderSignal` in `pipeline-cli/src/hierarchy/webhook.ts` reports `alive`, the class becomes `healthy` (signal `quiet`), and `webhook status` prints `persisted: launchd <label>`;
   - `pipeline-cli/src/hierarchy/webhook-health.ts` closes the episode: DEC-0402 was answered `restart-feed` with "webhook health recovered" at 18:40:42Z, three minutes before any event arrived (the operator started a forwarder by hand at 18:43:47Z).

3. **A wrong secret is silent.** The agent was installed with a secret that differs from the running receiver's (the literal text `...` was pasted where the secret belongs). Had the forwarder started, every delivery would have been refused with 401 and the status would still have read `healthy` while no PR changed.

**Shape.** The agent runs the real `gh` by absolute path with a `PATH` that does not contain the board's `bin/` directory. "Alive" means launchd has the job running. `webhook up` checks that before it says the agent is loaded. Refused deliveries count against health.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: does the agent need the call-counting wrapper? No: the wrapper counts `gh` API calls of sessions; one long-lived `gh webhook forward` process is not such a call. Does it need the session `PATH` at all? Only to find `gh`, which is resolved once at install time. 2. Deleted: the copy of the session `PATH` into the plist and the `/usr/bin/env` lookup. 3. Simplified or optimised: one parse of `launchctl print` (state, pid, last exit code) serves `webhook up`, the health signal and the `persisted:` line. 4. Accelerated: `webhook up` fails in seconds with the log tail instead of the operator finding out from a missing event. 5. Automated: tests for the plist content, the crash-loop signal and the refused-delivery signal.

- **Plist.** `installForwarder` resolves the real `gh` binary at install time, ignoring the board's `bin/` directory, and writes its absolute path as the first program argument (no `/usr/bin/env`). The plist `PATH` is the session `PATH` with the board's `bin/` directory removed. When no `gh` other than the wrapper is found, `webhook up` fails with a message that says so.
- **Liveness.** `forwarderAgentAlive` is true only when `launchctl print` shows the job running (`state = running` with a pid). A loaded job that is not running is `dead` for `forwarderSignal`.
- **`persisted:` line.** `forwarderPersistence` prints `persisted: launchd <label>` only for a running job. For a loaded job that is not running it prints `persisted: no (<label> loaded but not running, last exit code <n>)`.
- **`webhook up`.** After the bootstrap it waits a short bounded time for the job to be running. When the job is not running it prints the last lines of `webhook-forward.log`, the last exit code and the plist path, and exits non-zero. It prints `forwarder agent <label> loaded` only for a running job.
- **Refused deliveries.** The receiver records deliveries it refuses for a bad signature. When one or more were refused since the last accepted event, the health class is `degraded` with a reason that says the hook secret does not match the receiver's. No secret, and no digest of one, is written to disk.
- **Episode close.** No change in `webhook-health.ts` is expected: with the liveness fix a crash-looping agent no longer produces `healthy`. A test pins that a loaded, not running agent does not close an open episode.
- **Docs.** `docs/operations/cli-hierarchy.md` (webhook section): the agent's program and `PATH`, the new `persisted:` wording, what `webhook up` prints when the agent does not start, and the refused-delivery reason.

Out of scope: where the secret is carried in the plist; the feed kinds `tunnel` and `none`; Linux and Windows (no launchd).

## Acceptance Criteria

- [ ] #1 The plist written by `installForwarder` has an absolute path to `gh` as its first program argument and no `/usr/bin/env`; a test covers it.
- [ ] #2 With a session `PATH` whose first entry is the board's `bin/` directory, the plist `PATH` does not contain that directory and the program argument is not the wrapper; a test covers it.
- [ ] #3 When the only `gh` on `PATH` is the wrapper in the board's `bin/` directory, `webhook up --feed gh-forward` exits non-zero with a message naming the missing `gh`; a test covers it.
- [ ] #4 For `launchctl print` output with `state = spawn scheduled` and `last exit code = 126`, `forwarderAgentAlive` is false, the forwarder signal is `dead`, and the health class is not `healthy`; a test covers it.
- [ ] #5 For the same output, `webhook status` prints `persisted: no (...)` with the last exit code and never `persisted: launchd`; a test covers it.
- [ ] #6 When the job is not running after the bootstrap, `webhook up --feed gh-forward` exits non-zero, prints the tail of `webhook-forward.log` and the last exit code, and does not print `forwarder agent <label> loaded`; a test covers it.
- [ ] #7 With an open health episode and a loaded, not running agent, the episode is not closed and no `operator-answered` event is written; a test covers it.
- [ ] #8 After a delivery is refused for a bad signature and no event has been accepted since, the health class is `degraded` and the reason names the secret mismatch; an accepted event clears it; tests cover both.
- [ ] #9 `docs/operations/cli-hierarchy.md` describes the four changes listed under Docs.
- [ ] #10 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
