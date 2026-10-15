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
verdict, and flips CodeQL-clean drafts ready when `mark-ready-after-codeql` is granted.
The JSON also carries the caller's `identity` (`name`, `planner`), the `handoff` file text,
`selfClear` (whether `TMUX_PANE` is set) and `nextWakeSec`/`wakeReason`: 30 when a brief or
verdict was handled, 300 when work is queued or inflight, 1800 when the board is empty and
nothing is inflight. The session sleeps that long (a new brief or verdict file wakes it
early), so an idle board costs at most two model calls an hour. A draft PR whose CodeQL
run is still pending waits up to the idle interval (1800 s) before mark-ready flips it, and
a standing failed Analyze job does not shorten the sleep. Exit `0`; `1` on a guard refusal; `2` on a malformed number or a retry limit above
the cap.

**Stall check (AISDLC-826).** Every tick also checks each inflight claim once. The
pipeline refreshes the claim's heartbeat (`inflight/<task>.state.json`, `lastHeartbeat` and
`currentStep`) on every `next-step` transition, so a live executor is never silent for
longer than one step. A claim is stalled when its heartbeat is older than the stale
threshold (default 30 minutes, `AI_SDLC_DISPATCH_STALE_MS`), or when its holder session is
`idle`, `gone` or `unknown` in `status` and the heartbeat is older than the grace (default
10 minutes, `AI_SDLC_DISPATCH_STALL_GRACE_MS`) with no verdict in `done/` or `failed/`. A
stalled claim moves to `failed/` with `cause: stale-worker`, `lastStep` and
`heartbeatAgeMs`; the holder is cleared (which restarts its executor loop with
`/ai-sdlc:executor`) and the task is re-queued with a resume note naming the step it
stalled at and any existing pull request number, so no developer re-runs when a PR exists.
The tick result carries `stalled` (`taskId`, `worker`, `ageMs`, `step`) and a progress line
per reap. This is operational: the planner is not asked. Clearing needs
`clear-executor-context` and the re-queue needs `requeue`; the playbook treats both
`stale-worker` and `stale-heartbeat` failures as re-queue-with-resume-note shapes.

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
verdict (step "Stop" in [The executor loop](parallel-dispatch.md#the-executor-loop)); `clear`
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
| `behind-or-dirty` | `land-prep` | until AISDLC-881: `resume` with a rebase note ([hand-review-path.md](hand-review-path.md)) |
| `attestation-content-hash-mismatch` | `push-only-resign` | `resume` with a push-only re-sign note (AISDLC-821) |
| `real-failure` | `reenter` | until AISDLC-882: `resume` carrying the failing check line and head SHA |
| `cancelled-or-infra` | `retrigger-once` | `gh run rerun --failed --commit <sha>`; once per head SHA |
| `ready-to-flip` | `flip-ready-takeover` | `gh pr ready <n>`, only after executor death post-sign |
| `armed-clean`, `pending` | `none` | nothing |
| `no-match` | `route-to-planner` | the only state routed to the planner |

**Docs action set** (machine-owned from birth):

| Situation | Action | What runs |
|---|---|---|
| `behind-or-dirty` | `rebase-in-place` | `cli-file rebase <id> --pr` |
| failing DoR check | `rerun-dor` | `gh run rerun --failed --commit <sha>` |
| green, CLEAN, not armed | `arm` | `cli-merge-if-eligible <pr> --source-kind backlog` with the arm flag |
| other real check failure, `no-match` | `route-to-planner` | planner |
| `cancelled-or-infra` | `retrigger-once` | rerun once per head SHA |
| `merged` | `mark-landed` | record `landed` |
| remaining states | `none` | nothing |

Rows are checked in this precedence: landed, manifest mismatch, stale claim, BEHIND/DIRTY,
attestation, pr-ready, cancelled/infra, then the green and pending rows.
`cli-dispatch classify-prs --input <facts.json>` remains for fixtures and writes one
`DispatchPrClassified` event per PR.

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
request. The command exits 1, changing nothing, when the task has no verdict.

`resume` accepts three verdict outcomes (AISDLC-807): a `done/` verdict with outcome
`success`, a `done/` verdict with outcome `iterate-needed` (the executor returned for another
round), and a `failed/` verdict (a failure). The manifest carries `resume.prNumber`,
`resume.note` and `resume.fromVerdictOutcome`, the outcome it was resumed from. A task with
no verdict is refused. `cli-dispatch requeue --task-id <id> --note "<text>"` returns a failed
task with the same `resume.note` block, so there is one note channel. `cli-dispatch release`
is refused for a task that already has a verdict in `done/`; run `resume` to send it back, or
`remove-verdict` to discard the verdict first.
**Three board behaviours (AISDLC-868).**

- `cli-dispatch remove-verdict --task-id <id> --from failed` removes the verdict and
  diagnostic. It also removes the `failed/<id>.manifest.json` copy when `--with-manifest true`
  is passed or when the task file is already in `backlog/completed/`, so no stale failed
  manifest outlives a finished task (the AISDLC-800 invariant). Otherwise the manifest stays,
  because a live resume or `requeue` needs it. Pass `--work-dir` when not run from the repo root.
- `resume --failing-checks` (and `--failing-check`) splits on commas only and trims each item.
  Spaces, ampersands and parentheses stay inside a name, so
  `"Backlog Drift,Build & Test (Node 22)"` records exactly two checks.
- Brief ingestion by `cli-hierarchy tick` skips a task already on the board (a resume, for
  example) instead of refusing the whole brief. The tick result lists each one under `skipped`
  as `{ file, taskId, state }` and ingests the rest; the exit code is unchanged. A brief whose
  tasks are all on the board is marked ingested with no tasks.

`cli-dispatch idle-backoff` prints the sleep (5 to 60 seconds) an executor without a tmux
pane uses when the queue is empty.
