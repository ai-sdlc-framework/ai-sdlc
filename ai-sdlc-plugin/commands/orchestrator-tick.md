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

## Protocol overview (RFC-0041 Phase 1 + Phase 1.5 + AISDLC-396 Pattern X v2 — reconcile flow)

**Pattern X v2 (AISDLC-396 round 2 reframe):** the dev subagent honors its
standard Definition-of-Done contract (commit → rebase → push --force-with-lease
→ open DRAFT PR → return JSON envelope with `prUrl`). The Conductor
**reconciles after-the-fact**: picks up the verdict, runs 3 reviewers, signs
the attestation envelope, force-pushes the attestation chore on top of the
dev's branch, and flips draft → ready-for-review.

This reframe replaces the v1 framing ("dev doesn't push; Conductor handles
push + PR") which fought the dev agent's hardwired contract per
`feedback_dev_subagents_violate_no_push.md` and silently dropped the
`bg-agent-request` Agent return value because the bash slash command body
isn't a JS event loop.

```
/ai-sdlc orchestrator-tick (Conductor)
  │
  ├── 1. Check AI_SDLC_AUTONOMOUS_ORCHESTRATOR is set
  ├── 2. Sweep stale heartbeats (reap dead Workers into failed/)
  ├── 2.5. [Pattern X v2 / AISDLC-396] TWO-PHASE sweep:
  │       Phase A — RECONCILE completions: for each completion notification
  │         that matched a pending request since last tick (delivered to
  │         the parent CC session via <task-notification> system-reminders),
  │         parse the Agent return JSON, extract commitSha + prUrl, write
  │         done/<task-id>.verdict.json via `cli-dispatch write-verdict`,
  │         remove the bg-agent-pending/<task-id>.json sentinel.
  │       Phase B — DISPATCH pending: for each bg-agent-request file with
  │         no matching pending-sentinel, fire a background
  │         `Agent(developer)` call (run_in_background:true), write a
  │         bg-agent-pending/<task-id>.json sentinel so Phase A of the
  │         NEXT tick can reconcile its completion, and remove the
  │         consumed request file. Also GC orphaned requests.
  ├── 3. Poll done/ subdir — for each new verdict:
  │       outcome === 'success':
  │         a. Spawn 3 reviewer subagents (foreground Agent calls)
  │         b. Sign attestation
  │         c. **Force-push the attestation chore commit ON TOP of the
  │            dev's branch** (the dev already pushed in step 2.5 Phase B;
  │            we're adding the chore commit, not the work commit)
  │         d. **Flip draft → ready-for-review** via gh pr ready <#>
  │            (the dev opened the PR as draft per Pattern X v2 contract;
  │            this flip triggers CI exactly once on the fully-attested HEAD)
  │         e. Arm auto-merge
  │         f. Remove the consumed verdict
  │       outcome === 'iterate-needed' (Phase 1.5 / AISDLC-377.2):
  │         a. Probe iteration budget — if exhausted, write
  │            'iteration-exhausted' diagnostic; else write a resume
  │            signal next to the still-inflight manifest
  │         b. **[Pattern X iteration]** Write a fresh bg-agent-request
  │            for the same task; Step 2.5 Phase B of NEXT tick dispatches
  │            a new bg Agent with the resume signal prepended to the prompt.
  │            (Pattern X devs are stateless one-shot — unlike Pattern Z
  │            Workers, the same Agent process does not resume; a fresh
  │            Agent re-runs with the resume signal as added context.)
  │         c. Remove the consumed verdict (manifest stays in inflight/)
  ├── 4. Poll failed/ subdir — escalate diagnostics to operator
  │       (including 'iteration-exhausted' from step 3)
  ├── 5. Peek queue + inflight counts — LOOP `while in-flight < cap AND
  │       frontier-has-ready`: emit + claim + write bg-agent-request for
  │       each frontier-admitted task. Single-tick fill-to-cap (AISDLC-396
  │       round-2 MAJOR-4 fix). The loop body re-checks the cap each
  │       iteration to handle the race where Step 2.5 Phase B drained
  │       concurrent dispatches.
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
# AISDLC-411 (2026-05-23) flipped AI_SDLC_AUTONOMOUS_ORCHESTRATOR to default-ON.
# Conductor is enabled unless the operator explicitly opted out via the FALSY set.
case "$(echo "${AI_SDLC_AUTONOMOUS_ORCHESTRATOR:-}" | tr '[:upper:]' '[:lower:]')" in
  off|0|false|no)
    echo "ERROR: AI_SDLC_AUTONOMOUS_ORCHESTRATOR is explicitly disabled (\"$AI_SDLC_AUTONOMOUS_ORCHESTRATOR\")."
    echo "Unset it (or set to a non-opt-out value) to re-enable; default-ON since AISDLC-411."
    exit 1
    ;;
esac
```

## Step 2 — Sweep stale heartbeats

```bash
SWEEP_RESULT=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" sweep --board-dir "$BOARD_DIR")
echo "[orchestrator-tick] sweep: $SWEEP_RESULT"
```

The sweeper moves any inflight Workers with stale heartbeats (>30 min by
default, RFC-0041 OQ-3) to `failed/` with a `stale-heartbeat` diagnostic.
The Conductor's failed/ poll (Step 4) then escalates.

## Step 2.5 — Two-phase sweep: RECONCILE completions, then DISPATCH pending (Pattern X v2 / AISDLC-396 round 2)

**Pattern X v2 (single-session autonomous drain with after-the-fact reconcile):**
the slash command body operates as a two-phase reconciler.

- **Phase A — RECONCILE completions.** For every dev `Agent(developer)`
  call previously dispatched via `run_in_background:true`, Claude Code
  delivers a `<task-notification>` completion event to the parent CC
  session as a system-reminder when the bg Agent finishes. The slash
  command body parses the Agent's return JSON (the standard developer
  envelope with `commitSha` + `prUrl`), writes it as a verdict to
  `done/<task-id>.verdict.json` via `cli-dispatch write-verdict`, and
  removes the matching `bg-agent-pending/<task-id>.json` sentinel.
