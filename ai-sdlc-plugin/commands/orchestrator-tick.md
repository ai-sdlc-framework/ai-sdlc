---
name: orchestrator-tick
description: >-
  [SUBSCRIPTION-ONLY PATH post-2026-06-15 — RFC-0041 Phase 1] Run one
  Conductor tick. Reads the dispatch frontier, emits manifests to the
  Dispatch Board for Worker sessions to claim, then polls the done/ + failed/
  subdirs for newly-landed verdicts. For each successful verdict, fans out
  3 reviewer subagents (foreground Agent calls), signs the attestation,
  pushes the branch, and arms auto-merge. Because
  reviewers run foreground in this interactive session, they draw the
  operator's subscription quota — not the Agent SDK credit pool. Pair with
  one or more sibling sessions running /ai-sdlc dispatch-worker to drain
  the queue end-to-end at zero incremental cost. See RFC-0041 §4.6 +
  docs/operations/billing-and-cost-optimization.md §1b.
argument-hint: "[--once]"
allowed-tools:
  - Read
  - Bash
  - Agent(code-reviewer, test-reviewer, security-reviewer)
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

## Protocol overview (RFC-0041 Phase 1 + Phase 1.5)

```
/ai-sdlc orchestrator-tick (Conductor)
  │
  ├── 1. Check AI_SDLC_AUTONOMOUS_ORCHESTRATOR is set
  ├── 2. Sweep stale heartbeats (reap dead Workers into failed/)
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
  │       (one per frontier-admitted task, via cli-deps frontier)
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

## Step 5 — Peek board occupancy + emit new manifests

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

Backpressure: if `peek.queued + peek.inflight >= inSessionAgentMaxSessions`,
skip emitting new manifests this tick. The Worker sessions are saturated;
no point in piling up.

Each manifest declares `workerKind: in-session-agent` (the default per
`.ai-sdlc/dispatch-config.yaml`). The Conductor MAY override to
`claude-p-shell` for tasks the operator wants run headlessly (Phase 2 only
— Phase 1 Worker sessions ignore `claude-p-shell` manifests).

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
