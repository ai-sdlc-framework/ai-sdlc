---
id: RFC-0018
title: In-Soul Journey Pattern
status: Draft
lifecycle: Ready for Review
author: Morgan Hirtle
created: 2026-05-04
updated: 2026-05-28
targetSpecVersion: v1alpha1
requires:
  - RFC-0009
  - RFC-0017
  - RFC-0035
requiresDocs: []
---

# RFC-0018: In-Soul Journey Pattern

**Document type:** Normative
**Status:** Ready for Review v0.3 — operator OQ walkthrough complete 2026-05-28 with full rigor rubric (problem statement → industry research → 3-4 options with tradeoffs → recommendation + counter-argument per OQ). All 10 §10 OQs resolved. Cross-cutting framing: operator-impacting journey-lifecycle events (count thresholds, state cardinality, metric staleness, accessibility-cadence overdue, WCAG-superseded use, sub-journey / cross-soul activation requests, state-ID drift) **route through [RFC-0035 G0 non-blocking pipeline contract](RFC-0035-decision-catalog-operator-routing.md)** — pipeline never halts. §10.1 codifies per-Soul / per-org config schema. Implementation broken into 6 phase tasks (AISDLC-465..470).
**Lifecycle:** Ready for Review
**Created:** 2026-05-04
**Updated:** 2026-05-28
**Authors:** Morgan Hirtle (Design Authority, InternalAdopter)
**Engineering pass:** Dominique Legault, Claude Opus 4.7 (orchestrator), 2026-05-04 — fleshed §3-§13 from Mo's v0.1 stub. Design + accessibility-vertex semantics (specifically §5.4 success metrics + §10 OQs) deferred to Mo for editorial pass.
**OQ walkthrough:** Dominique Legault (Operator), 2026-05-28 — full-rubric resolution of all 10 §10 OQs.
**Requires:** RFC-0009 (Tessellated Design Intent Documents), RFC-0017 (In-Soul Variant Pattern), RFC-0035 (Decision Catalog — G0 non-blocking routing for journey lifecycle Decisions)

> The bold-style status block above is preserved for human readability. The
> YAML frontmatter at the top of the file is the source of truth for tooling
> (CI, dashboards, the RFC index in `README.md`).

---

## Sign-Off