- **Phase B — DISPATCH pending.** For every `bg-agent-request` written
  by Step 5 of a prior tick that has no in-flight bg Agent, fire a
  fresh `Agent(developer)` call with `run_in_background:true`, write a
  `bg-agent-pending/<task-id>.json` sentinel (so the NEXT tick's Phase A
  knows to expect this Agent's completion), and remove the consumed
  request file.

> **Why two phases.** Bash slash command bodies are NOT JS event loops;
> they cannot register a callback when a bg Agent completes. The previous
> tick's Phase B fires the Agent and exits; the completion arrives
> minutes-to-hours later as a `<task-notification>` in the operator's CC
> session. Phase A of the NEXT tick is when the parent CC session — now
> aware of the completion — can write the verdict. The
> `bg-agent-pending/<task-id>.json` sentinel is the durable handoff
> between ticks, surviving session exits per AC-6.

```bash
# 1. GC any requests whose inflight manifest has been reaped by the
#    stale-heartbeat sweeper (Step 2 above). Safe to call every tick.
PRUNED_JSON=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" prune-orphaned-bg-agent-requests \
  --board-dir "$BOARD_DIR")
echo "[orchestrator-tick] bg-agent-request prune: $PRUNED_JSON"
```

### Phase A — Reconcile completed bg Agent calls

Scan `<BOARD_DIR>/bg-agent-pending/` for sentinel files. For each
sentinel, check the parent CC session's recent `<task-notification>`
events for a completion matching the sentinel's `agentId`. When a match
is found, extract the Agent's final return JSON (the standard developer
envelope) and translate it into a verdict via `cli-dispatch write-verdict`:

```bash
# Parse the matched Agent's return envelope into a verdict. The fields
# below are extracted from the dev's JSON envelope:
#   summary, filesChanged, commitSha, prUrl, verifications,
#   acceptanceCriteriaMet, notes
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" write-verdict \
  --board-dir "$BOARD_DIR" \
  --task-id "$TASK_ID" \
  --outcome success \
  --commit-sha "$DEV_COMMIT_SHA" \
  --pushed-branch "$DEV_PUSHED_BRANCH" \
  --pr-url "$DEV_PR_URL" \
  --verifications "$DEV_VERIFICATIONS_JSON" \
  --acceptance-criteria-met "$DEV_ACS_JSON" \
  --worker-kind in-session-agent \
  --worker-id "in-session-agent-${TASK_ID}"

# Sentinel consumed — remove so Phase A doesn't re-process next tick.
rm -f "$BOARD_DIR/bg-agent-pending/${TASK_ID}.pending.json"
```

When the Agent's return envelope had `prUrl: null` and a `notes` field
explaining a blocker (the standard developer escalation contract), the
verdict's `outcome` is `failed` or `blocked` per the dev's reported state.

> **What if the operator dismissed the task-notification or the parent
> session restarted between dispatch and completion?** The sentinel
> persists. Phase A's first scan will see no matching notification,
> leave the sentinel in place, and check again next tick. The bg Agent's
> actual work product is already on disk (commit + push happened inside
> the Agent's session); the only thing waiting is the verdict-write.
> The operator can manually re-trigger Phase A reconciliation by querying
> the dev's PR via `gh pr view` for the SHA + URL, then running
> `cli-dispatch write-verdict` directly. AISDLC-396 round-2 follow-up
> may automate this query-and-recover path; the round-2 baseline is the
> sentinel-driven manual recovery.

### Phase B — Fire bg Agent for each pending request

```bash
# List every pending request (oldest-first by requestedAt).
REQUESTS_JSON=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" list-bg-agent-requests \
  --board-dir "$BOARD_DIR")
echo "[orchestrator-tick] bg-agent-request list: $REQUESTS_JSON"
```

For each request in the `requests` array (parse with `node -e ...`):

1. Skip if `bg-agent-pending/<task-id>.pending.json` already exists (Phase
   B of a prior tick already fired this Agent; Phase A is waiting on its
   completion).
2. **Fire a background `Agent` call** to the `developer` subagent with:
   - `subagent_type`: `developer`
   - `cwd`: the request's `worktree` value
   - `run_in_background`: `true` — completion notifications arrive on a
     later tick for Phase A to reconcile.
   - `prompt`: the request's `prompt` field (built by
     `buildDevPromptFromManifest`; honors the dev's standard
     push + DRAFT-PR contract per Pattern X v2).
3. Write a `bg-agent-pending/<task-id>.pending.json` sentinel describing
   the dispatch (Agent ID, dispatched-at timestamp, manifest path) so
   Phase A of the next tick can pair the completion notification with
   this dispatch.
4. Remove the consumed `bg-agent-request/<task-id>.request.json` so this
   tick's remaining sweep + the next tick's Phase B don't double-fire.

```bash
# Per-request: dispatch + sentinel + cleanup.
mkdir -p "$BOARD_DIR/bg-agent-pending"
cat > "$BOARD_DIR/bg-agent-pending/${REQ_TASK_ID}.pending.json" <<JSON
{
  "schemaVersion": "v1",
  "taskId": "${REQ_TASK_ID}",
  "agentId": "${BG_AGENT_ID}",
  "dispatchedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "manifestPath": "${MANIFEST_PATH}"
}
JSON

node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" remove-bg-agent-request \
  --board-dir "$BOARD_DIR" --task-id "$REQ_TASK_ID"
```

