---
name: orchestrator-tick
description: >-
  [SUBSCRIPTION-ONLY PATH post-2026-06-15 — RFC-0041 Phase 1 + AISDLC-396
  Pattern X] Run one Conductor tick. Reads the dispatch frontier, emits
  manifests to the Dispatch Board, dispatches a developer Agent for each
  emitted manifest as an in-session background call (Pattern X — single
  session autonomous drain), then polls the done/ + failed/ subdirs for
  newly-landed verdicts. For each successful verdict, fans out 3 reviewer
  subagents (foreground Agent calls), signs the attestation, pushes the
  branch, and arms auto-merge. ONE operator-opened CC session is sufficient
  for end-to-end autonomous drain. The legacy Pattern Z fallback (sibling
  /ai-sdlc dispatch-worker sessions) is still supported when N>4 parallel
  is needed. See RFC-0041 §4.6 + docs/operations/billing-and-cost-optimization.md §1b.
argument-hint: "[--once]"
allowed-tools:
  - Read
  - Bash
  - Agent(developer, code-reviewer, test-reviewer, security-reviewer)
model: inherit
---

Run one autonomous orchestrator tick in the current Claude Code session as
**Conductor** (RFC-0041 §4.2).

This command shifted in RFC-0041 Phase 1 (AISDLC-377.1). The previous behavior
invoked `Agent` directly to dispatch dev subagents in-session. The original
RFC-0041 §2.1 rationale cited a "600s background-agent watchdog (~85% kill
rate)" — **that claim was a misdiagnosis** (forensic re-measurement
2026-05-21 via `python3 ~/.claude/skills/audit-subagent/audit.py` found 0
watchdog kills and 80.8% clean completion across 73 dev subagents, median
16 min, max 2.5 h). The Conductor/Worker decoupling pattern provides real
benefits (operator-controlled parallelism, billing visibility, cost-pool
isolation post-2026-06-15) that stand independently of the now-corrected
watchdog claim; this command continues to use the pattern for those reasons.
The cost-pool comparison should be re-evaluated against the corrected
baseline.

> **Why this lives in the slash command body (not a subagent).** Plugin
> subagents cannot use the `Agent` tool — Claude Code filters it out one
> level deep. The reviewer fan-out per verdict must therefore happen here.

## Hard rules (identical to `/ai-sdlc execute`)

1. **Never merge any PR.** Do not run `gh pr merge`.
2. **Never force-push.** Use `--force-with-lease` only after the mandatory rebase.
3. **Never close PRs or issues.** No `gh pr close`, `gh issue close`.
4. **Never delete branches.** No `git branch -D` / `-d`.
5. **Never edit `.ai-sdlc/**` or `.github/workflows/**`.**
6. **Never run destructive git operations.** No `git reset --hard`.
7. **Never write CI-skip tokens** (`[skip ci]`, `[ci skip]`, etc.) in commits.

## Protocol overview (RFC-0041 Phase 1 + Phase 1.5 + AISDLC-396 Pattern X)

```
/ai-sdlc orchestrator-tick (Conductor)
  │
  ├── 1. Check AI_SDLC_AUTONOMOUS_ORCHESTRATOR is set
  ├── 2. Sweep stale heartbeats (reap dead Workers into failed/)
  ├── 2.5. [Pattern X / AISDLC-396] Sweep bg-agent-request/ — for each
  │       pending request, fire a background `Agent(developer)` call and
  │       remove the consumed request file. Also GC orphaned requests.
  ├── 3. Poll done/ subdir — for each new verdict:
  │       outcome === 'success':
  │         a. Spawn 3 reviewer subagents (foreground Agent calls)
  │         b. Sign attestation
  │         c. Push branch + arm auto-merge
  │         d. Remove the consumed verdict
  │       outcome === 'iterate-needed' (Phase 1.5 / AISDLC-377.2):
  │         a. Probe iteration budget — if exhausted, write
  │            'iteration-exhausted' diagnostic; else write a resume
  │            signal next to the still-inflight manifest
  │         b. Remove the consumed verdict (manifest stays in inflight/)
  ├── 4. Poll failed/ subdir — escalate diagnostics to operator
  │       (including 'iteration-exhausted' from step 3)
  ├── 5. Peek queue + inflight counts — if under cap, emit new manifests
  │       (one per frontier-admitted task, via cli-deps frontier).
  │       [Pattern X / AISDLC-396] After emitting each manifest, ALSO
  │       write a bg-agent-request so Step 2.5 of the next tick dispatches
  │       a developer Agent in-session (no sibling session needed).
  └── 6. ScheduleWakeup(30s) — OR exit if --once passed
```

