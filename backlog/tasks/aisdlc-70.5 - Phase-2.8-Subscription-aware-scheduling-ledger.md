---
id: AISDLC-70.5
title: 'Phase 2.8: Subscription-aware scheduling + ledger'
status: To Do
assignee: []
created_date: '2026-04-26 19:46'
labels:
  - rfc-0010
  - phase-2.8
  - scheduling
  - cost
milestone: m-2
dependencies:
  - AISDLC-70.4
references:
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#14-subscription-aware-scheduling
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#11-per-stage-model-routing
  - orchestrator/src/cost-governance.ts
  - spec/examples/subscription-plans/
parent_task_id: AISDLC-70
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SubscriptionLedger + scheduler (RFC §14) for window-utility optimization. The largest single phase; folds in Q9–Q13 resolutions plus the §14.10 cost model clarification. Sequenced after 70.4 because the ledger keys on getAccountId() from the harness adapter framework (§14.12). Estimated 2 weeks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 SubscriptionLedger interface + persistent state implemented at orchestrator/src/scheduling/{ledger.ts, types.ts} per RFC §14.2; persisted to $ARTIFACTS_DIR/_ledger/<harness>-<accountIdShort>-<tenant>.json
- [ ] #2 SubscriptionPlan resource validation; ship reference plans for claude-code-pro, claude-code-max-5x, claude-code-max-20x, codex-plus, codex-pro, pay-per-token at spec/examples/subscription-plans/ (RFC §6.6)
- [ ] #3 Schema additions: Stage.schedule, Stage.estimatedTokens (with optional frozen), Pipeline.spec.{tenant, tenantQuotaShare, accountId, offPeakMaxWait, artifactSchemaVersion} per RFC §6.3, §6.5
- [ ] #4 quotaSource field on SubscriptionPlan with self-tracked (default), authoritative-api, authoritative-with-fallback modes; LedgerReconciliation event on first switch from self-tracked to authoritative per RFC §14.11 (Q9)
- [ ] #5 Off-peak schedule evaluation with timezone-aware time-range matching; offPeak.lastVerified freshness warnings (advisory at >30d, error at >90d) per RFC §14.5 (Q10)
- [ ] #6 Schedule-aware dispatcher per RFC §14.3 with four modes (now, off-peak, quota-permitting, defer-if-low-priority)
- [ ] #7 HarnessAdapter.getAccountId() implemented for shipped adapters; ledger keying (harness, accountId, tenant) per RFC §14.12 (Q12)
- [ ] #8 Tenant overlay validation: sum of tenantQuotaShare per (harness, accountId) MUST equal 1.0; orchestrator startup fails with TenantShareInvalid otherwise (Q12)
- [ ] #9 LedgerPooled event when two pipelines share a ledger; LedgerKeyAmbiguous warning when accountId can't be derived (Q12)
- [ ] #10 Burn-down report emitter every 5 min (RFC §14.4); fields per §14.10 (subscriptionTokensConsumed, dollarsSpent, shadowCostUsd, subscriptionUtilizationFraction)
- [ ] #11 Rolling per-stage token-estimate calibration at $ARTIFACTS_DIR/_ledger/stage-estimates.json; cold-start default {50000, 10000} with MissingEstimate warning; EstimateBootstrapped event after first run; frozen: true opt-out per RFC §14.6 (Q11)
- [ ] #12 Reference dogfood pipeline ships with estimatedTokens populated for all 10 canonical stages per RFC §14.6.4 table (Q11)
- [ ] #13 TierAnalysis weekly aggregation at $ARTIFACTS_DIR/_ledger/tier-analysis.jsonl; Slack digest entry only when recommendedPlan != currentPlan AND confidence != 'low'; cli-tier-recommendation [--last N --details --all-tenants] command per RFC §14.13 (Q13)
- [ ] #14 Three-axis cost model enforcement per RFC §11.5: costBudget (RFC-0004) shared, windowQuotaTokens per-harness, Stage.maxBudgetUsd per-stage; AdmissionDenied event names blocking cap (Q2)
- [ ] #15 cli-status --subscriptions view groups by (harness, accountId), shows tenant shares, freshness color-coded
- [ ] #16 Integration test: 20-issue queue with mixed PPA scores + schedule hints, fixture clock advancing through peak/off-peak, verify off-peak deferrals + correct burn-down recommendations
- [ ] #17 New code reaches 80%+ patch coverage
<!-- AC:END -->