> **Cross-session survivability (AC-6).** If the slash command body exits
> between Step 5 (request written) and Step 2.5 Phase B (Agent fired), the
> request survives on disk. The next `orchestrator-tick` — in a fresh
> session — sees the pending request in `list-bg-agent-requests` and
> fires the `Agent` call. If the parent session exits between Phase B
> (Agent fired, sentinel written) and Phase A (notification arrives), the
> sentinel persists; the operator's manual recovery uses `gh pr view` to
> inspect the dev's pushed branch + PR and runs `cli-dispatch
> write-verdict` to land the verdict. If a request's inflight manifest
> has gone stale during the gap, the stale-heartbeat sweeper reaps the
> manifest and `prune-orphaned-bg-agent-requests` deletes the orphaned
> request — no double-dispatch risk.

> **Concurrency cap (AC-5).** Step 5 (below) enforces the
> `inSessionAgentMaxSessions` cap (default 4, configurable via
> `.ai-sdlc/dispatch-config.yaml`'s `spec.parallelism.inSessionAgentMaxSessions`
> — AISDLC-396 round-2 MAJOR-3 fix) BEFORE writing each request, so the
> count of pending+inflight Pattern X tasks never exceeds the cap.
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

1. Read the PR URL + commit SHA + pushed branch from the verdict. In
   Pattern X v2 (AISDLC-396 round 2 reconcile flow) the dev has already
   pushed its branch AND opened a DRAFT PR; `prUrl` and `pushedBranch`
   are populated in the verdict. The Conductor's role here is the
   **after-the-fact reconcile**: add the attestation chore commit on top
   of the dev's branch and flip the draft PR to ready-for-review.
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
5. **Force-push the attestation chore commit on top of the dev's branch**
   (Pattern X v2 reconcile). The dev already pushed its work commit + opened
   the PR in step 2.5 Phase B; this push adds the attestation chore commit
   on top. Run from the dev's worktree:
   ```bash
   cd "${WORKTREE_PATH}"
   git fetch origin main
   git rebase origin/main
   git push --force-with-lease
   ```
6. **Flip the draft PR to ready-for-review** via:
   ```bash
   gh pr ready "<PR#>"
   ```
   This is the load-bearing flip — it triggers CI exactly once on the
   fully-attested HEAD. The dev opened the PR as draft per Pattern X v2
   contract specifically to defer this CI trigger until attestation
   landed.
7. Arm auto-merge: `gh pr merge --auto <PR#>`.
8. Remove the consumed verdict:
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

  # 2c. [Pattern X iteration / AISDLC-396 round-2 MAJOR-5] Re-dispatch.
  # Pattern X dev subagents are stateless one-shot — unlike Pattern Z
  # Workers which call `Agent(continue:true)` to resume, Pattern X has
  # already exited the bg Agent that produced the iterate-needed verdict.
  # The next tick's Step 2.5 Phase B sees a fresh bg-agent-request for
  # this task and fires a new dev Agent. The dev's prompt-build path
  # checks for a resume signal (via `cli-dispatch read-resume-signal`)
  # and prepends FEEDBACK_TEXT to the standard prompt.
  node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" dispatch-bg-agent \
    --board-dir "$BOARD_DIR" \
    --manifest-path "$BOARD_DIR/inflight/${TASK_ID}.dispatch.json" \
    --requested-by "conductor-iterate-$$" \
    || echo "[orchestrator-tick] Pattern X iterate re-dispatch skipped (cap saturated or duplicate; next tick retries)"
fi

# In BOTH cases, consume the done/ verdict so the Conductor doesn't
# re-process it next tick. Iteration uses the SAME inflight manifest as the
# first attempt — the manifest stays in inflight/ for the Worker to
# continue against; only the verdict file is consumed here.
node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" remove-verdict \
  --board-dir "$BOARD_DIR" --task-id "$TASK_ID" --from done
