---
id: RFC-0016
title: Estimation Calibration with T-Shirt Sizes
status: Draft
lifecycle: Ready for Review
author: dominique@reliablegenius.io
created: 2026-05-01
updated: 2026-05-03
targetSpecVersion: v1alpha1
requires:
  - RFC-0011
  - RFC-0015
requiresDocs: []
---

# RFC-0016: Estimation Calibration with T-Shirt Sizes

**Document type:** Normative
**Status:** Ready for Product owner sign-off (Engineering + Operator signed off 2026-05-03; 8 open questions resolved per §15)
**Lifecycle:** Ready for Review
**Author:** dominique@reliablegenius.io (with Claude assist)
**Created:** 2026-05-01
**Updated:** 2026-05-03
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [x] Engineering owner — dominique@reliablegenius.io (2026-05-03)
- [ ] Product owner — Alex (pending review)
- [x] Operator owner — dominique@reliablegenius.io (2026-05-03)

## Revision History

| Version | Date | Author | Notes |
|---|---|---|---|
| v1 | 2026-05-01 | dominique | Initial draft. Captures the systematic-overestimate-bias problem observed during the 2026-05-01 session and proposes a t-shirt-size + 2x-deviation calibration loop, mirroring how human teams calibrate story points. |
| v2 | 2026-05-01 | dominique | Restructured around the **deterministic-first / LLM-as-last-resort** pattern (mirrors RFC-0011 DoR Stage A/B). New §5 catalogues 8 Stage A deterministic signals (file scope, LOC delta, coverage threshold, historical actuals, dependency depth, blocked-paths-touched, file-type breakdown, reviewer-iteration history). New §6 reframes the LLM as a tie-breaker that runs ONLY when Stage A signals disagree or are missing, with the deterministic inputs as context. Renumbered §5-§9 → §7-§11; updated §1 + §2.2 to lead with the Stage A/B framing; added Q8 (which Stage A signals ship in Phase 1). |
| v3 | 2026-05-03 | dominique | Operator walkthrough resolved 8 open questions (Q1-Q8); Q3 / Q5 / Q6 received substantive design upgrades beyond the original lean — see new §15 Resolutions section. Q3 collapses the 10-class taxonomy to a 3-class convergent core (`bug` / `feature` / `chore`) with full ontology structure (definition + exemplars + anti_patterns + synonyms) and confidence-gated LLM classification (auto / log-for-review / fall-back); Q5 replaces the single-shot EstimateRevised model with content-hash-keyed ensemble sampling (median bucket + variance signal); Q6 introduces a 3-state token enum (`uncalibrated` / `warming` / `calibrated`) with appendable variance qualifier shared across PR comment / CLI / dashboard / Slack surfaces. Q7 PR surfacing now ships as a bot comment with the AISDLC-142 idempotent-marker pattern; Q8 ships 6 cheap signals + a class-default fallback (= 7 signals) in Phase 1. Lifecycle flipped Draft → Ready for Review; Engineering + Operator signoffs added (Product owner Alex pending review). |

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

**Architectural principle (mirrors RFC-0011 DoR Stage A/B)**: estimation is deterministic-first, LLM-as-last-resort. Stage A collects up to 9 measurable signals about the task (file scope, historical actuals, dependency depth, blocked-paths-touched, the class-default fallback for cold-start, etc.) and produces a candidate bucket from a pure-function lookup. Stage B (LLM) runs ONLY when Stage A signals disagree across buckets or when ensemble variance ≥ 2 buckets per §8.4 — and even then receives all Stage A inputs as deterministic context, not as freeform "guess from intuition." Class assignment itself is LLM-based (per §6.1) but happens once per task, gets cached, and is a separate fuzzy-classification step from Stage A bucket lookup.

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

Stage A runs BEFORE any LLM call. It collects up to 9 measurable signals about the task (8 original + 1 class-default fallback per Q8 resolution) and produces a candidate bucket via a pure-function lookup table per task class. The LLM is not in this loop. Class assignment itself IS LLM-based (per Q3 resolution, §6.1) but happens once per task and gets cached — Stage A bucket lookup remains deterministic.

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
| 9 | **Class-default fallback** (Q8) | seed catalogue: `bug` → S, `feature` → M, `chore` → S | Fires only when signal #2 returns `unknown` (n<5 for the class). Cheap-specific signals override class-default when they disagree. Retires gracefully as real signal #2 calibration data flows in Phase 3. |

### 5.2 Stage A → bucket lookup

Each signal returns a candidate bucket (XS / S / M / L / XL) via a pure-function rule. Stage A's output is the **multiset of candidate buckets** plus a confidence rating:

