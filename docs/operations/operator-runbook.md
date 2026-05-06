# AI-SDLC Operator Runbook

**Audience:** AI-SDLC Pipeline Operator — the human responsible for running, tuning, and triaging an AI-SDLC pipeline.
**Status:** Draft v1
**Companion to:** [RFC-0010 Parallel Execution and Worktree Pooling](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md)

---

## What this role is

The Pipeline Operator owns the **policy, posture, and triage layer** of an AI-SDLC pipeline. Three engineering capabilities had to land before this role could exist coherently:

- **PPA scoring** (RFC-0005, integrated via RFC-0008) lifted prioritization out of human hands.
- **AI-driven implementation + review** lifted code production and code review out of human hands.
- **Parallel + cost-aware orchestration** (RFC-0010) lifted infrastructure choreography out of human hands.

What's left for the operator is the thin layer of human judgment the system genuinely needs: **configuration, cost posture, calibration, and event triage.**

## What this role is not

| Not | Why |
|---|---|
| Software engineer | The agents write code |
| Code reviewer | Review agents review code (testing, critic, security) |
| Product manager | PPA prioritizes work |
| SRE / DevOps | Orchestrator + adapters manage infrastructure |
| Maintainer | Per project policy, only humans merge PRs — but the operator does NOT merge either; engineers/maintainers do |
| Customer support | Separate function |

## Daily, weekly, monthly cadence

```
DAILY      • Read Slack daily-digest
           • Triage flagged events (see Event Triage below)
           • Glance at `cli-status` to confirm parallel agents are progressing
           Time: ~5–15 min
```

```
WEEKLY     • Review TierAnalysis recommendations (Slack digest entry, or `cli-tier-recommendation`)
           • Audit IndependenceViolated and MigrationDiverged events from the week
           • Check burn-down trends per harness
           Time: ~30 min
```

```
MONTHLY    • Refresh `lastVerified` dates on SubscriptionPlans (verify against vendor docs)
           • Audit cost ledger against vendor invoice
           • Review classifier calibration drift (`$ARTIFACTS_DIR/_classifier/calibration.jsonl`)
           • Tune pipeline YAML if recommendations have stacked up
           Time: 1–2 hours
```

```
AS-NEEDED  • Approve `cli-model-bump` after vendor deprecation announcements
           • Resolve operator-required failures (RebaseConflict, MigrationConflict, WorktreeOwnershipMismatch)
           • Onboard new client → declare new SubscriptionPlan + tenant overlay
           • Adjust `requiresIndependentHarnessFrom` on security-critical stages
           Time: variable
```

---

## Event Triage Reference

The orchestrator surfaces structured events to `$ARTIFACTS_DIR/_events.jsonl` and to the Slack daily-digest. This is the master reference for what each event means and how to respond.

### Severity levels

| Severity | Meaning | Default surface |
|---|---|---|
| **Info** | Audit signal, no action required | Event stream only |
| **Advisory** | Operator may want to act, no urgency | Slack daily-digest |
| **Warning** | Operator should review within ~1 day | Slack daily-digest, highlighted |
| **Error** | Operator should review within ~1 hour | Slack immediate, plus digest |
| **Critical** | Pipeline is blocked or degraded; act now | Slack immediate alert |

### Quota and cost events

| Event | Severity | Meaning | Response |
|---|---|---|---|
| `BurnDownReport` | Info | Periodic (5-min) snapshot of subscription utilization | Read in `cli-status --subscriptions`. No action unless `recommendation` is `under-pacing` or `over-pacing` for multiple consecutive periods |
| `QuotaContention` | Advisory | High-PPA stage blocked on `hardCap`; pipeline did not cede priority to lower-PPA work | If frequent, consider tier upgrade or raising `hardCap` |
| `BudgetExceeded` | Warning | Stage exceeded its `maxBudgetUsd` circuit breaker | Review `estimatedTokens` for the stage; either raise `maxBudgetUsd` or investigate why the stage ran long |
| `AdmissionDenied` | Info | Stage couldn't admit (which cap blocked is in the event detail) | Inform tuning, not action |
| `OffPeakDeferralExceeded` | Advisory | `schedule: off-peak` stage waited longer than `offPeakMaxWait` and dispatched on-peak | Check off-peak schedule freshness; consider extending `offPeakMaxWait` if dispatching on-peak is unacceptable |
| `LedgerSourceFallback` | Advisory | Authoritative quota API was unavailable; ledger fell back to self-tracked | Check vendor API status; resolve once API recovers |
| `TierAnalysis` | Advisory | Weekly tier recommendation | Review in Slack digest. If `recommendedPlan != currentPlan` and `confidence: high`, evaluate the upgrade/downgrade |

### Subscription configuration events

| Event | Severity | Meaning | Response |
|---|---|---|---|
| `LedgerReconciliation` | Warning | First switch to authoritative quota source surfaced divergence from self-tracked | Review divergence (>10 points means historical decisions warrant audit). One-time event per switch |
| `LedgerPooled` | Info | Two pipelines on the same `(harness, accountId, tenant)` are sharing a ledger | Confirm pooling matches your intent; not a problem unless you expected isolation |
| `LedgerKeyAmbiguous` | Warning | Adapter couldn't derive `accountId`; ledger degraded to per-pipeline keying | Set `Pipeline.spec.accountId` explicitly to recover correct pooling |
| `TenantShareInvalid` | Critical | Sum of `tenantQuotaShare` across same `(harness, accountId)` ≠ 1.0; orchestrator startup failed | Fix YAML. Pipelines on the same account must have shares summing to 1.0 |
| `OffPeakScheduleStale` | Advisory (>30d) / Error (>90d) | `SubscriptionPlan.spec.offPeak.lastVerified` is old or missing | Verify the schedule against current vendor docs and bump the date |
| `QuotaSourceUpdateRecommended` | Advisory | Self-tracker drift detectable; vendor authoritative API now available | Consider opt-in via `quotaSource: authoritative-api` |

### Harness and model events

| Event | Severity | Meaning | Response |
|---|---|---|---|
| `HarnessFallback` | Info | Stage fell over from primary to fallback harness | Audit only. Frequent fallback → primary harness has availability issues |
| `HarnessUnavailable` | Critical | Pipeline-load failed because primary harness isn't installed/in-version | Install or upgrade the harness binary (see error detail for command) |
| `HarnessProbeFailed` | Warning | Adapter couldn't parse `--version` output; assumed available | Likely a vendor output-format change; report to maintainer |
| `IndependenceViolated` | Error | Stage with `requiresIndependentHarnessFrom` couldn't preserve independence after fallback | If `onFailure: continue`, audit any review that fired and consider re-running on a different harness manually |
| `UnknownHarness` | Critical | Pipeline references an unregistered harness | Fix YAML or wait for the adapter to be registered |
| `ModelDeprecated` | Advisory | Model is deprecated but still resolves; removal date in event | Plan migration before `removedAt` |
| `ModelDeprecationGracePeriod` | Warning | Within 30 days of `removedAt` | Run `cli-model-bump --dry-run` to preview; commit migration soon |
| `ModelRemoved` | Critical | Model is unavailable; pipeline-load failed | Update model alias or registry; `cli-model-bump` to upgrade |
| `CyclicIndependenceConstraint` | Critical | `requiresIndependentHarnessFrom` references downstream stage | Fix YAML — independence references must be upstream-only |

