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
| v2 | 2026-05-01 | dominique | Restructured around the **deterministic-first / LLM-as-last-resort** pattern (mirrors RFC-0011 DoR Stage A/B). New §5 catalogues 8 Stage A deterministic signals (file scope, LOC delta, coverage threshold, historical actuals, dependency depth, blocked-paths-touched, file-type breakdown, reviewer-iteration history). New §6 reframes the LLM as a tie-breaker that runs ONLY when Stage A signals disagree or are missing, with the deterministic inputs as context. Renumbered §5-§9 → §7-§11; updated §1 + §2.2 to lead with the Stage A/B framing; added Q8 (which Stage A signals ship in Phase 1). |

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

**Architectural principle (mirrors RFC-0011 DoR Stage A/B)**: estimation is deterministic-first, LLM-as-last-resort. Stage A collects 8 measurable signals about the task (file scope, historical actuals, dependency depth, blocked-paths-touched, etc.) and produces a candidate bucket from a pure-function lookup. Stage B (LLM) runs ONLY when Stage A signals disagree across buckets, when a class has no historical data, or when the operator explicitly requests an override — and even then receives all Stage A inputs as deterministic context, not as freeform "guess from intuition."

The mechanism mirrors human agile teams: estimate → measure → compute deviation → adjust → re-estimate. With Stage A in front of the LLM, the LLM's job becomes "apply the calibration table to these signals" not "guess wall-clock from training intuition."

## 2. Motivation

### 2.1 Why continuous estimates fail

"This will take 25-40 minutes" implies false precision. The estimate is essentially:

1. A point guess (or 2-point range) in continuous time
2. Without a category attached
3. Captured in conversational prose, never indexed
4. Compared against actuals only ad-hoc by the operator's memory

There's no way to compute "Claude's average bias on this task class." Every estimate is a one-shot prediction with no feedback loop.

### 2.2 Why deterministic-first

Asking the LLM "how long will this take?" with no context is asking it to interpolate from training-data intuitions about other people's projects. That's the original failure mode (§2.1). The fix isn't "ask the LLM more carefully" — it's **gather measurable signals about THIS specific task first** and feed them as deterministic input.