## Path resolution

```bash
# Same convention as /ai-sdlc execute (see ai-sdlc-plugin/README.md).
if [ -n "${CLAUDE_PLUGIN_DIR:-}" ]; then
  PIPELINE_CLI_BIN="$CLAUDE_PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin"
  PLUGIN_SCRIPTS_DIR="$CLAUDE_PLUGIN_DIR/scripts"
else
  PIPELINE_CLI_BIN="$(pwd)/pipeline-cli/bin"
  PLUGIN_SCRIPTS_DIR="$(pwd)/ai-sdlc-plugin/scripts"
fi
BOARD_DIR="${AI_SDLC_DISPATCH_BOARD_DIR:-$(pwd)/.ai-sdlc/dispatch}"
```

## Step 1 — Feature-flag guard

```bash
if [ -z "$AI_SDLC_AUTONOMOUS_ORCHESTRATOR" ]; then
  echo "ERROR: AI_SDLC_AUTONOMOUS_ORCHESTRATOR is not set. Set it to 'experimental' to enable."
  exit 1
fi
```

## Step 2 — Sweep stale heartbeats

```bash
SWEEP_RESULT=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" sweep --board-dir "$BOARD_DIR")
echo "[orchestrator-tick] sweep: $SWEEP_RESULT"
```

The sweeper moves any inflight Workers with stale heartbeats (>30 min by
default, RFC-0041 OQ-3) to `failed/` with a `stale-heartbeat` diagnostic.
The Conductor's failed/ poll (Step 4) then escalates.

## Step 2.5 — Sweep `bg-agent-request/` and fire in-session dev dispatches (Pattern X / AISDLC-396)

**Pattern X (single-session autonomous drain):** Step 5 of the previous
tick may have written one or more `bg-agent-request/<task-id>.json` files
describing dev dispatches that need a foreground `Agent` call. This step
fires those dispatches in the main session.

> **Why this lives in the slash command body** — plugin subagents cannot
> use `Agent` (AISDLC-98), so the Conductor cannot directly spawn a dev
> subagent inline. Instead, Step 5 writes a synthetic request file and
> Step 2.5 (the slash command body, where `Agent` is available) picks it
> up. This filesystem coordination is the core of Pattern X.

```bash
# 1. GC any requests whose inflight manifest has been reaped by the
#    stale-heartbeat sweeper (Step 2 above). Safe to call every tick.
PRUNED_JSON=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" prune-orphaned-bg-agent-requests \
  --board-dir "$BOARD_DIR")
echo "[orchestrator-tick] bg-agent-request prune: $PRUNED_JSON"

# 2. List every pending request (oldest-first by requestedAt).
REQUESTS_JSON=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" list-bg-agent-requests \
  --board-dir "$BOARD_DIR")
echo "[orchestrator-tick] bg-agent-request list: $REQUESTS_JSON"
```

For each request in the `requests` array (parse with `node -e ...`),
**fire a background `Agent` call** to the `developer` subagent with:

- `subagent_type`: `developer`
- `cwd`: the request's `worktree` value
- `run_in_background`: `true` — so the slash command body can fire all
  pending dispatches in parallel without blocking on any one. The dev
  subagents write their JSON envelopes to stdout; Claude Code's
  background-Agent machinery delivers a completion notification when each
  finishes. The receiving handler (the slash command body's listener for
  background-Agent completions) runs the dispatch-worker Step 5
  verdict-write protocol to land the outcome into `done/<task-id>.json`.
