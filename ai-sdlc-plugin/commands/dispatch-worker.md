---
name: dispatch-worker
description: >-
  [SUBSCRIPTION-PRESERVING — RFC-0041 Phase 1] Run one in-session-agent
  Worker tick. Atomically claims one Dispatch Board manifest matching
  workerKind ∈ {any, in-session-agent}, invokes the ai-sdlc:developer
  agent on it as a FOREGROUND Agent call (no 600s watchdog kill — RFC-0041
  §4.3.1), writes the resulting verdict to done/ or failed/, then loops
  via ScheduleWakeup. Operator opens N sibling CC sessions and fires this
  command in each to drain the queue at zero incremental subscription
  cost (per AISDLC-353). See RFC-0041 §4.3.1 for the cost model.
argument-hint: "[--once]"
allowed-tools:
  - Read
  - Bash
  - Agent(developer)
model: inherit
---

Run one in-session-agent **Worker** tick (RFC-0041 §4.3.1).

This command is the Worker half of the Conductor / Worker process split.
The operator opens **one or more** sibling Claude Code sessions and fires
`/ai-sdlc dispatch-worker` in each. Each session loops:

1. Claim one manifest from the Dispatch Board.
2. Invoke the `ai-sdlc:developer` subagent in foreground.
3. Write the verdict to `done/` (success) or `failed/` (diagnostic).
4. `ScheduleWakeup` for the next tick.

When the queue is empty the session hibernates for ~30 seconds (configurable
via `.ai-sdlc/dispatch-config.yaml` `spec.inSessionAgent.emptyQueueHibernateSec`)
before re-polling — this avoids burning subscription tokens on busy-waits.

## Why this is safe vs. the legacy run_in_background pattern

The previous pattern dispatched dev subagents via
`Agent(subagent_type: 'developer', run_in_background: true)` from inside the
Conductor's session. That triggered Anthropic's hardcoded 600s silent-stdout
background-agent watchdog (~85% kill rate during `pnpm test` per RFC-0041
§2.1). The Dispatch Board protocol moves Workers to their own CC sessions
where they invoke `Agent` in **foreground** — the platform shows a live
spinner and trusts the call. No background-agent watchdog applies.

## Hard rules (identical to `/ai-sdlc execute`)

1. **Never merge any PR.** Do not run `gh pr merge`.
2. **Never force-push.** Use `--force-with-lease` only after the mandatory rebase.
3. **Never close PRs or issues.** No `gh pr close`, `gh issue close`.
4. **Never delete branches.** No `git branch -D` / `-d`.
5. **Never edit `.ai-sdlc/**` or `.github/workflows/**`.**
6. **Never run destructive git operations.** No `git reset --hard`.
7. **Never write CI-skip tokens** (`[skip ci]`, `[ci skip]`, etc.) in commits.

## Path resolution

```bash
if [ -n "${CLAUDE_PLUGIN_DIR:-}" ]; then
  PIPELINE_CLI_BIN="$CLAUDE_PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin"
else
  PIPELINE_CLI_BIN="$(pwd)/pipeline-cli/bin"
fi
BOARD_DIR="${AI_SDLC_DISPATCH_BOARD_DIR:-$(pwd)/.ai-sdlc/dispatch}"
WORKER_ID="${AI_SDLC_WORKER_ID:-worker-$$-$(date +%s)}"
```

## Step 1 — Feature-flag guard

```bash
if [ -z "$AI_SDLC_AUTONOMOUS_ORCHESTRATOR" ]; then
  echo "ERROR: AI_SDLC_AUTONOMOUS_ORCHESTRATOR is not set. Set it to 'experimental' to enable."
  exit 1
fi
```

## Step 2 — Claim a manifest

```bash
CLAIM_JSON=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" claim \
  --board-dir "$BOARD_DIR" \
  --worker-kind in-session-agent)
echo "[dispatch-worker] claim: $CLAIM_JSON"
```

Parse the JSON:

- `{"claimed": false}` → no eligible manifest in the queue. **Hibernate**
  via `ScheduleWakeup(30s)` (or per the configured
  `emptyQueueHibernateSec`). Exit this tick.
- `{"claimed": true, "manifestPath": "...", "manifest": {...}}` → continue
  to Step 3.

```bash
CLAIMED=$(echo "$CLAIM_JSON" | node -e "
  const d=[]; process.stdin.on('data',c=>d.push(c));
  process.stdin.on('end',()=>{
    const r = JSON.parse(d.join(''));
    process.stdout.write(r.claimed ? 'yes' : 'no');
  });
")
if [ "$CLAIMED" != "yes" ]; then
  echo "[dispatch-worker] queue empty — hibernating"
  # ScheduleWakeup 30s /ai-sdlc dispatch-worker
  exit 0
fi

TASK_ID=$(echo "$CLAIM_JSON" | node -e "
  const d=[]; process.stdin.on('data',c=>d.push(c));
  process.stdin.on('end',()=>{
    const r = JSON.parse(d.join(''));
    process.stdout.write(r.manifest.taskId);
  });
")
WORKTREE=$(echo "$CLAIM_JSON" | node -e "
  const d=[]; process.stdin.on('data',c=>d.push(c));
  process.stdin.on('end',()=>{
    const r = JSON.parse(d.join(''));
    process.stdout.write(r.manifest.worktree);
  });
")
```

