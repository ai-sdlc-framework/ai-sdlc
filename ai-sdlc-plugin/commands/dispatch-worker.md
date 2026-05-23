---
name: dispatch-worker
description: >-
  [SUBSCRIPTION-PRESERVING — RFC-0041 Phase 1 + Phase 1.5] Run one
  in-session-agent Worker tick. Either resumes a prior iterate-needed
  session (Phase 1.5 / AISDLC-377.2 — when the Conductor wrote a resume
  signal next to the still-inflight manifest, the Worker invokes Agent
  with continue:true to preserve prior conversation state) OR atomically
  claims a fresh Dispatch Board manifest matching workerKind ∈ {any,
  in-session-agent} and invokes the ai-sdlc:developer agent on it as a
  FOREGROUND Agent call. Writes the resulting verdict to done/ or
  failed/, then loops via ScheduleWakeup. Operator opens N sibling CC
  sessions and fires this command in each to drain the queue at zero
  incremental subscription cost (per AISDLC-353). See RFC-0041 §4.3.1 +
  §10 OQ-4 resolution.
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

## Worker isolation rationale

Workers run in their own Claude Code sessions and invoke `Agent` in
foreground. This isolation provides operator-controlled parallelism (N
sessions = N workers), explicit subscription-quota visibility, and
independence from the Conductor's session lifecycle.

**Historical note (2026-05-21):** RFC-0041 §2.1 originally cited Anthropic's
"600s silent-stdout background-agent watchdog (~85% kill rate during pnpm
test)" as the primary motivation for moving Workers out of the Conductor's
session. That claim was a misdiagnosis — forensic re-measurement of 73 dev
subagent transcripts via `python3 ~/.claude/skills/audit-subagent/audit.py`
found **0 watchdog-shape kills** and 80.8% clean completion (median 16 min,
max 2.5 h). The 19.2% failures were operator-initiated interrupts, not
system kills. The Dispatch Board pattern stands on the other rationales
above; the watchdog-avoidance framing has been removed.

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
# AISDLC-411 (2026-05-23) flipped AI_SDLC_AUTONOMOUS_ORCHESTRATOR to default-ON.
# Worker is enabled unless the operator explicitly opted out via the FALSY set.
case "$(echo "${AI_SDLC_AUTONOMOUS_ORCHESTRATOR:-}" | tr '[:upper:]' '[:lower:]')" in
  off|0|false|no)
    echo "ERROR: AI_SDLC_AUTONOMOUS_ORCHESTRATOR is explicitly disabled (\"$AI_SDLC_AUTONOMOUS_ORCHESTRATOR\")."
    echo "Unset it (or set to a non-opt-out value) to re-enable; default-ON since AISDLC-411."
    exit 1
    ;;
esac
```

## Step 2a — Resume-signal check (Phase 1.5 / AISDLC-377.2)

**Before** claiming a fresh manifest, check whether ANY inflight manifest
has a pending resume signal. The Worker's discovery is **filesystem-first**
(MAJOR #3, iteration-2 close-out): a resume signal is a `*.resume.json` file
under `inflight/`, which survives Worker session restarts. The env-var
`AI_SDLC_DISPATCH_RESUME_TASK_ID` (exported at the end of Step 5) is only a
fast-path optimization — relying on it alone would silently strand the
inflight slot if the Worker session died and was re-launched between
Conductor's resume-write and the Worker's next tick.

```bash
IS_RESUME=no
RESUME_TASK_ID=""

# 1. Scan inflight/ for any pending resume signals — filesystem-durable,
#    survives Worker session restart. This is the canonical discovery path.
SIGNALS_JSON=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" list-resume-signals \
  --board-dir "$BOARD_DIR")