### Worktree and database events

| Event | Severity | Meaning | Response |
|---|---|---|---|
| `WorktreeOwnershipMismatch` | Critical | Worktree adoption refused — worktree points at a different clone | Manual cleanup of the `.worktrees/` entry; verify which clone is authoritative |
| `PortCollision` | Info | Deterministic port collided; orchestrator probed for a free port | Audit only |
| `RebaseConflict` | Critical | Merge gate's rebase failed; pipeline run suspended | Manual rebase + push, or abort the run |
| `MergeConflict` | Critical | Git merge conflict | Same as RebaseConflict |
| `MigrationConflict` | Critical | Schema migration conflict at merge time | Resolve in code (rename column, etc.); often signals coordination issue between two PRs |
| `MigrationFailed` | Critical | Migration command failed during branch allocation | Branch was reclaimed; pipeline aborted. Fix migration code or migration-command config |
| `MigrationDiverged` | Warning | Reclaimed branch had active children that inherited its now-discarded migration | Triage children: rebase, accept divergence, or reclaim. Only fires when `allowBranchFromBranch: true` |
| `BranchQuotaExceeded` | Error | Vendor branch quota hit | Run stale-branch sweep; if persistent, raise vendor quota or reduce `maxConcurrent` |
| `BranchTopologyForbidden` | Critical | Pipeline tried to branch-from-branch with `allowBranchFromBranch: false` | Either restructure to branch from stable upstream, or opt in (and accept divergence risk) |
| `DatabaseIsolationRequired` | Critical | Pipeline has `parallelism > 1` and a `databaseAccess: write/migrate` stage but no DatabaseBranchPool | Declare a DatabaseBranchPool or set `parallelism: 1` |
| `BranchAllocationLatency` | Info | P99 branch creation time elevated | If sustained >5s P99 for >10% of allocations, consider enabling `warmPoolSize > 0` |

### Stage execution events

| Event | Severity | Meaning | Response |
|---|---|---|---|
| `AgentTimeout` | Warning | Stage exceeded its `timeout` | First occurrence: investigate. Multiple: re-score (handled automatically per §9.4) |
| `MaxRetriesExhausted` | Error | Retry strategy exhausted | Issue is back on the queue with re-scoring. Manual triage if it cycles |
| `CIFailure` | Info / Warning | CI failed on the PR | Fix-PR pipeline runs automatically. If fix-PR also fails, manual review required |
| `RetriageStorm` | Warning | Single issue triggered >10 re-triage events in 24h | Investigate why. The issue isn't actually being addressed |
| `ArtifactSchemaInvalid` | Critical | Adapter produced JSON that didn't validate against schema, after retry | Manual review of the adapter prompt; likely a regression in adapter source |
| `ArtifactSchemaRetry` | Info | First-attempt JSON failed validation; retry succeeded | Audit only. Persistent retries → tune adapter prompt |
| `MissingEstimate` | Advisory | Stage has no `estimatedTokens` and no rolling history | Pipeline loads with default `{50000, 10000}`. After first run, `EstimateBootstrapped` will fire |
| `EstimateBootstrapped` | Info | Rolling estimate replaced cold-start default | Audit. Significant divergence (>3×) may warrant declaring `estimatedTokens` in YAML |
| `EstimateVariance` | Warning | Observed tokens deviated from estimate by >50% | Investigate. Persistent variance → stale estimate or model/prompt change |

### Autonomous orchestrator playbook events (RFC-0015 Phase 2)

The autonomous orchestrator (opt-in via `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental`)
ships a 9-pattern catalogued failure playbook from RFC-0015 §5.1 (AISDLC-169.2).
Per-mode events are emitted by the playbook runner; Phase 4 (AISDLC-169.4)
plumbs them into the canonical `events.jsonl` bus. Until Phase 4 ships
they're returned in-memory on each tick result's `playbookEvents` field
and persisted forensically to
`$ARTIFACTS_DIR/_orchestrator/workers/<worker-id>.state.json`.

| Event | Severity | Meaning | Response |
|---|---|---|---|
| `WorkerStateTransition` | Info | Worker moved between states (e.g. `DEV_RUNNING → REVIEW_RUNNING`). Carries `{from, to, duration_ms, context}` | Audit only — feeds the `cli-status --orchestrator` view (Phase 4) |
| `RemediationApplied` | Info | A handler attempted remediation. Carries `{mode, attempt, outcome, note}` | Audit only. Frequent retries on the same mode → catalogue tuning candidate |
| `RemediationFailed` | Warning | A handler exhausted its retry budget. Carries `{mode, attempts, reason}` | Investigate the per-mode entry below for the right operator action |
| `WorkerParked` | Advisory | `LongRunningPRBlocksWorker` released a worker slot whose PR was open >2h. PR continues independently | No action — operator may merge the PR manually if it's been blocked on a non-CI factor |

#### Per-mode escalation reference

When a `RemediationFailed` event fires, the `mode` field tells you what
to do:

