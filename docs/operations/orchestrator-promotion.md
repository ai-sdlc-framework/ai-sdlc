# Promoting `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` from default-OFF to default-ON

**Audience**: AI-SDLC operators (specifically: whoever is dispatching the
final flag-flip PR for RFC-0015). This is the runbook for the final
step of RFC-0015 Phase 5 — flipping the
`AI_SDLC_AUTONOMOUS_ORCHESTRATOR` env-var default from `off` to `on`
so the autonomous pipeline orchestrator becomes the standard behaviour.

**TL;DR**: there are two paths. Both produce the same default-on
end-state. Pick based on whether the events corpus is rich enough for
math.

| Path | When to use | Tooling | Authority |
|---|---|---|---|
| **Corpus path** | events.jsonl corpus has ≥20 dispatched tasks across ≥3 distinct task IDs | `cli-orchestrator-corpus aggregate` | Math-rigorous; recommendation drops out of the data |
| **Override path** | Corpus is sparse OR the operator has separate evidence (`cli-status --orchestrator` survey of recent runs) the unattended dispatch isn't surprising | Eyeball recent events in `cli-status --orchestrator` + `gh run list` | Operator judgment |

---

## Background: why two paths?

Per maintainer directive 2026-05-01 (RFC-0015 §11 Phase 5): **calendar
duration is a side-effect, not a gate**. The promotion criteria are:

- **Unattended completion rate ≥ 95%** — `(completed + recovered) /
  dispatched` across the corpus, where `completed` =
  `OrchestratorCompleted{outcome: 'approved'}` and `recovered` =
  `OrchestratorRecovered` (Phase 2 playbook auto-fixed a failure
  without operator involvement). The denominator is `dispatched` =
  `OrchestratorDispatched` event count.
- **No quota-burn surprise** — actual tokens-per-task within ±10% of
  RFC-0015 §12's projection (~200k/task; tunable via
  `--tokens-per-task`). A surprise = any run consuming materially more
  tokens than projected, which would risk mid-batch quota exhaustion
  in `default-on` mode.
- **Real-issue queue scale** — ≥20 dispatched tasks across ≥3 distinct
  backlog tasks/RFCs (RFC §11 Phase 5 acceptance "≥20 tasks across 3
  RFCs"). RFC tagging isn't on the events stream so we operationalise
  "≥3 RFCs" as "≥3 distinct task IDs" — a corpus that re-runs the
  same task 25 times does NOT satisfy the gate.

Whichever path satisfies the criteria first wins. Until the events
corpus accumulates enough data after Phase 1-4 ship for confident
math, the operator may use the override path (eyeball + judgment) so
the promotion isn't gated on calendar time.

The two paths produce the same end-state: the
`AI_SDLC_AUTONOMOUS_ORCHESTRATOR` default flips from `off` to `on` in
the appropriate config file (see "The flag flip" below). The only
difference is which evidence justified the flip.

---

## Corpus path (preferred when ≥20 tasks across ≥3 task IDs)

### 1. Collect events.jsonl artifacts

The Phase 4 events writer emits a date-rotated JSONL artifact at
`$ARTIFACTS_DIR/_orchestrator/events-YYYY-MM-DD.jsonl` per
orchestrator-running day. Collect recent files into a single
directory:

```bash
mkdir -p ./orchestrator-corpus
# Local — every operator who opted in has events under their
# project-local `$ARTIFACTS_DIR/_orchestrator/`. The conventional
# location is `./artifacts/_orchestrator/` when ARTIFACTS_DIR isn't
# set.
cp -r ./artifacts/_orchestrator/* ./orchestrator-corpus/
```

If you've also been uploading events as workflow artifacts (e.g. from
a self-hosted GH Actions runner that runs the orchestrator), download
them with `gh run download`:

```bash
gh run list --limit 100 --json databaseId \
  | jq -r '.[].databaseId' \
  | while read run_id; do
      gh run download "$run_id" --pattern '*-orchestrator-events' --dir ./orchestrator-corpus 2>/dev/null || true
    done
```

The `gh run download` layout drops one subdirectory per artifact;
`cli-orchestrator-corpus` recurses into the root and globs all
`.jsonl` files automatically. Per-worker forensic state files
(`workers/<id>.state.json`) are NOT consumed by the aggregator — they
are forensic-only per RFC §13 Q2.

### 2. Run the aggregator

```bash
node pipeline-cli/bin/cli-orchestrator-corpus.mjs aggregate ./orchestrator-corpus --format table
```

Or for JSON output (useful when chaining with `jq` for the dispatch
decision):

```bash
node pipeline-cli/bin/cli-orchestrator-corpus.mjs aggregate ./orchestrator-corpus
```

### 3. Read the `recommendation` field