- **All resolved signals point at the same bucket** → confidence = high; bucket = unanimous choice; **LLM is not invoked**.
- **Signals split across 2 adjacent buckets** → confidence = medium; bucket = range estimate (`S-M`); **LLM is not invoked**.
- **Signals split across 2 non-adjacent buckets, OR 3+ buckets** → confidence = low; **escalate to Stage B with the disagreement spelled out**.
- **Class has n<5 historical samples (cold-start)** → signal #2 returns `unknown` AND **signal #9 (class-default fallback) activates** with the seed bucket per Q8. The remaining 7 cheap signals + the class-default vote on the bucket; cheap-specific signals override the class-default on direct disagreement (per Q8 ordering rule). Escalate to Stage B only if the cheap signals AND class-default still split across non-adjacent buckets.
- **Reference unresolvable (file doesn't exist, missing planning data)** → signal returns `unknown`; treated the same as cold-start for that signal.

### 5.3 Worked example (AISDLC-123 retrospective)

Applying Stage A to AISDLC-123 (shadow-mode test exact-count):

| Signal | Value | Bucket |
|---|---|---|
| File scope count | 1 (just `shadow-mode.test.ts`) | XS |
| Historical actuals | n=4 for `bug` class (warming; signal=unknown until n≥5) | unknown |
| LOC delta (planning estimate) | ~25 lines | XS |
| Test coverage requirement | 80% patch threshold; test-only file | no bump |
| Dependency depth | 0 (no blockers) | no bump |
| Blocked paths touched | none | no bump |
| File-type breakdown | 1 .ts test file | XS-S |
| Reviewer-iteration history | n=4 mean=1.0 (warming) | unknown |
| Class-default fallback (Q8) | class=`bug` → seed bucket S (overruled by file-scope XS, the cheap-specific signal) | S |

→ 6 of 6 cheap-specific signals point at XS or XS-S; class-default fallback (S) is overruled by the cheap-specific signals per the Q8 ordering rule. Stage A confidence: high. Bucket: **XS**. **No LLM call needed.** Actual was 8 min (XS bucket = <10 min). ✓

Compare to the LLM's original "15 min" guess (M bucket) — Stage A would have caught the overestimate before it was made.

## 6. Stage B — LLM Judgment (Last Resort)

Stage B runs ONLY when Stage A escalates. The LLM receives the full Stage A signal table as deterministic context, not "estimate this task."

### 6.1 Stage B prompt shape

```
TASK: <task title + description>
TASK CLASS: <class>

DETERMINISTIC SIGNALS (Stage A):
  1. File scope count: 8 files → bucket M
  2. Historical actuals (n=12 for `feature` class): median L
  3. LOC delta (planning): ~400 lines → bucket M
  4. Test coverage requirement: 80%; high test coverage required → +1 bucket
  5. Dependency depth: 2 blockers (per cli-deps) → +0
  6. Blocked paths touched: .github/workflows/** YES → +1 bucket
  7. File-type breakdown: 5 .ts + 2 .yaml + 1 .md → no extra bump
  8. Reviewer-iteration history (n=8 for `feature`): mean iterations 1.4 → +0-1 bucket
  9. Class-default fallback (Q8): class=`feature` → seed bucket M (signal #2 already populated, fallback inactive)

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
  "class": "feature",
  "stageA": {
    "signals": [...],
    "candidateBucket": "M-L",
    "confidence": "low"
  },
  "stageB": {
    "invoked": true,
    "promptHash": "sha256:...",
    "bucket": "L",
    "justification": "feature-class historical median + workflow YAML touch + 1.4 mean iterations all push toward L; file scope alone (M) is overruled by 3 stronger signals."
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
{"ts":"2026-05-01T22:30:00Z","predictedBy":"claude-opus-4-7","taskId":"AISDLC-123","class":"bug","bucket":"S","scopeFactors":["test-only","corpus-fixture-already-shipped"],"context":"dispatch-decision","estimateInputHash":"sha256:abc...","runIndex":1}
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

### 6.1 Task-class ontology (Q3 resolution)

Calibration is **conditional on task class**. Bias on a `bug` is different from bias on a `feature`. Per the Q3 resolution (§15), the ontology ships **3 starter classes** — `bug`, `feature`, `chore` — chosen as the **empirical convergent core** (≥6 of 10 popular PM tools default-ship these three; nothing else converges across the survey). The triad theme also mirrors the 3-reviewer triad (RFC-0011) and the 3-stage pipeline (Stage A signals / Stage B LLM / Phase-3 calibration).

The original v2 list of 10 classes (`single-file-test-fix`, `single-file-code-fix`, `multi-file-refactor`, `single-feature`, `rfc-phase`, `rfc-design`, `infra-cleanup`, `review-cycle`, `bug-investigation`, `cron-batch`) is **dropped**. Operators may add project-specific classes via the LLM-proposes / operator-approves workflow described below — but the calibration math doesn't pay off until per-class n ≥ 5, and 10 narrowly-scoped classes never reach that threshold in a single-operator dogfood project.

#### Class structure

Each class in `.ai-sdlc/estimate-classes.yaml` carries the **full ontology shape** (definition + exemplars + anti_patterns + synonyms):

```yaml
classes:
  bug:
    definition: "Restore expected behavior in code that previously worked or was specified to work."
    exemplars:
      - "Fix null-pointer crash in PaymentValidator.validate() when amount is undefined"
      - "Restore Auth header propagation through the proxy after middleware refactor"
    anti_patterns:
      - "Add new validation rule that didn't exist before (this is feature)"
      - "Rename internal helper for clarity (this is refactor)"
    synonyms: ["regression", "hotfix", "patch"]
  feature:
    definition: "Add capability that did not previously exist or was not previously specified."
    exemplars:
      - "Add t-shirt-size estimate field to backlog task schema"
      - "Add /ai-sdlc estimate CLI command"
    anti_patterns:
      - "Restore behavior that regressed (this is bug)"
      - "Update CHANGELOG before release (this is chore)"
    synonyms: ["enhancement", "capability", "new"]
  chore:
    definition: "Maintenance work with no user-visible behavior change — dependency bumps, formatting, doc nits, infra cleanup."
    exemplars:
      - "Bump @types/node from 22.10.0 to 22.10.5"
      - "Run prettier across the orchestrator package"
    anti_patterns:
      - "Add a missing test for behavior that already shipped (this is bug — covers a gap)"
      - "Restructure CHARTER.md to add a new section (this is feature — new content)"
    synonyms: ["maintenance", "tidy", "infra"]
```

#### Class assignment is LLM-based (NOT deterministic)

Stage A's deterministic-first principle (§5) governs **bucket lookup once the class is known**. Class assignment itself is a **separate fuzzy-language classification step** that happens once per task at estimate time and gets cached:

- The LLM reads the task title + description.
- It outputs `{class: <name>, confidence: 0.0–1.0, rationale: <one line>}`.
- The result is written to the task's frontmatter (`class:`) so downstream Stage A bucket lookup, calibration recording, and the PR comment (§8a) all agree on which class this task belongs to.
- Re-classification only fires when title/description change materially (covered by the §6.5 content-hash machinery — class assignment IS one of the inputs to `estimateInputHash`).

#### Confidence gates

| Confidence | Behavior |
|---|---|
| **≥ 0.90** | Auto-approve. If the LLM returned an existing class, use it directly. If the LLM proposed a brand-new class (with full structure it generates), append it to `.ai-sdlc/estimate-classes.yaml` automatically and use it. |
| **0.70 – 0.89** | Assign the existing class the LLM picked, but log the assignment to the operator-review queue: write to Slack `#estimation-review` channel + the `cli-estimate-classes review` dashboard. Operator confirms or reassigns within the next batch sweep. |
| **< 0.70** | Fall back to the synthetic `uncategorized` class. Warn in the calibration log. **Do NOT calibrate** against this class until the operator decides what it actually is — `uncategorized` samples are excluded from per-class bias math. |

#### Operator approval workflow for proposed-new-classes

When the LLM proposes a brand-new class (any confidence below the auto-approve threshold), append it to `.ai-sdlc/estimate-classes-proposed.jsonl` (append-only):

```jsonl
{"ts":"2026-05-04T10:00:00Z","taskId":"AISDLC-200","proposedClass":"docs-rewrite","structure":{"definition":"...","exemplars":["..."],"anti_patterns":["..."],"synonyms":["..."]},"confidence":0.78,"rationale":"task is a structural rewrite of multiple .md files; doesn't fit chore (behaviour-impacting) or feature (no new capability)"}
```

The operator runs `cli-estimate-classes review`, which opens a diff (proposed vs nearest existing class) and asks accept/reject. Accepted proposals are merged into `.ai-sdlc/estimate-classes.yaml`.

**Auto-promotion rule:** when ≥ N proposals (default 3) of the same shape (similar definition + exemplar overlap) accumulate within one weekly batch, the next batch sweep auto-promotes the most-frequent shape to a full class. Operator can roll back via the same `cli-estimate-classes` command.

#### Whole-replace semantics for bucket boundaries

Per the Q1 resolution (§15), the operator-tunable `.ai-sdlc/estimate-buckets.yaml` is a **whole replacement** of the catalogue defaults — no merge with §4.1's defaults. Either the operator hasn't shipped a yaml (defaults apply) or they have (their yaml is the full bucket set). This eliminates a class of "did this bucket override merge correctly?" debugging.

### 6.2 Actuals collection

Three sources, in priority order:

1. **`events.jsonl`** (per RFC-0015) — `WorkerDispatch` → `WorkerCompleted` deltas. Most precise. Authoritative when present.
2. **Git timestamps** — first commit on branch → merge commit on main. Coarser (includes review wait time).
3. **PR `createdAt` → `mergedAt`** — for tasks shipped via the pipeline. Includes human review wait time.

The collector runs periodically (cron or post-merge hook), joins each completed task to its captured estimate, computes the actual bucket, writes to `$ARTIFACTS_DIR/_estimates/calibration.jsonl` (rotated monthly per Q4 resolution: `_estimates/calibration-2026-05.jsonl` etc.):

```jsonl
{"ts":"2026-05-01T23:00:00Z","taskId":"AISDLC-123","class":"bug","predictedBucket":"S","actualBucket":"XS","bucketMiss":1,"actualWallClockSec":480,"source":"events.jsonl","estimateInputHash":"sha256:abc...","runIndex":1,"estimateVariance":0}
```

The new fields `estimateInputHash`, `runIndex`, and `estimateVariance` come from the Q5 ensemble model (§8.4). Monthly rotation gives a future roll-up natural batch boundaries; per Q4 the roll-up is **spec'd but NOT built in Phase 2** — raw queryability beats premature aggregation, and the per-class median over the last 30 days OR last 20 estimates from §9.1 streams line-by-line just fine over raw JSONL.

### 6.3 Excluding non-work time

Actual wall-clock should EXCLUDE:
- Time waiting for human review (PR open → first review)
- Time waiting in merge queue
- Time blocked on operator decisions (e.g. mid-RFC Q&A)

Inclusion of these inflates the "actual" and trains the bias adjustment in the wrong direction. The collector subtracts these gaps using `events.jsonl` `WorkerParked` / `WorkerResumed` events.

### 8.4 Ensemble sampling with content hashing (Q5 resolution)

LLM estimates are non-deterministic — a probability matrix being qualified, not a one-shot prediction. The naive "EstimateRevised event when the agent changes its mind" model from the v2 draft conflated three distinct things: (a) the same prompt run twice giving two answers (sampling noise), (b) the task itself materially changing mid-flight (scope drift), and (c) the agent re-evaluating with new information (legitimate revision). Q5's resolution separates these via **content hashing**.

#### Content hash

```
estimateInputHash = sha256(taskTitle + taskDescription + stageA_signals + classAssignment)
```

Every input that materially changes the LLM's bucket choice contributes to the hash. Rationale: same hash = same prompt-shape; different hash = different prompt-shape (which is the only legitimate reason to expect a different answer beyond sampling noise).

#### Same-hash multiple estimates → ensemble

When the same `estimateInputHash` shows up multiple times in `_estimates/log.jsonl` (because the agent re-ran the estimate, or a deliberate sampling pass fired N times for variance estimation):

- Aggregate as **datapoints**, not revisions. The log keeps every entry; no overwrite.
- Calibration uses the **median bucket** across the same-hash batch (robust to a single outlier sample).
- **Variance signal:**
  - `estimateVariance = (maxBucketIndex − minBucketIndex)` across the batch (XS=0, S=1, M=2, L=3, XL=4)
  - **Variance ≥ 2 buckets** → escalate to Stage B with the full inputs (LLM tie-breaker), OR flag for operator review when Stage B already ran. Variance is a free confidence proxy — wide spread means the model itself is uncertain.
  - **Variance ≤ 1 bucket** → accept the median; record `estimateVariance` as a low-cost calibration signal.

#### Different-hash → new estimate cycle

When `estimateInputHash` changes (because task title/description was edited, Stage A signals changed, or class assignment flipped), a fresh ensemble starts. Previous-hash estimates stay in the log forever for forensic value but **don't aggregate** with the new hash's batch. This naturally handles "task was modified mid-flight" without revision-vs-fresh ambiguity — the hash is the disambiguator.

The transition is logged via a new `EstimateInputChanged` event:

```jsonl
{"ts":"2026-05-01T22:45:00Z","taskId":"AISDLC-200","oldHash":"sha256:abc...","newHash":"sha256:def...","changedFields":["taskDescription","classAssignment"]}
```

Operators can audit input transitions in the same way RFC-0015 audits other event-stream transitions.

#### Schema additions

The `_estimates/calibration.jsonl` writer (§8.2) gains three fields:

- `estimateInputHash: <sha256>` — which prompt-shape produced this row
- `runIndex: <N>` — 1, 2, 3 for repeated runs against the same hash
- `estimateVariance: <number>` — computed at the BATCH level, written when input hash changes or task hits Done (lazy aggregation; one batch-summary row per hash transition)

This unifies "single-shot estimate" (n=1, variance=0) with "deliberate ensemble sampling" (n≥2, variance≥0) under the same schema — the analytics queries don't have to special-case ensemble vs solo.

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
3. Surface BOTH the raw and adjusted estimate to the operator: "Estimate: M (raw L, adjusted -1 for `chore`-class overestimate bias)"
4. Capture both in the log so future calibration can detect when the adjustment itself drifts

### 7.3 Cold-start (Q6 resolution — state token enum)

Confidence in any estimate gets surfaced via a **3-state token enum** that's appendable across all four surfaces (PR comment §8a / CLI output / dashboard / Slack). The original draft used a `(n=3/5)` denominator that became confusing once `n` exceeded the threshold; Q6 drops the denominator and adopts these state tokens instead:

| State | Condition | Format |
|---|---|---|
| `uncalibrated` | `n = 0` for the class | `(uncalibrated)` |
| `warming` | `1 ≤ n < 5` for the class | `(warming, n=N)` |
| `calibrated` | `n ≥ 5` for the class | `(calibrated, n=N, bias=±X%)` |

#### Variance qualifier (Q5 connection)

When the §8.4 `estimateVariance ≥ 2`, append `; high-variance` to the state token even when calibrated:

```
(calibrated, n=23, bias=+15%, high-variance)
```

This composes with §8.4's escalation behavior — the human reading the surface sees both "we have enough samples to trust the bias number" AND "this particular estimate has wide LLM disagreement, take the bucket with extra salt."

#### Operator overrides count as samples

When the operator overrides a bucket (via the calibration log, recorded as `outcome: 'override'`), that override counts as a calibration sample with `source: 'override'`. Bias-multiplier math weights overrides equally with model-produced samples. Rationale: the operator IS the ground truth (Q2 resolution); refusing to learn from operator corrections would defeat the calibration loop.

#### Single-source-of-truth formatting

All four surfaces (PR comment §8a / `cli-estimates show` CLI / dashboard / Slack `#estimation-review`) render the state token via one shared formatter — there's no surface-specific parsing, just one string substituted into each surface's templating.

Adjustment math stays the same: when `state = calibrated` AND `|mean_miss| ≥ 1.0 bucket`, apply correction per §7.2. When `warming` or `uncalibrated`, the raw estimate ships unmodified — log it, don't adjust.

### 7.4 Drift detection

If after adjustment the mean miss flips sign (consistently underestimated post-adjustment), the bias multiplier was over-corrected. Phase 3 emits a `EstimateBiasOverCorrected` event when this pattern persists for ≥3 consecutive estimates.

## 9a. PR Surfacing — bot comment (Q7 resolution)

Estimates appear on every PR via a **bot-posted PR comment** (NOT a PR template field, NOT freeform agent body text). This pattern reuses two well-tested AISDLC-142 ergonomics:

1. **Idempotent marker:** `<!-- ai-sdlc:estimate -->` at the top of the comment body. The comment writer scans the PR's existing comments for this marker and either edits the existing comment or posts a fresh one. There's never more than one estimate comment per PR.
2. **Trusted-author filter:** the writer is the same `ai-sdlc-bot` GitHub identity that posts the AISDLC-142 review-results comment, so external contributors can't forge a fake "estimated XS" comment and have it taken seriously by downstream tooling that reads this comment as ground truth.

#### Comment payload

```
<!-- ai-sdlc:estimate -->
**Estimated:** M (calibrated, n=23, bias=+15%)
**Class:** feature
**Stage A signals:** 6 of 6 agreed (file scope, dep depth, ...)
**Variance across runs:** 0 buckets (single estimate, n=1)

*Last updated: <isoTimestamp>*
```

The state token (Q6 resolution, §7.3) renders identically to the CLI / dashboard / Slack surfaces — single source of truth.

#### Why bot comment beats PR template field

- **Survives PR-description rewrites.** The Q5 ensemble model (§8.4) produces a fresh estimate when `estimateInputHash` changes; that becomes a comment EDIT, not a PR-description rewrite that fights with the operator's own description text.
- **Visible diff history.** GitHub shows comment edit history; "the estimate started M, drifted to L, settled at L on the third run" is auditable inline without grepping the JSONL.
- **No forgery surface.** A PR template field is whatever the PR opener types; a bot-authored comment with a known identity is verifiable.
- **Doesn't deadlock docs-only PRs.** The AISDLC-131 / AISDLC-132 docs-only PR ergonomics keep working — the estimate comment is purely informational, not a required check.

#### When the comment fires

- On `pull_request: opened` — write the initial estimate comment with current Stage A signals + class assignment + state token.
- On `pull_request: synchronize` (force-push, push-to-PR-branch) — recompute `estimateInputHash`; if changed, edit the comment with the new estimate + bump the timestamp.
- On `pull_request: closed` (merged) — append the actual bucket + final variance summary in the same edit.

## 10. Schema Changes

- New `$ARTIFACTS_DIR/_estimates/log.jsonl` — captured estimates (raw entries; same-hash batches identified by `estimateInputHash`)
- New `$ARTIFACTS_DIR/_estimates/calibration-YYYY-MM.jsonl` — predicted vs actual paired records, **rotated monthly per Q4** so future roll-up has natural batch boundaries
- New `$ARTIFACTS_DIR/_estimates/EstimateInputChanged.jsonl` — content-hash-transition log (Q5)
- New `.ai-sdlc/schemas/estimate.v1.schema.json` — JSON Schema for log + calibration files
- New `.ai-sdlc/estimate-classes.yaml` — class ontology with full structure (definition + exemplars + anti_patterns + synonyms) per Q3; ships with 3 starter classes (`bug` / `feature` / `chore`)
- New `.ai-sdlc/estimate-classes-proposed.jsonl` — append-only log of LLM-proposed new classes pending operator review (Q3)
- New `.ai-sdlc/estimate-buckets.yaml` — operator-tunable bucket boundaries per Q1; **whole-replace** semantics (no merge with §4.1 defaults)
- Extension to RFC-0015 `events.jsonl`: new event types `EstimateCaptured`, `EstimateInputChanged`, `EstimateBiasApplied`, `EstimateBiasOverCorrected`

### 10.1 Concurrency contract for log + cache writers (AISDLC-328)

PR #498 (AISDLC-280, Phase 2) round-1 review surfaced two latent race conditions in the writers below. Both are dormant when `cli-orchestrator` runs at `maxConcurrent: 1` (the Phase 1-4 default) but **activate in Phase 5** when the orchestrator raises concurrency or when a scripted parallel-estimation sweep fires. The hardening contract is documented here so Phase 5 implementers don't have to re-derive it.

#### Estimate-log writer — append-only with per-row discriminator

`captureEstimate()` writes one JSONL line per call to `_estimates/log.jsonl` via `fs.appendFileSync`. The contract:

- **Atomic append**: `appendFileSync` uses POSIX `O_APPEND` semantics. Sub-PIPE_BUF writes (4 KiB on macOS/Linux) are syscall-atomic — concurrent appends never interleave, so the file is always parseable as one JSON object per line. Typical estimate rows are well under 4 KiB.
- **Per-row uniqueness via `runDiscriminator`**: the writer mints a strictly-monotonic `${epochMs}-${pid}-${seq}` string on every call. The combination of pid (separates processes), epoch-ms (separates seconds-scale events) and a process-local sequence counter (separates sub-millisecond events within one process) guarantees uniqueness even under heavy concurrent capture. Phase 3+ ensemble aggregation MUST key on `runDiscriminator` (not `runIndex`) when distinguishing physical rows.
- **`runIndex` is now a best-effort display ordinal**: the legacy `runIndex` field is derived from a lock-free scan-and-count; concurrent same-hash captures CAN produce duplicate `runIndex` values. Use `(taskId, estimateInputHash)` for ensemble grouping (the existing `computeEnsembleVarianceForHash()` already does this) and `runDiscriminator` for per-row identity.

#### Class-assignment cache — file lock + atomic-rename writes

`assignClassCached()` reads `_estimates/class-assignments.json`, mutates the in-memory map, and writes the full file back. The contract:

- **Cross-process file lock**: a sibling `class-assignments.json.lock` is acquired via `open(path, 'wx')` (O_CREAT | O_EXCL) before the read-mutate-write critical section. First caller wins; concurrent attempts retry until the lock is released or the deadline (5s default) expires. Stale locks (>30s old) are forcibly cleared so a crashed estimator can't deadlock the cache.
- **Atomic rename for tear-free reads**: `writeCache()` writes the JSON to a sibling `<file>.tmp.<pid>.<epochMs>` first, then `rename(2)`s onto the target. Readers see either the old or the new file — never a partially-written one.
- **Fast-path lock-free read**: when the cache already has a fresh-`contentHash` entry for the requested `taskId`, the function returns without acquiring the lock (the common case stays cheap).
- **Best-effort fallback**: if the lock cannot be acquired within the deadline, the writer degrades to lock-free last-writer-wins rather than throwing. This protects the pipeline against a degraded filesystem at the cost of accepting a rare lost-entry under extreme contention (operators detect this via re-classification frequency in the calibration log).

#### Out of scope (Phase 6+)

- Cross-machine coordination (NFS-safe locks, etcd, etc.). Dogfood runs every estimator on one machine; the single-machine lock is sufficient.
- Migration to a real KV store (sqlite, etc.). The JSONL log + JSON cache file model is sufficient at dogfood-scale parallel-dispatch volumes.

The hardening lives in `pipeline-cli/src/estimation/{log-writer,cache,fs-lock}.ts` with hermetic concurrency tests under `pipeline-cli/src/estimation/concurrency.test.ts` (N=50-100 parallel calls via `Promise.all`).

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
| **Phase 1: Stage A signals (deterministic) + class-default fallback** | 1.5 wk | `cli-estimate stage-a <task-id>` command; collectors for the **6 cheap signals** (file scope, blocked paths, file-type breakdown, dependency depth, coverage requirement, LOC delta from planning) **PLUS signal #9: class-default fallback** (Q8 resolution — when historical actuals signal #2 returns `unknown`, fall back to the catalogue median per class); pure-function bucket-lookup table; seed class-default buckets for the 3 starter classes (`bug` → S, `feature` → M, `chore` → S) | `cli-estimate stage-a AISDLC-X` returns the candidate bucket + per-signal breakdown for any task in the backlog. No LLM calls. Class-default fallback fires when n<5 for the class. |
| **Phase 2: Capture** | 0.5 wk | Estimate-log writer; record Stage A multiset + final bucket + `estimateInputHash` (Q5); wire to RFC-0015 events.jsonl; class-assignment LLM call cached on first use (Q3) | 100% of agent estimates appear in log.jsonl with stageA + finalBucket + estimateInputHash + class fields |
| **Phase 3: Measurement** | 1 wk | Actuals collector; **monthly-rotated** calibration.jsonl writer (Q4); non-work-time exclusion logic; signal #2 (historical actuals) becomes populated as data flows in; class-default seed values **retire gracefully** as real signal #2 takes over | For ≥10 completed tasks, calibration-YYYY-MM.jsonl has paired predicted/actual records; signal #2 starts producing non-`unknown` values once n≥5 per class; class-default fallback rate drops as calibration data accumulates |
| **Phase 4: Stage B (LLM tie-breaker) + Q5 ensemble** | 1 wk | Stage B prompt builder; only invoked when Stage A escalates per §5.2 OR when same-hash variance ≥ 2 buckets per §8.4; full Stage A signal table passed as context per §6.1; ensemble batch aggregation writes `estimateVariance` per hash transition | When Stage A signals split across non-adjacent buckets OR ensemble variance ≥ 2, Stage B receives the full table + returns one bucket or 2-bucket range with justification |
| **Phase 5: Per-class bias adjustment + state token + PR comment** | 1 wk | Bias-multiplier computation across Stage A + Stage B verdicts; per-agent stratification via `predictedBy` (Q2); `cli-estimates show <class>` command; **3-state token enum formatter** (Q6 — `uncalibrated`/`warming`/`calibrated`) shared across CLI/dashboard/Slack/PR-comment surfaces; **bot PR comment writer** with `<!-- ai-sdlc:estimate -->` marker (Q7) | `cli-estimates show feature` returns mean/median bucket-miss + Stage-A-vs-Stage-B accuracy comparison; PR opened from worktree gets a bot estimate comment within 30s of `pull_request: opened` |
| **Phase 6: Soak + drift detection + class proposals** | corpus-driven, NOT calendar-gated | `EstimateBiasOverCorrected` event; weekly calibration digest; metrics on Stage-A-coverage (% of estimates that bypass Stage B entirely); `cli-estimate-classes review` for operator approval of LLM-proposed new classes (Q3); auto-promotion when ≥3 proposals of same shape accumulate | Promotion when 95%+ of 1-bucket misses + < 5% of 3-bucket misses across 50 estimates AND Stage-A-coverage >70% AND class-proposal queue is operator-actionable |

Total wall-clock: ~5 weeks for Phase 1-5. Phase 6 corpus-driven per maintainer directive 2026-05-01.

Critical path: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6. **Stage A (Phase 1) must ship before Capture (Phase 2)** — capturing estimates without the Stage A signals would lock in the LLM-only baseline we're trying to escape.

## 14. Composes With

- **RFC-0011** (DoR calibration log) — same JSONL pattern; same calibration-loop philosophy
- **RFC-0014** (dependency graph) — `effectivePriority` could fold in estimated cost (XS leaf is cheaper to dispatch than XL leaf)
- **RFC-0015** (orchestrator) — `events.jsonl` is the actuals source; orchestrator's capacity planner uses calibrated estimates for "can I fit 3 more M-bucket tasks before off-peak ends?"
- **RFC-0010** (subscription scheduling) — bucket-class × calibrated time = predicted token cost per task; SubscriptionLedger uses this for window planning

## 15. Resolutions

The 8 open questions from v2 were walked through in operator session on 2026-05-03. All 8 are resolved. Q1, Q2, Q4, Q7, Q8 ACCEPT the v2 lean (with refinements noted below). **Q3, Q5, Q6 are SUBSTANTIVE UPGRADES that change the design** — see the corresponding section updates in §6.1 (Q3), §8.4 (Q5), §7.3 (Q6), and §9a (Q7). Summary table:

| # | Question | Resolution |
|---|---|---|
| Q1 | Operator-tunable bucket boundaries | **ACCEPT lean.** `.ai-sdlc/estimate-buckets.yaml` ships as the operator-control surface. **Whole-replace semantics** — operator yaml is the full bucket set, no merge with §4.1 defaults. Eliminates a "did this override merge correctly?" debugging class. |
| Q2 | Multi-agent estimate calibration | **ACCEPT (a) per-agent.** Operator estimate stays uncalibrated **forever** — operator IS the ground truth, not a calibration target. Schema's `predictedBy` field enables per-agent stratification. Don't blend across agents until n ≥ 30 paired estimates per agent. |
| Q3 | Task-class taxonomy | **SUBSTANTIVE UPGRADE — ontology pattern with confidence gates.** See updated §6.1. Ship **3 starter classes** (`bug` / `feature` / `chore` — empirical convergent core), each with full ontology structure (definition + exemplars + anti_patterns + synonyms). Class assignment is **LLM-based** (separate fuzzy-classification step from Stage A bucket lookup). LLM output: `{class, confidence, rationale}`. **Confidence gates:** ≥0.90 auto, 0.70–0.89 log-for-review, <0.70 fall-back to `uncategorized` (excluded from calibration). LLM may PROPOSE new classes; operator approves via `cli-estimate-classes review`; auto-promote on weekly batch when ≥3 same-shape proposals accumulate. Triad theme (3 classes ↔ 3 reviewers ↔ 3 stages) preserved. |
| Q4 | Calibration log retention | **ACCEPT structural intent, defer roll-up.** Raw forever in practice; roll-up spec'd but **NOT built in Phase 2**. `calibration.jsonl` writer rotates monthly (`_estimates/calibration-2026-05.jsonl`) so a future roll-up has natural batch boundaries. Per-class median over the last 30 days OR last 20 estimates from §9.1 doesn't need roll-up — JSONL streamed line-by-line handles it fine. If/when storage becomes a real constraint, build the roll-up; until then, raw queryability beats premature aggregation. |
| Q5 | Mid-task estimate revisions | **SUBSTANTIVE UPGRADE — ensemble sampling with content hashing.** See new §8.4. Replace single-shot `EstimateRevised` event with `estimateInputHash = sha256(taskTitle + taskDescription + stageA_signals + classAssignment)`. Same-hash multiple estimates aggregate as ensemble (median bucket; `estimateVariance = max−min`). Variance ≥ 2 buckets escalates to Stage B or operator review (variance-as-confidence-proxy). Variance ≤ 1 bucket accepts the median. Different-hash starts a fresh ensemble; previous-hash entries stay in log but don't aggregate. `EstimateInputChanged` event logs hash transitions. Schema gains `estimateInputHash`, `runIndex`, `estimateVariance`. |
| Q6 | Cold-start confidence messaging | **SUBSTANTIVE UPGRADE — Option B (revised) with state token enum.** See updated §7.3. **Three states:** `uncalibrated` (n=0), `warming` (1≤n<5, format `(warming, n=N)`), `calibrated` (n≥5, format `(calibrated, n=N, bias=±X%)`). **Drops the `/5` denominator** that confused once n exceeded threshold. **Variance qualifier appendable** (Q5 connection): when `estimateVariance ≥ 2`, append `; high-variance` even when calibrated. **Operator overrides count as samples** with `source: 'override'` weighted equally with model samples. **Three surfaces share one format** (PR comment Q7, CLI, dashboard, Slack). |
| Q7 | Estimates surfaced in PRs | **ACCEPT — Option D (bot comment).** See new §9a. **Bot-posted PR comment** (NOT PR template field, NOT freeform body text). Idempotent marker `<!-- ai-sdlc:estimate -->` (re-uses AISDLC-142 marker pattern). Trusted-author filter reuse from AISDLC-142 (external contributors can't forge fake estimates). Comment payload renders the Q6 state token. Comment EDITS naturally support Q5 ensemble revisions (no PR-description rewrite needed). |
| Q8 | Stage A signals shipped in Phase 1 | **ACCEPT — Option B with class-default fallback.** See updated §13 Phase 1. Ship the **6 cheap signals** (file scope, blocked paths, file-type breakdown, dep depth, coverage requirement, planning LOC delta) **PLUS new signal #9: class-default fallback** — when historical actuals (signal #2) returns `unknown`, fall back to the catalogue median per class. **Seed values:** `bug` → S, `feature` → M, `chore` → S. These retire gracefully once real signal #2 calibration data flows in Phase 3 — no architectural debt. Cheap-specific signals (file scope, etc.) override class-default when they disagree. |

## 16. References

- RFC-0011 — Definition-of-Ready Gate (calibration-log JSONL pattern this RFC mirrors)
- RFC-0015 — Autonomous Pipeline Orchestrator (events.jsonl actuals source; orchestrator capacity-planning consumer)
- Original conversation with @dominique establishing the need (2026-05-01): "we need a system where you can start to calibrate your estimates against actual data ... story points or t-shirt sizes ... see if we are off by a factor of 2x then adjust our estimates based on our bias."
- Industry pattern: agile story-point + t-shirt-size estimation — Mike Cohn, _Agile Estimating and Planning_ (2005)
