# Dispatch Supervisor — installation + operations runbook

**Audience**: operators running the AI-SDLC autonomous loop who want the
**`claude-p-shell`** Worker kind (RFC-0041 §4.3.2) — i.e. the headless /
CI / cron-driven path that does NOT require an open Claude Code session
per parallel worker.

This runbook covers Phase 2 of RFC-0041 (AISDLC-377.3). If you are using
only the `in-session-agent` Worker kind (RFC §4.3.1 — the
subscription-quota path), you do NOT need a supervisor at all.

> **Cost reminder.** Each `claude -p` invocation the supervisor spawns
> draws from the per-plan **Agent SDK credit pool** (~$200/mo on
> Max-20x) post-2026-06-15, with overflow billed at API-token rates.
> The Conductor prints a one-line `[dispatch-cost]` notice on the first
> `claude-p-shell` manifest of each session. Suppress with
> `suppressCostWarning: true` in `.ai-sdlc/dispatch-config.yaml` if you
> have explicitly accepted the cost model.

---

## When you need this

You need the supervisor when at least one of the following is true:

1. You want autonomous dispatch to keep draining work **while no Claude
   Code session is open** (overnight catch-up, CI-triggered batch).
2. You run AI-SDLC on a headless server with no interactive operator.
3. You want to scale beyond the practical ~6-8 in-session-agent
   sessions per operator on a Max-20x plan.

You do **NOT** need the supervisor when:

- Your operator opens N Claude Code sessions and runs
  `/ai-sdlc dispatch-worker` in each. That's the AISDLC-353 path — pure
  subscription quota, no Agent SDK credit draw.
- You execute single tasks via `/ai-sdlc execute <task-id>` (which never
  touches the Dispatch Board).

---

## What the supervisor is

A small Node daemon (~190 LOC in `pipeline-cli/src/dispatch/supervisor.ts`,
~210 LOC for the CLI wrapper) that:

1. Polls `.ai-sdlc/dispatch/queue/` every `claudePShell.pollIntervalSec`
   (default 15s — biased slower than in-session-agent's 5s per RFC-0041
   OQ-6 so subscription Workers preferentially win `any` races).
2. For each manifest matching `workerKind ∈ {claude-p-shell, any}`:
   atomically `rename`s it to `.ai-sdlc/dispatch/inflight/`, then spawns
   `env -u CLAUDECODE claude -p ...` in the manifest's `worktree`
   (RFC §4.4 — the `CLAUDECODE` env var must be unset; Claude Code's
   startup guard refuses to launch otherwise).
3. Enforces the concurrency cap from
   `parallelism.claudePShellMaxConcurrent` in `.ai-sdlc/dispatch-config.yaml`.
4. Sweeps stale inflight heartbeats every tick. Any worker with
   `lastHeartbeat > 30 min ago` (RFC §4.4 + OQ-3, matching
   `ShellClaudePSpawner.DEFAULT_TIMEOUT_MS`) gets a `SIGTERM`, its
   manifest moves to `failed/` with `cause: stale-heartbeat`, and the
   PID is dropped from the inflight set.
5. Records its own PID in `.ai-sdlc/dispatch/.supervisor.pid`. Refuses
   to start if a live PID already owns the lock (RFC §5.1).

---

## Install — macOS launchd

Create `~/Library/LaunchAgents/io.ai-sdlc.dispatch-supervisor.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.ai-sdlc.dispatch-supervisor</string>

  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USER/path/to/ai-sdlc</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>pipeline-cli/bin/cli-dispatch-supervisor.mjs</string>
    <string>start</string>
    <string>--max-concurrent</string>
    <string>2</string>
    <string>--poll-interval-sec</string>
    <string>15</string>
  </array>

  <!-- Restart on crash; log stdout/stderr for postmortems. -->
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/YOUR_USER/path/to/ai-sdlc/.ai-sdlc/dispatch/supervisor.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USER/path/to/ai-sdlc/.ai-sdlc/dispatch/supervisor.err.log</string>

  <!-- Inherit operator env (OQ-2). The PATH below must include
       wherever `claude` is installed (typically ~/.local/bin or
       /usr/local/bin via the official installer). -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/YOUR_USER/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/YOUR_USER</string>
  </dict>
</dict>
</plist>
```

Load + start:

```bash
launchctl load ~/Library/LaunchAgents/io.ai-sdlc.dispatch-supervisor.plist
launchctl start io.ai-sdlc.dispatch-supervisor
```

Verify:

