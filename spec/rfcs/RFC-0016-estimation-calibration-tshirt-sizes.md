---
id: RFC-0016
title: Estimation Calibration with T-Shirt Sizes
status: Draft
lifecycle: Draft
author: dominique@reliablegenius.io
created: 2026-05-01
updated: 2026-05-01
targetSpecVersion: v1alpha1
requires:
  - RFC-0011
  - RFC-0015
requiresDocs: []
---

# RFC-0016: Estimation Calibration with T-Shirt Sizes

**Document type:** Normative (draft)
**Status:** Draft (initial seed; structure may shift; open questions in §13)
**Lifecycle:** Draft
**Author:** dominique@reliablegenius.io (with Claude assist)
**Created:** 2026-05-01
**Updated:** 2026-05-01
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [ ] Engineering owner — dominique@reliablegenius.io (pending)
- [ ] Product owner — Alex (pending)
- [ ] Operator owner — dominique@reliablegenius.io (pending)

## Revision History

| Version | Date | Author | Notes |
|---|---|---|---|
| v1 | 2026-05-01 | dominique | Initial draft. Captures the systematic-overestimate-bias problem observed during the 2026-05-01 session and proposes a t-shirt-size + 2x-deviation calibration loop, mirroring how human teams calibrate story points. |

---

## 1. Summary

Claude (and other AI agents) systematically overestimate task duration. Concrete evidence from the 2026-05-01 session:

| Estimate | Actual | Bias |
|---|---|---|
| AISDLC-123 "15 min total" | ~8 min | 1.9x over |
| AISDLC-128 round 2 "10-25 min" | ~20 min | 1.0x (within range) |
| AISDLC-115.4 "25-40 min" | ~20 min | 1.6x over |
| AISDLC-130 "small (~5 min)" | ~4 min | 1.25x (close) |
| Cron-tick "1 hour" | typically 30-45 min | 1.5x over |

Pattern: 1.5-2x overestimate, especially on small tasks. Predictable bias is correctable; **continuous-time predictions are not**.

This RFC proposes adopting the t-shirt-size pattern (XS / S / M / L / XL) with explicit wall-clock buckets, capturing every estimate structurally (not in conversational prose), measuring actuals from existing data sources (`events.jsonl` per RFC-0015, git timestamps, PR `createdAt`/`mergedAt`), and applying per-class bias multipliers to future estimates so the system learns from its own track record.

The mechanism mirrors human agile teams: estimate → measure → compute deviation → adjust → re-estimate.

## 2. Motivation

### 2.1 Why continuous estimates fail

"This will take 25-40 minutes" implies false precision. The estimate is essentially:

1. A point guess (or 2-point range) in continuous time
2. Without a category attached
3. Captured in conversational prose, never indexed
4. Compared against actuals only ad-hoc by the operator's memory

There's no way to compute "Claude's average bias on this task class." Every estimate is a one-shot prediction with no feedback loop.

### 2.2 Why categorical (t-shirt) buckets work

T-shirt sizes are an industry-standard agile pattern for the same reason they apply here:

- **Buckets are stable.** "M" doesn't drift over time the way "30 min" does as the team gets faster.
- **Bias is detectable.** "Predicted M, actual L" is a 1-bucket miss; "predicted S, actual XL" is a 3-bucket miss. You can compute "average bucket-distance miss" without parsing time strings.
- **Bias is correctable.** If the agent consistently misses by 1 bucket high (predicts M when actual is S), the agent's "M" should map to the team's "S" — apply a -1 bucket shift to future estimates.
- **Confidence is implicit.** A 2-bucket range ("M-L") signals lower confidence than a single-bucket point estimate.

### 2.3 What this enables

- **Trust calibration.** Operator can ask "what's Claude's median miss on infra tasks?" and get a real number.
- **Better dispatch decisions.** RFC-0015's orchestrator can use calibrated estimates for capacity planning ("can I fit 3 more L-bucket tasks before the off-peak window closes?").
- **Foundation for confidence intervals.** Once buckets are calibrated, confidence ranges become principled rather than guesses.

## 3. Goals and Non-Goals

### Goals

- Replace continuous-time estimates with categorical t-shirt-size buckets (XS / S / M / L / XL).
- Capture every estimate structurally at the moment it's made (not in prose).
- Measure actuals from existing data sources (`events.jsonl`, git, gh).
- Compute per-class bias and surface it back to the agent at estimate time.
- Apply learned bias adjustments to future estimates (not just record + display).

### Non-Goals