| Mode | What it means escalated | Operator action |
|---|---|---|
| `SecretScanBlocked` | Dev couldn't rewrite the literal-secret pattern in 2 attempts | Review the PR's diff. The literal value lives in source as a string — refactor to template-literal construction or move to env. PR is labelled `needs-human-attention` |
| `PushRaceWithMergeQueue` | Push still rejected after 3 × 60s retries | Likely a merge-queue jam. Run `gh pr view <pr> --json state,mergeStateStatus`; check the queue. Push manually once the queue drains |
| `RebaseConflict` | `/ai-sdlc rebase` resolver couldn't auto-resolve | Manual rebase per CLAUDE.md "Git Flow" section. Resolve markers, run verify, `git push --force-with-lease` |
| `VerificationFailure` | Dev re-implementation failed verify on both attempts | Review the verify output in the PR. May indicate AC was wrong, env mismatch, or genuine code issue — engineering judgment call |
| `ReviewerMajorOrCritical` | Reviewer flagged critical/major findings on both dev attempts | Read the reviewer feedback in the PR body. Re-spawn dev manually with sharpened guidance, or hand-fix |
| `EnvHookFailure` | `--no-verify` retry refused (source-touching change) OR push still failed | Investigate the env (PATH, husky, tooling). Source-touching changes require a working hook environment; never bypass |
| `AttestationVerifyMismatch` | Re-sign + re-push failed | Manually run `bash scripts/check-attestation-sign.sh` then `git push --force-with-lease`. If still mismatched, run `/ai-sdlc rebase <pr>` |
| `LongRunningPRBlocksWorker` | (Not an escalation — this is the parked-worker terminal state) | Check why the PR is stuck (CI? branch protection? merge queue?). Merge manually if appropriate, or resolve the blocker |
| `StackedPRBaseSquashed` | Rebase onto main produced conflicts after the base PR was squash/rebase-merged | Either resolve the rebase conflicts manually, OR open a fresh PR from the rebased branch with `--base main` (drops the implicit chain). See [`docs/operations/stacked-prs.md`](./stacked-prs.md) |
| `UnknownFailureMode` | No catalogued handler matched (RFC §13 Q8 catch-all) | Read the captured stderr in the PR comment. If it's a recurring shape, propose a new catalogue entry via PR against `.ai-sdlc/orchestrator-failure-patterns.yaml` + a new handler under `pipeline-cli/src/orchestrator/playbook/handlers/` |

The 9 catalogued modes ship with default budgets in
`.ai-sdlc/orchestrator-failure-patterns.yaml`; per-project operators
override per-mode `budget` and `escalateImmediately` via the same file
(RFC §13 Q7). Schema validation is at
`.ai-sdlc/schemas/orchestrator-failure-patterns.v1.schema.json` —
malformed catalogues refuse the orchestrator at startup.

### Autonomous orchestrator pre-dispatch filter events (RFC-0015 Phase 3)

Phase 3 (AISDLC-169.3) ships these on the in-process tick result; the
Phase 4 events.jsonl writer (AISDLC-169.4) plumbs them into the structured
event stream that downstream consumers (Slack digest, dashboard) tail. See
[`pipeline-cli/docs/orchestrator.md`](../../pipeline-cli/docs/orchestrator.md)
for the per-filter behaviour + the backoff state machine.

| Event | Severity | Meaning | Response |
|---|---|---|---|
| `OrchestratorBlockedByDependency` | Info | A candidate skipped because an upstream task is still open. Auto-clears when the upstream task lands in `backlog/completed/` | Audit only. Persistent skips on the same task → check `cli-deps blockers <id>` for an unexpected dangling reference |
| `OrchestratorBlockedByDor` | Advisory | Latest `RefinementVerdict` for the candidate is `needs-clarification`. The DoR comment-loop ingress (RFC-0011 §6) is the canonical resolution path; the orchestrator only consumes the verdict | Address the clarification questions in the issue (or apply `dor-bypass` per RFC-0011 §7.4 with a documented reason) |
| `OrchestratorAwaitingExternal` | Advisory | Candidate declares one or more `externalDependencies` of `kind: 'manual'` AND no operator clearance is recorded | When the external prerequisite is satisfied, append `{ "taskId": "<id>", "externalDepId": "<dep-id>" }` to `<artifactsDir>/_orchestrator/cleared-external-deps.json` |
| `OrchestratorIdleNoWork` | Info | Tick saw an empty frontier — no candidates to consider. Backoff curve advances per RFC-0015 §13 Q5 | Audit only. Sustained idle → backlog is fully drained or every open task has unresolved dependencies |
| `OrchestratorIdleAllFiltered` | Advisory | Tick saw N candidates but every one was rejected by the filter chain. Backoff curve advances per RFC-0015 §13 Q3 | Inspect the per-tick `filterEvents` to see which filter is rejecting which candidate; act on the matching `OrchestratorBlockedBy*` row |
| `OrchestratorStuckCandidate` | Warning | A single candidate was skipped >5 consecutive ticks for the same reason. Emits ONCE per streak (re-emits only after the streak resets) | Resolve the gating condition (close the dependency, address the DoR clarification, or clear the external dep). The streak resets on the next admission |

#### `OrchestratorAwaitingExternal` — operator response template

Phase 3 reads operator clearance from a JSON file at
`<artifactsDir>/_orchestrator/cleared-external-deps.json`. With Phase 4
(AISDLC-169.4) now shipped, the same filter events also land on the
`events.jsonl` stream, so operators have a single grep target. To clear
an external dep manually:

```bash
# 1. Inspect the awaiting events on the events stream:
jq 'select(.type == "OrchestratorAwaitingExternal")' \
  artifacts/_orchestrator/events-*.jsonl

# 2. Append a clearance record (create the file if missing — it's a JSON array):
jq '. += [{taskId: "AISDLC-92", externalDepId: "sec-review"}]' \
  artifacts/_orchestrator/cleared-external-deps.json \
  > /tmp/cleared.json && mv /tmp/cleared.json artifacts/_orchestrator/cleared-external-deps.json

# 3. The next tick's external-deps filter sees the entry and admits the candidate.
```

A `cli-orchestrator clear-external <task-id> <external-dep-id>` helper
is on the Phase 5+ roadmap; until then operators edit the JSON file
directly. The file is read fresh on every tick — no orchestrator
restart required.

### Orchestrator-specific failure-mode runbook (RFC-0015 Phase 5)

Phase 5 (AISDLC-169.5) ships the soak corpus + chaos-test harness and
this runbook section. The four failure modes below are
**orchestrator-scoped** (not per-task) — they describe what to do when
the orchestrator itself is the thing that surprised you, rather than
a worker hitting a known catalogued mode.

#### `UnknownFailureMode` escalation triage

The catch-all (RFC §13 Q8). When an `OrchestratorFailed` event has
`mode: 'UnknownFailureMode'`, the catalogued handlers all declined to
match the failure shape. Operator workflow:

1. **Pull the captured stderr** from the events stream:

   ```bash
   node dogfood/dist/cli-status.js --orchestrator --json --limit 100 \
     | jq '[.[] | select(.type == "OrchestratorFailed" and .mode == "UnknownFailureMode")]'
   ```

   The `reason` field is the captured stderr/exit-code from the failing
   dispatch. The `taskId` + `prUrl` fields tell you which worker was
   affected.

2. **Decide if it's a one-off or a pattern.** A single
   `UnknownFailureMode` for a novel shape is fine — the conservative
   bias (Q8 Resolution Option A) means the operator does the hand-fix,
   the orchestrator continues. Two or more occurrences of the same
   shape across distinct tasks → catalogue extension candidate.