```bash
pnpm supervisor:status
# → {"pid":12345,"alive":true,"board":{"queued":0,"inflight":0,"done":0,"failed":0}}
```

Stop:

```bash
launchctl stop io.ai-sdlc.dispatch-supervisor
launchctl unload ~/Library/LaunchAgents/io.ai-sdlc.dispatch-supervisor.plist
```

---

## Install — Linux systemd `--user` unit

Create `~/.config/systemd/user/ai-sdlc-dispatch-supervisor.service`:

```ini
[Unit]
Description=AI-SDLC Dispatch Supervisor (RFC-0041 §4.5)
After=default.target

[Service]
Type=simple
WorkingDirectory=%h/path/to/ai-sdlc
ExecStart=/usr/bin/node pipeline-cli/bin/cli-dispatch-supervisor.mjs start --max-concurrent 2 --poll-interval-sec 15
Restart=on-failure
RestartSec=10

# Inherit operator env so ~/.claude/credentials etc. work (OQ-2).
PassEnvironment=PATH HOME ANTHROPIC_API_KEY

StandardOutput=append:%h/path/to/ai-sdlc/.ai-sdlc/dispatch/supervisor.out.log
StandardError=append:%h/path/to/ai-sdlc/.ai-sdlc/dispatch/supervisor.err.log

[Install]
WantedBy=default.target
```

Enable + start:

```bash
systemctl --user daemon-reload
systemctl --user enable ai-sdlc-dispatch-supervisor.service
systemctl --user start ai-sdlc-dispatch-supervisor.service
systemctl --user status ai-sdlc-dispatch-supervisor.service
```

Logs:

```bash
journalctl --user -u ai-sdlc-dispatch-supervisor.service -f
```

Stop:

```bash
systemctl --user stop ai-sdlc-dispatch-supervisor.service
systemctl --user disable ai-sdlc-dispatch-supervisor.service
```

---

## Install — manual tmux pane (development / ad-hoc)

When you don't want a true service unit and just need the supervisor
running for an overnight drain:

```bash
tmux new -s ai-sdlc
# inside the tmux session:
cd /path/to/ai-sdlc
pnpm supervisor:start
# detach with Ctrl+B, D — supervisor keeps running until the host reboots
# or you `pnpm supervisor:stop` from another shell.
```

To re-attach later:

```bash
tmux attach -t ai-sdlc
```

This is fine for short stints (≤24 h) but doesn't survive a laptop
reboot — use launchd / systemd for permanent installations.

---

## Configuration

The supervisor reads `.ai-sdlc/dispatch-config.yaml` (RFC-0041 §4.3.3,
schema at `spec/schemas/dispatch-config.v1.schema.json`). Phase-2-relevant
fields:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: DispatchConfig
spec:
  # Set to 'claude-p-shell' to flip the autonomous loop's default to
  # the headless path. Most operators leave this as 'in-session-agent'
  # and tag specific manifests with workerKind: claude-p-shell instead.
  defaultWorkerKind: in-session-agent

  parallelism:
    # Concurrent claude -p Workers under one supervisor. 0 disables.
    # Sized against your Agent SDK credit budget — at ~$0.20/task and
    # ~$200/mo, 1000 tasks/mo is the practical ceiling; 2-4 concurrent
    # is a typical operator setting.
    claudePShellMaxConcurrent: 2

  claudePShell:
    pollIntervalSec: 15        # RFC-0041 OQ-6 — 15s default
    watchdogMs: 1800000        # 30 min — matches OQ-3
    supervisorPidFile: .ai-sdlc/dispatch/.supervisor.pid
