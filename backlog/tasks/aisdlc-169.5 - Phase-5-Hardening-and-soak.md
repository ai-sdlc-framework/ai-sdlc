---
id: AISDLC-169.5
title: 'Phase 5: Hardening + soak'
status: To Do
assignee: []
created_date: '2026-05-03'
labels:
  - rfc-0015
  - phase-5
  - soak
  - hardening
  - flag-promotion
milestone: m-3
dependencies:
  - AISDLC-169.4
parent_task_id: AISDLC-169
references:
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - docs/operations/operator-runbook.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 of RFC-0015. Run a real-issue queue (≥20 tasks across ≥3 RFCs) under the orchestrator, execute a chaos test (kill orchestrator mid-tick, verify resume per Q2 idempotency), validate subscription quota burn against RFC-0010 §14 ledger projections, and promote `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` from `experimental` → default-on when corpus criteria are met. Per RFC §11 Phase 5.

## Soak policy — corpus-driven, NOT calendar-driven

Per maintainer directive (consistent with RFC-0014 Phase 5): this phase ships when:

- **95%+ of tasks complete without human intervention** on the real-issue queue (`needs-human-attention` rate < 5% measured against tasks dispatched), AND
- **No quota-burn surprise** vs RFC-0010 §14 SubscriptionLedger projections (actual tokens-per-task within ±20% of §12 cost model).

Whichever comes first. Calendar duration is a side-effect, not a gate.

## Components

- **Real-issue queue**: ≥20 tasks across ≥3 RFCs from the live backlog. Corpus selection biased toward variety — mix of small/medium/large tasks, mix of failure-mode triggers (verification fail, push race, rebase conflict) so the playbook gets exercised.
- **Chaos test (Q2 resume)**: scripted SIGKILL of the orchestrator mid-tick at three distinct points — (a) mid-dispatch (worktree allocated, dev not yet spawned), (b) mid-finalize (commit pushed, PR not yet opened), (c) mid-remediation (handler running, retry not yet committed). Verify the next orchestrator startup resumes correctly via the Q2 idempotent-finalize design — no duplicate commits, no duplicate PRs, no orphaned worktrees.
- **Subscription quota burn validation**: instrument the orchestrator to report actual tokens-per-task and compare against RFC §12's cost model (~200k tokens/task; 12 tasks/hour × 5h × 200k = 12M tokens/window). Validate the SubscriptionLedger's "may-dispatch?" check is correctly preventing mid-batch quota exhaustion.
- **Promotion-criteria dashboard**: extends the `cli-status --orchestrator` view (Phase 4) with "promotion criteria" panel: rolling 7-day `needs-human-attention` rate vs 5% threshold; rolling 7-day tokens-per-task vs ±20% band; both metrics flip green when within bounds.
- **Default-on flip PR**: separate, reviewable PR that links to the corpus measurement justifying promotion. Rollback procedure documented (flip env back to `off`, single-line revert). Same model as RFC-0014 Phase 5 / RFC-0011 enforce-mode promotion.
- **Operator runbook extension**: `docs/operations/operator-runbook.md` extended with orchestrator-specific failure modes (UnknownFailureMode escalation, parked-worker investigation, OrchestratorStuckCandidate triage, chaos-test rerun procedure).

## Promotion mechanics

- Default `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=off`; opt-in `experimental` during soak.
- Operators run the orchestrator opt-in for at least one full corpus window (≥20 tasks) before promotion proposal.
- When promotion criteria met, flip default to `on` in a single, reviewable PR. Document the corpus measurement (`needs-human-attention` rate + tokens-per-task burn) that justified promotion.
- Hybrid corpus-OR-operator-override promotion model available (matches RFC-0011 / AISDLC-161 / RFC-0014 pattern) if the corpus is too small for statistical confidence within reasonable wall-clock.

## Documentation deliverables

- `docs/operations/operator-runbook.md` — extended with the 4 orchestrator-specific failure modes above plus the chaos-test rerun procedure.
- `pipeline-cli/docs/orchestrator.md` — soak measurement methodology + promotion-decision template so future RFCs can reuse the corpus-driven pattern.
- RFC-0015 Revision History — v2 entry recording the corpus measurement that justified promotion + the promotion-PR SHA.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Real-issue queue (≥20 tasks across ≥3 RFCs) drains under the orchestrator with `needs-human-attention` rate < 5% measured against tasks dispatched (per RFC §11 Phase 5 acceptance "95%+ tasks complete without human intervention")
- [ ] #2 Chaos test (Q2 resume): SIGKILL the orchestrator at three points — mid-dispatch, mid-finalize, mid-remediation — and verify the next startup resumes correctly via idempotent-finalize. Assertions: no duplicate commits on any branch, no duplicate PRs, no orphaned worktrees, no events.jsonl corruption
- [ ] #3 Subscription quota burn validation: actual tokens-per-task within ±20% of RFC §12's ~200k/task projection; SubscriptionLedger's "may-dispatch?" check verified to correctly prevent mid-batch quota exhaustion against a synthetic burn-test queue
- [ ] #4 Promotion-criteria panel extends `cli-status --orchestrator`: rolling 7-day `needs-human-attention` rate vs 5% threshold + rolling 7-day tokens-per-task vs ±20% band; both metrics flip green when within bounds
- [ ] #5 Default-on flip is a separate, reviewable PR linking to the corpus measurement justifying promotion; rollback procedure documented (flip env back to `off`, single-line revert) — same model as RFC-0014 Phase 5
- [ ] #6 Operator runbook (`docs/operations/operator-runbook.md`) extended with orchestrator-specific failure modes: UnknownFailureMode escalation, parked-worker investigation, OrchestratorStuckCandidate triage, chaos-test rerun procedure
- [ ] #7 Soak measurement methodology + promotion-decision template documented in `pipeline-cli/docs/orchestrator.md` so future RFCs can reuse the corpus-driven pattern
- [ ] #8 RFC-0015 v2 entry added to Revision History when promoted (records the corpus measurement + promotion-PR SHA)
- [ ] #9 Parent AISDLC-169 ACs #2, #3, #6, #8 closed by the work in this sub-task (flag promoted, real-issue queue runs autonomously, RFC v2 entry, runbook extended)
<!-- AC:END -->