- **`safe-to-promote`** — `dispatched ≥ minTasks`, `distinctTaskIds ≥
  minDistinctTasks`, `unattendedRate ≥ 95%`, AND
  `quotaBurnSurprises === 0`. Dispatch the flag flip (see "The flag
  flip" below).
- **`continue-soak`** — corpus has enough data, but at least one of
  the gates above failed. The `reason` field names the failing
  metric — that's the next thing to tune (or wait on more data).
  - **Unattended rate too low** → grow the failure playbook
    (RFC-0015 §5.1 / AISDLC-169.2). The `failureModes` distribution
    tells you which mode is escalating most often; expanding that
    handler's coverage usually moves the rate.
  - **Quota burn surprise** → either operators are running on a
    smaller subscription tier than RFC §12 anticipated (override
    `--tokens-per-task`), or a particular task's cost is genuinely
    surprising and warrants per-task investigation before flipping.
- **`insufficient-data`** — `dispatched < 20` OR `distinctTaskIds <
  3`. Either wait for more orchestrator activity or use the override
  path below.

Tunables (rarely needed; defaults match RFC-0015 §11 Phase 5):

- `--min-tasks` — dispatched-task floor (default 20)
- `--min-distinct-tasks` — distinct-task-ID floor (default 3)
- `--unattended-threshold` — unattended-completion rate floor (default 0.95)
- `--quota-burn-threshold` — per-run quota-burn ratio above which a run counts as a surprise (default 1.10)
- `--tokens-per-task` — RFC §12 per-task projection (default 200000)

### 4. Dispatch the flag flip

Once `recommendation: safe-to-promote` lands, follow "The flag flip"
section below. Include the `cli-orchestrator-corpus aggregate` JSON
envelope in the PR body as the audit trail.

---

## Override path (when corpus is sparse but signal is clearly fine)

Use this when:

- `cli-orchestrator-corpus` returns `insufficient-data`, AND
- The operator has separate evidence the orchestrator isn't
  surprising (e.g. they've spot-checked recent runs in the
  `cli-status --orchestrator` view and the dispatch decisions +
  outcomes look reasonable).

### Steps

1. **Spot-check `cli-status --orchestrator`**:

   ```bash
   AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental \
     node dogfood/dist/cli-status.js --orchestrator --limit 50
   ```

   - Are the `OrchestratorCompleted` events outnumbering
     `OrchestratorFailed`? (Good — autonomous mode is converting
     dispatch into completion.)
   - Is there a recurring `OrchestratorFailed{mode: ...}` that the
     playbook isn't handling? Trace the `mode` field; if it's a
     pattern, file the catalogue extension before promoting.
   - Are there `OrchestratorRecovered` events? Those are wins — the
     Phase 2 playbook caught + remediated a known failure mode. They
     count in the unattended numerator.

2. **Spot-check the per-worker forensic files**:

   ```bash
   ls -la artifacts/_orchestrator/workers/
   cat artifacts/_orchestrator/workers/w-aisdlc-XXX.state.json | jq .
   ```

   - States ending in `DONE` or `DONE_WITH_FLAG` are clean.
   - States ending in `NEEDS_HUMAN_ATTENTION` mean the operator did
     get pulled in — check the `lastFailure.mode` field.
   - States ending in `PARKED` mean a long-running PR (per RFC §13
     Q6) and is NOT a defect — the orchestrator correctly released
     the slot.

3. **Document the decision**: when dispatching the flag-flip PR,
   include a short note in the PR body explaining which path was
   used and the evidence the operator looked at. The override path
   is the operator's call to make, but the audit trail is mandatory.

4. **Dispatch the flag flip** the same way as the corpus path. The
   flip is identical — the only difference is which evidence
   justified it.

---

## The flag flip

The `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` default is currently OFF. The
flag parser lives in `pipeline-cli/src/orchestrator/feature-flag.ts`
(`isOrchestratorEnabled`) and follows the canonical opt-in semantics
(`experimental` plus the standard `1`/`true`/`yes`/`on`
case-insensitive). To flip the default to ON, choose the surface
appropriate to your deployment:

### Option A — flip the default in the parser (single-PR flip)

Edit `pipeline-cli/src/orchestrator/feature-flag.ts#isOrchestratorEnabled`
so the flag defaults to ON when unset, and operators opt OUT via
`AI_SDLC_AUTONOMOUS_ORCHESTRATOR=off`. This is the cleanest
"default-on" flip but inverts the parser's polarity — every consumer
that branches on the flag value should be reviewed in the same PR.

A mechanical reference diff (do NOT apply blindly — review every
caller first):

```diff
-export function isOrchestratorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
-  const raw = env[ORCHESTRATOR_FLAG];
-  if (!raw) return false;
-  return TRUTHY.has(raw.trim().toLowerCase());
-}
+const FALSY = new Set(['off', '0', 'false', 'no']);
+export function isOrchestratorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
+  const raw = env[ORCHESTRATOR_FLAG];
+  if (!raw) return true; // default-on after RFC-0015 §11 Phase 5 promotion
+  return !FALSY.has(raw.trim().toLowerCase());
+}
```

### Option B — set the env in the orchestrator entrypoint

Add `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental` to the env block of
every workflow / systemd unit / Docker container that runs the
orchestrator — leaves the parser's default OFF and lets local
operators opt out by running with the env unset. Less invasive but
doesn't propagate to operator shells.

The corpus-path PR should pick Option A (true default-on); the
override path may pick either depending on confidence. **Both produce
the same operator UX**: the orchestrator polls + dispatches +
remediates without per-task supervision; the events.jsonl bus carries
the full forensic trail.

After the flip lands, update:

- `CLAUDE.md` — change the "Off by default" line in the
  `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` bullet to "On by default; set
  `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=off` to disable."
- `pipeline-cli/docs/orchestrator.md` — flip the "Quick start" framing
  + the "Phase 1+ are opt-in" status line to reflect the new default.
- AISDLC-169 (parent) — close ACs #2, #3, #6, #8 ("flag promoted,
  real-issue queue runs autonomously, RFC v2 entry, runbook extended").

---

## What happens after the flip

Once `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` is ON by default:

- Operators who run `node pipeline-cli/bin/cli-orchestrator.mjs start`
  (or the systemd / Docker / GH Actions runner template) get the
  autonomous loop without setting an env. Set
  `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=off` locally to revert.
- The `cli-deps frontier` query, `executePipeline()` invocation, and
  failure playbook all behave identically — no per-event behaviour
  shift, just "the loop now runs unsupervised in more environments."
- The events.jsonl bus + per-worker forensic state continue to
  accumulate; nothing on-disk needs to be undone.
- Future failure modes that fall into the catch-all
  `UnknownFailureMode` still escalate to `needs-human-attention` per
  RFC §13 Q8 — the conservative bias is preserved.

If the flip turns out to be premature (unattended rate spikes after
promotion, or a quota-burn surprise surfaces), revert the parser
change (Option A) or remove the env override (Option B) in a
single-line PR. The events.jsonl artifacts and per-worker state files
keep accumulating regardless of mode; the next corpus aggregation
will reflect the regression.

### Rollback procedure

The flag is designed to be a single-line revert. Rollback is the
mirror of the flip:

```bash
# Option A rollback — re-flip the parser default to OFF.
git revert <flag-flip-sha>
git push origin HEAD --force-with-lease  # only on a feature branch
```

```bash
# Option B rollback — remove the env from the workflow/unit file.
# (No code change; the workflow re-runs with the new env block.)
```

The events stream + per-worker forensic files keep flowing through
the rollback — nothing is lost, and the next corpus aggregation will
show the regression that justified the rollback.

---

## Chaos-test rerun procedure

RFC §11 Phase 5 also gates promotion on the chaos test: kill the
orchestrator mid-tick at three distinct points (mid-dispatch,
mid-finalize, mid-remediation) and verify the next startup resumes
correctly per RFC §13 Q2 (idempotent finalize).

The hermetic harness lives at
[`pipeline-cli/src/orchestrator/chaos.test.ts`](../../pipeline-cli/src/orchestrator/chaos.test.ts)
and runs as part of `pnpm --filter @ai-sdlc/pipeline-cli test`. To
spot-check before promotion:

```bash
pnpm --filter @ai-sdlc/pipeline-cli test src/orchestrator/chaos.test.ts
```

A failure here MUST block promotion — the recovery contract is the
foundation of the autonomous mode. If you need to rerun the
end-to-end chaos test against a real orchestrator (rather than the
hermetic injection harness), the procedure is:

1. Start the orchestrator in a tmux/screen session with a 5-task
   fixture queue:

   ```bash
   AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental \
     node pipeline-cli/bin/cli-orchestrator.mjs start \
     --tick-interval-sec 5 --max-concurrent 1 --max-ticks 5
   ```

2. Watch `cli-status --orchestrator` in a second terminal until the
   first dispatch fires.

3. `kill -TERM <pid>` while the dispatch is in-flight. The
   orchestrator should drain + exit cleanly (RFC §13 Q2).

4. Restart with the same command. The new orchestrator should
   re-dispatch the same task — git/gh state is the source of truth,
   not any in-memory orchestrator state.

5. Verify the events.jsonl file is intact (no corrupted lines) and
   that the per-worker forensic file shows the post-restart
   transitions.

---

## Dispatch patterns — X / Y / Z (AISDLC-396)

Once the orchestrator default-on flip is done, the operator has three
ways to dispatch dev Workers. They are NOT mutually exclusive — the same
Dispatch Board accepts manifests from any mix — but each has a different
operator-effort + billing profile.

| Pattern | Worker mechanism | Operator effort | Billing | When to use |
|---|---|---|---|---|
| **X (default, AISDLC-396)** | `/ai-sdlc orchestrator-tick` Conductor spawns dev `Agent(developer)` calls in-session via the `bg-agent-request/` coordination protocol | Open ONE CC session, fire `orchestrator-tick`, walk away. ScheduleWakeup loops indefinitely. | Subscription interactive quota only — Sonnet for dev/code/test, Opus only for security. | The default for interactive operator sessions. ONE session = autonomous drain. Capped at `inSessionAgentMaxSessions` (default 4) — bump for more parallelism in `.ai-sdlc/dispatch-config.yaml`. |
| **Y** | `cli-orchestrator tick --spawner claude` shells out to `claude -p` subprocesses | One-time daemon setup (cron/systemd/launchd), session-independent. | Subscription Agent SDK credit pool ($200/mo on Max-20x post-2026-06-15). | Headless/CI contexts where no operator CC session is available. Cron-driven background drain. |
| **Z (legacy)** | Operator opens N sibling CC sessions running `/ai-sdlc dispatch-worker` | Open N+1 sessions per drain. | Subscription interactive quota. | When N>4 parallel devs needed (large backlog burst). Pattern X's `inSessionAgentMaxSessions` cap can be bumped, but >4 starts hitting per-session attention-tax. |

### Escalation criteria (X → Y → Z)

Start with **X**. Escalate as follows:

- **X → Y**: when the operator wants to walk away for >24h. Pattern X
  needs a live CC session to drive the slash command body; Pattern Y is
  daemonized.
- **X → Z**: when the operator wants N>4 parallel devs and isn't ready to
  draw the paid Agent SDK pool. Z is the "scale up subscription
  parallelism" lever — open more terminals.
- **Y → Z** (or **Y → X**): when the Agent SDK credit pool is exhausted
  or the operator wants to verify a single task interactively before
  re-arming the daemon.

### Concurrency-cap tuning (Pattern X)

`.ai-sdlc/dispatch-config.yaml`:

```yaml
spec:
  parallelism:
    inSessionAgentMaxSessions: 4  # default; bump to 6-8 for bigger drains
```

The cap governs the union of `bg-agent-request/` (pending) +
`inflight/` (running dev Agent) Pattern X tasks. The Conductor's Step 5
refuses to write a new request when the cap is saturated and waits for a
Step 2.5 sweep to drain the backlog.

### Operator runbook — kicking off Pattern X

1. Ensure `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental` (or the
   default-on equivalent if the flip is done).
2. Open one CC session in the project root.
3. `/ai-sdlc orchestrator-tick` — the Conductor:
   - Emits up to `inSessionAgentMaxSessions` manifests to `queue/`
   - Claims each into `inflight/` and writes a `bg-agent-request/`
   - The next tick's Step 2.5 fires `Agent(developer)` in-session for
     each pending request
   - Reviewer fanout + sign + push + auto-merge happens via Step 3 on
     each dev verdict
4. ScheduleWakeup runs the next tick every 30s; the session can be
   left open indefinitely.
5. Operator monitors via `cli-status --orchestrator` or the events.jsonl
   tail.

If the session crashes or the operator closes it, the on-disk state
(`queue/`, `inflight/`, `bg-agent-request/`) survives. The next session
opening the same project picks up where this one left off — pending
requests fire, stale heartbeats reap, the drain continues.

---

## References

- RFC-0015 §11 Phase 5 (corpus-driven exit criteria)
- RFC-0015 §13 Q2 (stateless + idempotent finalize → no resume code path)
- RFC-0015 §13 Q8 (UnknownFailureMode catch-all → needs-human-attention)
- RFC-0041 §4.4 (Dispatch Board protocol — Pattern X coordination layer)
- AISDLC-396 (Pattern X — in-session background Agent dispatch — this section)
- AISDLC-169.5 (chaos test + corpus aggregator)
- AISDLC-169.4 (Phase 4 — events.jsonl writer + cli-status --orchestrator)
- AISDLC-169.2 (Phase 2 — failure playbook this aggregator counts)
- [`pipeline-cli/docs/orchestrator.md`](../../pipeline-cli/docs/orchestrator.md) — operator guide for the flag
- [`docs/operations/deps-composition-promotion.md`](deps-composition-promotion.md) — sister
  promotion runbook for RFC-0014's `AI_SDLC_DEPS_COMPOSITION` flip;
  same hybrid-corpus-OR-override structure
- [`docs/operations/dor-promotion.md`](dor-promotion.md) — sister
  promotion runbook for RFC-0011 DoR `enforce` flip; same hybrid
  structure