```

The CLI flags on `cli-dispatch-supervisor start` (`--max-concurrent`,
`--poll-interval-sec`, `--stale-ms`, `--pid-file`) override the
config-file values when present.

---

## Troubleshooting

### "refusing to start: supervisor pid=NNNN already running"

There is already a live supervisor owning the PID lock. Either:

1. **Intentional**: `pnpm supervisor:status` to confirm; you don't need
   to start another.
2. **Crashed but left a stale file**: shouldn't happen (the supervisor
   removes its own PID file on exit), but if it did:
   ```bash
   pnpm supervisor:status
   # → {"pid":NNNN,"alive":false,...}
   rm .ai-sdlc/dispatch/.supervisor.pid
   pnpm supervisor:start
   ```

`acquirePidLock` auto-reclaims stale files (PID present but dead) on
the next start, so manual `rm` is rarely needed.

### Manifests pile up in `queue/`, nothing happens

Check the supervisor is running:

```bash
pnpm supervisor:status
```

If `alive: false` or `pid` missing, start it. If it's running but no
spawns happen:

1. Check `.ai-sdlc/dispatch/supervisor.err.log` for spawn-rejected
   errors (e.g. `ENOENT: claude binary missing` → install Claude Code).
2. Check the manifests have `workerKind: claude-p-shell` or
   `workerKind: any`. The supervisor ignores `in-session-agent`
   manifests.
3. Check `.ai-sdlc/dispatch-config.yaml`'s `claudePShellMaxConcurrent`
   isn't `0` (the Phase 1 default — bump to ≥1 to enable the
   supervisor).

### A Worker hung in `inflight/` — supervisor didn't reap it

The stale-heartbeat sweeper fires every tick, but only if the inflight
manifest is older than `staleMs` (default 30 min) **and** has either
no heartbeat or a heartbeat older than `staleMs`. If you see an entry
stuck for ≥30 min:

```bash
ls -la .ai-sdlc/dispatch/inflight/
cat .ai-sdlc/dispatch/inflight/AISDLC-NNN.state.json
```

If `lastHeartbeat` is recent, the Worker is still alive — the sweeper
is correctly leaving it alone. If `lastHeartbeat` is older than 30
min and the manifest is still there after a tick (15s default poll),
the supervisor may be hung or have crashed without removing its PID
file. Check `supervisor.err.log`, then restart:

```bash
pnpm supervisor:stop
pnpm supervisor:start
```

### Cost notice fires repeatedly

The `[dispatch-cost]` line is supposed to fire **once per Conductor
session** (AC #7 in AISDLC-377.3). If it fires on every tick, the
Conductor's `CostWarningState` is not being persisted across
`ScheduleWakeup` resumes. Suppress with `suppressCostWarning: true`
until the Conductor session-state bug is filed.

### Log inspection (paths)

```text
.ai-sdlc/dispatch/supervisor.out.log      — supervisor stdout (light)
.ai-sdlc/dispatch/supervisor.err.log      — supervisor stderr (tick logs)
.ai-sdlc/dispatch/queue/                  — pending manifests
.ai-sdlc/dispatch/inflight/               — claimed manifests + heartbeats
.ai-sdlc/dispatch/done/                   — success verdicts
.ai-sdlc/dispatch/failed/                 — failure verdicts + diagnostics
```

The Conductor reads `done/` + `failed/` to fan out reviewers / surface
escalations. The supervisor never reads `done/` or `failed/` after
landing the verdict — those are Conductor-owned.

### Restart procedure

```bash
pnpm supervisor:stop      # SIGTERM, wait 5s, SIGKILL if needed
pnpm supervisor:start     # acquires fresh PID lock
pnpm supervisor:status    # verify alive
```

If you've edited the supervisor source, you MUST rebuild before
restart:

```bash
pnpm --filter @ai-sdlc/pipeline-cli build
pnpm supervisor:stop && pnpm supervisor:start
```

The supervisor reads compiled `dist/` (not `src/`); a stale `dist/`
silently runs the old code.

---

## Failure modes (RFC-0041 §5.2 surface)

| Mode | Detection | Owner | Remediation |
|---|---|---|---|
| `WorkerSupervisorMissing` | Manifests stuck in `queue/`, supervisor PID absent or dead | Conductor | `AskUserQuestion` to operator — restart supervisor |
| `WorkerSpawnRefused` | `claude -p` exits immediately non-zero (no auth, ENOENT) | Supervisor | Writes `failed/<id>.diagnostic.json` with `cause: spawn-rejected`; operator inspects + restarts |
| `WorkerStaleHeartbeat` | `inflight/<id>.state.json.lastHeartbeat > 30 min ago` | Supervisor | Reaped via sweep; manifest moved to `failed/` with `cause: stale-heartbeat`; Conductor retries (budget 1) or escalates |
| `DispatchBoardCorruption` | Manifest JSON parse fails | Supervisor + Conductor | Manifest moved to `failed/` with `cause: schema-violation`; Conductor surfaces |

---

## Operator soak (post-AISDLC-377.3 acceptance)

The hermetic test in `pipeline-cli/src/dispatch/supervisor.test.ts`
covers the spawn protocol with a mock subprocess. The end-to-end
acceptance (AC #9) — supervisor running in a tmux pane + Conductor in
a separate CC session + a real `claude -p` Worker draining a real
manifest to a merged PR — is **operator-verified post-merge**. The
acceptance signal is: a real PR landed by the autonomous loop with no
in-session-agent session open at any point of its execution. File a
backlog task with the run's PR URL and merge timestamp to close out
AC #9.