- Predict ARRIVAL times (when something will land in the queue) — this RFC is about estimating WORK durations, not scheduling.
- Replace human estimation entirely — operator-provided estimates are kept as a separate signal.
- Calibrate non-task work (general conversation length, design discussion duration) — only structured tasks dispatched through the pipeline are in scope.
- Multi-agent calibration — single-agent calibration first; per-agent calibration is a future extension.

## 4. T-Shirt Size Taxonomy

### 4.1 Wall-clock buckets

| Bucket | Wall-clock range | Examples (calibrated against this session) |
|---|---|---|
| **XS** | < 10 min | Single-line config edit; CLAUDE.md doc nit; trivial test addition |
| **S** | 10-25 min | Single-file fix with tests (AISDLC-123); cosmetic refactor bundle (AISDLC-128 round 2) |
| **M** | 25-60 min | Multi-file fix + tests + docs (AISDLC-130); single phase of an RFC chain |
| **L** | 1-2 hours | Multi-module integration (AISDLC-115.4 Phase 3); RFC-implementation phase |
| **XL** | > 2 hours | Cross-cutting refactor; new RFC + phased implementation |

**Bucket boundaries are explicit, not soft.** "AISDLC-115.4 was estimated L, actual S" is a precise statement.

### 4.2 Bucket math

- **1-bucket miss** = predicted bucket adjacent to actual bucket. Acceptable noise; common in agile teams.
- **2-bucket miss** = significant calibration error. Triggers a correction event.
- **3+ bucket miss** = systemic mismodeling. Triggers a `EstimateClassMismatch` review.

### 4.3 Confidence ranges

An estimate may be a single bucket (high confidence) or a 2-bucket range (lower confidence):

- `S` — point estimate; agent claims this is firmly in the S bucket
- `S-M` — straddles two buckets; agent uncertain which side it falls
- Ranges wider than 2 buckets (e.g. `S-XL`) are not allowed — that's a refusal to estimate; agent should ask for scope clarification first

## 5. Estimate Capture

### 5.1 Capture surface

Every estimate the agent makes is captured to `$ARTIFACTS_DIR/_estimates/log.jsonl` at the moment of utterance:

```jsonl
{"ts":"2026-05-01T22:30:00Z","predictedBy":"claude-opus-4-7","taskId":"AISDLC-123","class":"single-file-test-fix","bucket":"S","scopeFactors":["test-only","corpus-fixture-already-shipped"],"context":"dispatch-decision"}
```

### 5.2 Capture trigger

The agent emits an estimate event when it commits to ANY of:

- Dispatching a task (RFC-0015 `WorkerDispatch` event correlates)
- Drafting an RFC implementation plan (per-phase estimates)
- Predicting wall-clock for a cron tick / batch
- Operator-prompted estimate ("how long will X take?")

### 5.3 Capture structure

Required fields:
- `ts` (ISO timestamp)
- `predictedBy` (agent identity — model + harness)
- `bucket` (XS / S / M / L / XL or 2-bucket range like `S-M`)
- `class` (per §6.1 taxonomy — what KIND of task this is)
- `context` (free-text human-readable scope description, ≤200 chars)

