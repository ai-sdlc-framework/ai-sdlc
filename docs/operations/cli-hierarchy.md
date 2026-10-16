# `cli-hierarchy` Reference

`cli-hierarchy` starts, inspects and stops the session hierarchy: a planner, a dispatch
session and up to five executors, each a Claude Code session in its own tmux session.
It replaces `/ai-sdlc execute-parallel`; the executor loop, the dispatch loop, liveness and
the cancel back-channel are documented at the end of this page. RFC: [RFC-0051](../../spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md).

The documented entry point is the plugin command, which runs `cli-hierarchy` from the
resolved pipeline-cli bin (works from an installed plugin, not only the dogfood repo):

```text
/ai-sdlc hierarchy <command> [options]
```

It passes `up`, `status`, `attach`, `terminals`, `brief` and `down` through unchanged,
with these differences: `attach` and `up --attach` print the shell command to run (a
Claude Code session cannot switch your terminal); `down` with no `--role` asks you to
confirm first; `clear`, `tick`, `restart`, `register`, `route-decision`, `check-sender`, `check-repo` and
`executor-start` are refused (they belong to the dispatch and executor loop bodies); with no arguments it
prints `--help` plus a common-recipes block.

The fallback is the bare binary, from the repository root:

```bash
node pipeline-cli/bin/cli-hierarchy.mjs <command> [options]
```