- `prompt`: the request's `prompt` field (built by `dispatch-bg-agent`
  from the manifest; already includes the task ID, worktree path, branch,
  and verify commands).

After firing the Agent call for a request, **remove the request file** so
the next tick's sweep does not double-fire:

```bash
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" remove-bg-agent-request \
  --board-dir "$BOARD_DIR" --task-id "$REQ_TASK_ID"
```

> **Cross-session survivability (AC-6).** If the slash command body exits
> between Step 5 (request written) and Step 2.5 (Agent fired), the request
> survives on disk. The next `orchestrator-tick` — in a fresh session —
> sees the pending request in `list-bg-agent-requests` and fires the
> `Agent` call. The dev subagent re-launches from scratch (no continuation
> state to preserve since it hasn't started yet). If a request's inflight
> manifest has gone stale during the gap, the stale-heartbeat sweeper
> reaps the manifest and `prune-orphaned-bg-agent-requests` deletes the
> orphaned request — no double-dispatch risk.

> **Concurrency cap (AC-5).** Step 5 (below) enforces the
> `inSessionAgentMaxSessions` cap (default 4) BEFORE writing each request,
> so the count of pending+inflight Pattern X tasks never exceeds the cap.
> Step 2.5 does not need its own cap — it fires whatever Step 5 already
> admitted.

## Step 3 — Pick up `done/` verdicts and fan out reviewers

```bash
VERDICTS_JSON=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" collect-verdicts --board-dir "$BOARD_DIR" --include-failed)
echo "[orchestrator-tick] done/+failed/ verdicts: $VERDICTS_JSON"
```

The `--include-failed` flag is required so failed-side verdicts surface in
`$VERDICTS_JSON`. Without it the CLI's `includeFailed` default is `false`
(see `pipeline-cli/src/cli/dispatch.ts`), and Step 4's `outcome ∈ {failed,
quota-exhausted, blocked}` iteration would silently see zero entries —
stale-heartbeat reaps and `noClaimBefore` cool-downs would never fire.

For each verdict in the array with `outcome === 'success'`:

1. Read the PR branch / commit SHA from the verdict.
2. **Spawn 3 reviewer subagents in parallel** via foreground `Agent` calls:
   - `code-reviewer` — `Read`/`Bash`/`Grep` tools, reviews the diff
   - `test-reviewer` — same toolset, focuses on test coverage + ACs
   - `security-reviewer` — same toolset, security audit
   Reviewer subagents are short-lived (read diff JSON, emit verdict JSON, exit).
   Foreground `Agent` calls are well-suited regardless of duration.
3. Aggregate the 3 verdicts, write them to `.ai-sdlc/verdicts/<task-id>.json`.
3a. **Emit transcript leaves (RFC-0042 Phase 3 / AISDLC-383.8)** — after aggregating verdicts, emit one Merkle leaf per reviewer before signing. Required for v6 signing; harmless in v5 mode:
   ```bash
   HEAD_SHA_FOR_NONCE="<PR head SHA from verdict>"
   TASK_ID_LOWER="$(echo '<task-id>' | tr '[:upper:]' '[:lower:]')"
   WORKTREE_PATH=".worktrees/${TASK_ID_LOWER}"
   EMIT_MODEL="${AISDLC_REVIEWER_MODEL:-claude-sonnet-4-6}"
   for AGENT_NAME in code-reviewer test-reviewer security-reviewer; do
     TRANSCRIPT_FILE="${WORKTREE_PATH}/.ai-sdlc/transcripts/${TASK_ID_LOWER}/${AGENT_NAME}.jsonl"
     VERDICT_FILE="${WORKTREE_PATH}/.ai-sdlc/verdicts/${AGENT_NAME}-${TASK_ID_LOWER}.json"
     [ -f "$TRANSCRIPT_FILE" ] || { echo "[orchestrator-tick] transcript missing for $AGENT_NAME — skipping leaf" >&2; continue; }
     [ -f "$VERDICT_FILE" ] || { echo "[orchestrator-tick] verdict missing for $AGENT_NAME — skipping leaf" >&2; continue; }
     node "$PIPELINE_CLI_BIN/cli-attestation.mjs" emit-leaf \
       --repo-root "$WORKTREE_PATH" \
       --task-id "<task-id>" \
       --reviewer "$AGENT_NAME" \
       --transcript-path "$TRANSCRIPT_FILE" \
       --verdict-path "$VERDICT_FILE" \
       --head-sha "$HEAD_SHA_FOR_NONCE" \
       --harness "claude-code" \
       --model "$EMIT_MODEL" \
       || echo "[orchestrator-tick] emit-leaf for $AGENT_NAME exited non-zero (non-fatal in v5 mode)"
   done
   ```
4. Sign the attestation:
   ```bash
   node "$PLUGIN_SCRIPTS_DIR/sign-attestation.mjs" \
     --review-verdicts ".ai-sdlc/verdicts/<task-id>.json" \
     --task-id <task-id>
   ```
5. Rebase + push the branch (`git fetch origin main && git rebase origin/main && git push --force-with-lease`).
6. Arm auto-merge: `gh pr merge --auto <PR#>`.
7. Remove the consumed verdict:
   ```bash
   node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" remove-verdict \
     --board-dir "$BOARD_DIR" --task-id <task-id> --from done
   ```