## Step 3 — Write initial heartbeat

```bash
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" heartbeat \
  --board-dir "$BOARD_DIR" \
  --task-id "$TASK_ID" \
  --worker-id "$WORKER_ID" \
  --worker-kind in-session-agent \
  --current-step starting \
  --pid $$
```

The Conductor's stale-heartbeat sweeper (RFC-0041 §4.4) uses this state file
to distinguish "working" from "dead". The Worker SHOULD refresh the
heartbeat periodically while the dev subagent runs (no strict deadline —
the default sweep threshold is 30 min per OQ-3).

## Step 4 — Invoke the developer subagent (foreground)

Use the `Agent` tool to spawn `ai-sdlc:developer` against the manifest's
worktree + task file. **This is a foreground call** — the slash command
body waits for the result. The platform shows a live spinner; no 600s
watchdog applies. Required parameters:

- `subagent_type`: `developer`
- `cwd`: the manifest's `worktree` (absolute or repo-relative)
- A prompt that includes the manifest's `spec.taskFile` path + the task
  description (the developer agent will read the task file and follow its
  hard rules + verification commands).

After the Agent call returns, parse the developer's JSON envelope (the
standard return shape: `summary`, `filesChanged`, `commitSha`, `prUrl`,
`verifications`, `acceptanceCriteriaMet`, `notes`).

> **OQ-7 — quota exhaustion handling.** If the `Agent` tool returns a
> rate-limit error or the dev subagent surfaces a 429, do NOT write a
> normal verdict. Instead write a `quota-exhausted` diagnostic with
> `retryAfter` = the Anthropic `Retry-After` header (default 600s if
> absent). The Conductor will pause emitting new `in-session-agent`
> manifests for that duration and re-enqueue this task with
> `noClaimBefore: now + retryAfter`.

## Step 5 — Write the verdict

On success:

```bash
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" write-verdict \
  --board-dir "$BOARD_DIR" \
  --task-id "$TASK_ID" \
  --outcome success \
  --worker-id "$WORKER_ID" \
  --worker-kind in-session-agent \
  --commit-sha "<SHA from developer return>" \
  --pushed-branch "<branch from developer return>" \
  --pr-url "<PR URL from developer return>" \
  --verifications '{"build":"passed","test":"passed","lint":"passed","format":"passed"}' \
  --acceptance-criteria-met '[1,2,3]' \
  --duration-ms "$DURATION_MS"
```

On failure / quota exhaustion / block, set `--outcome` accordingly
(`failed`, `quota-exhausted`, or `blocked`) and include `--cause`,
`--retry-after`, `--notes` as appropriate. The `write-verdict` subcommand
auto-routes the JSON to `done/` (success/iterate-needed) or `failed/`
(everything else) and clears the inflight manifest + heartbeat.

## Step 6 — ScheduleWakeup

```bash
ONCE_FLAG="${ARGUMENTS:-}"
if [ "$ONCE_FLAG" != "--once" ]; then
  echo "[dispatch-worker] verdict written; scheduling next tick"
  # ScheduleWakeup 5s /ai-sdlc dispatch-worker
fi
```

The 5s cadence (per `.ai-sdlc/dispatch-config.yaml`
`spec.inSessionAgent.pollIntervalSec`) is RFC-0041 OQ-6's cost-first bias:
in-session-agent Workers preferentially win `workerKind: any` manifests
over claude-p-shell Workers (which poll at 15s per their config), keeping
work on the subscription-quota path.

When the queue is empty (Step 2 `claimed: false`), the Worker uses the
slower `emptyQueueHibernateSec` cadence (30s default) to avoid spamming
the filesystem with empty polls.

---

## Why this lives in the slash command body (not a subagent)

Plugin subagents cannot use the `Agent` tool — Claude Code filters it out
one level deep. The dev-subagent invocation must therefore happen in the
slash command body, not inside a Worker subagent middleman.

## Failure modes

| Scenario | Worker behavior | Conductor consumes |
|---|---|---|
| Empty queue | `ScheduleWakeup(emptyQueueHibernateSec)` | nothing |
| Dev subagent succeeds | `write-verdict --outcome success` | `done/<task>.verdict.json` → reviewer fan-out |
| Dev subagent reports `prUrl: null` + commit | `write-verdict --outcome failed --cause push-failed` | `failed/` diagnostic |
| Agent tool throws | `write-verdict --outcome failed --cause agent-error` | `failed/` diagnostic |
| 429 quota | `write-verdict --outcome quota-exhausted --retry-after <Retry-After>` | `failed/` diagnostic → Conductor cool-down |
| Worker session crashes | inflight heartbeat goes stale | Conductor sweep reaps → `failed/` `stale-heartbeat` diagnostic |

## Where to look

- RFC-0041 §4.3.1 — the in-session-agent Worker kind contract
- `spec/schemas/dispatch-manifest.v1.schema.json` — the JSON shape this command consumes
- `spec/schemas/dispatch-verdict.v1.schema.json` — the JSON shape this command emits
- `pipeline-cli/src/dispatch/board.ts` — the in-process implementation
- `pipeline-cli/bin/cli-dispatch.mjs` — the bash-callable surface
- `.ai-sdlc/dispatch-config.yaml` — operator-configured tuning knobs