3. **Extend the catalogue** when the shape recurs. The source-of-truth
   is `.ai-sdlc/orchestrator-failure-patterns.yaml` (RFC §13 Q9). Add
   a new entry with the regex shape + a TypeScript handler under
   `pipeline-cli/src/orchestrator/playbook/handlers/<mode>.ts`, then
   PR. The catalogue loader validates against
   `.ai-sdlc/schemas/orchestrator-failure-patterns.v1.schema.json` so
   typos fail loudly at startup.

4. **Hand-fix the parked task**: the worker's PR carries the
   `needs-human-attention` label per the catch-all escalation; address
   it directly (rebase, re-spawn dev, manual edit, etc.) and re-push.

#### Parked-worker investigation

A `WorkerParked` event (or a worker whose persisted state is `PARKED`
in `artifacts/_orchestrator/workers/<id>.state.json`) means
`LongRunningPRBlocksWorker` released the worker slot because the
worker's PR sat open >2h without merge or rejection (RFC §13 Q6). The
PR continues independently; the slot freed up.

Investigation workflow:

1. **Find parked workers**:

   ```bash
   for f in artifacts/_orchestrator/workers/*.state.json; do
     state=$(jq -r '.state' "$f")
     if [[ "$state" == "PARKED" ]]; then
       echo "$f"
       jq '{taskId, branch, lastFailure, history: (.history | length)}' "$f"
     fi
   done
   ```

2. **Check why the PR stalled.** Common causes:
   - **CI flake** — a required check is stuck in queue or failed
     transiently. Re-run via `gh pr view <url>` + `gh run rerun`.
   - **Branch protection / required reviews** — auto-merge is on but
     a human reviewer hasn't approved. Tag the right reviewer.
   - **Merge queue jam** — `gh pr view --json mergeStateStatus` shows
     `BLOCKED` or `BEHIND`. Run `/ai-sdlc rebase <pr>` if behind.
   - **Genuinely abandoned** — the work is moot (RFC pivot, sibling
     PR superseded). Close the PR + the parked state file is just
     forensic exhaust; safe to leave.

3. **No automatic action** — orchestrator design (Q6 Option A) is
   "park, do not nag." Auto-rebase during human review would dismiss
   reviews + auto-merge enablement.

#### `OrchestratorStuckCandidate` triage

`OrchestratorStuckCandidate` is a future-Phase-4 event reserved in
RFC §7.1's enum (currently unwired). Detected when the same task ID
appears as the top of frontier across many consecutive ticks without
ever being dispatched — usually because the DoR / dependency / quota
filters keep declining. Triage steps:

1. **Confirm the stuck shape** — the task is at frontier head but
   never dispatches. Check via:

   ```bash
   node dogfood/dist/cli-status.js --orchestrator --limit 200 \
     | grep "candidates=" | head -20
   ```

2. **Identify which filter blocked it.** Phase 3
   (AISDLC-169.3) exposes the filter trace via
   `OrchestratorAwaitingExternal{reason, context}` events. The
   `reason` field names the filter (DoR rejection, dependency gate,
   external-dep block, subscription scheduling).

3. **Resolve the underlying gate**:
   - **DoR rejection** → fix the task's DoR profile (see
     `docs/operations/dor-promotion.md`) or apply `dor-bypass` label.
   - **Dependency gate** → drive the upstream task to completion.
   - **External-dep block** → address the external dependency
     (npm publish, third-party PR merge, etc.).
   - **Subscription scheduler** → `cli-status --subscriptions` shows
     which window is blocked; wait for off-peak or upgrade tier.

4. **Force-progress** is operator judgment — the orchestrator
   correctly refuses to dispatch when a gate says no, so "stuck" is
   diagnostic, not a defect.

#### Chaos-test rerun procedure

The Phase 5 chaos test (hermetic, in
`pipeline-cli/src/orchestrator/chaos.test.ts`) runs as part of
`pnpm --filter @ai-sdlc/pipeline-cli test`. If a regression in the
orchestrator's resume contract is suspected:

```bash
# Hermetic harness — runs in seconds, deterministic.
pnpm --filter @ai-sdlc/pipeline-cli test src/orchestrator/chaos.test.ts
```

A failure here MUST be treated as a release-blocker — the recovery
contract (RFC §13 Q2 idempotent finalize) is what makes
`AI_SDLC_AUTONOMOUS_ORCHESTRATOR=on` safe.