FIRST_RESUMABLE_TASK=$(echo "$SIGNALS_JSON" | node -e "
  const d=[]; process.stdin.on('data',c=>d.push(c));
  process.stdin.on('end',()=>{
    const r = JSON.parse(d.join(''));
    const signals = Array.isArray(r.signals) ? r.signals : [];
    // The Worker can resume any signal whose corresponding manifest
    // declares a compatible workerKind. Phase 1 ships only in-session-agent
    // so the first available signal is always claimable here; Phase 2 will
    // need to read the inflight manifest's workerKind before resuming.
    process.stdout.write(signals.length > 0 ? signals[0].taskId : '');
  });
")

if [ -n "$FIRST_RESUMABLE_TASK" ]; then
  RESUME_TASK_ID="$FIRST_RESUMABLE_TASK"
  IS_RESUME=yes
  echo "[dispatch-worker] resume signal discovered on disk for $RESUME_TASK_ID — running iteration 2"
else
  # 2. No on-disk signal. Fall through to the env-var fast path for the
  #    common single-session case (Worker stayed alive across the
  #    Conductor's write). This is now redundant defense-in-depth: if a
  #    signal exists for this task ID, the scan above already picked it up.
  ENV_RESUME_TASK_ID="${AI_SDLC_DISPATCH_RESUME_TASK_ID:-}"
  if [ -n "$ENV_RESUME_TASK_ID" ]; then
    SIGNAL_JSON=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" read-resume-signal \
      --board-dir "$BOARD_DIR" --task-id "$ENV_RESUME_TASK_ID")
    PRESENT=$(echo "$SIGNAL_JSON" | node -e "
      const d=[]; process.stdin.on('data',c=>d.push(c));
      process.stdin.on('end',()=>{
        const r = JSON.parse(d.join(''));
        process.stdout.write(r.present ? 'yes' : 'no');
      });
    ")
    if [ "$PRESENT" = "yes" ]; then
      RESUME_TASK_ID="$ENV_RESUME_TASK_ID"
      IS_RESUME=yes
      echo "[dispatch-worker] resume signal detected via env for $RESUME_TASK_ID — running iteration 2"
    fi
  fi
fi

if [ "$IS_RESUME" = "yes" ]; then
  # Resume path: TASK_ID + WORKTREE will be re-read from the still-inflight
  # manifest in Step 4-Resume; fall through past Step 2b's claim.
  TASK_ID="$RESUME_TASK_ID"
fi
```

If no resume signal is present (`IS_RESUME=no`), proceed to Step 2b to
claim a fresh manifest.

## Step 2b — Claim a manifest (fresh dispatch)

Only executed when Step 2a did not surface a resume signal (`IS_RESUME=no`).
When resuming, the Worker already has its TASK_ID + must continue against
the still-inflight manifest — claiming a NEW manifest in the same tick
would burn a slot for nothing.

```bash
if [ "$IS_RESUME" != "yes" ]; then
CLAIM_JSON=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" claim \
  --board-dir "$BOARD_DIR" \
  --worker-kind in-session-agent)
echo "[dispatch-worker] claim: $CLAIM_JSON"
fi
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

### Step 4-Fresh — first-attempt dispatch (IS_RESUME != yes)

Use the `Agent` tool to spawn `ai-sdlc:developer` against the manifest's
worktree + task file. **This is a foreground call** — the slash command
body waits for the result. The platform shows a live spinner. Required parameters:

- `subagent_type`: `developer`
- `cwd`: the manifest's `worktree` (absolute or repo-relative)
- A prompt that includes the manifest's `spec.taskFile` path + the task
  description (the developer agent will read the task file and follow its
  hard rules + verification commands).

After the Agent call returns, parse the developer's JSON envelope (the
standard return shape: `summary`, `filesChanged`, `commitSha`, `prUrl`,
`verifications`, `acceptanceCriteriaMet`, `notes`).

### Step 4-Resume — Phase 1.5 iteration (IS_RESUME == yes)

When the Worker detected a resume signal in Step 2a, invoke the SAME
`ai-sdlc:developer` subagent with `continue: true` semantics. The Agent
tool's continue mode preserves the prior conversation state (the
exploration the dev did, the files it touched, what it tried and why it
failed) and prepends the conductor's feedback as the next operator turn.

```
SIGNAL=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" read-resume-signal \
  --board-dir "$BOARD_DIR" --task-id "$TASK_ID")
FEEDBACK=$(echo "$SIGNAL" | node -e "
  const d=[]; process.stdin.on('data',c=>d.push(c));
  process.stdin.on('end',()=>{
    const r = JSON.parse(d.join(''));
    process.stdout.write(r.signal.feedback);
  });
")
PRIOR_ITERATION=$(echo "$SIGNAL" | node -e "
  const d=[]; process.stdin.on('data',c=>d.push(c));
  process.stdin.on('end',()=>{
    const r = JSON.parse(d.join(''));
    process.stdout.write(String(r.signal.priorIteration ?? 1));
  });
")
NEW_ITERATIONS_ATTEMPTED=$((PRIOR_ITERATION + 1))
```

