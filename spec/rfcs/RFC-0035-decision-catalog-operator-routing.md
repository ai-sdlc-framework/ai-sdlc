---
id: RFC-0035
title: Decision Catalog and Operator Decision Routing
status: Draft
lifecycle: Implemented
author: Dominique Legault
created: 2026-05-08
updated: 2026-05-27
targetSpecVersion: v1alpha1
requires: [RFC-0011, RFC-0023, RFC-0024, RFC-0025, RFC-0029]
# Strategic / framework RFC. User-facing surfaces (operator runbook, API reference)
# land at sign-off; intentionally empty at Draft stage.
requiresDocs: []
implementedBy:
  - AISDLC-285 (Phase 1 — Decision schema + cli-decisions)
  - AISDLC-286 (Phase 2 — Stage A scorer + dep-graph blast-radius)
  - AISDLC-287 (Phase 3 — Stage B rubric + actor routing)
  - AISDLC-288 (Phase 4 — DoR integration + clarification decisions)
  - AISDLC-289 (Phase 5 — Stage C LLM classifier + calibration corpus)
  - AISDLC-290 (Phase 6 — Decision support surface)
  - AISDLC-291 (Phase 7 — Capacity + fatigue config)
  - AISDLC-292 (Phase 8 — TUI decisions pane + multi-surface notify)
  - AISDLC-293 (Phase 9 — Override-driven calibration loop)
  - AISDLC-294 (Phase 10 — Research subagent + visual graphs)
  - AISDLC-295 (Phase 11 — Promotion runbook)
---