For end-to-end validation against a real orchestrator instance, see
the procedure in
[`docs/operations/orchestrator-promotion.md`](orchestrator-promotion.md#chaos-test-rerun-procedure).

---

## CLI Commands

### Read commands (low-risk, run anytime)

```
cli-status                            # All active worktrees + their current stage
cli-status --subscriptions            # Subscription utilization, color-coded freshness
cli-status --branches                 # Database branches: warm vs active, divergent flag
cli-status --branches --divergent     # Filter to divergent branches only
cli-tier-recommendation               # Most recent TierAnalysis per ledger key
cli-tier-recommendation --last 4      # Last 4 weeks of analyses
cli-tier-recommendation --details     # Per-event contention breakdown
cli-tier-recommendation --all-tenants # All tenants, not just current pipeline
```

### Write commands (require operator decision)

```
cli-model-bump --dry-run              # Preview model alias resolution after deprecation
cli-model-bump                        # Start a new pipeline run picking up new resolutions
cli-classifier-feedback <pr> --add-reviewer <r> --reason <text>
                                      # Attribute a missed reviewer to classifier output
                                      # (calibration ground truth)
cli-requeue <issue>                   # Force a requeue (will trigger re-scoring per §9.4)
```

### Configuration

The operator does not run a `cli-edit` command — pipeline configuration lives in YAML files in your project repo:

| File | Owns |
|---|---|
| `pipeline.yaml` | Stages, parallelism, branching, model/harness routing, schedule hints |
| `worktree-pool.yaml` | Worktree pool config, port allocation, DB pool refs, subscription plan refs |
| `subscription-plans/*.yaml` | Vendor billing models, off-peak schedules, quota source, tenants |
| `database-branch-pools/*.yaml` | DB adapter, upstream, lifecycle, migrations, credentials |

Edit, validate, commit. The orchestrator picks up changes on next pipeline-load (= next pipeline run, NOT mid-run).

---

## Configuration Responsibilities

### Subscription posture

- **Declare a SubscriptionPlan per vendor account.** Without it, `parallelism` defaults to 1 — you've opted out of parallel execution.
- **Refresh `offPeak.lastVerified` quarterly.** Dates >90 days old escalate from advisory to error severity.
- **Choose `quotaSource` deliberately.** Default `self-tracked` is right today; flip to `authoritative-api` only when you trust the vendor API and want strict accounting.

### Tenant overlays

Use `Pipeline.spec.tenant` + `tenantQuotaShare` ONLY when one vendor account serves multiple internal cost centers. Most operators don't need this.

```yaml
# Two teams sharing one account
spec:
  tenant: team-platform
  tenantQuotaShare: 0.6
```

Sum of shares across all tenants on the same `(harness, accountId)` MUST equal 1.0.

### Independence enforcement

Add `requiresIndependentHarnessFrom: [implement]` to `review-critic` and `review-security` stages. The reference pipeline ships with this declared. Without it, fallback can silently collapse cross-harness review onto the same harness as the implementer.

For security-critical pipelines, set `onFailure: abort` on `IndependenceViolated`. For advisory pipelines, leave the default `continue` and watch for the warning in the digest.

### Model routing

The reference pipeline routes:
- `triage`, `review-classify` → Haiku
- `plan`, `review-*`, `validate`, `simplify`, `fix-pr` → Sonnet
- `implement` → Opus 1M

Override per stage via `Stage.model: haiku | sonnet | opus | opus[1m] | inherit`. Pipeline-wide via `Pipeline.spec.defaultModel`.

### Schedule hints

The reference pipeline schedules:
- `triage`, `review-classify`, `plan`, `validate` → `now` (block dispatch queue)
- `implement`, `fix-pr` → `quota-permitting`
- `simplify` → `off-peak`
- `review-*` → `defer-if-low-priority`

Override per stage. Be deliberate: a stage marked `off-peak` may dispatch up to `offPeakMaxWait` (default 8h) into the future.

### Estimate calibration

For the reference pipeline's canonical stages, `estimatedTokens` ships pre-populated. For your novel stages:

1. Leave `estimatedTokens` unset on first declaration.
2. Run the pipeline. Watch for `MissingEstimate` warning at load and `EstimateBootstrapped` after first run.
3. After a few runs, if the rolling estimate is stable, leave it. If it's bimodal and the rolling mean produces bad admission decisions, freeze it:

```yaml
estimatedTokens:
  input: 200000
  output: 30000
  frozen: true
```

---

## Common Scenarios

### "Pipeline dispatched 5 issues but they're all sitting on `quota-permitting`"

Check `cli-status --subscriptions`. Likely `projectedUtilization > hardCap` for the harness driving `implement`. Options:
1. Wait — `BurnDownReport` will show when headroom returns.
2. Lower `hardCap` if you set it artificially low.
3. If a one-off rush, manually lower stage `schedule` to `now` for the issues you need shipped today.
4. Long-term: `TierAnalysis` will surface tier-upgrade recommendations after a few weeks.

### "Slack pinged me about `MigrationDiverged`"

Only fires when `allowBranchFromBranch: true`. Run `cli-status --branches --divergent` to see affected branches. For each, decide:
- **Rebase**: Run `cli-requeue <issue>` after merging the parent migration into the child branch's base.
- **Accept**: The child PR ships its own copy of the parent's migration. Acceptable if the migration was actually correct; problematic if the parent was abandoned for a reason.
- **Reclaim**: Cancel the child PR. The orchestrator does not auto-reclaim children — you must.

### "TierAnalysis says I should downgrade from Max-5x to Pro"

Read the digest entry. If `confidence: high` and utilization has been <40% for 4+ consecutive weeks, the recommendation is sound. Before flipping:
1. Check the `--details` view for any `QuotaContention` events you may have missed.
2. Confirm with the team that workload won't spike (release windows, sprint kickoffs).
3. Update the SubscriptionPlan YAML, restart the orchestrator. New pipeline runs pick up the new tier.

### "`OffPeakScheduleStale` keeps appearing in the digest"

The `lastVerified` date on a SubscriptionPlan is more than 30 days old. Check current vendor docs for off-peak hours, update `schedule:` and `lastVerified:` in the YAML, commit. The warning silences on next pipeline-load.

### "Model deprecation announced — I have 6 weeks before removal"

1. Run `cli-model-bump --dry-run` to see which stages resolve to the deprecated ID and what the replacement is.
2. Test the replacement: start a non-production pipeline run that picks up the new resolution. Verify outputs are acceptable.
3. When ready, restart your production orchestrator (no YAML change needed if you're using aliases). New runs use the new resolution; in-flight runs complete on the deprecated ID per the pinning property.
4. After removal date passes, runs against the old ID will fail. The pinning protects you; the warning gives you the lead time.

### "First-time onboarding a new client"

1. Get the client's vendor account credentials. Add to your secrets management (NEVER paste in YAML).
2. Declare their `SubscriptionPlan` resource with the right `billingMode`, quota, off-peak schedule (verify against vendor docs and set `lastVerified` to today).
3. If they share an account with another client, decide `tenant` overlay (shares summing to 1.0).
4. Create their pipeline YAML referencing the SubscriptionPlan via `WorktreePool.spec.subscriptionPlans[]`.
5. Start with `parallelism.maxConcurrent: 1` for the first few runs. Bump to tier-aware default once you have observed clean execution.

### "RFC-0014 dependency-graph composition is acting up"

The composition layer (`AI_SDLC_DEPS_COMPOSITION`) ships behind a flag — these are the failure modes worth knowing while it's in soak (and after promotion):

- **Snapshot validation failures**: `cli-deps validate` reports cycles or dangling refs. Snapshots are best-effort consistency per RFC-0014 §12 Q6, so transient dangling edges (a task moved between `tasks/` and `completed/` mid-walk) are expected. Persistent failures across multiple runs point at a real cycle in `dependencies:` frontmatter — fix the cycle in the offending task file. The dispatcher refuses via `cli-deps preflight`, so a dangling edge surfaces as a refusal, not a wrong dispatch.
- **Dispatch ordering anomalies**: `cli-deps frontier` returns a top pick that surprises the operator. First check `effectivePriority` + `criticalPathLength` columns in `--format table` — the rationale usually drops out of the metadata ("oh, this leaf unblocks a critical-tagged chain"). If unexplained, log an override via `cli-deps log-override --picked <id> --reason <text>`; the override log is the soak signal that drives [`docs/operations/deps-composition-promotion.md`](deps-composition-promotion.md).
- **Blast-radius callout misfires**: the DoR clarification comment cites the wrong N (or fires when it shouldn't). Lower the per-project threshold via `dor-config.yaml`'s `blastRadiusThreshold` (default 3); see `pipeline-cli/docs/deps.md` Phase 3 section for tuning. False-positive bypass-tone comments are a calibration signal — log them and tune the rubric, don't suppress the comment.
- **Override log polluting the corpus**: `cli-deps log-override` refuses no-op overrides (operator picked the dispatcher's top) and unknown picks (id not on the ranked frontier). If the log accumulates entries you don't trust, it's safe to truncate `$ARTIFACTS_DIR/_deps/overrides.jsonl` — the file is append-only with no other consumer than the aggregator, and the aggregator tolerates missing files.

---

## Skills and Onboarding

### Required

- YAML config + JSON-schema literacy
- Read [PPA scoring](../../spec/rfcs/RFC-0005-product-priority-algorithm.md) (RFC-0005, foundational spec) and the [Triad Integration](../../spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md) layer (RFC-0008) at a conceptual level
- Vendor billing-model literacy (subscription tiers, off-peak schedules, monthly caps)
- Triage / prioritization mindset — decide which events warrant action
- Some budget/finance intuition — tier recommendations, dollar vs token cost model
- Comfort with structured logs and event streams

### Not required

- Ability to write production code
- Ability to review code for correctness
- Deep infrastructure expertise
- Vendor relationship management at procurement level (someone else negotiates contracts)

### Onboarding sequence (1 week)

| Day | Focus |
|---|---|
| 1 | Read this runbook. Read [RFC-0010 §1, §2, §5, §14, §15](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md). Skim others |
| 2 | Walk through the reference pipeline YAML. Trace one issue end-to-end through artifacts |
| 3 | Shadow current operator on a daily triage. Read 1 week of historical Slack digests |
| 4 | Run `cli-*` commands against a dev pipeline. Practice the common scenarios above |
| 5 | Triage independently with current operator on call for questions |

---

## Recovery Runbooks (specific failure modes)

### `WorktreeOwnershipMismatch`

**Symptom.** Pipeline-load fails or `cli-status` shows a worktree the orchestrator refuses to operate on. The error message names the expected clone path vs the actual clone path.

**Cause.** The pool-root directory contains a worktree from a different clone of the same upstream repo. Two common scenarios:
- An operator (or another orchestrator) cloned the repo to a different path and used the same pool root.
- The original clone was deleted but the pool root persisted.

**Recovery.**
1. Confirm the worktree's `.git` pointer file: `cat <pool>/<branch-slug>/.git`
2. If the declared `gitdir` references a clone that still exists: re-run from that clone, OR move the worktree to a pool-root scoped to your clone.
3. If the original clone is gone: manually remove the worktree directory (it's orphaned). `rm -rf <pool>/<branch-slug>`. The next `git worktree add` will recreate it cleanly.
4. To prevent recurrence: scope each clone's pool to a distinct path (default workspace-scoped layout already does this).

### `RebaseConflict`

**Symptom.** Merge gate suspended a pipeline run. The branch's base is stale and `git rebase origin/main` hit a content conflict.

**Recovery.**
1. `cd <pool>/<branch-slug>` and inspect with `git status` — files in conflict are listed.
2. Either resolve manually (preferred for substantive conflicts) or run `git rebase --abort` to bail.
3. If aborting: re-trigger the pipeline run; the orchestrator will re-fetch and try again. If the rebase fails the same way, the issue likely needs a different implementation approach — re-triage manually.
4. After resolving + `git rebase --continue`: `git push --force-with-lease origin <branch>`. The orchestrator will detect the up-to-date base on next merge-gate acquisition.

### Stuck heartbeats (agent hung mid-stage)

**Symptom.** `cli-status` shows an issue with `(STALE)` next to its heartbeat age. No progress for >5 minutes.

**Cause.** The agent process crashed or wedged mid-stage; the heartbeat writer didn't get a chance to update `state.json`.

**Recovery.**
1. Check the actual process: `ps aux | grep <issue-id>`. If it's gone, the agent crashed.
2. Check the worktree for partial state: `cd <pool>/<branch-slug>; git status`. Any uncommitted work is lost or salvageable depending on what was written.
3. To recover the slot: run `cli-requeue <issue-id>` to re-dispatch (Phase 3 dispatcher); or reclaim the worktree manually via `pool.reclaim()` then re-run.
4. Persistent stuck heartbeats on the same issue → check the issue itself for a pathological pattern (e.g., agent stuck in a verify-then-fix loop). Re-triage manually.

### `IndependenceViolated`

**Symptom.** Slack digest entry: review-stage ran on the same harness as the implementer because fallback emptied the chain.

**Recovery.**
1. If the original implementer's harness has recovered: re-run the review stage manually with `cli-requeue` (it'll get the fresh fallback chain).
2. If the harness is persistently down: temporarily expand the stage's `harnessFallback` chain to include another vendor (e.g., add `aider` after `claude-code, codex`).
3. If the pipeline declared `onFailure: abort` for `IndependenceViolated`, the run is suspended; operator decision required.

### `MigrationDiverged`

**Symptom.** Slack digest: child branches inherit a migration that no longer exists in any merged code (parent PR was abandoned).

**Recovery.** See AISDLC-70.9 / RFC §15.5.1 — three options:
1. **Rebase children:** acceptable if the parent migration was discardable.
2. **Accept divergence:** child PR ships its own copy of the parent's migration. Acceptable when the migration was correct.
3. **Reclaim children:** cancel child PRs entirely. Most aggressive.

The orchestrator does NOT auto-reclaim — every option above requires operator triage.

### `BranchQuotaExceeded`

**Symptom.** New worktrees can't allocate database branches; pipeline-load fails.

**Recovery.**
1. Run the stale-branch sweep: `cli-branch-sweep` (or the equivalent operator command — check `cli-status --branches`). Reclaims branches past their TTL.
2. If sweep doesn't free enough: lower `WorktreePool.spec.parallelism.maxConcurrent` temporarily.
3. Long-term: upgrade the vendor quota tier (Neon, Supabase, RDS).

## Definition-of-Ready (DoR) Gate

The DoR gate runs the seven-gate rubric (RFC-0011 §4.1) against every new issue or backlog task before it enters PPA scoring. When a gate fails, the issue is parked in `Needs Clarification` and a comment is posted to the author's native channel with the specific gates that blocked admission. The runbook below covers what the operator sees, where to look, and what to do for the three failure modes specific to the gate's operation: **refusal**, **bypass**, and **escalation**.

For the warn-only → enforce promotion procedure (a separate operational concern), see [`docs/operations/dor-promotion.md`](./dor-promotion.md). The normative spec is [RFC-0011 — Definition-of-Ready Gate](../../spec/rfcs/RFC-0011-definition-of-ready-gate.md).

**When the gate is active.** Behavior is gated by `evaluationMode` in `.ai-sdlc/dor-config.yaml` (RFC-0011 §10):

| Mode | Behavior |
|---|---|
| `disabled` | Gate runs but does not block; verdicts logged to calibration log only |
| `warn-only` | Comments posted with findings; issues NOT moved to `Needs Clarification` |
| `enforce` | Full gate behavior — refusal, comment, status transition |

The failure modes below describe `enforce` behavior. In `warn-only` the comment posts but no refusal fires; the operator's job in `warn-only` is calibration spot-checks (see `dor-promotion.md`), not failure-mode triage.

### Refusal flow (Stage A or Stage B gate failure)

**Symptoms (what operator sees).**

- Slack daily-digest entry naming the issue + the gate(s) that failed (e.g., "Gate 1 — AC not binary-testable").
- Issue / backlog task transitions from `Draft` (or `To Do`) to `Needs Clarification`.
- A `<!-- ai-sdlc:dor-comment -->` comment is posted to the author's native channel (GitHub issue comment, backlog task `## Clarifications Requested` section, or Slack thread per RFC-0011 §6.2).
- If the operator (or anyone) tries `/ai-sdlc execute <task-id>` on the parked issue, the command refuses with: `Refused: <ID> is in Needs Clarification (blocks: Gate N, Gate M). Address the questions in the issue thread, then re-run.` (RFC-0011 §7.3).
- PPA admission silently skips the issue — it does NOT score `Needs Clarification` issues (RFC-0011 §7.2).

**Diagnosis (where to look).**

1. **The DoR comment itself.** It names the failing gates with concrete findings and a checklist of clarifying questions. `gh issue view N --comments` or open the backlog task file under its `## Clarifications Requested` section.
2. **Calibration log.** `$ARTIFACTS_DIR/_dor/calibration.jsonl` records every verdict with `{issueId, verdict, gateResults, confidence, stage}`. Useful for confirming which stage (A deterministic vs B LLM) produced the refusal and the agent's confidence.
3. **CI workflow run.** For GitHub-issue ingress, the `dor-ingress.yml` workflow run carries the full evaluator output; download the `dor-calibration-issue-N-A` artifact for the raw JSONL.

**Resolution (what to do).**

The agent recovers automatically — no operator action is required for the happy path:

1. Author reads the comment, edits the issue body to address the clarifying questions.
2. The edit fires a re-check (debounced 60 seconds per RFC-0011 §7.1) OR the author runs `/ai-sdlc dor-recheck <issue>` manually.
3. If the verdict is now `ready`, status transitions back to `To Do`, the comment is updated (idempotent via the HTML marker), and PPA picks the issue up on the next admission tick.

The operator only intervenes when:

- The verdict is a **false positive** (the issue is genuinely fine but the agent keeps blocking) — apply `dor-bypass` per the next subsection.
- The author has gone silent — escalation handles this; see "Escalation paths" below.
- Refusal cycles repeatedly on the same gates across many authors → the rubric needs tuning; surface in the weekly calibration review (the per-gate failure rate is the most operationally useful metric per RFC-0011 §8.2).

### Bypass mechanism (`dor-bypass` label)

**Symptoms (when to reach for the bypass).**

- A specific issue is genuinely actionable but the rubric keeps refusing it (e.g., the gate is mis-firing on a domain the agent doesn't understand, or the AC is binary-testable in context but doesn't surface that way to the gate).
- Urgent work is blocked behind a verdict the operator has confirmed is wrong.
- Round 3 escalation has reached the operator and the operator's judgment is "yes, admit this issue" (vs split / close / coach the author).

**Diagnosis (confirm before bypassing).**

1. Read the DoR comment. Confirm the agent's findings are wrong, not just inconvenient. The bypass exists for false positives; using it to skip valid clarifications defeats the gate.
2. Check the calibration log entry's `confidence` field. `low`-confidence verdicts should be bypassed only with explicit operator review (per RFC-0011 Q4 they auto-escalate via the same path as round 3).
3. Confirm the bypass actor is in the trusted-reviewer role per `.ai-sdlc/trusted-reviewers.yaml` (RFC-0009). Non-trusted actors applying the label are rejected by the bypass handler.

**Resolution (how to apply).**

1. Apply the `dor-bypass` label to the issue (GitHub) OR add the label to the backlog task frontmatter.
2. Provide a **reason** in the bypass comment — required, not optional. The bypass handler logs `{issueId, actor, reason, originalVerdict}` to the calibration log with `event: 'override'` (RFC-0011 §7.4).
3. The handler sets the verdict to `ready (manual override by <maintainer>)` and the issue advances to PPA scoring.

**What the bypass overrides.**

- The seven DoR rubric gates (Gates 1-7).
- The `Needs Clarification` status block on PPA admission and `/ai-sdlc execute`.

**What the bypass does NOT override.**

- Security gates (review-security, attestation verification, signing-key checks).
- Schema validation (`ArtifactSchemaInvalid`, `MigrationFailed` — these are downstream of admission and have nothing to do with DoR).
- The trusted-reviewer role check itself — the label is ignored when applied by a non-trusted actor.
- The audit trail. Every override is permanently logged to the calibration log and counted in per-maintainer override-rate metrics.

A high override rate per maintainer is a signal that either (a) the rubric is too aggressive and needs tuning, or (b) the maintainer is gaming the gate. Surface persistent override-rate spikes in the weekly calibration review.

### Escalation paths (3-round + low-confidence)

Two distinct triggers route to the same human triager:

1. **Round-cap escalation** — the issue has cycled through `Needs Clarification` 3 times without passing (configurable via `escalation.maxRoundsBeforeHumanTriage`, default 3, per RFC-0011 §6.3).
2. **Low-confidence escalation** — the agent's verdict carries `confidence: low`, regardless of round number (RFC-0011 Q4 — never auto-act on low confidence).

**Symptoms (what operator sees).**

- A Slack mention or GitHub team ping naming the configured triager (per `escalation.triager` in `.ai-sdlc/dor-config.yaml`; legacy `escalation.triageRouters[]` array also accepted for backward compat).
- The escalation comment summarizes the agent's findings across all rounds + the author's responses, framed as a soft handoff.
- The issue remains in `Needs Clarification` — escalation does NOT auto-admit. The triager owns the decision.

**Diagnosis (where to look).**

1. **The escalation comment** itself — names the round count, the per-round gate findings, and the agent's confidence on the most recent verdict.
2. **The full clarification thread.** Each round of agent comments + author responses is in the issue / task thread, marked by the `<!-- ai-sdlc:dor-round-N -->` round counter (per `comment-loop.ts` `dorRoundMarker`).
3. **Calibration log.** Filter for the issue ID to see the verdict trajectory across rounds; the override-or-not decision is the next entry the triager appends.

**Resolution (what the operator does at round 3 — soft handoff per RFC-0011 §6.3).**

The operator chooses one of four:

| Decision | Action | Logged as |
|---|---|---|
| **Approve manually** | Apply `dor-bypass` per the previous subsection with reason `escalation: false-positive after N rounds` | Override |
| **Close as not actionable** | Standard issue close + comment explaining why (no override flag — the gate was right) | Close (no override) |
| **Split** | File N replacement issues, each scoped narrowly enough to pass DoR independently. Close the original referencing the splits | Split (no override) |
| **Coach the author** | Direct message / pairing session — work with the author to revise the issue. Then `/ai-sdlc dor-recheck` once the body is updated | No log entry until next verdict |

**Tuning the trigger.** If round-3 escalations are firing too often:

- Tighten the rubric (the per-gate false-positive rate in the calibration log identifies the offending gate).
- Increase `escalation.maxRoundsBeforeHumanTriage` if the data shows authors typically resolve within 4-5 rounds (be cautious — the cap exists to surface genuinely-stuck issues, not to extend friction indefinitely).
- If low-confidence escalations dominate, the LLM evaluator (Stage B) prompt may need refinement; surface to the rubric maintainer.

**Cross-references.**

- Normative spec: [RFC-0011 §6.3 (escalation), §7.4 (bypass), §10 (evaluation modes)](../../spec/rfcs/RFC-0011-definition-of-ready-gate.md).
- Promotion procedure (warn-only → enforce): [`dor-promotion.md`](./dor-promotion.md).
- Trusted-reviewer role definition: [RFC-0009 — Trusted Reviewer Role](../../spec/rfcs/) (the `.ai-sdlc/trusted-reviewers.yaml` registry the bypass handler reads).

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

## Chaos test plan (Phase 5 hardening)

Per RFC §17 Phase 5, before promoting `AI_SDLC_PARALLELISM=experimental` to default-on, the dogfood pipeline MUST pass three chaos scenarios:

| Scenario | Setup | Verification |
|---|---|---|
| **Kill during plan** | Dispatch 3 parallel issues, send SIGKILL to one agent during the plan stage | Surviving agents continue; killed agent's worktree reclaimed within `branchTtl`; PR not created |
| **Kill during implement** | Same, kill during implement | Worktree reclaimed; partial commits NOT pushed; issue requeues with re-scoring per §9.4 |
| **Kill during validate** | Same, kill during validate | Implementation artifact preserved (already written); validation re-runs on requeue |

The chaos test is intended to be run by the operator before the feature-flag promotion, not as a CI gate. Document failures in the RFC's revision history (v21+) before promoting.

## Feature-flag promotion ritual (after 1-week soak)

1. Verify dogfood pipeline ran for ≥7 consecutive days with `AI_SDLC_PARALLELISM=experimental` and no `IndependenceViolated`/`MigrationDiverged`/stuck-heartbeat events that required operator intervention.
2. Run the chaos test plan above. All three scenarios MUST pass.
3. Update `orchestrator/src/runtime/parallelism-flag.ts` so `readParallelismMode()` defaults to `'on'` when the env var is unset.
4. Append a v21 entry to `spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md` revision history documenting the promotion date and the chaos-test results.
5. Update `CHANGELOG.md` with the user-visible behavior change ("parallelism is now on by default").
6. Announce in Slack with a link to the rollback procedure (set `AI_SDLC_PARALLELISM=off` to disable).

## Backlog-task auto-close on push (AISDLC-220)

The `scripts/check-task-moved.sh` pre-push hook (wired into `.husky/pre-push`
after the coverage gate and before the attestation-sign gate) handles task-file
lifecycle closes in the originating PR's own diff.

**How it works:**

When any commit in the push range has `(AISDLC-N)` or `(AISDLC-N.M)` in its
subject and `backlog/tasks/aisdlc-N - *.md` exists locally but
`backlog/completed/aisdlc-N - *.md` does not:

1. Invokes `node pipeline-cli/bin/cli-task-complete.mjs AISDLC-N` (the
   AISDLC-203 atomic helper) which flips the frontmatter `status` to `Done`
   and `git mv`s `backlog/tasks/<file>` → `backlog/completed/<file>`.
2. Stages the moved files (`git add -- backlog/tasks/ backlog/completed/`).
3. Commits all moves as a single `chore: auto-close AISDLC-N (AISDLC-220)`
   commit and exits 1 with a "re-run git push" message.
4. The next `git push` detects the file is already in `backlog/completed/` (or
   that HEAD is the auto-close chore) and exits 0 — the push proceeds normally.

**Why this shape:** the lifecycle close lands in the originating PR's own diff,
not a separate follow-up PR. No orphan chore PRs, no CI bypass, no operator
babysitting.

**Operator action when this misfires:**

- Commit subject doesn't match `(AISDLC-N)` → hook exits 0 silently. If you
  intended a backlog task to close, manually run
  `node pipeline-cli/bin/cli-task-complete.mjs AISDLC-N` and commit the result.
- `cli-task-complete.mjs` fails → hook exits 2 (push aborted). Check that
  `pnpm --filter @ai-sdlc/pipeline-cli build` has been run and the dist is
  up to date.
- Task file is already in `completed/` → hook detects it and skips (idempotent).
- Defer the auto-move for a specific push: `AI_SDLC_SKIP_TASK_MOVE=1 git push`.
  You are then responsible for moving the file manually before or after push.

## Related Documents

- [RFC-0010 — Parallel Execution and Worktree Pooling](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md) — full normative spec for everything this runbook references
- [RFC-0005 — Product Priority Algorithm](../../spec/rfcs/RFC-0005-product-priority-algorithm.md) — foundational PPA spec defining the seven dimensions, composite formula, and calibration loop the operator interprets but doesn't tune
- [RFC-0008 — PPA Triad Integration](../../spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md) — admission-time integration of RFC-0005 across Product / Design / Engineering pillars
- [RFC-0004 — Cost Governance and Attribution](../../spec/rfcs/RFC-0004-cost-governance-and-attribution.md) — `costBudget` semantics; see also [Tutorial: Cost Governance](../tutorials/cost-governance.md) and [API Reference: Cost Governance](../api-reference/cost.md)
- [RFC-0011 — Definition-of-Ready Gate](../../spec/rfcs/RFC-0011-definition-of-ready-gate.md) — normative spec for the seven-gate rubric, refusal flow (§6, §7.3), bypass (§7.4), escalation (§6.3), and `evaluationMode` lifecycle (§10) the "Definition-of-Ready (DoR) Gate" section above operationalizes
- [DoR promotion runbook](./dor-promotion.md) — warn-only → enforce promotion procedure (corpus-driven exit criterion + override path)
- [Project Slack Integration](../../../.claude/projects/-Users-dominique-Documents-dev-ai-sdlc/memory/project_slack_integration.md) — how digest entries reach the operator
