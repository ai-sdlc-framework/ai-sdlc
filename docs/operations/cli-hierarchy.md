# `cli-hierarchy` Reference

`cli-hierarchy` starts, inspects and stops the session hierarchy: a planner, a dispatch
session and up to five executors, each a Claude Code session in its own tmux session.
It replaces `/ai-sdlc execute-parallel` (see [`parallel-dispatch.md`](parallel-dispatch.md),
which keeps the shared runbook material: the executor loop, the dispatch loop, liveness
and the cancel back-channel). RFC: [RFC-0051](../../spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md).

The documented entry point is the plugin command, which runs `cli-hierarchy` from the
resolved pipeline-cli bin (works from an installed plugin, not only the dogfood repo):

```text
/ai-sdlc hierarchy <command> [options]
```

It passes `up`, `status`, `attach`, `terminals`, `brief` and `down` through unchanged,
with these differences: `attach` and `up --attach` print the shell command to run (a
Claude Code session cannot switch your terminal); `down` with no `--role` asks you to
confirm first; `clear`, `tick`, `route-decision`, `check-sender`, `check-repo` and
`executor-start` are refused (they belong to the dispatch and executor loop bodies); with no arguments it
prints `--help` plus a common-recipes block.

The fallback is the bare binary, from the repository root:

```bash
node pipeline-cli/bin/cli-hierarchy.mjs <command> [options]
```

The examples below use the bare `cli-hierarchy` name for brevity; the plugin form takes
the same commands and options.

Source of truth: `pipeline-cli/src/cli/hierarchy.ts` (the command table and `--help`) and
`pipeline-cli/src/hierarchy/*`. A test (`pipeline-cli/src/hierarchy/docs-parity.test.ts`)
reads the real `--help` output and fails when this page omits a command or option.

## Contents

