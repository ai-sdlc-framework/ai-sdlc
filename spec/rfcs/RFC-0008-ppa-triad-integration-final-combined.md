# RFC-0008: PPA Triad Integration

**Document type:** Normative (final)
**Status:** Final v4 — Complete with Addendum A (Engineering Integration), Addendum B (Deterministic-First SA Scoring), and Addendum B CR Resolution
**Created:** 2026-04-03
**Revised:** 2026-04-13
**Authors:** [Author Name]
**Reviewers:** [Design Leadership], [Product Leadership], [Engineering]
**Spec version:** v1alpha1
**Requires:** RFC-0006 (Design System Governance), PPA v1.0

---

## Sign-Off

| Person | Role | Status | Date |
|--------|------|--------|------|
| Dominique Legault | CTO / Engineering Authority | ✅ Approved | 2026-04-04 |
| Morgan Hirtle | Chief of Design / Design Authority | ✅ Approved | 2026-04-13 |
| Alexander Kline | Head of Product Strategy / Product Authority | ✅ Approved | 2026-04-04 |

**Morgan Hirtle Addendum B sign-off notes (2026-04-13):**
- **CR-3 design-domain pattern coverage minimums:** "Approve as specified. The minimums are achievable within Phase 2a given that your design principles are already articulated in the design system."
- **OQ-5 SA-2 coherence interpretation:** "Accept the interpretation. Computable and directional are parallel signals at different timescales — that framing is consistent with how your pipeline already treats design system compliance (a code area can be behind on tokens while a new feature still points the right direction)."

---

## Revision History

| Version | Date | Summary |
|---------|------|---------|
| v1 | 2026-04-03 | Initial draft. Defines five integration connections closing the Product↔Design edge of the PPA triad. Introduces the Design Intent Document as a shared foundational artifact. |
| v2 | 2026-04-03 | Added C6 (post-ship design quality feedback to PPA Cκ calibration) and C7 (PPA design lookahead notification to design team). Completes all six directional flows identified in the Contribution Analysis. |
| v3 | 2026-04-03 | Added Addendum A: Engineering Integration Gaps. Addresses four engineering-side flow gaps: PPA→Engineering handoff enrichment with Eρ₄ breakdown, design-centric Learn phase metrics, DesignQualityTrendDegrading reconciliation event, Design→Engineering lookahead for token schema changes. Also adds Source Trust Model for Dπ₁ to resolve internal-team scoring collapse. |
| v4 | 2026-04-03 | Incorporates Product pillar formal review (Alexander Kline, April 2026). Six amendments applied: (A1) DID split-authority ownership model; (A2) C1 LLM assessment double-counting elimination; (A3) Eρ₄ lifecycle escape valve for bootstrap and pre-design-system phases; (A4) HC weight restoration — consensus 0.45, decision 0.25, HC_design 0.10, HC_override restored as bypass mechanism not a weighted term; (A5) Addendum A §A.6 composite aligned with PPA formula with Admission Scoring Subset documented; (A6) Pillar Perspective Breakdown added to scoring output and C7 payload. All seven open questions resolved with Product positions. PPA v1.1 direction section added (§17). Internal consistency error between §3.2 and §9.2 HC weights corrected. |
| Addendum B | 2026-04-04 | Added Addendum B: Deterministic-First SA Scoring. Three-layer architecture (deterministic → structural BM25 → LLM) replacing embedding-only SA scoring. DID structured fields for Layer 1. spaCy dep-parse rule engine. BM25 scorer for Layer 2. Exemplar bank for Layer 3 calibration. Feedback flywheel and SoulDriftDetected monitoring. |
| Addendum B CR Resolution | 2026-04-04 | CR-1: corrected SA-2 formula (removed self-multiplication of principleAlignment). CR-2: w_structural floor ≥ 0.20 spec decision. CR-3: detection pattern test tool promoted to Phase 2a deliverable; Phase 2b gate conditions revised with pattern coverage minimums. |
| v4 (final) | 2026-04-13 | All-pillar sign-off received on all documents. CR patches applied inline to Addendum B (§B.7.2 corrected formula, §B.7.3 weight floor, §B.10 test tool and gate conditions). All Addendum B open questions closed. Three RFC-0008 documents consolidated into this single file. Implementation fully unblocked across all scope. |

---

## Table of Contents