For verdicts with `outcome === 'iterate-needed'` (Phase 1.5 / AISDLC-377.2),
the Conductor runs the **iteration trigger protocol** (RFC-0041 OQ-4):

```bash
# 1. Probe the manifest's iteration budget. Output:
#    {"taskId":"...","attempts":N,"budget":M,"exhausted":<bool>,"hasManifest":true}
PROBE_JSON=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" probe-iteration-budget \
  --board-dir "$BOARD_DIR" --task-id "$TASK_ID")

EXHAUSTED=$(echo "$PROBE_JSON" | node -e "
  const d=[]; process.stdin.on('data',c=>d.push(c));
  process.stdin.on('end',()=>{
    const r = JSON.parse(d.join(''));
    process.stdout.write(r.exhausted ? 'yes' : 'no');
  });
")

# MAJOR #2 (iteration-2 review): parse ATTEMPTS + BUDGET out of the probe
# BEFORE either branch consumes them. Earlier revisions referenced these
# as bash positionals without ever assigning them — that emitted empty
# numeric arguments to write-iteration-exhausted, causing NaN/invalid
# values in the escalated diagnostic. The assignment uses the same
# stdin-piped node -e pattern as EXHAUSTED above (no jq dependency).
ATTEMPTS=$(echo "$PROBE_JSON" | node -e "
  const d=[]; process.stdin.on('data',c=>d.push(c));
  process.stdin.on('end',()=>{
    const r = JSON.parse(d.join(''));
    process.stdout.write(String(r.attempts));
  });
")
BUDGET=$(echo "$PROBE_JSON" | node -e "
  const d=[]; process.stdin.on('data',c=>d.push(c));
  process.stdin.on('end',()=>{
    const r = JSON.parse(d.join(''));
    process.stdout.write(String(r.budget));
  });
")

if [ "$EXHAUSTED" = "yes" ]; then
  # 2a. Budget cap hit — escalate, do NOT trigger another resume.
  node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" write-iteration-exhausted \
    --board-dir "$BOARD_DIR" \
    --task-id "$TASK_ID" \
    --iterations-attempted "$ATTEMPTS" \
    --iteration-budget "$BUDGET" \
    --worker-kind in-session-agent
  # The Conductor will pick this up next tick as a failed-side
  # 'iteration-exhausted' diagnostic and surface to the operator.
else
  # 2b. Within budget — write a resume signal.
  # FEEDBACK_TEXT is the concatenation of:
  #   - the verdict's `notes` field (Worker self-reported reasons),
  #   - any verifier stderr the Worker captured,
  #   - the Conductor's own observations (e.g. "stale-heartbeat reaped,
  #     trying once more").
  # Keep it terse — this is prepended to the resumed conversation.
  node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" write-resume-signal \
    --board-dir "$BOARD_DIR" \
    --task-id "$TASK_ID" \
    --feedback "$FEEDBACK_TEXT" \
    --prior-iteration "$ATTEMPTS" \
    --triggered-by "conductor-$$"
fi

# In BOTH cases, consume the done/ verdict so the Conductor doesn't
# re-process it next tick. Iteration uses the SAME inflight manifest as the
# first attempt — the manifest stays in inflight/ for the Worker to
# continue against; only the verdict file is consumed here.
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" remove-verdict \
  --board-dir "$BOARD_DIR" --task-id "$TASK_ID" --from done
```