The planner session can show a live context meter with compact, clear and hand-off actions:
see [`context-meter.md`](context-meter.md).

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
- [Dispatch tick: PR and board state machine](#dispatch-tick-pr-and-board-state-machine)
- [Restarting after a plugin upgrade](#restarting-after-a-plugin-upgrade)
- [Troubleshooting](#troubleshooting)
- [Quota and cost events](#quota-and-cost-events)
- [HC_design three-state diagnostic (AISDLC-171)](#hc_design-three-state-diagnostic-aisdlc-171)
- [Fork-PR workflow safety pattern (AISDLC-381)](#fork-pr-workflow-safety-pattern-aisdlc-381)
- [Liveness detection and session reaper](#liveness-detection-and-session-reaper)
- [Cancel back-channel](#cancel-back-channel)
- [The executor loop](#the-executor-loop)
- [The operator-dispatch loop](#the-operator-dispatch-loop)

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
| `.ai-sdlc/dispatch/retired/`       | Queued manifests retired by `dequeue`, with `retiredReason` and `retiredAt`.                       |
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
                 [--attach] [--planner-permission-mode <m>] [--allow-planner-bypass]
                 [--no-vscode-tasks] [--node <version>]
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
| `--planner-permission-mode <m>` | Planner permission mode (default `bypassPermissions`); `default` gives a prompting planner. |
| `--allow-planner-bypass` | Deprecated, no effect (prints a deprecation line); every session starts in `bypassPermissions`. |
| `--no-vscode-tasks`      | Do not regenerate `.vscode/tasks.json` (see below).                          |
| `--node <version>`       | Node version every session runs under (default: the version in `.nvmrc`).    |

**Pinned Node (AISDLC-812).** Every session command starts by loading nvm and running
`nvm use <version>`, so the Node a session runs under never depends on the launching
shell's default. The version is `--node <version>` when given, otherwise the first line of
`.nvmrc` in the repository root (22.23.2, per DEC-0060); `.nvmrc` is the single source of
truth. Without either, sessions inherit the launching shell's Node. `up` checks
`$NVM_DIR/versions/node` before starting anything and refuses when the version is not
installed, naming the next step (`nvm install <version>`). Only plain versions (`22`,
`22.23.2`, `v22.23.2`) are accepted. Five-step review: the requirement (sessions run the
engines Node, AISDLC-801 / DEC-0113) stays; the dependence on the operator's shell default is
deleted; the launch prefix replaces a manual `nvm use`; `status` surfaces a mismatch instead
of a mid-task Step 3 failure.

**VS Code tasks file (AISDLC-754).** After writing the roster, when at least one session was
started or the roster changed, `up` regenerates `<cwd>/.vscode/tasks.json` (the same document
`terminals --vscode` writes) if the file is absent or was written by us. "Written by us" means
a top-level marker `"ai-sdlc": { "generated": true, "roster": "<board-dir>/hierarchy.json" }`.
A file without the marker is never overwritten; `up` prints one line saying to merge by hand
with `cli-hierarchy terminals --vscode --print`. A second `up` that starts nothing leaves the
file byte-identical, and `down` leaves it alone. `--no-vscode-tasks` skips all of this for
operators who manage the file themselves. When `up` runs in a VS Code terminal
(`TERM_PROGRAM=vscode` or `VSCODE_GIT_IPC_HANDLE` set) it ends with one line:
`VS Code: run task "hierarchy: open all agents" (Terminal > Run Task) to open one terminal per agent`.

**VS Code extension (AISDLC-755).** The private workspace package `vscode-hierarchy/`
(`vscode-hierarchy`) is a VS Code extension that opens one integrated terminal per
roster agent as `.ai-sdlc/dispatch/hierarchy.json` changes (in the opened folder or one level
below), each running `node <cli-hierarchy.mjs> attach <name>`. Terminals are transient, are
disposed when the agent leaves the roster or the roster is deleted, and a terminal you close is
not reopened until the next roster write. Install:

```
pnpm --filter vscode-hierarchy package
code --install-extension vscode-hierarchy/dist/ai-sdlc-vscode-hierarchy.vsix
```

Settings: `aiSdlc.hierarchy.autoOpen` (default `true`), `aiSdlc.hierarchy.focusNew` (default
`false`), `aiSdlc.hierarchy.pipelineCliBin` (absolute `cli-hierarchy.mjs`, used only when it is
not under the repository's `pipeline-cli/bin` or the Claude plugin cache). Commands:
`AI-SDLC: Open all hierarchy agents` and `AI-SDLC: Close all hierarchy agents`. The extension
sets `AI_SDLC_VSCODE_HIERARCHY=1` in integrated terminals, and `up` then omits the run-task hint
above. `.vscode/extensions.json` recommends it.

Every session, the planner included, starts in `bypassPermissions` (the mode
`claude --dangerously-skip-permissions` selects): the hierarchy is unattended for most of the
day and hooks, not prompts, are the control surface. `--planner-permission-mode <m>`
overrides the planner only. The operator's own `defaultMode` setting does not influence it.
An operator who relied on a prompting planner must now pass `--planner-permission-mode default`.

Every session is started with `AI_SDLC_HIERARCHY_SESSION=<qualified name>` and
`AI_SDLC_HIERARCHY_ROLE=<planner|operator-dispatch|executor>` in its environment, so the
plugin hooks see them at launch and the agent's own Bash commands cannot change them.

**Launch-env contract (AISDLC-791, DEC-0079, DEC-0080).** The prefix is not optional: the
lease-push hook binds an executor by it, and an executor launched bare (`claude --name ...`)
has every lease push refused with `not-task-worktree`. `up` asserts the command carries both
assignments before it starts a session and refuses otherwise. A bare launch comes only from
an `up` run out of an older `pipeline-cli` build, so `resolve-pipeline-cli.sh` prefers the
main checkout's build, prints its dist mtime, and exits 1 with the build command when
`dist/hierarchy/up.js` is missing or older than `src/hierarchy/up.ts`. `status` and
`ai-sdlc doctor` (check `hierarchy-launch-env`) read each running entry's tmux
`#{pane_start_command}` and flag a missing prefix. `clear` never relaunches a process, so the
only repair is `down --role <role>` then `up` from the main checkout's build.

**Executor lease push (AISDLC-756).** Executors are rooted at the main checkout and claim a
task only after launch, so the lease-push guard (`spec.governance.allowForcePush:
leaseOnOwnBranch`) cannot bind them with `AI_SDLC_ACTIVE_TASK_ID`. For a main-rooted session it
accepts the cwd task worktree when either that variable equals the worktree's `.active-task`,
or `AI_SDLC_HIERARCHY_ROLE` is `executor` and the board's `inflight/` holds exactly one
manifest claimed (heartbeat `workerId`) by this session, for the task in the worktree's
`.active-task`. The dispatch and planner roles hold no claim and get no path. All the
other worktree checks stay, and only the explicit `HEAD:refs/heads/<own-branch>` spelling is
accepted. Hooks run from the installed plugin, so a restart (`down` then `up`) is needed
after the plugin upgrade that ships this.

Preflight, all before anything starts:

- **Settings.** Because every session starts in bypass mode, the effective `crossSessionInbound`
  setting must be `accept` (user settings, `.claude/settings.json`, `.claude/settings.local.json`),
  or lower-tier messages are not delivered. `up` refuses with the exact fix otherwise.
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
counts. The table also lists each session's `HIERARCHY_SESSION` and `HIERARCHY_ROLE` values.
The `ENV` column is `ok` when the session's tmux start command carries
`AI_SDLC_HIERARCHY_SESSION=<name>` and `AI_SDLC_HIERARCHY_ROLE=<role>`, `missing` when it does
not (a bare launch; the repair line follows the table), and `-` for a gone window.
The `NODE` column is the Node version the pane's processes run, read from the process table
(`ps`), with `MISMATCH` appended when it does not satisfy `.nvmrc`; a repair line follows the
table. It is `-` when no nvm-managed node process runs under the pane or `ps` cannot be read.
The last line is the webhook receiver: `webhook: up (port N)` when running, `webhook: off (no secret)`
when `AI_SDLC_WEBHOOK_SECRET` is unset, `webhook: off (not running)` otherwise.
A final `unbriefed` line lists dispatchable open tasks under `backlog/tasks/` that are on no
brief and not on the board (nothing would ever queue them); write a brief for them.

```bash
cli-hierarchy status [--json]
```

`--json` prints one JSON object: `{ "rows": [ { "entry": <roster entry>, "state": "...",
"attached": true|false, "inflightTask": "AISDLC-N", "launchEnv": "ok|missing",
"nodeVersion": "22.23.2", "nodeMismatch": true, "nextStep": "..." } ], "board": { "queued": n,
"inflight": n, "done": n, "failed": n }, "webhook": { "state": "up", "port": n, "pid": n } }`. Read-only. Exit code `0`.

### `webhook`

The local GitHub webhook receiver (RFC-0054, AISDLC-880). A delivery is a trigger, never a fact:
after the `X-Hub-Signature-256` HMAC check the receiver writes one event record into
`.ai-sdlc/dispatch/events/` (create-if-absent, named by `<repo>#<pr>@<headSha>:<kind>:<deliveryId>`,
URL-encoded) holding `repo`, `pr`, `headSha`, `kind`, `deliveryId` and `receivedAt`, and nothing else.
A replay of a delivery id returns 200 and writes nothing; a missing or wrong signature returns 401 and
writes nothing. After a record is written, deliveries for the same `(pr, headSha)` are debounced for 5 s
and then the file `.ai-sdlc/dispatch/wake` is touched, once. The receiver never classifies or acts.

```bash
AI_SDLC_WEBHOOK_SECRET=... cli-hierarchy webhook up [--port 8765]
cli-hierarchy webhook status [--json]
cli-hierarchy webhook down
```

The secret comes only from the `AI_SDLC_WEBHOOK_SECRET` environment variable, never a file in the
repository. Without it `webhook up` does nothing and dispatch stays poll-only (not an error). The
receiver binds to `127.0.0.1` only, on `--port` or `AI_SDLC_WEBHOOK_PORT` (default 8765), at path
`/webhooks/github`. `cli-hierarchy up` starts it when the secret is set. Subscribed event kinds:
`pull_request`, `check_suite`, `check_run`, `workflow_run`, `status`, `pull_request_review`.

Reaching it from GitHub, with the repository webhook's secret equal to `AI_SDLC_WEBHOOK_SECRET`:
`gh webhook forward --repo <owner>/<repo> --events pull_request,check_suite,check_run,workflow_run,status,pull_request_review --url http://127.0.0.1:8765/webhooks/github`
for development, or a named tunnel (for example Cloudflare Tunnel) pointing at `127.0.0.1:8765` for daily
use.

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
`node <abs path of cli-hierarchy.mjs> attach <name>` (command `node` plus an `args` array, so
it works where `cli-hierarchy` is not on `PATH` and survives spaces in the path), and a
compound task `hierarchy: open all agents`. Each agent task is `isBackground` with
`echo: false`, `clear: true`, and the file carries the `ai-sdlc.generated` marker that lets
`up` regenerate it.

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

**Auto-brief (AISDLC-930).** `cli-file task <path> --pr` also writes
`.ai-sdlc/dispatch/briefs/tasks-<id>.md` on the local board: one entry, no `after`, wave 1,
priority from the task frontmatter. The next tick ingests it, so a filed task reaches the
board without a planner pass. `--no-brief` skips it. A `dispatchable: false` task, one with
`blocked.reason`, and an existing brief of that name get none. A task already on the board is
skipped on ingest, so a later hand-written brief naming it is harmless. Still write a brief by
hand when the task has dependencies (`after`), belongs to a sequence group, or needs a hold:
use `--no-brief` and `cli-hierarchy brief`.

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

### `restart`

Stop and start one executor without touching the rest of the hierarchy.

```bash
cli-hierarchy restart <executor> [--after-task] [--wait <seconds>]
```

`<executor>` is a roster name, a tmux window or the unqualified name (`executor-beta`).
The session is asked to exit (closed by pane id when it stays open), then started again
with the model, permission mode and launch environment its roster entry records. Its roster
entry (pid, pane, started time) is replaced in one atomic write; no other entry, window or
inflight manifest is touched, and the dispatch session keeps running. A window that is
already gone (a crash) is simply started.

An executor that holds a claimed task is refused: the message names `--after-task`. With
`--after-task` the command waits for the task boundary (up to `--wait` seconds, default
1500; nothing is stopped if the wait runs out), then restarts. If the executor claims its
next task in the instant between the last check and the stop, that manifest is returned to
`queue/` right after the stop (the JSON shows it as `requeued`). The roster is re-read just
before the write, so a change to another entry made during the wait is kept. If the new session cannot be started, its dead entry
is dropped from the roster and the message says to run `cli-hierarchy up`.

Dispatch session only (the same mistake guard as `clear`, not authentication); executors
only. The planner and dispatch sessions are refused with the `down --role` then `up` path.
A session without the ownership marker, or whose recorded pane no longer belongs to it, is
refused and left running. Prints the before and after pid, start time and pane as JSON.
Exit `0`; `1` on a refusal.

### `register`

Re-record an executor that is already running under a new pid, for example after it was
restarted by hand.

```bash
cli-hierarchy register <executor>
```

Before writing it checks that the tmux window is open, carries the ownership marker, has a
readable pane whose start command carries this session's `AI_SDLC_HIERARCHY_SESSION` and
`AI_SDLC_HIERARCHY_ROLE`, and that a live harness session of that name is registered in this
checkout whose pid is the pane's process or one of its descendants. It then replaces that entry's pid, pane and started time (status `running`) and
nothing else; a pid that belongs to another roster entry is refused, and an entry that
already matches is left unchanged. It does not wait for tasks, because the roster's task
binding is the session name, not the pid. Same caller and role rules as `restart`.

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
| `--self`                   | Schedule the calling session's own pane to receive `/clear`, then `/ai-sdlc operator-dispatch` (dispatch session), `/ai-sdlc:planner` (planner) or `/ai-sdlc executor` (an idle executor). |
| `--resume-after <seconds>` | With `--self`: upper bound on the delay before the resume command (default 60); a new brief or verdict file wakes it sooner; `/clear` is typed after 20 s. Refused when `TMUX_PANE` is unset. |

`clear <executor>` is a dispatch-session command; `clear --self` is also open to the planner
and to an executor that holds no inflight task, which is how an idle executor returns to the
context floor.
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

### `handoff`

Write or read a session's handoff file. The file is generated from board and catalog state
(roster, queue, inflight tasks, blocked and failed tasks, open decisions), never from prose,
so it cannot go stale by omission.

```bash
cli-hierarchy handoff write --role <planner|operator-dispatch|executor> [--name <n>] [--out <path>]
cli-hierarchy handoff read  --role <planner|operator-dispatch|executor> [--name <n>] [--out <path>]
```

| Option         | Meaning                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| `--role <r>`   | `planner`, `operator-dispatch` (alias `dispatch`) or `executor`.                             |
| `--name <n>`   | Session name; default the calling session's roster name, else the role.                      |
| `--out <path>` | Use another file location.                                                                   |

Files: dispatch and executors write `.ai-sdlc/dispatch/handoff/<session-name>.md`; the planner
writes its dated memory file, `.claude/memory/project_planner_handoff_YYYY_MM_DD.md` (an
existing dated file is reused). The generated text sits between
`<!-- ai-sdlc-handoff:begin -->` and `<!-- ai-sdlc-handoff:end -->` with a hash of the state it
was built from; text outside the markers (the planner's own notes) is kept on every rewrite.

Call `write` after each state change (a ruling recorded, a task claimed, a verdict written, a
brief sent). `read` recomputes the hash first and regenerates a missing or stale file, so a
stale file is never read as current.

**Resume contract.** After any `/clear`, the first thing a loop body does is
`handoff read --role <r>`; the file and the board are all a fresh context needs. The resume
command per role is `/ai-sdlc:planner`, `/ai-sdlc operator-dispatch` and `/ai-sdlc executor`.

### `auto-clear`

The Stop hook of the plugin (`context-auto-clear`) runs this after each turn of a session that
is in the roster; any other session is a no-op.

```bash
cli-hierarchy auto-clear --transcript <path>
```

It reads the session's current context size (input plus cache tokens of the newest assistant
usage entry in `--transcript`) and compares it with the role's threshold. Over it, it writes
the handoff and runs the `clear --self` machinery with the role's resume command; the result is
cleared within one turn without the operator. An executor that holds an inflight task is never
cleared: the command reports `defer`, and the first turn after its verdict is written clears it.
A clear scheduled in the last two minutes is not scheduled again.

| Role                | Default threshold (tokens) | Resume command              |
| ------------------- | -------------------------- | --------------------------- |
| planner             | 150000                     | `/ai-sdlc:planner`          |
| operator-dispatch   | 120000                     | `/ai-sdlc operator-dispatch` |
| executor            | 120000                     | `/ai-sdlc executor`         |

Thresholds are configurable in `.ai-sdlc/dispatch/config.json`:

```json
{ "contextThresholds": { "planner": 150000, "operator-dispatch": 120000, "executor": 120000 } }
```

Missing or invalid values fall back to the defaults. Set `AI_SDLC_AUTO_CLEAR=off` to switch the
hook off for a session.

### Context usage: status line, warning, handoff (AISDLC-728)

Three pieces work for all three roles; none of them blocks or refuses anything.

- **Status line.** `ai-sdlc-plugin/scripts/context-statusline.mjs` prints `ctx NN%`, green below
  the warn threshold, yellow from it, red from the crit threshold. Defaults 30 and 40 percent;
  set `AI_SDLC_CONTEXT_WARN_PCT` and `AI_SDLC_CONTEXT_CRIT_PCT` to change them. Enable it in
  settings: `{ "statusLine": { "type": "command", "command": "node <plugin>/scripts/context-statusline.mjs" } }`.
  It also records the percentage per session in `$TMPDIR/ai-sdlc-context-warn/<session>.json`.
- **Warning.** The `context-warn` Stop hook reads that record after each turn and, once the
  percentage reaches the crit threshold, shows one message: say "handoff", then `/clear`, or
  paste the `/compact Keep: ...` line it prints. It warns once per crossing and re-arms when the
  percentage falls below the warn threshold. `AI_SDLC_CONTEXT_WARN=off` silences it. The warning
  only appears once the status line has run for the session.
- **Reload.** SessionStart for sources `clear` and `compact` re-injects the role block and the
  output of `handoff read` (truncated to 12000 characters) for a roster session; for the planner
  it also says to list scheduled jobs and recreate lost ones. The planner's routine is in
  `commands/planner.md`; dispatch batches non-blocking reports to the planner into one hourly
  digest (`commands/operator-dispatch.md`). The executor's clear-between-tasks flow is unchanged.

**Not verified or not possible with documented APIs** (written offline): the exact status line
JSON fields (`context_window.used_percentage`, `session_id`), the Stop hook `systemMessage`
output field, and the SessionStart `compact` source name are taken from the task's notes and
must be checked against current Claude Code docs. A hook cannot run `/compact` or `/clear`; it
can only print a line to paste. A mod could call `$.session.compact({ instructions })` from a
button (the `context-meter` mod calls it without instructions today), and whether a mod can run
`/clear` is unverified, so clearing stays a human action (or the 150k auto-clear above).

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
verdict, flips CodeQL-clean drafts ready when `mark-ready-after-codeql` is granted, and
lands eligible own-author PRs when `land-eligible-prs` is granted.
The JSON also carries the caller's `identity` (`name`, `planner`), the `handoff` file text,
`selfClear` (whether `TMUX_PANE` is set) and `nextWakeSec`/`wakeReason`: 30 when a brief or
verdict was handled, 300 when work is queued or inflight, 1800 when the board is empty and
nothing is inflight. The session sleeps that long (a new brief or verdict file wakes it
early), so an idle board costs at most two model calls an hour. A draft PR whose CodeQL
run is still pending waits up to the idle interval (1800 s) before mark-ready flips it, and
a standing failed Analyze job does not shorten the sleep. Exit `0`; `1` on a guard refusal; `2` on a malformed number or a retry limit above
the cap.

**Landing step (AISDLC-894).** With the `land-eligible-prs` operational action granted in
`.ai-sdlc/agent-role.yaml`, every tick lists the open, non-draft pull requests whose author
is on the policy's `mergeAuthors` list and passes each through `runMergeIfEligible`, the one
governed path to a landing: policy read from main, author, head commit and required checks
are all re-verified, and this step issues no raw `gh` call that lands anything. When GitHub
auto-merge is available (`autoMergeAllowed` from `gh repo view`) the PR is armed, once per
head sha; when it is unavailable or cannot be read, the PR is squashed at once, but only
when it is green and CLEAN. A landing (squashed or armed) stamps `landed` (ISO-8601) on the
task's verdict in `done/`. A refusal is written once per head sha to
`<board>/notes/land-<pr>-<sha>.refused.txt`; the attempt is repeated each tick, since a
pending check turns green later. The tick result carries `landed` (`landed`, `refused`,
`error`). Without the grant the tick makes no arm or squash call.

**Stall check (AISDLC-826).** Every tick also checks each inflight claim once. The
pipeline refreshes the claim's heartbeat (`inflight/<task>.state.json`, `lastHeartbeat` and
`currentStep`) on every `next-step` transition, so a live executor is never silent for
longer than one step. A claim is stalled when its heartbeat is older than the stale
threshold (default 30 minutes, `AI_SDLC_DISPATCH_STALE_MS`), or when its holder session is
`idle`, `gone` or `unknown` in `status` and the heartbeat is older than the grace (default
10 minutes, `AI_SDLC_DISPATCH_STALL_GRACE_MS`) with no verdict in `done/` or `failed/`. A
stalled claim moves to `failed/` with `cause: stale-worker`, `lastStep` and
`heartbeatAgeMs`; the holder is cleared (which restarts its executor loop with
`/ai-sdlc:executor`) and the task is sent back with a note naming the step it stalled at
and any existing pull request number (`cli-dispatch reenter <pr> --note` when a PR exists,
so no developer re-runs; a plain `requeue` when none does).
The tick result carries `stalled` (`taskId`, `worker`, `ageMs`, `step`) and a progress line
per reap. This is operational: the planner is not asked. Clearing needs
`clear-executor-context` and the re-queue needs `requeue`; the playbook treats both
`stale-worker` and `stale-heartbeat` failures as re-queue-with-resume-note shapes.

**PRs needing a human (AISDLC-888).** Every tick lists each open PR whose title contains
`[needs-human-attention]`, or whose `done/` verdict is `iterate-needed` with the iteration
budget spent, as a progress line: PR number, age, draft or ready, merge state and open
finding count (read from the PR body). The tick result carries the same rows as
`humanAttention`. A flagged PR older than 24 hours adds one more line, `PR #N needs a human
for Nh`; no new notification channel is involved. The operator digest prints a
"PRs needing a human" section with the same rows and omits it when there are none. Both use
the single classifier `classifyHumanAttention` (`hierarchy/human-attention.ts`).

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
after every tick** (`clear --self`, regenerating its handoff with `handoff write` first), so every tick starts
from the context floor. The self-clear needs tmux (`TMUX_PANE`); a dispatch session outside
tmux is refused by `clear --self` and stops rather than polling with a growing context. Every role, the
planner included, also clears itself automatically when its context passes its [threshold](#auto-clear);
handoff files are regenerated by the CLI, so a session can be cleared at any moment.

How `clear` interacts with an executor's loop: the executor's loop ends after it reports a
verdict (step "Stop" in [The executor loop](#the-executor-loop)); `clear`
then empties the context and types `/ai-sdlc executor`, starting a fresh pass. An executor
that still holds an inflight task is never cleared, so work in progress is never destroyed.

## PR reconciler

The PR lifecycle is one state machine owned by code, not by the dispatch model (RFC-0054,
AISDLC-829). Five steps: the requirement "the model must look at PRs" is questioned, because
the facts are REST JSON and the decision is a table; Step 2b of `operator-dispatch.md`, the
`.pr-facts.json` file and the model-paced cadence are deleted; one reconciler, one record per
PR and one table remain; reaction time drops from the tick interval to the reconciler's run
time after an event; the reconciler runs itself, automated last. The tick runs one line,
`cli-dispatch reconcile --board-dir "$BOARD_DIR"`.

`cli-dispatch reconcile [--pr <n>] [--facts <facts.json>] [--watch]` lists open PRs (`gh pr
list` and `gh pr view` for checks), classifies each with `pipeline-cli/src/hierarchy/pr-state.ts`
(`classifyPr`, unchanged), writes `landing/<pr>.json` under the board and runs the one action
the table names. `--facts` reads a JSON array of PR facts instead of GitHub. It is idempotent:
facts that match the stored state, action, head SHA and owner change no file and run no
action. A PR that merged is detected through its record and marked `landed`.

**Kinds.** A PR on a docs branch (`ai-sdlc/file-*`, `ai-sdlc/decisions-sync*`, `docs/*`) or with
no task id is a docs PR; one with a task id (branch or title) is a task PR; the release-please
PR (`chore: release`, `release-please--*`) is reported and never acted on.

**Trust filter.** Facts gathering skips cross-repository (fork) PRs and PRs whose author is not
in the allow-list (`AI_SDLC_RECONCILE_AUTHORS`, comma separated, else the authenticated `gh`
user; unknown means no facts). A task PR is acted on only when the task's own board record
names its number (a verdict `prNumber` or `prUrl`, a resume signal, or the inflight manifest
branch); a PR that only names a task id in its branch or title is ignored.

**Record** (`landing/<pr>.json`): `pr`, `kind`, `taskId`, `owner`, `state`, `action`,
`headSha`, `failingLine`, `delivered`, `landed`, and `history` (one `{ts, state, action,
headSha}` per change). `owner` is `executor:<name>` until `delivered` (the PR flipped ready),
then `machine`; docs PRs are `machine` from creation, so no PR is ever unowned. `cli-dispatch
peek` and the brief-progress loop read `done/` only.

**Scheduler** (`pipeline-cli/src/hierarchy/scheduler.ts`, `reconcile --watch`): a reconcile
runs at start (session start or machine wake), within a 2 s debounce after the webhook
receiver touches `<board>/.reconcile-wake`, and on a timer of 60 s while any task or docs PR
is open, else 15 min. It is code, not a model turn; `cli-hierarchy clear --self
--resume-after` no longer paces PR handling. The tick's progress line lists open PRs as
`#<n> <kind> <state>`.

**Task action set** (acted on from `ready` on; before delivery the executor owns the PR, so
the action is `none`, except stale claims and takeover after executor death post-sign):

| Classifier state | Action | What runs |
|---|---|---|
| `merged` | `mark-landed` | record `landed`; done verdict, parent sync and dependants stay with the tick playbook |
| `manifest-branch-mismatch` | `rewrite-manifest` | left to a session (`write-manifest` with the PR head ref) |
| `stale-claim` | `reap-resume` | `cli-dispatch reap` |
| `behind-or-dirty` | `land-prep` | until AISDLC-881: `reenter` (rebases a BEHIND PR; a DIRTY one goes to an executor) ([hand-review-path.md](hand-review-path.md)) |
| `attestation-content-hash-mismatch` | `push-only-resign` | `reenter` (push-only re-sign manifest, AISDLC-821) |
| `real-failure` | `reenter` | `cli-dispatch reenter <pr>` (manifest with the failing line and head SHA) |
| `cancelled-or-infra` | `retrigger-once` | `gh run rerun --failed --commit <sha>`; once per head SHA |
| `ready-to-flip` | `flip-ready-takeover` | `gh pr ready <n>`, only after executor death post-sign |
| `armed-clean`, `pending` | `none` | nothing |
| `no-match` | `route-to-planner` | the only state routed to the planner |

**Docs action set** (machine-owned from birth):

| Situation | Action | What runs |
|---|---|---|
| `behind-or-dirty` | `rebase-in-place` | `cli-file rebase <id> --pr` (same branch, same PR number; lease push, then re-armed) |
| failing DoR check | `rerun-dor` | `gh run rerun --failed --commit <sha>` |
| green, CLEAN, not armed | `arm` | `cli-merge-if-eligible <pr> --source-kind docs` with the arm flag |
| other real check failure, `no-match` | `route-to-planner` | planner |
| `cancelled-or-infra` | `retrigger-once` | rerun once per head SHA |
| `merged` | `mark-landed` | record `landed` |
| remaining states | `none` | nothing |

**Docs lane (AISDLC-878).** Filing PRs made by `cli-file` (head branch `ai-sdlc/file-*`) travel a
lane of their own:

- `cli-file` never opens a draft: its `gh pr create` argv carries no `--draft`, so the PR is
  armable the moment it exists.
- `cli-file rebase <id> --pr` rebuilds the branch from current `origin/main` and lease-pushes the
  SAME branch (DEC-0088: `--force-with-lease` pinned to the SHA it read). The PR number is kept,
  no replacement PR is opened and nothing is closed; the PR is then re-armed.
- `cli-merge-if-eligible <pr> --source-kind docs` with the arm flag arms such a PR. It keeps the
  fork, base, author and head-commit checks, requires the head branch to start with
  `ai-sdlc/file-`, and refuses any PR whose diff touches a path outside the docs-only list,
  naming each offending path.
- The docs-only list has one definition, `pipeline-cli/attestation-core/docs-only-paths.mjs`
  (`DOCS_ONLY_PATTERN`). It covers the RFC, docs and backlog directories, attestation envelopes,
  `.ai-sdlc/_decisions/`, `.ai-sdlc/dispatch/briefs/`, `.claude/memory/`,
  `.github/dependabot.yml`, `.github/*.md` and root-level `*.md`.
  `scripts/is-docs-only-changeset.mjs` and the reviewer-scope code re-export it.

Rows are checked in this precedence: landed, manifest mismatch, stale claim, BEHIND/DIRTY,
attestation, pr-ready, cancelled/infra, then the green and pending rows.
`cli-dispatch classify-prs` gathers the facts itself (AISDLC-913) and writes one
`DispatchPrClassified` event per PR; `--input <facts.json>` still classifies a fixture.
`cli-dispatch pr-facts [--out <path>]` writes the gathered facts, with `mergeStateStatus` in
the GraphQL vocabulary (REST `mergeable_state` is mapped when the list omits it) and, for a
failed `ai-sdlc/pr-ready`, the first failing line of the job log as `failingLine`. Nobody
assembles REST payloads by hand.

## Planner rulings (`cli-dispatch rule`)

A ruling the planner sends by message would die with the dispatch session's next clear, so the
session records it: `cli-dispatch rule <task-id> --text "<ruling>" [--until <task-id>] [--by <name>]`
writes a `ruling` object (`text`, `until`, `by`, `at`) onto the task's manifest in `queue/`,
`failed/` or `done/` and refuses on `inflight/`; `cli-dispatch rule <task-id> --clear` removes it.
The reconciler then classifies a red or no-match PR of that task as `held` with the ruling text,
not `route-to-planner` or `reenter`. When `until` is set and that task's PR has merged, the next
pass clears the ruling and reports `ready-to-requeue`. `handoff write --role operator-dispatch`
lists every ruling under "Rulings in force". Dispatch drains its inbox (and applies each ruling)
before the tick, and its digest never repeats an item that carries a ruling.

## Restarting after a plugin upgrade

Sessions load the plugin once, when they start. A new plugin version (commands, hooks,
role text) is picked up only after `cli-hierarchy down` followed by `cli-hierarchy up`, or,
for one executor at a time, `cli-hierarchy restart <executor> --after-task` from the dispatch
session (the dispatch and planner sessions still need `down` then `up`);
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

**`clear`, `tick`, `restart`, `register` or `route-decision` exits 1 with a caller message.** Only the running
dispatch session may run them. Run them from that session.

**`status` shows `ENV missing`, or `doctor` reports `hierarchy-launch-env`.** The session was
started without the launch env, so its lease push is refused. Run `cli-hierarchy down --role
<role>` then `up` from the main checkout's build (`pnpm --filter @ai-sdlc/pipeline-cli build`
there first when `resolve-pipeline-cli.sh` refuses as stale). `clear` does not fix it.

**An executor's heartbeat.** `executor-start` writes `inflight/<task>.state.json` naming the
worker right after the claim, before any model call, because the hook's second condition is
that file; it exits non-zero when the write fails, leaving the claim for the reaper.

**Reading `status --json`.** `state` `busy` or `idle` come from the harness registry; `gone`
means the tmux window is closed; `starting` means the harness has not registered the
session; `unknown` means it is open but absent from the registry. `inflightTask` names the
task the session's heartbeat holds; an executor with `idle` and no `inflightTask` is ready
to claim. `board.queued` of 0 with all executors idle means the queue is drained.

## Correcting a stale queued manifest (dequeue)

A queued, unclaimed manifest that names a wrong field (for example a branch that no longer
exists) is corrected in two calls, never with a hand `rm` of the queue file:

```bash
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" dequeue --task-id <id> --reason "<why it is stale>" --board-dir "$BOARD_DIR"
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" write-manifest --json <corrected-manifest.json> --board-dir "$BOARD_DIR"
```

`dequeue` moves `queue/<id>.dispatch.json` to `retired/` with `retiredReason` and `retiredAt`
recorded; `--reason` is required. It exits 1, leaving the queue file untouched, when the task
is inflight (claimed), has a `done/` verdict, or is not queued.

## Sending a finished task back (reenter)

A task whose pull request goes red (a coverage shortfall, a stale attestation after a
rebase, reviewer findings, a semantic conflict) goes back to an executor, not to a second
`/ai-sdlc execute` and not to a push from the dispatch session: the hook binds a push to
the task's own worktree, which only its executor holds. One command, keyed on PR state
(RFC-0054, AISDLC-882; it replaced `resume` and `requeue --note`):

```bash
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" reenter "<pr-number|task-id>" --board-dir "$BOARD_DIR" \
  [--note "<what the executor must fix>" | --note-file <path>]
```

It needs the `requeue` grant and runs only from the dispatch session. It reads the PR from
GitHub, classifies it (`pr-state.ts`) and then:

- BEHIND with no other failure, or a cancelled or infra check: runs the machine action
  (`gh pr update-branch --rebase`, or a rerun of the failed jobs on the head) and writes no manifest.
- A real failure on the current head, a DIRTY (semantic) conflict or an attestation content
  mismatch: writes ONE `queue/` manifest carrying `branch` (the PR head ref), `resume.prNumber`,
  `resume.headSha`, `resume.failingLine`, `resume.failingChecks` and the note, and moves the
  task's `done/` and `failed/` files (verdict, diagnostic, manifest copy) to
  `landing/<pr>/history/`. The claim is made later by the normal executor claim; Step 3 reuses
  the branch the manifest names and never guesses. `executor-start` prints the note before the
  task runs; the pipeline re-enters the existing worktree, injects the note into the developer
  prompt, re-runs the reviewers, re-signs, lease-pushes from that worktree and updates the PR.
- A state that needs nothing (green, pending, armed): refused, unless `--note` orders a round.
- Loop guard (AISDLC-883): the same `(action, head SHA)` is never taken twice. The second call
  exits 1 with `loop guard: <action>@<sha> x2 ...`; a push (new head) resets it. Route a
  refused loop to the planner with `cli-decisions escalate`.

The command exits 1, changing nothing, when the PR is merged or closed, the task has no
verdict, or no PR can be found (a PR-less failure uses `cli-dispatch requeue --task-id <id>`,
which takes no `--note`). A verdict may be a `done/` `success` or `iterate-needed`, a
`failed/` verdict, or a reaped claim's diagnostic. `cli-dispatch release` is refused for a
task that already has a verdict in `done/`; run `reenter` to send it back, or `remove-verdict`
to discard the verdict first.

**Three board behaviours (AISDLC-868).**

- `cli-dispatch remove-verdict --task-id <id> --from failed` removes the verdict and
  diagnostic. It also removes the `failed/<id>.manifest.json` copy when `--with-manifest true`
  is passed or when the task file is already in `backlog/completed/`, so no stale failed
  manifest outlives a finished task (the AISDLC-800 invariant). Otherwise the manifest stays,
  because a live `reenter` or `requeue` needs it. Pass `--work-dir` when not run from the repo root.
- Brief ingestion by `cli-hierarchy tick` skips a task already on the board (a re-entry, for
  example) instead of refusing the whole brief. The tick result lists each one under `skipped`
  as `{ file, taskId, state }` and ingests the rest; the exit code is unchanged. A brief whose
  tasks are all on the board is marked ingested with no tasks.

`cli-dispatch idle-backoff` prints the sleep (5 to 60 seconds) an executor without a tmux
pane uses when the queue is empty.


No-CodeQL repositories (AISDLC-896): mark-ready flips any `ai-sdlc/` task draft whose PR checks are all green. `governance.openTaskPrsReady: true` opens task PRs ready from Step 11 and `ship`; the default stays draft.

## Quota and cost events

Admission order for the events below follows the Product Priority Algorithm ([RFC-0005](../../spec/rfcs/RFC-0005-product-priority-algorithm.md)).

| Event | Severity | Meaning | Response |
|---|---|---|---|
| `BurnDownReport` | Info | Periodic (5-min) snapshot of subscription utilization | Read in `cli-status --subscriptions`. No action unless `recommendation` is `under-pacing` or `over-pacing` for multiple consecutive periods |
| `QuotaContention` | Advisory | High-PPA stage blocked on `hardCap`; pipeline did not cede priority to lower-PPA work | If frequent, consider tier upgrade or raising `hardCap` |
| `BudgetExceeded` | Warning | Stage exceeded its `maxBudgetUsd` circuit breaker | Review `estimatedTokens` for the stage; either raise `maxBudgetUsd` or investigate why the stage ran long |
| `AdmissionDenied` | Info | Stage couldn't admit (which cap blocked is in the event detail) | Inform tuning, not action |
| `OffPeakDeferralExceeded` | Advisory | `schedule: off-peak` stage waited longer than `offPeakMaxWait` and dispatched on-peak | Check off-peak schedule freshness; consider extending `offPeakMaxWait` if dispatching on-peak is unacceptable |
| `LedgerSourceFallback` | Advisory | Authoritative quota API was unavailable; ledger fell back to self-tracked | Check vendor API status; resolve once API recovers |
| `TierAnalysis` | Advisory | Weekly tier recommendation | Review in Slack digest. If `recommendedPlan != currentPlan` and `confidence: high`, evaluate the upgrade/downgrade |

## HC_design three-state diagnostic (AISDLC-171)

The HC composite includes a `HC_design` channel (RFC-0008 §9, weight `0.10`) that carries Design Authority leadership signals. When you read an issue's `pillarBreakdown.shared.hcComposite` and `hcDesign = 0`, that zero is **ambiguous** — three different upstream conditions all produce it, and the operational response differs for each. This section explains what the operator sees, how to read the diagnostic flag that distinguishes the three, and when each warrants action.

The normative semantic is in [RFC-0008 §14.2.1](../../spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md#1421-principal-participation-three-state-semantic-aisdlc-171); this section is the operator-facing companion. Both reference the implementation anchors in [`orchestrator/src/admission-hc.ts`](../../orchestrator/src/admission-hc.ts) and [`orchestrator/src/design-authority.ts`](../../orchestrator/src/design-authority.ts).

### The states

The disambiguating signal is the `designAuthorityConfigured` field on `pillarBreakdown.shared.hcComposite`. It is a **diagnostic flag only** — it does not change the score; it just tells you which underlying condition produced the score you're looking at.

The implementation surfaces **three distinct flag values** (`undefined`, `false`, `true`) in combination with `hcDesign`, producing four observable states. The two "no Design Authority configured" rows below collapse into a single operator response — they differ only in whether the DSB resource exists at all — but tooling that scans the breakdown must handle both flag values to avoid silently dropping the DSB-with-empty-principals case into an "unknown" bucket.

| State | `designAuthorityConfigured` | `hcDesign` | Distinguishing test | What it means |
|---|---|---|---|---|
| **none** — DSB absent | `undefined` (field omitted) | `0` | No `DesignSystemBinding` resource exists for the project (the `preDesignSystem` lifecycle phase per RFC-0008 §6.2). `buildDesignAuthoritySignal` short-circuits to `undefined`, and `computeAdmissionHumanCurve` omits the field entirely | The project has not opted into Design Authority signal routing. Common for early-stage adopters |
| **none** — DSB present, principals empty | `false` (field present and explicitly `false`) | `0` | A DSB exists but `spec.stewardship.designAuthority.principals` is empty or absent. `buildDesignAuthoritySignal` returns `principalsDeclared: false`, which propagates through to the breakdown | Operationally equivalent to DSB-absent — no Design Authority is declared. The distinct flag value lets you see that a DSB exists but has not been populated with principals yet |
| **configured-but-silent** — DA configured, did not review | `true` | `0` | DSB declares one or more principals, but none of them appears as the issue's author or as a commenter. The channel is wired; design leadership simply did not weigh in on this particular issue | The operationally interesting case — see "Operator response" below |
| **engaged** — DA reviewed | `true` | non-zero (positive or negative) | At least one declared principal participated as the issue's author or as a commenter; the signal type is resolved from issue labels (`design/advances-coherence`, `design/fills-gap`, `design/fragments-catalog`, `design/misaligned-brand`) | Steady-state goal for projects with a mature design system |

### When each state appears

- **`none`** is normal for projects in the `preDesignSystem` lifecycle phase (no DSB yet) and for projects whose design system has not been formalized through `stewardship.designAuthority`. There is **no penalty** — the composite simply omits the design-leadership signal. Most early-stage adopters live here.
- **`configured-but-silent`** appears once the operator (or a maintainer) has declared design authority principals on the DSB but those principals are not actually reviewing issues. The composite reflects "design did not weigh in" — neither positively nor negatively. This is the **operationally interesting state**: it usually means DA assignment is paper-only.
- **`engaged`** is the steady-state goal for any project whose design system is mature enough to warrant principal review. Both positive (`advances-coherence`, `fills-gap`) and negative (`fragments-catalog`, `misaligned-brand`) signals lift design intent into the prioritization model.

### What triggers the implicit penalty

Strictly speaking there is no separate "penalty" code path — the penalty is structural. In **`configured-but-silent`** the composite includes `0.10 × 0` for the design term, so the issue scores as if no positive design signal exists even though the channel is wired. Issues competing with peers whose design leadership has weighed in (with positive signals) will score below them by exactly the missing weight. The framework deliberately does NOT push `hcDesign` to a negative default value when the DA goes silent — silence is not a vote against, just an absent vote.

### Why a diagnostic flag rather than a behavioral change

The principal-participation gate (only listed principals may emit full-weight `HC_design`) exists to prevent abuse — without it, anyone could trigger the design channel by labeling an issue. That gate must hold even when the DSB is configured but inactive. The ambiguity at `hcDesign = 0` is purely a **reporting** problem, not a scoring problem. `designAuthorityConfigured` lets you see the configured-but-silent state without weakening the gate.

### Operator response

| State | Operator response |
|---|---|
| **none** | No action. Expected for early-stage adopters and any project that has not formalized Design Authority |
| **configured-but-silent** (occasional) | No action. Design leadership simply chose not to weigh in on this particular issue |
| **configured-but-silent** (persistent across many issues) | **Review your DA assignment.** The most common causes are: (a) the principal list on the DSB names someone who has left the team, (b) the principals are real but were never told about their reviewer role, (c) DA notification is not wired into the principal's working environment (no GitHub `@mentions`, no Slack ping). Confirm the principals listed under `DesignSystemBinding.spec.stewardship.designAuthority.principals` are accurate, then either re-onboard them or update the list |
| **engaged** | No action — this is the steady-state goal |

### How to inspect the flag

The flag is computed on every admission scoring result. The framework does not currently persist per-issue admission scores to a queryable artifact tree — there is no `artifacts/_admission/scores/` directory. Two real inspection surfaces exist:

**1. `cli-admit` — recompute the score and inspect the breakdown for a single issue.** The dogfood CLI runs the admission pipeline and writes the full result (including `pillarBreakdown`) as JSON to stdout. Pipe it through `jq` to extract the diagnostic surface:

```bash
# Backlog task:
pnpm --filter @ai-sdlc/dogfood admit \
  --tracker backlog --task-id AISDLC-42 --enrich-from-state \
  | jq '.pillarBreakdown.shared.hcComposite'

# GitHub issue (requires the full --title/--body-file/--labels invocation —
# see `dogfood/src/cli-admit.ts` header comment for the full flag list):
pnpm --filter @ai-sdlc/dogfood admit \
  --title "..." --body-file /tmp/body.txt --issue-number 42 \
  --labels '["bug"]' --reactions 3 --comments 2 \
  --created-at 2026-01-01T00:00:00Z --enrich-from-state \
  | jq '.pillarBreakdown.shared.hcComposite'
```

Sample output for the configured-but-silent state:

```json
{
  "explicit": 0,
  "consensus": -1,
  "decision": 0,
  "design": 0,
  "value": -0.4218990,
  "designAuthorityConfigured": true
}
```

For the DSB-present-empty-principals state, `designAuthorityConfigured` will be `false` (the field is present but explicitly `false`); for the DSB-absent state, the field is omitted entirely.

**2. `design_lookahead_notifications` SQLite table — historical breakdowns for top-10 issues.** The C7 design-lookahead detector (RFC-0008 §11) persists the full `PillarBreakdown` as JSON in the `pillar_breakdown_json` column whenever it emits a notification (top-10 backlog item, design impact detected, not deduped within the 7-day window). The state DB lives at `.ai-sdlc/state.db`. To pull the breakdown for a specific issue:

```bash
sqlite3 .ai-sdlc/state.db \
  "SELECT pillar_breakdown_json FROM design_lookahead_notifications WHERE issue_number = 42;" \
  | jq '.shared.hcComposite'
```

To bulk-scan for `configured-but-silent` issues (the operational tell that DA is paper-only):

```bash
sqlite3 .ai-sdlc/state.db \
  "SELECT issue_number, pillar_breakdown_json FROM design_lookahead_notifications;" \
  | while IFS='|' read -r issue json; do
      state=$(echo "$json" | jq -r '
        .shared.hcComposite as $hc
        | if   $hc.designAuthorityConfigured == null  then "none-dsb-absent"
          elif $hc.designAuthorityConfigured == false then "none-dsb-empty-principals"
          elif $hc.designAuthorityConfigured == true and $hc.design == 0 then "configured-but-silent"
          elif $hc.designAuthorityConfigured == true                       then "engaged"
          else "unknown" end')
      if [[ "$state" == "configured-but-silent" ]]; then
        echo "issue $issue: $state"
      fi
    done
```

The classifier above explicitly handles the `false` flag value (DSB-present-empty-principals); a classifier that only branches on truthiness silently bins those issues into `unknown` and you will miss DSBs that exist but have not been populated with principals. Note that this surface only contains the top-N items the lookahead detector observed — for one-off inspection of an issue not in that table, use `cli-admit` (path 1).

A clustered run of `configured-but-silent` results across recent admissions is the operational tell that DA assignment needs review.

### Cross-references

- Normative spec: [RFC-0008 §14.2.1 — principal-participation three-state semantic](../../spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md#1421-principal-participation-three-state-semantic-aisdlc-171).
- HC_design channel definition: [RFC-0008 §9 — Connection 5: HC_design](../../spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md#9-connection-5-hc_design--design-lead-signal-channel).
- Original adopter report: [RFC-0009 §13 OQ-8](../../spec/rfcs/RFC-0009-tessellated-design-intent-documents.md) — resolved 2026-05-04 by filing AISDLC-171.
- Implementation anchors:
  - [`orchestrator/src/admission-hc.ts`](../../orchestrator/src/admission-hc.ts) — `AdmissionHumanCurveResult.designAuthorityConfigured` field; the JSDoc on `hcDesign` ties back to RFC-0008 §14.2.
  - [`orchestrator/src/design-authority.ts`](../../orchestrator/src/design-authority.ts) — principal participation check; the file-header JSDoc (AISDLC-171 / RFC-0009 §13 OQ-8 anchor) is the canonical inline cross-reference to this section.
  - `orchestrator/src/admission-enrichment.ts` — `buildDesignAuthoritySignal` computes `principalsDeclared` from the resolved DSB.
- Implementation history:
  - AISDLC-171 (`backlog/completed/aisdlc-171 - HC-composite-design-pillar-wiring-investigate-stewardship-designAuthority-to-HC_design-propagation-gap.md`) — surfaced the `designAuthorityConfigured` flag.
  - AISDLC-185 (this section, RFC-0008 §14.2.1) — documentation backport.

## Fork-PR workflow safety pattern (AISDLC-381)

External-contributor PRs from forks (witnessed at PR #568 by @akillies) get
blocked at the merge queue when the upstream's required status checks
(`Backlog Drift`, `ai-sdlc/pr-ready`, `ai-sdlc/attestation`) cannot post
because GitHub silently downgrades GITHUB_TOKEN to read-only on
`pull_request` events from forks — regardless of the workflow's declared
`permissions:` block. The fix is to migrate the affected workflows to
`pull_request_target`, which runs in the upstream repo's context with full
write permissions even for fork PRs. The footgun: `pull_request_target`
exposes secrets and write tokens to the workflow, so any execution of
fork-controlled code under that context is a takeover vector.

### The 5-point safety guard

Every workflow that fires on `pull_request_target` MUST apply ALL FIVE
of the following constraints. The hermetic test at
`.github/workflows/__tests__/fork-pr-safety.test.mjs` greps for the
forbidden patterns; CI fails the PR if any guard is violated. The
specific workflows currently in scope are:

- `.github/workflows/ai-sdlc-gate.yml (attestation-gate job)` (posts `ai-sdlc/attestation`)
- `.github/workflows/ai-sdlc-review.yml` (posts `Post Review Results` + review comments)
- `.github/workflows/auto-enable-auto-merge.yml` (arms auto-merge on PR open)

#### Guard 1 — Workflow logic checks out the TARGET repo's main, NOT the fork's HEAD

`actions/checkout@v4` with no `ref:` argument defaults to the workflow
file's source ref. On a `pull_request_target` event that's the BASE
branch tip (target main), which is exactly what we want — every script
under `scripts/`, `pipeline-cli/`, `ai-sdlc-plugin/agents/`, etc. is
sourced from main, never from fork content. A fork PR cannot inject a
malicious `scripts/verify-attestation.mjs` that runs with `statuses:write`.

CORRECT:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
    # NO ref: arg — defaults to main
```

WRONG (executes fork code with target's secrets):

```yaml
- uses: actions/checkout@v4
  with:
    ref: ${{ github.event.pull_request.head.sha }}  # fork content
```

#### Guard 2 — Fork PR content is read as DATA only, never checked out

Do NOT `actions/checkout` the fork PR head in a `pull_request_target` job
(Scorecard DangerousWorkflow class; AISDLC-704, AISDLC-704.6). When the
workflow legitimately needs fork content (e.g. the
`.ai-sdlc/attestations/<sha>.dsse.json` envelope that the verifier reads
as JSON), fetch it as data:

- Files: fetch the head commit objects into the local git store (SHA-anchored
  refspec; a failed fetch must fail the step), enumerate with
  `git ls-tree -z <sha> -- <dir>/`, keep only regular blobs (mode
  100644/100755) whose names match a strict regex (path-traversal guard), and
  materialise with `git show <sha>:<path>`. See `scripts/stage-attestation-data.sh`.
  Avoid the contents API for bulk staging: it costs one call per file and
  lists at most 1000 entries per directory.
- Git objects (for `git diff <base>...<head>`): `git init pr-content` then
  `git -C pr-content fetch --no-tags https://github.com/${REPO}.git +${SHA}:refs/remotes/...`
  (objects only, no working tree).
- PR metadata via `gh api .../pulls/<N>/...` (target-context API).

Bind `HEAD_REPO_FULL` / `HEAD_SHA` through step `env:` (never `${{ }}` inside
`run:`), hex-validate the SHA and pattern-validate the repo name before use.

NEVER `cd pr-content/`, `pushd pr-content/`, `node pr-content/<script>`,
`bash pr-content/<script>`, `./pr-content/<script>`, set
`working-directory: pr-content`, etc. Fetched fork data is a DATA source,
not an execution target.

#### Guard 3 — NEVER `pnpm install` / `pnpm build` / script execution against `pr-content/`

`pnpm install` triggers lifecycle scripts (`preinstall`, `install`,
`postinstall`) defined in `package.json`. A fork's `package.json`
preinstall hook would run with the workflow's elevated token. The
workflow's install step MUST run against MAIN's `package.json` and
`pnpm-lock.yaml`:

CORRECT:

```yaml
- run: pnpm install --frozen-lockfile  # main's lockfile (default cwd)
- run: pnpm build                       # main's package.json
```

WRONG:

```yaml
- run: cd pr-content && pnpm install   # fork's preinstall fires
- run: pnpm install --filter ./pr-content/...  # same
```

The hermetic test greps for these patterns and fails the PR if found.

#### Guard 4 — NEVER use fork-provided actions

Every `uses:` reference MUST be either a vetted publisher (e.g.
`actions/checkout@v4`, `pnpm/action-setup@v4`) or pinned to a specific
commit SHA. NEVER a relative-path reference that resolves into fork
content:

WRONG:

```yaml
- uses: ./pr-content/.github/actions/my-action  # fork-controlled
```

CORRECT:

```yaml
- uses: actions/checkout@v4                     # vetted publisher
- uses: some-org/some-action@a1b2c3d            # pinned SHA
```

#### Guard 5 — Minimum-needed secrets; NEVER signing keys into fork context

Workflows under `pull_request_target` MUST declare exactly the
permissions and secrets they need. Suggested matrix:

| Workflow | `permissions:` | Secrets allowed |
|---|---|---|
| `ai-sdlc-gate.yml (attestation-gate job)` | `contents:read`, `statuses:write`, `pull-requests:read` | `github.token` only |
| `ai-sdlc-review.yml` (docs-only-check) | `contents:read`, `statuses:write`, `pull-requests:read` | `github.token` only |
| `ai-sdlc-review.yml` (analyze) | `contents:read`, `pull-requests:read` | `ANTHROPIC_API_KEY`, `MARKER_HMAC_SECRET` |
| `ai-sdlc-review.yml` (report) | `pull-requests:write`, `issues:read`, `statuses:write` | `github.token`, `SLACK_BOT_TOKEN` |
| `auto-enable-auto-merge.yml` | `pull-requests:write` | `AI_SDLC_PAT` |

NEVER:

- `AI_SDLC_ATTESTATION_PRIVATE_KEY` (DSSE signing key)
- `NPM_TOKEN` (release publishing)
- Any AWS / GCP / cloud-provider credentials

These belong in `release.yml` which fires on `push` to `main` (no fork
PR triggers). The hermetic test catches accidental references.

The `analyze` job's `ANTHROPIC_API_KEY` is a partial exception: it IS
exposed to a step that reads fork-controlled content (the PR diff). The
mitigation is structural — the analyze job has NO GitHub write
permissions, so even if the LLM is prompt-injected into emitting an
APPROVE verdict, the JSON output cannot affect the repo. The `report`
job (which posts the verdict using `github.token`) only consumes the
verdict as parsed JSON — never as code — and the rollup gate
`ai-sdlc/pr-ready` (build/test/coverage) plus human review provide
defense-in-depth.

### Verification

When migrating a new workflow to `pull_request_target`, run the
hermetic test locally before pushing:

```bash
pnpm test:fork-pr-safety
```

The test enforces all 5 guards across every workflow in the
`AFFECTED_WORKFLOWS` array in `fork-pr-safety.test.mjs`. Add your new
workflow to that array as part of the migration commit.

### End-to-end fork-PR verification

The hermetic test can't actually create a fork PR — that requires an
external GitHub account. To prove a migration works end-to-end:

1. Find a contributor with a fork (or create one yourself from a
   secondary GitHub account)
2. Have them open a trivial fork PR (e.g. fix a typo)
3. Watch the workflow run logs: confirm `gh api .../statuses` returns
   201 (was 403 pre-AISDLC-381), and the three required status checks
   land green
4. Watch the merge-queue admission step: confirm the PR is admitted
   without operator bypass

If a contributor's fork PR is currently blocked (e.g. PR #568), the
re-trigger procedure is:

```bash
# Re-run all checks against the existing PR head SHA
gh pr checks <pr-number>          # confirm current status
gh workflow run ai-sdlc-gate.yml (attestation-gate job) --ref <fork-branch-ref>
gh workflow run ai-sdlc-review.yml --ref <fork-branch-ref>
# auto-enable re-fires automatically on the next push
```

If the fork PR still fails after re-trigger, capture the workflow run
logs and file a backlog task referencing AISDLC-381 + the fork PR
number for follow-up investigation.

## Liveness detection and session reaper

**AISDLC-481** — the session reaper detects sessions that have stopped
heartbeating and marks them `failed` automatically.

### How liveness works

Every `/ai-sdlc execute` session writes `lastHeartbeat` to its session file
(`.ai-sdlc/dispatch/sessions/<task-id>.session.json`) at each Step 0-13
transition via `update_session_state`. The reaper (`reapStaleSessions` in
`pipeline-cli/src/dispatch/session-reaper.ts`) compares the current wall time
against `lastHeartbeat` (falling back to `spawnedAt` when no heartbeat has
been written yet).

**Default threshold: 30 minutes.** Sessions whose heartbeat anchor is older
than 30 minutes are reaped. This matches the Dispatch Board inflight sweeper
threshold (RFC-0041 OQ-3) so the two substrates have identical liveness
windows.

### Two-substrate reconciliation

The execute-parallel coordination layer has two independent substrates that
track session state:

| Substrate                    | File location                                                     | Purpose                                    |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| **Session file substrate**   | `.ai-sdlc/dispatch/sessions/<task>.session.json`                  | tmux/execute-parallel coordination         |
| **Dispatch Board substrate** | `.ai-sdlc/dispatch/inflight/<task>.dispatch.json` + `.state.json` | Conductor/Worker Dispatch Board (RFC-0041) |

When a session dies, both substrates must be updated consistently — an orphan
in one while the other shows the session alive creates a false-positive
"still running" state.

The reaper reconciles both:

1. **Session file reap**: when `lastHeartbeat` is stale, marks the session
   file `status: failed`.
2. **Board reconcile**: sweeps the Dispatch Board inflight entry for the same
   `taskId`. If an inflight entry exists, it is moved to `failed/` with a
   `stale-heartbeat` diagnostic. If no inflight entry exists (the session was
   a pure tmux session without a board manifest), a diagnostic is still written
   to `failed/` so the Conductor's verdict poll records the event.
3. **Board-only orphan sweep**: after the session-file pass, a board-level
   sweep catches inflight entries that have no corresponding session file
   (Workers that don't use execute-parallel). These appear in
   `SessionReaperResult.boardOnlyReaped`.

### When the reaper runs

The reaper is invoked automatically by `execute-parallel-status` on every
status table refresh. You can also invoke it programmatically:

```typescript
import { reapStaleSessions } from '@ai-sdlc/pipeline-cli';

const result = reapStaleSessions({
  boardDir: '.ai-sdlc/dispatch',
  staleMs: 30 * 60 * 1000, // 30 minutes (default)
});
// result.reaped[].taskId — session-file reaped tasks
// result.boardOnlyReaped[] — board-only reaped task IDs
```

### Manual inspection

```bash
# Check a session file's last heartbeat
cat .ai-sdlc/dispatch/sessions/aisdlc-462.session.json | jq '.lastHeartbeat, .status'

# Check board inflight state
ls .ai-sdlc/dispatch/inflight/
cat .ai-sdlc/dispatch/inflight/AISDLC-462.state.json | jq '.lastHeartbeat'
```

If a session appears stuck (heartbeat age > 30 min), the reaper will clean it
up on the next status refresh. You can force a reap cycle by running:

```bash
/ai-sdlc execute-parallel-status
```

---

## Cancel back-channel

**AISDLC-481 v1 scope: cancel-only.** Full pause/resume is a deliberate
follow-up. This section documents the cancel mechanism.

### What the cancel back-channel does

The orchestrator (or an operator script) writes a cancel control signal to
`.ai-sdlc/dispatch/sessions/<task-id>.cancel.json`. A running
`/ai-sdlc execute` session reads this file at its **step boundaries** (after
Step 1, before Step 5, after Step 6, after Step 7c) and performs a clean abort
when the signal is present.

On cancel:

1. The cancel signal file is removed (idempotent — no spurious re-cancel on restart).
2. The session file status is updated to `cancelled`.
3. A board diagnostic is written to `.ai-sdlc/dispatch/failed/` so the
   Conductor's verdict poll sees the cancellation.
4. The pipeline exits 1.

### Cancel signal schema

```json
{
  "schemaVersion": "v1",
  "taskId": "AISDLC-462",
  "cancelledAt": "2026-06-01T10:00:00.000Z",
  "reason": "operator requested cancel via UI",
  "cancelledBy": "conductor-session-abc"
}
```

Fields:

| Field           | Required | Description                                |
| --------------- | -------- | ------------------------------------------ |
| `schemaVersion` | Yes      | Always `v1`                                |
| `taskId`        | Yes      | Task ID matching the session               |
| `cancelledAt`   | Yes      | ISO-8601 timestamp of signal write         |
| `reason`        | No       | Human-readable reason (audit trail)        |
| `cancelledBy`   | No       | Orchestrator / operator session identifier |

### Writing a cancel signal

#### Via TypeScript (orchestrator-side)

```typescript
import { writeCancelSignal } from '@ai-sdlc/pipeline-cli';

writeCancelSignal('.ai-sdlc/dispatch', {
  schemaVersion: 'v1',
  taskId: 'AISDLC-462',
  cancelledAt: new Date().toISOString(),
  reason: 'operator requested cancel',
  cancelledBy: 'conductor-session-xyz',
});
```

#### Via shell (operator script)

```bash
node -e "
  const fs = require('fs');
  const taskId = 'AISDLC-462';
  const signal = {
    schemaVersion: 'v1',
    taskId,
    cancelledAt: new Date().toISOString(),
    reason: 'manual operator cancel',
    cancelledBy: 'operator-shell',
  };
  const dir = '.ai-sdlc/dispatch/sessions';
  fs.mkdirSync(dir, { recursive: true });
  const tmp = dir + '/' + taskId.toLowerCase() + '.cancel.json.tmp';
  const target = dir + '/' + taskId.toLowerCase() + '.cancel.json';
  fs.writeFileSync(tmp, JSON.stringify(signal, null, 2));
  fs.renameSync(tmp, target);
  console.log('cancel signal written for', taskId);
"
```

### When is the cancel signal read?

The session checks for the cancel signal at these step boundaries:

| After step                         | Why                                                  |
| ---------------------------------- | ---------------------------------------------------- |
| Step 1 (argument validation)       | Earliest safe abort — before any state mutation      |
| Before Step 5 (developer subagent) | Prevent starting a long-running developer invocation |
| After Step 6 (developer completes) | Before starting expensive review fan-out             |
| After Step 7c (reviews complete)   | Before committing / pushing                          |

The cancel is **clean** — no partial commits are left; the session terminates
at a safe boundary. The worktree is preserved on disk for operator inspection
(same behavior as a developer failure).

### Composing with AISDLC-480 (decision routing)

This task's cancel back-channel composes with AISDLC-480's decision routing:

- AISDLC-480 routes an operator question out of a running session to the
  Decision Catalog.
- AISDLC-481 (this task) carries back the control signal (cancel or, in a
  future follow-up, an answer) to the waiting session.

In v1, when a session is waiting for an operator decision (blocked at an
`AskUserQuestion` boundary), the orchestrator can write a cancel signal to
abort cleanly while emitting the `decisionId` in the diagnostic so the audit
trail records which question triggered the cancel.

```bash
# Cancel a session and record the associated decision ID.
node -e "
  const fs = require('fs');
  const signal = {
    schemaVersion: 'v1',
    taskId: 'AISDLC-462',
    cancelledAt: new Date().toISOString(),
    reason: 'blocked on DEC-0042 — cancelling while decision is pending',
    cancelledBy: 'orchestrator',
    decisionId: 'DEC-0042',
  };
  const f = '.ai-sdlc/dispatch/sessions/aisdlc-462.cancel.json';
  fs.writeFileSync(f, JSON.stringify(signal, null, 2));
"
```

Full pause/resume (the session waits, receives the operator answer, and
resumes from where it was blocked) is tracked as a follow-up to this task.

---

## The executor loop

In a session hierarchy, each executor session runs `/ai-sdlc executor` for its whole
life. The planner and dispatch sessions are covered by their own commands; this
section is the executor's side of the board.

One pass of the loop:

1. **Identify.** The executor reads the roster (`.ai-sdlc/dispatch/hierarchy.json`)
   and finds its own entry (the session whose process is the entry's `pid`) and the
   dispatch session's entry. The name is used exactly as the roster has it,
   including any collision suffix the harness added.
2. **Claim.** `cli-dispatch claim --worker-kind in-session-agent --worker <name>`
   moves the next eligible manifest to `inflight/` with `workerId` equal to the
   roster name. That equality is what lets `cli-hierarchy status` and `down` join an
   inflight task to its session. When nothing is eligible, the executor blocks on
   the board (`cli-hierarchy executor-start`, up to 1,500 s, no model calls
   while it waits); if still nothing is eligible it clears its own context and restarts
   (`cli-hierarchy clear --self --resume-after 30`), or, with no tmux pane to clear, schedules a
   wake-up after `spec.inSessionAgent.emptyQueueHibernateSec` (default 1800 seconds; this default intentionally applies to Pattern Z Workers running `/ai-sdlc dispatch-worker` too).
3. **Execute.** It runs `/ai-sdlc execute <task-id>` with the task id and no other
   argument. The pipeline is not modified for executors.
4. **Report.** `cli-dispatch complete --task-id <id> --outcome <outcome>
   --worker <name> [--pr <n>] [--follow-ups <ids>] [--decisions <ids>]` writes the
   verdict. `success` and `iterate-needed` land in `done/`; every other outcome
   lands in `failed/`. Every outcome except `iterate-needed` also removes the task
   from `inflight/`; on `iterate-needed` the inflight manifest stays, so the worker
   keeps the slot across the iteration. The verdict records the
   outcome, the pull request number, the follow-up task ids and the decision ids
   raised. The command refuses when the task is not inflight, when a follow-up id
   is not a sub-id of the task, and when `--worker` is missing or differs from the
   name recorded at claim time. That match guards against a mistake (a session
   completing the wrong task); it is not authentication, because the recorded name
   is readable from the inflight manifest. `cli-dispatch write-verdict` applies the
   same check when the caller resolves to the executor role in the roster
   (`--worker` required, the caller must hold the claim, nothing is written on a
   refusal) and the same caveat; other callers are not checked.
5. **Tell the dispatch session.** One status line goes to the dispatch session:
   task, outcome, pull request, decision ids. It carries status only.
6. **Stop.** The dispatch session sees the verdict, clears the executor's context and
   issues `/ai-sdlc executor` again.

### After a clear

`/clear` keeps a session's name and permission mode but empties its context. The
plugin's `SessionStart` hook runs again with source `clear`; when the session is
named in the roster it injects a short block with the session's role, name, the
dispatch session's name and the command to run. The hook adds nothing for any other
source (`startup`, `resume`, `compact`) and nothing for a session that is not in the
roster. It finds its session by matching the roster's `pid` against the hook
process's ancestors.

### Role tool rules

What an executor may not do with messages, decisions and task creation is checked by
a hook, not just asked for. A `PreToolUse` hook (`enforce-role-tools`) identifies the
session the same way the clear hook does (the nearest running roster entry among the
hook's ancestor processes, and only when that process is a claude process) and
refuses a call that matches a rule for the session's role. By default an executor is
refused:

- `SendMessage` to anyone but the dispatch session named in the roster;
- any `cli-decisions` subcommand outside an allowlist: `escalate`, `add` (never with
  `--autonomous-fallback`, `--timebox` or `--timebox-hours`) and the read-only
  `list`, `show`, `log-path`, `graph`, `coverage`, `research`, `summary` and
  `exemplars list`; `answer`, `resolve`, `override`, `auto-expire`, `extend`,
  `fatigue`, `score-a`, `score-c` and any unknown subcommand are refused;
- a `task_create` call that is not a sub-task of a task the session has claimed. The
  plugin's `task_create` must carry a sub-task id (`<task-id>.<n>`); any other
  `task_create` tool (the backlog server, which assigns ids itself) must carry
  `parentTaskId` set to a claimed task and no `id` key at all. A session with no
  claimed task is refused;
- Write, Edit or MultiEdit that creates a new file under `backlog/tasks/` or
  `backlog/drafts/` unless its id is a sub-task of a claimed task (an existing file
  is an edit and is allowed);
- `backlog task create` (also `task new`, `create`, `draft create`) without
  `--parent <claimed task>`.

What is enforced is exactly this: the MCP create tools and Write/Edit/MultiEdit are
enforced by tool matcher, and a differently cased path for a task file counts as a create. The Bash rules are pattern matchers and do not catch every
way a shell can write a file or run a command.

Enforcement needs the session's process to be named `claude` or `claude-code`: an install
whose process reports itself as `node` (for example an npm-global one) is not enforced,
and the hook prints a stderr diagnostic saying so.

A refusal names the role, the rule, a next step the session can take itself (for example
`cli-decisions escalate`, `cli-dispatch next-subid <task-id>` with `parentTaskId`, or
`cli-dispatch claim`) and, failing that, escalation to its dispatch session; no refusal ends
in a human-only exit. A
session that is not in a hierarchy (no roster) or whose role cannot be resolved (no
matching entry, a stale entry, a pid that is not a claude process; the last case also
prints a one-line stderr diagnostic) is treated as the operator and is never
blocked; the hook spawns nothing at all when there is no roster. Once a session
resolves to the executor the hook fails closed: an unreadable or invalid policy, or
an error while evaluating a rule, applies the strict executor defaults (it never
relaxes them), and a call that cannot be evaluated is refused. A `cli-decisions`
command longer than 64 KB is refused.

A repo changes the list under `spec.governance.roles.<role>.blockedTools` in
`.ai-sdlc/agent-role.yaml`:

```yaml
governance:
  roles:
    executor:
      blockedTools: [] # an explicit empty list removes the executor's defaults
    planner:
      blockedTools:
        - tool: WebFetch
        - tool: Bash
          argument: command
          contains: 'rm -rf'
          reason: 'No recursive deletes from the planner.'
```

`blockedTools: []` disables that role's tool blocks. A non-empty list replaces the role's defaults. Each entry names a `tool` (exact, or
with `*` wildcards, or several joined with `|`) and optionally a built-in `match` (`notDispatchRecipient`,
`decisionMutation`, `topLevelTask`, `newTaskFile`, `backlogCliCreate`) or an `argument` with `contains`, which refuses a
call whose named argument contains the text. A malformed list is ignored and the
role's defaults apply; malformed input never relaxes a rule. The policy is read from
the main checkout's copy when it can be verified, so a worktree copy cannot relax it;
a linked worktree whose main checkout cannot be verified gets the strict defaults.
The executor skill prints the resolved rules at the start of each pass
(`render-role-tool-rules.mjs --role executor`), rendered from the same policy.

This is a mistake guard, not a sandbox: a static matcher cannot see `eval`, encoded
payloads or names built at run time, and text that merely mentions a refused command
(for example `cli-decisions answer` in a commit message or a `grep` pattern) is
refused too; describe such text in words or write it with a file tool.

The deferred coverage `Stop` hook does not run in executor or operator-dispatch
sessions (the pre-push gate covers the work they ship); it still runs for the planner
and for any session whose role cannot be resolved.

### Follow-up task ids

A follow-up an executor discovers is filed as a sub-id of its own task (the role
rules above refuse the task tools' other forms; see the qualification there). `cli-dispatch next-subid <task-id>` prints the first
`<task-id>.<n>` that is free in all three places a sub-id can already exist:

- `backlog/` (task files, open and completed),
- the board (a manifest or verdict in any state),
- the file lists of open pull requests (`gh pr list`; when it cannot be reached the
  command warns, reports `"openPrScan":"unavailable"` and checks the first two only).

### Rules an executor keeps

- It never messages another executor.
- It does not answer decisions, its own or another task's (the hook refuses the
  `cli-decisions` subcommands outside its allowlist).
- It never edits an RFC's Open Questions.
- When it is blocked, it records the question with `cli-decisions escalate` and
  stops. The routing of that decision to the dispatch session or the planner is a
  separate step that is not part of this loop yet.

---

## The operator-dispatch loop

The dispatch session runs `/ai-sdlc operator-dispatch` on a wake-up interval (60
seconds). It owns throughput: it turns briefs into work, keeps the board moving,
clears each executor between tasks, unblocks what it is allowed to unblock and
reports to the planner. Each wake-up runs one command:

```bash
cli-hierarchy tick --worker <dispatch session name>
```

The command has a mistake guard (see "The caller binding" below): it identifies its
caller instead of relying on `--worker`. It finds the nearest ancestor process that is a
running roster entry and a claude process, and refuses, writing and sending nothing,
unless that session has the `operator-dispatch` role. `--worker` is optional; when given
it must equal the caller's own roster name. The roster is read from the main checkout's
board, never from a path the caller passes: the command also refuses unless
`--board-dir` and the working directory are the main checkout's, and unless the command
is running from the main checkout's own install when it runs inside a git work tree
(an installed layout outside any work tree skips that last check). `--retry-limit` may
not exceed 2; a larger value is refused with exit 2, not clamped. Every board write the loop
makes carries the caller's name. `cli-hierarchy clear` and `cli-hierarchy route-decision`
apply the same guard, and so does `cli-dispatch requeue`. The command prints, as JSON,
what it did and what the session has to say.

1. **Ingest.** Each new `*.md` file in `.ai-sdlc/dispatch/briefs/` is parsed and
   enqueued with the same mapping as `cli-dispatch enqueue --from-brief`, then
   marked ingested in `.ai-sdlc/dispatch/operator-dispatch.state.json`. A later
   wake-up never enqueues it again. A brief the board refuses is reported and is
   retried only after the file changes.
2. **Verdict watch.** Each new verdict in `done/` or `failed/` is handled once. The
   executor that wrote it is cleared (below), then failures go through the
   unblocking playbook.
3. **Reports.** A progress line goes to the planner at the configured cadence
   (15 minutes by default, `--report-every-ms`), and a summary when every task of
   an ingested brief has reached a final state.

### The caller binding

The binding is a mistake guard. It stops a session from using the dispatch commands by
mistake, for example an executor that types `cli-hierarchy tick`, or a `--board-dir`
that points at the wrong board. It is not authentication and it does not contain a
hostile or confused session.

The install-location check works from the real path of the running command. If that
path is inside a git work tree, the work tree must be the main checkout, so a copy in a
task worktree, a scratch repository or any other repository is refused. If it is not
inside any work tree (a global install, the plugin cache), the check is skipped,
because there is no checkout to compare against: installed layouts get the weaker
guard. A path that cannot be resolved, or a git failure other than "not a repository",
is refused.

A session running as the same user can still defeat the guard:

- a scratch repository with a forged roster and a forged policy file, used as the
  working directory, board and `--work-dir`, together with a copy of the command placed
  inside that scratch repository so the install-location check passes;
- an installed layout, where the install-location check does not apply at all;
- redirecting git with environment variables of the `GIT_COMMON_DIR` kind (the commands
  strip the ones they know, but a list of names is not a guarantee).

The hook-level deny of `tick`, `clear` and `route-decision` for executor roles is the
control that closes this. It should be in place before `tick` is enabled with more than
one executor.

### The unblocking playbook

Every step is gated by the `operational` list in `spec.governance` of
`.ai-sdlc/agent-role.yaml` (read, never written, by the loop, and read only from the verified main checkout: the `.git` there must be a real directory, not a symlink, matching the git common dir; any doubt grants nothing) and is recorded as an
`OperatorPlaybookAction` event. A step the policy does not grant is refused and
becomes an escalation.

| Failure record | Action | Grant needed |
| --- | --- | --- |
| Mechanical conflict shape (`test-additions-overlap`, `prettier-drift`, `pnpm-lock-regen`, `package-json-bin-concat`, `behind-only`) | Rebase the task branch onto `origin/main`, then lease-push to that branch | `rebase-own-branch`, `lease-push-own-branch` |
| `stale-merge-ref` | Push an empty commit to the task branch | `retrigger-ci` |
| `stale-heartbeat`, `spawn-rejected`, `quota-exhausted`, `transient`, within the retry limit | `cli-dispatch requeue --task-id <id>` | `requeue` |
| Failed task whose verdict names an OPEN PR (PR follow-up: rebase, re-sign, push, ready flip) | `cli-dispatch reenter <pr-or-task> --note "<what to finish>"`; no retry is used, no escalation. A second `reenter` on the same `(action, head SHA)` is refused by the loop guard (AISDLC-883) | `requeue` |
| Anything else | Escalate: the planner is messaged with the task id and the failure. No git action is taken. | none |

The playbook can push to one place: `HEAD:refs/heads/<the task's own branch>`.
`main`, `master`, any other branch, any forced or deleting push and any other
refspec form are refused before git is run. A lease push is also refused, with no
git action, unless the trusted policy resolves `allowForcePush` to `leaseOnOwnBranch` (the default when unset, AISDLC-710), when
the branch is on the policy's `protectedBranches` list (or the built-in protected
names), and when the task's worktree does not verify as a genuine worktree of this
repository (under `.worktrees/`, registered under the main checkout's
`.git/worktrees/`, with a consistent `gitdir` back-pointer). Git runs with
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and every `GIT_CONFIG*` variable removed,
credential prompts off, and a two minute timeout per command, except `git push`, which
gets thirty minutes because the repository's pre-push hooks run inside it. Git is
started in its own process group, and on a timeout the whole group is killed so no
hook worker is left running. A rebase that does not apply cleanly is aborted, never
resolved by hand.

Decision ids and cause codes read from a verdict are checked before they are passed
on: a decision id must be `DEC-` followed by four to nine digits and a cause must be lower-case words
joined by hyphens. Anything else is dropped and listed in the verdict's
`rejectedFields`; `cli-dispatch complete` refuses such values outright.

`cli-dispatch requeue --task-id <id> [--retry-limit <n>]` returns one failed task to
`queue/` with its retry count incremented. It restores the manifest saved when the
task failed. It refuses, changing nothing, when the task is not in `failed/`, has no
saved manifest, is already queued, inflight or blocked, or has used its retries
(default 2).

### Clearing an executor

```bash
cli-hierarchy clear <executor-name> [--settle-ms <n>]
```

`cli-hierarchy clear` is meant for the dispatch session only. Its mistake guard resolves
the calling session from the roster and refuses, sending nothing, for any other caller,
including a human at a plain shell (it is not authentication; see "The caller binding"). A person outside the hierarchy who needs to empty a pane uses tmux
directly (`tmux send-keys -t <pane> -l -- /clear`, then `Enter`), after checking with
`cli-hierarchy status` that the executor holds no inflight task.

Looks up the executor in the roster and sends `/clear` and Enter to its pane, waits
for the settle time (8000 ms by default), then sends `/ai-sdlc executor` and Enter.
It refuses, sending nothing, when the name is not a running executor, the name or
pane id is malformed, the window is not open, or the executor holds an inflight
task, or the executor's tmux session does not carry the `@ai-sdlc-hierarchy` marker
that `up` sets (a session `cli-hierarchy` did not start is never typed into; sessions
of the old single-session layout predate the marker and are not checked). Keys are
sent only to the pane the roster names, and only after tmux confirms the pane still
belongs to that window; a recorded pane id that no longer belongs to it is refused,
never replaced by the window name. An `ExecutorContextCleared` event records the
clear.

The `hierarchy.clear` capability is reported `live` when the restart command was
sent and the executor printed its identity line again within the settle time, and
`degraded`, with the reason, when it did not or a keystroke could not be sent. A
degraded clear shows up in `doctor`; check the executor's window with
`cli-hierarchy status`.

### Per-tick self-clear

The dispatch session clears its own context after every tick so each tick starts from
the context floor. The last step of a tick refreshes the handoff file
(`operator-dispatch-handoff.md` in the auto-memory directory) when the queue, standing
rules or open-PR list changed, then runs `cli-hierarchy clear --self [--resume-after <seconds>]`.
That command resolves the session's own pane from its roster entry, refuses any caller
that is not the dispatch session, and has a detached process type `/clear` and then
`/ai-sdlc operator-dispatch` 60 seconds later. With `TMUX_PANE` unset it falls back to a
60 second `ScheduleWakeup` without a clear.

### Planner context ceiling

The planner hands off and clears at 15% of the window (150k tokens), without exception.
It keeps its handoff file current as rulings happen and delegates review rounds and
orchestration loops instead of running them in its own context.

### Events

`HierarchySessionStarted` (from `cli-hierarchy up`), `ExecutorContextCleared`,
`DecisionRouted` (`cli-hierarchy route-decision`) and `OperatorPlaybookAction` are
written to the orchestrator events stream.
