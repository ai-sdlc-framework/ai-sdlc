---
id: RFC-0062
title: Algorithm improvement directions, wire what exists, then calibrate, then learn
status: Draft
lifecycle: Draft
author: 'Dominique Legault'
created: 2026-11-06
updated: 2026-11-06
targetSpecVersion: v1alpha1
requires: []
assumes: [RFC-0005, RFC-0008, RFC-0010, RFC-0014, RFC-0016, RFC-0019, RFC-0050, RFC-0051, RFC-0056, RFC-0060, RFC-0061]
runtimeEvidence: []
requiresDocs: []
---

# RFC-0062: Algorithm improvement directions, wire what exists, then calibrate, then learn

**Status:** Draft
**Lifecycle:** Draft
**Author:** Dominique Legault
**Created:** 2026-11-06
**Updated:** 2026-11-06
**Target Spec Version:** v1alpha1

> Draft. This RFC turns the external review "AI-SDLC Algorithm Improvement Directions"
> (2026-11-06) into a proposal. Every claim the review made about the code was checked
> against `main` at `e9da7a01` on 2026-11-06 by four read-only code audits; the "Corrections
> to the source review" section records where the review was wrong or incomplete, and the
> proposal below is built on the corrected picture. The six Open Questions are the review's
> own six, restated with the evidence the audits found. None is resolved here; each is walked
> with the operator through the decision rubric, one at a time.

## Summary

The review's thesis survives verification: the framework's algorithms are structurally
reasonable, but almost every numeric decision is a hand-set constant, and the richer engines
that already exist (three-layer Soul Alignment, the SubscriptionLedger, the Stage B
estimation ensemble, the calibration coefficient, SA drift detection) are exported but not on
any live call path. The audits also found that the live dispatch path is not the one the
review examined, that the repository holds zero labelled priority outcomes, and that review
attestations have been unsigned since RFC-0061 landed. Those three facts reshape the plan.

This RFC proposes three phases, each shippable on its own and each behind a shadow-mode
pattern the repository already uses in three places. Phase 1 wires engines that exist and
removes constant or wrong scores. Phase 2 adds the statistical layer (intervals, proper
scoring rules, ordinal models, sequential tests) that the scheduler, the router and the
priority composite all depend on. Phase 3 introduces learned components (a contextual
bandit router, fitted PPA weights, author reputation) and starts only once Phase 2 has
produced enough labelled outcomes. Attestation hardening is split: the canonical-JSON and
shared-schema fix is Phase 1; a signed, Merkle-structured record is a separate decision
because RFC-0061 deliberately chose an unsigned, error-resistant verdict record.

## Motivation

The review audited the `main` branch on 2026-11-06 and listed twenty algorithmic surfaces
with the method in use and its sharpest limitation. The four code audits confirmed the
pattern behind the list and sharpened it:

- **Engines exist but are not wired.** `scoreSoulAlignment` (`orchestrator/src/sa-scoring/index.ts:92`),
  `runWorkerPool` and `evaluateSchedule` (`orchestrator/src/dispatch/worker-pool.ts:46`,
  `orchestrator/src/scheduling/schedule-decision.ts:41`), `buildCategoryCoefficients`
  (`orchestrator/src/calibration.ts`), `aggregateStageBEnsemble`
  (`pipeline-cli/src/estimation/stage-b.ts:421-443`), `detectSoulDrift`
  (`orchestrator/src/sa-scoring/drift-monitor.ts`), `review-meta.ts` (inactive because no
  caller passes `metaReviewLLM`), `detectFlooding` (`significance.ts`) and `reclaimStale`
  (`worktree-pool.ts`) have no production caller beyond barrel exports.
- **The live scheduler is simpler than the one documented.** The hierarchy claim order
  (`pipeline-cli/src/dispatch/board.ts:1055-1060`, comparator `:415-420`) sorts by `wave`, then
  a three-level rank (`PRIORITY_RANK = { high: 1, medium: 2, low: 3 }`,
  `pipeline-cli/src/hierarchy/brief.ts:81`), then manifest mtime. `critical` is absent from the
  rank, so a critical task sorts after low. Effective priority, critical-path length and
  `dispatchedAt` are not consulted. RFC-0014's effective priority applies only to the legacy
  `pipeline-cli/src/orchestrator/loop.ts` path, which nothing in `hierarchy/` or `dispatch/`
  imports.
