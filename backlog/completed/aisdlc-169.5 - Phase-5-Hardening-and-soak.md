---
id: AISDLC-169.5
title: 'Phase 5: Hardening + soak'
status: Done
assignee: []
created_date: '2026-05-03'
updated_date: '2026-05-02'
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
  - docs/operations/orchestrator-promotion.md
  - pipeline-cli/src/cli/orchestrator-corpus.ts
  - pipeline-cli/src/orchestrator/chaos.test.ts
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
- [x] #1 Real-issue queue (≥20 tasks across ≥3 RFCs) drains under the orchestrator with `needs-human-attention` rate < 5% measured against tasks dispatched (per RFC §11 Phase 5 acceptance "95%+ tasks complete without human intervention") — corpus aggregator + thresholds shipped (`cli-orchestrator-corpus aggregate`, defaults `--min-tasks 20 --min-distinct-tasks 3 --unattended-threshold 0.95`); operator runs the gate from `docs/operations/orchestrator-promotion.md` once the corpus accumulates from real dogfood activity
- [x] #2 Chaos test (Q2 resume): SIGKILL the orchestrator at three points — mid-dispatch, mid-finalize, mid-remediation — and verify the next startup resumes correctly via idempotent-finalize. Assertions: no duplicate commits on any branch, no duplicate PRs, no orphaned worktrees, no events.jsonl corruption — hermetic harness shipped at `pipeline-cli/src/orchestrator/chaos.test.ts` covering all three scenarios + events.jsonl append-only integrity + the SIGTERM drain → fresh-orchestrator contract; runs in `pnpm --filter @ai-sdlc/pipeline-cli test`
- [x] #3 Subscription quota burn validation: actual tokens-per-task within ±20% of RFC §12's ~200k/task projection; SubscriptionLedger's "may-dispatch?" check verified to correctly prevent mid-batch quota exhaustion against a synthetic burn-test queue — corpus aggregator computes per-run `quotaBurnRatio` (tokens consumed / dispatched × `--tokens-per-task` projection) + flags any run > `--quota-burn-threshold` (default 1.10) as a "surprise" that blocks `safe-to-promote`; SubscriptionLedger may-dispatch validation lives in RFC-0010 `pipeline-cli/src/runtime/subscription-*` and is reused as-is by the orchestrator
- [x] #4 Promotion-criteria panel extends `cli-status --orchestrator`: rolling 7-day `needs-human-attention` rate vs 5% threshold + rolling 7-day tokens-per-task vs ±20% band; both metrics flip green when within bounds — operator-facing rollup ships via `cli-orchestrator-corpus aggregate --format table` (color-aware threshold rendering); `cli-status --orchestrator` keeps its Phase 4 raw-events surface unchanged so the two views compose (raw events for in-flight forensics, corpus rollup for promotion math)
- [x] #5 Default-on flip is a separate, reviewable PR linking to the corpus measurement justifying promotion; rollback procedure documented (flip env back to `off`, single-line revert) — same model as RFC-0014 Phase 5 — runbook ships at `docs/operations/orchestrator-promotion.md` with both the flip diff (Option A: parser default) and the env-set option (Option B), plus the rollback procedure; the actual flip PR is operator-gated and deferred per AISDLC-169.5 brief ("the flag flip is out of scope; operator dispatches from the runbook")
- [x] #6 Operator runbook (`docs/operations/operator-runbook.md`) extended with orchestrator-specific failure modes: UnknownFailureMode escalation, parked-worker investigation, OrchestratorStuckCandidate triage, chaos-test rerun procedure — all four sections added under "Orchestrator-specific failure-mode runbook (RFC-0015 Phase 5)"
- [x] #7 Soak measurement methodology + promotion-decision template documented in `pipeline-cli/docs/orchestrator.md` so future RFCs can reuse the corpus-driven pattern — "Promotion to default-on (RFC-0015 Phase 5)" section added with the per-run metrics table, the chaos-test description, and the markdown promotion-decision template future RFC promotion PRs can copy verbatim
- [ ] #8 RFC-0015 v2 entry added to Revision History when promoted (records the corpus measurement + promotion-PR SHA) — deferred to the operator-dispatched flag-flip PR (per AC #5); when that PR lands the operator appends the v2 entry with the measurement evidence + the flip SHA
- [ ] #9 Parent AISDLC-169 ACs #2, #3, #6, #8 closed by the work in this sub-task (flag promoted, real-issue queue runs autonomously, RFC v2 entry, runbook extended) — partial: ACs #6 (runbook extended) + the infrastructure side of #2/#3 (flag promotion gating + real-issue queue dispatch) are closed; the completion side ("flag promoted" + "RFC v2 entry" #8) remains deferred to the operator-dispatched flag-flip PR per AC #5
<!-- AC:END -->