- [Roles and naming](#roles-and-naming)
- [On-disk state](#on-disk-state)
- [Commands](#commands)
- [Operating cycle](#operating-cycle)
- [Restarting after a plugin upgrade](#restarting-after-a-plugin-upgrade)
- [Troubleshooting](#troubleshooting)

## Roles and naming

| Role      | Roster name                            | Purpose                                                                                   |
| --------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| planner   | `planner`                              | Operator-facing tier. Plans, files tasks and decisions. Keeps its approval prompts.       |
| dispatch  | `operator-dispatch`                    | Ingests briefs, queues tasks, watches verdicts, clears executors, reports to the planner. |
| executors | `executor-alpha` .. `executor-epsilon` | Each claims one task at a time from the board and runs `/ai-sdlc execute`.                |

Each agent runs in its own detached tmux session. The session name equals the window name
equals the agent name, so two terminals can show two agents at once.

Names are project-qualified: `<project>-<role>`, for example `ai-sdlc-executor-alpha`. The
project defaults to the repository directory's basename (sanitised). `--project <name>`
is required, with a value distinct from the other hierarchy's, when sessions with the same
role names already run for another project on this machine; otherwise `up` refuses
(see [troubleshooting](#troubleshooting)). Anywhere a command takes an agent name, the
unqualified role name (`executor-beta`) also works and selects the agent in this
repository's roster only.

## On-disk state

All state lives under the dispatch board directory, `.ai-sdlc/dispatch/` by default
(`--board-dir <path>` on any command overrides it).

| Path                               | Contents                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `.ai-sdlc/dispatch/hierarchy.json` | The roster (written atomically, validated against `spec/schemas/hierarchy-roster.v1.schema.json`). |
| `.ai-sdlc/dispatch/queue/`         | Manifests waiting to be claimed.                                                                   |
| `.ai-sdlc/dispatch/inflight/`      | Manifests claimed by a worker (`workerId` equals the roster name), plus heartbeats.                |
| `.ai-sdlc/dispatch/done/`          | Verdicts for tasks that finished with `success` or `iterate-needed`.                               |
| `.ai-sdlc/dispatch/failed/`        | Diagnostics and verdicts for every other outcome.                                                  |
| `.ai-sdlc/dispatch/blocked/`       | Manifests parked while they wait on a decision.                                                    |
| `.ai-sdlc/dispatch/briefs/`        | Dispatch briefs written by `brief`.                                                                |

### Roster shape

`hierarchy.json` is `{ "schemaVersion": "v1", "sessions": [ ... ] }`. Each session entry has:

| Field            | Meaning                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `role`           | `planner`, `operator-dispatch` or `executor`.                      |
| `project`        | The project the name is qualified with.                            |
| `name`           | The name the harness registered (normally equal to `tmuxSession`). |
| `tmuxSession`    | tmux session name; equal to `tmuxWindow`.                          |
| `tmuxWindow`     | tmux window name.                                                  |
| `paneId`         | tmux pane id (`%N`); keystrokes are sent only to this pane.        |
| `pid`            | Process id used to identify the session from its process tree.     |
| `model`          | Model the session was started with.                                |
| `permissionMode` | Permission mode it was started with.                               |
| `startedAt`      | ISO timestamp.                                                     |
| `status`         | `starting` or `running`.                                           |

## Commands

All commands accept `--board-dir <path>` (default `.ai-sdlc/dispatch`). Exit codes: `0`
success, `1` a refusal or runtime error (message on stderr), `2` a usage error (missing or
malformed argument). `--help`, `-h` or `help` prints the usage and exits 0.

### `up`

Start the planner, the dispatch session and up to five executors, each in its own detached
tmux session, and write the roster. Idempotent: sessions already running are left alone and
only the missing ones are started.

```bash
cli-hierarchy up [--executors <n>] [--planner-model <m>] [--dispatch-model <m>]
                 [--executor-model <m>] [--no-planner] [--project <name>]
                 [--attach] [--allow-planner-bypass]
```

| Option                   | Meaning                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `--executors <n>`        | Number of executors, 0 to 5 (default 5).                                     |
| `--planner-model <m>`    | Planner model (default `fable`).                                             |
| `--dispatch-model <m>`   | Dispatch model (default `sonnet`, per DEC-0068).                             |
| `--executor-model <m>`   | Executor model (default `sonnet`).                                           |
| `--no-planner`           | Do not start a planner.                                                      |
| `--project <name>`       | Project the names are qualified with (default the repository basename).      |
| `--attach`               | Show the planner (or the dispatch session when there is none) when done.     |
| `--allow-planner-bypass` | Allow the planner to start in `bypassPermissions` mode (refused by default). |

The planner starts in the permission mode from the operator's settings (falling back to
`default`); dispatch and executors start in `bypassPermissions`.

Preflight, all before anything starts:

- **Settings.** When any bypass session is to start, the effective `crossSessionInbound`
  setting must be `accept` (user settings, `.claude/settings.json`, `.claude/settings.local.json`),
  or lower-tier messages are not delivered. `up` refuses with the exact fix otherwise.
- **Planner mode.** A planner that would start in `bypassPermissions` is refused unless
  `--allow-planner-bypass` is given.
- **Resource gate.** At least 4 GiB of memory available and a 1-minute load average below the
  core count; `AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE=1` overrides it (testing only).
- **Foreign sessions.** Live sessions on the machine with the same role names for another
  project make `up` refuse unless `--project` is given.
- **Roster.** An old single-session-layout roster is refused (run `down` first); a second
  planner is never started.

`--no-planner` consequence: no planner session starts, so the planner is not a roster member,
and the dispatch session reports only to planners in the roster. With no planner in the
roster its reports have nowhere to go; use it only when a planner already runs elsewhere
and you will read the board yourself, or when you want a headless drain.

Effects: creates tmux sessions, marks each with the `@ai-sdlc-hierarchy` ownership option
(`down`, `clear` and `brief --notify` act only on marked sessions), writes `hierarchy.json`
and emits a `HierarchySessionStarted` event per session. Exit code: `0` (or the attach exit
code with `--attach`), `1` on any refusal or a failed tmux start.

```bash
cli-hierarchy up --executors 3 --project billing-api
```

### `status`

Show the roster with each session's live state (`busy`, `idle`, `starting`, `gone`,
`unknown`), whether a tmux client is attached, and the board's inflight task, plus the queue
counts.

```bash
cli-hierarchy status [--json]
```

`--json` prints one JSON object: `{ "rows": [ { "entry": <roster entry>, "state": "...",
"attached": true|false, "inflightTask": "AISDLC-N" } ], "board": { "queued": n,
"inflight": n, "done": n, "failed": n } }`. Read-only. Exit code `0`.

### `attach`

Show one agent in this terminal: `switch-client` when `TMUX` is set, `attach-session`
otherwise.

```bash
cli-hierarchy attach <name>
```

`<name>` is the tmux window name, the registered name or the unqualified role name. An
unknown name exits 1 and lists the valid names; no name exits 2. Exit code otherwise is the
tmux command's.

### `terminals`

Generate a VS Code `tasks.json` with one dedicated terminal per agent, each running
`cli-hierarchy attach <name>`, and a compound task `hierarchy: open all agents`.

```bash
cli-hierarchy terminals --vscode [--out <dir>] [--force] [--print]
```

| Option        | Meaning                                                   |
| ------------- | --------------------------------------------------------- |
| `--vscode`    | Required; the only supported target (without it, exit 2). |
| `--out <dir>` | Output directory (default `./.vscode`).                   |
| `--force`     | Replace an existing `tasks.json`.                         |
| `--print`     | Print the JSON to stdout instead of writing a file.       |

Writes `<out>/tasks.json` atomically; refuses an existing file without `--force`. Exit `0`,
or `1` on a refusal.

### `brief`

Write a dispatch brief (waves and sequence groups) from task metadata, and optionally tell
the dispatch session about it.

```bash
cli-hierarchy brief --tasks <id,...> | --rfc <RFC-NNNN> [--out <path>] [--force] [--notify]
```

| Option             | Meaning                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `--tasks <id,...>` | Task ids to include.                                                                       |
| `--rfc <RFC-NNNN>` | Include every open task that references the RFC.                                           |
| `--out <path>`     | Output file (default `.ai-sdlc/dispatch/briefs/<slug>.md`).                                |
| `--force`          | Replace an existing brief.                                                                 |
| `--notify`         | Message the dispatch session that the brief is ready; an existing brief is kept as edited. |

Prints `wrote <file>` or `kept existing <file>`, then `notified '<dispatch name>'` with
`--notify`. Exit `0`, `1` on a refusal (unknown task, brief exists without `--force`, no
running dispatch session for `--notify`).

```bash
cli-hierarchy brief --rfc RFC-0051 --notify
```

### `down`

End sessions, return their inflight manifests to `queue/`, close their windows and update
the roster.

```bash
cli-hierarchy down [--role <name-or-role>]
```

`--role` stops one session by name (`executor-beta`) or a role (`executor` selects all
executors); with no option every session stops. Each session is asked to exit and gets a
grace period; a window that stays open is closed by pane id. A session that does not carry
the ownership marker, or whose recorded pane no longer belongs to it, is refused and left
in the roster. Effects: manifests held by a stopped session move from `inflight/` to
`queue/`; stopped entries are removed from `hierarchy.json`. Exit `0`; `1` when any
session was refused or `--role` matches nothing.

### `clear`

Empty an executor's context between tasks: send `/clear`, wait for the settle time, then
send `/ai-sdlc executor` so the loop restarts.

```bash
cli-hierarchy clear <executor-name> [--settle-ms <n>]
cli-hierarchy clear --self [--resume-after <seconds>]
```

| Option                     | Meaning                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `--settle-ms <n>`          | Wait between the two keystrokes (default 8000).                                               |
| `--self`                   | Schedule the calling session's own pane to receive `/clear`, then `/ai-sdlc operator-dispatch` (dispatch session) or `/ai-sdlc executor` (an idle executor). |
| `--resume-after <seconds>` | With `--self`: upper bound on the delay before the resume command (default 60); a new brief or verdict file wakes it sooner; `/clear` is typed after 20 s. Refused when `TMUX_PANE` is unset. |

`clear <executor>` is a dispatch-session command; `clear --self` is also open to an executor
that holds no inflight task, which is how an idle executor returns to the context floor.
A mistake guard resolves the caller from the process tree and the
roster and exits 1 for anyone else (not authentication). `clear <executor>` refuses an
executor that holds an inflight task, is not a running executor, or lacks the ownership
marker, and sends keys only to the pane the roster names. Prints a JSON result and records
an `ExecutorContextCleared` event. After a clear the plugin's `SessionStart` hook
re-injects the role, so the executor's loop resumes with no re-briefing. Exit `0`, `1` on a
refusal, `2` on a malformed number or missing name.

### `executor-start`

An executor's whole start-up in one call that costs no model calls while it waits: roster
identity (the calling session must be a running executor), the `check-repo` test, then a
blocking claim (`cli-dispatch claim --wait`, which wakes on a change to `queue/` and re-checks
every 2 s).

```bash
cli-hierarchy executor-start [--wait <seconds>]
```

Prints the `[executor] I am '<name>'` identity line, then one JSON line
`{"name", "project", "dispatch", "taskId": "<id>"|null, "manifest": {...}}`. `--wait` defaults to
1500. Because that exceeds the Bash tool's 600 s foreground cap, the executor runs it with the Bash
tool's `run_in_background: true`, stops its turn, and reads the JSON when the completion
notification re-invokes the session. Exit `1` when the session is not an executor or the working directory is not the project's
repository.

**Idle path.** When `taskId` is `null` the executor runs `cli-hierarchy clear --self --resume-after 30`
and stops; 20 s later its context is cleared and `/ai-sdlc executor` restarts it from the
context floor, so an idle executor costs one short turn per ~25 minutes rather than a poll
every 30 s on a large context. With no tmux pane to clear it falls back to `ScheduleWakeup`
after `spec.inSessionAgent.emptyQueueHibernateSec` (default 1800 seconds).

### `tick`

One wake-up of the dispatch loop: ingest briefs, handle new verdicts (clear the finished
executor, run the unblocking playbook), and print the escalations and reports to send, as
JSON.

```bash
cli-hierarchy tick [--worker <dispatch-name>] [--report-every-ms <n>] [--settle-ms <n>]
                   [--retry-limit <n>] [--work-dir <path>]
```

| Option                  | Meaning                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `--worker <name>`       | Optional; when given it must equal the calling session's own roster name. |
| `--report-every-ms <n>` | Spacing of progress reports (default 900000).                             |
| `--settle-ms <n>`       | Settle time used for clears (default 8000).                               |
| `--retry-limit <n>`     | Re-queues allowed per failed task (default 2; a larger value is refused). |
| `--work-dir <path>`     | Repository root (default the current directory).                          |

Dispatch-session command, guarded like `clear`. Effects: moves manifests into `queue/`,
requeues failed tasks within the retry limit, clears executors whose tasks reached a
verdict, and flips CodeQL-clean drafts ready when `mark-ready-after-codeql` is granted.
The JSON also carries the caller's `identity` (`name`, `planner`), the `handoff` file text,
`selfClear` (whether `TMUX_PANE` is set) and `nextWakeSec`/`wakeReason`: 30 when a brief or
verdict was handled, 300 when work is queued or inflight, 1800 when the board is empty and
nothing is inflight. The session sleeps that long (a new brief or verdict file wakes it
early), so an idle board costs at most two model calls an hour. A draft PR whose CodeQL
run is still pending waits up to the idle interval (1800 s) before mark-ready flips it, and
a standing failed Analyze job does not shorten the sleep. Exit `0`; `1` on a guard refusal; `2` on a malformed number or a retry limit above
the cap.

### `route-decision`

Record that a decision was routed to a tier (emits a `DecisionRouted` event).

```bash
cli-hierarchy route-decision --decision-id <id> --route operational|design --to <name>
                             [--task-id <id>] [--worker <name>]
```

| Option               | Meaning                                                     |
| -------------------- | ----------------------------------------------------------- |
| `--decision-id <id>` | Decision Catalog id (`DEC-0000`).                           |
| `--route <name>`     | `operational` or `design`.                                  |
| `--to <name>`        | Session name or role that now owns the decision.            |
| `--task-id <id>`     | Task the decision belongs to (optional).                    |
| `--worker <name>`    | Optional; must equal the calling session's own roster name. |

Dispatch-session command, guarded like `clear`. Prints `{ok, decisionId, route, routedTo}`.
Exit `0`, `1` on a guard refusal, `2` on a missing or invalid argument.

### `check-sender`

Exit 0 only when the sender of a message is this roster's running dispatch session. The
executor skill runs it before acting on an instruction.

```bash
cli-hierarchy check-sender [--sender-pid <n>] [--sender-ref <ref>]
```

The sender is compared by pid or harness session ref, never by a name written in the message
text. A mismatch prints `not my dispatch session` and exits 1. When the harness reports
neither a pid nor a ref the check fails open: a warning on stderr, `{"ok":true,"verified":false}`
on stdout, exit 0. Read-only.

### `check-repo`

Exit 0 only when the working directory is in the repository that owns this roster's board.

```bash
cli-hierarchy check-repo
```

Prints `{"ok":true,"project":"<project>"}` on success; otherwise the reason on stderr and
exit 1 (including a roster that mixes projects). Read-only.

## Operating cycle

The cycle is **brief, tick, clear**:

1. **brief.** The planner writes a brief with `cli-hierarchy brief --tasks ... --notify`
   (or `--rfc`). The brief lists waves and sequence groups; `--notify` tells the dispatch
   session it is ready.
2. **tick.** The dispatch session runs `cli-hierarchy tick` on a schedule. Each tick ingests
   briefs into `queue/`, handles new verdicts, and returns the reports and escalations to
   send. Executors claim from `queue/` on their own.
3. **clear.** When an executor's task reaches a verdict, the tick clears that executor
   (`clear <executor>`), which restarts its loop with an empty context.

Self-clear rule: **one task per executor context**, and **the dispatch session clears itself
after every tick** (`clear --self`, refreshing its handoff file first), so every tick starts
from the context floor. The self-clear needs tmux (`TMUX_PANE`); a dispatch session outside
tmux is refused by `clear --self` and stops rather than polling with a growing context. The planner clears at 150k tokens of context.

How `clear` interacts with an executor's loop: the executor's loop ends after it reports a
verdict (step "Stop" in [The executor loop](parallel-dispatch.md#the-executor-loop)); `clear`
then empties the context and types `/ai-sdlc executor`, starting a fresh pass. An executor
that still holds an inflight task is never cleared, so work in progress is never destroyed.

## Restarting after a plugin upgrade

Sessions load the plugin once, when they start. A new plugin version (commands, hooks,
role text) is picked up only after `cli-hierarchy down` followed by `cli-hierarchy up`;
`clear` does not reload the plugin. `down` returns inflight manifests to `queue/`, so the
restart loses no queued work, but finish or accept the loss of any task in flight first.

## Troubleshooting

**`up` refuses over a stale roster.** The message `the roster uses the old single-session
layout` means `hierarchy.json` came from before one-session-per-agent; run `down`, then `up`.
Entries whose tmux session is gone are dropped with a warning and restarted if planned. A
roster that does not match the schema fails every command with the schema error; fix or
remove `.ai-sdlc/dispatch/hierarchy.json` after running `down`.

**`up` says sessions with the same role names already run for another project.** Another
hierarchy on this machine uses the bare names (`planner`, `executor-alpha`); their names
could receive this hierarchy's messages. Run `up --project <distinct-name>`, or stop those
sessions.

**`attach` reports `no agent named '<name>' in the roster`.** The error lists the valid
names. Run `status` to see the roster; an agent absent from it needs `up`. A roster entry
with a `gone` state needs `up` to restart it.

**`attach` or `clear` says the tmux session is not running.** The session ended outside
`down`. Run `up`: it drops the dead entry and starts a replacement.

**`down` or `clear` refuses a session.** It lacks the `@ai-sdlc-hierarchy` ownership option
(a personal tmux session sharing the name) or its pane id no longer matches the roster. The
session is left alone; stop it by hand if it is yours.

**`clear`, `tick` or `route-decision` exits 1 with a caller message.** Only the running
dispatch session may run them. Run them from that session.

**Reading `status --json`.** `state` `busy` or `idle` come from the harness registry; `gone`
means the tmux window is closed; `starting` means the harness has not registered the
session; `unknown` means it is open but absent from the registry. `inflightTask` names the
task the session's heartbeat holds; an executor with `idle` and no `inflightTask` is ready
to claim. `board.queued` of 0 with all executors idle means the queue is drained.

## Sending a finished task back (resume)

A task in `done/` whose pull request later goes red (a coverage shortfall, a stale
attestation after a rebase, reviewer findings) goes back to an executor, not to a second
`/ai-sdlc execute` and not to a push from the dispatch session: the hook binds a push to
the task's own worktree, which only its executor holds.

```bash
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" resume --board-dir "$BOARD_DIR" \
  --task-id "<task-id>" --pr "<number>" --failing-checks "<check,check>" \
  --note "<what the executor must fix>" [--finding "<reviewer finding>"]
```

It needs the same `requeue` grant as `requeue` and runs only from the dispatch session. The
task returns to `queue/` with the note on its manifest and is claimed like any other task
(an idle executor claims it within a minute). `executor-start` prints the note before the
task runs; the pipeline then re-enters the existing worktree and branch (never `origin/main`),
re-writes `.active-task`, injects the note into the developer prompt, re-runs the reviewers,
re-signs the attestation, lease-pushes from that worktree and updates the existing pull
request. The command exits 1, changing nothing, when the task is not in `done/`.
`cli-dispatch idle-backoff` prints the sleep (5 to 60 seconds) an executor without a tmux
pane uses when the queue is empty.