- **Constants stand in for estimates.** PPA weights (`orchestrator/src/priority.ts:37,98,136`),
  the calibration clamp (`calibration.ts:9,37-41`, `minSampleSize` default 1), the token EWMA
  (window 20, decay 0.85, `scheduling/calibration.ts:180-196`), the routing downshift rule
  (`DEFAULT_MIN_TASKS = 30`, `DEFAULT_MARGIN_POINTS = 5`, `routing/evaluate-cell.ts:19-23`),
  the review thresholds (0.8 and 0.5, `review-meta.ts:15`, `runners/review-agent.ts:40`) and the
  admission thresholds (`minimumScore 0.05`, `minimumConfidence 0.2`, `.ai-sdlc/pipeline.yaml:48-49`)
  are all set by hand, with no interval and no fitting procedure.
- **There is no training data yet.** `did_feedback_events`, `priority_calibration`,
  `did_scoring_events`, `sa_phase_weights` and `routing_history` in `.ai-sdlc/state.db` have zero
  rows. `artifacts/_dor/calibration.jsonl` (105 rows) is Definition-of-Ready data whose
  `outcome` equals the gate's own verdict on every row, so it is not an independent label. The
  classifier calibration file (284 rows) has `humanOverrideAfterMerge: null` throughout. What
  does exist is routing evidence: 1,637 assignment rows (all `taskClass=uncategorized`) and
  1,923 review-ledger records (1,862 approved, 61 rejected) over 264 tasks.
