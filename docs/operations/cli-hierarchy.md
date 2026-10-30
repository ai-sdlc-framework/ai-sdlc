# `cli-hierarchy` Reference

`cli-hierarchy` starts, inspects and stops the session hierarchy: a planner, a dispatch
session and up to five executors, each a Claude Code session in its own tmux session.
It replaces the retired `/ai-sdlc execute-parallel` (AISDLC-763); the executor loop, the dispatch loop, liveness and
the cancel back-channel are documented at the end of this page. RFC: [RFC-0051](../../spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md).

The documented entry point is the plugin command, which runs `cli-hierarchy` from the
resolved pipeline-cli bin (works from an installed plugin, not only the dogfood repo):

```text
/ai-sdlc hierarchy <command> [options]
```

It passes `up`, `status`, `attach`, `terminals`, `brief` and `down` through unchanged,
with these differences: `attach` and `up --attach` print the shell command to run (a
Claude Code session cannot switch your terminal); `down` runs at once, with no
confirmation (AISDLC-1104); `clear`, `tick`, `restart`, `register`, `playbook`, `route-decision`, `check-repo` and
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

Start the planner and the dispatch session, each in its own detached tmux session, and write
the roster. No executor is started: dispatch spawns one executor per task with [`spawn`](#spawn)
(RFC-0059, AISDLC-1075). Idempotent: sessions already running are left alone and
only the missing ones are started. It also starts the reconcile scheduler (`cli-dispatch reconcile --watch`, which polls `<board>/.reconcile-wake`) as a detached process and records its pid in `<board>/reconcile-scheduler.json`; a second `up` with a live scheduler starts no other.

```bash
cli-hierarchy up [--executors <n>] [--planner-model <m>] [--dispatch-model <m>]
                 [--executor-model <m>] [--no-planner] [--project <name>]
                 [--attach] [--planner-permission-mode <m>] [--allow-planner-bypass]
                 [--no-vscode-tasks] [--node <version>] [--rebuild]
```

| Option                   | Meaning                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `--executors <n>`        | Deprecated: standing executors, 0 to 5 (default 0); a value above 0 prints a deprecation line and is removed in the next release. |
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
| `--rebuild`              | Rebuild a stale or missing `pipeline-cli` build, then launch (see below).    |

**Stale build refusal (AISDLC-988).** In the ai-sdlc monorepo `up` first runs
`resolve-pipeline-cli.sh --strict` (also `AI_SDLC_RESOLVE_STRICT=1`). When the repo's own
`pipeline-cli/dist` is missing or older than its sources, `up` exits non-zero and prints
`pnpm --filter @ai-sdlc/pipeline-cli build`; it never falls through to the plugin cache,
which holds the last release and lacks newer subcommands. With `--rebuild`, `up` runs that
command itself and then launches. Other callers of the resolve script, without `--strict`,
keep the warning and the cache fallback. `ai-sdlc doctor` reports the same condition as
`stale-repo-build`.

**The monorepo never runs on the plugin-cache CLI (AISDLC-1001).** Superseding the
non-strict fallback above: in a repo that has `pipeline-cli/src`, `resolve-pipeline-cli.sh`
runs `ensure-pipeline-cli-built.sh` (one `pnpm --filter @ai-sdlc/pipeline-cli build`, only
when `dist` is missing or older than `src`) and prints the repo bin. If the build fails it
exits 1 with the build error line on stderr, which the dispatch tick's resolve step shows;
it never prints a plugin-cache path. `--strict` is accepted and now implied. The cache
fallback remains only for consumer repos without `pipeline-cli/src`. The same helper runs
in worktree setup (once, after install) and in `scripts/check-followups.mjs` when its rule
module is missing, so a fresh executor worktree no longer fails the push on a missing dist.

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
  or lower-tier messages are not delivered. `up` refuses with the exact fix otherwise. The
  managed (enterprise) settings file is read last because it has the highest precedence
  (AISDLC-664.5). A per-session `--settings` override is declined: it would outrank the
  operator's own files and change approval behaviour for the planner, so the planner keeps its
  held-message gate by the value in the files alone.
- **Resource gate (opt-in).** Off by default. With `hierarchy.resourceGate: true` under `spec` in
  `.ai-sdlc/pr-lifecycle.yaml` (read from the base branch), `up` refuses unless at least 4 GiB of
  memory is available and the 1-minute load average is below the core count. The
  `AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE` variable no longer exists.
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
The line after it is the reconcile scheduler (the poller of `<board>/.reconcile-wake`): `scheduler: up (pid N)` or `scheduler: off`. Below it, `open PRs:` lists every open PR with lane, action, reason, owner and age. The scheduler writes stdout and stderr to `<board>/log/reconcile.log`, which also receives one row per open PR per run; the same lane, action, reason, owner and `lastActionAt` fields are copied onto each row of `pr-snapshot.json`. The tick forwards to the planner only the routings new in that run. A failed action is retried once on an unchanged head; the second failure routes the PR to the planner once and the row reads `reenter (failed x2)` (AISDLC-1125).
A `gh calls last hour` line (AISDLC-963) gives each `HIERARCHY_SESSION`'s `gh` calls in the last hour and the live remaining
quota for the core and graphql buckets (`gh api rate_limit`, not metered). The source is `<board-dir>/gh-calls.jsonl`, one
JSON line per call (`at`, `session`, `argv`, `exit`, `remaining` when `gh api -i` printed it), written by the runner in
`runtime/exec.ts` and by a `gh` shim that `up` puts first on each session PATH (`<board-dir>/bin/gh`, which execs the real
binary) for callers that spawn `gh` directly. Lines older than 24 hours are dropped on each `status`. The dispatch tick skips its
GitHub reads (human-attention list, mark-ready, landing) and reports the skip when the lowest remaining bucket is below the floor
(default 300, override with `AI_SDLC_GH_QUOTA_FLOOR`). The gate workflow prints the Actions quota at the start (`detect`) and end
(`pr-ready`) of each run in the job summary.
The `MODULE` column (AISDLC-1061) is the hierarchy hooks module's heartbeat for the session, read from
`<board-dir>/handoff/module-<name>.json` (`{state, reason, version, at}`): `loaded`, `refused: <reason>`,
`absent` (no file: the session has no hierarchy role, or the module never ran in it) or, for the dispatch
host only, `stale: ...` when its per-tick refresh stopped for two minutes. The module's `session.start`
gate writes the file through `$.process.run`; the dispatch role refreshes it on every tick. `up` ends by
waiting up to 60 seconds (two tick intervals) for the dispatch host to report `loaded`, else exits 1 naming
the reason and the fix (`--no-module-check` skips it); `ai-sdlc doctor` has the same check
(`hierarchy-module`). See Troubleshooting, "Module absent".
The `CONTEXT` column (AISDLC-1066) is the session's live context size in k tokens: the last assistant record's
`usage` (input plus cache read plus cache creation) in its transcript
`~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`, found through the session id in the harness session
registry and read by seeking from the end of the file (at most 1 MiB, never the whole file). `OVER` follows the
value when it exceeds the role's clear threshold, `?` means the transcript could not be found, and `-` a
session whose window is gone. `status --json` carries `contextTokens` and `overThreshold` per session; `status`
and `up` print one `warning:` line per session that is over. This catches the dead-module case: when the hooks
module is not loaded nothing rotates the session, so an executor sits at 450k to 966k context showing `busy`
and `ENV ok`; the column makes that visible within an hour. The CLI only reports; rotation stays with the
module and the dispatch session.
A final `unbriefed` line lists dispatchable open tasks under `backlog/tasks/` that are on no
brief and not on the board (nothing would ever queue them); write a brief for them.

```bash
cli-hierarchy status [--json]
```

`--json` prints one JSON object: `{ "rows": [ { "entry": <roster entry>, "state": "...",
"attached": true|false, "inflightTask": "AISDLC-N", "launchEnv": "ok|missing",
"nodeVersion": "22.23.2", "nodeMismatch": true, "module": { "state": "loaded|refused|absent|stale", "reason": "..." }, "nextStep": "..." } ], "board": { "queued": n,
"inflight": n, "done": n, "failed": n }, "webhook": { "state": "up", "port": n, "pid": n }, "scheduler": { "state": "up", "pid": n } }`. Read-only. Exit code `0`.

### Drain stall (AISDLC-1101)

Each dispatch tick checks for a drain that stopped moving: eligible queued work, an idle executor holding no
inflight task, and an unchanged board (queue, inflight, done and failed counts) for longer than
`stallAfterMinutes` (default 30, set in `<board-dir>/config.json`). It writes one record to
`<board-dir>/drain-stall.json` (opens and closes are appended to `drain-stalls.jsonl`), names the stage that
did not run (`clear-and-wake-after-verdict`, `wake-after-ingest`, `claim` or `wake`) and sends one `drain-stall`
report to the planner. `cli-hierarchy status` prints the open stall as a `drain-stall:` line (and `drainStall` in
`--json`). The record closes by itself when the board moves or the condition lapses. Nothing is recorded while
the board is held.

### Stall thresholds (AISDLC-1103)

The stall reaper uses two thresholds for every worker, roster or ephemeral. `graceMs` (default 10 minutes) applies
only when the holder session is `gone` or `unknown`: the claim is then reaped as `holder-not-busy`. An `idle` holder is not reaped early (AISDLC-1124): a backgrounded developer leaves the pane idle for its whole pass, so the board (manifest plus a heartbeat under `staleMs`) decides busy. `staleMs`
(default 30 minutes) applies whatever the session state: a heartbeat older than it is reaped as `stale-heartbeat`, so a
busy developer pass is never reaped before 30 minutes.

### `stall-notice`

An alert-only check for a drain that stopped moving (AISDLC-871). With eligible queued work and
no new verdict and no moved heartbeat for N minutes it raises one desktop notification
(`osascript` on macOS, `notify-send` elsewhere) and appends one line to
`<board-dir>/stall-digest.log`. The same stall is reported once: the progress timestamp it was
reported for is kept in `<board-dir>/stall-notice.json`, so a second run says nothing until
something moves and stalls again. An empty queue or recent progress sends nothing. It never
relaunches a session, never sends keys or messages to one and never starts a model, so it spends
no tokens.

```bash
cli-hierarchy stall-notice [--minutes <n>]
```

`--minutes` overrides the default of 45. It prints one JSON object (`action`, `reason`,
`idleMinutes`). Exit code `0`. Run it on a timer, for example every 10 minutes from cron:

```cron
*/10 * * * * cd /path/to/repo && node pipeline-cli/bin/cli-hierarchy.mjs stall-notice >> /tmp/stall-notice.log 2>&1
```

or from a launchd agent (`~/Library/LaunchAgents/io.ai-sdlc.stall-notice.plist`) with
`ProgramArguments` of `node`, `pipeline-cli/bin/cli-hierarchy.mjs`, `stall-notice`,
`WorkingDirectory` set to the repository and `StartInterval` `600`.

### `webhook`

The local GitHub webhook receiver (RFC-0054, AISDLC-880). A delivery is a trigger, never a fact:
after the `X-Hub-Signature-256` HMAC check the receiver writes one event record into
`.ai-sdlc/dispatch/events/` (create-if-absent, named by `<repo>#<pr>@<headSha>:<kind>:<deliveryId>`,
URL-encoded) holding `repo`, `pr`, `headSha`, `kind`, `deliveryId` and `receivedAt`, and nothing else.
A replay of a delivery id returns 200 and writes nothing; a missing or wrong signature returns 401 and
writes nothing. After a record is written, deliveries for the same `(pr, headSha)` are debounced for 5 s
and then the file `.ai-sdlc/dispatch/.reconcile-wake` (the file `reconcile --watch` polls) is touched, once. A replayed delivery id or a failed signature touches nothing. The receiver never classifies or acts.

```bash
AI_SDLC_WEBHOOK_SECRET=... cli-hierarchy webhook up [--port 8765]
cli-hierarchy webhook status [--json]
cli-hierarchy webhook down
```

The secret comes only from the `AI_SDLC_WEBHOOK_SECRET` environment variable, never a file in the
repository. Without it `webhook up` does nothing and dispatch stays poll-only (not an error). The
receiver binds to `127.0.0.1` only, on `--port` or `AI_SDLC_WEBHOOK_PORT` (default 8765), at path
`/webhooks/github`. `cli-hierarchy up` starts it when the secret is set (and always starts the reconcile scheduler that consumes its wake file, see `up`). Subscribed event kinds:
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

### `brief-status`

Print each brief under `<board-dir>/briefs/` with how many of its tasks hold a verdict in
`done/`. The planner command uses it for the open-briefs step.

```bash
cli-hierarchy brief-status
```

Prints `<brief>.md: <done> of <total> task(s) done` per brief, `<brief>.md: unreadable (...)`
for a brief that does not parse, or `No briefs yet.`. Exit `0`.

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

**`after` is derived from `dependencies:` (AISDLC-1027).** A manifest written by `enqueue`,
`requeue` or `reprioritize` with no explicit `after` carries the task file's `dependencies:` as
`after`, so a hand requeue cannot skip them. A dependency counts as met only once it has
**landed**: a completion marker or a success verdict stamped `landed` in `done/`, or its task
file Done on `main`. A delivered-but-unlanded dependency holds the claim (`waiting for <id> to
land`), the same test the executor's dependency preflight applies, so the board never offers a
claim the preflight will refuse.

### `down`

End sessions, return their inflight manifests to `queue/`, close their windows and update
the roster.

```bash
cli-hierarchy down [--role <name-or-role>]
```

`--role` stops one session by name (`executor-beta`) or a role (`executor` selects all
executors); with no option every session stops, with no confirmation question, and the reconcile scheduler (the poller of `<board>/.reconcile-wake`) is stopped too. Each session is asked to exit and gets a
grace period; a window that stays open is closed by pane id. A session that does not carry
the ownership marker, or whose recorded pane no longer belongs to it, is refused and left
in the roster. Effects: manifests held by a stopped session move from `inflight/` to
`queue/`; stopped entries are removed from `hierarchy.json`. Exit `0`; `1` when any
session was refused or `--role` matches nothing.

### `restart`

Stop and start one session, or dispatch plus every executor, without `down` and `up`.

```bash
cli-hierarchy restart <name> [--after-task] [--wait <seconds>]
cli-hierarchy restart --all [--wait <seconds>]
```

`<name>` is a roster name, a tmux window or the unqualified name (`executor-beta`,
`operator-dispatch`, `planner`). The session is asked to exit (closed by pane id when it
stays open), then started again with the model, permission mode and launch environment its
roster entry records. Its roster entry (pid, pane, started time) is replaced in one atomic
write; no other entry, window or inflight manifest is touched. Restarting
`operator-dispatch` leaves every inflight manifest on the board (nothing is requeued) and
re-registers the reconcile scheduler and, when `AI_SDLC_WEBHOOK_SECRET` is set, the webhook
receiver. A window that is already gone (a crash) is simply started.

`--all` restarts dispatch, then every idle executor, now; each busy executor is restarted at
its task boundary, as `--after-task` does. The planner is left alone. One failure does not
stop the rest; the JSON lists `restarted`, `deferred`, `failed` and `skipped`, and the exit is `1` when
any failed.

A session cannot restart itself: stopping its own window would kill the command before the new
window starts. `restart <own-name>` is refused, and `restart --all` run from dispatch skips
dispatch (listed in `skipped`) and restarts the executors; ask the planner to restart dispatch.

An executor that holds a claimed task is refused: the message names `--after-task`. With
`--after-task` the command waits for the task boundary (up to `--wait` seconds, default
1500; nothing is stopped if the wait runs out), then restarts. If the executor claims its
next task in the instant between the last check and the stop, that manifest is returned to
`queue/` right after the stop (the JSON shows it as `requeued`). The roster is re-read just
before the write, so a change to another entry made during the wait is kept. If the new session cannot be started, its dead entry
is dropped from the roster and the message says to run `cli-hierarchy up`.

The dispatch or planner session may run it (the same mistake guard as `clear`, not
authentication); executors may not. A session without the ownership marker, or whose recorded
pane no longer belongs to it, is refused and left running. Prints the before and after pid,
start time and pane as JSON. Exit `0`; `1` on a refusal.

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
binding is the session name, not the pid. Dispatch session only, executors only.

### `clear`

Empty an executor's context from the dispatch side (AISDLC-1107). The clear is a dispatch-owned deterministic step:
the executor's model and hooks module are not involved, there is no marker line to print, no `rotate` message, no
request file and no acknowledgement. The verdict file under `done/` or `failed/` is the proof the task ended.

```bash
cli-hierarchy clear <name> [--settle-ms <n>]
```

| Option            | Meaning                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `--settle-ms <n>` | Ceiling for each wait for the pane prompt (default 30000, config `clear.handshakeCeilingMs`). |

The sequence, the same pane driving `restart` relies on: wait until the executor's pane shows an idle prompt, type `/clear`
and Enter, wait for the fresh prompt, type `/ai-sdlc:executor` and Enter. The dispatch tick runs it on the tick that
consumes the verdict, so "idle after verdict" cannot persist past one tick and `status` no longer reports it.

**Fallback.** When the pane shows no idle prompt, or no fresh prompt after `/clear`, within the ceiling, the command calls
`restart <name>` (kill and relaunch), which also needs no cooperation. The result says `via: "clear"` or `via: "restart"`.
Text sent to a roster pane by `send` or `brief --notify` is submitted with Enter after a 400 ms pause, so Claude Code does
not read it as a paste.

Refusals, each sending nothing and naming the cause (exit `1`; `2` on a malformed number or missing name):

- the name is not a running roster session, or its entry is unsafe;
- the session is not an executor;
- an executor that holds an inflight task (its context is work in progress);
- the tmux session was not started by `cli-hierarchy up`, or the recorded pane id is stale.

`clear <name>` is a dispatch-session command, checked by the same mistake guard as `tick` (not authentication). An
`ExecutorContextCleared` event records each clear. The over-threshold rotation (120k tokens mid-task) stays in the
executor's hooks module and is a separate concern.

### `escalation-file`

Writes `<board-dir>/escalations/<task-id>-<epoch-ms>.json` for the planner: the task's failure record
(`failed/<id>.diagnostic.json`, else its verdict), a log tail (the last 20 lines of the record's `notes`) and a
PR check summary (`gh pr checks <pr>`, first 40 lines, when the record names a PR). The dispatch host calls it for a
tick result the policy tables cannot classify, then announces the file to the planner with `$.session.send`.

```bash
cli-hierarchy escalation-file --task-id <id> --message <text>
```

Prints `{"file": "<path>"}`. Exit `2` on a missing flag, `1` on an invalid task id.

### `spawn`

Starts one ephemeral executor for one task (RFC-0059, AISDLC-1073).

```bash
cli-hierarchy spawn <task-id> [--model <m>]
```

The session name is `ai-sdlc-executor-<task-id-lowercase>` (`.` becomes `-`), matched against
`^ai-sdlc-executor-[a-z0-9-]+$` before any shell or tmux call. It creates the tmux session, writes a dynamic
roster entry (role `executor`, `taskId`, `startedAt` as the spawn time) and launches the interactive `claude`
with `AI_SDLC_EXECUTOR_TASK=<id>`. A live session of that name is reported and nothing is created; a task already
inflight is refused. The hooks module executor branch reads the variable at `session.start` and runs the executor
command at once, with no `enqueue` wake to wait for. `status` lists each dynamic executor as
`dynamic executor: <name> task <id> age <age> (<state>)`, one line per roster entry that carries a `taskId`.
A tmux session of that name that the roster does not know, with no inflight task, is an orphan (AISDLC-1117): `spawn` kills it and
creates the session, and the dispatch tick reaps every such session on its own (listed in the tick result as `orphansReaped`).
A rostered live session is never touched. The last tick's spawn failures print in `status` as `spawn error: task <id>: <error>`,
and the drain-stall check counts spawn errors with no live executor as a stall. `down` also kills the session of an ephemeral executor.
The session ends with its task (one task per executor). With the variable set, `executor-start` claims only that task, exits `1` naming the reason
when it is not claimable (or the board is held), and refuses `--wait`.

### `executor-start`

An executor's whole start-up in one call: roster identity (the calling session must be a running
executor), the `check-repo` test, then one claim (`cli-dispatch claim`, no wait). The board claim is the
authority (RFC-0051).

```bash
cli-hierarchy executor-start
```

Prints the `[executor] I am '<name>'` identity line, then one JSON line
`{"name", "project", "dispatch", "taskId": "<id>"|null, "manifest": {...}}`. Exit `1` when the session is not an
executor or the working directory is not the project's repository.

**Removed flags (AISDLC-1034, RFC-0058 phase 1).** `--wait`, `--sender-pid` and `--sender-ref` are gone, and so is
the start token (`start-token.ts`, `<board-dir>/starts/`): an executor no longer blocks in a background call, and
the start no longer checks who typed it. `check-sender` was deleted in phase 4 (AISDLC-1037): the module's roster-name check is the guard.

**Idle path.** When `taskId` is `null` the executor ends its reply with `[executor] idle` and keeps its context.

## The hierarchy hooks module (dispatch role, model-less host)

RFC-0058 phase 2 (AISDLC-1035, OQ-6). With `HIERARCHY_ROLE=operator-dispatch` the same module hosts the dispatch
loop and **never submits a prompt to the dispatch model**; its dispatch code has no `prompt.submit` port.

- **Guard.** The version floor plus a probe of `clock.every`, `process.run`, `session.send`, `ui.open` and
  `session.measure`; a miss registers nothing and logs one line naming it.
- **Timer.** `$.clock.every(ms, fn)` (default 30 s, module option `tickMs`) runs `node pipeline-cli/bin/cli-hierarchy.mjs tick`
  through `$.process.run`. The result goes to the board and the pane, never to the model. Ticks do not overlap.
- **Consumed events.** `session.receive` consumes `verdict <task-id> ...` (applied with `cli-dispatch collect-verdicts`,
  then an immediate tick), `landed #<pr>` (`cli-dispatch reconcile --pr <n>`) and `status ...` messages, then refreshes
  the pane. A message starting `planner:` or `to planner:` is forwarded with `$.session.send` to the planner roster
  name (module option `plannerName`, default `planner`). A message of an unknown shape becomes an escalation file.
- **Escalation file.** A tick `escalations` entry, a tick that returns no result, or an unclassified message is written
  with [`escalation-file`](#escalation-file) (failure record, log tail, PR check summary, the RFC-0056 OQ-5 shape) and announced to the
  planner by one `$.session.send`. The dispatch model is not prompted. Tick `reports` and a changed `blockers` list
  are sent to the planner the same way.
- **Board pane.** `$.ui.open` plus an `ui.render` handler show roster, queue, inflight, done, failed and blockers from
  `cli-hierarchy status --json`, then the last ten events; it is rebuilt on every tick and consumed event and replaces
  the model-written tick notes.
- **Executor wake.** When a tick ingests tasks, the host sends `enqueue <task-id>` with `$.session.send` to one idle
  executor per task; the executor module consumes it.
- **Rotation.** At 120k tokens (`session.measure`) the host writes the
  handoff and runs `clear`. It rarely happens: the host has no model turns.
- **Deleted.** `cli-dispatch idle-backoff`, the dispatch half of `clear.ts`, and the loop prose of the
  operator-dispatch command, which is now a role description.

Interim assumptions (a hooks module has no process or file API and the host contract is read from the RFC): the payload shapes of
`$.clock.every(ms, fn)` (AISDLC-1082: the host throws `$.clock.every takes a function` for the old `{ ms, run }` object; the first argument is the interval in milliseconds, the second the callback), `$.process.run([command, ...args])` (AISDLC-1082: the host takes an argv list of strings and rejects `{ command, args }` with "takes argv, a non-empty list of strings naming the command first"; result `stdout` plus `exitCode`) and the
`ui.render` return value are verified by `claude plugin test` fixtures against engine-written types when available.

## The hierarchy hooks module (executor and planner roles)

`ai-sdlc-plugin/hooks/hierarchy/register.tsx`, listed under `modules` in `ai-sdlc-plugin/hooks/hooks.json`
(RFC-0058, OQ-2). It replaces the 25-minute `--wait` poll and the typed `/clear` for an executor.

- **Role gate.** At `session.start` it reads the role (`HIERARCHY_ROLE` or `AI_SDLC_HIERARCHY_ROLE`, the module option
  `role`; a record carried in `$.store` is never a role source and `session.start` clears a stale one). With no role it
  registers no role hook.
- **Version and primitive guard (OQ-5).** It compares `$.session.version()` with the floor recorded by the phase 0 spike
  (2.1.307) and probes `prompt.submit`, `command.run`, `session.compact`, `session.measure` and `session.send`. The validator
  refuses `typeof $.noun.verb`, so each probe is one call with a bare-string argument (never an object with fields) that
  a typed host rejects before acting; only an absent primitive counts as missing. On a miss it
  registers nothing and logs one line naming the missing primitive and the floor (the `hierarchy/log` list in `$.store`).
- **Start line (OQ-4).** The line names the role and the detected tier; when `$.session.identity()` answers, the identity
  is recorded as an informational field, never as authority.
- **Spawned executor (AISDLC-1075).** With `AI_SDLC_EXECUTOR_TASK` set at launch (`spawn`), the executor branch runs
  `$.command.run({ command: 'ai-sdlc:executor' })` at `session.start` and does not wait for a wake; `executor-start`
  claims exactly that task.
- **Wake (legacy standing executors).** `session.receive` consumes an `enqueue` message from the dispatch roster name (no model turn) and calls
  `$.command.run({ command: 'ai-sdlc:executor' })` (the host refuses `$.prompt.submit` of a text starting with `/`). A task
  with no turn activity for 30 minutes no longer mutes later wakes. Status noise from dispatch is
  consumed; anything else passes through.
- **Rotation (OQ-1).** At 120k tokens (never mid-task) the module writes the
  handoff, runs `$.command.run({ command: 'clear' })` with `$.store` carrying the role, resume command, last reply and a
  timestamp, and runs the resume command from the first hook of the new session (`turn.start`, `session.measure` or
  `session.receive`, since `session.start` does not fire after a mod-run clear; a record older than 10 minutes is dropped). On `{ drop }` it runs `$.session.compact` with the hierarchy
  summary prompt; on a second failure it ends the session so `cli-hierarchy up` starts a fresh one. A measure over 120k tokens during a task waits for the task's last reply. After a verdict, dispatch clears the pane from the verdict file ([`clear`](#clear)); the module reads no marker line.
- **Planner role (AISDLC-1036).** The same rotation function serves the planner, differing in threshold and handoff
  role. `session.measure` at 150k tokens runs `handoff write --role planner` first, then `clear` (compact, then session
  end as fallbacks); a measure that lands during a turn waits for the main thread's `turn.complete`, so the planner
  never rotates mid-turn. The last reply of each main-thread turn is stored in `$.store` under the roster name
  (`hierarchy/last-reply/<name>`, the launcher's `AI_SDLC_HIERARCHY_SESSION`), and the resume runs
  `/ai-sdlc:planner` with `last-reply: <text>` as its arguments, which the planner command prints for the operator.
  This replaces `LAST_MESSAGE.md`. `session.receive` passes rulings and escalations (including the escalation-file
  notices dispatch announces) to the model unchanged and consumes only status noise from the dispatch session.
- **Roster wrapper.** A planner messages a session by hand only through [`send`](#send), which refuses a name the
  roster does not list. Address roster names, or reply to the `from` address of a message you received; never a name from memory or convention.
- **Mixed fleets.** A tmux-driven dispatch session can still enqueue for a mod-driven executor: both read the same board.

**Single clear rule (AISDLC-815).** A hierarchy session clears when its context passes its role threshold (the
module rotation: planner 150k, dispatch 120k, executor 120k tokens; the module uses these built-in values, and
`contextThresholds` in `<board-dir>/config.json` only changes what `cli-hierarchy status` prints), or when an executor's task finishes (dispatch
clears it on the verdict). There is no per-tick clear for dispatch and no idle-wait clear for executors. Motivation:
in the 24 h to 2026-10-11 the ledger recorded 375 task-less sessions under 300k weighted units each, 49M units
(11% of the day), spent re-reading the fixed prefix after per-tick and per-idle clears.

### `handoff`

Write or read a session's handoff file. The file is generated from board and catalog state
(roster, queue, inflight tasks, blocked and failed tasks, open decisions), never from prose,
so it cannot go stale by omission.

```bash
cli-hierarchy handoff write --role <planner|operator-dispatch|executor> [--name <n>] [--out <path>]
cli-hierarchy handoff read  --role <planner|operator-dispatch|executor> [--name <n>] [--out <path>]
cli-hierarchy handoff note  --role <r> --kind filed|commented|opened|closed|sent --url <url> [--summary <text>] --board-dir <dir>
```

| Option         | Meaning                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| `--role <r>`   | `planner`, `operator-dispatch` (alias `dispatch`) or `executor`.                             |
| `--name <n>`   | Session name; default the calling session's roster name, else the role.                      |
| `--out <path>` | Use another file location.                                                                   |
| `--full`       | `read` only: print the whole file instead of the bounded view.                               |
| `--no-archive` | `write` only (planner): write the block without rolling older notes into the archive file.   |

Files: dispatch and executors write `.ai-sdlc/dispatch/handoff/<session-name>.md`; the planner
writes its dated memory file, `.claude/memory/project_planner_handoff_YYYY_MM_DD.md` (an
existing dated file is reused). The generated text sits between
`<!-- ai-sdlc-handoff:begin -->` and `<!-- ai-sdlc-handoff:end -->` with a hash of the state it
was built from; text outside the markers (the planner's own notes) is kept on every rewrite.
A file without markers gets the block right after its frontmatter.
**One current notes block (AISDLC-933).** For the planner, `write` keeps exactly one
`## RESUME HERE` section in the live file (the last one) and appends the older ones, plus any
prose before the markers that is not frontmatter or the `# ` title, to
`<basename>_archive.md` beside it, so the generated block is the first content after the
header. The output reports `archivedBlocks` and `archiveFile`; a write with nothing new to
archive touches neither file. Pass `--no-archive` for the old block-only behaviour. Put notes at the end of the
file: `read` prints the generated block, then the last 8000 characters (cut at a line boundary)
of the prose outside the markers, then the file path; `--full` prints the whole file.

Call `write` after each state change (a ruling recorded, a task claimed, a verdict written, a
brief sent). `read` recomputes the hash first and regenerates a missing or stale file, so a
stale file is never read as current.

**Outward-action ledger (AISDLC-1049).** `handoff note` appends one JSON line
(`at`, `role`, `kind`, `url`, optional `summary`) to `handoff_ledger_<role>.jsonl` beside the
handoff (`.claude/memory/` for the planner, `<board-dir>/handoff/` otherwise). Use it in the same
turn as any post outside the repository (an issue filed, a comment, a hand-opened PR, a message
to another project's session). An unknown `--kind` is refused with the allowed list. `write`
renders the newest 20 lines, newest first, under `## Outward actions` inside the generated block,
and `read` prints them with the block. The ledger is append-only: `write` never rewrites it.

**Resume contract.** After any `/clear`, the first thing a loop body does is
`handoff read --role <r>`; the file and the board are all a fresh context needs. The resume
command per role is `/ai-sdlc:planner`, `/ai-sdlc operator-dispatch` and `/ai-sdlc executor`.

### Dispatch loop measures itself (RFC-0051 section 6)

The dispatch loop is meant to be mechanical, so `tick` measures it:

- **Tick marker.** Every tick emits a `DispatchTick` event (`tickId`, `startedAt`, `endedAt`,
  ordered `steps`, `nextWakeSec`) so the usage ledger can bucket the dispatch session's model
  calls per tick. A call belongs to the tick that had started at or before it and the next had
  not, and to the latest step of that tick that had started.
- **Turns per tick.** `cli-usage scorecard` prints an `operator-dispatch` line (and a
  `dispatchTurns` field in JSON) with the median and p90 turns per tick over the window,
  against `dispatch.turnsPerTickBudget` (default 5, see [`usage-ledger.md`](usage-ledger.md)).
  The dispatch session's calls are recorded under the agent role `operator-dispatch`.
- **Decision on overrun.** When the median over the last 20 completed ticks exceeds the
  budget, `tick` files one Decision (scope `dispatch-turns-per-tick`) naming the step that used
  the most turns, with the options `move-step`, `raise-budget` and `accept`. Further overruns
  while it is unanswered file nothing (`turnBudget.skipped`).

### Context thresholds (AISDLC-815, AISDLC-1036)

The auto-clear Stop hook, `cli-hierarchy auto-clear` and `LAST_MESSAGE.md` persistence are gone
(AISDLC-1036): the [hierarchy hooks module](#the-hierarchy-hooks-module-executor-and-planner-roles) rotates a
session when `session.measure` pushes a token count over the role's threshold, so nothing parses a transcript.

| Role                | Default threshold (tokens) | Resume command              |
| ------------------- | -------------------------- | --------------------------- |
| planner             | 150000                     | `/ai-sdlc:planner`          |
| operator-dispatch   | 120000                     | `/ai-sdlc operator-dispatch` |
| executor            | 120000                     | `/ai-sdlc executor`         |

`cli-hierarchy status` prints the thresholds from `.ai-sdlc/dispatch/config.json` (display only: the hooks module rotates at the built-in values in the table above):

```json
{ "contextThresholds": { "planner": 150000, "operator-dispatch": 120000, "executor": 120000 } }
```

Missing or invalid values fall back to the defaults.

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
  output of `handoff read` (bounded view; when still over 12000 characters the middle is dropped, keeping the state block and the newest notes) for a roster session; for the planner
  it also says to list scheduled jobs and recreate lost ones. The planner's routine is in
  `commands/planner.md`; dispatch batches non-blocking reports to the planner into one hourly
  digest (`commands/operator-dispatch.md`). The executor's clear-between-tasks flow is unchanged.

**Not verified or not possible with documented APIs** (written offline): the exact status line
JSON fields (`context_window.used_percentage`, `session_id`), the Stop hook `systemMessage`
output field, and the SessionStart `compact` source name are taken from the task's notes and
must be checked against current Claude Code docs. A hook cannot run `/compact` or `/clear`; it
can only print a line to paste. A mod could call `$.session.compact({ instructions })` from a
button (the `context-meter` mod calls it without instructions today), and whether a mod can run
`/clear` is unverified, so clearing stays a human action (or the module's 150k rotation above).

### `canary`

Loop canary (AISDLC-1102). `cli-hierarchy canary run --no-pr` enqueues two synthetic docs-only tasks
(`CANARY-<n>` and `CANARY-<n+1>`) and polls the board for five stages in order, each with its own
deadline counted from the previous stage: `claimed` (15 min), `developed` (30 min, the verdict lands
in `done/`), `verdictRecorded` (10 min, the dispatch tick handled it), `executorCleared` (10 min, the
clear stamp `canary-runs/cleared/<executor>.json` is newer than the verdict) and `reclaimed` (15 min,
the second task was claimed). `--no-pr` is required: the canary never opens a pull request. It
refuses under a hold.

```bash
cli-hierarchy canary run --no-pr
```

Records are `<board>/canary-runs/run-<n>.json` (`status` pass or fail, the stages seen, and on
failure `failedStage` and `reason`). A failure also sends the planner a message naming the stage.
The dispatch tick runs the canary without operator action: on the first tick after `up` and then
daily, never while the board is held. The synthetic `CANARY-` ids are excluded from the board's
queued, done and failed counts, and a failed canary verdict never runs the playbook. An executor
that claims a `CANARY-` task does no development: it reports a `success` verdict with the note
`canary` and stops.

### `hold`

Pause the drain without silencing it (AISDLC-899). `hold` writes `<board>/.hold`
(`{reason, since, by}`); `resume` removes it. Only the planner or the operator at a shell may run
either; dispatch and executors are refused.

```bash
cli-hierarchy hold --reason <text>
cli-hierarchy resume
```

While held, `tick` still ingests briefs, watches verdicts, classifies PRs and returns `reports`
and `escalations`, plus `held` (`reason`, `since`, `by`); it does not clear executors, run the
playbook, re-queue failures or reap stalled claims (a failure becomes an escalation instead).
`executor-start` claims nothing, prints `BOARD HELD: <reason>` and returns `taskId: null` with
`held`. A held board with open work wakes on the `active` cadence. The tick JSON also carries
`blockers`: the hold, failures awaiting the planner, queued tasks waiting on an unfinished
prerequisite, and queued work with no running executor; dispatch sends it to the planner whenever
it differs from `<board>/.blockers-sent.json`. Holds and resumes are appended to
`<board>/hold-events.jsonl`.

The tick JSON also carries `eligibleQueued` (queued task ids that can be claimed, in claim order; empty
while held), `idleExecutors` (names of idle executor sessions) and `holdLifted` (true on the first tick
after a hold was lifted). The hooks module wakes idle executors on every tick that has both, not only
when a brief was ingested; an executor woken on one tick is skipped on the next (one-tick back-off), and
`holdLifted` clears the back-off.

| State   | Claims | Relaunches / re-queues | Reports and escalations |
| ------- | ------ | ---------------------- | ----------------------- |
| running | yes    | yes                    | yes                     |
| held    | no     | no                     | yes                     |

A hold limits actions, never reporting; the rule is rendered once from `prompt-rules.js` into the
planner, dispatch and executor commands.

### `block` and `unblock`

Park one queued task without pausing the drain (AISDLC-1043). `cli-dispatch block` moves
`queue/<id>.dispatch.json` to `blocked/` and records `block: {blockedAt, blockedBy, reason}`; the
claim logic never reads `blocked/`, and `cli-hierarchy status` lists each blocked task with its
reason. It refuses an inflight, done or failed task and is a no-op on an already blocked one.
`unblock` returns the manifest to `queue/` with `after`, `priority` and its queue position
unchanged. Use `hold` to pause every claim; use `block` to park one task while the others drain.

```bash
cli-dispatch block --task-id <id> --reason <text> [--by <name>]
cli-dispatch unblock --task-id <id>
```

### `resume`

Remove the hold set by `cli-hierarchy hold`; see [`hold`](#hold). Prints `{"ok": true, "resumed": <bool>}`.

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
| `--settle-ms <n>`       | Ceiling for each wait for the pane prompt (default 30000, config `clear.handshakeCeilingMs`). |
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

**Two cadences (AISDLC-960).** The busy 30 s tick works on the board alone: it claims, clears and
reissues from local files and makes no GitHub call. Its GitHub reads (human-attention list,
mark-ready, landing) run at most once per 5 minutes (`GITHUB_READ_INTERVAL_MS`, stamped as
`lastGithubReadAt` in `operator-dispatch.state.json`), earlier only when the webhook receiver
touched `<board>/.reconcile-wake` after the last read. The CI sweep runs on its own timer:
`cli-ci sweep --board-dir "$BOARD_DIR"` runs at most once per 15 minutes per board (stamp
`<board>/.ci-sweep.json`) and lists runs with `--limit 500`.

**Rejected briefs (AISDLC-952).** A brief the board refuses is recorded in
`operator-dispatch.state.json` as `rejected[<file>] = { mtime, error, parentHead }` (the older
number-only value, an mtime, is still read). Every tick lists each still-rejected brief in
`ingestErrors` with its stored error, so the handoff and status line keep showing it until it
ingests. A rejected brief is retried when its mtime changes (the planner edited it) or when
the parent `HEAD` differs from the one recorded at rejection (a fast-forward that brings the
missing task file); otherwise it is not retried.

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

**Parent upkeep (AISDLC-981).** The tick owns the shared parent checkout. Once per tick it
runs the orchestrator-state recovery (`check-orchestrator-state.sh`), the merged-worktree
sweep and the untracked-file sync with stale-debris prune; the sweep reuses the wake's
open-PR snapshot, so branches with an open PR cost no `gh` call. A refusal is a progress line
(`parent upkeep refused: ...`) and the `parentUpkeep` field of the tick result. The tick skips
the upkeep for low quota. Executors no longer repair the parent: `initTask` (Step 0) only
asserts the parent is on `main`, has no tracked changes and is at or behind `origin/main`, and
otherwise refuses with a reason that points at the dispatch tick.

A standalone `/ai-sdlc execute` (no `AI_SDLC_HIERARCHY_SESSION` in the environment) still runs
the repairs inline. Set `AI_SDLC_PARENT_UPKEEP=inline` to force that inside a hierarchy
session, or `AI_SDLC_PARENT_UPKEEP=assert` to force the assertion outside one.

### `playbook`

```
cli-hierarchy playbook --task <task-id> --action <rebase-push|retrigger-ci|requeue> [--worker <dispatch-name>]
```

Runs one named playbook step for one task (AISDLC-918), through the same guarded runner and
grant checks as `tick`, and records an `OperatorPlaybookAction` event like a tick-driven step.
It reads the task's failure record from `failed/`; a task with no failure record exits 1, and an
`--action` outside the three steps exits 2. A step whose operational grants the role lacks
(`rebase-push` needs both `rebase-own-branch` and `lease-push-own-branch`) is refused, recorded
and escalated. Dispatch-session command: the lease-push grant is exercised only through the
playbook (`tick` or this command), never a typed push; the PreToolUse lease-push guard is unchanged.

A failure record with cause `push-non-fast-forward` (written when the pipeline's push step is
refused as non-fast-forward) is classified by `tick` as `rebase-push`.

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

### `send`

Message one roster session, the planner's roster guard (AISDLC-1036).

```bash
cli-hierarchy send --to <name-or-from-address> --text "<message>"
```

Address roster names, or reply to the `from` address of a message you received; never a name from memory or convention.
`--to` may also be the `from="uds:/tmp/cc-socks/<pid>.sock"` address of a cross-session message this session received (the
hooks module records it in `<board-dir>/handoff/received-<session>.json` on `session.receive`); the text is written to that
socket. Otherwise `--to` must be a session name listed in this project's roster (`<board-dir>/hierarchy.json`, the list
`status` prints). Any other name is refused with exit 1 and a reason that names the roster source and
the names it does list, so a look-alike or another project's session never receives the text. The
message is typed into the session's pane with the same ownership checks `brief --notify` applies.
Exit `2` on a missing `--to` or `--text`. A mistake guard, not authentication.

### `demo`

Regenerate the terminal demo clip from a scenario file, with nobody at the keyboard (AISDLC-1079).
The clip shows one unit of work: the operator states a feature, the planner surfaces open
questions, the operator answers them, a brief goes to dispatch, an executor opens a PR, and the PR
lands.

```bash
cli-hierarchy demo --scenario pipeline-cli/demo/scenarios/home-page.json --out demo-out
cli-hierarchy demo run --scenario <file> --out <dir>
cli-hierarchy demo cut --cast <dir>/hierarchy.cast --beats <dir>/beats.json --out <dir>/hierarchy.cut.cast
cli-hierarchy demo render --cast <dir>/hierarchy.cut.cast --out <dir>
```

With no stage, `demo` runs the three stages in order and stops at the first non-zero one.

**Scenario file** (JSON): `request` (the one-sentence feature the operator states), `task` (an
existing `To Do`, dispatchable backlog task that implements it), `author` (optional, passed as
`--by`; default `operator`), `decisions` (at least two of `{ summary, options: [{ id, description }],
answer, rationale }`, `answer` being one of the option ids), `brief` (`{ tasks: [ids] }`),
`timeoutMinutes` and `pollSeconds`. A scenario missing a field is rejected with the field name.

**Scenario tasks are reserved.** The task a scenario names is held out of every brief until the
demo run consumes it (the run is what lands it). When a scenario's task has landed by another path,
retire the scenario in the same PR; the loader test fails until you do. The current scenario is
`home-page.json` (AISDLC-1106), consumed by ai-sdlc.io (`shorts/scripts/render-demo.mjs`).

**Stages.**

- `run` checks that `asciinema`, `agg` and `ffmpeg` are on PATH (one line per missing tool), that
  the roster has an idle executor, that the task is `To Do` and dispatchable, and that the checkout
  is clean. It then re-executes itself (`demo run --inner`) under `asciinema rec --overwrite
  --idle-time-limit 2 --cols 120 --rows 30`, writing `<out>/hierarchy.cast`. The inner run adds each
  decision (`cli-decisions add`, scope `issue:<task>`, source `ad-hoc`), lists them, answers them,
  runs `cli-hierarchy brief --tasks <ids> --notify`, then polls `cli-dispatch board --json`,
  `gh pr list --search <task>` and `gh pr view` once per `pollSeconds`, printing one line per
  transition, until the PR is `MERGED` or `timeoutMinutes` elapse. Each beat (`request`,
  `questions`, `answers`, `brief`, `pr-opened`, `pr-landed`) is written to `<out>/beats.json` with
  its elapsed seconds on the recorded clock (idle gaps capped at 2 seconds, like the recording), so
  the cut never parses terminal text.
- `cut` keeps at most 8 seconds of events around each beat (2 before, 6 after), drops the rest,
  rescales any gap over 1.5 seconds down to 1.5 seconds, and writes a cast of 30 to 60 seconds.
  It reads asciicast v2 or v3.
- `render` runs `agg` (dark theme, font size 22, 120 by 30 cells) to a GIF, then `ffmpeg` to
  `hierarchy.mp4` (libx264, crf 18, yuv420p, faststart) and `hierarchy.webm` (libvpx-vp9, crf 32),
  both without audio, extracts `hierarchy-poster.png`, and writes `manifest.json` (task id, PR
  number, merge sha, cast and cut durations, asciinema, agg and ffmpeg versions).

**Honesty rule.** Only the operator's request and the scenario's answers are typed by the command;
every other line in the clip is the real output of a real command. Nothing is replayed from a
canned transcript, so the clip doubles as an end-to-end smoke test of the hierarchy.

**Exit codes.** 0 on success; 2 for missing flags, an invalid scenario or an unknown stage; 1 for a
failed preflight, a failed command, a run that times out (the cast is kept for inspection and
nothing is rendered), a beat missing from the beats file, a cut outside 30 to 60 seconds, a failed
render step, or a video over 4 MB.

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
3. **clear.** When an executor's task reaches a verdict, the dispatch tick clears its pane from the
   verdict file (AISDLC-1107); `clear <executor>` is the manual form of the same step.

Self-clear rule: **one task per executor context**, and **the dispatch session does not clear
itself between ticks** (the model-less host runs the tick on a timer, see [the dispatch role](#the-hierarchy-hooks-module-dispatch-role-model-less-host)).
It rotates through its hooks module at 120k tokens. Every role, the
planner included, also clears itself automatically when its context passes its [threshold](#context-thresholds-aisdlc-815-aisdlc-1036);
handoff files are regenerated by the CLI, so a session can be cleared at any moment.

How `clear` interacts with an executor's loop: the executor's loop ends after it reports a
verdict (step "Stop" in [The executor loop](#the-executor-loop)); the rotation
then empties the context and runs the resume command, starting a fresh pass. An executor
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
action. A PR that merged is detected through its record and marked `landed`. When the merged
PR's task is inflight with an `iterate-needed` verdict, the reconciler completes it as `success`
(inflight worker, PR number, `landed` stamp), which frees the executor's slot; the pass names
the task in `acted` (`auto-complete`). The landing step does the same for a PR it squashes now
(`autoCompleted` in the tick's `landed` report). A task already in `done/` only gets the stamp
(AISDLC-1030).

**Kinds.** A PR on a docs branch (`ai-sdlc/file-*`, `docs/*`) or with
no task id is a docs PR; the PR on branch `ai-sdlc/decisions-sync` is its own `decisions-sync` kind
(AISDLC-935): it follows the docs action set, but `arm` runs
`cli-merge-if-eligible <pr> --source-kind decisions-sync --arm`, and a head change re-arms it on the next tick; one with a task id (branch or title) is a task PR; the release-please
PR (`chore: release`, `release-please--*`) is reported and never acted on.

**One PR snapshot per wake (AISDLC-959).** The four PR consumers of a wake (human-attention,
mark-ready, land-eligible, reconcile) share one open-PR list call that asks for the union of
their fields, including `statusCheckRollup`; the per-PR check-rollup reads are answered from the
same snapshot (`pipeline-cli/src/hierarchy/pr-snapshot.ts`). The snapshot is stored as
`<board>/pr-snapshot.json`. When the webhook receiver is up (its `events/` directory exists), a
later wake reuses the stored snapshot, with no GitHub call, as long as no event record is newer
than it; a recorded event, or a snapshot older than the 15 minute refresh interval, makes the
next wake list once. A lost delivery therefore costs latency, not correctness. Without a
receiver every wake lists once. A command that changes a PR (marking it ready, arming it)
drops the stored snapshot.

**Fingerprint.** Each PR has a fingerprint: head sha, newest event id for the PR, and a digest of
its check rollup. land-eligible records a refused PR's fingerprint in
`<board>/pr-fingerprints.json` and does not re-read that PR until the fingerprint changes or 15
minutes pass. A landing record whose PR was closed without landing is marked `closedUnlanded`
after one confirmation and is not checked again.

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

**Definition of done (AISDLC-816).** `delivered` means the PR is non-draft and armed; that is the
executor's hand-back and frees its slot, and a PR that is not ready and armed at hand-back is
`iterate-needed`, naming the unmet condition. `landed` means merged, and only the state machine
writes `done/` for it, from `landing/<pr>.json`. `cli-dispatch claim` refuses a fresh task for an
executor whose own record (`owner: executor:<name>`) has no `delivered` timestamp, naming the PR,
unless the fresh manifest carries `fixesPr` (or is a resume); a delivered-but-unlanded PR does not
block. `cli-hierarchy status` shows the PR each executor is landing in the `LANDING` column.

**Fix-on-PR flow (AISDLC-1054).** A red PR that needs code is fixed by one task that lands on the
same PR. File it with `cli-file task <path> --pr --fixes-pr <n>`: the brief entry carries `fixesPr`
and `prHeadRef` (the PR's head branch, read with `gh pr view`), and `cli-dispatch enqueue
--from-brief` copies both into the manifest, with `branch` set to `prHeadRef`, so no manifest is
rewritten by hand. For a manifest with `fixesPr`, Step 2 uses `prHeadRef` (else `gh pr view <n>
--json headRefName`) as the branch, Step 3 checks that branch out, and Step 11 lease-pushes to it
(DEC-0264), appends `Fixed by <task id>` to the existing PR body and creates no PR; the task file
moves to `backlog/completed/` in that push and the verdict's PR is the fixed PR. A manifest without
`fixesPr` behaves as before. A fork PR head is not supported.

**Scheduler** (`pipeline-cli/src/hierarchy/scheduler.ts`, `reconcile --watch`): a reconcile
runs at start (session start or machine wake), within a 2 s debounce after the webhook
receiver touches `<board>/.reconcile-wake`, and on a timer of 60 s (`BUSY_INTERVAL_MS`, `scheduler.ts:10`) while any task or docs PR
is open, else 15 min (`IDLE_INTERVAL_MS`, `scheduler.ts:11`). It runs as code, not a model turn, and does not pace PR handling. The tick's progress line lists open PRs as
`#<n> <kind> <state>`.

**Task action set** (acted on from `ready` on; before delivery the executor owns the PR, so
the action is `none`, except stale claims and takeover after executor death post-sign):

| Classifier state | Action | What runs |
|---|---|---|
| `merged` | `mark-landed` | record `landed`; done verdict, parent sync and dependants stay with the tick playbook |
| `manifest-branch-mismatch` | `rewrite-manifest` | left to a session (`write-manifest` with the PR head ref) |
| `behind-or-dirty` | `land-prep` | `land-prep` (AISDLC-881) is not built yet and is served by `reenter` (`reconcile.ts` `TASK_ACTIONS`): `reenter` rebases a BEHIND PR; a DIRTY one goes to an executor) ([hand-review-path.md](hand-review-path.md)) |
| `attestation-content-hash-mismatch` | `push-only-resign` | `reenter` (push-only re-sign manifest, AISDLC-821) |
| `rate-limited` | `wait-and-rerun` | recorded as `wait-and-rerun`, executed as `rerun-rate-limited`: every failing job (the `pr-ready` rollup aside) ran under 30 s and its annotation or log says `API rate limit exceeded for installation` (AISDLC-949), or, with no summary at all, the only failed gate jobs are `Detect Changes` (optionally plus `ai-sdlc/issue-link`) and every other gate job was skipped (AISDLC-953; no test ran); `gh run list --commit <sha> --workflow ai-sdlc-gate.yml` for the run id, then `gh run rerun <id> --failed` (no gate run for the head: no-op with a note) once per head SHA, at or after the next full hour; never `reenter` |
| `real-failure` | `reenter` | `cli-dispatch reenter <pr>` (manifest with the failing line and head SHA); when the failing line names low patch coverage, a failing suite or a waived/skipped test line, the reconciler adds `--developer-round --note <failing line>` so an unchanged patch id still runs the developer (AISDLC-1093) |
| `cancelled-or-infra` | `retrigger-once` | `gh run list --commit <sha> --workflow ai-sdlc-gate.yml` for the run id, then `gh run rerun <id> --failed` (no gate run for the head: no-op with a note); once per head SHA |
| `ready-to-flip` | `flip-ready-takeover` | `gh pr ready <n>`, only after executor death post-sign |
| `armed-clean`, `pending` | `none` | nothing |
| `no-match` | `route-to-planner` | the only state routed to the planner |

Design note (AISDLC-953): `cli-hierarchy` has no dequeue for a wrong `reenter` manifest, so a misclassified red costs a full review round. Any such command needs a governance review before it is built; none exists today.

**PR follow-up loop guard (AISDLC-883).** The reconciler (`pipeline-cli/src/hierarchy/reconcile.ts`) is the only PR poller, and a stalled claim has one owner, the stall check (`stall.ts`). Unlike failures must not add up, so a PR follow-up is bounded by what the action did, not by a retry count. Before any machine action on a PR, the reconciler reads `landing/<pr>.json` history; if the same `(action, headSha)` was already taken and the PR returned to it on the same head, the action is not run again and the record becomes `route-to-planner` with a note such as `rebase@<sha> x2`. A push that moves the head resets the guard. The limit is `loopGuard.maxSameHeadActions` in `.ai-sdlc/pr-lifecycle.yaml`. A task with no PR keeps the retry cap in `requeue.ts`.

**Docs action set** (machine-owned from birth):

| Situation | Action | What runs |
|---|---|---|
| `behind-or-dirty` | `rebase-in-place` | `cli-file rebase <id> --pr` (same branch, same PR number; lease push, then re-armed) |
| failing DoR check | `rerun-dor` | `gh run list --commit <sha> --workflow ai-sdlc-gate.yml` for the run id, then `gh run rerun <id> --failed` (no gate run for the head: no-op with a note) |
| `rate-limited` | `wait-and-rerun` | same as the task set: one rerun per head SHA after the recorded reset time |
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

**A rule gates the claim (AISDLC-1025).** A manifest whose ruling names an `--until` task without a
success verdict in `done/` is skipped by `claim` (and listed as ineligible, with the reason), so no
executor spends a run on it; the hold lifts by itself once that task is done. 

**Start token (AISDLC-1028), removed (AISDLC-1034).** `clear` no longer writes `<boardDir>/starts/<executor>.json` and `executor-start` no longer verifies one.

## Restarting after a plugin upgrade

Sessions load the plugin once, when they start. A new plugin version (commands, hooks,
role text) is picked up only after `cli-hierarchy down` followed by `cli-hierarchy up`, or,
for any session, `cli-hierarchy restart <name>` (or `restart --all`) from the dispatch or
planner session, which keeps inflight manifests on the board;
`clear` does not reload the plugin. `down` returns inflight manifests to `queue/`, so the
restart loses no queued work, but finish or accept the loss of any task in flight first.

## Troubleshooting

**Module absent (AISDLC-1061).** Look in `hierarchy/log` for `tick registration failed <reason>` and `refreshPane failed <reason>`; since AISDLC-1082 every failure `safe()` swallows is also logged there as `swallowed <primitive>: <error text>`. `status` shows `MODULE absent`, `refused: <reason>` or `stale` for the
dispatch host, or `up` exits 1 with `the hierarchy hooks module is not loaded on the dispatch host`. With
no module the hierarchy is inert: no ticks, no executor wakes, no rotations, while `STATE` still reads
`busy`/`idle`. A refusal from the host validator or a hook that threw (for example `on() ... a hook may not
register hooks`) is visible only in two places, not the pane: the Claude Code debug log and the plugin store log
(`hierarchy/log`, which ending at the `role=... identity=...` line means the gate threw after it). Probe with
`AI_SDLC_HIERARCHY_ROLE=executor AI_SDLC_HIERARCHY_SESSION=probe claude -p "ok" --max-turns 1 --debug`: it must
write `.ai-sdlc/dispatch/handoff/module-probe.json` with `state: loaded` and print no
`session.start hook skipped` line for `ai-sdlc`. All `on()` calls live in `register()`; the host refuses one
made later. Fix
`ai-sdlc-plugin/hooks/hierarchy/`, rebuild, then `cli-hierarchy down --role operator-dispatch` and
`cli-hierarchy up`. `absent` on a planner or executor launched without a hierarchy role is expected.

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

**`attach` says the tmux session is not running.** The session ended outside
`down`. Run `up`: it drops the dead entry and starts a replacement.

**`down` refuses a session.** It lacks the `@ai-sdlc-hierarchy` ownership option
(a personal tmux session sharing the name) or its pane id no longer matches the roster. The
session is left alone; stop it by hand if it is yours.

**`clear <name>`, `tick`, `restart`, `register` or `route-decision` exits 1 with a caller message.** Only the running
dispatch session may run them (`restart` also accepts the planner). Run them from that session.

**`status` shows `ENV missing`, or `doctor` reports `hierarchy-launch-env`.** The session was
started without the launch env, so its lease push is refused. Run `cli-hierarchy down --role
<role>` then `up` from the main checkout's build (`pnpm --filter @ai-sdlc/pipeline-cli build`
there first when `resolve-pipeline-cli.sh` refuses as stale). `clear` does not fix it.

**A dispatch-side problem, not a `clear` one:** `clear` no longer needs any hooks module. If the dispatch session's hooks module is not loaded or has refused to register, ticks and wakes stop. Open its pane; the module logs one line naming
the missing primitive and the version floor (`hierarchy/log` in `$.store`, and the plugin store log). The line
`[hierarchy] not registering: Claude Code <version> is below the floor 2.1.307 (session.version)` means the host's
`$.session.version()` was read as older than the floor; since AISDLC-1062 the guard reads both the string form and the
2.1.309 object form `{ version: { VERSION } }`, and prints the object's keys when it finds no version, so a line showing
a current version or `{...}` keys points at a new host shape to add to `versionString` in `hooks/hierarchy/executor.ts`. Fix the host (Claude Code at or above the floor,
the plugin installed with its `modules` entry), then run `clear` again; the stale request is consumed by the first tick that
runs. The old entries about an unsubmitted resume command and an `unknown` state after a degraded clear no longer exist:
no command is typed, so none can be left unsubmitted in an input line.

Since AISDLC-1064 the dispatch registration logs one line per step to the plugin store log (and `hierarchy/log`), in
this order after the `role=... identity=...` line: `tick registered every <ms>`, `ui.open ok|failed <reason>`,
`first tick ran at <iso>`, `refreshPane ok|failed <reason>`. The planner and executor branches end with
`registered role=<role>`. Reading what is missing: no `tick registered` means `$.clock.every` rejected or never
returned (a `tick registration failed <reason>` line names it) and no tick or wake runs; `tick registered`
without `first tick ran` means the host never called the timer; no `ui.open` line means the pane open is still pending
(harmless, the tick runs regardless); `refreshPane failed timed out` means `cli-hierarchy status` hung and the board key
was not written. The first tick runs at registration, so the board is read within seconds of `up`.

**An executor's heartbeat.** `executor-start` writes `inflight/<task>.state.json` naming the
worker right after the claim, before any model call, because the hook's second condition is
that file; it exits non-zero when the write fails, leaving the claim for the reaper.

**Reading `status --json`.** `state` `busy` or `idle` come from the harness registry; `gone`
means the tmux window is closed; `starting` means the harness has not registered the
session; `unknown` means it is open but absent from the registry. `inflightTask` names the
task the session's heartbeat holds; an executor with `idle` and no `inflightTask` is ready
to claim. `board.queued` of 0 with all executors idle means the queue is drained.

## Claim order and reprioritize (AISDLC-904)

A worker claims the eligible queue entry that sorts first by: `wave` ascending (absent is 0),
then `priority` ascending (any finite number; an absent priority sorts last), then enqueue time
(file mtime, oldest first). Inside one priority band the order is first-in-first-out, so a late
critical task waits behind everything filed before it unless its priority is lowered. A resume
manifest has no special rank. `peek --order` prints the eligible entries in exactly this order,
each with `wave`, `priority` and `dispatchedAt`:

```bash
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" peek --order --board-dir "$BOARD_DIR"
```

To move a queued task, never hand-edit the manifest:

```bash
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" reprioritize <task-id> --priority 0 [--note "<text>"] --board-dir "$BOARD_DIR"
```

`reprioritize` rewrites only `priority` on `queue/<id>.dispatch.json` (the enqueue time is kept).
`--note` is audit metadata stored in `reorderNote` and never touches `resume` (AISDLC-1047): an
existing resume block, including its `resume.note` instructions, is copied through unchanged, and the
command output names its first line as `resumeNote`. `--note` never creates a resume block, so a
never-started task is still claimed as a fresh task. The note is bounded by the same 4000-character
limit as a resume note. The command exits 1, leaving the file untouched, when the task is inflight, has a verdict in `done/` or a
diagnostic in `failed/`, or is not queued.

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
  [--note "<what the executor must fix>" | --note-file <path>] [--developer-round]
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
- `--developer-round` (AISDLC-1053) sets `resume.developerRound: true` on the manifest. By
  default `next-step` skips the developer and reviewers when the patch id equals the newest
  attested envelope (`review-skipped: unchanged`), so a note asking for new code (a missing
  test, say) reaches nobody. With the flag, `next-step` bypasses that shortcut, builds the
  developer prompt with the resume note as the feedback block, runs the developer, then clears
  the flag from the inflight manifest and takes the normal delta review on the new patch id. A
  later resume of the same manifest takes the normal path. Without the flag nothing changes.
  The command output carries `resumePath` (`unchanged`, `delta`, `full` or `developer-round`)
  for a manifest it writes: the path the next resume takes, so you see before the executor
  runs whether the note will be acted on.
- Loop guard (AISDLC-883): the same `(action, head SHA)` is never taken twice. The second call
  exits 1 with `loop guard: <action>@<sha> x2 ...`; a push (new head) resets it. Two more
  releases serve a planner-ordered round (AISDLC-1105). (1) `--developer-round --note <text>`
  keys the guard on `(route, head SHA, note hash)`, so a second order with a different note on
  the same head is accepted and records the note hash; the identical note is still refused.
  (2) `--decision <DEC-NNNN>` releases the guard when the catalog holds an answered record
  scoped to the task (its escalation task id or scope names it); an open, unknown or unrelated
  record is refused, and the guard entry records the decision id. Automated reconcile routing
  to the planner is unchanged.

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


No-CodeQL repositories (AISDLC-896): mark-ready flips any `ai-sdlc/` task draft whose PR checks are all green. `governance.openTaskPrsReady: true` opens task PRs ready from Step 11 and `ship`; the default stays draft.

### Failed executor work is re-claimed (AISDLC-946)

Work an executor finished locally but could not push is never hand-pushed. The normal loop re-claims it:

- Every resume entry point (`next-step` init, the `validate-task` step tool, `execute`) treats an existing task worktree as prior work, so a task file found only in `backlog/completed/` (of the worktree or the parent) is accepted. `no task file for <id>` is reserved for first runs.
- A `push-only-check` refusal (exit 1) is not terminal: the executor continues into a normal resume (review round, sign, lease push) in the same run.
- `reenter` with the task worktree HEAD ahead of the PR head is not blocked by the loop guard. The guard keys on the local HEAD, and the manifest note says the local commits are pending a push and must be reviewed, signed and lease-pushed.
- No session other than an executor pushes. The lease-push hook refuses dispatch and planner sessions by design.

## Quota and cost events

### Idle executor polling (AISDLC-1065)

Weekly token audit, 2026-10-16 to 2026-10-23: three idle executor sessions on 2026-10-23 re-ran `executor-start --wait 1500` in a background loop and read its output 2,100 to 3,000 times each, at an average context of 450k to 483k tokens (peak 966k). They consumed 3,702M cache-read tokens, 47 percent of the week, and wrote under 0.4M output tokens. Their hooks module was not loaded, so nothing woke or rotated them and the model polled. Even with a module, polling climbs about 1k context per minute per executor.

Guards: `executor-start --wait N` (N > 0) exits 1 with a one-line refusal when the session has no `loaded` module heartbeat (`handoff/module-<name>.json`); a second `executor-start` within 60 s from the same roster name with no new enqueue (recorded under `<board-dir>/starts/<name>.json`) prints "already idle; stop the turn" and returns `{"taskId":null,"repeat":true}`. An idle executor ends its turn with `[executor] idle` and costs no model calls until the module wakes it.

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

The session coordination layer (the retired execute-parallel, AISDLC-763, left these files in place) has two independent substrates that
track session state:

| Substrate                    | File location                                                     | Purpose                                    |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| **Session file substrate**   | `.ai-sdlc/dispatch/sessions/<task>.session.json`                  | tmux session coordination                 |
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
   (Workers without a session file). These appear in
   `SessionReaperResult.boardOnlyReaped`.

### When the reaper runs

The reaper runs from the session status refresh. You can also invoke it programmatically:

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
up on the next status refresh; `cli-hierarchy status` shows the current state.

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
   the board (`cli-hierarchy executor-start`, one claim); if nothing is eligible it stays idle and the hierarchy
   hooks module wakes it on the next enqueue message, or, without the module, it schedules a
   wake-up after `spec.inSessionAgent.emptyQueueHibernateSec` (default 1800 seconds; the retired `/ai-sdlc dispatch-worker`, AISDLC-763, shared this default).
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

### Push-only resume

**Push-only resume.** When the `RESUMED TASK` block says `RESUME MODE: push-only` (the
manifest's `resume.resumeMode`), run no developer and no reviewer subagent. In the existing worktree:
`git fetch origin && git rebase origin/main` (mechanical only; on a conflict abort the rebase, report
`failed` naming the conflicting files in the verdict note, and stop), build `reference`, `orchestrator`
and `pipeline-cli`, run `pnpm lint` and `pnpm format:check` (fix format drift with `pnpm format` and commit
it as `style:`), then sign from the existing `.ai-sdlc/verdicts/<task-id-lower>.json` and transcript
leaves, lease-push from your own session (never a subagent), run `gh pr ready`, and report the verdict.
After the rebase run `node pipeline-cli/bin/cli-dispatch.mjs push-only-check --task-id <task-id> --worktree <worktree>` (it wraps
`evaluatePushOnly` in `pipeline-cli/src/dispatch/resume.ts`). Exit 1 means refuse the mode, say why in your status line, and continue in this same run with the normal
pipeline below (a refusal is never a failure on its own) (the verdict is not an approval, or the branch content no longer matches an approval after the rebase). A missing verdict file
alone is not a refusal: the JSON carries `verdictMissing`, so run the verdict step (sign from the approval envelope) rather than a developer. Never write a new verdict file and never set an `AI_SDLC_SKIP_*` variable.

### Continuation after `iterate-needed`

**`iterate-needed` is the continuation path.** The verdict leaves the claim in place, so release it right after reporting (`cli-dispatch.mjs release --board-dir "$BOARD_DIR" --task-id "$TASK_ID"`); it refuses while the worktree holds unpushed commits or uncommitted tracked changes (commit and push first; `--force --reason <text>` drops work). Dispatch then continues the task with `cli-dispatch.mjs reenter <pr> --note "<the verdict notes>"`, which requeues it with no wave for the next claim. A worker holds one claim at a time.

### Rules an executor keeps

- It never messages another executor.
- It does not answer decisions, its own or another task's (the hook refuses the
  `cli-decisions` subcommands outside its allowlist).
- It never edits an RFC's Open Questions.
- When it is blocked, it records the question with `cli-decisions escalate` and
  stops. The routing of that decision to the dispatch session or the planner is a
  separate step that is not part of this loop yet.

---

**No channel reaches an executor (AISDLC-948).** An executor takes input from the board only:
the roster gives the planner no route to it, and the dispatch session may not message it or type
into its pane. An executor therefore never waits on a question. When a step cannot proceed, it
writes the exact refusal and the options into the verdict notes, reports `failed` or
`iterate-needed` with `cli-dispatch complete`, releases nothing by force, and stops; the dispatch
tick routes that verdict to the planner. The stall check backs this up: an executor that is idle
with a question as its last output is reaped on the next tick (reason `holder-asked-question`),
without waiting for the idle grace.

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
cli-hierarchy clear <name> [--settle-ms <n>]
```

See [`clear`](#clear) for the flow, the restart fallback and the refusals. The `ExecutorContextCleared` event records each
clear; a dispatch tick whose clear and fallback both fail reports the clear as `failed`, a blocker.

### Mods-driven hierarchy: tiers, floor and gaps

- **Install tier (OQ-4).** The hierarchy runs on every install tier (user, project, managed). The module records the
  detected tier and, when `$.session.identity()` answers, the identity as an informational field in its start line; it is
  never authority, and enterprise-only gating (organisation allow-lists, managed settings) is accepted rather than worked around.
- **Version floor and probe (OQ-5).** At `session.start` the module compares `$.session.version()` with the floor and probes each
  primitive it registers (`prompt.submit`, `command.run`, `session.compact`, `session.measure`, `session.send`; the dispatch
  host needs `clock.every`, `process.run`, `session.send`, `ui.open` and `session.measure`). On a miss it registers nothing and
  logs one refusal naming the primitive or the floor, so a session on an older host runs as a plain session and
  `cli-hierarchy clear` reports `no module loaded` instead of silently doing nothing. The floor moves up only with a
  dated entry in the RFC.
- **What tmux still does.** tmux is a window manager only (OQ-3): `up`, `attach` and `terminals` create and attach windows.
  `clear`, the executor wake, the dispatch tick and the rotations send no keys. The remaining key deliveries (`send`,
  `brief --notify`, the escalation-chain messages and the `/exit` of `down`) are the last tmux typing and move to the
  module transport when it can be called from a CLI.
- **A gap in Mods.** Report it upstream first (the Claude Code Mods surface), then add the smallest interim workaround here,
  named in the code with the upstream report it waits on, and delete it when the upstream fix lands. Do not widen the
  workaround into a second keystroke layer.

### Planner context ceiling

The planner hands off and clears at 15% of the window (150k tokens), without exception.
It keeps its handoff file current as rulings happen and delegates review rounds and
orchestration loops instead of running them in its own context.

### Events

`HierarchySessionStarted` (from `cli-hierarchy up`), `ExecutorContextCleared`,
`DecisionRouted` (`cli-hierarchy route-decision`) and `OperatorPlaybookAction` are
written to the orchestrator events stream.

## How `close-superseded` names the superseding PR (AISDLC-1055)

`cli-dispatch close-superseded <pr>` (DEC-0266) never takes the superseding PR from a title
search. After step (c) proves every diff path is byte-identical on main, it runs
`git log -1 origin/main -- <path>` per path and maps the last-touching commit to its PR (the
`(#NNNN)` in a squash subject, else `gh pr list --search <sha>` matched on the merge commit).
All paths must resolve to one PR; paths landing through different PRs, or a path that cannot be
attributed, refuse the close with that reason. The comment and the
`audit/superseded-close.jsonl` line carry the PR number and its merge commit sha. The
id-based search remains only as a pre-check for `ai-sdlc/<task-id>-*` branches, restricted to
that branch's own task id.

### Executor MCP servers (AISDLC-1067)

When `AI_SDLC_EXECUTOR_MCP_CONFIG=<path>` names an MCP config json, `cli-hierarchy up` starts
executors with `--strict-mcp-config --mcp-config <path>`, so they load only those servers and
not the operator's personal connectors; the tool schemas of unrelated servers otherwise ride in
every model call. The config must include the plugin's own server (`task_edit`,
`task_complete`). Unset, or `AI_SDLC_EXECUTOR_MCP=all`, leaves MCP loading unchanged (the
strict flag alone would load no server at all). Planner and dispatch sessions are unaffected.

The plugin is now the only source of the SessionStart governance block; the duplicate
registration in `.claude/settings.json` was removed.

## Every open PR has an owner (AISDLC-1091)

The reconciler keeps no skip lane. Each open same-repo PR gets a lane and an action:
`dependabot/*` PRs are the `deps` lane (armed with `--source-kind deps` when green and CLEAN,
`gh pr update-branch` once per head when BEHIND); a task PR is owned through its branch or title even
when the verdict lacks `prUrl`; a draft of a done task with no live claim is taken over, flipped ready
and armed; a green CLEAN unarmed task PR is armed. A PR no lane can act on (foreign author, a branch
with no task id and no docs-lane prefix, a draft with no claim and no verdict) is recorded as owner
`unowned` with the reason in `note`, routed to the planner once per head, and counted in
`cli-hierarchy status` as `unowned PRs: N`.

### Aging sweep (AISDLC-1092)

An open PR whose record has had no action or state change for 6 hours (`lastActionAt`, else the last
history entry) is re-evaluated on the next reconcile pass with fresh facts and its action re-run.
Each head gets at most 3 attempts (the first run plus two aged re-runs, counted in `agedAttempts`);
then one line goes to the planner and the head is not retried. `cli-hierarchy status` lists every
open PR past the window as `aged PR #N: <age>, lane <owner>, last action <action>`, oldest first.

## Drain liveness (AISDLC-1096)

Every tick records `lastTickAt` and `lastTickBy` (`host` or `scheduler`) in `operator-dispatch.state.json`; `status` prints `last tick: <n>s ago by <who>`. The detached watch scheduler (`cli-dispatch reconcile --watch`) checks every 30 s and, when the host has missed three intervals and work is queued, runs `cli-hierarchy tick --by scheduler`: the same deterministic tick, no model turn. The tick re-checks staleness itself, so a live host is never doubled. After each tick, webhook event records for closed PRs are deleted and the directory is capped at 2,000 files (oldest first; canary records are kept).

## Module measure (AISDLC-1100)

The hooks module reads the host `session.measure` payload at `context.tokens` and mirrors the last count to the plugin store key `hierarchy/measure/<name>`. `cli-hierarchy status` shows it in the MODULE column (`measured N`) and warns `measure mismatch` when it and CONTEXT fall on opposite sides of the clear threshold. An unrecognised payload shape is logged once (`session.measure payload not recognised`). The host `turn.complete` carries no reply text, so a pending threshold rotation fires at the turn boundary; a verdict-marker rotation still needs reply text.