The same pattern works in RFC-0011 DoR (Stage A's 7 deterministic gates run before any LLM call) and RFC-0008 PPA (deterministic SA scoring before LLM-driven calibration). Estimation should follow it: when Stage A's measurable signals point at a single bucket, the LLM has no role to play. When signals disagree (the rare semantic case), the LLM acts as a tie-breaker with the disagreement spelled out for it, not an oracle making a fresh guess.

### 2.3 Why categorical (t-shirt) buckets work

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

## 5. Stage A — Deterministic Pre-Estimation Analytics

Stage A runs BEFORE any LLM call. It collects 8 measurable signals about the task and produces a candidate bucket via a pure-function lookup table per task class. The LLM is not in this loop.

### 5.1 Stage A signal catalogue

| # | Signal | Source | Bucket impact |
|---|---|---|---|
| 1 | **File scope count** | Task `references[]` + the dev's planning step output | More files → larger bucket (1 file ≈ XS-S; 2-5 files ≈ S-M; 6-15 files ≈ M-L; >15 files ≈ L-XL) |
| 2 | **Historical actuals (per class)** | `_estimates/calibration.jsonl` median wall-clock for the same task class | Strongest single signal once n≥5 — replaces guesswork with the median bucket of the class |
| 3 | **LOC delta from `git diff --stat`** | post-implementation diff size | Calibration anchor for §6 actuals; also a forward signal during planning if the dev produces a draft diff |
| 4 | **Test coverage requirement** | `.codecov.yml` patch threshold + project test layout | Multiplies test-writing time; pushes bucket up by 0-1 |
| 5 | **Dependency depth** | `cli-deps blockers <id>` + `cli-deps blast-radius <id>` per RFC-0014 | Coordination cost grows with depth; pushes bucket up by 0-1 |
| 6 | **Blocked-paths touched** | path glob match against `.github/workflows/**`, `.ai-sdlc/**`, schema files | +1 bucket for caution (review-cycle iterations on these paths are systematically longer) |
| 7 | **File-type breakdown** | extension count from references / draft diff | Pure markdown changes are XS-S regardless of file count; pure TS code follows the standard bucket math; YAML edits sit between |
| 8 | **Reviewer-iteration history (per class)** | `events.jsonl` `ITERATE_DEV` count for tasks of this class | Classes with mean iteration count >1 systematically take longer; pushes bucket up |

### 5.2 Stage A → bucket lookup

Each signal returns a candidate bucket (XS / S / M / L / XL) via a pure-function rule. Stage A's output is the **multiset of candidate buckets** plus a confidence rating:

- **All 8 signals point at the same bucket** → confidence = high; bucket = unanimous choice; **LLM is not invoked**.
- **Signals split across 2 adjacent buckets** → confidence = medium; bucket = range estimate (`S-M`); **LLM is not invoked**.
- **Signals split across 2 non-adjacent buckets, OR 3+ buckets** → confidence = low; **escalate to Stage B with the disagreement spelled out**.
- **Class has n<5 historical samples** → signal #2 returns `unknown`; if remaining 7 signals agree, use them; if they don't, escalate to Stage B.
- **Reference unresolvable (file doesn't exist, missing planning data)** → signal returns `unknown`; treated the same as cold-start for that signal.

### 5.3 Worked example (AISDLC-123 retrospective)

Applying Stage A to AISDLC-123 (shadow-mode test exact-count):

| Signal | Value | Bucket |
|---|---|---|
| File scope count | 1 (just `shadow-mode.test.ts`) | XS |
| Historical actuals | n=4 for `single-file-test-fix` (cold-start; signal=unknown) | unknown |
| LOC delta (planning estimate) | ~25 lines | XS |
| Test coverage requirement | 80% patch threshold; test-only file | no bump |
| Dependency depth | 0 (no blockers) | no bump |
| Blocked paths touched | none | no bump |
| File-type breakdown | 1 .ts test file | XS-S |
| Reviewer-iteration history | n=4 mean=1.0 (cold-start) | unknown |

→ 6 of 6 resolved signals point at XS or XS-S. Stage A confidence: high. Bucket: **XS**. **No LLM call needed.** Actual was 8 min (XS bucket = <10 min). ✓

Compare to the LLM's original "15 min" guess (M bucket) — Stage A would have caught the overestimate before it was made.

## 6. Stage B — LLM Judgment (Last Resort)

Stage B runs ONLY when Stage A escalates. The LLM receives the full Stage A signal table as deterministic context, not "estimate this task."

### 6.1 Stage B prompt shape

```
TASK: <task title + description>
TASK CLASS: <class>

DETERMINISTIC SIGNALS (Stage A):
  1. File scope count: 8 files → bucket M
  2. Historical actuals (n=12 for rfc-phase): median L
  3. LOC delta (planning): ~400 lines → bucket M
  4. Test coverage requirement: 80%; high test coverage required → +1 bucket
  5. Dependency depth: 2 blockers (per cli-deps) → +0
  6. Blocked paths touched: .github/workflows/** YES → +1 bucket
  7. File-type breakdown: 5 .ts + 2 .yaml + 1 .md → no extra bump
  8. Reviewer-iteration history (n=8 for rfc-phase): mean iterations 1.4 → +0-1 bucket

DISAGREEMENT: signals split between M and L (file scope says M; historical median says L; coverage + blocked-paths bumps push M → L; iteration history straddles).

TASK: judge whether the M-vs-L disagreement resolves to M, L, or M-L range.
Output ONE bucket or a 2-bucket range. Justify in ≤2 sentences.
```

### 6.2 What the LLM is NOT asked to do

- Guess wall-clock duration from intuition (Stage A handles this with measurable signals).
- Pick a bucket without context (every Stage B prompt includes the full signal table).
- Override Stage A's confidence rating (if Stage A said high-confidence-XS, Stage B doesn't run).

### 6.3 Stage B verdict structure

Stored alongside Stage A signals in `_estimates/log.jsonl`:

```json
{
  "ts": "2026-05-01T22:30:00Z",
  "taskId": "AISDLC-115.4",
  "class": "rfc-phase",
  "stageA": {
    "signals": [...],
    "candidateBucket": "M-L",
    "confidence": "low"
  },
  "stageB": {
    "invoked": true,
    "promptHash": "sha256:...",
    "bucket": "L",
    "justification": "rfc-phase historical median + workflow YAML touch + 1.4 mean iterations all push toward L; file scope alone (M) is overruled by 3 stronger signals."
  },
  "finalBucket": "L"
}
```

### 6.4 When Stage B is forbidden

For task classes where Stage A has high-confidence (≥6 of 8 signals agreeing) AND historical n≥10, Stage B is NOT invoked even if the operator asks. The Stage A verdict is final; the operator can override the bucket directly via the calibration log (which gets recorded as `outcome: 'override'` for next-cycle tuning).

## 7. Estimate Capture

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
- `class` (per §8.1 taxonomy — what KIND of task this is)
- `context` (free-text human-readable scope description, ≤200 chars)

Optional fields:
- `taskId` (when estimate ties to a backlog task)
- `scopeFactors[]` (specific factors the agent considered: "RFC implementation", "test-only", "blocked-by-X")
- `expectedActorClass` (who's doing the work: agent / human / hybrid)

## 8. Measurement

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

## 9. Bias Adjustment

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

## 10. Schema Changes

- New `$ARTIFACTS_DIR/_estimates/log.jsonl` — captured estimates
- New `$ARTIFACTS_DIR/_estimates/calibration.jsonl` — predicted vs actual paired records
- New `.ai-sdlc/schemas/estimate.v1.schema.json` — JSON Schema for both files
- New `.ai-sdlc/estimate-classes.yaml` — operator-extensible taxonomy of task classes (per Q3)
- Extension to RFC-0015 `events.jsonl`: new event types `EstimateCaptured`, `EstimateBiasApplied`, `EstimateBiasOverCorrected`

## 11. Backward Compatibility

- Opt-in via feature flag `AI_SDLC_ESTIMATION_CALIBRATION=experimental`. Default off.
- When off, the agent emits estimates in conversational prose (status quo). When on, every estimate is also captured to the log.
- Existing pipeline code unchanged; the calibration loop is purely additive.

## 12. Alternatives Considered

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

## 13. Implementation Plan

Sequential phases, each behind feature flag `AI_SDLC_ESTIMATION_CALIBRATION=experimental`.

| Phase | Wall-clock | Components | Acceptance |
|---|---|---|---|
| **Phase 1: Stage A signals (deterministic)** | 1.5 wk | `cli-estimate stage-a <task-id>` command; collectors for the 6 cheap signals (file scope, blocked paths, file-type breakdown, dependency depth, coverage requirement, LOC delta from planning); pure-function bucket-lookup table per class | `cli-estimate stage-a AISDLC-X` returns the candidate bucket + per-signal breakdown for any task in the backlog. No LLM calls. |
| **Phase 2: Capture** | 0.5 wk | Estimate-log writer; record both Stage A multiset + final bucket; wire to RFC-0015 events.jsonl | 100% of agent estimates appear in log.jsonl with stageA + finalBucket fields |
| **Phase 3: Measurement** | 1 wk | Actuals collector; calibration.jsonl writer; non-work-time exclusion logic; signal #2 (historical actuals) becomes populated as data flows in | For ≥10 completed tasks, calibration.jsonl has paired predicted/actual records; signal #2 starts producing non-`unknown` values once n≥5 per class |
| **Phase 4: Stage B (LLM tie-breaker)** | 1 wk | Stage B prompt builder; only invoked when Stage A escalates per §5.2; full Stage A signal table passed as context per §6.1 | When Stage A signals split across non-adjacent buckets, Stage B receives the full table + returns one bucket or 2-bucket range with justification |
| **Phase 5: Per-class bias adjustment** | 1 wk | Bias-multiplier computation across Stage A + Stage B verdicts; class-taxonomy YAML + JSON Schema; `cli-estimates show <class>` command | `cli-estimates show single-file-test-fix` returns mean/median bucket-miss + Stage-A-vs-Stage-B accuracy comparison |
| **Phase 6: Soak + drift detection** | corpus-driven, NOT calendar-gated | `EstimateBiasOverCorrected` event; weekly calibration digest; metrics on Stage-A-coverage (% of estimates that bypass Stage B entirely) | Promotion when 95%+ of 1-bucket misses + < 5% of 3-bucket misses across 50 estimates AND Stage-A-coverage >70% |

Total wall-clock: ~5 weeks for Phase 1-5. Phase 6 corpus-driven per maintainer directive 2026-05-01.

Critical path: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6. **Stage A (Phase 1) must ship before Capture (Phase 2)** — capturing estimates without the Stage A signals would lock in the LLM-only baseline we're trying to escape.

## 14. Composes With

- **RFC-0011** (DoR calibration log) — same JSONL pattern; same calibration-loop philosophy
- **RFC-0014** (dependency graph) — `effectivePriority` could fold in estimated cost (XS leaf is cheaper to dispatch than XL leaf)
- **RFC-0015** (orchestrator) — `events.jsonl` is the actuals source; orchestrator's capacity planner uses calibrated estimates for "can I fit 3 more M-bucket tasks before off-peak ends?"
- **RFC-0010** (subscription scheduling) — bucket-class × calibrated time = predicted token cost per task; SubscriptionLedger uses this for window planning

## 15. Open Questions

1. **Q1: Should the bucket boundaries be operator-tunable per project?** A small embedded team's "L" might be 4 hours; a startup's "L" might be 30 min. Lean: yes — `.ai-sdlc/estimate-buckets.yaml` carries per-project boundaries; defaults from §4.1 ship as the catalogue. Decide before Phase 1.

2. **Q2: How does the bias adjustment handle multi-agent estimates?** When operator + Claude both estimate, do we calibrate each separately, blend, or pick one? Lean: calibrate each separately (per-agent bias is a real signal); operator's estimate stays uncalibrated (humans self-calibrate via experience). Decide before Phase 4.

3. **Q3: Is the task-class taxonomy fixed in §6.1 or operator-extensible?** Lean: extensible via `.ai-sdlc/estimate-classes.yaml` (same pattern as RFC-0015 Q9 failure-pattern catalogue). Default 10 classes ship; operators add project-specific classes. Decide before Phase 3.

4. **Q4: Should the calibration log retain individual estimates forever, or roll up after N days?** Lean: keep raw entries 90 days; roll up to per-class aggregates monthly thereafter (forensic + bounded storage). Decide before Phase 2.

5. **Q5: How do we handle estimates the agent makes mid-task (e.g. "now I think this is L not M")?** Lean: capture as a NEW `EstimateRevised` event, not overwrite — the revision is itself a signal of mid-task scope discovery. Calibration uses the LATEST estimate but tracks revision count. Decide before Phase 1.

6. **Q6: When no actuals exist for a class (cold-start), how confident is the agent in raw estimates?** Lean: agent surfaces the estimate with a "no calibration data — confidence low" suffix. Decide before Phase 4.

7. **Q7: Should estimates appear in PR descriptions automatically?** A standardized "Estimated: M; will track actual on merge" line gives operators visibility per-PR. Lean: yes, but as a lint-checkable PR template field rather than agent-injected freeform text. Decide before Phase 4.

8. **Q8: Which Stage A signals ship in Phase 1?** §5.1 catalogues 8 signals but some are cheaper than others. Lean: ship the 6 cheap ones (file scope, blocked paths, file-type breakdown, dependency depth, coverage requirement, LOC delta from planning) in Phase 1; defer the 2 expensive ones (historical actuals — needs §8 measurement first; reviewer-iteration history — same dependency) to Phase 3 once data flows in. Decide before Phase 1 ships. Open question: do we ship a 7th cheap signal as a fallback when historical actuals are unknown? E.g., `task-class default bucket from §6.1 wall-clock table`?

## 16. References

- RFC-0011 — Definition-of-Ready Gate (calibration-log JSONL pattern this RFC mirrors)
- RFC-0015 — Autonomous Pipeline Orchestrator (events.jsonl actuals source; orchestrator capacity-planning consumer)
- Original conversation with @dominique establishing the need (2026-05-01): "we need a system where you can start to calibrate your estimates against actual data ... story points or t-shirt sizes ... see if we are off by a factor of 2x then adjust our estimates based on our bias."
- Industry pattern: agile story-point + t-shirt-size estimation — Mike Cohn, _Agile Estimating and Planning_ (2005)