- **The trust chain changed under the review.** After RFC-0061 (AISDLC-1173, PR #2407) the
  review attestation is an unsigned verdict record in `refs/ai-sdlc/verdicts/<headSha>`,
  committed under a fixed identity and protected only by ref-write control and a hook fence.
  Ed25519 DSSE survives only for the MCP release tarball (`scripts/sign-mcp-tarball.mjs`).
  The audit hash chains (TypeScript, Go and a third variant in Python) still differ in field
  set, genesis value and timestamp precision, and no SDK verifies another SDK's chain.

The cost of leaving this as it is: dispatch order is decided by file mtime more often than by
priority; admission scores are nearly constant per label, so the Decision Engine ranks by
author trust; routing cannot downshift safely because the margin rule has no error control;
and the audit chain promise on the website ("hash-chained, verifiable") holds only within one
SDK.

## Goals

- Put the engines that already exist on the live path, behind shadow mode, before writing
  new theory.
- Replace each hand-set constant with an estimate that carries an interval, fitted from
  outcomes the pipeline records, with a stated fallback when data is thin.
- Make dispatch order a function of priority, expected cost and critical path, with a
  starvation bound, on the path the hierarchy actually uses.
- Give model routing an error-controlled downshift rule and, later, an online policy.
- Make the audit chain one schema with one canonical byte form across the TypeScript, Go
  and Python SDKs, with a conformance fixture that proves it.
- Decide explicitly, through the rubric, what a signed or Merkle-structured verdict record
  would add on top of RFC-0061's error-resistant claim, rather than reintroducing it by
  default.

## Non-Goals

- Reopening RFC-0061's trust claim. That RFC chose an unsigned, error-resistant verdict
  record with a named upgrade trigger (a forged or out-of-pipeline verdict). This RFC does not
  change that decision; OQ-4 only decides whether canonicalisation is a Phase 1 blocker.
- Implementing RFC-0060 (multi-machine scheduling). Resource-aware dispatch here is
  single-host; OQ-5 names which RFC-0060 questions it depends on.
- An optimal scheduler. Precedence-constrained scheduling with resource caps is NP-hard;
  the goal is a list-scheduling heuristic with the right priority function.
- Post-quantum signatures now. Crypto agility (an algorithm identifier per envelope, a
  dual-signing flag) is proposed; switching schemes is not.
- Changing the PPA factor structure (RFC-0005) or the RFC-0008 phase plan. Weights,
  inputs and thresholds change; the factors stay.

## Proposal

### Phase 1, wire what exists

1. **Dispatch order on the live path.** `orderEligible` in `pipeline-cli/src/dispatch/board.ts`
   ranks by `wave`, then a continuous key, then id, where the continuous key is the RFC-0014
   effective priority computed by `pipeline-cli/src/deps/effective-priority.ts` (already
   memoised and already carrying the 1 to 4 bucket mapping with `critical = 4`), then
   critical-path length, with manifest mtime demoted to the last tie-break. `PRIORITY_RANK`
   gains `critical`. The `max` versus `+` conflict inside RFC-0014 (§5.2 says `+`, §5.3 and Q1
   say `max`, code uses `max`) is settled by OQ-2, not here; until then the code's `max` stays.
2. **Soul Alignment from the three-layer engine.** `admission-composite.ts` consumes
   `scoreSoulAlignment` through the existing `soulAlignmentOverride` slot, in phase 2a shadow
   mode first (weights (0,0), one `did_scoring_events` row per dimension, label fallback
   applies), then phase 2b once `validatePhase2bExemplars` passes. The label tables in
   `admission-score.ts:253-263` and `backlog-adapter.ts:432-474` remain the fallback.
3. **One DAG engine.** `orchestrator/src/task-decomposer.ts` (`topologicalSort` without cycle
   detection, `validateTaskGraph` at about V×(V+E), `getExecutionLayers` silently dropping
   nodes on a cycle) delegates to `pipeline-cli/src/deps/dependency-graph.ts`, which already
   has iterative cycle detection with path reporting. The eight walks the audit counted
   shrink to that module plus the RFC-0056 Kahn sort, which already feeds its edges into it.
4. **One audit record, one byte form.** A shared audit-entry schema (`spec/spec.md#audit-entry`,
   which `spec/adapters.md:225` already links to and which does not exist) with RFC 8785 (JCS)
   canonicalisation before hashing in `reference/src/audit/logger.ts`,
   `sdk-go/audit/logger.go` and `sdk-python/src/ai_sdlc/audit/logger.py`; one genesis value;
   RFC 3339 timestamps at one precision; a cross-SDK fixture under `conformance/` that each SDK
   must verify. Whether this blocks Phase 1 or waits is OQ-4.
5. **Small corrections.** `orchestrator/src/provenance.ts:29-31` stores the full prompt digest
   (the 16-hex form stays as a display and grep key, since that is all it is used for);
   `validate-agent-output.ts` diffs against the merge base instead of `HEAD~1`; the
   `ceiling: 40` worktree alarm becomes a cap with eviction of the oldest open-PR worktree by
   branch-head age.

### Phase 2, statistical layer

| Signal | Today | Proposed |
| --- | --- | --- |
| Cκ (`orchestrator/src/calibration.ts`) | `clamp(1 + 0.3·(accepts−escalates)/total, 0.7, 1.3)`, `minSampleSize` 1, `override` events counted but unused, nothing feeds it | Beta-binomial shrinkage toward the category prior; publish the 90% interval; wire the feedback events that exist in the schema |
| Token estimates (`scheduling/calibration.ts`) | EWMA, window 20, decay 0.85; ±50% samples raise an event but are averaged in | Log-normal model on the cost ratio; median plus P90; Huber-weighted update |
| T-shirt bias (`pipeline-cli/src/estimation/bias.ts`) | Arithmetic mean of ordinal bucket misses; Stage B ensemble median exported but `cli estimate` runs Stage A only | Proportional-odds model; probability mass per bucket; decide whether Stage B is run or deleted (dark-code gate) |
| Review confidence (`review-meta.ts`, `runners/review-agent.ts`) | Hand-set 0.5 and 0.8 cut-offs; meta-review inactive (no caller passes `metaReviewLLM`) | Isotonic recalibration from reported confidence to acceptance per finding category; Brier score per gate and per reviewer role in the compliance surface |
| Routing downshift (`routing/evaluate-cell.ts`) | Point-rate gap, n ≥ 30, margin 5 points, no interval | Always-valid non-inferiority test (mixture SPRT or confidence sequence) with a stated false-downshift rate |
| SA drift (`sa-scoring/drift-monitor.ts`) | Mean < 0.4 or stddev > 0.15 for 3 windows, no caller | CUSUM or Page-Hinkley on the shadow-mode scores, tuned false-alarm rate, called from the tick |
| Flood detection (`significance.ts`) | Per-source z > 3.0, Gaussian on counts, hourly count against daily baseline, no caller | Poisson or negative-binomial test on matched windows |

Calibration lands first because the scheduler's cost weights, the router's price term and
PPA's Execution Reality factor all read it.

### Phase 3, learned components

1. **Contextual Thompson-sampling router.** A Beta posterior per (role, taskClass, model) on
   first-pass approval, with context from t-shirt size, code area and the security-path flag;
   pick by sampled quality minus λ × price, seeded by the existing sha256 draw for
   reproducibility; discount the posterior on `modelVersion` change. The scorecard join in
   `usage/scorecard.ts` (usage ledger, reviews ledger, assignment log) already produces the
   outcome rows; `taskClass` must stop being `uncategorized` first.
2. **Log-space PPA with fitted weights.** `log PPA = Σ wᵢ log xᵢ` with a floor per factor;
   weights fitted by logistic regression against accept/escalate/dismiss outcomes; admission
   thresholds set from the empirical distribution and refitted monthly. The admission
   composite today (`SA × DP_adj × ER × er5 × (1 + HC)`, Mφ = 1, Eτ = 0, Cκ absent) and the
   full PPA formula in `priority.ts` are reconciled as part of this item.
3. **Author reputation.** A per-author Beta posterior on acceptance replaces the
   `author_association` floors in `admission-score.ts:263-288`; Backlog items, which the adapter
   labels `OWNER` or `MEMBER` today, start at the prior like everyone else.
4. **AST-based classification and semantic diff gates.** TypeScript compiler API or
   tree-sitter for `code-area-classifier.ts` and `soul-slug-ast-scan-rule.ts`; new gates for
   public-API change, new dependency, complexity delta and test-to-code ratio on the diff.
5. **Signal analysis.** HDBSCAN or HNSW with average linkage once an RFC-0019 adapter is
   wired; finish tessellation drift Rule 2 (`inter-soul-embedding-distance-rule.ts` returns `[]`)
   with the `fail-loud` stale-vector policy already pinned by the consumer.
6. **Crypto agility.** An algorithm identifier in every envelope that is still signed (today
   only the MCP tarball) and a dual-signing flag (Ed25519 + ML-DSA-65) behind it. What, if
   anything, is signed in the verdict record is a separate rubric item and is not assumed.

**Sequencing gate.** Phase 3 routing and PPA fitting do not start until Phase 2 has
produced at least 200 labelled outcomes per cell. Today the count is zero in every PPA
category (OQ-3), so Phase 3 has no start date yet.

**Shadow mode.** Every Phase 2 and Phase 3 item ships behind one of the patterns already in
the repository: `shadowMode` in `orchestrator/src/sa-scoring/composite.ts:239`,
`runShadowEval` and `shouldPromoteCandidate` in `pipeline-cli/src/dor/shadow-mode.ts`, or the
`off | shadow | enforce` judgment mode of RFC-0049. Compute, log, compare, then flip.

## Design Details

### Dispatch ranking

```
rank(T) = ( wave(T),
            effectivePriority(T),              # RFC-0014, 1..4 with critical = 4
            criticalPathCost(T),                # Σ ĉ(u) over the longest path T → sink
            ageBonus(T),                        # clamp((ageDays − 30) / 180, 0, 1)
            id(T) )
```

`ĉ(u)` is the calibrated expected cost from Phase 2; before calibration has data it is the
t-shirt midpoint, and before an estimate exists it is 1, which reduces the term to
critical-path length in tasks. The age bonus bounds starvation of short leaf tasks behind a
long chain; it reuses the drift formula in `admission-score.ts:293`, whose sign differs
between the two paths that use it today (see corrections, item 6).

Resource-aware packing (concurrency slot, worktree, quota headroom in the current
subscription window) is a greedy first-fit-decreasing pass on `ĉ` over the ranked list,
bounded by the `EXECUTOR CAP` the pacer already computes. It depends on cost estimates
being roughly right, which is why it sits after Phase 2.

### Audit entry schema (Phase 1, item 4)

```json
{
  "$id": "https://ai-sdlc.io/schemas/v1alpha1/audit-entry.json",
  "type": "object",
  "required": ["id", "timestamp", "actor", "action", "resource", "outcome", "previousHash", "hash"],
  "properties": {
    "id": { "type": "string" },
    "timestamp": { "type": "string", "format": "date-time", "description": "RFC 3339, UTC, millisecond precision" },
    "actor": { "type": "string" },
    "action": { "type": "string" },
    "resource": { "type": "object", "required": ["kind", "name"], "properties": { "kind": { "type": "string" }, "name": { "type": "string" } } },
    "policy": { "type": "string" },
    "outcome": { "type": "string", "enum": ["allowed", "denied", "overridden"] },
    "details": { "type": "object" },
    "previousHash": { "type": "string", "description": "hex sha256 of the previous entry; the fixed string 'genesis' for the first" },
    "hash": { "type": "string", "description": "hex sha256 of the RFC 8785 canonical form of every field except hash" }
  }
}
```

The hash input is the JCS serialisation of the entry without `hash`; HTML escaping, key
order and whitespace are therefore defined by RFC 8785, not by the language runtime. A
`signature` block, if any SDK adds one, is outside the hashed form and carries an
algorithm identifier.

### Routing downshift test (Phase 2)

For a candidate `c` against the incumbent `i` in one cell, with first-pass approval rates
`p_c` and `p_i` and a non-inferiority margin `δ` (the current 5 points becomes a parameter):
maintain an always-valid confidence sequence for `p_i − p_c` and downshift when its upper
bound falls below `δ`; the sequence is valid under continuous monitoring, so `evaluate-cell`
may run on every tick without inflating the false-downshift rate. The decision still goes
through route-propose, a Decision record and a commit, as today.

## Backward Compatibility

- No resource schema changes in v1alpha1 except the new audit-entry schema, which is
  additive; existing JSONL audit files remain readable, but a chain written before the
  change does not verify under the new rule. Each SDK carries a `schemaVersion` on the
  file so verifiers pick the right rule.
- Dispatch order changes for every adopter on the hierarchy path. The change ships behind a
  `dispatch.ranking: legacy | effective-priority` key, default `legacy` for one release, with
  the shadow comparison logged to the board.
- Admission scores change when SA moves off the label table; phase 2a shadow mode makes the
  swap observable before it is enforced.
- `AI_SDLC_DEPS_COMPOSITION=off` continues to disable effective-priority sorting on the legacy
  loop.

## Alternatives Considered

### Keep the review's plan as written

Rejected. Three of its premises were wrong on `main`: the live dispatch path is not
`loop.ts`, review attestations are no longer Ed25519 DSSE envelopes, and there is no
accept/escalate/reject data to fit against. Shipping the Phase 3 items on that basis would
replace hand-set constants with weights fitted to nothing.

### Start with the learned components

Rejected by the sequencing gate. With zero labelled PPA outcomes, a bandit or a fitted
composite is noisier than the constants it replaces. The honest first step is to make the
pipeline record the labels.

### Re-sign the verdict record now (Ed25519, Merkle leaves, inclusion proofs)

Deferred, not rejected. RFC-0061 OQ-8 chose an error-resistant claim with an explicit
upgrade trigger; adding signatures and a tree without that trigger reintroduces the key
management RFC-0061 removed three days ago. OQ-4 decides the canonicalisation part; a
signed record is a future RFC if the trigger fires.

### A Z3 dependency for policy consistency checks

Open (OQ-6). The alternative is a bounded TypeScript check over the small boolean systems
(autonomy policies, enforcement levels), which is enough for contradiction detection at
today's sizes.

## Implementation Plan

- [ ] Walk the six Open Questions with the operator through the decision rubric (one at a
      time); record each answer as a Decision record on `main`.
- [ ] Phase 1 tasks (filed after the OQ walkthrough, not before): live-path ranking with
      shadow comparison; SA engine at admission in phase 2a; DAG consolidation; audit-entry
      schema, JCS and conformance fixture; prompt-digest, merge-base diff and worktree cap.
- [ ] Phase 2 tasks: calibration coefficient, token model, ordinal bias, confidence
      recalibration and Brier surface, sequential downshift test, drift and flood tests.
- [ ] Phase 3 tasks: filed when the sequencing gate is met.
- [ ] Update normative spec document(s): `spec/spec.md#audit-entry`, RFC-0014 §5.2 formula.
- [ ] Update JSON Schema(s): audit-entry.
- [ ] Conformance test updates: cross-SDK audit chain fixture.
- [ ] Fix stale comments the audits found: `orchestrator/src/runtime/attestations.ts:1-72`
      still describes signing and v3/v5 acceptance; `dogfood/scripts/ppa-score.ts:112` says 90
      days where the code uses 180; `spec/dor-corpus/README.md:10-19` says 75 fixtures where
      78 exist; `spec/rfcs/RFC-0019-*.md:30` body lifecycle disagrees with its frontmatter.

## Corrections to the source review

The review's claims were checked one by one. The corrections that change the plan:

1. **Live dispatch path.** The review examined `pipeline-cli/src/orchestrator/loop.ts`
   (`DEFAULT_MAX_CONCURRENT = 1`, four buckets). Nothing in `hierarchy/` or `dispatch/` imports
   it. The live order is wave, then a three-level rank without `critical`, then manifest mtime
   (`board.ts:1055-1060`, `brief.ts:81`). Effective priority and critical path are not used on
   the live path at all; concurrency is set by `executors.max` and the pacer, not by `loop.ts`.
2. **RFC-0014 formula.** The RFC disagrees with itself: §5.2 (`:128`) and `:32` say `+`, §5.3
   (`:135`) and Q1 (`:231`) say `max`. The code uses `max`. The conflict is inside the RFC first.
3. **SubscriptionLedger and `defer-if-low-priority`** belong to RFC-0010 §14, not RFC-0050
   (which is the usage ledger and model-routing RFC). `recommend-worker.ts` does not call them;
   it reads `_ledger/*.json` directly. Nothing else calls them either.
4. **DAG engines.** About eight separate walks exist, and every one except
   `task-decomposer.topologicalSort` detects or guards against cycles. `dependency-graph.ts`
   already reports cycle paths; the RFC-0056 Kahn sort already feeds its edges into it.
5. **Worktree sweep.** The live sweep (`steps/00-worktree-disposition.ts`) removes merged,
   closed and no-PR worktrees and open-PR worktrees whose branch head is older than 14 days;
   it is not an mtime sweep. The `ceiling: 40` only raises an alarm. The `reclaimStale` mtime
   sweep in `worktree-pool.ts` has no caller.
6. **Age drift term.** `competitiveDrift = clamp((ageDays − 30) / 180, 0, 1)` exists in
   `admission-score.ts:293`. In the admission composite it raises demand pressure (older scores
   higher); in the full PPA it feeds the entropy tax (older scores lower). Backlog tasks use a
   label-based drift instead.
7. **Admission does not use the `priority.ts` formula.** The composite is
   `SA × DP_adj × ER × er5 × (1 + HC)` with Mφ = 1, Eτ = 0 and Cκ absent
   (`admission-composite.ts:319-340`); confidence is `0.5 × (9 mapper fields supplied) + 0.5 × (5
   enrichment slots loaded)`, not the 16-field fraction.
8. **Cκ** uses `dismisses`, not rejects, counts `override` events it never uses, and is not
   multiplied into admission anyway.
9. **T-shirt Stage A** is a min–max range over cheap voters plus bumps, not a majority vote;
   the LLM ensemble median exists but `cli estimate` never calls Stage B.
10. **Attestation.** After RFC-0061, `runtime/attestations.ts` signs nothing; it holds types
    and leftover constants (`ACCEPTED_SCHEMA_VERSIONS = ['v3','v5']`). The verdict record is
    unsigned by design (RFC-0061 OQ-8), protected by ref-write control, a hook fence and the
    trusted CI writer. Ed25519 DSSE survives only for the MCP tarball. The verdict leaves file
    is hashed as a whole, as the review said, with no inclusion proofs.
11. **Audit chains.** Three variants, not two: TypeScript (`JSON.stringify`, `null` genesis,
    millisecond timestamps), Go (`json.Marshal` sorted map with HTML escaping, `"genesis"`,
    second precision, different field names) and Python (TypeScript fields with Python's
    default separators and ASCII escaping). No SDK verifies another's chain; `conformance/`
    has no hash-chain vectors; no document claims interop.
12. **Prompt hash.** The 16-hex truncation is a label and grouping key for provenance blocks
    and tessellation rules; nothing re-derives or checks it, so it is not an integrity claim.
    Storing the full digest is still cheap and right.
13. **DoR corpus.** 78 fixtures, not 75; the 100% bar is Stage A only; Stage B and end-to-end
    bars are 90% and 95% against a calibrated mock spawner, not a live model. Stage A mixes
    regex with real reference lookups (file, issue, URL).
14. **`validate-agent-output.ts`.** Path rules are a prefix match, not globs; only max-lines
    comes from `git diff HEAD~1`; in `execute.ts` the check runs after push.
15. **Cross-harness review.** The Codex check does not pick the agent; `AI_SDLC_REVIEWER_HARNESS`,
    then `model-routing.yaml`, does, and this repository pins `harness: claude` until
    2026-11-19. Security review always stays on Claude. No per-category agreement between
    harnesses is tracked anywhere; the reviews-analysis module knows roles, not harnesses.
16. **`review-meta.ts`** uses `>= 0.8`, keeps a finding when the meta call fails, and is
    inactive because no caller supplies `metaReviewLLM`.
17. **Flood detection** compares `z > 3.0` strictly, runs only under 3 distinct sources with 7
    days of baseline, divides by zero variance to +∞, and compares an hourly count with daily
    baseline samples. No production code calls it.
18. **Tessellation Rule 2** stub is in `tessellation/inter-soul-embedding-distance-rule.ts`,
    not in `tessellation-drift.ts`. RFC-0019's frontmatter says `lifecycle: Implemented` while
    its body says Ready for Review; the embedding adapter exists but nothing outside
    `orchestrator/src/embedding/` calls it.
19. **The usage ledger** records no outcomes. First-pass approval per (role, model, taskClass)
    is derived by `usage/scorecard.ts` from three files; every assignment row today is
    `taskClass=uncategorized`.
20. **Shadow mode** exists in three places (RFC-0008 SA `shadowMode`, DoR `runShadowEval`,
    RFC-0049 judgment mode), but the SA one has no production caller and its phase is a
    caller argument, not a config key.

Claims confirmed as written: the `author_association` floors (plus one the review missed,
every Backlog item is labelled trusted); the admission thresholds; the token EWMA constants;
the routing constants and the sha256 explore draw; the SA drift thresholds; the BM25
clustering parameters and threshold; the regex nature of the soul-slug scan; the nine path
markers (plus five extension checks); the HMAC-SHA256 signed logger with a plain `===`
comparison and no Ed25519 option; the absence of any post-quantum, crypto-agility or
algorithm-identifier mention; all ten RFC-0060 questions open.

## Dependents

- RFC-0014: §5.2 formula amended once OQ-2 is answered.
- RFC-0010 §14: SubscriptionLedger wiring, if OQ-1 keeps it.
- RFC-0019: lifecycle inconsistency fixed; adapter wiring is a Phase 3 dependency.
- RFC-0061: unchanged; a signed verdict record would be a successor RFC.
- `spec/spec.md`: new `#audit-entry` section that `spec/adapters.md:225` already links to.

## Open Questions

Six questions, the review's own, restated with the evidence the audits found. None is
resolved in this draft. Each is walked with the operator through the decision rubric, one
at a time, and the answer recorded as a Decision record before the matching tasks are filed.

### OQ-1: What happens to `runWorkerPool`, `evaluateSchedule` and the SubscriptionLedger

The review asked which call path reaches them. The audit answer is none: both functions are
defined (`orchestrator/src/dispatch/worker-pool.ts:46`,
`orchestrator/src/scheduling/schedule-decision.ts:41`), re-exported from three barrels, and
called only from tests; `SubscriptionLedger` is constructed only in `coverage-gaps.test.ts`;
`recommend-worker.ts` reads `_ledger/*.json` directly. They belong to RFC-0010 §14. The
decision is what to do with them: (a) wire `defer-if-low-priority` into the hierarchy claim
order as the quota term of the Phase 1 ranking; (b) delete them under the dark-code gate and
let the pacer's `BUDGET` line remain the only quota control; (c) keep them exported for an
RFC-0060 worker and exclude them from this RFC.

### OQ-2: `max`, `+`, or weighted critical path for RFC-0014 composition

RFC-0014 says `+` at `:32` and `:128` and `max` at `:135` and `:231`; the code uses `max`
(`effective-priority.ts:11,203-223`); the live path uses neither. Candidates: (a) amend the
RFC to `max` and put effective priority on the live path as is; (b) adopt `+` as written in
§5.2; (c) drop both for the weighted critical-path rank in Design Details, with effective
priority as the first tie-break. The choice fixes what Phase 1 item 1 ships and what the
RFC-0014 amendment says.

### OQ-3: Labelled outcomes and the Phase 3 start date

The count today is zero in every PPA category: the five state tables are empty, the DoR
calibration file's `outcome` is the gate's own verdict, and the classifier file has no human
override. Routing has 1,637 assignments and 1,923 review records but a single `taskClass`.
Candidates for how labels get produced: (a) record accept/escalate/dismiss from the
Decision Catalog answers that already exist (DEC records carry a chosen option and a
rationale); (b) add an explicit operator label step to admission; (c) treat first-pass review
approval as the only label and fit routing first, PPA later. The answer sets the 200-per-cell
gate's clock and which Phase 2 items can be fitted at all.

### OQ-4: Cross-SDK audit verification and whether canonicalisation blocks Phase 1

No SDK verifies another's chain; the Go verifier (`sdk-go/audit/filesink.go:65-83`) would
reject a TypeScript file on field names and genesis alone; Python is a third variant; no
document claims interop and `spec/adapters.md:225` links to a schema section that does not
exist. Candidates: (a) one schema, JCS and a conformance fixture in Phase 1, every SDK
verifies every SDK; (b) one schema and fixture in Phase 1 but each SDK verifies only its own
output, interop deferred; (c) document single-SDK verification as the contract and remove the
dangling link. This decides Phase 1 item 4's scope and whether the website's "verifiable"
claim is cross-language.

### OQ-5: Which RFC-0060 questions resource-aware dispatch depends on

All ten RFC-0060 questions are open (`RFC-0060:157-158`, sign-off not eligible). The
single-host packing pass in Design Details needs none of them. A multi-host version depends
on OQ-3 (per-user subscription quota source), OQ-4 (placement policy) and OQ-5 (resource
telemetry agent) of RFC-0060. Candidates: (a) scope this RFC to single-host packing and
state that dependency list for the successor; (b) hold resource-aware dispatch until those
three RFC-0060 questions are answered; (c) fold the packing pass into RFC-0060 and remove it
from Phase 2 here.

### OQ-6: A Z3 dependency for policy consistency checks

No SAT or SMT dependency exists today. The policy systems in question (autonomy policies,
quality-gate enforcement levels) are small boolean systems. Candidates: (a) add Z3 (via a
WebAssembly build) at config-validation time and emit the unsat core as a compliance
artefact; (b) a bounded TypeScript truth-table check with an explicit size limit, no new
dependency; (c) no consistency check in this RFC. The choice weighs a credible compliance
artefact against a heavy dependency in a CLI that adopters install.

## Sign-Off

| Role | Owner | Status | Date |
|---|---|---|---|
| Engineering | Dominique Legault | pending | |
| Operator | Dominique Legault | pending | |
| Product | | pending | |
| Design | | pending | |

## Revision History

| Version | Date | Change |
|---|---|---|
| v0.1 | 2026-11-06 | Draft from the external review "AI-SDLC Algorithm Improvement Directions" (2026-11-06), with every code claim verified against `main` at `e9da7a01` by four read-only audits; twenty corrections recorded; three phases with a sequencing gate; six Open Questions restated with evidence, none resolved. |

## References

- "AI-SDLC Algorithm Improvement Directions", external review, 2026-11-06 (operator's copy,
  outside the repository).
- RFC-0005 Product Priority Algorithm; RFC-0008 PPA Triad Integration (Addendum B);
  RFC-0010 Parallel Execution and Worktree Pooling (§14 SubscriptionLedger); RFC-0011
  Definition-of-Ready Gate; RFC-0014 Dependency Graph Composition; RFC-0016 Estimation
  Calibration; RFC-0019 Embedding Provider Adapter; RFC-0049 judgment mode; RFC-0050 Usage
  Ledger and model routing; RFC-0051 session hierarchy; RFC-0056 workflow engine; RFC-0060
  Distributed LLM-worker scheduler; RFC-0061 Review verdict gate (OQ-8 trust claim).
- Critical-path list scheduling: Adam, Chandy, Dickson, CACM 1974. Thompson sampling for
  contextual bandits: Agrawal and Goyal, ICML 2013. Always-valid sequential tests: Johari,
  Koning, Pekelis, Walsh, KDD 2017. Calibration: Platt 1999; Zadrozny and Elkan, KDD 2002;
  Brier score. Change detection: Page 1954 (CUSUM); Page-Hinkley. Clustering: HDBSCAN
  (Campello, Moulavi, Sander 2013); HNSW (Malkov and Yashunin 2018).
- RFC 8785 JSON Canonicalization Scheme; RFC 6962 Certificate Transparency; DSSE envelope
  specification; FIPS 204 ML-DSA; FIPS 205 SLH-DSA.