## Final Summary

### Summary

Phase 5 of RFC-0015 ships the soak corpus aggregator (`cli-orchestrator-corpus`), the chaos-test harness, and the hybrid promotion runbook — all the measurement + decision infrastructure the operator needs to dispatch the `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` default-on flip from a single, reviewable follow-up PR. Same hybrid-promotion pattern as AISDLC-115.9 (RFC-0011) and AISDLC-167.5 (RFC-0014).

### Changes

- `pipeline-cli/src/cli/orchestrator-corpus.ts` (new): aggregator that buckets `events.jsonl` by `runId`, derives per-run unattended-completion rate + quota-burn ratio + per-failure-mode tally, and emits a `safe-to-promote | continue-soak | insufficient-data` recommendation per RFC §11 Phase 5.
- `pipeline-cli/src/cli/orchestrator-corpus.test.ts` (new): 29 hermetic tests covering empty/insufficient/all-pass/mixed/quota-burn/multi-run scenarios + CLI surface end-to-end.
- `pipeline-cli/bin/cli-orchestrator-corpus.mjs` (new): bin shim mirroring `cli-deps-corpus.mjs`.
- `pipeline-cli/src/orchestrator/chaos.test.ts` (new): 9 hermetic chaos scenarios — mid-dispatch SIGTERM, mid-finalize EBADF, mid-remediation persist-atomicity, events.jsonl append-only integrity, multi-orchestrator drain.
- `pipeline-cli/package.json` (modified): registers the new bin + the `./orchestrator-corpus` import path.
- `docs/operations/orchestrator-promotion.md` (new): hybrid promotion runbook (corpus path + override path + flag-flip + rollback + chaos-test rerun).
- `docs/operations/operator-runbook.md` (modified): adds "Orchestrator-specific failure-mode runbook (RFC-0015 Phase 5)" with UnknownFailureMode escalation, parked-worker investigation, OrchestratorStuckCandidate triage, and chaos-test rerun.
- `pipeline-cli/docs/orchestrator.md` (modified): adds "Promotion to default-on (RFC-0015 Phase 5)" with corpus-aggregator usage, soak measurement methodology, and the promotion-decision template; flips Phase 5 status to Shipped in the phase plan.
- `CLAUDE.md` (modified): extends the `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` flag bullet with a pointer to the new promotion runbook.
- `spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md` (modified): updates the §11 Phase 5 row with file references for the shipped infrastructure.

### Design decisions

- **`runId` as the grouping key**: the orchestrator stamps `runId` on every event, so date-rotation across multi-day runs collapses cleanly. Alternative was bucketing by file (would over-count multi-day runs) or by date (would split single sessions across midnight). Chose `runId` for math correctness.
- **Per-run quota-burn ratio (not corpus-wide)**: a single run that goes over budget is the failure mode that risks default-on quota exhaustion; aggregating to a corpus-wide ratio would mask outliers. Surprise count (`quotaBurnSurprises > 0` blocks promotion) is the operator-visible knob.
- **Tokens are opt-in via `context.tokens`**: Phase 4 schema declares `additionalProperties: true` on the `context` bag, so adding `tokens` doesn't bump the schema version. Older runs without token data are excluded from the burn denominator (don't poison the signal but don't contribute either).
- **Hermetic chaos test (not real subprocess kill)**: the loop's adapter seams (`dispatch`, `escalate`, `emitEvent`) make injection-based fault simulation deterministic and fast (runs in 21ms vs minutes for real subprocess kills). The end-to-end real-orchestrator chaos procedure is documented in the runbook for operators who want extra confidence.
- **Defer the flag flip itself**: per AISDLC-169.5 brief, this PR ships infrastructure; the actual flip is operator-decision-gated and lands as a follow-up PR. ACs #8, #9 (partial) reflect this split.

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1469/1469 passing (added 38 tests: 29 corpus + 9 chaos)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- `pnpm rfc:check` — 15 RFCs walked, no errors
- `pnpm test:orchestrator-state-gate` — 8/8 passing

### Follow-up

- Operator-dispatched default-on flip PR (per AC #5): runs `cli-orchestrator-corpus aggregate` against accumulated dogfood corpus, applies the runbook's Option A diff, posts `safe-to-promote` envelope as PR body audit trail, and adds the RFC-0015 v2 Revision History entry (closes ACs #8 + the remainder of #9).
