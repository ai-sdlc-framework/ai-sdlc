# AI-SDLC Operator Runbook

**Audience:** AI-SDLC Pipeline Operator — the human responsible for running, tuning, and triaging an AI-SDLC pipeline.
**Status:** Draft v1
**Companion to:** [RFC-0010 Parallel Execution and Worktree Pooling](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md)

---

## What this role is

The Pipeline Operator owns the **policy, posture, and triage layer** of an AI-SDLC pipeline. Three engineering capabilities had to land before this role could exist coherently:

- **PPA scoring** (RFC-0008) lifted prioritization out of human hands.
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

---

## Skills and Onboarding

### Required

- YAML config + JSON-schema literacy
- Read [PPA scoring](../../spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md) at a conceptual level
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

## Related Documents

- [RFC-0010 — Parallel Execution and Worktree Pooling](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md) — full normative spec for everything this runbook references
- [RFC-0008 — PPA Triad Integration](../../spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md) — scoring model the operator interprets but doesn't tune
- [RFC-0004 — Cost Governance and Attribution](../../spec/rfcs/RFC-0004-cost-governance-and-attribution.md) — `costBudget` semantics
- [Project Slack Integration](../../../.claude/projects/-Users-dominique-Documents-dev-ai-sdlc/memory/project_slack_integration.md) — how digest entries reach the operator