Optional fields:
- `taskId` (when estimate ties to a backlog task)
- `scopeFactors[]` (specific factors the agent considered: "RFC implementation", "test-only", "blocked-by-X")
- `expectedActorClass` (who's doing the work: agent / human / hybrid)

## 6. Measurement

### 6.1 Task-class taxonomy

Calibration is **conditional on task class**. Bias on infra cleanup is different from bias on RFC implementation. Initial classes (extensible via Q3):

- `single-file-test-fix` — modify one test file, no code changes
- `single-file-code-fix` — modify one source file (no new files)
- `multi-file-refactor` — refactor across 2-5 files, no new architecture
- `single-feature` — implement one cohesive feature (≤10 files)
- `rfc-phase` — one phase of an RFC implementation chain
- `rfc-design` — write or iterate on an RFC document
- `infra-cleanup` — backlog drift, attestation cleanup, workflow YAML edits
- `review-cycle` — 3-reviewer fan-out + aggregation (always M for now)
- `bug-investigation` — diagnose-then-fix where the diagnosis is the work
- `cron-batch` — wake-tick + sweep + dispatch + log

### 6.2 Actuals collection

Three sources, in priority order:

1. **`events.jsonl`** (per RFC-0015) — `WorkerDispatch` → `WorkerCompleted` deltas. Most precise. Authoritative when present.
2. **Git timestamps** — first commit on branch → merge commit on main. Coarser (includes review wait time).
3. **PR `createdAt` → `mergedAt`** — for tasks shipped via the pipeline. Includes human review wait time.

The collector runs periodically (cron or post-merge hook), joins each completed task to its captured estimate, computes the actual bucket, writes to `$ARTIFACTS_DIR/_estimates/calibration.jsonl`:

```jsonl
{"ts":"2026-05-01T23:00:00Z","taskId":"AISDLC-123","class":"single-file-test-fix","predictedBucket":"S","actualBucket":"XS","bucketMiss":1,"actualWallClockSec":480,"source":"events.jsonl"}
```

### 6.3 Excluding non-work time

Actual wall-clock should EXCLUDE:
- Time waiting for human review (PR open → first review)
- Time waiting in merge queue
- Time blocked on operator decisions (e.g. mid-RFC Q&A)

Inclusion of these inflates the "actual" and trains the bias adjustment in the wrong direction. The collector subtracts these gaps using `events.jsonl` `WorkerParked` / `WorkerResumed` events.

## 7. Bias Adjustment

### 7.1 Per-class bias

For each task class, compute over the last 30 days OR last 20 estimates (whichever is more):

- **Mean bucket miss**: signed integer (positive = overestimate, negative = underestimate)
- **Median bucket miss**: robust to outliers
- **Bias multiplier**: heuristic correction factor. If mean miss = +1 bucket consistently, agent should apply a -1 shift.

### 7.2 Adjustment algorithm

When the agent makes a new estimate of class C:

1. Look up class C's bias from the calibration log.
2. If `|mean_miss| ≥ 1.0 bucket` AND `n ≥ 5 samples`, apply correction:
   - Predicted bucket = agent's raw estimate
   - Adjusted bucket = predicted bucket - mean_miss (rounded)
3. Surface BOTH the raw and adjusted estimate to the operator: "Estimate: M (raw L, adjusted -1 for infra-cleanup overestimate bias)"
4. Capture both in the log so future calibration can detect when the adjustment itself drifts

### 7.3 Cold-start

When n < 5 for a class: no adjustment. Log raw estimate only. Adjustment kicks in once 5 samples accumulate.

### 7.4 Drift detection

If after adjustment the mean miss flips sign (consistently underestimated post-adjustment), the bias multiplier was over-corrected. Phase 3 emits a `EstimateBiasOverCorrected` event when this pattern persists for ≥3 consecutive estimates.

## 8. Schema Changes

- New `$ARTIFACTS_DIR/_estimates/log.jsonl` — captured estimates
- New `$ARTIFACTS_DIR/_estimates/calibration.jsonl` — predicted vs actual paired records
- New `.ai-sdlc/schemas/estimate.v1.schema.json` — JSON Schema for both files
- New `.ai-sdlc/estimate-classes.yaml` — operator-extensible taxonomy of task classes (per Q3)
- Extension to RFC-0015 `events.jsonl`: new event types `EstimateCaptured`, `EstimateBiasApplied`, `EstimateBiasOverCorrected`

## 9. Backward Compatibility

- Opt-in via feature flag `AI_SDLC_ESTIMATION_CALIBRATION=experimental`. Default off.
- When off, the agent emits estimates in conversational prose (status quo). When on, every estimate is also captured to the log.
- Existing pipeline code unchanged; the calibration loop is purely additive.

## 10. Alternatives Considered

### 10.1 Continuous-time estimates with confidence intervals

Replace "30 min" with "30 min ± 15 min, 80% confidence." Still continuous, still hard to calibrate; confidence intervals don't address the underlying bucketing problem.

### 10.2 Prediction markets / multi-agent voting

Have multiple agents estimate; aggregate. Adds complexity for marginal value when most estimates come from one agent (Claude). Defer.

### 10.3 Always-defer-to-operator

Stop having the agent estimate at all; require operator to provide all estimates. Loses the predictive value the agent CAN provide once calibrated.

### 10.4 Story points (Fibonacci 1/2/3/5/8) instead of t-shirt sizes

Considered. T-shirt sizes (XS/S/M/L/XL) win because:
- Fewer buckets (5 vs 6+) — fewer calibration parameters
- Wall-clock-anchored — story points are dimensionless and require team-specific calibration just to interpret
- Industry-recognizable for the agile-aware operator audience

## 11. Implementation Plan

Sequential phases, each behind feature flag `AI_SDLC_ESTIMATION_CALIBRATION=experimental`.

| Phase | Wall-clock | Components | Acceptance |
|---|---|---|---|
| **Phase 1: Capture** | 0.5 wk | Estimate-log writer; agent prompt updates to emit structured estimates; wire to RFC-0015 events.jsonl | 100% of agent estimates appear in log.jsonl with required fields |
| **Phase 2: Measurement** | 1 wk | Actuals collector; calibration.jsonl writer; non-work-time exclusion logic | For ≥10 completed tasks, calibration.jsonl has paired predicted/actual records |
| **Phase 3: Per-class bias** | 1 wk | Bias-multiplier computation; class-taxonomy YAML + JSON Schema; `cli-estimates show <class>` command | `cli-estimates show single-file-test-fix` returns mean/median miss + sample count |
| **Phase 4: Adjustment** | 0.5 wk | Agent-side bias-application; raw + adjusted both captured + surfaced | Operator sees both raw and adjusted in dispatch-time messages |
| **Phase 5: Soak + drift detection** | corpus-driven, NOT calendar-gated | `EstimateBiasOverCorrected` event; weekly calibration digest | Promotion when 95%+ of 1-bucket misses + < 5% of 3-bucket misses across 50 estimates |

Total wall-clock: ~3 weeks for Phase 1-4. Phase 5 corpus-driven per maintainer directive 2026-05-01.

Critical path: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5.

## 12. Composes With

- **RFC-0011** (DoR calibration log) — same JSONL pattern; same calibration-loop philosophy
- **RFC-0014** (dependency graph) — `effectivePriority` could fold in estimated cost (XS leaf is cheaper to dispatch than XL leaf)
- **RFC-0015** (orchestrator) — `events.jsonl` is the actuals source; orchestrator's capacity planner uses calibrated estimates for "can I fit 3 more M-bucket tasks before off-peak ends?"
- **RFC-0010** (subscription scheduling) — bucket-class × calibrated time = predicted token cost per task; SubscriptionLedger uses this for window planning

## 13. Open Questions

1. **Q1: Should the bucket boundaries be operator-tunable per project?** A small embedded team's "L" might be 4 hours; a startup's "L" might be 30 min. Lean: yes — `.ai-sdlc/estimate-buckets.yaml` carries per-project boundaries; defaults from §4.1 ship as the catalogue. Decide before Phase 1.

2. **Q2: How does the bias adjustment handle multi-agent estimates?** When operator + Claude both estimate, do we calibrate each separately, blend, or pick one? Lean: calibrate each separately (per-agent bias is a real signal); operator's estimate stays uncalibrated (humans self-calibrate via experience). Decide before Phase 4.

3. **Q3: Is the task-class taxonomy fixed in §6.1 or operator-extensible?** Lean: extensible via `.ai-sdlc/estimate-classes.yaml` (same pattern as RFC-0015 Q9 failure-pattern catalogue). Default 10 classes ship; operators add project-specific classes. Decide before Phase 3.

4. **Q4: Should the calibration log retain individual estimates forever, or roll up after N days?** Lean: keep raw entries 90 days; roll up to per-class aggregates monthly thereafter (forensic + bounded storage). Decide before Phase 2.

5. **Q5: How do we handle estimates the agent makes mid-task (e.g. "now I think this is L not M")?** Lean: capture as a NEW `EstimateRevised` event, not overwrite — the revision is itself a signal of mid-task scope discovery. Calibration uses the LATEST estimate but tracks revision count. Decide before Phase 1.

6. **Q6: When no actuals exist for a class (cold-start), how confident is the agent in raw estimates?** Lean: agent surfaces the estimate with a "no calibration data — confidence low" suffix. Decide before Phase 4.

7. **Q7: Should estimates appear in PR descriptions automatically?** A standardized "Estimated: M; will track actual on merge" line gives operators visibility per-PR. Lean: yes, but as a lint-checkable PR template field rather than agent-injected freeform text. Decide before Phase 4.

## 14. References

- RFC-0011 — Definition-of-Ready Gate (calibration-log JSONL pattern this RFC mirrors)
- RFC-0015 — Autonomous Pipeline Orchestrator (events.jsonl actuals source; orchestrator capacity-planning consumer)
- Original conversation with @dominique establishing the need (2026-05-01): "we need a system where you can start to calibrate your estimates against actual data ... story points or t-shirt sizes ... see if we are off by a factor of 2x then adjust our estimates based on our bias."
- Industry pattern: agile story-point + t-shirt-size estimation — Mike Cohn, _Agile Estimating and Planning_ (2005)