The Worker (running `/ai-sdlc dispatch-worker` in a sibling CC session)
detects the resume signal on its next poll and invokes the developer agent
with `continue: true` (preserving prior conversation state) plus the
`FEEDBACK_TEXT` prepended.

## Step 4 — Pick up `failed/` diagnostics

For each verdict with `outcome ∈ {failed, quota-exhausted, blocked}`:

- `quota-exhausted` → set `noClaimBefore` on subsequent in-session-agent
  manifests for `retryAfter` seconds (OQ-7 cool-down). Do NOT emit new
  `in-session-agent` manifests during the cool-down window.
- `failed` (verification-failed, schema-violation, etc.) → escalate via
  `AskUserQuestion` summarising the diagnostic.
- `blocked` → the Worker stopped on a precondition (e.g. upstream OQ).
  Surface the `notes` field to the operator.

Remove the consumed diagnostic from `failed/` after handling.

## Step 5 — Peek board occupancy + emit new manifests + Pattern X dispatch

```bash
PEEK_JSON=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" peek --board-dir "$BOARD_DIR")
# Parse PEEK_JSON.queued + .inflight; if their sum < inSessionAgentMaxSessions
# (default 4, per .ai-sdlc/dispatch-config.yaml spec.parallelism), pick more
# frontier tasks via:
#   node "$PIPELINE_CLI_BIN/cli-deps.mjs" frontier --format json
# For each admitted task, build a DispatchManifest (RFC-0041 §4.4) and write it:
#   echo '<manifest-json>' > /tmp/manifest.json
#   node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" write-manifest \
#     --board-dir "$BOARD_DIR" --json /tmp/manifest.json
```

**Pattern X (AISDLC-396) — in-session dev dispatch:** after writing each
manifest, ALSO claim it into `inflight/` and write a `bg-agent-request`
so the next tick's Step 2.5 fires the dev `Agent` call in this session.

```bash
# 1. Claim the just-written manifest (atomic rename from queue/ to inflight/).
CLAIM_JSON=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" claim \
  --board-dir "$BOARD_DIR" \
  --worker-kind in-session-agent)
TASK_ID=$(echo "$CLAIM_JSON" | node -e "
  const d=[]; process.stdin.on('data',c=>d.push(c));
  process.stdin.on('end',()=>{
    const r = JSON.parse(d.join(''));
    process.stdout.write(r.claimed ? r.manifest.taskId : '');
  });
")
MANIFEST_PATH=$(echo "$CLAIM_JSON" | node -e "
  const d=[]; process.stdin.on('data',c=>d.push(c));
  process.stdin.on('end',()=>{
    const r = JSON.parse(d.join(''));
    process.stdout.write(r.claimed ? r.manifestPath : '');
  });
")

if [ -n "$TASK_ID" ] && [ -n "$MANIFEST_PATH" ]; then
  # 2. Write a heartbeat so the stale-heartbeat sweeper (Step 2) tolerates
  #    the gap between Conductor-claim and Step-2.5-Agent-fire.
  node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" heartbeat \
    --board-dir "$BOARD_DIR" \
    --task-id "$TASK_ID" \
    --worker-id "in-session-conductor-$$" \
    --worker-kind in-session-agent \
    --current-step bg-agent-pending

  # 3. Write the bg-agent-request that Step 2.5 will fire next tick.
  #    The CLI enforces the inSessionAgentMaxSessions cap; exit code 1
  #    indicates the cap is saturated and Step 2.5 will catch up first.
  DISPATCH_JSON=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" dispatch-bg-agent \
    --board-dir "$BOARD_DIR" \
    --manifest-path "$MANIFEST_PATH" \
    --requested-by "conductor-tick-$$" || true)
  echo "[orchestrator-tick] bg-agent-request dispatch: $DISPATCH_JSON"
fi
```