| Person | Role | Status | Date |
|--------|------|--------|------|
| Morgan Hirtle | Chief of Design / Design Authority | ✍️ Authored v0.1 stub | 2026-05-04 |
| Dominique Legault | CTO / Engineering Authority + AI-SDLC Operator | ✅ Signed v0.3 (all 10 §10 OQs resolved per operator walkthrough 2026-05-28 with full rigor rubric; pending Design editorial pass) | 2026-05-28 |
| Alexander Kline | Head of Product Strategy / Product Authority | ✅ Signed v0.2 (PPA-composability scope only; full v1.0+ pending Mo's editorial) | 2026-05-04 |

### Product Authority review (PPA-composability scope only)

This RFC is properly Mo's Design-Authority territory; the Product Authority lens is restricted to how Journeys compose with PPA scoring.

**PPA composition observations**:

- **Pillar Perspective Breakdown applies cleanly to journeys**. A journey can have Product HIGH / Design LOW (right need, design system not ready for the journey state) or Engineering HIGH / Product LOW (easy to build, weak strategic value at journey scope). PPA v1.1's per-pillar surfacing already covers this.
- **SA1 per-stage**: `journey.completionCriteria` and per-state success metrics are SA1 inputs at journey scope. Work items targeting a specific journey state should score against the state's specific completion criteria, not soul-aggregate. PPA v1.1 §5 supports this.
- **ER4 per-state**: per-journey accessibility floors interact with ER4 (Design System Readiness). When RFC-0027 (Design Coherence Drift Detection) lands, journey-level WCAG conformance feeds ET via the design-coherence drift signal.
- **Demand cluster routing**: when RFC-0030 lands, demand clusters tagged with journey-completion language (e.g., "onboarding completion regression") should route through the journey's per-state SA1, not the soul's. Cross-reference recommended once 0030 lands.

Endorsement contingent on the v1.0+ normative spec preserving accessibility floors per Mo's RFC-0009 v3.4 C3 commitment.

Position grounded in RFC-0029 Principle 1 + Pillar Perspective Breakdown.

---

## 1. Summary

A **Journey** is a temporally-ordered user flow within a Soul DID (RFC-0009 §2) or Variant (RFC-0017): a named sequence of states and transitions that carries distinct design intent, completion criteria, accessibility requirements, and success metrics at the journey scope.

This RFC defines the **In-Soul Journey Pattern** — how journeys are declared on a Soul DID (or Variant), how they relate to the parent's design intent surface, how the admission composite (RFC-0008 / RFC-0005) prioritizes work items that advance, repair, or complete a specific journey, and where the boundary lies between "this is a journey" and "this is just a feature."

The pattern is **flow-based, not configuration-based**. Static configuration overlays are RFC-0017's concern; this RFC handles temporal sequences that have entry, intermediate, terminal, and (sometimes) failure states.

**Practitioner validation source:** InternalAdopter's accessibility audit pipeline. The WCAG 2.1 AA audit surface maps naturally to journey-level design intent: each product flow (onboarding, payment, backflow reporting, regulatory submission) is a journey with distinct completion criteria and accessibility requirements that cannot be collapsed to soul-level aggregate scoring without losing precision. A WCAG failure on the ProductA onboarding journey doesn't tell you anything useful about ProductA's billing journey — they have different states, different transitions, different audiences, different success criteria.

## 2. Motivation

Today, the Soul DID model (RFC-0009) gives a single design intent surface per product face, and RFC-0017 adds variant-level configuration overlays. Both are static — they describe a configuration in time, not a sequence through time. But practitioners report:

- A product face contains multiple distinct user flows (onboarding, daily-task, occasional-event, regulatory) each with different completion semantics
- Soul-level success metrics aggregate across all flows, masking per-flow regressions (an onboarding-completion regression averages-out against a healthy daily-task flow)
- WCAG conformance audits MUST be per-flow — auditors evaluate the user's path through the system, not the system's overall configuration
- Work items that target "improve the onboarding flow" need to score against onboarding-specific design intent + accessibility requirements, not soul-aggregate

Specifically observed at InternalAdopter: **the WCAG 2.1 AA audit pipeline produces per-flow conformance reports. Today these reports have nowhere to land in the framework's scoring surface — they're operator-implicit context.** The framework treats accessibility as a soul-level compliance regime, but the actual conformance evidence is journey-level.

The framework needs a temporal partition for this case that:

1. Names the user flow at a scope the framework can score against
2. Captures completion criteria the framework can verify (work item that "improves onboarding" scores higher when onboarding completion-rate has regressed)
3. Routes accessibility + design imperatives at journey scope (not collapsed to soul)
4. Composes with RFC-0017 (a journey can live within a Variant — e.g., the small-utility variant has a different onboarding flow than the enterprise variant)

## 3. Goals

1. **First-class journey declaration on Soul DID (or Variant)** — `soul.spec.journeys[]` (or `variant.spec.journeys[]`) with id, states, transitions, completion criteria, success metrics
2. **Journey-scoped design intent** — `journey.designImperatives` layered on top of soul/variant level (most-specific-wins, same as RFC-0017 §5.4)
3. **Journey-scoped accessibility requirements** — explicit WCAG level / conformance target per journey; lifts compliance gating from soul-aggregate to per-flow
4. **Admission scoring composes** — `targetedJourneys` field on work items routes scoring through journey-level design intent + success metrics
5. **Composes with Variants (RFC-0017)** — a journey can be soul-scoped OR variant-scoped; admission scorer handles both
6. **Backward compatibility** — Soul DIDs without journeys behave identically
7. **Practitioner validation** — InternalAdopter's accessibility audit pipeline proves out journey-scoped scoring + WCAG mapping before normative status

## 4. Non-Goals

1. **Workflow engine** — this RFC defines journey AS A SCORING SCOPE. Runtime state-machine execution (does a user actually move from state A → B?) is the application's concern, not the framework's. The framework reads completion-rate metrics; it doesn't compute them.
2. **Cross-journey navigation** — a journey is a flow within ONE soul/variant. Multi-soul user paths (user spans multiple products) are operator-application concerns.
3. **State-explosion guards** — the framework does not enforce a maximum number of states or transitions per journey. Journey complexity is the design authority's call.
4. **A/B testing framework** — running parallel journey variants in production is out of scope. RFC-0017's `cardinality: experimental` is the closest hook for "this journey is experimental"; treatment-vs-control tracking is application-side.
5. **Cross-soul journeys** — a journey lives within a single Soul DID (or one of its Variants). Multi-soul flows require the operator to model them as separate journeys per soul + a coordination layer outside the framework.

## 5. Proposal

### 5.1 Journey declaration

Add `journeys[]` to Soul DID `spec` AND to Variant (RFC-0017 §5.1):

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: SoulDID
metadata:
  name: spry-engage
spec:
  # ... existing Soul DID fields including variants[] from RFC-0017 ...
  journeys:
    - id: onboarding
      scope: soul                 # journey applies to ALL variants
      states:
        - id: arrived
          terminal: false
        - id: account-created
          terminal: false
        - id: profile-complete
          terminal: false
        - id: first-task-done
          terminal: true
          successState: true       # reaching this state = journey-success
        - id: abandoned
          terminal: true
          successState: false      # explicit failure-state (analytics signal)
      transitions:
        - from: arrived
          to: account-created
          trigger: "user-signup"
        - from: account-created
          to: profile-complete
          trigger: "profile-form-submitted"
        - from: profile-complete
          to: first-task-done
          trigger: "first-task-completed"
        - from: ["arrived", "account-created", "profile-complete"]
          to: abandoned
          trigger: "session-timeout-30d"
      completionCriteria:
        kind: terminal-success-state
        target: first-task-done
      accessibility:
        wcagLevel: "AA"
        wcagVersion: "2.1"
        conformanceTarget: 100   # percent
        auditCadence: quarterly
      successMetrics:
        - id: completion-rate
          target: 0.65            # 65%
          alertBelow: 0.50
        - id: median-time-to-first-task-done
          targetSeconds: 1800     # 30 min
          alertAbove: 3600        # 1 hour
      designImperatives:
        - "first-task-done within 30 min of account creation"
        - "profile-form is single-screen (no pagination)"
    - id: backflow-annual-test
      scope: variant:annual-test  # journey applies only to a specific variant
      # ... fields as above ...
```

### 5.2 Journey fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string (kebab-case, unique within parent scope) | yes | Journey identifier |
| `scope` | enum (`soul`, `variant:<id>`) | yes | Whether this journey applies to the whole Soul or a specific Variant |
| `states` | array of state objects | yes | Named states; at least 1 MUST have `terminal: true` AND `successState: true` |
| `transitions` | array of transition objects | yes | State-to-state transitions; `from` MAY be a string OR array (any-of); `to` is a single state id |
| `completionCriteria` | object | yes | How "done" is defined (terminal-success-state, all-states-reached, custom-predicate) |
| `accessibility` | object | yes | WCAG level + version + conformance target + audit cadence (per RFC-0009 compliance regime) |
| `successMetrics` | array of metric objects | no | Quantified success signals; feeds Sα₂ + Cκ scoring at journey scope |
| `designImperatives` | string[] | no | Journey-scoped design intent; layered on soul + variant per most-specific-wins |
| `complianceFloor` | enum (`inherit`) | yes (when scope=variant) | MUST be `inherit` — journeys cannot diverge from parent compliance |

### 5.3 Bounded inheritance + composition with Variants

Inheritance flows: **Soul DID → Variant → Journey** (when scoped to a variant) OR **Soul DID → Journey** (when scoped to soul).

| Inherited (journey cannot override) | Specializable (journey overrides allowed) |
|---|---|
| `complianceRegimes` (per-soul) | `accessibility.wcagLevel` (journey may set HIGHER than soul) |
| `substrateInvariants` | `designImperatives` (additive, most-specific-wins) |
| `targetAudience` (from soul or variant) | `successMetrics` (journey-scoped only — no parent equivalent) |
| `tenantQuotaShare` (RFC-0010) | `completionCriteria` (journey-scoped only) |

Journeys MAY raise the WCAG level above the parent (e.g., a soul defaults to WCAG 2.1 AA but the regulatory-submission journey requires 2.2 AAA). Journeys MAY NOT lower the WCAG level below the parent.

### 5.4 Admission scoring composition

Work items target a journey via `targetedJourneys` (parallel to RFC-0017 `targetedVariants`):

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: WorkItem
metadata:
  name: onboarding-profile-form-pagination-removal
spec:
  targetedSouls: [spry-engage]
  targetedVariants: [spry-engage/small-utility]
  targetedJourneys: [spry-engage/onboarding]   # Soul-id/Journey-id
                                                # OR Soul-id/Variant-id/Journey-id
```

Scoring composes per-journey:

- **Sα₁ Audience Resonance** — soul/variant level (journeys don't redefine audience)
- **Sα₂ Vibe Coherence** — journey's `designImperatives` UNION variant's UNION soul's; conflict resolution: most-specific wins (journey > variant > soul)
- **Cκ Capability Coverage** — journey's `successMetrics` weighted at journey scope; if journey's `completion-rate` is BELOW its `alertBelow` threshold, work that addresses this journey gets a Cκ boost (the framework knows this journey is hurting)
- **Eρ₅ Compliance Clearance** — elevated when journey has explicit accessibility requirements above the soul floor (regulatory work on a journey with `wcagLevel: AAA` gates more strictly than soul-default work)
- **Dπ_n** — soul/variant level (Demand Pressure / Market Force / Entropy Tax are aggregate channels)

Cross-journey scoring rule (work touches multiple journeys) — same `min` aggregation as RFC-0009 §7.2 / RFC-0017 §5.4 by default.

### 5.5 Boundary: journey vs. just a feature

**Use a Journey when:**
- The flow has a discoverable sequence of states (entry → intermediate → terminal)
- Completion has a meaningful definition (not "user did something" but "user reached a specific terminal state")
- Distinct accessibility requirements exist (WCAG audit produces per-flow reports)
- Distinct success metrics exist (completion rate, time-to-completion are measurable + meaningful)

**Don't use a Journey for:**
- Single-screen interactions ("the settings page" — that's a feature, not a journey)
- Stateless API calls
- Background jobs
- Static content surfaces

The Design Authority owns the boundary call. When uncertain, default to **don't add a journey** — journeys carry overhead (declaration, accessibility audit, success metrics maintenance) that should pay for itself in scoring precision. Underuse is safer than overuse.

## 6. Design Details

### 6.1 Schema additions

Add to Soul DID schema AND Variant schema (per RFC-0017 §5.1):

```json
{
  "properties": {
    "journeys": {
      "type": "array",
      "items": { "$ref": "#/$defs/Journey" }
    }
  },
  "$defs": {
    "Journey": {
      "type": "object",
      "required": ["id", "scope", "states", "transitions", "completionCriteria", "accessibility"],
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
        "scope": {
          "type": "string",
          "pattern": "^(soul|variant:[a-z][a-z0-9-]*)$"
        },
        "states": {
          "type": "array",
          "minItems": 2,
          "items": {
            "type": "object",
            "required": ["id", "terminal"],
            "properties": {
              "id": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
              "terminal": { "type": "boolean" },
              "successState": { "type": "boolean", "description": "Required when terminal=true" }
            }
          }
        },
        "transitions": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["from", "to", "trigger"],
            "properties": {
              "from": {
                "oneOf": [
                  { "type": "string" },
                  { "type": "array", "items": { "type": "string" } }
                ]
              },
              "to": { "type": "string" },
              "trigger": { "type": "string" }
            }
          }
        },
        "completionCriteria": {
          "type": "object",
          "required": ["kind"],
          "properties": {
            "kind": { "type": "string", "enum": ["terminal-success-state", "all-states-reached", "custom-predicate"] },
            "target": { "type": "string" },
            "predicate": { "type": "string", "description": "Required when kind=custom-predicate" }
          }
        },
        "accessibility": {
          "type": "object",
          "required": ["wcagLevel", "wcagVersion", "conformanceTarget"],
          "properties": {
            "wcagLevel": { "type": "string", "enum": ["A", "AA", "AAA"] },
            "wcagVersion": { "type": "string", "enum": ["2.0", "2.1", "2.2", "3.0"] },
            "conformanceTarget": { "type": "number", "minimum": 0, "maximum": 100 },
            "auditCadence": { "type": "string", "enum": ["quarterly", "annually", "release-gated", "continuous"] }
          }
        },
        "successMetrics": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["id"],
            "properties": {
              "id": { "type": "string" },
              "target": { "type": "number" },
              "alertBelow": { "type": "number" },
              "alertAbove": { "type": "number" },
              "targetSeconds": { "type": "number" }
            }
          }
        },
        "designImperatives": {
          "type": "array",
          "items": { "type": "string" }
        },
        "complianceFloor": {
          "type": "string",
          "const": "inherit"
        }
      }
    }
  }
}
```

Add to Work Item schema:

```json
{
  "properties": {
    "targetedJourneys": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z][a-z0-9-]*\\/(([a-z][a-z0-9-]*\\/)?[a-z][a-z0-9-]*)$",
        "description": "Soul-id/Journey-id OR Soul-id/Variant-id/Journey-id"
      }
    }
  }
}
```

### 6.2 Behavioral changes

- **Reconciliation** — journey state IDs / transitions are referenced by application code (instrumentation, analytics). The `Eτ_tessellation_drift` detector (RFC-0009 §13) MUST scan substrate code for journey state ID references parallel to soul/variant scans. Application code referencing a state that's been removed is a drift signal.
- **Admission scoring** — when `targetedJourneys` is non-empty, the admission scorer routes Sα₂ + Cκ + Eρ₅ inputs through journey-level fields. Cκ specifically boosts work when journey success-metrics are below `alertBelow` thresholds.
- **Compliance escalation** — work that targets a journey with `wcagLevel` ABOVE the soul-default MUST trigger Eρ₅ Compliance Clearance at the journey-elevated level, not the soul-default level.

### 6.3 Migration path

Soul DIDs without `journeys[]` are unchanged. Adding journeys is purely additive. Removing a journey requires:

1. Sweep `targetedJourneys` across all open work items; reject removal if any work item references the journey
2. Sweep substrate code for state ID references; report any matches as drift
3. Provide deprecation window (default 90 days for journeys vs. 30 for variants — journeys carry more downstream code references)
4. Emit `JourneyRemoved` event per RFC-0008 event taxonomy

## 7. Backward Compatibility

**Not a breaking change.** Soul DIDs (and Variants) without `journeys[]` continue to behave identically. Work items without `targetedJourneys` are scored at their existing (soul or variant) scope.

The only soft regression: Sα₂ scoring previously aggregated across all flows in a soul. Surfacing journeys lets the framework score per-flow precision, which means SOME work that previously scored well at soul-aggregate may score lower if the specific journey it targets has weaker design intent than the soul average. This is the FEATURE, not a bug — it surfaces under-articulated journey design intent that the operator can then strengthen.

## 8. Alternatives Considered

### 8.1 Use Variants for flows (RFC-0017's `cardinality: experimental` for A/B treatments)

Treat each flow as a variant. **Rejected** — variants are static configuration overlays; flows have temporal sequence (entry → intermediate → terminal) that doesn't fit the variant model. Forcing temporal data into a static schema produces awkward declarations + loses the completion-criteria + state-machine semantics.

### 8.2 Use a separate `kind: Journey` resource

Journeys as standalone resources composed at admission time. **Rejected** for the same reason as RFC-0017 §8.2 — journeys are tightly bound to their parent Soul/Variant. Standalone resources add ceremony for a sub-concern.

### 8.3 Skip the schema; route through label-based tagging

Add a `journey: <name>` label on work items; let admission heuristically aggregate. **Rejected** — same reasons as RFC-0017 §8.3 (no inheritance contract, doesn't compose with scoring, doesn't surface in design intent hierarchy). Plus journeys NEED state declarations to be useful for completion-criteria scoring.

### 8.4 External workflow engine (Temporal, BPMN)

Outsource journey state-machine modeling to a workflow engine. **Rejected** — out-of-scope per §4 non-goal #1. The framework defines journey AS A SCORING SCOPE; runtime state execution is application-side. Adopters who use Temporal/BPMN can keep doing so; this RFC just lets them ALSO declare the journey to the framework for scoring purposes.

## 9. Implementation Plan

- [ ] Soul DID schema addition (`journeys[]`)
- [ ] Variant schema addition (`journeys[]` per RFC-0017 §5.1)
- [ ] Work Item schema addition (`targetedJourneys`)
- [ ] Admission scorer composition (Sα₂ + Cκ + Eρ₅ journey routing)
- [ ] Journey inheritance validator (`JourneyInheritanceViolation` event)
- [ ] `Eτ_tessellation_drift` detector extension for journey-scoped state-ID scans
- [ ] Success-metrics ingestion adapter (where do `completion-rate` values come from? — likely an adapter pattern per RFC-0003)
- [ ] InternalAdopter accessibility audit pipeline as reference implementation (one journey per product flow, minimum)
- [ ] Glossary additions (`Journey`, `targetedJourneys`, `completionCriteria`)
- [ ] Conformance test suite — journey declaration round-trip; admission-scoring composition; inheritance + WCAG-elevation enforcement
- [ ] Author/update each user-facing doc surface declared in `requiresDocs` (currently `[]` — pending tutorial/runbook decision)

## 10. Open Questions — resolved (operator walkthrough 2026-05-28 with full rubric)

> **Resolution status (2026-05-28):** All 10 §10 OQs resolved via operator walkthrough with full rigor rubric (problem statement → industry research → 3-4 options with tradeoffs → recommendation + counter-argument per OQ). Lifecycle promoted Draft → Ready for Review. **Cross-cutting framing:** every operator-impacting journey-lifecycle event (count thresholds, state cardinality, metric staleness, accessibility cadence overdue, WCAG superseded version use, sub-journey / cross-soul activation requests, state-ID drift) routes through [RFC-0035 G0 non-blocking pipeline contract](RFC-0035-decision-catalog-operator-routing.md). §10.1 codifies per-Soul / per-org config schema. Implementation broken into 6 phase tasks: AISDLC-465..470.

**OQ-1 — Maximum journeys per Soul/Variant:** Should the schema cap journey count? Recommendation: soft warning at 10+, hard limit at 50. Journeys are heavier than variants — encourage discipline.

   **Resolution (2026-05-28, full rubric):** **Per-org configurable; defaults soft 10 / hard 50.** Author's defaults (soft 10 from Miller's 7±2 + industry advisory; hard 50 from Salesforce-style enterprise-platform ceiling) wrapped in the per-org-configurability convention established this session (matches RFC-0017 OQ-1 variant count exactly). Industry research: Atlassian ~12, Slack ~8, Salesforce 30+, Temporal recommends ≤50; cognitive-load research (Miller 7±2, Cowan ~4) supports ~10 as mental-model-maintenance threshold. Soft warn → `Decision: journey-count-soft-warning` (non-blocking batch review); hard limit → refuse declaration + `Decision: journey-count-hard-limit-exceeded` + clarification task. **Selected over fixed 10/50** because Salesforce-style enterprise platforms legitimately exceed 50; per-org override prevents constant-rejecting-RFC friction. **Selected over RFC-0017's 5/20** because journey count tracks user-flow surface (typically 10+ per mid-market SaaS) not audience-segment surface (typically <10). Different concept space; different defaults.

**OQ-2 — State cardinality limits:** Per-journey state limit? Recommendation: NO hard limit; surface a soft warning at >12 states (suggests a journey should be split into sub-journeys).

   **Resolution (2026-05-28, full rubric):** **Per-org configurable; defaults soft 12 / hard 100 + concrete v1 message.** Industry research: cognitive-load (Miller 7±2), XState/robot3 advisory "consider hierarchical states" at >10, BPMN practical limit ~20, IEEE state-diagram readability research >15 correlates with maintenance issues. Soft warn message ships operator-actionable workaround: *"Consider splitting into multiple top-level journeys with handoff terminal states (v1 workaround) OR await OQ-3 sub-journey activation (v2)."* Hard limit at 100 is sanity check (typo / runaway-loop guard, NOT architectural constraint — regulatory-submission journeys with 25-40 states are legitimate). Soft warn → `Decision: journey-state-count-soft-warning`; hard limit → refuse + `Decision: journey-state-count-hard-limit-exceeded`. **Selected over author's "no hard limit + vague sub-journey message"** because (a) sub-journey advisory is meaningless when OQ-3 rejects sub-journeys for v1 (operator can't act on it) and (b) typo / runaway-loop guard has real value. **Selected over no limits** because sanity guard prevents 500-state declarations that are almost certainly bugs. **Selected over RFC-0017 5/20 mirror** because state count is conceptually different from variant count.

**OQ-3 — Sub-journeys (journey-within-journey):** Can a journey reference another journey as a sub-flow (e.g., "checkout journey embeds payment sub-journey")? Recommendation: NO for v1 — composition adds complexity for a use case we don't have practitioner evidence for. Revisit if multi-step flows surface.

   **Resolution (2026-05-28, full rubric):** **Schema-enforced flat: `journeys[]` cannot contain `journeys[]`** + future Decision-Catalog auto-promote on ≥2 distinct adopter requests. Matches RFC-0017 OQ-2 nested-variants resolution exactly (design-tokens pattern: Tailwind/Material/Stripe/Vercel; Mendling et al. BPMN research on maintainability concerns above 2 levels of nesting; XState statecharts.dev warning against nesting >2 levels). v1 workaround documented in operator runbook + OQ-2 warning text: model sub-flows as multiple top-level journeys with handoff terminal states using shared `userId` / `sessionId` correlation. Future RFC via `Decision: journey-sub-flow-activation-request` (Stage A counter, auto-promote at ≥2 distinct adopter requests; matches RFC-0017 OQ-8 + this RFC OQ-9 pattern). **Selected over convention-only NO (author's lean)** because schema-permissive + convention-gated is the design-tokens-explosion anti-pattern RFC-0017 OQ-2 v0.2 had to refit. **Selected over allow-nested-v1** because premature without practitioner evidence (complexity-management debt from day 1). **Selected over opt-in flag** because adds config surface for capability without demand.

**OQ-4 — Completion-criteria expressiveness:** §5.2 sketches `terminal-success-state | all-states-reached | custom-predicate`. Is `custom-predicate` an arbitrary string DSL, a JS expression, a JsonLogic predicate, or off the table for v1? Recommendation: closed enum for v1 (`terminal-success-state` + `all-states-reached` only); defer `custom-predicate` until adopters surface a real need.

   **Resolution (2026-05-28, full rubric):** **Closed enum for v1 + future Decision-Catalog auto-promote on ≥2 adopter requests + pre-recommended CEL (Google Common Expression Language) for v2.** Industry research: CEL is the modern de-facto sandboxed expression language (Kubernetes admission webhooks, gRPC, Cloud IAM); statically-typed, statically-analyzable, deterministic, no IO. JsonLogic limited expressiveness; arbitrary JS is anti-pattern (sandbox escape, non-determinism, non-analyzable); JEXL too dangerous; Rego / Cedar overkill. Future RFC via `Decision: journey-custom-predicate-activation-request` (matches RFC-0017 OQ-8 cardinality + this RFC OQ-3, OQ-9 pattern). Pre-recommending CEL in the resolution captures current industry consensus AND signals to adopters that the answer is already known (not blocking on technology selection). **Selected over vague defer (author's lean)** because vague defer has no concrete adopter-demand mechanism. **Selected over ship-CEL-v1** because premature without demand. **Selected over arbitrary-JS** because anti-pattern (security + non-determinism).

**OQ-5 — Success-metrics source:** §9 mentions an adapter pattern for ingesting metrics like `completion-rate`. What's the adapter contract — operator-supplied numbers, or framework-side polling of an analytics backend? Recommendation: operator-supplied numbers via a typed `MetricSnapshot` resource (operator's analytics pipeline writes them). Frees the framework from analytics-backend integration.

   **Resolution (2026-05-28, full rubric):** **Operator-supplied `MetricSnapshot` resource for v1 + `Decision: journey-metric-stale` on stale data (>30d default, per-Soul configurable) + future-RFC pre-recommends `MetricsAdapter` pattern parallel to RFC-0030 SignalSourceAdapter.** Industry research: push vs pull patterns both production-proven; product analytics (Mixpanel, Amplitude, Heap) require N-vendor adapters for framework-poll (high framework-side cost); operator-supplied glue is lower friction because adopters already have analytics. Stale-metric handling: warn-and-unknown (not fail-closed) via Decision routing — treat as missing input for Cκ at journey scope. **Selected over author's lean** because v0.2 leaves stale-handling implicit (Phase 1 implementer choice) AND omits the v2 trajectory composition with RFC-0030. **Selected over adapter-framework-day-one** because premature; high framework-side cost. **Selected over reuse-SignalSourceAdapter** because conflates qualitative (text) vs quantitative (numeric) semantics → bad type hierarchy long-term.

**OQ-6 — Accessibility cadence enforcement:** §5.1's `auditCadence: quarterly | annually | release-gated | continuous` declares cadence but the framework doesn't currently enforce it. Should overdue audits trigger Eρ₅ degradation (compliance-clearance gate fails until audit lands)? Recommendation: YES with a 30-day grace window past the cadence; configurable per Soul.

   **Resolution (2026-05-28, full rubric):** **Graduated Eρ₅ degradation + threshold Decisions + per-Soul `accessibility.auditOverdueGracePolicy` config.** Industry research: SOC2 30d grace; PCI-DSS strict; Vanta/Drata/Secureframe production governance tools use graduated risk-score reduction (not binary cliff); HIPAA ongoing assessments. Graduated schedule: 0-30d past cadence → warn (no Eρ₅ impact); 30-60d → Eρ₅ -25%; 60-90d → Eρ₅ -50%; 90d+ → effective block. Decisions at each threshold transition: `journey-audit-overdue-warn`, `journey-audit-overdue-graduated`, `journey-audit-overdue-blocking`. Per-Soul config preserves stricter modes (`binary-30d`, `hard-block`) for SOC2/HIPAA-strict shops. **Selected over author's binary 30d grace then fail** because operator-hostile cliff behavior + contradicts industry pattern (Vanta/Drata graduated). **Selected over hard-block at cadence+0d** because too aggressive as default (preserved as per-Soul opt-in). **Selected over warn-only** because loses Eρ₅ scoring teeth the OQ surfaces.

**OQ-7 — WCAG version evolution:** WCAG 3.0 is in development. How does the schema handle a new WCAG version landing — bump `wcagVersion` enum, leave existing journey declarations valid? Recommendation: additive enum (existing journeys keep their declared version; new journeys can pick the latest); document migration in a follow-on RFC when WCAG 3.0 normative.

   **Resolution (2026-05-28, full rubric):** **Additive enum + WCAG 3.0 scoring-model preview documented + `Decision: wcag-version-superseded` advisory on W3C-superseded versions.** Industry research: WCAG version history 2.0 (2008) → 2.1 (2018) → 2.2 (2023) → 3.0 (in development); W3C never formally removes versions but 2.1+ is recommended; WCAG 3.0 is a structural shift (binary conformance → Silver framework graduated scoring). Resolution pre-documents that the `conformanceTarget: number` field assumes binary; WCAG 3.0 normative will likely require `scoringModel: 'binary' | 'graduated'` discriminant in a future RFC. Pre-documenting captures the foreseeable scope. `Decision: wcag-version-superseded` advisory when adopter declares WCAG 2.0 (no scoring impact; visible-gap signal). **Selected over author's lean (additive enum + vague defer)** because both refinements implicit → re-discovery cost. **Selected over strict-force-latest** because contradicts version-bound audit reality (conformance audits target specific version). **Selected over schema-permissive** because loses validation value.

**OQ-8 — Drift detection on state ID references:** §6.2 says substrate code referencing a removed state ID is a drift signal. How does the detector find these references — string match on the state ID, AST scan for typed references, or both? Recommendation: string match v1 (cheap, conservative); AST scan in a follow-on if false-positive rate is too high.

   **Resolution (2026-05-28, full rubric):** **AST scan from v1, reusing RFC-0009 §13 Rule #1 infrastructure.** The existing AST scan engine ALREADY EXISTS for soul-slug leakage detection — adding journey state-ID detection is extending the engine with one additional rule, not building from scratch. Industry research: modern tools (Sonar, Semgrep, CodeQL) use AST or semantic match (not string match); string match's 15-30% false-positive rate creates decision fatigue when surfaced as `Decision: journey-state-id-drift` events. Author's "string match v1, AST follow-on" path is actually MORE work because (a) deprecation cost forces operator CI migration, (b) inconsistency with existing §13 infrastructure, (c) high v1 FP load compounds decision fatigue. Composes with OQ-10's "4th rule in same engine" resolution — the scan technology choice and engine integration are deeply linked. **Selected over author's lean (string match v1, AST follow-on)** because deprecation cost dominates. **Selected over string-match-only** because persistent false-positive rate creates decision fatigue. **Selected over LSP-based** because per-language tooling burden disproportionate to v1.

**OQ-9 — Cross-soul journeys (the multi-product user path case):** §4 non-goal #5 explicitly excludes these. But practitioners DO have multi-product user flows (e.g., a ProductA onboarding that hands off to ProductB). What's the right operator pattern — separate journey per soul + a "handoff" terminal state, or document this as a known limitation? Recommendation: document as known limitation v1; surface as candidate for a "Cross-Soul Coordination" follow-on RFC if multiple adopters report this.

   **Resolution (2026-05-28, full rubric):** **Document as v1 limitation + concrete per-soul-with-handoff workaround + Decision-Catalog auto-promote on ≥2 distinct adopter requests.** Industry research: Salesforce (Service → Sales → Marketing handoff), Atlassian (Jira → Confluence → BitBucket), HubSpot (Marketing → Sales → CRM), Microsoft 365 — all production multi-product flows use the per-soul-with-handoff pattern via shared correlation IDs (sessionId, userId, customer reference). Concrete v1 workaround documented in operator runbook: (a) each Soul owns its own journey with `transitioned-to-soul-B` terminal state; (b) cross-soul correlation via shared `userId` / `sessionId` in work-item metadata; (c) operator-application owns cross-soul orchestration; (d) framework scores per-soul only; (e) cross-soul completion-rate computed by operator's analytics pipeline. Future RFC via `Decision: cross-soul-journey-coordination-request` (matches RFC-0017 OQ-8 + this RFC OQ-3, OQ-4 pattern). **Selected over author's lean ("vague limitation")** because "known limitation" without workaround leaves operators stranded. **Selected over ship-cross-soul-v1** because substantial scope without practitioner evidence. **Selected over block-cross-soul-use-cases** because operator-hostile (multi-product flows exist in reality).

**OQ-10 — Interaction with RFC-0009's Tessellation Drift detection:** RFC-0009 §13 lists 3 drift detection rules (AST scan, embedding distance, cross-soul provenance). Journey declarations add a 4th class of drift (state-ID drift). Should this be a 4th rule in the same engine, or a separate detector? Recommendation: 4th rule in the same engine — composability with the existing dispatcher is more important than separation of concerns.

   **Resolution (2026-05-28, full rubric):** **4th rule in the same §13 engine + concrete registration mechanism spec'd: `Tessellation§13RuleRegistry.register(rule)`.** Industry research: unified-engine-with-plugin-rules (Sonar, Semgrep, CodeQL, Snyk, Dependabot, Renovate) is the modern de-facto pattern; federated engines arise from organizational boundaries not design choice. Composes with OQ-8 (AST scan reusing §13 Rule #1 infrastructure) and RFC-0028 OQ-7.2 (unified-drift-detection direction). Rule interface: `{ name, description, scan(target): DriftEvent[], severity }`. §13 dispatcher fans out all registered rules in parallel; aggregates Decisions for catalog routing. Concrete new rule: `JourneyStateIdDriftRule` scans substrate code for references to journey-state-id strings; emits `Decision: journey-state-id-drift` when referenced state ID is not declared in any active journey OR the journey itself has been removed. **Selected over author's lean (4th rule in same engine, no registration mechanism)** because Phase 2 implementer would invent the registration shape; spec'ing it prevents convention-by-implementation problem. **Selected over separate-engine** because contradicts OQ-8 + AI-SDLC unification pattern. **Selected over defer-to-Phase-2** because same re-discovery cost.

### 10.1 Configuration Schema (per-Soul / per-org defaults)

Per-organization configurability across the OQ resolutions. Per-Soul overrides codify journey-substrate config:

```yaml
# .ai-sdlc/journey-config.yaml (per-org defaults)
journey:
  limits:                                    # OQ-1
    softWarnAt: 10                           # Miller's 7±2 upper end + industry advisory
    hardLimit: 50                            # Salesforce-style enterprise ceiling

  stateLimits:                               # OQ-2
    softWarnAt: 12                           # Miller's 7±2 + IEEE readability research
    hardLimit: 100                           # sanity guard (typo / runaway-loop), NOT architectural
    softWarnMessage: "Consider splitting into multiple top-level journeys with handoff terminal states (v1 workaround) OR await OQ-3 sub-journey activation (v2)"

  subJourneys:                               # OQ-3
    allowed: false                           # schema-enforced flat
    futureActivationDecision: journey-sub-flow-activation-request
    futurePromotionThreshold:
      distinctAdopterRequests: 2

  completionCriteria:                        # OQ-4
    enumValues: [terminal-success-state, all-states-reached]
    futureActivationDecision: journey-custom-predicate-activation-request
    futurePromotionThreshold:
      distinctAdopterRequests: 2
    futureLanguage: cel                       # Google Common Expression Language

  successMetrics:                            # OQ-5
    contract: operator-supplied
    resource: MetricSnapshot
    staleness:
      thresholdDays: 30                      # per-Soul configurable
      onStale:
        decision: journey-metric-stale
        scoringBehavior: warn-and-unknown    # NOT fail-closed
    futureAdapterPattern: MetricsAdapter      # parallel to RFC-0030 SignalSourceAdapter

  accessibility:                             # OQ-6
    auditOverdueGracePolicy: graduated       # alternatives: binary-30d, hard-block
    graduatedThresholds:
      warnAt: 0                              # days past cadence
      reduced25At: 30
      reduced50At: 60
      effectiveBlockAt: 90
    decisions:
      atWarn: journey-audit-overdue-warn
      atGraduated: journey-audit-overdue-graduated
      atBlocking: journey-audit-overdue-blocking

  wcag:                                      # OQ-7
    enum: additive                           # existing journey declarations stay valid; new can pick latest
    supersededAdvisory:
      enabled: true
      decision: wcag-version-superseded      # advisory only; no scoring impact
    forwardCompatNote: "WCAG 3.0 binary → graduated scoring shift may require `scoringModel` discriminant in future RFC"

  driftDetection:                            # OQ-8 + OQ-10
    integration: rfc-0009-§13-rule-4         # 4th rule in same engine
    registry: Tessellation§13RuleRegistry
    ruleName: JourneyStateIdDriftRule
    scanTechnology: ast                       # reuses §13 Rule #1 AST scan infrastructure
    decisionOnMatch: journey-state-id-drift

  crossSoulCoordination:                     # OQ-9
    v1Mechanism: per-soul-with-handoff-pattern
    correlationField: shared-userId-or-sessionId-in-work-item-metadata
    futureActivationDecision: cross-soul-journey-coordination-request
    futurePromotionThreshold:
      distinctAdopterRequests: 2
```

Default constants ship in the `ai-sdlc init` journey-config template. Per-Soul overrides via the soul's `spec.journeyConfig` block (composes with RFC-0009 substrate). Schema enforces limits at journey-declaration load, lifecycle states at threshold transitions, vendor-prefix for any future adopter override fields.

## 11. Practitioner Validation Plan

InternalAdopter's accessibility audit pipeline drives the validation pass:

| Soul / Variant | Journeys (proposed) | Validates |
|---|---|---|
| ProductA | onboarding, daily-task-management, billing-inquiry-resolution | Multi-flow per soul; completion-rate + time-to-completion metrics |
| ProductB | shift-start, route-completion, end-of-shift-handoff | Mobile-form-factor accessibility (touch targets, voice commands) |
| ProductC | csr-onboarding, customer-self-service, dispute-resolution | Variant-scoped journeys (csr vs. customer-portal use the same product but different journeys) |
| ProductD / annual-test (variant) | submit-test-results, request-extension, view-historical-tests | Regulatory journey with elevated WCAG (`AAA` per state requirement) |

Validation criteria (Mo's edits welcome):
1. Each journey's states + transitions form a valid state machine (no unreachable states, terminal states correctly marked)
2. WCAG audit reports map 1:1 to journey declarations (each audit has a target journey ID)
3. Admission scoring on a real work item (e.g., "improve onboarding completion-rate") produces a higher score when the targeted journey's `completion-rate` metric is below `alertBelow`
4. Variant-scoped journeys (e.g., backflow `annual-test` variant journeys) demonstrate journey-level WCAG elevation working independently of soul-level

## 12. References

- [RFC-0009 Tessellated Design Intent Documents](RFC-0009-tessellated-design-intent-documents.md) — parent Soul DID model
- [RFC-0017 In-Soul Variant Pattern](RFC-0017-in-soul-variant-pattern.md) — journeys can be soul-scoped OR variant-scoped
- [RFC-0008 PPA Triad Integration](RFC-0008-ppa-triad-integration-final-combined.md) — admission scoring foundation; journey scoring extends `targetedSouls`/`targetedVariants` pattern
- [WCAG 2.1 Quick Reference](https://www.w3.org/WAI/WCAG21/quickref/) — referenced by `accessibility.wcagVersion` field

## 13. Revision History

| Version | Date | Author | Notes |
|---|---|---|---|
| v0.1 | 2026-05-04 | Morgan Hirtle | Initial stub (carve-out from RFC-0009 OQ-3). Established summary + practitioner-validation source. |
| v0.2 | 2026-05-04 | Engineering pass (Dominique + Claude Opus 4.7) | Filled §3-§13 from boilerplate. Schema sketch with state machines + accessibility + success metrics; inheritance table; admission-scoring composition (Sα₂ + Cκ + Eρ₅); boundary-vs-just-a-feature; alternatives; 10 open questions; InternalAdopter validation plan. Awaiting Mo's design-authority editorial pass on §5.4 success metrics + §10 OQs. |
| v0.3 | 2026-05-28 | dominique (Operator OQ walkthrough) | Full-rubric resolution of all 10 §10 OQs (problem statement → industry research → 3-4 options with tradeoffs → recommendation + counter-argument per OQ). Resolutions: **(OQ-1)** per-org configurable journey count limits with defaults soft 10 / hard 50 (matches RFC-0017 OQ-1 per-org-config pattern; higher than variant 5/20 because journey count tracks user-flow surface). **(OQ-2)** per-org configurable state cardinality limits with defaults soft 12 / hard 100 (sanity guard, not architectural); concrete operator-actionable warning message pointing at v1 workaround. **(OQ-3)** schema-enforced flat (no nested journeys); future RFC via `Decision: journey-sub-flow-activation-request` at ≥2 distinct adopter requests (matches RFC-0017 OQ-2 + OQ-8 pattern). **(OQ-4)** closed enum for completion-criteria v1 (`terminal-success-state`, `all-states-reached`); future Decision-Catalog auto-promote on ≥2 requests; pre-recommended CEL (Google Common Expression Language) for v2 — captures industry consensus + signals adopters the answer is known. **(OQ-5)** operator-supplied `MetricSnapshot` resource for v1 + `Decision: journey-metric-stale` on stale data (>30d default, per-Soul configurable; warn-and-unknown, NOT fail-closed) + v2 trajectory pre-recommends `MetricsAdapter` pattern parallel to RFC-0030 SignalSourceAdapter. **(OQ-6)** graduated Eρ₅ degradation (0-30d warn / 30-60d -25% / 60-90d -50% / 90d+ blocking) + threshold Decisions + per-Soul `accessibility.auditOverdueGracePolicy` config (preserves stricter `binary-30d` / `hard-block` modes for SOC2/HIPAA shops). **(OQ-7)** additive WCAG-version enum + pre-documented scoring-model shift for WCAG 3.0 (binary → Silver framework graduated; may require `scoringModel` discriminant in future RFC) + `Decision: wcag-version-superseded` advisory on W3C-superseded version use. **(OQ-8)** AST scan from v1 reusing RFC-0009 §13 Rule #1 infrastructure (NOT string match — engine already exists; deprecation cost dominates). **(OQ-9)** v1 limitation with concrete per-soul-with-handoff workaround documented (shared `userId` / `sessionId` correlation, framework scores per-soul only) + future RFC via `Decision: cross-soul-journey-coordination-request`. **(OQ-10)** 4th rule in same §13 engine + concrete registration mechanism (`Tessellation§13RuleRegistry.register(rule)` + standard interface) — composes with OQ-8 + RFC-0028 OQ-7.2 unified-drift-detection direction. §10.1 added consolidating per-Soul / per-org `.ai-sdlc/journey-config.yaml` schema. Cross-cutting framing: operator-impacting journey-lifecycle events route through RFC-0035 G0 catalog. Frontmatter `requires` expanded: added RFC-0035 (catalog routing for journey Decisions). Lifecycle promoted Draft → Ready for Review. Implementation broken into 6 phase tasks: AISDLC-465 (Phase 1 schema additions + count/state limits + inheritance validator + nested rejection), AISDLC-466 (Phase 2 admission scorer composition + completion criteria), AISDLC-467 (Phase 3 §13 4th rule integration — JourneyStateIdDriftRule + Tessellation§13RuleRegistry), AISDLC-468 (Phase 4 MetricSnapshot resource + stale-metric Decision + accessibility cadence graduated degradation), AISDLC-469 (Phase 5 WCAG version evolution + superseded Decision + WCAG 3.0 forward-compat documentation), AISDLC-470 (Phase 6 InternalAdopter reference impl + glossary + conformance tests + cross-soul workaround docs). Engineering + Operator sign-off (Dominique) added; pending Design editorial pass from Mo + Practitioner validation per §11. |