<!-- ai-sdlc:lifecycle-jump-approved-by:deefactorial reason:All 14 OQs resolved in §15 (operator walkthrough 2026-05-15). All 11 implementation phases shipped (AISDLC-285..295 — see implementedBy frontmatter). Engineering + Operator sign-offs complete (signed today via PR #742). Product Authority box still pending but not gating per project_team_roles (operator owns Engineering + Operator authority). Lifecycle ladder skip (Ready for Review → Implemented) authorized because: (a) all phases shipped and merged, (b) Engineering + Operator authority concurs, (c) AISDLC-447 timebox enhancement is a documented follow-up not a gating gap. -->


# RFC-0035: Decision Catalog and Operator Decision Routing

**Status:** Draft (v0.2 — all 14 OQs resolved via operator walkthrough 2026-05-15; §15.1 Design Patterns codifies the architectural coherence)
**Lifecycle:** Ready for Review (14/14 OQs resolved; awaiting per-owner sign-off)
**Author:** Dominique Legault
**Created:** 2026-05-08
**Updated:** 2026-05-15
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [x] Engineering owner — Dominique Legault (2026-05-27 — all 14 OQs resolved per §15 walkthrough 2026-05-15)
- [ ] Product owner — Alexander Kline (pending)
- [x] Operator owner — Dominique Legault (2026-05-27 — all 14 OQs resolved per §15 walkthrough 2026-05-15)

## Table of Contents

1. [Summary](#1-summary)
2. [Motivation](#2-motivation)
3. [Goals and Non-Goals](#3-goals-and-non-goals)
4. [The Decision Resource](#4-the-decision-resource)
5. [Deterministic-First Evaluation Ladder](#5-deterministic-first-evaluation-ladder)
6. [Actor Routing Rubric](#6-actor-routing-rubric)
7. [Capacity and Fatigue Model](#7-capacity-and-fatigue-model)
8. [Decision Support Surface](#8-decision-support-surface)
9. [Calibration](#9-calibration)
10. [Composition with Other RFCs](#10-composition-with-other-rfcs)
11. [Schema Sketch (Illustrative)](#11-schema-sketch-illustrative)
12. [Backward Compatibility](#12-backward-compatibility)
13. [Alternatives Considered](#13-alternatives-considered)
14. [Implementation Plan](#14-implementation-plan)
15. [Open Questions](#15-open-questions)
16. [References](#16-references)

---

## 1. Summary

This RFC operationalizes [`VISION.md`](../../VISION.md) §3 (operator-as-decision-steward) by making the operator's decision queue a **first-class resource**. Today, open questions live as scattered markdown bullets across individual issues, RFC bodies, DoR clarifications, and emergent findings — there is no global view, no priority signal, no actor-routing rubric, and no decision-support surface beyond the operator's intuition and Claude Code's basic options prompt.

This RFC introduces:

1. A **`Decision` resource type** with a stable schema and source-of-truth catalog
2. A **deterministic-first evaluation ladder** modeled on [RFC-0011 §4.4](RFC-0011-definition-of-ready-gate.md) and the [review-calibration system](../../docs/api-reference/review-calibration.md): structural checks first, rubric scoring second, LLM as last resort
3. An **actor-routing rubric** keyed off [RFC-0029](RFC-0029-product-pillar-architectural-vision.md)'s pillar model that decides who answers what
4. A **capacity model** that respects operator decision fatigue rather than treating the operator as a queue worker
5. A **decision-support surface** that goes beyond options-only prompts: framework recommendation, counter-arguments, sub-decision graphs, on-demand research subagents
6. A **calibration loop** mirroring [RFC-0031](RFC-0031-calibration-driven-did-revision-proposal.md) that learns from operator overrides

The catalog is the data model the [Operator TUI (RFC-0023)](RFC-0023-operator-tui-pipeline-monitoring.md) reads when it foregrounds decisions-pending. RFC-0023 owns the surface; this RFC owns what's surfaced.

## 2. Motivation

### 2.1 The cost-asymmetry premise needs a queue

`VISION.md` §2 makes the framework's leverage move explicit: operator decisions made upfront are cheap and (mostly) correct; AI decisions made under uncertainty mid-execution are expensive and often wrong. Frontloading the operator's thinking is the entire game.

For frontloading to work, the operator must be able to **see the queue of upcoming decisions ranked by leverage**. Today they cannot. Open questions are buried in:

- RFC body sections (`§13 Open Questions` markdown bullets in 15+ active RFCs)
- Issue acceptance-criteria markup (`OQ-3:` style annotations)
- DoR clarification rounds (RFC-0011) — currently surfaced only at admission, not catalogued
- Emergent findings during execution (RFC-0024) — captured per-issue, not aggregated
- In-flight subagent prompts that escalated mid-run

Without a catalog the operator is forced to either (a) skim every artifact looking for OQs, or (b) wait for the framework to surface decisions one at a time at admission/execution time — the worst possible moment per the cost-asymmetry argument.

### 2.2 Decision fatigue is a real constraint, not a metaphor

Recorded operator memory (`feedback_decision_fatigue_signal.md`): when the operator declares fatigue, the framework MUST stop walkthrough-style OQ asks and switch to mechanical-only mode. This is not an edge case — it's a regular occurrence in long sessions, and it directly contradicts the framework's tendency to surface every uncertain decision the moment it appears.

A decision system that ignores capacity violates the operator's stated preference and burns trust. The Decision Engine framing in `VISION.md` §3 implicitly assumes the operator has unbounded decision throughput; in practice they don't, and the framework needs to model that.

### 2.3 The current decision-prompt UX is too low-fidelity

Claude Code's `AskUserQuestion` (and the framework's various clarification prompts) presents 2–4 labeled options with one-line descriptions. This is sufficient for trivial choices but insufficient for load-bearing decisions where the operator needs:

- A **framework recommendation** with its rationale and confidence
- **Counter-arguments** to the recommendation (steel-manned alternatives)
- **Sub-decisions** that follow from each option (some options open new decision trees; the operator should see this before committing)
- **On-demand research** ("what do other systems do here?") spawned as a side-task, not blocking
- **Visual representations** of the decision graph for non-trivial branching

Existing prompts compress all of this into "pick A, B, or C." The result is the operator either rubber-stamps the first option that looks reasonable or burns 20 minutes mentally reconstructing context the framework already had.

### 2.4 The framework already has the building blocks

This RFC is largely about **composition**, not invention. The deterministic-first ladder is RFC-0011's contribution. Confidence-tiered LLM filtering is the review-calibration contribution. Pillar-keyed actor routing is RFC-0029's contribution. Calibration-via-exemplars is the review-calibration + RFC-0031 contribution. Operator-foregrounded decision surface is RFC-0023's contribution. What's missing is the **resource type and the routing rubric** that ties them together.

## 3. Goals and Non-Goals

### 3.1 Goals

- **G0 — Non-Blocking Pipeline Contract.** The Decision Catalog substrate guarantees **zero pipeline-halting events**. Every potential operator interruption is logged as a `Decision` record with an auto-resolution policy (per Stage A/B/C confidence) OR a timeboxed default-on-silence action (per [RFC-0024 §15.1](RFC-0024-emergent-issue-capture-and-triage.md) lifecycle-defaults convention). The operator's role is decision *stewardship* — reviewing prioritized batches retroactively and exercising 24h override windows — not decision *throughput*. Implementation tasks continue against their dispatched-version contract while Decisions resolve asynchronously. Throughput rigor and decision rigor are orthogonal axes; the catalog's job is to make both maximal simultaneously.

    **Anti-patterns explicitly prohibited under G0:**
    - "Block PR / task / pipeline-tick until operator confirms" — every such case MUST be re-shaped as a Decision with auto-resolution or timeboxed default-on-silence.
    - "Halt admission on missing operator input" — instead, refuse via a Decision-Catalog-emitted clarification task back upstream; pipeline continues on whatever else is dispatchable.
    - "Real-time prompt at the moment of decision" — the catalog batches + prioritizes; the operator processes asynchronously.
    - "Single blocking-event surface" — there is no such thing in this framework. If a design surfaces one, it routes through the catalog instead.

    G0 is **measurable** by RFC-0025: every `decision-routed-to-operator-unnecessarily` event is a `framework-misbehaved` sub-class that closes the calibration loop on this contract. See §10 for the audit-dep relationship.

- **G1.** Catalog every open decision across the workspace as a `Decision` resource with a stable schema and a single source-of-truth location.
- **G2.** Score each `Decision` deterministically first, structurally second, with an LLM only as a last resort — same ladder as RFC-0011 §4.4 and review-calibration.
- **G3.** Route each `Decision` to a specific actor (or to the framework, when LLM-eligible) using an explicit, auditable rubric.
- **G4.** Foreground the operator's highest-leverage decisions while respecting daily capacity and fatigue signals.
- **G5.** Surface each `Decision` with first-class support: recommendation + confidence, counter-arguments, sub-decision graph, optional research subagent, optional visual rendering.
- **G6.** Calibrate routing and LLM-eligibility against labeled exemplars and operator-override events, mirroring the review-calibration feedback loop.
- **G7.** Be invisible when the work is mechanical: routine decisions auto-decide; only load-bearing decisions reach the operator.

### 3.2 Non-Goals

- **N1.** Replacing Claude Code's `AskUserQuestion` tool. This RFC defines the framework's operator-decision surface; in-IDE prompts continue to use Claude Code's native UX. (Note: per G0, `AskUserQuestion` is only used when the catalog has *already* prioritized and surfaced a Decision — never as a real-time pipeline interrupt.)
- **N2.** Auto-deciding load-bearing decisions without operator sign-off. Per `VISION.md` §6 ("You decide. We don't override."), the framework recommends; the operator decides. (G0 still applies: load-bearing decisions sit in the prioritized queue with timeboxed defaults; they don't halt the pipeline.)
- **N3.** Cross-organization actor routing. Single-workspace v1, mirroring [RFC-0023 §10](RFC-0023-operator-tui-pipeline-monitoring.md) (single-workspace OQ resolution).
- **N4.** Generating the operator UI itself. RFC-0023 owns the TUI; this RFC owns the data the TUI reads.
- **N5.** Replacing RFC-0011's DoR rubric. DoR clarifications **feed** the catalog as `Decision` records; the rubric stays.
- **N6.** Replacing the backlog issue model. A `Decision` is not an `Issue`; some decisions produce issues (or RFC amendments) when answered, but most do not.
- **N7.** Adopter-side blocking events. Adopters' downstream tooling (CI, IDE, etc.) is outside this RFC's scope — they may have their own real-time interrupt surfaces. The framework's contract under G0 is: pipeline operations *the framework owns* (orchestrator tick, task dispatch, admission, attestation, merge) never halt on operator decisions; the catalog absorbs all of them.

## 4. The Decision Resource

A **`Decision`** is a single open question that requires resolution before some downstream work can proceed (or, for non-blocking decisions, that the operator should be aware of).

### 4.1 Where decisions come from

| Source | Generator | Example |
|---|---|---|
| `dor-clarification` | RFC-0011 DoR gate | "Which auth flow does 'fix login' refer to?" |
| `rfc-open-question` | RFC body §Open Questions section | OQ-3 in this RFC |
| `emergent-finding` | RFC-0024 emergent capture | "Spawner returned empty stdout — investigate before re-dispatch?" |
| `framework-calibration` | RFC-0031 calibration loop | "DID drift exceeds threshold — propose revision?" |
| `subagent-escalation` | Mid-execution operator ask | "Should this PR depend on AISDLC-237 or be independent?" |
| `ad-hoc` | Operator-authored directly | "Should we adopt approach X for the next sprint?" |

The catalog **projects** from these sources where possible and stores its own records where projection would lose history (e.g. operator override events).

### 4.2 Lifecycle

```
proposed → open → (deferred) → answered → (superseded)
                       │
                       └→ archived (ttl expired without resolution)
```

- **proposed** — generator emitted the decision; not yet validated against schema
- **open** — schema-valid; eligible for routing and surfacing
- **deferred** — operator explicitly snoozed (with reason + revisit-by); does not appear in active queue
- **answered** — resolved with a chosen option, signed by the assigned actor; immutable
- **superseded** — replaced by a later decision (e.g. operator changed mind after new evidence)
- **archived** — open past TTL with no resolution; surfaces as a stale-decision report

## 5. Deterministic-First Evaluation Ladder

The ladder mirrors RFC-0011 §4.4 (DoR Stage A → Stage B → Stage C) and the review-calibration confidence-tier pattern. The architectural rule is the same: **never invoke an LLM for something a regex, a graph traversal, or a rubric can answer**.

### 5.1 Stage A — Deterministic checks (no LLM)

For every `Decision`, run these checks first:

| Check | Mechanism | Output |
|---|---|---|
| Schema validity | JSON-schema + ref resolution | valid / invalid + reasons |
| Blast radius | RFC-0014 dep-graph traversal | `blockedTaskCount`, `blockedRfcCount`, `affectedPillars[]` |
| Reference resolution | `gh api` HEAD checks for linked artifacts | resolved / broken |
| Decision-tree depth | Static analysis of declared `subDecisions[]` | integer 1..N |
| Capacity arithmetic | Compare proposed actor's remaining daily budget | within budget / over budget |
| Reversibility | Pattern-match against tagged-irreversible categories (e.g. `db-migration`, `public-api`, `merge-conflict-resolution`) | reversible / one-way / unknown |
| Duplicate detection | Levenshtein + normalized-summary against open decisions | unique / candidate-dup |

Stage A produces a **deterministic priority signal** in `[0, 1]` and an unambiguous routing actor when one exists. ~60% of decisions resolve their routing here without any rubric or LLM step.

### 5.2 Stage B — Structural rubrics (small LLM only for explicit subjective sub-scores)

For decisions that pass Stage A but lack an unambiguous routing or priority, score on four dimensions. Each is a 4-point rubric (0–3); each sub-score is deterministic where possible and uses a small LLM (Haiku-class, single-turn, exemplar-anchored) for explicitly subjective dimensions.

| Rubric | Dimensions | Determinism |
|---|---|---|
| **Load-bearing-ness** | reversibility, blast radius, downstream-decision count, deadline-criticality | 3 of 4 deterministic; reversibility may need LLM for novel categories |
| **LLM-confidence** | exemplar-similarity score, RFC-stated-position presence, evidence-completeness, novelty-vs-history | 3 of 4 deterministic; novelty is LLM-assessed against exemplars |
| **Actor-fit** | declared-pillar match, override-history fit, capacity availability, expertise-tag match | fully deterministic given pillar tagging from RFC-0029 |
| **Cost-of-block** | `blockedTaskCount × tier`, deadline distance, downstream-PR count | fully deterministic from dep graph |

Each rubric produces a 0–1 normalized score with rationale. The rubric prompts (when LLM is invoked) ship in `.ai-sdlc/decision-principles.md` and are anchored to `decision-exemplars.yaml` — same pattern as `review-principles.md` + `review-exemplars.yaml`.

### 5.3 Stage C — LLM as last resort

Stage C fires **only** when Stage A + Stage B leave a confidence gap in the mid-band (recommended: 0.4–0.7). The LLM call is single-turn and structured-output:

```typescript
interface DecisionEvaluation {
  recommendation: { optionId: string; confidence: number; rationale: string };
  alternativesConsidered: Array<{ optionId: string; pros: string[]; cons: string[] }>;
  counterArguments: string[];                    // steel-manned objections to the recommendation
  subDecisionsImplied: Array<{ optionId: string; followUp: string }>;
  routingRecommendation?: { actor: string; rationale: string };
  llmAnswerEligible: boolean;                    // true → framework can auto-decide if confidence ≥ threshold
}
```

The LLM receives `decision-policy.md`, `decision-principles.md`, the relevant exemplars, the Stage A + Stage B output, and the decision body. It does **not** receive the option-to-pick — it produces a recommendation independently.

### 5.4 Confidence thresholds (mirroring review-calibration)

| Composite confidence | Action |
|---|---|
| ≥ 0.8 + LLM-eligible + reversible | Framework auto-decides; logs to operator digest (post-fact, never foreground) |
| ≥ 0.8 + load-bearing | Surface to operator with strong recommendation pre-filled; operator confirms or overrides |
| 0.5 – 0.8 | Surface with recommendation + counter-arguments; operator decides |
| < 0.5 | Surface with options + research suggestions, no recommendation; operator decides |

Auto-decided decisions are **always reviewable** in the digest. Operator override of an auto-decision is a calibration signal (§9).

## 6. Actor Routing Rubric

### 6.1 Pillar model

Reuses [RFC-0029](RFC-0029-product-pillar-architectural-vision.md)'s three-pillar model:

- **Engineering** — implementation, architecture, performance, technical correctness
- **Product** — strategy, scope, audience, prioritization
- **Design** — user experience, visual identity, interaction patterns

The **Operator** role spans pillars and handles cross-pillar decisions and meta-framework decisions.

### 6.2 Routing rubric

```
single-pillar decision           → assign to that pillar's owner
multi-pillar decision            → assign to operator (or to a primary pillar if one is clearly dominant)
LLM-eligible per Stage A+B       → assign to framework (auto-decide); operator sees in digest
load-bearing + ambiguous pillar  → assign to operator with escalation note
```

The current owner mapping (operator-configurable, defaults shown):

```yaml
pillarOwners:
  engineering: Dominique Legault
  product:     Alexander Kline
  design:      morgan@<...>
operator:      Dominique Legault
```

### 6.3 Override surface

The assigned actor (or operator) can **re-route** any decision. Re-routes are calibration signals — repeated operator re-routes from pillar X to pillar Y indicate the rubric's pillar tagging is wrong for that decision class.

## 7. Capacity and Fatigue Model

### 7.1 Daily decision budget

Each actor has a per-day decision budget, expressed as:

```yaml
capacity:
  large:  { perDay: 3,  estMinutes: 30 }
  medium: { perDay: 8,  estMinutes: 10 }
  small:  { perDay: 25, estMinutes: 2 }
```

Decision tier is assigned at Stage B (load-bearing-ness rubric output). When the assigned actor's budget is full for a tier, new decisions of that tier are **deferred to the next day** (priority decay applies).

### 7.2 Fatigue signal

The framework switches to **mechanical-only mode** when:

1. **Explicit signal** — operator declares fatigue ("I'm exhausted", "no more decisions today", or via TUI command)
2. **Inferred signal (cautious)** — operator override rate exceeds threshold (e.g. > 50% in last hour) OR decision throughput drops > 60% from rolling baseline

Mechanical-only mode behavior:

- **Defer** all medium and large decisions to next day
- **Auto-decide** small + LLM-eligible + reversible decisions only
- **Surface** only blocking-critical small decisions (reversibility = one-way + deadline = today)
- **Suppress** all walkthrough-style multi-question prompts

The framework MUST NOT pretend a capacity-overrun decision was decided when it was actually pushed past the operator under fatigue. Decisions made in fatigue mode are flagged for re-review the following day.

### 7.3 Why a model and not a knob

Capacity could be a single setting ("how many decisions per day"). Modeling tiers + fatigue signal lets the framework be smart about *which* decisions to defer rather than uniformly throttling. A blanket throttle either over-throttles (defers an urgent small decision) or under-throttles (asks a 30-minute architectural decision when the operator has been at it for 8 hours).

## 8. Decision Support Surface

For every operator-routed decision, the framework generates a **decision view** with:

### 8.1 Always-on elements

- **Title + body** — the decision as authored
- **Options table** — each option with `description`, `consequences[]`, `dependents[]`, `subDecisions[]`
- **Framework recommendation** — option-id + confidence + rationale (from Stage C, or "no recommendation" if confidence < 0.5)
- **Counter-arguments** — steel-manned objections to the recommendation (LLM-generated; explicitly labeled as such)
- **Routing rationale** — why this decision was assigned to this actor
- **Stage A/B/C audit** — full deterministic + rubric output, expandable

### 8.2 On-demand elements

- **Research subagent** — operator can spawn a research task ("compare how Kubernetes / Argo / Buildkite handle X") that runs async and posts findings into the decision view
- **Sub-decision graph** — visual rendering of the decision tree implied by each option (text outline → Mermaid diagram → optional richer rendering, phased)
- **Infographic** — NotebookLM-style generated infographic for non-trivial branching decisions (Phase 8; behind feature flag)

### 8.3 Why this is more than a richer prompt

The framework already has all of this context internally — the dep graph, the pillar model, the exemplars, the OQ history. Without the decision view, the operator either re-derives it or decides without it. The decision view's job is to surface what the framework already knows in a form the operator can metabolize in seconds rather than minutes.

## 9. Calibration

Mirrors the review-calibration files (`review-policy.md`, `review-principles.md`, `review-exemplars.yaml`):

| File | Purpose |
|---|---|
| `.ai-sdlc/decision-policy.md` | Top-level rule (operator decides load-bearing; framework decides routine; reversibility tags); routing defaults; capacity defaults |
| `.ai-sdlc/decision-principles.md` | Durable principles (deterministic-first; respect fatigue; surface counter-arguments by default; explain auto-decisions in digest; never auto-decide one-way decisions) |
| `.ai-sdlc/decision-exemplars.yaml` | Labeled past decisions: correctly-routed, mis-routed-by-framework, operator-overrode-recommendation, fatigue-deferred-correctly |

### 9.1 Auto-exemplar generation

Every operator override of a framework recommendation becomes a candidate exemplar. The framework files them into a `pending-exemplars.yaml` for operator review (per RFC-0031's calibration-driven proposal pattern). Operator promotes accepted exemplars into `decision-exemplars.yaml`; rejected ones are noted with rationale (also a calibration signal).

### 9.2 Feedback store

A `DecisionFeedbackStore` (parallel to `ReviewFeedbackStore` in review-calibration) tracks:

- Operator override events
- Decision-time-to-resolve per tier
- LLM auto-decision precision (operator agrees / overrides)
- Routing precision (operator re-routes / accepts routing)
- Fatigue-mode entries and their triggers

Aggregated metrics surface in the operator analytics pane (RFC-0023 §6).

## 10. Composition with Other RFCs

| RFC | Role | This RFC's relationship |
|---|---|---|
| [RFC-0011](RFC-0011-definition-of-ready-gate.md) DoR Gate | Generates `Decision` records from clarification rounds | Upstream feeder; deterministic-first ladder model |
| [RFC-0014](RFC-0014-dependency-graph-composition.md) Dep Graph | Provides blast-radius computation | Stage A input |
| [RFC-0023](RFC-0023-operator-tui-pipeline-monitoring.md) Operator TUI | Surfaces the catalog (decisions-pending pane) | Downstream consumer; this RFC defines the data |
| [RFC-0024](RFC-0024-emergent-issue-capture-and-triage.md) Emergent Capture | Some emergent findings produce decisions, not issues | Upstream feeder |
| [RFC-0025](RFC-0025-framework-quality-monitoring.md) Quality Monitoring | **Hard runtime dep for Phase 7 (fatigue signal) + Phase 9 (calibration loop).** Audits Decision Catalog routing for `decision-routed-to-operator-unnecessarily` events — a `framework-misbehaved` sub-class that measures whether the catalog is keeping its G0 non-blocking contract. | Without this dep, G0 is unenforced (unmeasurable). RFC-0025 §5.2's `framework-misbehaved` taxonomy extends with `decision-over-blocked`, `decision-mis-routed-to-operator`, `decision-confidence-mis-tuned` sub-classes; events feed the calibration corpus that tunes the Stage C confidence threshold over time. |
| [RFC-0029](RFC-0029-product-pillar-architectural-vision.md) Product Pillar | Provides the actor model | Routing rubric input |
| [RFC-0031](RFC-0031-calibration-driven-did-revision-proposal.md) Calibration Loop | Calibration-driven proposal pattern | Reused for decision exemplar promotion |
| [RFC-0033](RFC-0033-governance-reporting-layer.md) Governance Reporting | Includes decision metrics in periodic synthesis | Downstream consumer of feedback store |

## 11. Schema Sketch (Illustrative)

> **Note:** This schema is illustrative for the Draft. The normative JSON Schema lands at Ready-for-Review in `spec/schemas/decision.schema.json`.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Decision
metadata:
  id: DEC-0042
  source: rfc-open-question
  scope: rfc:RFC-0035
  created: 2026-05-08T14:32:00Z
  updated: 2026-05-08T14:32:00Z
spec:
  summary: 'Catalog as separate resource vs view projected from existing markdown'
  body: |
    Should the Decision resource be a first-class entity stored under
    .ai-sdlc/decisions/, or a derived projection over existing OQ markdown
    bullets across issues + RFCs?
  options:
    - id: opt-a
      description: 'First-class resource (write + read; canonical)'
      consequences:
        - 'Decision history persists independently of source artifacts'
        - 'Override events have a stable home for calibration'
      subDecisions:
        - 'How do we keep the catalog in sync with source markdown?'
    - id: opt-b
      description: 'Projection over existing markdown (read-only view)'
      consequences:
        - 'No sync problem; markdown remains the source'
        - 'No stable home for override events / calibration'
status:
  lifecycle: open
  routing:
    assignedActor: Dominique Legault
    actorRationale: 'Cross-pillar (Engineering + Operator); architectural'
    llmEligible: false
  evaluation:
    stageA:
      blockedTaskCount: 0
      blockedRfcCount: 1   # this RFC
      affectedPillars: [engineering, operator]
      reversibility: one-way
      duplicateOf: null
    stageB:
      loadBearing: 0.85
      llmConfidence: 0.30
      actorFit: 1.0
      costOfBlock: 0.40
    stageC:
      recommendation:
        optionId: opt-a
        confidence: 0.65
        rationale: 'Calibration loop requires stable storage for override events'
      counterArguments:
        - 'Sync cost may exceed calibration value if override rate is low'
  priority: 0.72
  capacity: { tier: large }
  deadline: null
decisionLog: []
```

## 12. Backward Compatibility

This is a net-new resource type and a net-new operator surface. No existing schemas change. Specifically:

- Existing OQs in RFC bodies and issue ACs continue to live there. The catalog **projects** from them where possible.
- The DoR clarification flow (RFC-0011) gains a side effect (catalog write) but its rubric and admission semantics are unchanged.
- The Operator TUI's decisions-pending pane (RFC-0023) gains a richer data source but its contract is unchanged.

OQ-7 below addresses the longer-term question of whether OQ markdown bullets should be migrated to the catalog or remain projection sources.

## 13. Alternatives Considered

### 13.1 Alternative A — Don't catalog; project a view from existing markdown sources

Simpler v1, no sync problem. Rejected for the Draft because:

- No stable home for **override events** — the most important calibration signal would have nowhere to land
- No way to track **decision lifecycle** (deferred → answered → superseded) across artifacts
- Cross-issue dedup becomes a recurring scan rather than a property of the catalog

This alternative may still be the right v1; OQ-1 captures the question.

### 13.2 Alternative B — Treat decisions as a kind of issue in the backlog

The backlog already has issues, and PPA already prioritizes them. Why not just file decisions as issues? Rejected because:

- Conflates the **prioritization** signal (PPA: should we do this work?) with the **routing** signal (who should answer this question?)
- Decisions don't have ACs in the issue sense; their resolution is "an option was chosen", not "code shipped"
- The `Issue` lifecycle (To Do → In Progress → Done) doesn't map to the `Decision` lifecycle (proposed → open → answered → superseded)

Decisions and issues are related but distinct resources, like RFCs and issues are related but distinct.

### 13.3 Alternative C — Use Claude Code's `AskUserQuestion` for everything; no catalog

Status quo. Rejected because:

- No cross-issue prioritization (every decision arrives in isolation at the moment a subagent hits it)
- No actor routing (whoever happens to be at the keyboard answers everything)
- No calibration (override events disappear into chat history)
- Violates the cost-asymmetry premise (decisions arrive at the worst possible moment)

### 13.4 Alternative D — A single global decision queue without tiers or fatigue model

Simpler implementation. Rejected because operator fatigue is a stated, recorded constraint and a uniform queue defers urgently-blocking small decisions just as aggressively as architectural large decisions. A tier-aware model is a few hundred lines more code and orders-of-magnitude better operator experience.

## 14. Implementation Plan

Phased rollout behind feature flag `AI_SDLC_DECISION_CATALOG=experimental` (mirroring RFC-0014 / RFC-0015 promotion pattern):

- [ ] **Phase 1.** `Decision` resource schema + JSON Schema + `cli-decisions {list, show, add}` (manual authoring only)
- [ ] **Phase 2.** Stage A deterministic scorer + dep-graph blast-radius integration (depends on RFC-0014 Phase 1)
- [ ] **Phase 3.** Stage B rubric scorer (deterministic dimensions only) + actor routing
- [ ] **Phase 4.** RFC-0011 DoR integration: clarification rounds emit `Decision` records
- [ ] **Phase 5.** Stage C LLM evaluation + `decision-policy.md`, `decision-principles.md`, `decision-exemplars.yaml` calibration files
- [ ] **Phase 6.** Decision support surface: recommendation + counter-arguments + sub-decision graph (text rendering)
- [ ] **Phase 7.** Capacity model + fatigue signal handling
- [ ] **Phase 8.** RFC-0023 TUI decisions-pending pane integration (depends on RFC-0023 Phase 1)
- [ ] **Phase 9.** Override-driven calibration loop (`pending-exemplars.yaml` workflow)
- [ ] **Phase 10.** Optional: research subagent integration; visual decision graphs (Mermaid → richer); NotebookLM-style infographics
- [ ] **Phase 11.** Hybrid promotion runbook to flip default-on (`docs/operations/decision-catalog-promotion.md`)

Per the project's promotion convention (`docs/operations/dor-promotion.md`, `docs/operations/orchestrator-promotion.md`), the operator dispatches the default-on flip from the runbook once corpus or spot-check evidence supports it.

## 15. Open Questions

> **Operator walkthrough complete (2026-05-15):** All 14 of 14 OQs resolved with normative answers per Resolution markers below. Lifecycle promoted Draft → Ready for Review; awaits per-owner sign-off. The §15.1 *Design Patterns* subsection codifies the architectural coherence that emerged across the resolutions — 8 normative principles that anchor v1 implementation and serve as reusable design lessons for future operator-decision-pending subsystems.

1. **Catalog vs projection.** Is the `Decision` a first-class write-through resource, or a projection over existing markdown? What's the maintenance cost of each path? (See §13.1.)

   **Resolution (2026-05-15):** **Append-only event log (event sourcing).** Decisions are projections of an event log at `.ai-sdlc/_decisions/events.jsonl` (sibling to RFC-0015's existing `events.jsonl` substrate; consider unification later). Initial event types: `decision-opened | recommendation-issued | operator-answered | timebox-fired | overridden | calibration-adjusted | superseded`. Current state of any Decision is materialized on-demand via `cli-decisions show <id>` with optional cache. Schema evolution: explicit `eventVersion` field per record; migrations are append-only event-type additions. Selected over first-class write-through (Option A) because the Decision Catalog's core requirements *are* event-sourcing requirements: evolving state, override history, calibration replay, multi-consumer views. Reuses existing `events.jsonl` substrate; audit trail + calibration corpus come free from the log.

2. **Load-bearing measurement.** How do we score load-bearing-ness deterministically beyond `blockedTaskCount`? Does a decision blocking 1 critical task outscore one blocking 10 chores? Does deadline distance multiply linearly or non-linearly?

   **Resolution (2026-05-15):** **Hybrid: deterministic baseline (RFC-0014 max-blocked-task-priority + log(count)) + operator override with 14d TTL.** Default formula: `loadBearing = max(taskPriority(t)) + log(blockedTaskCount)` — composes with RFC-0014's shipped dep-graph priority; the `log` of count gives diminishing returns (blocking 100 tasks isn't 10× more load-bearing than blocking 10). Per-org tunable via `.ai-sdlc/decisions-config.yaml: loadBearingFormula`. Operator override via TUI expires after 14d unless re-affirmed (per timebox principle — operator priorities drift; computed value re-asserts). Override events feed the OQ-1 event log → calibration corpus → detect systematic divergence between computed and operator-set priority.

3. **LLM-confidence cold start.** How is LLM-confidence computed for a brand-new decision class with no exemplars? Self-reported by the LLM (untrustworthy)? Rubric-driven (manual)? Conservative-default-until-N-samples?

   **Resolution (2026-05-15):** **Auto-apply with 24-hour operator-override window (the Linear AI / Datadog auto-grouping pattern).** Reversible decisions auto-apply immediately upon Stage C completion; TUI surfaces "Auto-decided: <recommendation>; override within 24h?" with countdown. Operator override during window = negative exemplar (LLM was wrong); operator silence through window = positive exemplar (tacit acceptance). After window: decision is "settled"; override still possible but requires explicit re-decision. Multi-surface notification at decision time (TUI + Slack DM + 12h email digest if unacknowledged) prevents operator-on-vacation false-positives. Reversibility gate: `Decision.reversible: bool` (default `true`); `false` falls back to explicit confirm (no auto-apply). Override window per-org configurable (`overrideWindowHours: 24`). Operator-fatigue-aware: silence ≠ approval when fatigue active. Selected over phased clamp because the override-window pattern solves cold-start calibration without "Phase 1 auto-apply nothing" theater — corpus accumulates from day one via operator behavior.

4. **Task-vs-decision boundary.** Some tasks ARE decision trees ("design the auth flow" implies dozens of decisions). Do we recurse — task contains decisions, decisions can spawn tasks? Or is the boundary: decisions resolve to a chosen option; tasks deliver code?

   **Resolution (2026-05-15):** **Clean separation — distinct artifact types with frontmatter cross-references.** Decisions live in the OQ-1 event log; Tasks live in `backlog/tasks/`. Cross-refs: a Task frontmatter declares `depends-on: [DEC-0042]`; a Decision's `decision-answered` event includes `unblocks: [AISDLC-273]`. A Task with unresolved `depends-on` Decisions is non-dispatchable (extends AISDLC-243 dispatchability filter). `DEC-NNNN` IDs parallel `AISDLC-NNNN`. Selected over recursive nesting because ADR / BMad / Aha! converged on clean separation industry-wide; Decisions and Tasks have genuinely different lifecycles (Decision: open → answered → superseded; Task: To Do → In Progress → Done); cross-references handle the fuzzy "design the auth flow" case without artificial hierarchy. Decisions resolve to options (what); Tasks deliver code (how).

5. **Cross-source dedup.** If RFC-0011 raises "which dashboard?" via DoR clarification AND RFC-0024 raises the same question via emergent capture, is that one `Decision` or two? Auto-merge, or operator-choice?

   **Resolution (2026-05-15):** **Classifier-suggests-operator-confirms dedup, with 24h auto-expire (composes with OQ-3 pattern).** Single LLM classifier across triage, severity, DoR-new-concern, AND dedup — one shared corpus for calibration. Classifier scans queue periodically; ≥ 0.85 confidence (higher than triage 0.7 because false-positive merges cost more) surfaces as "possible duplicate: DEC-0042 ≈ DEC-0045; merge?" suggestion. Operator confirms via `cli-decisions merge` or dismisses; unhandled suggestion auto-expires after 24h. Schema: `Decision.dedupCandidates: [DecisionID]`. New event types: `decision-dedup-suggested | decision-merged | decision-dedup-dismissed`. Selected over manual-only because dev-tool industry standard for fuzzy semantic dedup is classifier-suggests + operator-confirms (Linear/Jira manual-only patterns apply to crisp-fingerprint dedup like stack traces); selected over auto-merge because false-positive merges destroy decision history.

6. **Capacity defaults.** What numbers ship by default for `large/medium/small` per-day budgets? Should the framework learn the operator's actual rate from history, or stay configurable-only?

   **Resolution (2026-05-15):** **Compose with RFC-0016 t-shirt sizing (XS / S / M / L / XL) — no parallel capacity model.** Each Decision gets a `tShirtSize` field computed by RFC-0016's Stage A algorithm (deterministic signals → bucket; LLM tie-breaks ambiguous cases). Capacity as per-tier daily slots: `XS: 30/day, S: 15/day, M: 6/day, L: 2/day, XL: 1/day`. Per-org configurable in `.ai-sdlc/decisions-config.yaml`. Calibration substrate already shipped (RFC-0016 Implementation): Decision Catalog's event log emits `decision-opened`/`decision-answered` events with timestamps; wall-clock actual feeds RFC-0016's per-class bias multipliers; operator sees `uncalibrated | warming | calibrated` token in TUI. Selected over inventing parallel capacity model because RFC-0016 already shipped the calibration loop, t-shirt buckets, and Stage A/B/C structure — duplicating violates the compose-don't-duplicate principle.

7. **Migration of existing OQ markdown.** Do we eventually migrate `§ Open Questions` markdown blocks in RFCs to catalog records, or leave them as authoritative source the catalog projects from indefinitely?

   **Resolution (2026-05-15):** **Don't migrate; event log references RFC source artifacts.** RFC §Open Questions markdown blocks stay authoritative for OQ *text* (the question, recommendation, counter-argument). The Decision Catalog event log captures decision *events* with `(rfc-id, oq-section)` references back to source. No double source of truth. When an OQ resolves via operator walkthrough, the RFC body gains a Resolution marker AND the event log gains a `decision-answered` event — both pointing at the same logical decision, neither requiring sync. Selected over one-time migration because RFCs are bounded artifacts with strong locality (an RFC's OQs belong with the RFC), and the event log model handles cross-RFC lifecycle without moving content.

8. **Fatigue inference vs explicit-only.** Should the framework infer fatigue from override-rate / throughput drop, or trust only explicit operator declarations? Inferred signals may misfire on legitimate disagreement runs.

   **Resolution (2026-05-15):** **Explicit operator signal as default + opt-in inferred from behavior.** Explicit fatigue: operator command (`ai-sdlc operator-state fatigue --on` or TUI button) sets `fatigueActive: true` in `.ai-sdlc/operator-state.yaml`. Inferred fatigue (opt-in): override-rate > 50% in last hour OR throughput drops > 60% from rolling baseline → soft-suppresses dispatch with operator notification. Inferred is OFF by default (`inferFatigue: false` in config). Under fatigue (explicit or inferred), timebox auto-defaults still fire per [decisions-degrade-gracefully memory](memory:feedback_decisions_degrade_gracefully); operator catches up retroactively. Selected over explicit-only because inferred provides a soft check for fatigued operators who don't realize it; selected over always-both because inferred misfires on legitimate disagreement runs.

9. **Counter-argument generation pattern.** Steel-man each option independently, or adversarially attack the recommendation? Different prompts; different operator UX. Both have failure modes.

   **Resolution (2026-05-15):** **Single sharp adversarial counter-argument on the recommendation.** Decision-support surface (§8) generates one CA per decision that steel-mans the strongest alternative to the recommendation. Cheaper than exhaustive option steel-manning; focuses operator attention; matches the format proven through the 14-OQ walkthrough session itself (every OQ had one sharp CA, and several decisions flipped to the alternative as a result — OQ-3 → E, OQ-6 → compose-with-RFC-0016). Single LLM call; deterministic prompt template. Selected over per-option steel-manning because attention is finite — N steel-mans for N options produces operator drowning, not better decisions; selected over no-CA because the walkthrough showed CAs add real signal.

10. **Sub-decision graph fidelity.** Text outline, Mermaid, or interactive — what's the v1 floor? Mermaid is cheap and good-enough; richer rendering is expensive. Phase the upgrade?

    **Resolution (2026-05-15):** **Mermaid for markdown/web surfaces; text outline fallback for TUI.** Sub-decision graphs render as Mermaid `flowchart TD` in RFC bodies and the future web operator surface (both render Mermaid natively). The Ink-based TUI falls back to indented text outlines for the same data — same graph data model, different rendering surface. Future-phase upgrade to interactive D3/React only when the web operator surface ships and needs richer interaction (Phase 8 of §14 Implementation Plan). Selected over text-only because complex sub-decision trees become unreadable; selected over interactive-only because TUI is text-rendered and there's no web surface yet.

11. **Operator-override exemplar promotion.** Every override → exemplar candidate, or only when the operator explicitly tags it? Auto-promotion has noise; manual tagging has friction.

    **Resolution (2026-05-15):** **All overrides feed the corpus automatically; aggregator filters anchors.** Every override (decision-time or during OQ-3 24h window) emits an `overridden` event in the OQ-1 log. Calibration corpus is the projection of those events. A separate aggregator (`cli-decisions-corpus aggregate`) periodically promotes high-signal overrides to "calibration anchors" — exemplars used for prompt-anchoring in subsequent Stage C calls. Promotion criteria: ≥ 3 overrides of the same recommendation class with consistent corrected-class, OR explicit operator tagging via `cli-decisions tag-anchor <event-id>`. Selected over operator-only-tagging because dogfood-tier volume can't sustain manual tagging; selected over auto-promote-at-confidence because anchor poisoning is a real risk and a 3-event threshold is honest about needing repeated signal.

12. **Decision deadline semantics.** Soft (priority decay), hard (auto-defer past deadline), or both? Hard deadlines may push the operator into fatigue mode counterproductively.

    **Resolution (2026-05-15):** **Hard timebox + default-on-silence for reversible decisions; soft priority decay only for irreversible.** Reversible decisions (`Decision.reversible: true`, default for new classes): per-OQ timebox fires, default-on-silence auto-action applies, operator can undo within window or with explicit override afterward. Irreversible decisions (`reversible: false`): no auto-fire; priority decays as timebox expires to signal urgency, but operator must explicitly answer or decision stays open. Composes with OQ-3 (auto-apply + override window — reversible uses the 24h window; irreversible doesn't). Composes with [decisions-degrade-gracefully memory](memory:feedback_decisions_degrade_gracefully): "not making a decision is a decision, except when consequences are irreversible." Selected over hard-only because auto-firing irreversible decisions violates operator authority; selected over soft-only because that reintroduces the indefinite-pending problem the timebox principle exists to fix.

13. **Multi-actor decisions.** When a decision touches Engineering AND Product AND Design, is sign-off concurrent or sequenced? Does any-pillar-blocks behavior produce deadlock under disagreement?

    **Resolution (2026-05-15):** **Operator routes multi-pillar decisions (per §6.2).** When a Decision touches multiple pillars (Engineering + Product + Design), the routing rubric assigns it to the operator (cross-pillar role per [team-roles memory](memory:project_team_roles): dominique = Engineering + Operator). Operator decides; pillar leads see the decision in their digest with `multi-pillar: true` marker but don't gate resolution. Single-pillar decisions still route to that pillar's lead per §6.2. Selected over concurrent sign-off because cross-pillar consensus is deadlock-prone under disagreement; selected over sequenced because sequencing serializes logically-parallel work; selected over pillar-primary auto-routing because cross-pillar decisions need cross-pillar context single-pillar primaries don't have. The operator-as-decision-steward framing in VISION.md §3 anchors this.

14. **Auto-decision audit.** Every framework auto-decision logs to the digest — but does the operator see *all* of them, only divergent-from-rubric ones, or only those flagged by the override calibration?

    **Resolution (2026-05-15):** **Per-organization configurable; default = overridden-only (signal-only digest).** `.ai-sdlc/decisions-config.yaml: auditDigest: { mode: 'overridden-only' | 'all' | 'anomalous' }`. Default `overridden-only`: operator sees auto-decisions that were subsequently overridden — the cases where the framework was wrong; actionable signal. `all` mode: every auto-decision; high-volume; appropriate for compliance-heavy orgs. `anomalous` mode: auto-decisions deviating from rubric expected output; requires rubric calibration to be meaningful. Mode selectable per-digest-frequency (daily / weekly / monthly). Selected over hardcoded mode because audit-signal preferences vary widely by org (3-person dogfood vs 50-person enterprise); `overridden-only` default is the actionable signal in the smallest payload.

### 15.1 Design Patterns (the Decision Catalog Architecture)

The 14 OQ resolutions converge on **8 normative design principles** for the v1 Decision Catalog. These also cross-reference the framework's existing pattern library so the catalog composes with substrate rather than duplicating it. They are reusable architectural lessons for future framework subsystems with operator-decision-pending state.

1. **Event-sourcing data model** (OQ-1, OQ-7, OQ-11). Decisions are projections of an append-only event log (`.ai-sdlc/_decisions/events.jsonl`). Reuses RFC-0015's `events.jsonl` substrate. Free audit trail, free override history, free calibration corpus. RFCs stay authoritative for OQ text; events reference them.

2. **Clean separation: Tasks deliver code; Decisions resolve options** (OQ-4). Distinct resource types with frontmatter cross-references (`depends-on: [DEC-0042]`, `unblocks: [AISDLC-273]`). Matches ADR / BMad / Aha! industry convention. Different lifecycles, different storage, related artifacts.

3. **Auto-apply with operator-override window for reversible decisions** (OQ-3, OQ-12). The Linear AI / Datadog auto-grouping pattern: reversible decisions auto-fire immediately; 24h override window captures negative exemplars; silence is acceptance signal. `Decision.reversible: bool` schema field; `false` falls back to explicit-confirm. Composes with [decisions-degrade-gracefully memory](memory:feedback_decisions_degrade_gracefully).

4. **Single shared LLM classifier corpus** (OQ-3, OQ-5, OQ-11; mirrors RFC-0024 OQs 2/3/5/11). One Haiku-class classifier services triage, severity, DoR-new-concern detection, AND cross-source dedup. One calibration corpus across all use cases. Threshold 0.7 for content classification; 0.85 for dedup (higher-cost false-positive). Aggregator promotes high-signal exemplars to calibration anchors at ≥ 3 consistent overrides.

5. **Composition over duplication** (OQ-2 with RFC-0014; OQ-6 with RFC-0016). The Decision Catalog reuses existing substrate: RFC-0014's `cli-deps frontier` for blocked-task priority; RFC-0016's t-shirt sizing + per-class bias multipliers for capacity + calibration; RFC-0015's `events.jsonl` writer for the event log. No parallel infrastructure.

6. **Per-organization configurability is mandatory** (every OQ). Every timebox, threshold, capacity slot, label set, digest mode is overridable in `.ai-sdlc/decisions-config.yaml`. Organizations process decisions at different velocities; framework constants don't scale.

7. **Operator-fatigue-aware but non-blocking** (OQ-8, OQ-12, composes with [decision-fatigue-signal memory](memory:feedback_decision_fatigue_signal)). Explicit fatigue declaration is the contract; inferred fatigue (override-rate, throughput) is opt-in. Auto-defaults fire even under fatigue — the operator catches up retroactively rather than blocking pipeline.

8. **Deterministic-first → LLM-as-last-resort → operator with timebox** (Stage A / Stage B / Stage C pattern across §4, §5, §6, §7, §8; mirrors RFC-0011 §4.4 DoR ladder + review-calibration system). Cheap deterministic checks resolve ~95% of decisions; LLM classifier with confidence-threshold gates handle ambiguity; operator surfaces with timebox + default-on-silence handle the residual.

These 8 patterns are normative for the v1 Decision Catalog implementation. RFC-0024 (Capture + Triage) already follows the same patterns; RFC-0011 (DoR Gate) shares the Stage A/B/C structure; RFC-0037 (Cost-Gated Heartbeat) inherits the timebox + default-on-silence convention. Future framework subsystems with operator-decision-pending state SHOULD compose these patterns rather than reinventing them.

## 16. References

- [`VISION.md`](../../VISION.md) §1–§3 — Decision Engine premise; cost-asymmetry; operator-as-decision-steward
- [RFC-0011](RFC-0011-definition-of-ready-gate.md) — DoR Gate; deterministic-first ladder model (§4.4)
- [RFC-0014](RFC-0014-dependency-graph-composition.md) — Dependency graph composition (Stage A blast-radius source)
- [RFC-0023](RFC-0023-operator-tui-pipeline-monitoring.md) — Operator TUI (decisions-pending surface)
- [RFC-0024](RFC-0024-emergent-issue-capture-and-triage.md) — Emergent issue capture and triage (upstream feeder)
- [RFC-0025](RFC-0025-framework-quality-monitoring.md) — Framework quality monitoring (calibration on framework misroutes)
- [RFC-0029](RFC-0029-product-pillar-architectural-vision.md) — Product pillar architectural vision (actor model)
- [RFC-0031](RFC-0031-calibration-driven-did-revision-proposal.md) — Calibration-driven DID revision (calibration loop pattern)
- [RFC-0033](RFC-0033-governance-reporting-layer.md) — Governance reporting layer (decision-metrics consumer)
- [`docs/api-reference/review-calibration.md`](../../docs/api-reference/review-calibration.md) — Review-calibration system; deterministic preprocessing → confidence-tiered → meta-review pattern this RFC mirrors