Backpressure: if `peek.queued + peek.inflight >= inSessionAgentMaxSessions`,
skip emitting new manifests this tick. The Worker sessions (or Pattern X
in-session Agents) are saturated; no point in piling up. The
`dispatch-bg-agent` subcommand also re-checks the cap as defense-in-depth
— if Step 5 races with Step 2.5 such that the cap is briefly exceeded,
the cap check exits 1 with `{ok:false, inFlight, maxSessions}` and the
manifest stays in inflight/ for the next tick to pick up.

Each manifest declares `workerKind: in-session-agent` (the default per
`.ai-sdlc/dispatch-config.yaml`). The Conductor MAY override to
`claude-p-shell` for tasks the operator wants run headlessly (Phase 2 only
— Phase 1 Worker sessions ignore `claude-p-shell` manifests).

### Operator escalation X → Y → Z

| Trigger | Switch to |
|---|---|
| Default | Pattern X (this command alone, single session, in-session Agent dispatch) |
| Subscription quota exhausted mid-drain | Pattern Y (`cli-orchestrator tick --spawner claude` — shells out to `claude -p`, draws Agent SDK credit pool) |
| N>4 parallel devs needed (large backlog burst) | Pattern Z (open N sibling sessions running `/ai-sdlc dispatch-worker`) |

Patterns coexist — the same Dispatch Board accepts manifests from any
mix of Workers. The `bg-agent-request/` subdir only governs Pattern X
dispatch; Pattern Y/Z Workers ignore it.

## Step 6 — ScheduleWakeup

```bash
ONCE_FLAG="${ARGUMENTS:-}"
if [ "$ONCE_FLAG" != "--once" ]; then
  echo "[orchestrator-tick] scheduling next tick in 30s"
  # ScheduleWakeup 30s /ai-sdlc orchestrator-tick
fi
```

---

## Conductor architecture

The Conductor:

- Does all Worker-bound dispatch through the filesystem-backed Dispatch Board.
  Workers live in their own CC sessions and can run as long as needed.
- Only spawns foreground reviewer subagents (short-lived: read diff, emit
  JSON, exit).

**Historical note (2026-05-21):** RFC-0041 §2.1 originally documented a "600s
background-agent watchdog" as the reason to avoid `Agent(... run_in_background)`.
That claim was a misdiagnosis — forensic re-measurement found 0 watchdog kills
in 73 dev subagents (`python3 ~/.claude/skills/audit-subagent/audit.py`). The
Conductor/Worker decoupling still provides useful properties (operator-controlled
parallelism, billing-pool isolation), so this command continues to use the
pattern; the watchdog-avoidance framing has been removed.

Operator runbook for opening Worker sessions: see `/ai-sdlc dispatch-worker`.
Reference manifest emit: see RFC-0041 §4.4. Heartbeat sweep + stale-claim
recovery: see RFC-0041 §5.2 (WorkerStaleHeartbeat row).

---

## Implementation note — legacy `claude-cli` inline-manifest path

The pre-RFC-0041 path (`cli-orchestrator tick --spawner claude-cli` +
in-session `Agent` dispatch) is retained for backward-compat but
**deprecated**. The Dispatch Board path is preferred for any operator who
wants to drain >1 task at a time. The legacy path will be removed in
RFC-0041 Phase 3.3 (AISDLC-377.6) after a one-release deprecation window.