```

**Pattern X iteration (AISDLC-396 round 2):** the dev's prompt-build path
checks for a resume signal before constructing the standard prompt. When
present, the resume signal's `feedback` is prepended as a leading section
("## Prior-iteration feedback from Conductor") so the dev re-attempts
with full context. Pattern Z Workers (running `/ai-sdlc dispatch-worker`
in sibling CC sessions) keep using their existing `Agent(continue:true)`
resume path — Pattern Z and X coexist on the same Dispatch Board.

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

## Step 5 — Peek board occupancy + fill-to-cap loop (Pattern X v2 / AISDLC-396 round-2 MAJOR-4 fix)

**Fill-to-cap loop (AISDLC-396 round 2):** the previous revision (round 1)
claimed AT MOST one manifest per tick. With a 30s wakeup loop and 4-task
cap, the worst case took 4 ticks (~2 min) to saturate from empty — a
needless throttle on autonomous drain throughput. Round 2 loops the claim
+ dispatch until the cap is hit OR the frontier has no more ready tasks.

```bash
# Resolve the cap from yaml (AISDLC-396 round-2 MAJOR-3) with fallback to
# the built-in default of 4.
MAX_SESSIONS=$(node -e "
  const { loadDispatchConfig } = require('$PIPELINE_CLI_BIN/../dist/dispatch/recommend-worker.js');
  const cfg = loadDispatchConfig(process.cwd());
  process.stdout.write(String(cfg?.inSessionAgentMaxSessions ?? 4));
" 2>/dev/null || echo 4)

# Fill-to-cap loop. Each iteration:
#   1. Re-check in-flight count (Step 2.5 Phase A may have drained some).
#   2. Stop if at/over cap OR frontier has no ready tasks.
#   3. Emit + claim + dispatch the next frontier task.
ITER=0
MAX_ITER=$((MAX_SESSIONS * 2))   # belt-and-braces — never loop more than 2x cap
while [ "$ITER" -lt "$MAX_ITER" ]; do
  ITER=$((ITER + 1))

  # 1. Recount in-flight (deduplicated inflight ∪ bg-agent-request).
  IN_FLIGHT=$(node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" count-in-flight-bg-agents \
    --board-dir "$BOARD_DIR" | node -e "
    const d=[]; process.stdin.on('data',c=>d.push(c));
    process.stdin.on('end',()=>{
      const r = JSON.parse(d.join(''));
      process.stdout.write(String(r.count));
    });
  ")
  if [ "$IN_FLIGHT" -ge "$MAX_SESSIONS" ]; then
    echo "[orchestrator-tick] fill-to-cap: in-flight $IN_FLIGHT >= cap $MAX_SESSIONS; done"
    break
  fi

  # 2. Probe the frontier — does cli-deps frontier have a ready task?
  FRONTIER_JSON=$(node "$PIPELINE_CLI_BIN/cli-deps.mjs" frontier --format json 2>/dev/null || echo '[]')
  HAS_READY=$(echo "$FRONTIER_JSON" | node -e "
    const d=[]; process.stdin.on('data',c=>d.push(c));
    process.stdin.on('end',()=>{
      try {
        const r = JSON.parse(d.join(''));
        const ready = Array.isArray(r) && r.find((t) => t && !t.nonDispatchable);
        process.stdout.write(ready ? 'yes' : 'no');
      } catch { process.stdout.write('no'); }
    });
  ")
  if [ "$HAS_READY" = "no" ]; then
    echo "[orchestrator-tick] fill-to-cap: frontier has no ready tasks; done"
    break
  fi

  # 3. Emit the manifest for the top frontier entry (build via your standard
  #    DispatchManifest builder; see RFC-0041 §4.4) into queue/, then jump
  #    into the per-manifest claim+dispatch block below.
  #
  # The original single-shot block continues below — the loop wraps it.

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
else
  # claim returned {claimed:false} — queue drained between probe + claim
  # (concurrent Conductor or rapid Step 2.5). Exit the fill-to-cap loop.
  echo "[orchestrator-tick] fill-to-cap: claim came back empty; done"
  break
fi
done   # end fill-to-cap while-loop
```

Backpressure: the loop's per-iteration `count-in-flight-bg-agents` probe
is the primary cap-enforcement signal; `dispatch-bg-agent` re-checks
defensively. If Step 5's loop races with Step 2.5 Phase A such that the
cap is briefly exceeded between iterations, the `dispatch-bg-agent` cap
check exits 1 with `{ok:false, inFlight, maxSessions}` and the manifest
stays in inflight/ for the next tick to pick up.

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
