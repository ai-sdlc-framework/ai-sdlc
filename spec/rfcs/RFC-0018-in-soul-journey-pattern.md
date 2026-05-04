---
id: RFC-0018
title: In-Soul Journey Pattern
status: Draft
lifecycle: Draft
author: morgan@sprypoint.com
created: 2026-05-04
updated: 2026-05-04
targetSpecVersion: v1alpha1
requires:
  - RFC-0009
  - RFC-0017
requiresDocs: []
---

# RFC-0018: In-Soul Journey Pattern

**Document type:** Normative (draft)
**Status:** Draft v0.2 — Initial spec expansion (Engineering pass on Mo's v0.1 stub). Practitioner-validation gates in §11 unresolved; full normative status awaits SpryPoint accessibility-audit-pipeline implementation pass + Mo's design-authority editorial review of §3-§13.
**Created:** 2026-05-04
**Authors:** Morgan Hirtle (Design Authority, SpryPoint)
**Engineering pass:** Dominique Legault, Claude Opus 4.7 (orchestrator), 2026-05-04 — fleshed §3-§13 from Mo's v0.1 stub. Design + accessibility-vertex semantics (specifically §5.4 success metrics + §10 OQs) deferred to Mo for editorial pass.
**Requires:** RFC-0009 (Tessellated Design Intent Documents), RFC-0017 (In-Soul Variant Pattern)

> The bold-style status block above is preserved for human readability. The
> YAML frontmatter at the top of the file is the source of truth for tooling
> (CI, dashboards, the RFC index in `README.md`).

---

## Sign-Off

| Person | Role | Status | Date |
|--------|------|--------|------|
| Morgan Hirtle | Chief of Design / Design Authority | ✍️ Authored v0.1 stub | 2026-05-04 |
| Dominique Legault | CTO / Engineering Authority | ✏️ Engineering pass on v0.2 (pending Design editorial) | 2026-05-04 |
| Alexander Kline | Head of Product Strategy / Product Authority | ✅ Signed v0.2 (endorse pending Mo's editorial pass) | 2026-05-04 |

---

## 1. Summary

A **Journey** is a temporally-ordered user flow within a Soul DID (RFC-0009 §2) or Variant (RFC-0017): a named sequence of states and transitions that carries distinct design intent, completion criteria, accessibility requirements, and success metrics at the journey scope.

This RFC defines the **In-Soul Journey Pattern** — how journeys are declared on a Soul DID (or Variant), how they relate to the parent's design intent surface, how the admission composite (RFC-0008 / RFC-0005) prioritizes work items that advance, repair, or complete a specific journey, and where the boundary lies between "this is a journey" and "this is just a feature."

The pattern is **flow-based, not configuration-based**. Static configuration overlays are RFC-0017's concern; this RFC handles temporal sequences that have entry, intermediate, terminal, and (sometimes) failure states.

**Practitioner validation source:** SpryPoint's accessibility audit pipeline. The WCAG 2.1 AA audit surface maps naturally to journey-level design intent: each product flow (onboarding, payment, backflow reporting, regulatory submission) is a journey with distinct completion criteria and accessibility requirements that cannot be collapsed to soul-level aggregate scoring without losing precision. A WCAG failure on the SpryEngage onboarding journey doesn't tell you anything useful about SpryEngage's billing journey — they have different states, different transitions, different audiences, different success criteria.

## 2. Motivation

Today, the Soul DID model (RFC-0009) gives a single design intent surface per product face, and RFC-0017 adds variant-level configuration overlays. Both are static — they describe a configuration in time, not a sequence through time. But practitioners report:

- A product face contains multiple distinct user flows (onboarding, daily-task, occasional-event, regulatory) each with different completion semantics
- Soul-level success metrics aggregate across all flows, masking per-flow regressions (an onboarding-completion regression averages-out against a healthy daily-task flow)
- WCAG conformance audits MUST be per-flow — auditors evaluate the user's path through the system, not the system's overall configuration
- Work items that target "improve the onboarding flow" need to score against onboarding-specific design intent + accessibility requirements, not soul-aggregate

Specifically observed at SpryPoint: **the WCAG 2.1 AA audit pipeline produces per-flow conformance reports. Today these reports have nowhere to land in the framework's scoring surface — they're operator-implicit context.** The framework treats accessibility as a soul-level compliance regime, but the actual conformance evidence is journey-level.

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
7. **Practitioner validation** — SpryPoint's accessibility audit pipeline proves out journey-scoped scoring + WCAG mapping before normative status

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
- [ ] SpryPoint accessibility audit pipeline as reference implementation (one journey per product flow, minimum)
- [ ] Glossary additions (`Journey`, `targetedJourneys`, `completionCriteria`)
- [ ] Conformance test suite — journey declaration round-trip; admission-scoring composition; inheritance + WCAG-elevation enforcement
- [ ] Author/update each user-facing doc surface declared in `requiresDocs` (currently `[]` — pending tutorial/runbook decision)

## 10. Open Questions

These need design + operator walkthrough before Lifecycle: Draft → Ready for Review.

**OQ-1 — Maximum journeys per Soul/Variant:** Should the schema cap journey count? Recommendation: soft warning at 10+, hard limit at 50. Journeys are heavier than variants — encourage discipline.

**OQ-2 — State cardinality limits:** Per-journey state limit? Recommendation: NO hard limit; surface a soft warning at >12 states (suggests a journey should be split into sub-journeys).

**OQ-3 — Sub-journeys (journey-within-journey):** Can a journey reference another journey as a sub-flow (e.g., "checkout journey embeds payment sub-journey")? Recommendation: NO for v1 — composition adds complexity for a use case we don't have practitioner evidence for. Revisit if multi-step flows surface.

**OQ-4 — Completion-criteria expressiveness:** §5.2 sketches `terminal-success-state | all-states-reached | custom-predicate`. Is `custom-predicate` an arbitrary string DSL, a JS expression, a JsonLogic predicate, or off the table for v1? Recommendation: closed enum for v1 (`terminal-success-state` + `all-states-reached` only); defer `custom-predicate` until adopters surface a real need.

**OQ-5 — Success-metrics source:** §9 mentions an adapter pattern for ingesting metrics like `completion-rate`. What's the adapter contract — operator-supplied numbers, or framework-side polling of an analytics backend? Recommendation: operator-supplied numbers via a typed `MetricSnapshot` resource (operator's analytics pipeline writes them). Frees the framework from analytics-backend integration.

**OQ-6 — Accessibility cadence enforcement:** §5.1's `auditCadence: quarterly | annually | release-gated | continuous` declares cadence but the framework doesn't currently enforce it. Should overdue audits trigger Eρ₅ degradation (compliance-clearance gate fails until audit lands)? Recommendation: YES with a 30-day grace window past the cadence; configurable per Soul.

**OQ-7 — WCAG version evolution:** WCAG 3.0 is in development. How does the schema handle a new WCAG version landing — bump `wcagVersion` enum, leave existing journey declarations valid? Recommendation: additive enum (existing journeys keep their declared version; new journeys can pick the latest); document migration in a follow-on RFC when WCAG 3.0 normative.

**OQ-8 — Drift detection on state ID references:** §6.2 says substrate code referencing a removed state ID is a drift signal. How does the detector find these references — string match on the state ID, AST scan for typed references, or both? Recommendation: string match v1 (cheap, conservative); AST scan in a follow-on if false-positive rate is too high.

**OQ-9 — Cross-soul journeys (the multi-product user path case):** §4 non-goal #5 explicitly excludes these. But practitioners DO have multi-product user flows (e.g., a SpryEngage onboarding that hands off to SpryMobile). What's the right operator pattern — separate journey per soul + a "handoff" terminal state, or document this as a known limitation? Recommendation: document as known limitation v1; surface as candidate for a "Cross-Soul Coordination" follow-on RFC if multiple adopters report this.

**OQ-10 — Interaction with RFC-0009's Tessellation Drift detection:** RFC-0009 §13 lists 3 drift detection rules (AST scan, embedding distance, cross-soul provenance). Journey declarations add a 4th class of drift (state-ID drift). Should this be a 4th rule in the same engine, or a separate detector? Recommendation: 4th rule in the same engine — composability with the existing dispatcher is more important than separation of concerns.

## 11. Practitioner Validation Plan

SpryPoint's accessibility audit pipeline drives the validation pass:

| Soul / Variant | Journeys (proposed) | Validates |
|---|---|---|
| SpryEngage | onboarding, daily-task-management, billing-inquiry-resolution | Multi-flow per soul; completion-rate + time-to-completion metrics |
| SpryMobile | shift-start, route-completion, end-of-shift-handoff | Mobile-form-factor accessibility (touch targets, voice commands) |
| SpryCIS | csr-onboarding, customer-self-service, dispute-resolution | Variant-scoped journeys (csr vs. customer-portal use the same product but different journeys) |
| SpryBackflow / annual-test (variant) | submit-test-results, request-extension, view-historical-tests | Regulatory journey with elevated WCAG (`AAA` per state requirement) |

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
| v0.2 | 2026-05-04 | Engineering pass (Dominique + Claude Opus 4.7) | Filled §3-§13 from boilerplate. Schema sketch with state machines + accessibility + success metrics; inheritance table; admission-scoring composition (Sα₂ + Cκ + Eρ₅); boundary-vs-just-a-feature; alternatives; 10 open questions; SpryPoint validation plan. Awaiting Mo's design-authority editorial pass on §5.4 success metrics + §10 OQs. |