**Core RFC**
1. [Summary](#1-summary)
2. [Motivation](#2-motivation)
3. [The Triad Architecture](#3-the-triad-architecture)
4. [The Design Intent Document](#4-the-design-intent-document)
5. [Connection 1: DesignSystemBinding → Sα₂ Vibe Coherence](#5-connection-1-designsystembinding--sα₂-vibe-coherence)
6. [Connection 2: DesignSystemBinding Status → Eρ₄ Design System Readiness](#6-connection-2-designsystembinding-status--eρ₄-design-system-readiness)
7. [Connection 3: AI-SDLC Quality Metrics → Dπ₁ Risk Adjustment](#7-connection-3-ai-sdlc-quality-metrics--dπ₁-risk-adjustment)
8. [Connection 4: AutonomyPolicy Level → Eρ₂ Hard Cap](#8-connection-4-autonomypolicy-level--eρ₂-hard-cap)
9. [Connection 5: HC_design — Design Lead Signal Channel](#9-connection-5-hc_design--design-lead-signal-channel)
10. [Connection 6: Post-Ship Design Quality → PPA Cκ Calibration](#10-connection-6-post-ship-design-quality--ppa-cκ-calibration)
11. [Connection 7: PPA Design Lookahead → Design Team Preparation](#11-connection-7-ppa-design-lookahead--design-team-preparation)
12. [Implementation Sequencing](#12-implementation-sequencing)
13. [Worked Example](#13-worked-example)
14. [Security and Authority Considerations](#14-security-and-authority-considerations)
15. [Open Questions](#15-open-questions)
16. [References](#16-references)
17. [PPA v1.1 Direction](#17-ppa-v11-direction)

**Addendum A: Engineering Integration Specification**
- [A.1 Scope](#a1-scope)
- [A.2 Enriched PPA Handoff](#a2-enriched-ppa-handoff)
- [A.3 Design-Centric Learn Phase Metrics](#a3-design-centric-learn-phase-metrics)
- [A.4 Admission Input Enrichment](#a4-admission-input-enrichment)
- [A.5 Admission Scoring Function](#a5-admission-scoring-function)
- [A.6 Admission Result and Pillar Breakdown](#a6-admission-result-and-pillar-breakdown)
- [A.7 DesignQualityTrendDegrading Reconciliation Event](#a7-designqualitytrenddegrading-reconciliation-event)
- [A.8 Design Authority Signal Monitoring](#a8-design-authority-signal-monitoring)
- [A.9 Design→Engineering Lookahead for Token Schema Changes](#a9-designengineering-lookahead-for-token-schema-changes)
- [A.10 Directional Flow Completion](#a10-directional-flow-completion)

**Addendum B: Deterministic-First SA Scoring**
- [B.1 Motivation](#b1-motivation)
- [B.2 Architectural Pattern](#b2-architectural-pattern)
- [B.3 DID Extensions for the Deterministic Layer](#b3-did-extensions-for-the-deterministic-layer)
- [B.4 Layer 1: Deterministic Scorer](#b4-layer-1-deterministic-scorer)
- [B.5 Layer 2: Structural Scorer](#b5-layer-2-structural-scorer)
- [B.6 Layer 3: LLM Scorer](#b6-layer-3-llm-scorer)
- [B.7 Composite Scoring](#b7-composite-scoring)
- [B.8 Feedback Flywheel](#b8-feedback-flywheel)
- [B.9 Scoring Stability Monitoring](#b9-scoring-stability-monitoring)
- [B.10 Phased Sequencing](#b10-phased-sequencing)
- [B.11 Impact on Existing RFC-0008 Sections](#b11-impact-on-existing-rfc-0008-sections)
- [B.12 Open Questions — Final Dispositions](#b12-open-questions--final-dispositions)

**Addendum C: CR Resolution Record**
- [C.1 CR-1: SA-2 Formula Correction](#c1-cr-1-sa-2-formula-correction)
- [C.2 CR-2: Phase 3 Structural Weight Floor](#c2-cr-2-phase-3-structural-weight-floor)
- [C.3 CR-3: Detection Pattern Test Tool and Phase Gate](#c3-cr-3-detection-pattern-test-tool-and-phase-gate)
- [C.4 v1.2 Planning Additions Confirmation](#c4-v12-planning-additions-confirmation)
- [C.5 Open Question Final Dispositions](#c5-open-question-final-dispositions)

---

## 1. Summary

This RFC closes the Product↔Design edge of the PPA triad — the integration between the PPA product prioritization system and the design governance layer defined in RFC-0006. It specifies seven connections that give design system health, design authority, delivery risk, and post-ship quality outcomes formal structural influence over product prioritization — and give the design team proactive visibility into upcoming work — completing the architecture required for Product, Design, and Engineering to operate as equally weighted disciplines.

This RFC also resolves a foundational gap identified in design leadership review: neither PPA v1.0 nor RFC-0006 defines the authoritative *design intent artifact* that both systems need to reference. Section 4 introduces the Design Intent Document as that shared artifact and specifies its ownership, structure, and relationship to the `DesignSystemBinding` resource.

**v4 note:** This version incorporates the formal Product pillar review from Alexander Kline (Head of Product Strategy, Arcana Concept Studio). The review identified structural issues with DID ownership, the HC formula, Eρ₄ gate behavior for bootstrap products, the §A.6 composite implementation, and the absence of scoring provenance output. All six blocking and required amendments are incorporated in full. A PPA v1.1 direction section (§17) captures four architectural changes this RFC surfaces that require a PPA version increment.

---

## 2. Motivation

### 2.1 The Missing Edge

PPA v1.0 frames the autonomous development system as a trifecta of three pillars:

| Pillar | System | Integration Status |
|--------|--------|-------------------|
| Engineering | AI-SDLC pipeline (RFC-0002, RFC-0004, RFC-0006) | Three explicit integration points with Product |
| Product | PPA scoring model | Well-specified |
| Design | RFC-0006 design governance layer | **Zero explicit integration points with Product** |

A true triad requires all three edges to be specified:

```
        Product (PPA)
           /     \
    Edge 1/       \Edge 3
         /         \
Engineering ——————— Design
        Edge 2
```

**Edge 1 (Product ↔ Engineering):** Partially specified in PPA v1.0 Section 5. Three integration points exist but two have gaps (addressed in Connections 3 and 4 below).

**Edge 2 (Engineering ↔ Design):** Specified in RFC-0006. Design system governance gates engineering execution. Stewardship model (§5.3) defines shared authority.

**Edge 3 (Product ↔ Design):** Unresolved. This is the missing edge. PPA's Soul Alignment dimension (Sα) currently references a "soul purpose definition document" maintained independently from the design governance layer. These two systems describe the same thing — what the product *is* and what it *should feel like* — from different vantage points, with no connection between them.

This RFC specifies Edge 3 and sharpens Edge 1.

### 2.2 Why Equal Weight Requires Structural Connection

If Product, Design, and Engineering are genuinely equally weighted, the architecture must reflect that equality — not just assert it. Currently:

- Engineering has three explicit integration points with Product (PPA v1.0 §5)
- Design has zero explicit integration points with Product (PPA v1.0 §8: "The interface between PPA and a design governance system has not been specified.")
- Design and Engineering are connected via RFC-0006, but design authority over that connection was only established in the v2 stewardship model

Without Edge 3, design leadership's influence on what gets built is informal — it enters through generic team consensus or meeting decisions, the same channels used by any team member. Design authority has no structural weight on the dimensions specifically within its domain.

### 2.3 The Soul Purpose Document Problem

PPA v1.0 computes Sα₂ (Vibe Coherence) via LLM assessment against "brand and UX guidelines." RFC-0006 `DesignSystemBinding` contains the token schema (mathematical expression of brand decisions), the component manifest (behavioral expression of brand decisions), and compliance rules (what violations look like). These are describing the same system from different angles, but neither document creates the shared artifact that both reference. This is a duplication problem waiting to become a divergence problem. Section 4 resolves it.

---

## 3. The Triad Architecture

### 3.1 Connection Map

The seven connections in this RFC close all three edges:

| Connection | From | To | Edge |
|------------|------|----|------|
| C1 | DesignSystemBinding | Sα₂ Vibe Coherence | Design → Product |
| C2 | DesignSystemBinding status | Eρ₄ (new sub-component) | Design → Product (via Engineering) |
| C3 | AI-SDLC quality metrics | Dπ₁ risk adjustment | Engineering → Product |
| C4 | AutonomyPolicy level | Eρ₂ hard cap | Engineering → Product |
| C5 | HC_design (new channel) | HC composite | Design → Product (human layer) |
| C6 | Design feedback flywheel | PPA Cκ calibration | Design → Product (post-ship) |
| C7 | PPA priority stack | Design team lookahead | Product → Design |

### 3.2 Data Flow

> **v4 correction:** The HC formula in this diagram was inconsistent with §9.2 in v3. Both now reflect the Amendment 4 formula. HC_override is not a weighted term; it is a bypass mechanism and does not appear in the composite formula.

```
┌──────────────────────────────────────────────────────────────┐
│                     PPA SCORING MODEL                        │
│                                                              │
│  Sα = Sα₁ · Sα₂ · Sα₃                                      │
│           ▲                                                  │
│           │ C1: Vibe Coherence grounded                      │
│           │     in DesignIntentDocument                      │
│                                                              │
│  Eρ = min(Eρ₁, Eρ₂, Eρ₃, Eρ₄)                              │
│                ▲           ▲                                 │
│           C4:  │      C2:  │                                 │
│      Autonomy  │   DS      │                                 │
│      hard cap  │   Readiness (lifecycle-aware)               │
│                                                              │
│  Dπ₁_adjusted = Dπ₁_normalized × (1 − defect_risk_factor)   │
│                                        ▲                     │
│                                   C3:  │                     │
│                                Quality metrics               │
│                                                              │
│  HC = tanh(0.2·HC_exp + 0.45·HC_con + 0.25·HC_dec           │
│            + 0.10·HC_design)                                 │
│                      ▲                                       │
│                 C5:  │                                       │
│            Design lead channel                               │
│                                                              │
│  [Scoring Output includes pillarBreakdown per §A.6]          │
└──────────────────────────────────────────────────────────────┘
        ▲           ▲           ▲           ▲
        │           │           │           │
┌───────┴──┐  ┌─────┴────┐  ┌──┴─────┐  ┌──┴──────────┐
│ Design   │  │ AI-SDLC  │  │ AI-SDLC│  │ Design      │
│ System   │  │ Autonomy │  │ Quality│  │ Leadership  │
│ Binding  │  │ Policy   │  │ Metrics│  │ (stewardship│
│ (RFC-006)│  │ (v1α1)   │  │ (Learn)│  │  model)     │
└──────────┘  └──────────┘  └────────┘  └─────────────┘
```

---

## 4. The Design Intent Document

### 4.1 Problem Statement

PPA's Sα₂ assessment references "brand and UX guidelines." RFC-0006's `DesignSystemBinding` contains tokens, component manifests, and compliance rules. Both systems model what the product *is* and what it *should feel like*, but neither creates the shared artifact that grounds both. Without this artifact:

- PPA maintains a separate copy of brand guidelines that can drift from the design system
- RFC-0006's `DesignSystemBinding` has no formal link to the product's strategic intent
- Design leadership has no single document that bridges their strategic vision (what the product should feel like) with the operational system (how the design system enforces it)

### 4.2 The Design Intent Document (DID)

The Design Intent Document is the authoritative artifact that defines the product's design intent at the strategic level. It is the document that both PPA and `DesignSystemBinding` reference — the shared root of the triad's design axis.

> **v4 change (Amendment 1):** The `stewardship` block now uses a split-authority model with separate `productAuthority`, `designAuthority`, `sharedAuthority`, and `engineeringReview` sub-fields. The single-owner model from v3 is replaced. See §4.4 for the full rationale.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignIntentDocument
metadata:
  name: acme-product-intent
  namespace: product-acme
  labels:
    product: acme-app
    version: "2.0"
spec:
  # --- OWNERSHIP (split-authority model, see §4.4) ---
  stewardship:
    # Product-domain fields: Product owns, Design approves
    productAuthority:
      owner: product-lead
      approvalRequired: [product-lead, design-lead]
      scope:
        - soulPurpose.mission
        - experientialTargets

    # Design-domain fields: Design owns, Product approves
    designAuthority:
      owner: design-lead
      approvalRequired: [design-lead, product-lead]
      scope:
        - soulPurpose.designPrinciples
        - brandIdentity
        - visualIdentity

    # Shared fields: either can propose, both must approve
    sharedAuthority:
      approvalRequired: [design-lead, product-lead]
      scope:
        - designSystemRef.syncFields

    # Engineering: reviewer on all, blocker only on measurableSignal feasibility
    engineeringReview:
      role: reviewer
      blockingScope: [designPrinciples.*.measurableSignal]

    reviewCadence: quarterly             # Reviewed every quarter at minimum

  # --- STRATEGIC INTENT ---
  soulPurpose:
    # Owned by productAuthority
    mission: >
      Acme helps small businesses manage inventory without
      requiring technical expertise. Every interaction should
      feel like a knowledgeable colleague helping, not a
      software system demanding.

    # Owned by designAuthority
    designPrinciples:
      - id: approachable-first
        name: "Approachable First"
        description: >
          Every component should be understandable on first encounter.
          Progressive disclosure over upfront complexity. When in doubt,
          remove options rather than add tooltips.
        measurableSignal: >
          Usability simulation task completion rate ≥ 85% for
          low-tech-confidence personas.
      - id: calm-confidence
        name: "Calm Confidence"
        description: >
          The interface communicates trustworthiness through visual
          stability. Minimal animation. Consistent spatial rhythm.
          No layout shifts. Information density is moderate — enough
          to feel informative without feeling overwhelming.
        measurableSignal: >
          Design review rejection rate for 'visual-quality' category
          ≤ 10%. Visual regression diff rate ≤ 2% across releases
          (indicating spatial stability).
      - id: efficient-depth
        name: "Efficient Depth"
        description: >
          Power users can access advanced features without the interface
          becoming complex for new users. Depth is earned through
          interaction, not displayed by default.
        measurableSignal: >
          Component reuse rate ≥ 70%. New components justified by
          catalog gap analysis, not feature-specific custom UI.

  # --- DESIGN SYSTEM BINDING (sharedAuthority) ---
  designSystemRef:
    name: acme-design-system             # Reference to DesignSystemBinding
    namespace: team-frontend
    bindingType: authoritative           # DID governs DesignSystemBinding intent
    syncFields:
      - did: soulPurpose.designPrinciples
        dsb: compliance.disallowHardcoded
        relationship: "Principles inform compliance rules"
      - did: soulPurpose.mission
        dsb: designReview.scope
        relationship: "Mission context provided to design reviewers"

  # --- BRAND IDENTITY (designAuthority) ---
  brandIdentity:
    voiceAttributes: ["helpful", "knowledgeable", "patient", "concise"]
    visualIdentity:
      description: >
        Clean, warm, professional. White space communicates calm.
        Primary blue communicates trust. Rounded corners communicate
        approachability. Type scale emphasizes readability over style.
      tokenSchemaRef: "acme-design-system.spec.tokens"
      # The token schema IS the mathematical expression of this description.
      # This field ensures no separate "brand guidelines" copy exists.

  # --- EXPERIENTIAL TARGETS (productAuthority) ---
  experientialTargets:
    onboarding:
      targetEmotion: "I can do this"
      maxStepsToFirstValue: 3
      usabilityTarget:
        taskCompletion: 0.90
        personaType: low-tech-confidence
    dailyUse:
      targetEmotion: "This saves me time"
      interactionEfficiency:
        metric: actions-per-task
        targetReduction: "20% vs. manual process"
    errorRecovery:
      targetEmotion: "That's okay, I know how to fix this"
      errorRecoveryRate: 0.95
      maxActionsToRecover: 3

status:
  lastReviewed: "2026-01-15T00:00:00Z"
  reviewedBy: ["design-lead", "product-lead"]
  nextReviewDue: "2026-04-15T00:00:00Z"
  designSystemAlignment:
    tokenSchemaCoherent: true
    complianceRulesReflectPrinciples: true
    lastAlignmentCheck: "2026-03-28T00:00:00Z"
  ppaBinding:
    sAlpha2Source: "acme-product-intent"
    lastScoringRun: "2026-04-01T00:00:00Z"
```

### 4.3 Relationship to Existing Resources

```
┌──────────────────────────────────────────────────────────────────┐
│               Design Intent Document (DID)                       │
│                                                                  │
│  productAuthority fields          designAuthority fields         │
│  ┌─────────────────────────┐     ┌──────────────────────────┐   │
│  │ mission (Product-owned) │     │ designPrinciples         │   │
│  │ experientialTargets     │     │ brandIdentity            │   │
│  │ ← SA-1 input           │     │ visualIdentity           │   │
│  └─────────────────────────┘     │ ← SA-2 input            │   │
│                                  └──────────────────────────┘   │
└────────────────────────┬───────────────────┬─────────────────────┘
                         │                   │
                 governs │                   │ grounds
                  intent │                   │ assessment
                         ▼                   ▼
               ┌──────────────┐     ┌──────────────────┐
               │ DesignSystem │     │  PPA             │
               │ Binding      │     │  Sα₁ ← mission   │
               │ (RFC-0006)   │     │  Sα₂ ← design    │
               │ "How is it   │     │  principles +    │
               │  enforced?"  │     │  brand identity  │
               └──────────────┘     └──────────────────┘
```

**The DID is the strategic layer.** It defines *what the product should feel like* in human language with measurable signals. Its fields are split between product-domain and design-domain authority; both pillars retain veto power through the mutual approval requirement.

**The DesignSystemBinding is the operational layer.** It defines *how the design system enforces* those intentions through tokens, compliance rules, and quality gates.

**PPA's Sα is the evaluation layer.** Sα₁ (Problem Resonance) is grounded in the DID's `mission` field, which is Product-owned. Sα₂ (Vibe Coherence) is grounded in the DID's `designPrinciples` and `brandIdentity` fields, which are Design-owned.

### 4.4 Ownership Model

> **v4 change (Amendment 1):** Replaces v3's single-owner model. The rationale for the change is that the DID contains two categorically different types of content: product-domain content (mission, experiential targets) that feeds SA-1 and is a Product decision, and design-domain content (design principles, brand identity) that feeds SA-2 and is a Design decision. Under the v3 model, Design Lead could unilaterally modify the mission statement that feeds SA-1, giving Design structural control over the most fundamental input to PPA's Problem Resonance scoring. The split-authority model preserves equal standing: both pillars hold veto power through the mutual approval requirement, but the initiating authority reflects the domain of the content.

The DID MUST use a split-authority stewardship model:

| Field Group | Owner | Approvers | Rationale |
|-------------|-------|-----------|-----------|
| `soulPurpose.mission` | Product Lead | Product Lead + Design Lead | Mission is the literal input to SA-1 (Problem Resonance). It is a Product decision what problem the product solves and for whom. |
| `experientialTargets` | Product Lead | Product Lead + Design Lead | Desired outcomes (task completion rates, efficiency gains) are Product decisions about what users should achieve. |
| `soulPurpose.designPrinciples` | Design Lead | Design Lead + Product Lead | Design principles define how the product feels. This is Design's domain. |
| `brandIdentity` | Design Lead | Design Lead + Product Lead | Visual and voice identity are Design decisions. |
| `visualIdentity` | Design Lead | Design Lead + Product Lead | Token schema reference and spatial/typographic principles are Design decisions. |
| `designSystemRef.syncFields` | Either | Both must approve | The sync mapping between DID and DesignSystemBinding affects both pillars. |
| Engineering Lead | Reviewer on all | — | Engineering reviews for technical feasibility. Can block only if a `measurableSignal` is technically infeasible to measure. Cannot block on content. |

**Documents drift toward their owner's perspective.** The split-authority model ensures product strategic intent drifts toward Product's perspective and design intent drifts toward Design's. Both pillars retain veto power through the mutual approval requirement, preserving the collaborative model while fixing the structural asymmetry.

**Review cadence:** The DID MUST be reviewed at least quarterly. The review MUST include a check that the `DesignSystemBinding`'s compliance rules and token schema still reflect the DID's design principles. Drift between the DID and the `DesignSystemBinding` is surfaced as a `DesignIntentDrift` reconciliation event (continuous, per Open Question 5 resolution in §15).

### 4.5 Schema Requirements

The `DesignIntentDocument` resource MUST be validated against JSON Schema (draft 2020-12). Required fields:

- `spec.stewardship.productAuthority.owner` — MUST be a principal with `productAuthority` in the team
- `spec.stewardship.designAuthority.owner` — MUST be a principal with `designAuthority` in the referenced `DesignSystemBinding`
- `spec.soulPurpose.mission` — MUST be non-empty (Product-owned)
- `spec.soulPurpose.designPrinciples` — MUST contain at least one principle with a `measurableSignal` (Design-owned)
- `spec.designSystemRef.name` — MUST reference an existing `DesignSystemBinding`
- `spec.brandIdentity.tokenSchemaRef` — MUST point to the token source in the referenced `DesignSystemBinding`

---

## 5. Connection 1: DesignSystemBinding → Sα₂ Vibe Coherence

**Edge:** Design → Product
**PPA open question resolved:** Section 8, "Design Layer Integration"

### 5.1 Current State

PPA computes Sα₂ (Vibe Coherence) via LLM assessment against "brand and UX guidelines." This implies a separate copy of brand guidelines maintained within PPA's data model, independent of the design governance system.

RFC-0006 `DesignSystemBinding` already contains the token schema (mathematical expression of brand decisions), the component manifest (behavioral expression of brand decisions), and compliance rules (what violations look like).

These are the same source of truth. PPA's brand guidelines copy is a duplication problem.

### 5.2 Specification

> **v4 change (Amendment 2):** Eliminates double-counting in the SA-2 scoring model. The LLM assessment is now restricted to principle and brand alignment only. Token compliance and catalog health are excluded from the LLM prompt context because they are already captured in the computable component. Including them in the LLM prompt caused them to penalize the score twice: once in the deterministic computable component and again through LLM inference from the same data. Deterministic signals are scored deterministically; the LLM handles semantic judgment.

PPA's Sα₂ assessment MUST read from the `DesignIntentDocument` resource (§4) as its primary input, with a clean separation between computable and LLM-assessed components:

```yaml
sAlpha2:
  source: design-intent-document
  ref: acme-product-intent

  scoring:
    # --- COMPUTABLE COMPONENT ---
    # Deterministic metrics scored deterministically.
    # No LLM involvement.
    computable:
      tokenComplianceWeight: 0.3
      catalogHealthWeight: 0.2
      inputs:
        - field: designSystemBinding.status.tokenCompliance.currentCoverage
          usage: >
            Token compliance percentage in the affected code area.
            Coverage below the DID's measurableSignal threshold
            penalizes Sα₂ for the work item.
        - field: designSystemBinding.status.catalogHealth.coveragePercent
          usage: >
            Component catalog coverage. Low catalog health in the
            feature's component category indicates the work item
            may introduce design inconsistency.

    # --- LLM-ASSESSED COMPONENT ---
    # Restricted to semantic/qualitative judgment only.
    # Computable metrics are EXCLUDED from the prompt to prevent double-counting.
    llmAssessed:
      weight: 0.5
      model: "claude-sonnet-4-20250514"
      temperature: 0.1
      inputs:
        - field: spec.soulPurpose.designPrinciples   # Design-owned: semantic alignment
        - field: spec.brandIdentity.visualIdentity   # Design-owned: brand coherence
      excludedFromPrompt:
        - tokenCompliance   # Scored in computable component
        - catalogHealth     # Scored in computable component
      prompt: >
        Given the design principles: {designPrinciples}
        And the brand identity: {brandIdentity}
        Evaluate whether this work item: {workItemDescription}
        is consistent with the product's design intent.
        Score from 0.0 (contradicts intent) to 1.0 (reinforces intent).
        Do not factor in token compliance or catalog health — those are
        assessed separately. Focus on semantic alignment with design
        principles and brand direction.
        Provide evidence for your score.
```

**Final Sα₂ formula:**

`Sα₂ = (0.3 × tokenCompliance) + (0.2 × catalogHealth) + (0.5 × llmPrincipleAlignment)`

The three components are independent. The LLM assesses what math cannot express (semantic alignment with design intent); the computable metrics assess operational compliance.

### 5.3 Authority Consequence

This connection resolves a governance gap identified in the RFC-0006 design leader review. If Sα₂ reads from the `DesignIntentDocument`'s `designPrinciples` and `brandIdentity` fields, and Design Lead owns those fields under the split-authority model (§4.4), then design leaders have formal authority over the Vibe Coherence input to PPA's prioritization.

Symmetrically: SA-1 (Problem Resonance) reads from the DID's `mission` field, which is Product-owned. Product's authority over problem definition is preserved in the scoring model.

Design authority is no longer advisory — it is structurally embedded in the scoring model. Product authority over strategic direction is equally embedded. Neither pillar controls the other's scoring inputs.

### 5.4 Elimination of Duplicate Source of Truth

PPA v1.0's separate "brand and UX guidelines" copy MUST be deprecated. The `DesignIntentDocument` is the single authoritative source. Any existing brand guidelines content SHOULD be migrated into the DID during the adoption phase.

---

## 6. Connection 2: DesignSystemBinding Status → Eρ₄ Design System Readiness

**Edge:** Design → Product (via Engineering)
**Gap filled:** PPA's Execution Reality dimension has no awareness of design system readiness

### 6.1 Current State

PPA computes:

`Eρ = min(Eρ₁ resource availability, Eρ₂ inverse complexity, Eρ₃ dependency clearance)`

This is a pure engineering readiness assessment. It does not ask: is the design system ready to support this feature category? A feature might score high on Soul Alignment and Demand Pressure with no engineering dependencies — but require a component category that doesn't exist in the catalog. The current model scores this as fully executable. It is not.

### 6.2 Specification

> **v4 change (Amendment 3):** Adds a lifecycle phase qualifier to the Eρ₄ specification. The v3 normative spec stated "If CatalogAvailable == False: Eρ₄ = 0.0" with no escape valve, while Addendum A §A.5 defaulted to 1.0 when `designSystemContext` is undefined — creating a contradiction between the spec and the implementation. The lifecycle qualifier resolves this contradiction and addresses the bootstrap deadlock: products entering without a declared design system should not be penalized for the absence of infrastructure they have not yet declared intent to govern.

Add `Eρ₄` (Design System Readiness) as a fourth sub-component:

`Eρ = min(Eρ₁, Eρ₂, Eρ₃, Eρ₄)`

`Eρ₄` is computed with lifecycle phase awareness:

```yaml
eRho4:
  source: design-system-binding
  ref: acme-design-system

  lifecyclePhase:
    # Phase A: No DesignSystemBinding declared
    # Products without a declared design system are not penalized.
    # The gate activates only when a team declares a DesignSystemBinding,
    # signaling intent to govern design system compliance.
    # Follows DP-6 (Progressive Enforcement): start permissive, graduate to mandatory.
    preDesignSystem:
      condition: "No DesignSystemBinding exists for this product namespace"
      eRho4: 1.0

    # Phase B: Bootstrap period
    # New design systems need a bootstrap window. During the first 90 days
    # after DesignSystemBinding declaration, Eρ₄ is floored at 0.3 to prevent
    # total pipeline lockout while the catalog is being populated.
    catalogBootstrap:
      condition: >
        DesignSystemBinding exists AND catalogHealth.coveragePercent < 0.2
        AND DesignSystemBinding was created within the last 90 days
      eRho4: "max(0.3, computed value)"

    # Phase C: Fully governed
    # After 90 days or when coverage exceeds 20%, the floor is removed
    # and Eρ₄ is fully computed from the formula below.
    postDesignSystem:
      condition: >
        DesignSystemBinding exists AND (catalogHealth.coveragePercent >= 0.2
        OR DesignSystemBinding age > 90 days)
      eRho4: "computed per formula below"

  computation:
    # Factor 1: Catalog coverage for the feature's component category
    catalogCoverage:
      input: status.catalogHealth.coveragePercent
      scope: feature-component-category   # Filtered to relevant category
      weight: 0.4

    # Factor 2: Token compliance in the affected code area
    tokenCompliance:
      input: status.tokenCompliance.currentCoverage
      scope: affected-code-area
      weight: 0.3

    # Factor 3: Visual baseline coverage
    baselineCoverage:
      input: percentage of affected component stories with visual baselines
      weight: 0.3

  formula: >
    Phase A (preDesignSystem): Eρ₄ = 1.0
    Phase B (catalogBootstrap): Eρ₄ = max(0.3, computed)
    Phase C (postDesignSystem):
      Eρ₄ = (0.4 × catalogCoverage + 0.3 × tokenCompliance + 0.3 × baselineCoverage)

  note: >
    The CatalogAvailable condition from v3 (hard gate to 0.0) is subsumed
    by Phase C's computation: if the catalog has no components in the required
    category, catalogCoverage = 0.0, driving Eρ₄ toward a low value through
    the formula rather than a hard floor. This preserves the scoring pressure
    to fill catalog gaps while allowing the bootstrap floor in Phase B.
```

### 6.3 Consequences

The `min()` structure means design system unreadiness suppresses execution scores. The lifecycle model means this pressure only activates after a team has declared governance intent, not before.

**Implicit infrastructure prioritization:** Catalog gaps lower Eρ₄ for features in that category, surfacing infrastructure deficits as a scoring consequence before work is ever queued. A team that sees multiple high-demand features scoring low on Eρ will naturally prioritize design system infrastructure work to unblock them.

**Design system health becomes upstream of task selection.** In the current model, design system health only affects quality gates within a pipeline run (RFC-0006). With Eρ₄, it also affects which tasks are selected in the first place. This is the difference between catching a problem at review time and preventing the problem at planning time.

**Bootstrap safety valve.** New portfolio companies entering through the Forge can begin building features immediately. The design system governance gate activates progressively as the team declares and populates their design system.

---

## 7. Connection 3: AI-SDLC Quality Metrics → Dπ₁ Risk Adjustment

**Edge:** Engineering → Product
**Gap filled:** Demand Pressure is pure signal with no delivery risk adjustment

### 7.1 Current State

PPA's Dπ (Demand Pressure) accumulates customer requests, builder conviction, and bug urgency. The AI-SDLC's Learn phase captures post-execution metrics — defect density, churn rate, code acceptance rate — that live in the engineering layer and never inform the product prioritization layer.

### 7.2 Specification

`Dπ₁` (Customer Signal Accumulation) carries a risk adjustment factor derived from the AI-SDLC's quality metrics for the code area the work item touches:

```yaml
dPi1Adjusted:
  formula: "Dπ₁_normalized × (1 − defect_risk_factor)"

  defectRiskFactor:
    source: ai-sdlc-learn-phase
    inputs:
      - metric: defect-density
        scope: affected-code-area
        window: "90d"                     # Trailing 90-day window
        normalization: "percentile-rank"  # Normalized to [0, 1]
        weight: 0.5

      - metric: code-churn-rate
        scope: affected-code-area
        window: "90d"
        normalization: "percentile-rank"
        weight: 0.3

      - metric: pr-rejection-rate
        scope: affected-code-area
        window: "90d"
        normalization: "percentile-rank"
        weight: 0.2

    # defect_risk_factor = weighted sum, clamped to [0, 0.5]
    # Clamping at 0.5 means demand can never be more than halved by risk.
    # Demand remains demand — it gets discounted by delivery confidence.
    clamp: [0.0, 0.5]
```

### 7.3 What This Captures

High demand for a feature in a high-defect code area should rank lower than the same demand level in a clean area — not because the demand is less real, but because the actual delivery risk is higher. This is a modifier within Dπ₁, not a separate dimension, and does not duplicate Eρ (which measures resource and dependency readiness, not code area health).

### 7.4 Boundary Condition

If the AI-SDLC Learn phase has insufficient data for the affected code area (e.g., new module with no history), `defect_risk_factor` defaults to 0.0 (no adjustment). The system does not penalize features in areas with no data — it only discounts features in areas with demonstrated quality problems.

> **Open Question 4 resolution:** Default to 0.0. No fallback to external tools (SonarQube, CodeClimate). Product position: incentivizing Learn phase adoption is the correct behavior. Teams that want C3 risk adjustment must adopt the full pipeline.

---

## 8. Connection 4: AutonomyPolicy Level → Eρ₂ Hard Cap

**Edge:** Engineering → Product
**Gap filled:** Execution Reality reads complexity but not the autonomy level required to execute

### 8.1 Current State

PPA reads the AI-SDLC's complexity assessment for `Eρ₂`. A complexity-5 task requiring only Level 1 autonomy and a complexity-5 task requiring Level 3 autonomy are treated identically. But if the team's `AutonomyPolicy` is capped at Level 2, the second task cannot be fully autonomous — it will require human-led execution or will stall.

### 8.2 Specification

`Eρ₂` incorporates the required autonomy level from `AutonomyPolicy`:

```yaml
eRho2:
  base: inverse-complexity              # Existing computation
  autonomyAdjustment:
    source: autonomy-policy
    ref: frontend-autonomy               # Team's AutonomyPolicy resource

    computation:
      requiredLevel:
        derivedFrom: task-complexity
        mapping:
          complexity-1-3: level-1        # Simple tasks need Junior
          complexity-4-6: level-2        # Moderate tasks need Mid
          complexity-7-10: level-3       # Complex tasks need Senior

      currentEarnedLevel:
        source: autonomy-policy.status.currentLevel

      adjustment:
        formula: >
          If requiredLevel <= currentEarnedLevel:
            autonomy_factor = 1.0        # No penalty — agent can handle it
          Else:
            gap = requiredLevel - currentEarnedLevel
            autonomy_factor = max(0.1, 1.0 - (gap × 0.4))
            # Gap of 1 level: factor = 0.6
            # Gap of 2 levels: factor = 0.2
            # Gap of 3 levels: factor = 0.1 (near-zero but not zero —
            #   human-led execution is always possible)

      eRho2Final: "eRho2_base × autonomy_factor"
```

### 8.3 Consequences

**Selection gating:** Tasks that require autonomy levels the team hasn't earned are deprioritized — not because they're impossible (human-led execution remains an option), but because their effective execution cost is higher.

**Autonomy progression incentive:** Tasks that help the team earn Level 2 or Level 3 autonomy become attractive because they unlock a previously suppressed queue of higher-complexity work. PPA doesn't need to model this explicitly — the math handles it.

**Secondary effect:** This gives the autonomy progression system (RFC-0006 §13) a direct prioritization feedback loop. Earning autonomy doesn't just change routing — it changes what gets built.

---

## 9. Connection 5: HC_design — Design Lead Signal Channel

**Edge:** Product internal, with formal anchor in Design
**Gap filled:** Human Curve has no formal channel for design leadership authority

### 9.1 Current State

PPA's Human Curve composites four signal types: Explicit priority (HC_explicit), Team Consensus (HC_consensus), Meeting Decisions (HC_decision), and Override (HC_override). Design leadership enters through generic Team Consensus or Meeting Decisions — the same channels used by any team member — with no structural weight on the dimensions specifically within their domain (Sα₂, Sα₃).

### 9.2 Specification

> **v4 change (Amendment 4):** Corrects the HC formula from v3. Three issues in v3 are resolved:
> (a) Team Consensus and Meeting Decisions weights were reduced without justification to accommodate HC_design. These channels carry the collective judgment of the full team including Product. They are restored.
> (b) HC_design was weighted at 0.15, higher than HC_override at 0.10, meaning a single-discipline signal outweighed an emergency bypass. This hierarchy is wrong.
> (c) HC_override was incorrectly included as a weighted term in the formula, fundamentally changing it from a bypass mechanism (PPA v1.0 §6) to a scored component. This change was not approved by Product. HC_override is restored to its PPA v1.0 behavior: it is a bypass, not a weight.
>
> The resolved formula below sums to 1.0 and restores the original balance of collective vs. individual-discipline signals.

Add a fifth HC signal type: `HC_design` (Design Lead Signal).

```yaml
humanCurve:
  formula: >
    HC(w) = tanh(0.2 × HC_explicit + 0.45 × HC_consensus
                + 0.25 × HC_decision + 0.10 × HC_design)

  weightRationale:
    hcExplicit: 0.20      # Manual priority signal — direct expression of intent
    hcConsensus: 0.45     # Collective team judgment — primary human signal (restored from v3)
    hcDecision: 0.25      # Deliberated meeting decision — outweighs individual signals (restored from v3)
    hcDesign: 0.10        # Design authority channel — meaningful but below collective signals
    total: 1.00

  hcOverride:
    behavior: BYPASS      # Not a weighted component. Moves item to position 1.
    spec: "PPA v1.0 Section 6"
    fields:
      - statedReason: required
      - expiry: required
      - auditLog: required
    note: >
      HC_override was included as a weighted term in RFC-0008 v3. This was an
      unapproved architectural change to PPA v1.0. Override is an escape hatch —
      it bypasses the composite formula entirely. Including it in the formula
      would have demoted it to a scored signal and removed its bypass guarantee.

  hcDesign:
    description: >
      A formal, bounded mechanism for design leadership to
      signal that a work item conflicts with or advances the
      design system's coherence and the product's design intent.

    sources:
      # Source 1: DesignSystemBinding stewardship model
      - type: stewardship-signal
        description: >
          Design authority principals (from DesignSystemBinding.spec.stewardship)
          can flag work items that affect design system coherence.
        inputField: designSystemBinding.stewardship.designAuthority.principals
        signalTypes:
          - "advances-design-coherence"    # Positive signal
          - "fragments-component-catalog"  # Negative signal
          - "misaligned-with-brand"        # Negative signal
          - "fills-catalog-gap"            # Positive signal

      # Source 2: Design lead tagged votes in backlog tool
      - type: design-authority-tag
        description: >
          Design leads tag their votes/comments with `design-authority`
          in the backlog tool (Linear, Jira, etc.)
        filter: { tag: "design-authority" }

      # Source 3: DesignSystemBinding compliance assessment
      - type: compliance-assessment
        description: >
          Automated signal from DesignSystemBinding compliance
          status for the specific work item's affected area.
        input: designSystemBinding.status.tokenCompliance
        automatedScoring: >
          Work items touching areas with high token compliance
          get a small positive signal (system is healthy here).
          Work items touching areas with low compliance get
          a small negative signal (system is fragile here).

    constraints:
      maxRawSignal: 5.0
      minRawSignal: -5.0

    influenceScope:
      note: >
        HC_design was specified in v3 as influencing Sα₂ and Sα₃ specifically,
        with explicit exclusion from Dπ, Eρ₁, and Eρ₃. This per-dimension routing
        is architecturally incompatible with PPA v1.0's scalar HC multiplier.
        PPA applies (1 + HC(w)) as a single multiplier. Per-dimension HC routing
        requires HC to become a vector — this is deferred to PPA v1.1 (see §17).
        For v1: HC_design enters the scalar HC composite alongside all other channels.
        Dimension-specific design authority influence is already provided structurally
        through C1 (SA-2 grounded in Design-owned DID fields) and C2 (Eρ₄ from
        DesignSystemBinding). HC_design does not need to duplicate that.
```

### 9.3 Critical Distinction

`HC_design` is not a general-purpose override. It specifically captures design leadership's judgment about design system coherence and design intent alignment. A design lead saying "this feature will fragment our component catalog" is a signal PPA currently has no formal way to receive. HC_design creates the receiving channel.

### 9.4 Relationship to RFC-0006 Stewardship

`HC_design` is anchored in the RFC-0006 stewardship model (§5.3). Only principals listed in `DesignSystemBinding.spec.stewardship.designAuthority.principals` can emit `HC_design` signals with full weight. Signals from non-design-authority principals are treated as regular `HC_consensus` signals.

---

## 10. Connection 6: Post-Ship Design Quality → PPA Cκ Calibration

**Edge:** Design → Product (post-ship feedback)
**Gap filled:** PPA's calibration loop has no design quality signal after a feature ships

### 10.1 Current State

RFC-0006 Addendum A defines a design review feedback flywheel (§A.7) that tracks accept/dismiss/override/escalate signals from design leads during the build process. PPA's Cκ (Calibration Kappa) dimension uses post-ship outcome data to recalibrate future scoring. These two systems both measure quality outcomes but operate independently — the design feedback flywheel calibrates the design review gates, while PPA's Cκ calibrates the scoring model. Neither feeds the other.

The result: PPA can ship a feature that scored well on Sα₂ (Vibe Coherence) during prioritization, but post-ship design quality problems (design debt, component fragmentation, usability regressions discovered by real users) never flow back to recalibrate Sα₂ scoring for similar future work items.

### 10.2 Specification

Post-ship design quality outcomes from the RFC-0006 feedback flywheel MUST be forwarded to PPA's Cκ calibration loop:

> **v4 clarification (Amendment 6 note):** The `calibrationEffect` described below adjusts Cκ (global calibration multiplier) with category-scoped weighting. It does NOT directly adjust SA-2. If per-dimension calibration coefficients are needed in the future (e.g., a category-scoped SA-2 calibration coefficient), that requires per-dimension calibration — a PPA v1.1 change (see §17, v1.1-2). For v1: category-scoped Cκ adjustment is sufficient and correct.

```yaml
connection6:
  source: rfc-0006-feedback-flywheel
  destination: ppa-calibration-kappa

  signals:
    # Signal 1: Design review outcomes aggregated per feature
    - type: feature-design-quality
      inputs:
        - metric: design-review-approval-rate
          scope: per-feature
        - metric: design-review-rejection-categories
          scope: per-feature
        - metric: usability-simulation-pass-rate
          scope: per-feature
        - metric: design-ci-pass-rate
          scope: per-feature
      destination: cKappa.designQualitySignal

    # Signal 2: Post-ship design debt accumulation
    - type: post-ship-design-debt
      inputs:
        - metric: token-compliance-drift
          description: >
            Change in token compliance in the feature's code area
            between ship date and ship+90d. Negative drift indicates
            design debt accumulating after ship.
          window: "90d-post-ship"
        - metric: component-fragmentation-rate
          description: >
            Number of one-off components created in the feature area
            post-ship that duplicate catalog patterns. Measured by
            the reconciler's ComponentUndocumented events.
          window: "90d-post-ship"
      destination: cKappa.designDebtSignal

    # Signal 3: Usability regression post-ship (optional enhancement)
    - type: post-ship-usability
      optional: true
      inputs:
        - metric: customer-reported-ux-issues
          description: >
            Customer support tickets or feedback tagged as UX/usability
            issues in the feature area. Requires adapter integration
            with support tooling. If the adapter is unavailable, C6
            operates on feedback flywheel data alone (Signals 1 and 2).
          window: "90d-post-ship"
      destination: cKappa.usabilityRegressionSignal

  calibrationEffect: >
    Features that shipped with high Sα₂ scores but accumulated
    design debt or usability regressions post-ship cause PPA to
    lower Cκ for similar future work items in the same component
    category (category-scoped Cκ adjustment). The calibration is
    category-scoped, not global — a usability regression in the
    data table category does not penalize the form category.

    Note: This adjusts the Cκ global multiplier with category
    weighting, not SA-2 directly. Per-dimension calibration
    coefficients are a PPA v1.1 change (§17, v1.1-2).
```

> **Open Question 6 resolution:** The post-ship customer signal (Signal 3) is an optional enhancement. C6 MUST operate on feedback flywheel data alone (Signals 1 and 2) when a support tooling adapter is unavailable. Customer UX signals are enrichment, not core.

### 10.3 What This Closes

Without this connection, PPA's Sα₂ scoring is forward-looking only — it evaluates alignment at prioritization time but never learns whether the alignment held through implementation and post-ship. C6 closes the loop, giving PPA empirical evidence about which types of work items maintain design quality through the pipeline and which degrade.

---

## 11. Connection 7: PPA Design Lookahead → Design Team Preparation

**Edge:** Product → Design
**Gap filled:** Design team has no proactive visibility into upcoming high-priority work that will require design system preparation

### 11.1 Current State

PPA produces a ranked priority stack. Engineering consumes it via pipeline triggers. The design team has no formal notification channel — they learn about upcoming work through sprint planning meetings, backlog grooming, or ad-hoc communication. By the time a feature reaches the design impact review stage (RFC-0006 §6.1 Stage 2), it's already in the pipeline. If the design system isn't ready (Eρ₄ is low), the feature stalls.

### 11.2 Specification

> **v4 changes:**
> (1) Trigger updated to stability-based emission (Open Question 7 resolution): notifications emit when a work item has been stable in the top 10 for ≥ 48 hours, not on rank entry. Prevents notification churn in volatile priority environments.
> (2) Notification payload now includes the full `pillarBreakdown` (Amendment 6) rather than a simplified `ppaContext`. The design team needs to see whether a work item is high-priority-but-blocked-by-design-readiness versus low-priority-and-not-design-ready. The tension flags make this legible immediately.

PPA MUST emit a **Design Lookahead Notification** when high-priority work items have design system implications:

```yaml
connection7:
  source: ppa-priority-stack
  destination: design-team-notification

  trigger:
    conditions:
      # Emit when a work item has been stable in the top N AND has design system implications
      - priorityRank: top-10
      - rankStabilityDuration: "PT48H"  # Must be in top 10 for 48+ hours
      - designSystemImpact: true         # Touches frontend components

    rationale: >
      Rank entry alone produces too many notifications in volatile priority
      environments. Items that enter and exit the top 10 within hours are
      not actionable. The 48-hour stability threshold ensures the design team
      only receives notifications for work items that have genuinely surfaced
      as imminent priorities.

  notification:
    type: design-lookahead
    channel: designAuthority.principals   # From DesignSystemBinding stewardship
    delivery: [slack, email, dashboard]   # Via orchestrator notification system

    payload:
      workItem:
        id: "{workItemId}"
        title: "{workItemTitle}"
        description: "{workItemDescription}"
        estimatedStart: "{sprintDate}"

      # Full pillar breakdown (Amendment 6)
      # Gives design team complete context on why this item is approaching
      # and what each pillar's dimensions contributed.
      pillarBreakdown:
        $ref: "§A.6 IssueAdmissionResult.pillarBreakdown"
        note: >
          The tension flags are the primary signal for design team action.
          PRODUCT_HIGH_DESIGN_LOW means "unblock this — design readiness is the constraint."
          All MEDIUM means "not worth unblocking yet — validate demand first."

      designSystemAssessment:
        eRho4Score: "{currentScore}"
        lifecyclePhase: "{preDesignSystem | catalogBootstrap | postDesignSystem}"
        catalogGaps:
          - category: "{componentCategory}"
            existingComponents: ["{list}"]
            missingCapabilities: ["{list}"]
            estimatedEffort: "{effort}"
        tokenReadiness:
          coverageInArea: "{percentage}"
          missingTokenCategories: ["{list}"]
        baselineReadiness:
          storiesWithBaselines: "{count}"
          storiesWithoutBaselines: "{count}"

      designComplexityFlags:
        - flag: new-component-required
          description: >
            This feature requires a component type not in the catalog.
            Design team should begin component exploration before
            the feature enters the pipeline.
        - flag: cross-component-impact
          description: >
            This feature modifies a shared component used by {N}
            other features. Design impact review will be required.
        - flag: brand-alignment-question
          description: >
            This feature's UI direction was flagged by HC_design
            as potentially misaligned with the DID. Design review
            will be triggered regardless of complexity score.

      actionItems:
        - "Review catalog gaps and begin component exploration"
        - "Ensure visual baselines exist for affected stories"
        - "Flag any intentional exceptions before the feature enters the pipeline"

  timing:
    initialEmission: on-rank-stability    # After 48h in top 10
    reEmission: on-material-change        # If designSystemAssessment changes by > 0.1
    suppressDuplicate: "PT24H"            # Once per day max per work item
```

### 11.3 What This Closes

C7 is the only connection that flows *from* Product *to* Design. It transforms the design team from reactive participants (discovering catalog gaps when the pipeline stalls) to proactive preparers (filling catalog gaps before the feature enters the pipeline). Combined with C2 (Eρ₄), this creates a self-correcting loop:

1. PPA ranks a feature highly
2. Eρ₄ is low (catalog gap)
3. C7 notifies the design team about the gap (after 48h stability)
4. Design team fills the gap
5. Eρ₄ rises, feature enters the pipeline ready
6. No stall, no wasted agent cycles, no design review rejections

The pillar breakdown in the notification payload makes the action clear: a `PRODUCT_HIGH_DESIGN_LOW` tension flag means "this is blocking you, not Product." An `All MEDIUM` cluster means "demand hasn't solidified yet, don't rush."

---

## 12. Implementation Sequencing

### Phase 1 — Highest Leverage, Lowest Complexity (Weeks 1–4)

**C1: DesignIntentDocument + DesignSystemBinding → Sα₂**
- Author the initial Design Intent Document (§4) with design and product leadership using the split-authority model
- Migrate existing brand guidelines into the DID, assigning fields to productAuthority or designAuthority per §4.4
- Wire PPA's Sα₂ to read from the DID with the clean computable/LLM separation (§5.2)
- *Eliminates duplicate source of truth and double-counting simultaneously*

**C4: AutonomyPolicy → Eρ₂ Hard Cap**
- Read the team's current earned autonomy level from `AutonomyPolicy.status`
- Apply the autonomy_factor adjustment to Eρ₂
- *Closes a real scheduling gap in the current pipeline*

**C7: PPA Design Lookahead**
- Wire the PPA priority stack to emit design lookahead notifications with 48h stability threshold
- Configure notification channels for design authority principals
- Include pillarBreakdown in payload from §A.6
- *Low complexity — reads existing priority data, requires no new computation*

### Phase 2 — Requires RFC-0006 Stewardship to Be Stable (Weeks 5–8)

**C5: HC_design Channel**
- Define the `design-authority` tag in the backlog tool
- Wire `HC_design` into the HC composite formula at weight 0.10
- Train design leads on the signal types and when to use them
- *Depends on formal design authority structure from RFC-0006 §5.3*

**C2: DesignSystemBinding → Eρ₄**
- Implement lifecycle phase detection (preDesignSystem / catalogBootstrap / postDesignSystem)
- Compute Eρ₄ from `DesignSystemBinding.status` fields with bootstrap floor
- Add Eρ₄ to the `min()` composition of Eρ
- Align with Addendum A §A.5 implementation (no contradiction between spec and code)

### Phase 3 — Requires Learn Phase Data to Accumulate (Weeks 9+)

**C3: Quality Metrics → Dπ₁ Risk Adjustment**
- Accumulate sufficient post-execution defect density and churn data (≥ 90 days)
- Compute `defect_risk_factor` per code area with `hasFrontendComponents` check (§A.5)
- Apply the adjustment to Dπ₁

**C6: Post-Ship Design Quality → Cκ Calibration**
- Accumulate 90 days of post-ship design quality data
- Wire feedback flywheel signals (Signals 1 and 2) to PPA's Cκ loop
- Begin category-scoped Cκ adjustment; optional Signal 3 if support adapter available

---

## 13. Worked Example

### Scenario: Two Features Compete for Priority

**Feature A:** "Add bulk inventory import" — high customer demand, touches a clean code area, requires a new data table component that doesn't exist in the catalog.

**Feature B:** "Redesign invoice template" — moderate customer demand, touches a high-defect code area, uses only existing components.

**Context:** Team has a declared `DesignSystemBinding` that is 45 days old with 35% catalog coverage (postDesignSystem phase — coverage > 20%).

#### Without Triad Integration (PPA v1.0)

| Dimension | Feature A | Feature B |
|-----------|-----------|-----------|
| Sα (Soul Alignment) | 0.8 | 0.7 |
| Dπ (Demand Pressure) | 0.9 | 0.6 |
| Eρ (Execution Reality) | 0.7 | 0.7 |
| **PPA Score** | **0.504** | **0.294** |

Feature A wins. The pipeline attempts to build a new data table component. The agent generates something from training data that doesn't match the design system. Design review rejects it. Multiple retry cycles. Cost budget consumed. Feature delivered late and inconsistent.

#### With Triad Integration (RFC-0008)

| Dimension | Feature A | Feature B |
|-----------|-----------|-----------|
| Sα₂ (via DID) | 0.75 (DID principle: "efficient depth" supports this) | 0.80 (DID principle: "calm confidence" aligns with cleaner invoices) |
| Dπ₁ adjusted | 0.9 × (1 − 0.05) = **0.855** (clean code area, minimal risk) | 0.6 × (1 − 0.35) = **0.390** (high-defect area, significant risk) |
| Eρ₂ (autonomy) | 0.7 (Level 2 sufficient) | 0.7 (Level 2 sufficient) |
| Eρ₄ (DS readiness, postDesignSystem phase) | **0.25** (data table category: 0% catalog coverage in category) | **0.92** (all components exist, high token compliance) |
| Eρ = min(...) | **0.25** (suppressed by Eρ₄) | **0.70** |
| **PPA Score** | **0.161** | **0.219** |

Feature B now wins. Feature A's score is suppressed because the design system isn't ready to support it.

**What happens next:** C7 emits a design lookahead notification (once Feature A is stable in the top 10 for 48h). The notification includes the pillar breakdown:

```
pillarBreakdown.design.eRho4.score: 0.25
tensionFlags:
  - type: PRODUCT_HIGH_DESIGN_LOW
    description: "Product dimensions (SA-1=0.80, D-pi=0.855) strongly support
                  this item but Design dimensions (ER-4=0.25) are suppressing it.
                  Data table catalog coverage is 0%. This is the constraint."
    actionable: true
    suggestedAction: "Build data table component category into design system"
```

The design team sees this and prioritizes data table component exploration. Once catalog coverage for data tables reaches a reasonable level, Eρ₄ for Feature A jumps, and it surfaces in the priority stack naturally — now with infrastructure in place to build it right.

This is what governance looks like when all three edges are connected.

---

## 14. Security and Authority Considerations

### 14.1 Design Intent Document Access

The DID contains strategic product intent that may be considered proprietary. Under the split-authority model, access controls are field-scoped:

- The DID resource MUST be namespace-scoped
- Read access: all team members in the namespace
- Write access to productAuthority fields: only `stewardship.productAuthority.owner` and their approved co-signers
- Write access to designAuthority fields: only `stewardship.designAuthority.owner` and their approved co-signers
- Approval authority for any change: both principals listed in the relevant `approvalRequired` list
- Engineering reviewers can comment and request changes; they cannot approve or block except on `measurableSignal` feasibility

### 14.2 HC_design Signal Integrity

`HC_design` signals carry structural weight in the prioritization model. To prevent abuse:

- Only principals listed in `DesignSystemBinding.spec.stewardship.designAuthority.principals` can emit full-weight `HC_design` signals
- All `HC_design` signals are recorded in the audit log with the principal's identity
- The `tanh` compression and `maxRawSignal` cap prevent any single signal from dominating the composite
- HC_design is weighted at 0.10 — below consensus (0.45) and deliberated decisions (0.25), preventing any individual design authority signal from overriding collective judgment

### 14.3 HC_override Integrity

HC_override is not part of the composite formula and therefore cannot be gamed through the scoring model. Override behavior (item to position 1, stated reason required, expiry required, audit log entry) is defined in PPA v1.0 Section 6 and unchanged by this RFC.

### 14.4 Cross-System Data Flow

Connections C1–C7 read data from RFC-0006 resources and PPA state. These reads MUST:

- Use the same authentication mechanism as the orchestrator (JIT credentials, scoped tokens)
- Not cache stale status data beyond one reconciliation cycle
- Log each cross-system read in the audit trail

---

## 15. Open Questions

> **v4 note:** All seven open questions from v3 are resolved with Product pillar positions from the Alexander Kline review. No open questions remain for the normative spec. The resolutions are recorded here as spec decisions.

| # | Question | Resolution | Authority |
|---|----------|------------|-----------|
| 1 | DID versioning for staged rollouts | **Yes, support versioning.** A rebrand must not flip every PPA score simultaneously. The `DesignIntentDocument` resource SHOULD support a `version` field and staged rollout via namespace or label selectors. Specification deferred to implementation. | Product position |
| 2 | Eρ₄ granularity (category vs component) | **Category-level for v1.** Component-level creates premature precision requirements on the design system before it has matured. Category-level is specified in §6.2. Component-level is a candidate for Eρ₄ v2 after teams have operated the system for one calibration cycle. | Product position |
| 3 | HC_design weight configurability | **Fixed at 0.10 in spec.** Configurable weights will be negotiated to zero by teams resisting design feedback. The weight is set by the spec, not by teams. | Product position |
| 4 | Defect risk factor fallback | **Default to 0.0.** No fallback to external code quality tools (SonarQube, CodeClimate). Incentivizes Learn phase adoption. | Product position (§7.4) |
| 5 | DID-to-DesignSystemBinding continuous drift check | **Yes, continuous.** Quarterly review is too slow. The reconciler SHOULD run a continuous `DesignIntentDrift` check comparing DID design principles against DesignSystemBinding compliance rules. Semantic drift (not just structural) should be checked. | Product position |
| 6 | C6 support tooling dependency | **Optional enhancement.** C6 MUST operate on feedback flywheel data alone (Signals 1 and 2) when a support tooling adapter is unavailable. Customer UX signals (Signal 3) are enrichment, not core. | Product position (§10.2) |
| 7 | C7 notification fatigue | **Stability threshold: top-10 for 48+ hours.** Prevents notification churn from volatile priority environments. The rank entry trigger from v3 is replaced with the stability trigger. | Product position (§11.2) |

---

## 16. References

- [AI-SDLC Specification v1alpha1](https://ai-sdlc.io/docs/spec/spec)
- [RFC-0006: Design System Governance Pipeline](https://ai-sdlc.io/docs/spec/rfcs/RFC-0006-design-system-governance)
- [RFC-0002: Pipeline Orchestration](https://ai-sdlc.io/docs/spec/rfcs/RFC-0002-pipeline-orchestration)
- [RFC-0004: CostPolicy Extension](https://ai-sdlc.io/docs/spec/rfcs/RFC-0004-cost-policy)
- [PPA v1.0: Product Prioritization Algorithm](https://ai-sdlc.io/docs/spec/ppa)
- [PPA Triad Integration Analysis (internal)](internal-reference)
- [AI-SDLC Contribution Analysis — Design × Engineering Integration (internal)](internal-reference)
- [Product Pillar Response to RFC-0008 v3 — Alexander Kline, April 2026](internal-reference)

---

## 17. PPA v1.1 Direction

> **New section (v4).** RFC-0008 v3 surfaced four changes that PPA v1.0's architecture cannot express without modification. These are queued for PPA v1.1. They are documented here rather than in PPA v1.0 directly because this RFC is the source of the requirement. When PPA v1.1 is authored, this section is the requirements input.

### v1.1-1: HC Vector (Per-Dimension Human Curve Routing)

PPA v1.0 applies HC as a scalar multiplier: `(1 + HC(w))`. RFC-0008's original `influenceScope` concept for HC_design (restricting its influence to Sα₂ and Sα₃) requires HC to become a vector where different channels influence different dimensions. This is architecturally significant.

**Interim (this RFC):** HC_design enters the scalar HC composite alongside all other channels. Dimension-specific design authority influence is already provided structurally through C1 (SA-2 grounded in Design-owned DID fields) and C2 (Eρ₄ from DesignSystemBinding). The structural embedding is sufficient for v1 without requiring per-dimension HC routing.

**v1.1 work:** Define HC as a dimension-indexed vector. Each HC channel has a weight distribution across dimensions, not a single composite weight. HC_design's weight is concentrated on Sα₂ and Sα₃; HC_consensus weight is distributed evenly.

### v1.1-2: Per-Dimension Calibration Coefficients

PPA v1.0's C-kappa is a single scalar calibration multiplier. C6's category-scoped design quality calibration implies per-dimension calibration coefficients (e.g., a category-scoped Sα₂ calibration independent from Dπ calibration). This is the correct long-term direction but requires careful design to prevent the calibration model from becoming overdetermined.

**Interim (this RFC):** C6 adjusts global Cκ with category-scoped weighting. Category-scoped Cκ is sufficient for v1.

**v1.1 work:** Define a `CalibrationCoefficient` type with a `dimensionScope` field. Cκ becomes a map from dimension to coefficient, not a scalar.

### v1.1-3: Lifecycle Phase Sensitivity

PPA v1.0 Section 8 already identifies this as an open question: "Should dimension weights shift based on product lifecycle?" The Eρ₄ bootstrap issue (Amendment 3) is a specific instance of the general problem. The `lifecyclePhase` qualifier in §6.2 is an ad-hoc escape valve, not a general solution.

**Interim (this RFC):** The Eρ₄ lifecycle qualifier is scoped to design system readiness only. Other dimensions use static weights.

**v1.1 work:** Define a `ProductLifecyclePhase` classifier (bootstrap, growth, maturity, plateau) and a dimension weight schedule keyed to lifecycle phase. Teams configure their current phase; PPA adjusts dimension weights accordingly.

### v1.1-4: Admission Scoring Subset Formalization

Addendum A §A.6 reveals that admission-time scoring is necessarily a subset of the full PPA composite (SA, D-pi, ER-2, ER-4 at admission; M-phi, E-tau, ER-1, ER-3, HC, C-kappa at runtime). This two-phase pattern is ad-hoc in v1.

**Interim (this RFC):** The admission scoring subset is documented in §A.6 with explicit framing as progressive enrichment, not omission.

**v1.1 work:** Formalize this as a standard two-phase scoring model. Define which PPA dimensions are computed at admission time versus when an item approaches the top of the stack. Define the trigger for full scoring and the state management for dimension results.

### v1.1-5: Pillar Perspective Breakdown as Standard Output

Amendment 6 specifies the pillar breakdown for RFC-0008 integration. PPA v1.1 will formalize this as a required component of every PPA scoring output — not just for triad traceability but as the standard provenance format. The tension detection heuristics will be calibrated against real scoring data once the triad integration is live.

**Interim (this RFC):** The pillar breakdown is a read-only presentation of existing scoring data implemented as an addition to `IssueAdmissionResult` (§A.6). No changes to the composite formula are required.

---

## Addendum A: Engineering Integration Specification

**Added:** v3 2026-04-03
**Updated:** v4 2026-04-03 — Amendment 3 (Eρ₄ lifecycle in §A.5), Amendment 4 objection (`hasFrontendComponents` in §A.5), Amendment 5 (§A.6 composite alignment + Admission Scoring Subset), Amendment 6 (pillarBreakdown in §A.6)

**Motivation:** Analysis of the live AI-SDLC codebase (specifically `orchestrator/src/admission-score.ts` and the trust-based source weighting commit `c04ca18`) revealed four engineering-side integration gaps that prevent Connections C1–C7 from being implementable. This addendum specifies the concrete type extensions, state store queries, and reconciliation events required.

**Cross-reference:** This addendum provides the implementation specification for C1–C5 against the actual orchestrator codebase. C6 and C7 are self-contained and do not require admission pipeline changes.

---

### A.1 Current Admission Pipeline Architecture

The admission pipeline currently derives all PPA scores from GitHub issue metadata:

```typescript
// Current: admission-score.ts → mapIssueToPriorityInput()
// Input: issue title, body, labels, reactions, comments, createdAt, authorAssociation
// Output: PriorityInput with soulAlignment, builderConviction, demandSignal,
//         teamConsensus, competitiveDrift, complexity
```

The function is **pure** — it takes issue metadata in and produces scores out, with no access to external state. This is clean but limiting: it means the admission scorer cannot read from the orchestrator's state store (autonomy ledger, episodic memory, quality metrics) or from the `DesignSystemBinding` status.

The trust-based boosting commit (`c04ca18`) established the pattern for source-aware scoring: `AuthorAssociation` determines signal floors. This addendum extends the same pattern to design authority and codebase-aware signals.

---

### A.2 AdmissionInput Type Extension

The `AdmissionInput` interface MUST be extended to carry design system and codebase context:

```typescript
// ── Existing fields (unchanged) ──────────────────────────────
export interface AdmissionInput {
  issueNumber: number;
  title: string;
  body?: string;
  labels: string[];
  reactionCount: number;
  commentCount: number;
  createdAt: string;
  authorAssociation?: AuthorAssociation;

  // ── New fields (RFC-0008) ──────────────────────────────────

  /**
   * Design system readiness context.
   * Populated by querying DesignSystemBinding.status before scoring.
   * If DesignSystemBinding is not configured, this field is undefined
   * and Eρ₄ defaults to 1.0 (no penalty — preDesignSystem phase).
   */
  designSystemContext?: {
    /** Catalog coverage for the component categories this issue touches.
     *  Derived from DesignSystemBinding.status.catalogHealth. */
    catalogCoverage: number;              // 0.0–1.0

    /** Token compliance in the code area this issue touches.
     *  Derived from DesignSystemBinding.status.tokenCompliance. */
    tokenCompliance: number;              // 0.0–1.0

    /** Whether the catalog is in bootstrap phase (< 20% coverage and < 90 days old). */
    inBootstrapPhase: boolean;

    /** Percentage of affected stories with visual baselines. */
    baselineCoverage: number;             // 0.0–1.0

    /** Specific catalog gaps identified. Used for C7 lookahead notifications. */
    catalogGaps?: Array<{
      category: string;
      missingCapabilities: string[];
    }>;
  };

  /**
   * Autonomy context from the team's AutonomyPolicy.
   * Populated by querying AutonomyPolicy.status before scoring.
   */
  autonomyContext?: {
    /** The team's current earned autonomy level (0–3). */
    currentEarnedLevel: number;

    /** The estimated required autonomy level for this task,
     *  derived from complexity score mapping. */
    requiredLevel: number;
  };

  /**
   * Code area quality metrics from the AI-SDLC Learn phase.
   * Populated by querying the state store's episodic memory.
   * If insufficient data exists (< 90 days), this field is undefined
   * and defect_risk_factor defaults to 0.0 (no adjustment).
   */
  codeAreaQuality?: {
    /** Defect density in the affected code area (trailing 90d).
     *  Normalized to percentile rank [0, 1]. */
    defectDensity: number;

    /** Code churn rate in the affected code area (trailing 90d).
     *  Normalized to percentile rank [0, 1]. */
    churnRate: number;

    /** PR rejection rate in the affected code area (trailing 90d).
     *  Normalized to percentile rank [0, 1]. */
    prRejectionRate: number;

    /** Whether this code area has frontend components.
     *  Determines whether design quality metrics are included in defectRiskFactor.
     *  See §A.5. */
    hasFrontendComponents: boolean;

    /** Design-specific quality metrics (only relevant when hasFrontendComponents = true). */
    designQuality?: {
      /** Design CI pass rate in the affected area (trailing 90d). */
      designCIPassRate: number;

      /** Design review rejection rate in the affected area (trailing 90d). */
      designReviewRejectionRate: number;

      /** Usability simulation pass rate in the affected area (trailing 90d). */
      usabilitySimPassRate: number;
    };
  };

  /**
   * Design authority signal.
   * Set when the issue author or a commenter is listed in
   * DesignSystemBinding.spec.stewardship.designAuthority.principals.
   */
  designAuthoritySignal?: {
    /** Whether the author is a design authority principal. */
    isDesignAuthority: boolean;

    /** Signal type if a design authority has flagged this issue. */
    signalType?: 'advances-design-coherence' | 'fragments-component-catalog'
               | 'misaligned-with-brand' | 'fills-catalog-gap';

    /** Compliance assessment for the affected area.
     *  Automated signal from DesignSystemBinding status. */
    areaComplianceScore?: number;         // 0.0–1.0
  };
}
```

### A.3 PriorityInput Type Extension

The `PriorityInput` interface MUST be extended with the new scoring dimensions:

```typescript
export interface PriorityInput {
  // ── Existing fields ────────────────────────────────────────
  soulAlignment: number;
  builderConviction: number;
  demandSignal: number;
  teamConsensus: number;
  competitiveDrift: number;
  complexity: number;

  // ── New fields (RFC-0008) ──────────────────────────────────

  /** Eρ₄: Design system readiness score.
   *  Computed from designSystemContext with lifecycle phase awareness.
   *  Defaults to 1.0 if no DesignSystemBinding is configured (preDesignSystem).
   *  Floored at 0.3 during catalogBootstrap phase. */
  designSystemReadiness: number;          // 0.0–1.0

  /** Autonomy factor applied to Eρ₂.
   *  1.0 if requiredLevel <= currentEarnedLevel.
   *  Degraded proportionally as the gap increases. */
  autonomyFactor: number;                 // 0.1–1.0

  /** Defect risk factor applied to Dπ₁.
   *  0.0 = no risk adjustment. Clamped at 0.5.
   *  Design quality metrics only included for frontend code areas. */
  defectRiskFactor: number;               // 0.0–0.5

  /** HC_design signal from design authority.
   *  0.0 if no design authority signal present.
   *  Positive for coherence-advancing, negative for fragmenting.
   *  Flows through HC composite formula, not directly to any dimension. */
  designAuthorityWeight: number;          // -1.0–1.0
}
```

### A.4 Admission Scorer Refactor: State Store Access

The `mapIssueToPriorityInput` function currently takes only `AdmissionInput`. To implement C2–C5, the admission pipeline MUST be refactored to populate the new `AdmissionInput` fields before scoring.

**Architecture change:**

```
Current:
  GitHub webhook → parse issue metadata → mapIssueToPriorityInput() → score

Proposed:
  GitHub webhook → parse issue metadata → enrichAdmissionInput() → mapIssueToPriorityInput() → score
                                              │
                                              ├── query DesignSystemBinding.status (C2/Eρ₄)
                                              ├── query AutonomyPolicy.status (C4)
                                              ├── query state store episodic memory (C3)
                                              └── query DesignSystemBinding.stewardship (C5)
```

```typescript
import { StateStore } from './state/index.js';
import { DesignSystemBinding } from './types.js';
import { AutonomyPolicy } from './types.js';

interface EnrichmentContext {
  stateStore: StateStore;
  designSystemBinding?: DesignSystemBinding;
  autonomyPolicy?: AutonomyPolicy;
}

/**
 * Enrich an AdmissionInput with state from the orchestrator.
 * This is the bridge between the stateless admission scorer
 * and the stateful orchestrator.
 *
 * If any external resource is unavailable, the corresponding
 * field is left undefined and the scorer uses safe defaults (no penalty).
 */
export async function enrichAdmissionInput(
  input: AdmissionInput,
  context: EnrichmentContext,
): Promise<AdmissionInput> {
  const enriched = { ...input };

  // ── C2: Design System Readiness (lifecycle-aware) ────────
  if (context.designSystemBinding) {
    const dsb = context.designSystemBinding;
    const status = dsb.status;

    // Determine lifecycle phase
    const coveragePercent = status?.catalogHealth?.coveragePercent ?? 0;
    const dsbAgedays = computeDsbAgeDays(dsb.metadata?.creationTimestamp);
    const inBootstrapPhase = coveragePercent < 20 && dsbAgedays < 90;

    enriched.designSystemContext = {
      catalogCoverage: coveragePercent / 100,
      tokenCompliance: status?.tokenCompliance?.currentCoverage
        ? status.tokenCompliance.currentCoverage / 100
        : 1.0,
      inBootstrapPhase,
      baselineCoverage: await computeBaselineCoverage(context.stateStore, input),
      catalogGaps: await identifyCatalogGaps(dsb, input),
    };
  }
  // If no DesignSystemBinding: designSystemContext is undefined → Eρ₄ = 1.0 (preDesignSystem)

  // ── C4: Autonomy Level ──────────────────────────────────
  if (context.autonomyPolicy) {
    const complexity = parseComplexity(input.body);
    const requiredLevel = complexityToAutonomyLevel(complexity);
    const currentLevel = context.autonomyPolicy.status?.currentLevel ?? 0;

    enriched.autonomyContext = {
      currentEarnedLevel: currentLevel,
      requiredLevel,
    };
  }

  // ── C3: Code Area Quality Metrics ───────────────────────
  const codeArea = inferCodeArea(input);
  if (codeArea) {
    const metrics = await context.stateStore.getCodeAreaMetrics(
      codeArea, { window: '90d' }
    );

    if (metrics && metrics.dataPointCount >= 10) {
      enriched.codeAreaQuality = {
        defectDensity: metrics.defectDensityPercentile,
        churnRate: metrics.churnRatePercentile,
        prRejectionRate: metrics.prRejectionRatePercentile,
        hasFrontendComponents: await checkHasFrontendComponents(codeArea, context.stateStore),
        designQuality: metrics.designMetrics
          ? {
              designCIPassRate: metrics.designMetrics.ciPassRate,
              designReviewRejectionRate: metrics.designMetrics.reviewRejectionRate,
              usabilitySimPassRate: metrics.designMetrics.usabilityPassRate,
            }
          : undefined,
      };
    }
  }

  // ── C5: Design Authority Signal ─────────────────────────
  if (context.designSystemBinding) {
    const principals = context.designSystemBinding.spec
      ?.stewardship?.designAuthority?.principals ?? [];
    const isDesignAuthority = await checkDesignAuthority(input, principals);

    if (isDesignAuthority) {
      enriched.designAuthoritySignal = {
        isDesignAuthority: true,
        areaComplianceScore: enriched.designSystemContext?.tokenCompliance,
      };
    }
  }

  return enriched;
}

function complexityToAutonomyLevel(complexity: number): number {
  if (complexity <= 3) return 1;
  if (complexity <= 6) return 2;
  return 3;
}
```

### A.5 Scoring Function Extensions

> **v4 changes:**
> (Amendment 3) Eρ₄ computation now implements the lifecycle phase logic from §6.2. The contradiction between the v3 normative spec (hard 0.0 gate) and Addendum A (default 1.0) is resolved.
> (Addendum A objection) The 70/30 code/design blend for `defectRiskFactor` is now conditional on `hasFrontendComponents`. For backend code areas, design quality metrics are irrelevant and the 30% weight should not apply.

```typescript
export function mapIssueToPriorityInput(input: AdmissionInput): PriorityInput {
  // ── Existing logic (trust-based boosting from c04ca18) ──────
  const assoc = input.authorAssociation ?? 'NONE';
  const isTrusted = assoc === 'OWNER' || assoc === 'MEMBER'
                 || assoc === 'COLLABORATOR';
  const isContributor = assoc === 'CONTRIBUTOR';

  // ... existing soulAlignment, builderConviction, demandSignal,
  //     teamConsensus, competitiveDrift, complexity logic ...

  // ── C1: DID-grounded soulAlignment (phased migration) ───────
  // Phase 1: Label-based scoring remains as fallback.
  // Phase 2: When DesignIntentDocument is available, soulAlignment
  //          is computed as a weighted blend of label-based score
  //          and DID principle alignment score.
  // Phase 3: Label-based scoring deprecated; DID is sole source.
  // The DID integration is a separate PR gated on the
  // DesignIntentDocument resource being implemented.

  // ── C2: Design System Readiness (Eρ₄) — lifecycle-aware ─────
  let designSystemReadiness = 1.0;        // Default: preDesignSystem phase — no penalty
  if (input.designSystemContext) {
    const ctx = input.designSystemContext;
    const computed =
      0.4 * ctx.catalogCoverage +
      0.3 * ctx.tokenCompliance +
      0.3 * ctx.baselineCoverage;

    if (ctx.inBootstrapPhase) {
      // catalogBootstrap phase: floor at 0.3
      designSystemReadiness = Math.max(0.3, computed);
    } else {
      // postDesignSystem phase: fully computed
      designSystemReadiness = computed;
    }
  }
  // If designSystemContext is undefined: preDesignSystem → 1.0 (already set)

  // ── C3: Defect Risk Factor (frontend-aware blend) ────────────
  let defectRiskFactor = 0.0;             // Default: no adjustment
  if (input.codeAreaQuality) {
    const q = input.codeAreaQuality;
    const codeRaw =
      0.5 * q.defectDensity +
      0.3 * q.churnRate +
      0.2 * q.prRejectionRate;

    // Design quality metrics only apply to code areas with frontend components.
    // For backend-heavy areas, the 30% design weight is irrelevant and misleading.
    if (q.designQuality && q.hasFrontendComponents) {
      const designRisk =
        0.4 * (1 - q.designQuality.designCIPassRate) +
        0.4 * q.designQuality.designReviewRejectionRate +
        0.2 * (1 - q.designQuality.usabilitySimPassRate);
      // 70% code quality / 30% design quality for frontend areas
      defectRiskFactor = Math.min(0.5, 0.7 * codeRaw + 0.3 * designRisk);
    } else {
      // Pure code quality for backend areas
      defectRiskFactor = Math.min(0.5, codeRaw);
    }
  }

  // ── C4: Autonomy Factor ─────────────────────────────────────
  let autonomyFactor = 1.0;               // Default: no penalty
  if (input.autonomyContext) {
    const gap = input.autonomyContext.requiredLevel
              - input.autonomyContext.currentEarnedLevel;
    if (gap > 0) {
      autonomyFactor = Math.max(0.1, 1.0 - (gap * 0.4));
    }
  }

  // ── C5: Design Authority Weight ─────────────────────────────
  let designAuthorityWeight = 0.0;        // Default: no signal
  if (input.designAuthoritySignal?.isDesignAuthority) {
    const signal = input.designAuthoritySignal;
    switch (signal.signalType) {
      case 'advances-design-coherence':
      case 'fills-catalog-gap':
        designAuthorityWeight = 0.6;
        break;
      case 'fragments-component-catalog':
      case 'misaligned-with-brand':
        designAuthorityWeight = -0.4;
        break;
      default:
        // Design authority with no explicit signal type: baseline positive
        designAuthorityWeight = 0.3;
    }
    // Automated compliance score modulates the signal
    if (signal.areaComplianceScore !== undefined) {
      designAuthorityWeight *= (1.2 - signal.areaComplianceScore);
    }
  }

  return {
    soulAlignment,
    builderConviction,
    demandSignal,
    teamConsensus,
    competitiveDrift,
    complexity,
    designSystemReadiness,
    autonomyFactor,
    defectRiskFactor,
    designAuthorityWeight,
  };
}
```

### A.6 Composite Score Integration

> **v4 changes (Amendment 5 + Amendment 6):**
>
> *5a fix:* HC_design now flows through the HC composite formula with tanh compression. The v3 implementation applied `designAuthorityWeight` as a direct additive modifier to `soulAlignmentDim`, bypassing tanh entirely. This is architecturally incorrect: tanh compression prevents any single channel from dominating. The direct SA modifier is replaced with HC_design as a weighted input to the HC function.
>
> *5b fix:* An explicit "Admission Scoring Subset" section documents which PPA dimensions are evaluated at admission time versus runtime. This is progressive enrichment, not omission.
>
> *5c acknowledgment:* The `influenceScope` restriction (HC_design influences only Sα₂ and Sα₃) requires PPA v1.1's HC vector architecture. For v1, HC_design enters the scalar composite. This is acceptable because C1 and C2 already provide dimension-specific design authority influence.
>
> *Amendment 6:* `pillarBreakdown` is added to `IssueAdmissionResult` as a required read-only field.

#### Admission Scoring Subset

PPA's full composite has seven terms. At admission time, a subset is evaluated based on available context. This is progressive enrichment — runtime scoring completes the picture when an item approaches the top of the stack.

| Dimension | Admission Time | Runtime | Notes |
|-----------|---------------|---------|-------|
| SA-1 Problem Resonance | ✅ | ✅ | Label-based at admission; DID-grounded post-C1 implementation |
| SA-2 Vibe Coherence | ✅ | ✅ | Computable component at admission; LLM at runtime |
| SA-3 Vision Vector | ✅ | ✅ | |
| D-pi Demand Pressure | ✅ (with C3 risk adjustment) | ✅ | |
| M-phi Market Force | ❌ | ✅ | Requires external market signal; not available at admission |
| E-tau Entropy Tax | ❌ | ✅ | Requires accumulated drift data; not available at admission |
| ER-1 Resource Availability | ❌ | ✅ | Sprint capacity not known at admission |
| ER-2 Build Complexity | ✅ (with C4 autonomy factor) | ✅ | |
| ER-3 Dependency Clearance | ❌ | ✅ | Dependency graph not fully known at admission |
| ER-4 Design System Readiness | ✅ (with lifecycle phase) | ✅ | |
| HC Human Curve | ✅ (with HC_design) | ✅ | |
| C-kappa Calibration | ❌ | ✅ | Requires historical outcome data; deferred to runtime |

```typescript
export function scoreIssueForAdmission(
  input: AdmissionInput,
  thresholds: AdmissionThresholds,
): IssueAdmissionResult {
  const p = mapIssueToPriorityInput(input);

  // ── Soul Alignment (SA) ─────────────────────────────────────
  const soulAlignmentDim = p.soulAlignment;
  // Note: SA-2 computable component is included in soulAlignment when
  // designSystemContext is available. LLM component deferred to runtime.

  // ── Demand Pressure (D-pi) with C3 risk adjustment ──────────
  const rawDemandPressure = (p.demandSignal + p.teamConsensus
    + p.builderConviction + p.competitiveDrift) / 4;
  const adjustedDemandPressure = rawDemandPressure * (1 - p.defectRiskFactor);

  // ── Execution Reality (ER) with C2 and C4 ───────────────────
  const baseExecutionReality = 1 - (p.complexity / 10);
  const eRho2Adjusted = baseExecutionReality * p.autonomyFactor;  // C4
  // ER = min(ER-2-adjusted, ER-4)
  // ER-1 (resource availability) and ER-3 (dependency clearance) are deferred to runtime
  const executionReality = Math.min(eRho2Adjusted, p.designSystemReadiness);  // C2

  // ── Human Curve (HC) with HC_design through composite ───────
  // HC_design flows through the tanh composite formula, not as a direct
  // SA modifier. This preserves tanh compression for all channels.
  // The HC formula from §9.2: tanh(0.2*exp + 0.45*con + 0.25*dec + 0.10*design)
  //
  // At admission time, HC_explicit, HC_consensus, HC_decision are derived
  // from label-based signals. HC_design from designAuthorityWeight.
  const hcExplicit  = deriveHcExplicit(input);   // From explicit priority labels
  const hcConsensus = deriveHcConsensus(input);  // From reaction/comment signals
  const hcDecision  = deriveHcDecision(input);   // From decision labels
  const hcDesign    = p.designAuthorityWeight;   // From C5 design authority signal

  const hcRaw = 0.2 * hcExplicit
              + 0.45 * hcConsensus
              + 0.25 * hcDecision
              + 0.10 * hcDesign;
  const hcComposite = Math.tanh(hcRaw);

  // ── Composite Score (admission-time subset) ─────────────────
  // Full PPA composite: SA × D-pi × ER × (1 + HC) × M-phi × (1 - E-tau) × C-kappa
  // Admission subset: SA × D-pi × ER × (1 + HC)
  // M-phi, E-tau, C-kappa are deferred to runtime scoring.
  const composite = soulAlignmentDim
    * adjustedDemandPressure
    * executionReality
    * (1 + hcComposite);

  // ── Pillar Perspective Breakdown (Amendment 6) ──────────────
  const pillarBreakdown = computePillarBreakdown(p, {
    soulAlignmentDim,
    adjustedDemandPressure,
    rawDemandPressure,
    eRho2Adjusted,
    executionReality,
    hcComposite,
    hcChannels: { explicit: hcExplicit, consensus: hcConsensus, decision: hcDecision, design: hcDesign },
    composite,
  });

  return {
    issueNumber: input.issueNumber,
    compositeScore: composite,
    pillarBreakdown,                    // Required field — always present
    admitted: composite >= thresholds.admissionThreshold,
    // ... existing admission logic (suggestions, labels) ...
  };
}
```

#### Pillar Perspective Breakdown

Every `IssueAdmissionResult` MUST include a `pillarBreakdown` object. This is a read-only presentation of existing scoring data — it requires no changes to the composite formula.

```typescript
interface IssueAdmissionResult {
  issueNumber: number;
  compositeScore: number;
  admitted: boolean;

  // Required: per-pillar dimension attribution and tension detection
  pillarBreakdown: {
    product: PillarContribution;
    design: PillarContribution;
    engineering: PillarContribution;
    shared: SharedDimensions;
    tensionFlags: TensionFlag[];
  };

  // ... existing fields ...
}

interface PillarContribution {
  label: string;
  governedDimensions: Record<string, DimensionScore>;
  pillarSignal: 'POSITIVE' | 'NEUTRAL' | 'BLOCKING';
  interpretation: string;
}

interface DimensionScore {
  name: string;
  score: number;
  source?: string;
  note?: string;
  breakdown?: Record<string, number>;
}

interface SharedDimensions {
  sAlpha3?: DimensionScore;
  hcComposite?: DimensionScore & { channels: Record<string, number> };
}

interface TensionFlag {
  type: TensionType;
  description: string;
  actionable: boolean;
  suggestedAction?: string;
}

type TensionType =
  | 'PRODUCT_HIGH_DESIGN_LOW'
  | 'PRODUCT_HIGH_ENGINEERING_LOW'
  | 'DESIGN_HIGH_PRODUCT_LOW'
  | 'ENGINEERING_HIGH_PRODUCT_LOW'
  | 'ALL_MEDIUM';
```

#### Dimension-to-Pillar Attribution

| Dimension | Pillar | Rationale |
|-----------|--------|-----------|
| SA-1 Problem Resonance | Product | Measures alignment with mission (Product-owned DID field) |
| SA-2 Vibe Coherence | Design | Measures alignment with design principles (Design-owned DID field) |
| SA-3 Vision Vector | Shared (Product + Design) | Both pillars govern product direction |
| D-pi Demand Pressure | Product | Customer signal is Product's domain |
| M-phi Market Force | Product | External market awareness is Product's domain |
| E-tau Entropy Tax | Product | Strategic drift detection is Product's domain |
| ER-1 Resource Availability | Engineering | Build resources are Engineering's domain |
| ER-2 Build Complexity | Engineering | Complexity and autonomy assessment are Engineering's domain |
| ER-3 Dependency Clearance | Engineering | Technical dependencies are Engineering's domain |
| ER-4 Design System Readiness | Design | Design system health is Design's domain |
| HC_explicit | Product | Manual priority field, typically Product-set |
| HC_consensus | Shared | Team-wide signal |
| HC_decision | Shared | Meeting-level deliberation |
| HC_design | Design | Design authority channel |
| C-kappa Calibration | Engineering | Calibrated from build outcomes (Engineering data) |

#### Tension Detection

```typescript
function detectTensions(breakdown: { product: PillarContribution; design: PillarContribution; engineering: PillarContribution }): TensionFlag[] {
  const flags: TensionFlag[] = [];
  const p = pillarSignalScore(breakdown.product);
  const d = pillarSignalScore(breakdown.design);
  const e = pillarSignalScore(breakdown.engineering);

  if (p > 0.7 && d < 0.3) {
    flags.push({
      type: 'PRODUCT_HIGH_DESIGN_LOW',
      description: 'Product dimensions strongly support this item but Design dimensions are suppressing it. Design system readiness is likely the constraint.',
      actionable: true,
      suggestedAction: 'Check ER-4 breakdown in design pillar. Fill catalog gap in the relevant component category.',
    });
  }
  if (p > 0.7 && e < 0.3) {
    flags.push({
      type: 'PRODUCT_HIGH_ENGINEERING_LOW',
      description: 'Product dimensions strongly support this item but Engineering dimensions are suppressing it. Complexity, autonomy level, or dependency clearance is the constraint.',
      actionable: true,
      suggestedAction: 'Decompose item or defer to a capacity window with sufficient autonomy level.',
    });
  }
  if (d > 0.7 && p < 0.3) {
    flags.push({
      type: 'DESIGN_HIGH_PRODUCT_LOW',
      description: 'Design system is ready and components exist, but product demand signal is weak.',
      actionable: false,
      suggestedAction: 'Validate demand signal. This may be infrastructure work masquerading as a feature.',
    });
  }
  if (e > 0.7 && p < 0.3) {
    flags.push({
      type: 'ENGINEERING_HIGH_PRODUCT_LOW',
      description: 'Item is easy to build but has low strategic value.',
      actionable: false,
      suggestedAction: 'Do not build just because it is easy. Validate strategic alignment first.',
    });
  }
  if (p >= 0.3 && p <= 0.5 && d >= 0.3 && d <= 0.5 && e >= 0.3 && e <= 0.5) {
    flags.push({
      type: 'ALL_MEDIUM',
      description: 'No pillar has a strong signal. The product thesis for this item may need revisiting.',
      actionable: false,
      suggestedAction: 'Run a Soul Health Diagnostic (PPA v1.0 Section 8). This item cluster may indicate unclear product direction.',
    });
  }

  return flags;
}
```

---

### A.7 Learn Phase: Design-Centric Metrics

The AI-SDLC Learn phase (orchestrator reconciliation step 7) currently records code-centric metrics: defect density, churn rate, code acceptance rate. C3's `defect_risk_factor` needs design-centric metrics from the same code areas.

**Required state store extensions:**

```typescript
interface CodeAreaMetrics {
  // ── Existing ────────────────────────────────────────────────
  defectDensity: number;
  churnRate: number;
  prRejectionRate: number;
  codeAcceptanceRate: number;

  // ── New: Frontend classification ────────────────────────────
  /** Whether this code area contains frontend components.
   *  Determines whether designMetrics are relevant. */
  hasFrontendComponents: boolean;

  // ── New: Design quality metrics (RFC-0008) ──────────────────
  designMetrics?: {
    /** Design CI pass rate — from RFC-0006 Addendum A §A.3 gates. */
    ciPassRate: number;

    /** Design review rejection rate — from RFC-0006 §8.5. */
    reviewRejectionRate: number;

    /** Usability simulation pass rate — from RFC-0006 Addendum A §A.5. */
    usabilityPassRate: number;

    /** Token compliance trend — from RFC-0006 §10.1.
     *  Negative = compliance declining (design debt accumulating). */
    tokenComplianceTrend: number;

    /** Component fragmentation count — number of one-off components
     *  created in this area that duplicate catalog patterns.
     *  Measured by ComponentUndocumented reconciliation events. */
    componentFragmentationCount: number;
  };

  /** Number of data points in the trailing window.
   *  Minimum 10 required for defect_risk_factor. */
  dataPointCount: number;
}
```

**Data source wiring:**

| Metric | Source | Pipeline Stage |
|--------|--------|---------------|
| `hasFrontendComponents` | Component catalog + code area path analysis | Registration time |
| `ciPassRate` | Design CI quality gate results (RFC-0006 Addendum A §A.3) | Post-gate audit log |
| `reviewRejectionRate` | Design review gate feedback (RFC-0006 §8.5.3) | Design review feedback store |
| `usabilityPassRate` | Usability simulation results (RFC-0006 Addendum A §A.5) | Simulation runner output |
| `tokenComplianceTrend` | Token compliance reconciliation events (RFC-0006 §10.1) | Reconciler event log |
| `componentFragmentationCount` | ComponentUndocumented events (RFC-0006 §10.1) | Reconciler event log |

The Learn phase MUST ingest these metrics from the RFC-0006 pipeline's audit log and store them in the state store's `CodeAreaMetrics` table, keyed by code area path.

---

### A.8 Reconciliation: DesignQualityTrendDegrading Event

The RFC-0006 reconciler is level-triggered — it fires on state changes (token changed, component added). It does not fire on quality *trends*. A code area where the design CI pass rate has been declining over 10 consecutive PRs produces no reconciliation event, even though this is a meaningful signal of design debt accumulation.

**New reconciliation event:**

```yaml
# Added to RFC-0006 §10.1 reconciliation events table
- event: DesignQualityTrendDegrading
  condition: >
    Design quality metrics in a code area show sustained decline
    over a configurable window (default: 10 consecutive PRs or 30 days,
    whichever comes first).
  triggers:
    - metric: designCIPassRate
      condition: "declined by >= 15% over window"
    - metric: designReviewRejectionRate
      condition: "increased by >= 20% over window"
    - metric: tokenComplianceTrend
      condition: "negative for >= 5 consecutive measurements"
  action:
    - notify: designAuthority.principals
    - notify: engineeringAuthority.principals
    - createIssue:
        title: "Design quality trend degrading in {codeArea}"
        labels: ["design-debt", "automated"]
        body: |
          Automated detection: design quality metrics in {codeArea}
          have been declining over the last {window}.

          Metrics:
          - Design CI pass rate: {current} (was {baseline})
          - Design review rejection rate: {current} (was {baseline})
          - Token compliance trend: {trend}

          This may indicate accumulating design debt. Consider:
          - Reviewing recent PRs in this area for token compliance
          - Scheduling a design system audit for affected components
          - Adjusting Eρ₄ to reflect current design system health
        priority: medium
```

This event gives both design and engineering leadership early warning before a code area's design quality degrades enough to affect Eρ₄ scores and block work items.

---

### A.9 Design → Engineering Lookahead: Planned Token Schema Changes

C7 (§11) specifies a Product → Design lookahead. The symmetric gap is Design → Engineering: when the design team plans a token schema restructuring (e.g., splitting a semantic token for dark mode expansion), engineering has no advance notice.

**New event type:**

```yaml
triggers:
  - event: design-change.planned
    source: design-intent-document
    description: >
      Emitted when a design authority principal marks a planned
      change in the DesignIntentDocument or DesignSystemBinding
      that has not yet been executed.

    payload:
      changeType: "token-restructure" | "token-addition" | "token-removal"
                | "component-category-addition" | "brand-revision"
                | "theme-expansion"
      description: "Splitting color.primary into color.primary.light
                    and color.primary.dark for dark mode support"
      estimatedTimeline: "2026-Q2"
      affectedTokenPaths: ["color.primary", "color.surface.brand"]
      estimatedComponentImpact: 34
      plannedBy: "design-lead"

    engineeringActions:
      - "Pre-warm visual baselines for affected stories"
      - "Schedule agent capacity for token migration pipeline"
      - "Flag components requiring complex refactoring (manual review)"
      - "Update DesignSystemBinding sync schedule if needed"
```

**Implementation:** The `DesignIntentDocument` resource (§4) gains a `spec.plannedChanges` array. When a design authority principal adds a planned change, the orchestrator emits the `design-change.planned` event.

```yaml
spec:
  # ... existing fields ...
  plannedChanges:
    - id: dark-mode-token-split
      changeType: token-restructure
      description: >
        Splitting color.primary into color.primary.light and
        color.primary.dark for dark mode support.
      estimatedTimeline: "2026-Q2"
      affectedTokenPaths: ["color.primary", "color.surface.brand"]
      status: planned                     # planned | in-progress | completed | cancelled
      addedBy: design-lead
      addedAt: "2026-03-15T00:00:00Z"
```

---

### A.10 GitHub Actions Workflow Extension

The `.github/workflows/ai-sdlc-admit.yml` workflow MUST be extended to pass the new context to the CLI:

```yaml
jobs:
  admit:
    steps:
      - name: Score issue
        run: |
          RESULT=$(node dist/cli-admit.js \
            --title '${{ github.event.issue.title }}' \
            --body-file /tmp/body.txt \
            --issue-number '${{ github.event.issue.number }}' \
            --labels '${{ toJSON(github.event.issue.labels.*.name) }}' \
            --reactions '${{ github.event.issue.reactions.total_count }}' \
            --comments '${{ github.event.issue.comments }}' \
            --created-at '${{ github.event.issue.created_at }}' \
            --author-association '${{ github.event.issue.author_association }}' \
            --enrich-from-state \
            2>/tmp/admit-stderr.txt | tail -1)
```

The `--enrich-from-state` flag signals the CLI to run `enrichAdmissionInput()` before scoring. When the flag is absent (backward compatibility), the scorer operates in stateless mode with safe defaults.

```typescript
interface AdmitArgs {
  // ... existing fields ...
  authorAssociation: string;

  // New: enrichment flag
  enrichFromState: boolean;              // --enrich-from-state

  // New: explicit overrides (for testing and manual pipeline runs)
  designSystemRef?: string;              // --design-system-ref <n>
  autonomyPolicyRef?: string;            // --autonomy-policy-ref <n>
}
```

---

### A.11 Summary: Interface Flow Coverage

After this addendum, all ten directional flows between the trifecta pillars are specified:

| From | To | Signal | Status |
|------|----|--------|--------|
| Engineering | PPA | Complexity score, cost metrics, build outcomes | **Specified** (PPA v1.0) |
| Engineering | PPA | Code area quality metrics (C3), autonomy level (C4) | **Specified** (this addendum §A.5–A.6) |
| PPA | Engineering | Ranked priority stack | **Specified** (PPA v1.0) |
| PPA | Engineering | Priority stack enriched with Eρ₄ breakdown + pillarBreakdown | **Specified** (this addendum §A.2–A.4, §A.6) |
| Design | PPA | Design system health (C2), vibe coherence (C1), HC_design (C5), post-ship quality (C6) | **Specified** (§§5–10) |
| PPA | Design | Upcoming items with design complexity flags + pillarBreakdown (C7) | **Specified** (§11) |
| Engineering | Design | Build outcomes triggering design reconciliation | **Specified** (RFC-0006 §10) |
| Engineering | Design | Design quality trend degradation alerts | **Specified** (this addendum §A.8) |
| Design | Engineering | DesignSystemBinding configuration | **Specified** (RFC-0006 §5) |
| Design | Engineering | Planned token schema changes (lookahead) | **Specified** (this addendum §A.9) |

All ten directional flows are covered. The engineering-side enrichment (§A.2–A.6) provides the implementation bridge that makes Connections C1–C7 executable against the live codebase.

---

*End of RFC-0008 v4*

---

## Addendum B: Deterministic-First SA Scoring

**Supersedes:** Addendum B (original ontology-graph approach)

This addendum supersedes the original Addendum B (ontology-grounded scoring) and incorporates Product pillar feedback from Alexander Kline (April 4, 2026). The diagnosis from the original is accepted by all parties: embedding-based SA scoring has two systematic failure modes — vocabulary overlap masquerading as conceptual alignment, and structural relationship blindness. The original solution (graph intersection infrastructure) is deferred pending production evidence.

This addendum applies the architectural pattern established in AI-SDLC Tutorial 09: **deterministic-first, structural-second, LLM-last**. Two Product pillar governance contributions are adopted in full: the DID `identityClass` field (core/evolving) on all fields, and the `SoulDriftDetected` portfolio-level monitoring event. Three clarification requests from the sign-off round (CR-1 formula correction, CR-2 weight floor, CR-3 test tool and gate conditions) are applied inline — see Addendum C for the resolution record.

---

## B.1 Motivation

Embedding-based SA scoring has two systematic failure modes.

**B.1.1 Vocabulary overlap masquerading as conceptual alignment.** Cosine
similarity rewards shared vocabulary regardless of whether the underlying
intent aligns. An issue proposing "brand-configurable button colors" shares
vocabulary with a soul document emphasizing brand consistency and will score
high on embedding similarity, despite being a theme engine feature request
that may be entirely outside the product's intended scope. The model cannot
distinguish "this issue is about our domain" from "this issue uses our
domain's vocabulary."

**B.1.2 Structural relationship blindness.** Soul documents express directed,
typed, and negated relationships. "Small businesses should not need technical
expertise to manage inventory" is a negated dependency — not three concepts
in proximity. An issue proposing "an inventory webhook API requiring developer
integration" inverts the relationship the soul document explicitly prohibits.
Embedding distance cannot detect this inversion because it flattens structure
into proximity. The highest-risk issues are the ones that look most aligned:
the closer an issue is to the soul's vocabulary while inverting its
constraints, the more likely embedding similarity is to miss the conflict.

These are real failure modes. Both are addressed by the three-layer
architecture specified below without requiring graph infrastructure or
a replacement LLM call that inherits the same variance problems as the
existing scorer.

---

## B.2 Architectural Pattern

### B.2.1 Source: Tutorial 09

AI-SDLC Tutorial 09 (Review Agent Calibration) established the
deterministic-first, structural-second, LLM-last pattern for code review:

```
PR Diff
  ├─→ [Deterministic] CI/CD — lint, typecheck, tests, coverage
  ├─→ [Deterministic] AST Preprocessor — complexity, file length, imports
  └─→ [LLM] Review Agents — only what compute cannot resolve
        └── Pre-verified boundary: agents skip CI-covered categories
```

The key discipline: each layer handles only what the layer below cannot.
The LLM receives a pre-verified boundary and never re-examines what
deterministic analysis already resolved. Layers partition the problem
space — they do not overlap.

### B.2.2 Applied to SA Scoring

The same partition applies to soul alignment scoring. The DID's structured
fields are the equivalent of the AST — they contain the rule bases that
enable deterministic checking before any LLM is involved.

```
Work item (title + body)
  │
  ├─→ [DETERMINISTIC] Compiled DID rules
  │     ├── Scope gate: outOfScope labels vs issue text
  │     ├── Constraint violations: must-not-require via dep-parse
  │     └── Anti-pattern hits: prohibited concept terms vs issue text
  │         └─→ Hard gates + conflict markers
  │                (scope_gate, violations[], antipattern_hits[])
  │
  ├─→ [STRUCTURAL] Classical IR (BM25)
  │     ├── Domain relevance: issue vs DID mission + experientialTargets
  │     │    (core fields weighted 2×, evolving fields weighted 1×)
  │     └── Principle coverage: BM25 per design principle (SA-2)
  │         └─→ domain_relevance ∈ [0,1], principle_coverage[]
  │
  └─→ [LLM] Structured assessment
        ├── Pre-verified boundary: scope, constraints, and anti-patterns
        │    are pre-resolved — LLM does not re-examine them
        ├── Structured output only: intentAlignment + subtleConflicts[]
        ├── Confidence filtering: findings below 0.5 suppressed
        └── Exemplar bank: labeled true/false positives for calibration
            └─→ intent_alignment ∈ [0,1], subtle_conflicts[]
```

### B.2.3 Why This Addresses Both Failure Modes

**B.1.1 (Vocabulary overlap):** The structural layer's BM25 domain
relevance score measures term importance against the DID's actual content,
not embedding proximity. The LLM layer is explicitly prompted to distinguish
intent alignment from vocabulary proximity. Both layers target the same
failure mode from different angles.

**B.1.2 (Structural inversion):** The deterministic layer's constraint
violation detection uses dependency parsing to catch negation patterns
("requires X" where DID says "must not require X") without any LLM
involvement. This is cheaper, faster, and more deterministic than
embedding or graph intersection approaches. The LLM layer handles subtle
inversions the dep-parser misses, but only those.

### B.2.4 Why This Addresses the Product Pillar's Concerns

**Premature architecture (Concern 1):** No new resource types. No new
state store tables. The DID extensions below add structured fields to an
existing resource. The BM25 scorer and dep-parser are standard library
operations. The LLM layer is a structured prompt replacing the existing
embedding computation — not an addition to it.

**Vocabulary control (Concern 3):** The deterministic rule bases are
compiled from DID fields governed by the existing split-authority model.
Product Lead owns the product-domain fields (constraints, scope boundaries,
anti-patterns). Design Lead owns the design-domain fields (visual
constraints, voice anti-patterns). The same mutual approval requirement
from §4.4 applies. No new governance surface is introduced.

**Embedding fallback inconsistency (Concern 2):** Embeddings are not used
as a scoring fallback. The structural layer uses BM25 — a classical IR
technique that is fully deterministic given fixed input. Embeddings are
retained only for entity resolution (synonym normalization in the dep-parse
step), which is a narrow and appropriate use — not a scoring mechanism.

---

## B.3 DID Extensions for the Deterministic Layer

### B.3.1 Overview

The DID currently buries rule-compilable information in prose. The
`mission` field contains scope boundaries, constraint negations, and
anti-patterns in natural language. The `measurableSignal` field on each
design principle is free text. These fields are legible to humans but
not directly compilable into deterministic checks.

The extensions below add structured counterparts to the existing prose
fields. The prose fields are preserved — they remain authoritative for
human comprehension. The structured fields are the machine-readable
compilation targets.

Every new field carries the `identityClass` marker from the Product
pillar's Amendment 4 contribution. `identityClass` governs both:
- The reconciliation response when the field changes (§B.9)
- The weight the field carries in the structural BM25 scorer (§B.5)

### B.3.2 Full Extended DID YAML

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignIntentDocument
metadata:
  name: acme-product-intent
  namespace: product-acme
  labels:
    product: acme-app
    version: "2.0"

spec:
  stewardship:
    # Unchanged from RFC-0008 v4 §4.4 split-authority model
    productAuthority:
      owner: product-lead
      approvalRequired: [product-lead, design-lead]
      scope:
        - soulPurpose.mission
        - soulPurpose.constraints           # NEW
        - soulPurpose.scopeBoundaries       # NEW
        - soulPurpose.antiPatterns          # NEW
        - experientialTargets
    designAuthority:
      owner: design-lead
      approvalRequired: [design-lead, product-lead]
      scope:
        - soulPurpose.designPrinciples
        - brandIdentity
        - brandIdentity.voiceAntiPatterns   # NEW
        - brandIdentity.visualIdentity.visualConstraints    # NEW
        - brandIdentity.visualIdentity.visualAntiPatterns   # NEW
    sharedAuthority:
      approvalRequired: [design-lead, product-lead]
      scope:
        - designSystemRef.syncFields
    engineeringReview:
      role: reviewer
      blockingScope:
        - soulPurpose.constraints.*.detectionPatterns
        - soulPurpose.antiPatterns.*.detectionPatterns
        - brandIdentity.visualConstraints.*.rule
      rationale: >
        Engineering reviews detection patterns for technical feasibility
        and visual constraint rules for measurability. Cannot block on
        content — only on whether a rule is technically computable.

    reviewCadence: quarterly

  # ─────────────────────────────────────────────
  # SOUL PURPOSE
  # ─────────────────────────────────────────────
  soulPurpose:

    mission:
      identityClass: core         # Alex's contribution: core = pivot event on change
      value: >
        Acme helps small businesses manage inventory without
        requiring technical expertise. Every interaction should
        feel like a knowledgeable colleague helping, not a
        software system demanding.

    # ── NEW: Typed constraint declarations ──────────────────────────────
    # Replaces constraint language buried in mission prose.
    # Each entry compiles to a dep-parse detection rule.
    # productAuthority
    constraints:
      - id: no-technical-expertise
        identityClass: core
        concept: "technical expertise"
        relationship: must-not-require
        rationale: >
          Our users are non-technical by definition. Any feature
          that increases required expertise violates the core
          product constraint.
        detectionPatterns:
          # These patterns are compiled into dep-parse rules.
          # A match in an issue's text triggers a constraint violation.
          - "requires technical expertise"
          - "requires developer"
          - "requires coding knowledge"
          - "requires API knowledge"
          - "developer integration required"
          - "technical setup required"

      - id: no-developer-involvement
        identityClass: core
        concept: "developer involvement"
        relationship: must-not-require
        rationale: >
          Features requiring engineering involvement to configure
          or operate break the product's core value proposition.
        detectionPatterns:
          - "requires a developer"
          - "developer setup"
          - "engineering required"
          - "custom development"
          - "code changes required"
          - "implementation by engineering"

    # ── NEW: Scope boundaries ────────────────────────────────────────────
    # Compiled to inclusion/exclusion keyword lists.
    # out-of-scope matches trigger the hard scope gate.
    # productAuthority
    scopeBoundaries:
      inScope:
        - label: "small businesses"
          identityClass: core
          synonyms:
            - "SMB"
            - "small business owner"
            - "small company"
            - "small team"
        - label: "inventory management"
          identityClass: core
          synonyms:
            - "stock management"
            - "inventory control"
            - "stock tracking"
            - "warehouse management"
        - label: "non-technical operators"
          identityClass: core
          synonyms:
            - "non-technical user"
            - "business owner"
            - "operator"
            - "staff"

      outOfScope:
        - label: "enterprise deployments"
          identityClass: core
          synonyms:
            - "enterprise"
            - "enterprise customer"
            - "large organization"
            - "Fortune 500"
            - "enterprise scale"
        - label: "developer tooling"
          identityClass: core
          synonyms:
            - "developers"
            - "engineers"
            - "technical users"
            - "API consumers"
            - "system integrators"
        - label: "white-label platforms"
          identityClass: evolving
          synonyms:
            - "white-label"
            - "reseller platform"
            - "multi-tenant for agencies"

    # ── NEW: Anti-patterns ───────────────────────────────────────────────
    # Explicit rejections of approaches the product does not take.
    # Compiled to term-matching rules against issue text.
    # productAuthority
    antiPatterns:
      - id: developer-required-setup
        identityClass: core
        label: "requiring developer involvement to set up or configure"
        description: >
          Any feature that requires engineering work to configure,
          deploy, or maintain on behalf of the customer.
        detectionPatterns:
          - "developer setup"
          - "engineering involvement"
          - "custom implementation"
          - "requires code changes"
          - "needs IT department"

      - id: raw-data-exposure
        identityClass: core
        label: "exposing raw data structures to end users"
        description: >
          Surfacing database schemas, API payloads, raw JSON, or
          technical data models directly in the user interface.
        detectionPatterns:
          - "JSON configuration"
          - "raw API response"
          - "database schema"
          - "raw payload"
          - "schema editor"
          - "query builder"

      - id: enterprise-feature-creep
        identityClass: evolving
        label: "enterprise-grade features misaligned with SMB needs"
        description: >
          Features designed primarily for enterprise scale, compliance
          requirements, or organizational complexity that add overhead
          to the SMB use case.
        detectionPatterns:
          - "SSO for enterprise"
          - "compliance reporting"
          - "audit trail for regulators"
          - "role-based access for large teams"

    # ── Design principles (extended with structured fields) ─────────────
    # designAuthority
    designPrinciples:
      - id: approachable-first
        name: "Approachable First"
        description: >
          Every component should be understandable on first encounter.
          Progressive disclosure over upfront complexity. When in doubt,
          remove options rather than add tooltips.
        identityClass: evolving

        # NEW: structured measurable signals (replaces free-text measurableSignal)
        # These compile to threshold checks against Learn phase metrics.
        measurableSignals:
          - id: task-completion-low-tech
            metric: usability-simulation-task-completion
            threshold: 0.85
            operator: gte
            scope: low-tech-confidence-personas
            identityClass: evolving
          - id: first-encounter-comprehension
            metric: user-research-first-encounter-score
            threshold: 0.80
            operator: gte
            scope: new-users
            identityClass: evolving

        # NEW: principle-scoped anti-patterns
        antiPatterns:
          - label: "tooltip proliferation"
            identityClass: evolving
            detectionPatterns:
              - "tooltip"
              - "help text on hover"
              - "information icon"
              - "contextual help popup"
          - label: "upfront configuration wizard"
            identityClass: evolving
            detectionPatterns:
              - "setup wizard"
              - "initial configuration"
              - "onboarding form"
              - "configuration required before use"
          - label: "feature exposure before readiness"
            identityClass: evolving
            detectionPatterns:
              - "advanced settings exposed"
              - "all options visible"
              - "full feature set on first screen"

      - id: calm-confidence
        name: "Calm Confidence"
        description: >
          The interface communicates trustworthiness through visual
          stability. Minimal animation. Consistent spatial rhythm.
          No layout shifts. Information density is moderate.
        identityClass: evolving

        measurableSignals:
          - id: design-rejection-rate-visual
            metric: design-review-rejection-rate
            threshold: 0.10
            operator: lte
            scope: visual-quality-category
            identityClass: evolving
          - id: visual-regression-diff-rate
            metric: visual-regression-diff-rate
            threshold: 0.02
            operator: lte
            scope: releases
            identityClass: evolving

        antiPatterns:
          - label: "layout shift"
            identityClass: core
            detectionPatterns:
              - "dynamic layout"
              - "content reflow"
              - "responsive resize of content"
              - "loading state changes layout"
          - label: "excessive animation"
            identityClass: evolving
            detectionPatterns:
              - "animated transitions between every"
              - "continuous animation"
              - "motion on scroll"
              - "parallax"
          - label: "information overload"
            identityClass: evolving
            detectionPatterns:
              - "show all data"
              - "full dashboard"
              - "all metrics on one screen"
              - "dense data grid"

      - id: efficient-depth
        name: "Efficient Depth"
        description: >
          Power users can access advanced features without the interface
          becoming complex for new users. Depth is earned through
          interaction, not displayed by default.
        identityClass: evolving

        measurableSignals:
          - id: component-reuse-rate
            metric: component-reuse-rate
            threshold: 0.70
            operator: gte
            scope: all-components
            identityClass: evolving

        antiPatterns:
          - label: "feature-specific custom UI"
            identityClass: evolving
            detectionPatterns:
              - "custom component for this feature"
              - "one-off design"
              - "unique to this page"
              - "new component type needed"
          - label: "complexity upfront"
            identityClass: evolving
            detectionPatterns:
              - "all options available immediately"
              - "no progressive disclosure"
              - "power user features on main screen"

  # ─────────────────────────────────────────────
  # DESIGN SYSTEM BINDING
  # ─────────────────────────────────────────────
  # Unchanged from RFC-0008 v4
  designSystemRef:
    name: acme-design-system
    namespace: team-frontend
    bindingType: authoritative
    syncFields:
      - did: soulPurpose.designPrinciples
        dsb: compliance.disallowHardcoded
        relationship: "Principles inform compliance rules"
      - did: soulPurpose.mission
        dsb: designReview.scope
        relationship: "Mission context provided to design reviewers"

  # ─────────────────────────────────────────────
  # BRAND IDENTITY (extended)
  # ─────────────────────────────────────────────
  # designAuthority
  brandIdentity:
    voiceAttributes: ["helpful", "knowledgeable", "patient", "concise"]

    # ── NEW: Voice anti-patterns ─────────────────────────────────────────
    # Compiled to term-matching rules against issue titles and descriptions
    # that imply a particular communication approach.
    voiceAntiPatterns:
      - label: "technical jargon in user-facing copy"
        identityClass: core
        description: >
          Using engineering vocabulary in UI strings, tooltips,
          error messages, or any user-visible text.
        detectionPatterns:
          - "API key"
          - "webhook payload"
          - "schema configuration"
          - "endpoint URL"
          - "JSON response"
      - label: "passive or uncertain voice"
        identityClass: evolving
        description: >
          Copy that hedges, uses passive constructions, or communicates
          uncertainty rather than calm confidence.
        detectionPatterns:
          - "may or may not"
          - "it is recommended"
          - "users should consider"

    visualIdentity:
      description: >
        Clean, warm, professional. White space communicates calm.
        Primary blue communicates trust. Rounded corners communicate
        approachability. Type scale emphasizes readability over style.
      tokenSchemaRef: "acme-design-system.spec.tokens"

      # ── NEW: Visual constraints ──────────────────────────────────────────
      # Compilable rules checked against Learn phase metrics and
      # DesignSystemBinding status. Engineering can block on measurability.
      # designAuthority
      visualConstraints:
        - id: animation-duration-cap
          identityClass: evolving
          label: "minimal animation"
          description: "Animations must not exceed 200ms duration"
          rule:
            metric: animation-duration-max-ms
            threshold: 200
            operator: lte
        - id: spacing-grid
          identityClass: evolving
          label: "8px spatial grid"
          description: "All spacing must be multiples of 8px"
          rule:
            metric: spacing-grid-compliance
            threshold: 0.95
            operator: gte
        - id: type-scale-compliance
          identityClass: evolving
          label: "defined type scale only"
          description: "Font sizes must come from the defined type scale"
          rule:
            metric: type-scale-compliance
            threshold: 1.0
            operator: gte

      # ── NEW: Visual anti-patterns ────────────────────────────────────────
      # designAuthority
      visualAntiPatterns:
        - label: "layout shift on data load"
          identityClass: core
          description: >
            UI elements that move or resize when data loads.
            All loading states must reserve space.
          detectionPatterns:
            - "skeleton loading changes layout"
            - "content shifts when loaded"
            - "dynamic height based on content"
        - label: "modal overuse"
          identityClass: evolving
          description: >
            Using modal dialogs for non-critical confirmations
            or as a primary navigation pattern.
          detectionPatterns:
            - "modal for every action"
            - "confirmation modal"
            - "dialog for settings"
        - label: "icon-only actions"
          identityClass: evolving
          description: >
            Action buttons with icons but no visible labels.
            All actions must have visible text or persistent labels.
          detectionPatterns:
            - "icon-only button"
            - "icon without label"
            - "toolbar with icons"

  # ─────────────────────────────────────────────
  # EXPERIENTIAL TARGETS
  # ─────────────────────────────────────────────
  # Unchanged from RFC-0008 v4, identityClass added
  # productAuthority
  experientialTargets:
    onboarding:
      identityClass: evolving
      targetEmotion: "I can do this"
      maxStepsToFirstValue: 3
      usabilityTarget:
        taskCompletion: 0.90
        personaType: low-tech-confidence
    dailyUse:
      identityClass: evolving
      targetEmotion: "This saves me time"
      interactionEfficiency:
        metric: actions-per-task
        targetReduction: "20% vs. manual process"
    errorRecovery:
      identityClass: evolving
      targetEmotion: "That's okay, I know how to fix this"
      errorRecoveryRate: 0.95
      maxActionsToRecover: 3

  # ─────────────────────────────────────────────
  # PLANNED CHANGES
  # ─────────────────────────────────────────────
  # Unchanged from RFC-0008 Addendum A §A.9
  plannedChanges: []
```

### B.3.3 Field Compilation Summary

At DID creation and on every approved change, the orchestrator compiles
the DID's structured fields into three runtime artifacts stored in the
state store:

| Compiled artifact | Source fields | Used by |
|-------------------|--------------|---------|
| Scope gate lists | `scopeBoundaries.inScope[]` + `outOfScope[]` (all synonyms flattened) | Layer 1: scope gate |
| Constraint violation rules | `constraints[].detectionPatterns[]` | Layer 1: dep-parse rules |
| Anti-pattern term lists | `antiPatterns[].detectionPatterns[]` + `designPrinciples[].antiPatterns[].detectionPatterns[]` + `voiceAntiPatterns[].detectionPatterns[]` + `visualAntiPatterns[].detectionPatterns[]` | Layer 1: term matching |
| BM25 corpora | `mission.value` + `experientialTargets` (weighted by identityClass) | Layer 2: domain relevance |
| Principle corpora | `designPrinciples[].description` per principle | Layer 2: principle coverage |
| Measurable signal thresholds | `designPrinciples[].measurableSignals[]` + `visualConstraints[]` | Layer 1: threshold checks |

Compilation is triggered by any approved DID change. The compiled
artifacts are lightweight — flat lists and BM25 index structures, not
graphs. Compilation is synchronous and fast.

**Identity class affects compilation weight, not compilation trigger.**
When `identityClass: core` fields change, the compiled artifacts are
rebuilt AND a `CoreIdentityChanged` event is emitted (see §B.9). When
`identityClass: evolving` fields change, the artifacts are rebuilt but
no special event is emitted.

---

## B.4 Layer 1: Deterministic Scorer

Layer 1 runs against the compiled DID artifacts. No LLM. No embeddings.
All checks are fully deterministic given fixed input and fixed compiled
artifacts.

### B.4.1 Scope Gate

```typescript
interface ScopeGateResult {
  passed: boolean;
  outOfScopeMatches: Array<{
    label: string;           // e.g. "enterprise deployments"
    matchedText: string;     // verbatim text from issue
    identityClass: 'core' | 'evolving';
  }>;
}

function checkScopeGate(
  issueText: string,        // title + body concatenated
  compiledScopeLists: CompiledScopeLists,
): ScopeGateResult {
  const outOfScopeMatches = [];

  for (const boundary of compiledScopeLists.outOfScope) {
    for (const synonym of boundary.synonyms) {
      if (containsToken(issueText, synonym)) {
        outOfScopeMatches.push({
          label: boundary.label,
          matchedText: synonym,
          identityClass: boundary.identityClass,
        });
      }
    }
  }

  return {
    passed: outOfScopeMatches.length === 0,
    outOfScopeMatches,
  };
}
```

**Hard gate:** If the scope gate fails with any `core` out-of-scope match:
`SA-1 = 0.0`. Scoring stops. The admission result includes the specific
match in its `pillarBreakdown.product.governedDimensions.sAlpha1`.

**Soft flag:** If the scope gate fails with only `evolving` out-of-scope
matches: scoring continues but a `scopeWarning` flag is attached to the
result. This represents possible scope expansion rather than a definitive
rejection.

### B.4.2 Constraint Violation Detection

Constraint violation detection uses dependency parsing to find cases
where an issue proposes requiring something the DID says must not be
required. This directly addresses failure mode B.1.2 (structural
inversion) without an LLM.

```typescript
interface ConstraintViolationResult {
  violations: Array<{
    constraintId: string;    // DID constraint id
    concept: string;         // e.g. "technical expertise"
    matchedPattern: string;  // which detectionPattern fired
    matchedText: string;     // verbatim text from issue
    identityClass: 'core' | 'evolving';
  }>;
}

function detectConstraintViolations(
  issueText: string,
  compiledConstraintRules: CompiledConstraintRules,
): ConstraintViolationResult {
  const violations = [];

  for (const rule of compiledConstraintRules) {
    for (const pattern of rule.detectionPatterns) {
      // Dep-parse: look for "requires [concept]", "needs [concept]",
      // "[concept] required", "must have [concept]" constructions
      // using a dependency parser (spaCy or equivalent)
      const match = depParseMatch(issueText, pattern);
      if (match) {
        violations.push({
          constraintId: rule.id,
          concept: rule.concept,
          matchedPattern: pattern,
          matchedText: match.verbatim,
          identityClass: rule.identityClass,
        });
      }
    }
  }

  return { violations };
}
```

**Implementation note:** The `depParseMatch` function uses a dependency
parser (spaCy `en_core_web_sm` is sufficient) to detect requirement
constructions. Simple pattern matching handles the majority of cases.
The dep-parser catches grammatical variants ("developer involvement is
required", "requires involvement from a developer") that string matching
would miss. This is not LLM inference — it is grammatical structure
analysis, fast and deterministic.

### B.4.3 Anti-Pattern Detection

```typescript
interface AntiPatternResult {
  hits: Array<{
    antiPatternId: string;
    label: string;
    matchedPattern: string;
    matchedText: string;
    identityClass: 'core' | 'evolving';
    scope: 'product' | 'design-principle' | 'voice' | 'visual';
  }>;
}

function detectAntiPatterns(
  issueText: string,
  compiledAntiPatterns: CompiledAntiPatterns,
): AntiPatternResult {
  const hits = [];

  for (const ap of compiledAntiPatterns) {
    for (const pattern of ap.detectionPatterns) {
      if (containsToken(issueText, pattern)) {
        hits.push({
          antiPatternId: ap.id,
          label: ap.label,
          matchedPattern: pattern,
          matchedText: extractContext(issueText, pattern),
          identityClass: ap.identityClass,
          scope: ap.scope,
        });
      }
    }
  }

  return { hits };
}
```

### B.4.4 Measurable Signal Threshold Checks (SA-2)

For SA-2, the `measurableSignals` and `visualConstraints` fields compile
to threshold rules checked against Learn phase metrics and
DesignSystemBinding status. These are already partially covered by
the existing token compliance and catalog health checks in SA-2's
computable component. The new structured fields extend this coverage
to principle-specific metrics.

```typescript
interface MeasurableSignalResult {
  checks: Array<{
    signalId: string;
    metric: string;
    threshold: number;
    operator: 'gte' | 'lte';
    currentValue: number | null;   // null if data unavailable
    passed: boolean | null;        // null if data unavailable
    identityClass: 'core' | 'evolving';
  }>;
}
```

### B.4.5 Layer 1 Output

```typescript
interface DeterministicScoringResult {
  // SA-1 signals
  scopeGate: ScopeGateResult;
  constraintViolations: ConstraintViolationResult;
  antiPatternHits: AntiPatternResult;

  // SA-2 signals
  designAntiPatternHits: AntiPatternResult;   // scope: 'design-principle' | 'visual' | 'voice'
  measurableSignalChecks: MeasurableSignalResult;

  // Derived signals for scoring
  hardGated: boolean;             // true if core scope gate failed
  coreViolationCount: number;     // count of core-class violations
  evolvingViolationCount: number; // count of evolving-class violations

  // Pre-verified boundary for LLM layer
  preVerifiedSummary: string;     // Human-readable summary of what Layer 1 found
                                  // Injected into Layer 3 prompt as CI Boundary equivalent
}
```

---

## B.5 Layer 2: Structural Scorer

Layer 2 uses BM25 (Best Match 25), a classical information retrieval
ranking function. BM25 is fully deterministic, requires no LLM, and
runs in milliseconds. It measures how well the issue text matches the
DID's content, weighted by term importance — which addresses failure
mode B.1.1 (vocabulary overlap) better than embedding cosine similarity
because BM25 is sensitive to term frequency and document length
normalization, not semantic proximity.

### B.5.1 Domain Relevance Score (SA-1)

```typescript
/**
 * BM25 domain relevance: measures how much of the issue's content
 * is about topics the DID cares about.
 *
 * Corpus: DID mission.value + experientialTargets (all fields flattened)
 * Query: issue title + body
 *
 * Core fields are included in the corpus at 2× weight.
 * Evolving fields are included at 1× weight.
 *
 * Returns a normalized score in [0, 1].
 */
function computeDomainRelevance(
  issueText: string,
  compiledBM25Corpus: BM25Corpus,  // prebuilt from DID at compile time
): number {
  const raw = bm25Score(issueText, compiledBM25Corpus);
  return normalize(raw, compiledBM25Corpus.scoreRange);
}
```

**Why BM25 over embedding cosine similarity:**
- Deterministic: same input always produces the same output
- No model dependency: not affected by embedding model updates
- Interpretable: the score can be decomposed into contributing terms
- Addresses B.1.1: BM25 penalizes term frequency mismatch. An issue that
  uses the DID's vocabulary but in a different distribution scores lower
  than an issue that matches the DID's term importance pattern.

### B.5.2 Identity-Class Weighting

The BM25 corpus construction gives `core` fields double term weight:

```typescript
function buildBM25Corpus(did: DesignIntentDocument): BM25Corpus {
  const documents = [];

  // Mission: core — double weight
  documents.push({
    text: did.spec.soulPurpose.mission.value,
    weight: did.spec.soulPurpose.mission.identityClass === 'core' ? 2.0 : 1.0,
  });

  // Experiential targets: evolving — standard weight
  for (const [key, target] of Object.entries(did.spec.experientialTargets)) {
    documents.push({
      text: flattenTarget(target),
      weight: target.identityClass === 'core' ? 2.0 : 1.0,
    });
  }

  return buildIndex(documents);
}
```

An issue that strongly matches core identity fields scores higher than
one that matches only evolving expression fields. This is the structural
implementation of Alex's intent behind the `identityClass` field.

### B.5.3 Principle Coverage Vector (SA-2)

For SA-2, a BM25 score is computed per design principle, producing a
coverage vector:

```typescript
interface PrincipleCoverageVector {
  principles: Array<{
    principleId: string;
    coverage: number;         // BM25 score against this principle's description
    identityClass: 'core' | 'evolving';
  }>;
  overallCoverage: number;    // Weighted average
}

function computePrincipleCoverage(
  issueText: string,
  compiledPrincipleCorpora: PrincipleCorpora[],  // one per principle
): PrincipleCoverageVector {
  const principles = compiledPrincipleCorpora.map(corpus => ({
    principleId: corpus.principleId,
    coverage: normalize(bm25Score(issueText, corpus), corpus.scoreRange),
    identityClass: corpus.identityClass,
  }));

  const overallCoverage = weightedMean(
    principles.map(p => p.coverage),
    principles.map(p => p.identityClass === 'core' ? 2.0 : 1.0),
  );

  return { principles, overallCoverage };
}
```

### B.5.4 Layer 2 Output

```typescript
interface StructuralScoringResult {
  domainRelevance: number;              // SA-1: BM25 score [0,1]
  principalCoverage: PrincipleCoverageVector; // SA-2: per-principle BM25
  contributingTerms: string[];          // Top BM25 terms — for auditability
}
```

---

## B.6 Layer 3: LLM Scorer

Layer 3 handles only what Layers 1 and 2 cannot: **intent vs. vocabulary
disambiguation** (B.1.1 residual) and **subtle structural inversions**
that the dep-parser missed (B.1.2 residual). Everything else is
pre-verified.

### B.6.1 Pre-Verified Boundary

The LLM receives Layer 1's `preVerifiedSummary` as a boundary block
before the assessment prompt. This is the direct equivalent of Tutorial
09's CI Boundary — it explicitly scopes the LLM away from work already
done by compute:

```
PRE-VERIFIED (do not re-assess these categories):

Scope check: {scopeGate.passed ? "PASSED" : "FLAGGED: " + scopeGate.outOfScopeMatches}
Constraint violations: {violations.length > 0 ? violations.map(v => v.concept) : "none detected"}
Anti-pattern hits: {hits.length > 0 ? hits.map(h => h.label) : "none detected"}

Your assessment should focus ONLY on:
1. Whether the work item's INTENT aligns with the product's purpose,
   beyond vocabulary overlap (DOMAIN INTENT)
2. Whether there are subtle constraint inversions not captured above
   (SUBTLE CONFLICTS)

Do not re-examine scope boundaries, explicit constraints, or named
anti-patterns — those are resolved.
```

### B.6.2 SA-1 Structured Assessment Prompt

```
PRODUCT IDENTITY:
Core identity (weight: HIGH):
{DID.soulPurpose.mission.value}

Current expression (weight: STANDARD):
{DID.experientialTargets — flattened}

---

WORK ITEM:
Title: {issue.title}
Body: {issue.body}

---

{preVerifiedBoundary}

---

Assess the following. Return ONLY valid JSON:

{
  "domainIntent": {
    "score": float,        // 0.0 = purely vocabulary overlap, no real alignment
                           // 1.0 = issue intent genuinely serves the product's purpose
    "reasoning": string,   // one sentence explaining the score
    "confidence": float    // 0.0-1.0
  },
  "subtleConflicts": [
    {
      "description": string,   // what the conflict is
      "severity": "high" | "medium" | "low",
      "confidence": float
    }
  ]
}

Rules:
- domainIntent focuses on INTENT, not vocabulary. An issue can use
  the right words but be pursuing a different goal. Score that low.
- subtleConflicts are inversions not caught by the pre-verified checks.
  Do not repeat pre-verified findings. Empty array if none found.
- Findings with confidence < 0.5 must not be included.
```

### B.6.3 SA-2 Structured Assessment Prompt

```
DESIGN IDENTITY:
Design principles (weight varies by identityClass):
{DID.soulPurpose.designPrinciples — name + description per principle}

Brand values:
{DID.brandIdentity.voiceAttributes}
{DID.brandIdentity.visualIdentity.description}

---

WORK ITEM:
Title: {issue.title}
Body: {issue.body}

---

{preVerifiedBoundary — design layer}

---

{
  "principleAlignment": {
    "score": float,        // 0.0-1.0: overall alignment with design intent
    "reasoning": string,
    "confidence": float
  },
  "subtleDesignConflicts": [
    {
      "principleId": string,   // which principle is affected
      "description": string,
      "severity": "high" | "medium" | "low",
      "confidence": float
    }
  ]
}
```

### B.6.4 Exemplar Bank

Stored in `.ai-sdlc/sa-exemplars.yaml`. Same pattern as Tutorial 09's
review exemplar bank. To calibrate a false positive or false negative,
add an exemplar — no code changes required.

```yaml
exemplars:
  - id: brand-config-vocabulary-overlap
    dimension: SA-1
    type: false-positive          # Would score high on embedding; should score low
    issue:
      title: "Add per-brand button color configuration"
      body: "Allow brand managers to configure button colors to match their brand guidelines"
    layer1:
      scopeGate: passed
      constraintViolations: []
      antiPatternHits: []
    layer2:
      domainRelevance: 0.72       # High — brand vocabulary overlaps DID
    layer3Expected:
      domainIntent: 0.25          # Low — this is a theme engine feature, not inventory
      reasoning: "Issue addresses UI customization for resellers, not inventory management for SMBs"
    verdict: "low SA-1 — vocabulary match on brand terms, intent misalignment"
    principle: intent-over-vocabulary

  - id: webhook-api-constraint-inversion
    dimension: SA-1
    type: true-negative           # Should score low — constraint violation caught by Layer 1
    issue:
      title: "Add inventory sync via webhook API for developer integration"
      body: "Expose a webhook endpoint so developers can sync inventory state to external systems"
    layer1:
      scopeGate:
        passed: false
        outOfScopeMatches:
          - label: "developer tooling"
            matchedText: "developers"
            identityClass: core
      constraintViolations:
        - constraintId: no-developer-involvement
          matchedPattern: "developer integration"
          identityClass: core
    layer3Expected: null          # Hard gate — LLM not reached
    verdict: "SA-1 = 0.0 — core scope gate failure + core constraint violation"
    principle: deterministic-first

  - id: bulk-import-genuine-alignment
    dimension: SA-1
    type: true-positive
    issue:
      title: "Add bulk inventory import from CSV"
      body: "Allow business owners to upload a CSV file to import their existing inventory
             without needing technical help or data transformation"
    layer1:
      scopeGate: passed
      constraintViolations: []
      antiPatternHits: []
    layer2:
      domainRelevance: 0.81
    layer3Expected:
      domainIntent: 0.88
      reasoning: "Issue directly serves SMB users managing inventory without technical expertise"
    verdict: "high SA-1 — genuine domain alignment across all three layers"
    principle: evidence-first
```

### B.6.5 Layer 3 Output

```typescript
interface LLMScoringResult {
  // SA-1
  domainIntent: number;              // [0,1], 0.0 if below confidence threshold
  domainIntentConfidence: number;
  subtleConflicts: SubtleConflict[];

  // SA-2
  principleAlignment: number;        // [0,1]
  principleAlignmentConfidence: number;
  subtleDesignConflicts: SubtleDesignConflict[];

  // Meta
  preVerifiedBoundaryApplied: boolean;  // Confirms LLM received boundary
  suppressedFindings: number;           // Findings below 0.5 confidence, not returned
}
```

---

## B.7 Composite Scoring

### B.7.1 SA-1 Formula

```
# Hard gate (Layer 1)
if scopeGate failed with core match:
  SA-1 = 0.0
  STOP

# Conflict penalty (Layer 1)
coreConflictPenalty   = min(0.8, coreViolationCount × 0.4)
                        # each core violation removes up to 40%, max 80% penalty
evolvingConflictPenalty = min(0.3, evolvingViolationCount × 0.1)
conflictPenalty = 1.0 - coreConflictPenalty - evolvingConflictPenalty

# Blended non-deterministic score (Layers 2 + 3)
# Weights are phase-dependent (see §B.10)
structural_score = domainRelevance          # Layer 2
llm_score        = domainIntent             # Layer 3 (0.0 if below confidence)
                   × (0.5 if any high-severity subtleConflict, else 1.0)

SA-1_blended = (w_structural × structural_score) + (w_llm × llm_score)
# Phase weights: see §B.10

# Final
SA-1 = SA-1_blended × conflictPenalty
```

### B.7.2 SA-2 Formula (Corrected — CR-1)

SA-2 retains its existing computable component from RFC-0008 v4 §5.2
unchanged. The three-layer architecture adds conflict detection from
Layer 1 and replaces the monolithic LLM assessment with the
structural/LLM blend.

```
# ── Computable component (unchanged from RFC-0008 v4) ──────────────
computableScore = (0.3 × tokenCompliance) + (0.2 × catalogHealth)

# ── Design conflict penalty from Layer 1 ────────────────────────────
# Core anti-pattern hits carry a heavier penalty than evolving hits.
designConflictPenalty =
  1.0 - min(0.60,
    (coreDesignAntiPatternHits   × 0.30) +
    (evolvingDesignAntiPatternHits × 0.10)
  )

# ── Blended LLM component (Layers 2 + 3) ────────────────────────────
#
# principalCoverage — Layer 2 BM25 score across design principles [0,1]
# principleAlignment — Layer 3 LLM score [0,1] (0.0 if below confidence)
#
# The blend is a weighted sum — no self-multiplication.
# Phase weights per §B.7.3. w_structural floor: 0.20 (CR-2).
#
# High-severity subtle design conflicts apply a 0.5 penalty to the
# LLM term only (they are residual — not caught by Layer 1).
llmTerm = w_llm × principleAlignment
        × (0.5 if any high-severity subtleDesignConflict else 1.0)

blendedScore = (w_structural × principalCoverage) + llmTerm

# The blended score is then penalized by Layer 1 conflict detection.
llmComponent = blendedScore × designConflictPenalty

# ── Final SA-2 ───────────────────────────────────────────────────────
SA-2 = computableScore + (0.5 × llmComponent)
```

**Correction note (CR-1):** The original formula had `principleAlignment`
as both the outer multiplier and inside the weighted blend, causing
self-compounding at `w_llm × principleAlignment²`. This was unintentional
and inconsistent with how SA-1 is computed. The corrected formula is a
clean weighted sum with the conflict penalty applied once at the end.
At Phase 2c values, the corrected formula produces ~10% higher scores
for well-aligned issues in the 0.7–0.9 range.

**Worked example at Phase 2c (w_structural = 0.35, w_llm = 0.65):**

| Input | Value |
|-------|-------|
| tokenCompliance | 0.88 |
| catalogHealth | 0.95 |
| principalCoverage (Layer 2) | 0.72 |
| principleAlignment (Layer 3) | 0.80 |
| subtleDesignConflicts | none |
| coreDesignAntiPatternHits | 0 |
| evolvingDesignAntiPatternHits | 0 |

```
computableScore       = (0.3 × 0.88) + (0.2 × 0.95) = 0.454
designConflictPenalty = 1.0
llmTerm               = 0.65 × 0.80 × 1.0            = 0.520
blendedScore          = (0.35 × 0.72) + 0.520         = 0.772
llmComponent          = 0.772 × 1.0                   = 0.772
SA-2                  = 0.454 + (0.5 × 0.772)         = 0.840
```

### B.7.3 Phase Weights

The blend between structural (Layer 2) and LLM (Layer 3) scores shifts
as the feedback flywheel accumulates calibration data:

| Phase | w_structural | w_llm | Condition |
|-------|-------------|-------|-----------|
| 2a: Shadow | 0.0 | 0.0 | Both computed, neither used in ranking |
| 2b: Blended entry | 0.20 | 0.80 | ≥ 20 issues scored, ≥ 5 exemplars |
| 2c: Calibrating | 0.35 | 0.65 | ≥ 60 days, C6 data beginning |
| 3: Calibrated | computed | computed | Weights from flywheel calibration |

In Phase 3, the weights are computed from the feedback flywheel data:
`w_structural` increases when structural scores prove more predictive
than LLM scores for accepted issues. The calibration is continuous —
weights update per sprint from C6 data.

**Structural weight floor (CR-2 spec decision):** `w_structural` has a
minimum floor of **0.20** regardless of flywheel calibration outcome.
This applies to both SA-1 and SA-2 `w_structural` parameters
independently. Rationale: the structural layer (BM25) provides
determinism, interpretability, and model-independence that the LLM layer
cannot guarantee. Even if flywheel data shows the LLM is more predictive
in aggregate, the floor ensures scoring remains reproducible across model
version changes and that the `contributingTerms` audit trail remains
meaningful. The floor is 0.20 rather than higher to preserve the
flywheel's ability to weight the LLM more heavily when empirically
warranted.

---

## B.8 Feedback Flywheel

Same pattern as Tutorial 09. Product Lead responses to SA assessments
calibrate the system over time.

| Signal | Source | Meaning |
|--------|--------|---------|
| `accept` | Product Lead marks issue as correctly assessed | True positive / true negative |
| `dismiss` | Product Lead overrides a low SA-1 score | False negative — issue was more relevant than scored |
| `escalate` | Product Lead flags a high SA-1 score as wrong | False positive — issue was less relevant than scored |
| `override` | Product Lead uses HC_override | Bypasses SA entirely — strongest false positive signal |

```typescript
import { SAFeedbackStore } from './state/index.js';

const store = new SAFeedbackStore();
store.record({
  issueNumber: 42,
  dimension: 'SA-1',
  deterministicResult: layer1Output,
  structuralScore: layer2Output.domainRelevance,
  llmScore: layer3Output.domainIntent,
  compositeScore: sa1Final,
  signal: 'dismissed',       // Product Lead override
  timestamp: new Date().toISOString(),
});

store.structuralPrecision();  // What fraction of structural scores were directionally correct
store.llmPrecision();         // What fraction of LLM scores were directionally correct
store.highFalsePositiveCategories();  // Which DID fields are driving false positives
```

**Calibration effects:**
- High `llmPrecision` and low `structuralPrecision`: shift Phase 3 weights toward LLM
- High `structuralPrecision` and low `llmPrecision`: shift Phase 3 weights toward structural
- Repeated `dismiss` signals on issues touching a specific DID field: candidate for exemplar addition or detection pattern refinement
- Repeated `escalate` signals on a specific anti-pattern detection: candidate for pattern removal or narrowing

---

## B.9 Scoring Stability Monitoring

Adopted from Alex's countermeasure with two additions: the event
distinguishes the change type (core identity vs evolving expression)
and the re-scoring scope follows the same `identityClass` logic that
governs the compiled artifacts.

### B.9.1 CoreIdentityChanged Event

When a `core`-class DID field is modified and approved:

```yaml
event: CoreIdentityChanged
payload:
  didName: string
  changedField: string       # e.g. "soulPurpose.mission"
  previousValue: string
  newValue: string
  changedBy: string
  approvedBy: string[]
action:
  - recompileAllArtifacts
  - rescoreFullBacklog       # All non-in-flight items, priority order
  - emit: BacklogReshuffled
  - notify: [product-lead, design-lead, engineering-lead]
  - flag: SoulGraphStale     # On in-flight items (C6 exclusion, per Addendum B original §B.7.4)
```

When an `evolving`-class DID field is modified:

```yaml
action:
  - recompileAllArtifacts
  - rescoreAdmissionQueue    # Items not yet admitted only
  # Full backlog re-score not triggered for evolving changes
```

### B.9.2 SoulDriftDetected Event

Adopted from Alex's countermeasure. Continuous monitoring of rolling
SA score distribution across admitted items.

```yaml
event: SoulDriftDetected
trigger:
  condition: >
    Rolling 30-day mean of SA-1 scores for admitted items drops
    below 0.4 OR standard deviation exceeds 0.15 for 3 consecutive
    sprints.
  rationale: >
    No single item fails. The portfolio drifts. This catches gradual
    accumulation of borderline-acceptable items that collectively
    represent strategic misalignment.
payload:
  dimension: SA-1 | SA-2
  rollingMean: float
  rollingStdDev: float
  sprintsInViolation: integer
  trend: increasing | decreasing | stable
  # New: which layer is producing the drift
  driftSource:
    deterministicFlags: integer    # Count of issues with soft (evolving) flags
    structuralScoreMean: float     # Layer 2 mean
    llmScoreMean: float            # Layer 3 mean
    note: >
      If structuralScoreMean is healthy but llmScoreMean is low,
      the drift may reflect LLM calibration issues, not actual
      product identity drift. Review exemplar bank before
      adjusting DID.
notification:
  channel: [product-lead, design-lead, engineering-lead]
  message: >
    SA-{dimension} scores have been trending low for
    {sprintsInViolation} consecutive sprints (mean: {rollingMean},
    stddev: {rollingStdDev}). Layer breakdown attached.
    This may indicate product identity drift or exemplar bank
    miscalibration. Review the DID core identity fields and
    the SA feedback flywheel before making DID changes.
```

The `driftSource` breakdown is the addition beyond Alex's original
proposal. If drift originates in the LLM layer, the fix is exemplar
bank calibration. If it originates in the structural layer, the fix
may be DID field refinement. If it originates in Layer 1 (many evolving
soft flags), the fix may be promoting some evolving constraints to core.
These have different remediation paths and should not be conflated.

---

## B.10 Phased Sequencing

| Phase | Timing | SA-1 Scorer | SA-2 Scorer | Gate |
|-------|--------|-------------|-------------|------|
| 1 (current) | v1.1 ships | Embedding-based (existing) | Composite (existing) | None |
| 2a Shadow | v1.2, weeks 1–2 | Three-layer computed; embedding used for ranking | Unchanged | DID structured fields authored; Layer 1 artifacts compiled; detection pattern test tool delivered |
| 2b Blended | v1.2, weeks 3–6 | Blended (w_llm=0.80, w_structural=0.20) | Layer 1 conflict penalty added to existing SA-2 | All Phase 2b gate conditions met (see below) |
| 2c Calibrating | v1.2, weeks 7–12 | Blended (w_llm=0.65, w_structural=0.35) | Unchanged | ≥ 60 days; C6 data beginning to accumulate |
| 3 Calibrated | v1.3+ | Weights from flywheel calibration; embedding deprecated | Same | C6 calibration data sufficient for weight optimization |

### B.10.1 Detection Pattern Test Tool (Phase 2a Deliverable — CR-3)

Before any detection patterns are committed to the DID, pattern authors
must be able to validate them against real issue text. The orchestrator
MUST provide a detection pattern test tool as a Phase 2a deliverable.

**Interface:**

```
ai-sdlc pattern-test \
  --did acme-product-intent \
  --field constraints.no-technical-expertise \
  --issue-text "Add inventory sync via webhook for developer integration"
```

**Output:**

```
Pattern test: constraints.no-technical-expertise
─────────────────────────────────────────────────
Issue text: "Add inventory sync via webhook for developer integration"

Matched patterns:
  ✓ "developer integration required" → fired (dep-parse: "for developer integration")
  ✓ "requires API knowledge"         → no match
  ✓ "developer setup"                → no match

Dep-parse result:
  "developer" ← prep("for") ← "integration"
  Requirement construction: DETECTED

Constraint violation: YES
  constraintId: no-technical-expertise
  matchedPattern: "developer integration required"
  matchedText: "for developer integration"
  identityClass: core
```

The tool runs Layer 1 checks only, in isolation. It does not invoke
the BM25 scorer or LLM. It accepts issue text from stdin or `--issue-text`,
and can be run against a list of issues via `--issue-file`.

**Authoring workflow:**

1. Pattern author drafts detection patterns in a local DID draft
2. Author runs `pattern-test` against a sample of recent issues
   (both issues that should fire the pattern and issues that should not)
3. Author reviews false positive and false negative rates
4. Author refines patterns until false positive rate is acceptable
5. Author commits patterns to DID and submits for approval

**False positive rate guidance:** Patterns that fire on more than 20%
of issues that should NOT fire them are considered too broad and must
be refined before Phase 2b activation. The test tool reports this rate
when run against a labeled issue set.

### B.10.2 Phase 2b Gate Conditions (Revised — CR-3)

Phase 2b (blended scoring) activates when ALL of the following are met:

**Quantitative gates:**
- ≥ 20 issues scored in shadow mode (Phase 2a)
- ≥ 5 exemplars in the SA exemplar bank covering both true-positive
  and false-positive cases

**Pattern coverage minimums (deterministic layer gate):**

The deterministic layer MUST NOT activate until minimum pattern coverage
is achieved per pillar. A sparse deterministic layer provides false
confidence while missing the majority of real violations.

| Category | Authority | Minimum |
|----------|-----------|---------|
| `constraints[]` (each entry must have ≥ 3 patterns) | Product | ≥ 2 constraints defined |
| `scopeBoundaries.outOfScope[]` (each entry must have ≥ 2 synonyms) | Product | ≥ 3 out-of-scope boundaries |
| `antiPatterns[]` (global, each with ≥ 3 patterns) | Product | ≥ 3 anti-patterns |
| `designPrinciples[].antiPatterns[]` (per principle, each with ≥ 2 patterns) | Design | ≥ 2 anti-patterns per principle |
| `voiceAntiPatterns[]` (each with ≥ 2 patterns) | Design | ≥ 2 voice anti-patterns |
| `visualAntiPatterns[]` (each with ≥ 2 patterns) | Design | ≥ 2 visual anti-patterns |

These are minimums, not targets. The reference DID in §B.3.2 meets all
of them and should be used as the authoring template.

Design-domain minimums sign-off (Morgan Hirtle, 2026-04-13): "Approve as
specified. The minimums are achievable within Phase 2a given that your
design principles are already articulated in the design system."

**False positive gate:**

Each committed pattern must have been validated against real issue text
using the test tool (§B.10.1). The aggregate false positive rate across
all patterns in the product-domain layer MUST be below 20%. The aggregate
false positive rate across all patterns in the design-domain layer MUST
be below 20%. These are measured during Phase 2a shadow mode against
the issues scored in that period.

**Embedding deprecation:** Embeddings are deprecated for SA-1 scoring
in Phase 3. They are retained for entity resolution in the dep-parse
step (synonym normalization) only — a narrow use that does not affect
scoring outcomes.

---

## B.11 Impact on Existing RFC-0008 Sections

| Section | Impact |
|---------|--------|
| §4.2 DesignIntentDocument YAML | Extended with structured fields per §B.3 |
| §4.4 Ownership Model | New fields assigned to productAuthority / designAuthority per §B.3.2 |
| §4.5 Schema Requirements | New required fields: `constraints`, `scopeBoundaries`, `antiPatterns` under productAuthority; `measurableSignals` (structured), principle-level `antiPatterns`, `voiceAntiPatterns`, `visualConstraints`, `visualAntiPatterns` under designAuthority |
| §5.2 SA-2 Specification | LLM assessment prompt updated with pre-verified boundary; Layer 1 conflict penalty applied to llmComponent |
| §A.2 AdmissionInput | Gains `deterministicSAContext` field carrying Layer 1 output |
| §A.4 enrichAdmissionInput() | Extended to run Layer 1 checks before scoring |
| §A.5 Scoring Function | SA-1 computation updated per §B.7.1; SA-2 updated per §B.7.2 |

---

## B.12 Open Questions — Final Dispositions

All five open questions are resolved. No open questions remain.

| OQ | Question | Resolution | Authority | Date |
|----|----------|-----------|-----------|------|
| 1 | Dep-parser library choice | **Closed.** spaCy `en_core_web_sm` confirmed as reference implementation. Engineering owns the Python interop or TypeScript binding decision during implementation. | Dom Legault | 2026-04-04 |
| 2 | BM25 index rebuild granularity | **Closed.** Immediate rebuild on approved DID change. DID changes are infrequent and approval-gated; debouncing adds complexity for a low-frequency event. | CR Resolution | 2026-04-04 |
| 3 | Detection pattern authoring UX | **Closed via CR-3.** Test tool promoted to Phase 2a deliverable. CLI interface, authoring workflow, and false positive rate guidance specified in CR Resolution §CR-3 Part A. | CR Resolution | 2026-04-04 |
| 4 | Phase 3 structural weight floor | **Closed via CR-2.** `w_structural >= 0.20` confirmed as spec decision. Applies to SA-1 and SA-2 independently. Rationale: deterministic anchor must not be fully overridden by the LLM layer. | CR Resolution | 2026-04-04 |
| 5 | SA-2 coherence (high principle alignment, low token compliance) | **Closed.** Design Authority accepted the interpretation: computable and directional are parallel signals at different timescales. A code area can be behind on tokens while a new feature still points the right direction. This is accurate mixed signal, not contradiction. | Morgan Hirtle | 2026-04-13 |

---

*End of RFC-0008 Addendum B (Revised)*

---

## Addendum C: CR Resolution Record

**Purpose:** Audit record of the three clarification requests raised by Alexander Kline during Product pillar sign-off on Addendum B (Revised), and their resolutions. The CR patches have been applied inline to Addendum B in this combined document. This addendum preserves the full resolution rationale and sign-off trail.

**Date:** 2026-04-04
**Final sign-off:** All items closed 2026-04-13

### C.0 Preamble

Alexander Kline has granted Product pillar sign-off on RFC-0008 Addendum B
(Revised) subject to resolution of three clarification requests. This document
resolves all three, provides the exact replacement text for each affected
section, and confirms the two v1.2 planning additions Alex noted are already
present in the revised addendum.

No architectural changes. All resolutions are surgical.

**Required for close:** Dom signs off on CR-1 (formula correction) and CR-3
(test tool scope). Morgan signs off on CR-3 (pattern coverage minimums for
design-domain fields) and OQ-5 (SA-2 coherence interpretation).

---

### C.1 CR-1: SA-2 Formula Correction (Applied to §B.7.2)

**Status:** Formula bug confirmed. Corrected below.

### Diagnosis

The formula in §B.7.2 of the revised addendum reads:

```
llmComponent = principleAlignment × (w_structural × principalCoverage
                                   + w_llm × principleAlignment)
             × designConflictPenalty
```

`principleAlignment` appears as both the outer multiplier and inside
the weighted blend as `w_llm × principleAlignment`. This causes
`principleAlignment` to multiply itself — at Phase 2c values
(w_llm = 0.65), a score of 0.8 produces a self-compounding term of
`0.8 × 0.65 × 0.8 = 0.416` rather than the intended `0.65 × 0.8 = 0.52`.
The effect is most pronounced in the 0.4–0.7 score range.

This is **unintentional**. The outer multiplier has no principled
justification and is inconsistent with how SA-1 is computed, where the
LLM score is a flat weighted term with no self-compounding. The intent
was a weighted blend of structural coverage and LLM principle alignment,
with the conflict penalty applied once at the end.

### Corrected Formula

**Replace §B.7.2 in its entirety with the following:**

---

### B.7.2 SA-2 Formula (Corrected)

SA-2 retains its existing computable component from RFC-0008 v4 §5.2
unchanged. The three-layer architecture adds conflict detection from
Layer 1 and replaces the monolithic LLM assessment with the
structural/LLM blend.

```
# ── Computable component (unchanged from RFC-0008 v4) ──────────────
computableScore = (0.3 × tokenCompliance) + (0.2 × catalogHealth)

# ── Design conflict penalty from Layer 1 ────────────────────────────
# Core anti-pattern hits carry a heavier penalty than evolving hits.
designConflictPenalty =
  1.0 - min(0.60,
    (coreDesignAntiPatternHits   × 0.30) +
    (evolvingDesignAntiPatternHits × 0.10)
  )

# ── Blended LLM component (Layers 2 + 3) ────────────────────────────
#
# principalCoverage — Layer 2 BM25 score across design principles [0,1]
# principleAlignment — Layer 3 LLM score [0,1] (0.0 if below confidence)
#
# The blend is a weighted sum — no self-multiplication.
# Phase weights per §B.7.3.
#
# High-severity subtle design conflicts apply a 0.5 penalty to the
# LLM term only (they are residual — not caught by Layer 1).
llmTerm = w_llm × principleAlignment
        × (0.5 if any high-severity subtleDesignConflict else 1.0)

blendedScore = (w_structural × principalCoverage) + llmTerm

# The blended score is then penalized by Layer 1 conflict detection.
llmComponent = blendedScore × designConflictPenalty

# ── Final SA-2 ───────────────────────────────────────────────────────
SA-2 = computableScore + (0.5 × llmComponent)
```

**Worked example at Phase 2c (w_structural = 0.35, w_llm = 0.65):**

| Input | Value |
|-------|-------|
| tokenCompliance | 0.88 |
| catalogHealth | 0.95 |
| principalCoverage (Layer 2) | 0.72 |
| principleAlignment (Layer 3) | 0.80 |
| subtleDesignConflicts | none |
| coreDesignAntiPatternHits | 0 |
| evolvingDesignAntiPatternHits | 0 |

```
computableScore    = (0.3 × 0.88) + (0.2 × 0.95) = 0.264 + 0.190 = 0.454
designConflictPenalty = 1.0
llmTerm            = 0.65 × 0.80 × 1.0 = 0.520
blendedScore       = (0.35 × 0.72) + 0.520 = 0.252 + 0.520 = 0.772
llmComponent       = 0.772 × 1.0 = 0.772
SA-2               = 0.454 + (0.5 × 0.772) = 0.454 + 0.386 = 0.840
```

**Same example with the original (buggy) formula for comparison:**

```
llmComponent (buggy) = 0.80 × (0.35 × 0.72 + 0.65 × 0.80) × 1.0
                     = 0.80 × (0.252 + 0.520)
                     = 0.80 × 0.772
                     = 0.618
SA-2 (buggy)         = 0.454 + (0.5 × 0.618) = 0.454 + 0.309 = 0.763
```

The corrected formula produces 0.840 vs the buggy formula's 0.763 for
the same inputs — a 10% difference at the values where SA-2 decisions
are most consequential (0.7–0.9 range). The corrected version is both
mathematically consistent with SA-1 and more favorable to well-aligned
issues.

**Dom sign-off required:** Confirm the corrected formula is correct and
note the approval in the implementation ticket.

---

### C.2 CR-2: Phase 3 Structural Weight Floor (Applied to §B.7.3)

**Status:** Closed as spec decision.

**Replace Open Question 4 in §B.12 with the following spec decision:**

---

### Spec Decision: Phase 3 Structural Weight Floor

`w_structural` has a minimum floor of **0.20** regardless of flywheel
calibration outcome.

**Rationale:** The structural layer (BM25) provides three properties
the LLM layer cannot guarantee: it is deterministic, interpretable,
and model-independent. Even if flywheel data shows the LLM is more
predictive in aggregate across the backlog, `w_structural >= 0.20`
ensures:

1. A scoring run produces the same result given the same inputs,
   regardless of LLM temperature variance or model version changes.
2. The `contributingTerms` output from the BM25 scorer remains a
   meaningful component of the pillar breakdown audit trail.
3. A future model change does not silently shift SA scoring in ways
   that are only detectable post-facto via `SoulDriftDetected`.

The floor is **0.20**, not higher, to preserve the flywheel's ability
to weight the LLM more heavily when it is empirically more accurate.
If the structural layer is producing useful signal (high structural
precision per §B.8), calibrated weights will reflect that and `w_structural`
will settle above 0.20 naturally.

This floor applies to both SA-1 and SA-2 `w_structural` parameters
independently. They may calibrate to different values above 0.20.

---

### C.3 CR-3: Detection Pattern Test Tool and Phase Gate (Applied to §B.10)

**Status:** Test tool promoted to Phase 2a deliverable. Minimum pattern
coverage thresholds defined as Phase 2b gate condition.

### Part A — Test Tool in Phase 2a Scope

**Add the following to §B.10 under Phase 2a:**

---

#### Detection Pattern Test Tool (Phase 2a Deliverable)

Before any detection patterns are committed to the DID, pattern authors
must be able to validate them against real issue text. The orchestrator
MUST provide a detection pattern test tool as a Phase 2a deliverable.

**Interface:**

```
ai-sdlc pattern-test \
  --did acme-product-intent \
  --field constraints.no-technical-expertise \
  --issue-text "Add inventory sync via webhook for developer integration"
```

**Output:**

```
Pattern test: constraints.no-technical-expertise
─────────────────────────────────────────────────
Issue text: "Add inventory sync via webhook for developer integration"

Matched patterns:
  ✓ "developer integration required" → fired (dep-parse: "for developer integration")
  ✓ "requires API knowledge"         → no match
  ✓ "developer setup"                → no match

Dep-parse result:
  "developer" ← prep("for") ← "integration"
  Requirement construction: DETECTED

Constraint violation: YES
  constraintId: no-technical-expertise
  matchedPattern: "developer integration required"
  matchedText: "for developer integration"
  identityClass: core
```

The tool runs Layer 1 checks only, in isolation. It does not invoke
the BM25 scorer or LLM. It accepts issue text from stdin or `--issue-text`,
and can be run against a list of issues via `--issue-file`.

**Authoring workflow:**

1. Pattern author drafts detection patterns in a local DID draft
2. Author runs `pattern-test` against a sample of recent issues
   (both issues that should fire the pattern and issues that should not)
3. Author reviews false positive and false negative rates
4. Author refines patterns until false positive rate is acceptable
5. Author commits patterns to DID and submits for approval

**False positive rate guidance:** Patterns that fire on more than 20% of
issues that should NOT fire them are considered too broad and must be
refined before Phase 2b activation. The test tool reports this rate when
run against a labeled issue set.

---

### Part B — Minimum Pattern Coverage Thresholds as Phase 2b Gate

**Replace the existing Phase 2b gate condition in §B.10 with the following:**

---

#### Phase 2b Gate Conditions (Revised)

Phase 2b (blended scoring) activates when ALL of the following are met:

**Quantitative gates:**
- ≥ 20 issues scored in shadow mode (Phase 2a)
- ≥ 5 exemplars in the SA exemplar bank covering both true-positive
  and false-positive cases

**Pattern coverage minimums (deterministic layer gate):**

The deterministic layer MUST NOT activate until minimum pattern coverage
is achieved per pillar. A sparse deterministic layer provides a false
sense of coverage while missing the majority of real violations.

| Category | Authority | Minimum |
|----------|-----------|---------|
| `constraints[]` (each entry must have ≥ 3 patterns) | Product | ≥ 2 constraints defined |
| `scopeBoundaries.outOfScope[]` (each entry must have ≥ 2 synonyms) | Product | ≥ 3 out-of-scope boundaries |
| `antiPatterns[]` (global, each with ≥ 3 patterns) | Product | ≥ 3 anti-patterns |
| `designPrinciples[].antiPatterns[]` (per principle, each with ≥ 2 patterns) | Design | ≥ 2 anti-patterns per principle |
| `voiceAntiPatterns[]` (each with ≥ 2 patterns) | Design | ≥ 2 voice anti-patterns |
| `visualAntiPatterns[]` (each with ≥ 2 patterns) | Design | ≥ 2 visual anti-patterns |

These are minimums. The Acme example DID in §B.3.2 meets all of them
and should be treated as the reference implementation.

**False positive gate:**

Each committed pattern must have been validated against real issue text
using the test tool (Part A above). The aggregate false positive rate
across all patterns in the product-domain layer MUST be below 20%.
The aggregate false positive rate across all patterns in the design-domain
layer MUST be below 20%. These are measured during Phase 2a shadow mode
against the issues scored in that period.

**Dom and Morgan sign-off required on pattern coverage minimums:**
- Dom: Confirm the minimums are achievable within Phase 2a timeline
- Morgan: Confirm the design-domain minimums are sufficient and that
  Design Lead can author patterns for all three design-domain categories
  (principle anti-patterns, voice anti-patterns, visual anti-patterns)
  before Phase 2b activation

---

### C.4 v1.2 Planning Additions Confirmation

Alex noted two additions worth incorporating into the PPA v1.2 working
draft. Both are already present in the revised Addendum B. This section
confirms their presence and provides the canonical references.

**Addition 1: `driftSource` breakdown in `SoulDriftDetected`**

Present in §B.9.2. The event payload includes:
```yaml
driftSource:
  deterministicFlags: integer    # Count of issues with soft (evolving) flags
  structuralScoreMean: float     # Layer 2 mean
  llmScoreMean: float            # Layer 3 mean
```
This is the canonical definition for PPA v1.2. No additional work needed.

**Addition 2: Flywheel signal types in feedback flywheel**

Present in §B.8. The four signal types are specified:
```
accept    → True positive / true negative
dismiss   → False negative (Product Lead overrides low score)
escalate  → False positive (Product Lead flags high score as wrong)
override  → HC_override bypass — strongest false positive signal
```
This is the canonical definition for PPA v1.2. No additional work needed.

---

### C.5 Open Question Final Dispositions

All five open questions from the revised Addendum B are now resolved.

| OQ | Resolution | Authority |
|----|-----------|-----------|
| 1. Dep-parser library (spaCy) | Engineering decision. Spec names spaCy `en_core_web_sm` as the reference implementation. Dom to confirm or substitute equivalent during implementation. | Engineering |
| 2. BM25 index rebuild granularity | Immediate rebuild on approved DID change. DID changes are infrequent and approval-gated; debouncing adds complexity for a low-frequency event. | Closed |
| 3. Detection pattern test tool scope | Promoted to Phase 2a deliverable. Authoring workflow and false positive rate guidance defined above (CR-3 Part A). | Closed |
| 4. Phase 3 structural weight floor | `w_structural >= 0.20` confirmed as spec decision (CR-2). | Closed |
| 5. SA-2 coherence (high principle alignment, low token compliance) | Expected behavior. Directional alignment and current operational compliance are different signals at different timescales. A new feature can be directionally aligned with design principles while touching a low-compliance code area — that is an accurate mixed signal, not a contradiction. **Morgan sign-off requested** to confirm Design is aligned on this interpretation before v1.2 planning begins. | Pending Morgan |

---

### C.6 Sign-Off Record

| Person | Item | Status | Date |
|--------|------|--------|------|
| Alexander Kline | All three CRs | ✅ Approved | 2026-04-04 |
| Dom Legault | CR-1: Formula correction confirmed correct | ✅ Confirmed | 2026-04-04 |
| Dom Legault | CR-3: Test tool in Phase 2a scope, minimums achievable | ✅ Confirmed | 2026-04-04 |
| Dom Legault | OQ-1: spaCy `en_core_web_sm` confirmed | ✅ Confirmed | 2026-04-04 |
| Morgan Hirtle | CR-3: Design-domain pattern coverage minimums sufficient and achievable | ✅ Approved as specified | 2026-04-13 |
| Morgan Hirtle | OQ-5: SA-2 coherence interpretation from Design seat | ✅ Accepted | 2026-04-13 |

**Morgan Hirtle sign-off notes (2026-04-13):**
- **CR-3:** "Approve as specified. The minimums are achievable within Phase 2a given that your design principles are already articulated in the design system."
- **OQ-5:** "Accept the interpretation. Computable and directional are parallel signals at different timescales — that framing is consistent with how your pipeline already treats design system compliance (a code area can be behind on tokens while a new feature still points the right direction)."

All sign-offs received. CR patches are applied inline throughout this document. Phase 2a implementation is fully unblocked across all scope including the design-domain Layer 1 activation path. No further stakeholder review is required.

---

*End of RFC-0008 v4 (final) — including Addendum A: Engineering Integration Specification, Addendum B: Deterministic-First SA Scoring, and Addendum C: CR Resolution Record*