Invoke `Agent` with `continue: true` and a prompt that is just the
conductor feedback (the prior conversation already has the task context):

- `subagent_type`: `developer`
- `cwd`: the manifest's `worktree` (same as the first attempt)
- `continue`: `true`
- `prompt`: the `FEEDBACK` text from the resume signal

After the Agent call returns, parse the JSON envelope as in Step 4-Fresh.

**Important — consume the resume signal BEFORE writing the verdict** so a
mid-iteration crash doesn't trigger a third resume on Worker restart:

```bash
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" remove-resume-signal \
  --board-dir "$BOARD_DIR" --task-id "$TASK_ID"
```

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
  --duration-ms "$DURATION_MS" \
  --iterations-attempted "${NEW_ITERATIONS_ATTEMPTED:-1}"
```

The `--iterations-attempted` flag records the burn count: 1 for a
first-attempt success, 2 for a resume-attempt success (set from
`NEW_ITERATIONS_ATTEMPTED` in Step 4-Resume).

On iterate-needed (Phase 1.5 / AISDLC-377.2): if the dev subagent reports
verification failure that the Worker believes is recoverable (verifier
output suggests the dev can fix it on a second attempt with context), set
`--outcome iterate-needed`. The Conductor's done-pickup loop handles the
resume-signal protocol; the inflight manifest is PRESERVED (writeVerdict
treats `iterate-needed` specially per RFC-0041 OQ-4) so the Worker can
continue against the same slot. Record the task ID in
`$AI_SDLC_DISPATCH_RESUME_TASK_ID` so the NEXT Worker tick (after
ScheduleWakeup) can check for the Conductor's resume signal in Step 2a.

```bash
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" write-verdict \
  --board-dir "$BOARD_DIR" \
  --task-id "$TASK_ID" \
  --outcome iterate-needed \
  --worker-id "$WORKER_ID" \
  --worker-kind in-session-agent \
  --notes "verifier fail: <stderr excerpt>; recoverable with context" \
  --iterations-attempted 1
export AI_SDLC_DISPATCH_RESUME_TASK_ID="$TASK_ID"
```

> **Why iterate-needed leaves the manifest in inflight/.** RFC-0041 OQ-4
> mandates that iteration is a continuation, not a restart — the Worker's
> prior conversation state (what it tried, what files it touched, what it
> learned) MUST survive across the iteration boundary. The board library
> handles this by detecting `iterate-needed` in `writeVerdict()` and
> SKIPPING the inflight-manifest cleanup that every other outcome
> performs. The verdict file lands in `done/` so the Conductor's poll
> sees it, but the inflight manifest stays put so the resume signal the
> Conductor writes lands next to it and the Worker can continue against
> the same slot.

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
| Dev subagent reports recoverable verifier-fail (Phase 1.5) | `write-verdict --outcome iterate-needed --iterations-attempted N`; export `AI_SDLC_DISPATCH_RESUME_TASK_ID` | `done/<task>.verdict.json` → Conductor writes resume signal (or `iteration-exhausted` if at budget cap) |
| Dev subagent reports `prUrl: null` + commit | `write-verdict --outcome failed --cause push-failed` | `failed/` diagnostic |
| Agent tool throws | `write-verdict --outcome failed --cause agent-error` | `failed/` diagnostic |
| 429 quota | `write-verdict --outcome quota-exhausted --retry-after <Retry-After>` | `failed/` diagnostic → Conductor cool-down |
| Worker session crashes | inflight heartbeat goes stale | Conductor sweep reaps → `failed/` `stale-heartbeat` diagnostic |

## Where to look

- RFC-0041 §4.3.1 — the in-session-agent Worker kind contract
- RFC-0041 §10 OQ-4 — the Phase 1.5 iteration-as-continuation resolution
- `spec/schemas/dispatch-manifest.v1.schema.json` — the JSON shape this command consumes
- `spec/schemas/dispatch-verdict.v1.schema.json` — the JSON shape this command emits
- `spec/schemas/dispatch-resume-signal.v1.schema.json` — the Phase 1.5 resume signal shape
- `pipeline-cli/src/dispatch/board.ts` — the in-process implementation
- `pipeline-cli/bin/cli-dispatch.mjs` — the bash-callable surface
- `.ai-sdlc/dispatch-config.yaml` — operator-configured tuning knobs
