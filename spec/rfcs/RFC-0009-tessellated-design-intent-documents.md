# RFC-0009: Tessellated Design Intent Documents for Multi-Soul Platforms

**Document type:** Normative (draft)
**Status:** Draft v3.2 — Product-pillar authored amendment to PPA v1.0's single-soul architecture. Closes PPA v1.0 §8 "Multi-Product Portfolio" open question and RFC-0005 "Multi-product portfolio-level resource allocation (future work)" non-goal. v3.2 strengthens fractal-triad framing (Identity / Expression / Coherence) per PPA v1.1, expands §5.1 design vertex with DID ownership-model parallel, marks OQ-13 resolved against title rename ("multi-soul" + "soul sharding" coexist), and adds explicit acknowledgment of PPA v1.1's C8 Cost Governance Integration wiring SubscriptionPlan.tenantQuotaShare → §7.3 Eρ₆. v1 + v2 + v3 + v3.1 superseded; see Revision History.
**Created:** 2026-04-24
**Revised:** 2026-04-27
**Authors:** Alexander Kline (Product Authority, author of PPA v1.0 + RFC-0005)
**Reviewers:** [Engineering Authority — Pending], [Design Authority — Pending], [Product Authority — Authored]
**Spec version:** v1alpha1
**Requires:** RFC-0005 (Product Priority Algorithm), RFC-0008 (PPA Triad Integration), PPA v1.0
**Closes:** PPA v1.0 §8 "Multi-Product Portfolio" open question; RFC-0005 "Multi-product portfolio-level resource allocation" non-goal; RFC-0008 §17 v1.1 Direction (extends with v1.1-6 + v1.1-7)

---

## Sign-Off

| Person | Role | Status | Date |
|--------|------|--------|------|
| Dominique Legault | CTO / Engineering Authority + AI-SDLC Operator | ⏸ Pending review of v3.2 | — |
| Morgan Hirtle | Chief of Design / Design Authority | ⏸ Pending review of v3.2 | — |
| Alexander Kline | Head of Product Strategy / Product Authority | ✍️ Authored v3.2 | 2026-04-27 |

---

## Revision History

| Version | Date | Summary |
|---------|------|---------|
| v1 | 2026-04-24 | Initial proposal. Introduces Tessellated DID + Shard DID + Fractal Triad as backwards-compatible additive extension to RFC-0008. Surfaced from practitioner pass against a real multi-shard platform implementation. |
| v1.1 | 2026-04-25 | Two follow-on candidate sections added: §13.5 session-bug + severity scoring rule, §13.6 incident monitoring + root-cause analysis. Asymmetric-risk closing argument added to §1. |
| v2 | 2026-04-26 | Rewritten in-place per Engineering review feedback (S190): reference-implementation-specific terminology stripped from normative body, format aligned to RFC-0008 convention, open questions enumerated, implementation sequencing made discrete. |
| v3 | 2026-04-26 | Product-pillar voice strengthened. Reframes RFC-0009 as a PPA architectural amendment (not just RFC-0008 schema additions): explicitly closes PPA v1.0 §8 "Multi-Product Portfolio" open question and RFC-0005 "Multi-product portfolio-level resource allocation" non-goal. Open questions where the implementation has a strong product position now state that position with reasoning instead of hedging; pure-naming questions (OQ-4) remain genuinely open. New §16 PPA v1.1 Direction section mirroring RFC-0008 §17 pattern adds v1.1-6 (per-shard Sα vector) and v1.1-7 (per-shard Cκ tensor). Reference Implementation appendix reframed as empirical proof-by-existence, not framework-supplicant. |
| v3.1 | 2026-04-27 | Additive-only patch acknowledging upstream's RFC-0010 (Parallel Execution + Worktree Pooling, published 2026-04-27 by Dom). New §7.3 Eρ₆ Cost Clearance gating sub-component (parallel to Eρ₅ Compliance Clearance) honoring RFC-0010 `tenantQuotaShare` per shard. New §8.5 SubscriptionPlan, §8.6 WorktreePool, §8.7 DatabaseBranchPool, §8.8 Operator role scope sections enumerating RFC-0010 resource interaction at platform vs shard scopes. New OQ-10 (Operator role tessellation), OQ-11 (DatabaseBranchPool per-shard policy), OQ-12 (Eρ₆ vs Dπ₃ — which dimension cost-pressure feeds into). No changes to v3's normative spec. |
| **v3.2** | **2026-04-27** | **Parity pass with PPA v1.1 (Alexander, same day). Strengthens §4 Fractal Triad with the Identity / Expression / Coherence framing for the structural pillar asymmetry — Product declares identity, Design expresses identity, Engineering maintains coherence between Identity and Expression at runtime; the asymmetry is a structural property of the basis, not a gap to fix. Strengthens §5.1 design vertex with explicit DID ownership-model parallel to PPA v1.1 §4 (Product owns mission/experientialTargets feeding SA1; Design owns designPrinciples/brandIdentity/visualIdentity feeding SA2; Engineering reviews and may block only on technical infeasibility of measurable signals). Adds §7.3 explicit acknowledgment of PPA v1.1's C8 Cost Governance Integration as the operational channel wiring SubscriptionPlan.tenantQuotaShare → Eρ₆. Marks OQ-13 resolved-against-rename: PPA v1.1 landed on "multi-soul scoring" terminology in body + title; "soul sharding" survives as accurate vocabulary for the *pattern itself* (mechanism), complementing "multi-soul platform" which describes the *architectural shape* (output). Adds PPA v1.1 to References. No normative content changed from v3 or v3.1; v3.2 is purely strengthening + cross-reference parity.** |

---

## Table of Contents

1. [Summary](#1-summary)
2. [Motivation](#2-motivation)
3. [Definitions](#3-definitions)
4. [The Fractal Triad](#4-the-fractal-triad)
5. [Schema Amendments to `design-intent-document.schema.json`](#5-schema-amendments)
6. [Admission Composite Extension](#6-admission-composite-extension)
7. [New Sub-Dimensions](#7-new-sub-dimensions)
8. [Resource Type Extensions](#8-resource-type-extensions)
9. [Migration Path](#9-migration-path)
10. [Implementation Sequencing](#10-implementation-sequencing)
11. [Worked Example](#11-worked-example)
12. [Security and Authority Considerations](#12-security-and-authority-considerations)
13. [Open Questions](#13-open-questions)
14. [References](#14-references)
15. [Appendix A: Reference Implementation](#15-appendix-a-reference-implementation)
16. [PPA v1.1 Direction](#16-ppa-v11-direction)

---

## 1. Summary

PPA v1.0 §3 defines Soul Alignment (Sα) as a scalar function `Sα(w)` computed against "the soul purpose definition document" — singular. RFC-0005 §"Pipeline.spec.priorityPolicy" wires this to a single `soulPurpose` string. RFC-0008 §3-§4 makes this DID a shared artifact between Product and Design pillars. **The single-soul assumption that flows from PPA v1.0 → RFC-0005 → RFC-0008 is structurally incompatible with multi-product platforms** — a category of adopter that PPA v1.0 §8 explicitly identifies as an open question and RFC-0005 explicitly defers to "future work."

This RFC is that future work. It amends the PPA architecture (and consequently the DID schema, the admission composite, the resource type definitions) to support platforms running multiple soul-distinct products on shared engineering substrate. The amendment is strictly additive: single-product adopters of RFC-0005 + RFC-0008 require zero changes; their PPA scoring continues unchanged.

Three concepts are introduced:

- **Tessellated DID** — a parent DID describing a platform whose soul is composed of multiple Shard DIDs tiled together. Carries platform-level invariants and a tessellation manifest enumerating child shards.
- **Shard DID** — a soul-complete DID for one product face of a tessellated platform. Inherits substrate invariants from its parent Tessellated DID; specializes its own Sα / compliance / audience.
- **Fractal Triad** — every DID (Tessellated OR Shard) carries a required `triad: { design, engineering, product }` object. The triad is fractal: it exists at the platform level AND at each shard level, with inheritance from parent to child.

Closes the architectural gap that locks the Design pillar at platform-aggregate values when work is single-shard-scoped (empirically observed: 0.40 vs the shard-bounded 0.7+ that per-shard DSBs would correctly produce). Per-shard DSBs become authorable; per-shard Sα scoring becomes meaningful; per-shard Cκ calibration becomes possible.

This RFC also queues two PPA v1.1 directions (§16 v1.1-6 + v1.1-7) that formalize what the interim solution embeds structurally.

Three concepts are introduced:

- **Tessellated DID** — a parent DID describing a platform whose soul is composed of multiple Shard DIDs tiled together. Carries platform-level invariants and a tessellation manifest.
- **Shard DID** — a soul-complete DID for one product face of a tessellated platform. Inherits substrate invariants from its parent Tessellated DID; specializes its own Sα / compliance / audience.
- **Fractal Triad** — every DID (Tessellated OR Shard) carries a required `triad: { design, engineering, product }` object. The triad is fractal: it exists at the platform level AND at each shard level, with inheritance from parent to child.

All schema additions are optional fields. Single-product adopters of RFC-0008 require zero changes; their DIDs continue to work unchanged.

Closes the architectural gap that locks the Design pillar at platform-aggregate values (e.g., 0.40) when work is single-shard-scoped (e.g., should be 0.7+ against the targeted shard's DSB). Per-shard DSBs become authorable; per-shard Sα scoring becomes meaningful.

---

## 2. Motivation

### 2.1 The single-DID assumption breaks at platform scale

RFC-0008 §3 (Triad Architecture) and §4 (Design Intent Document) assume one DID per Pipeline. This assumption is correct for single-product SaaS and for tightly-coupled product suites. It produces meaningful Sα scores, sensible Cκ calibration, and addressable QualityGate criteria when the platform serves one soul-distinct audience with one shared compliance regime.

The assumption breaks when a platform serves multiple soul-distinct products on shared engineering substrate.

Concrete observable failure mode: when a multi-product platform has one DSB (DesignSystemBinding) covering platform-aggregate design system maturity, all single-shard work scores against the platform-aggregate Design pillar value. Empirically observed: Design pillar locked at 0.40 (lifecycle: stabilizing) when product-shard-specific DSBs would correctly score 0.7+ for shard-bounded work. The framework is technically correct; the abstraction is incorrect for the input.

### 2.2 The pattern is general, not implementation-specific

Multi-product platforms with shared substrate are common at scale:

- Payment platforms with multiple product lines (transactions, marketplace platform, lending, fraud-detection, card issuance) where each line carries categorically distinct compliance regimes (PCI, marketplace fund-flow, lending regulations, ML governance, BIN sponsorship)
- Productivity platforms with multiple product faces (documents, databases, AI assistance, calendaring) sharing a block-based substrate but diverging on user value and success metrics
- Commerce platforms with multiple verticals (storefront, point-of-sale, shipping, capital, workflow) where the lending vertical's compliance cannot be expressed in the same DID as the payment-card-present vertical's
- Design tool platforms with multiple product surfaces (design canvas, collaborative whiteboarding, developer mode, presentation) where success criteria diverge sharply

Each of these eventually hits the multi-soul governance wall. Without framework-level support, adopters either: (a) average soul signals across products (Sα becomes meaningless per product), (b) fragment into separate pipelines (loses substrate-sharing advantage), or (c) author side-channel governance docs the framework can't see (silent fragmentation).

### 2.3 Concrete drift modes single-DID misses

1. **Substrate code encoding shard-specific identity strings as fallbacks.** Single-DID has no way to express "substrate code must not name any specific shard" because there's only one shard in its mental model. Pattern compounds with every new product added.
2. **Persisted state from one product silently appearing in another product's surface during hydration.** Cross-product visual identity bleed at the presentation layer. Single-DID can't model the cross-product isolation invariant.
3. **Type unification gaps where the same shape is declared multiple times across substrate code paths.** Substrate-vs-product type drift is invisible without the substrate/shard distinction.
4. **Compliance regime conflicts** that single-DID can't express simultaneously. Multiple categorically-distinct regimes get forced into one bucket; the framework's QualityGate model either passes everything or blocks everything.
5. **Per-product Cκ calibration impossible.** Without tessellation, calibration data averages outcomes across categorically different products. The "did this work succeed?" signal becomes noise.

### 2.4 Cost shape

The cost is **slow-then-cliff**. Single-DID looks fine for years, then one day a specific drift pattern (cross-tenant write, regulatory-regime conflict, schema mis-attribution) causes a real incident that forces the platform team to retrofit governance under load. Tessellated DID lets the framework absorb this growth gracefully.

### 2.5 The asymmetric risk and the framework's commercial trajectory

Multi-product platforms with shared substrate are the target market for AI-SDLC at scale. Single-product adopters benefit from the framework today; multi-product adopters are the bigger commercial opportunity. Without RFC-0009, the framework's effective ceiling is single-product adopters — which does not match the platform-company shape that produces the framework's largest contracts and most visible reference customers.

Three asymmetric costs accrue from inaction, not incidentally but structurally:

1. **Vocabulary leadership transfers to whoever ships first.** Some adopter hits the multi-soul wall in the next 6-18 months. If the framework hasn't adopted RFC-0009, that adopter ships their own version under their own naming — the framework either absorbs a less-coherent proposal later or watches the ecosystem fork. Adopting now means the framework gets to shape the vocabulary while the proposal is mature, backwards-compatible, and field-validated by an existing reference implementation. Adopting later means inheriting the next adopter's compromise.

2. **Adopters that hit the wall route around the framework or abandon it.** Concretely, a team using AI-SDLC for their first product launches successfully → adds a second product → hits single-soul Sα incoherence → has three options: (a) author side-channel governance docs the framework can't see (silent fragmentation; framework loses authority), (b) fork the framework with their own multi-DID extension (loud fragmentation; framework loses ecosystem coherence), or (c) abandon AI-SDLC for something more accommodating (commercial loss). All three reduce the framework's commercial trajectory. RFC-0009 absorbs the growth curve gracefully and keeps adopters inside the framework's authority.

3. **Competitive lead window is narrow.** No competing AI-SDLC-adjacent governance framework (CrewAI, AutoGen, SmythOS, the various agentic-platform startups) has solved multi-product governance. Most haven't even named it as a problem. AI-SDLC adopting RFC-0009 first means the framework has a structural differentiator that takes a competitor 6-12 months to credibly match — and by then the framework has compound-interest credibility from real adopters governing real multi-product platforms on it.

The product-pillar position: **single-soul governance feels safe today and becomes a liability tomorrow.** Tessellation is the cheapest insurance: strictly additive, backwards-compatible, validated by an existing reference implementation, with vocabulary the framework gets to own.

---

## 3. Definitions

Terms used throughout this RFC. Generic; adopter implementations may use different surface names while preserving the underlying concepts.

| Term | Meaning |
|---|---|
| **Tessellated DID** | A parent DID describing a platform composed of N Shard DIDs. Carries platform-level invariants, a tessellation manifest enumerating child shards, and cross-shard governance rules. |
| **Shard DID** | A soul-complete DID for one product face of a tessellated platform. Conforms to the same `design-intent-document.schema.json` as a single-product DID, with the addition of a `parentTessellation` field. |
| **Fractal Triad** | The PPA Triad (Engineering × Design × Product) replicated at multiple scopes: at the platform level on the Tessellated DID, and at each shard level on each Shard DID. Each triad vertex inherits from its parent. |
| **Sub-theme** | A purely cosmetic variant within a Shard DID — token overrides, no character roster change, no compliance change. Smallest sub-structure unit. |
| **Variant** | A visual + character-roster reskin of a Shard DID that shares the shard's underlying soul. Larger sub-structure than sub-theme; smaller than a separate shard. May add (but never subtract) compliance regimes from the parent shard. |
| **Journey** | A persona-pathway sub-division within a Shard DID. Same audience domain, same compliance, same engineering substrate; specializes scaffolding, mentor-roster emphasis, stage pacing, and journey-specific seed material for one cohort within the shard's broader audience. |
| **Tessellation Drift** | A class of Eτ-firing events: substrate code encoding shard-specific identifiers, cross-shard isolation invariant violations, or cross-shard convergence without explicit merge decision. |

The sub-theme < journey < variant < shard nesting represents four scopes of in-shard variation, each progressively larger in soul-distinctness.

---

## 4. The Fractal Triad

RFC-0008 §3 establishes the PPA Triad: **Engineering × Design × Product** as the three pillars of governance. RFC-0008 §C5 establishes HC_design as a design-pillar signal channel. This RFC extends the triad concept structurally: **the triad is fractal** — it exists at multiple scopes within a tessellated platform.

### 4.1 Geometry

A tessellation of triangles is a canonical mosaic pattern, used here as structural metaphor:

- Every **Shard DID is a triangle** with three vertices: `{ design, engineering, product }`
- Every **Tessellated DID is a larger triangle** with the same three vertices at platform scale
- Shard triangles tile into the platform triangle; each vertex of each shard triangle inherits from (and may extend) the corresponding platform-vertex
- A substrate invariant declared at a platform vertex propagates to all shard vertices of the same type
- A shard-specific specialization declared at a shard vertex remains local unless explicitly promoted to the platform vertex

### 4.1.1 The structural pillar asymmetry (v3.2 strengthening — Identity / Expression / Coherence)

The three pillars play structurally distinct roles at every scope of the tessellation. This asymmetry is a structural property of the basis, not a gap to fix:

- **Product declares identity** — what this shard is for, who it serves, what problem it exists to solve. The mission/audience/scope fields on the product vertex are the load-bearing identity declaration.
- **Design expresses identity** — how this shard appears, feels, and sounds. The design principles, brand identity, visual identity, and voice register on the design vertex are the load-bearing expression of identity that Product declared.
- **Engineering maintains coherence between Identity and Expression at runtime** — enforcement, quality gates, compliance, drift detection. Engineering's authority at any scope is to maintain what the other two pillars have declared. The compliance regimes, performance budgets, observability requirements, and substrate invariants on the engineering vertex are the load-bearing coherence-maintenance functions.

Engineering's offensive power in the PPA composite is gating, not amplifying — and that is correct. The market decides what is urgent (Product owns Demand Pressure, Market Force, Entropy Tax — dimensions that can amplify priority); Design and Engineering ensure the system only builds what it can build well (gating dimensions: ER₁–ER₆ on Engineering, ER₄ on Design via DesignSystemBinding readiness). The asymmetry replicates fractally: a shard-level Engineering authority maintains shard-level coherence, just as the platform-level Engineering authority maintains platform-level coherence.

This asymmetry is the formal structural answer to the question "why does the triad have three pillars in this specific configuration." Identity / Expression / Coherence is not a hierarchy of authority — all three pillars retain veto power through the multiplicative composite — but a hierarchy of what each pillar's authority is *over*. PPA v1.1 §5 ("Fractal Triad") and §9 ("Pillar Perspective Breakdown") formalize this asymmetry in the scoring model.

### 4.2 The three vertices per shard

For any Shard DID, the triad object specializes:

**Design vertex** — shard-specific design intent:
- Voice register specific to the shard's audience and domain
- Visual identity specialization (chrome tokens overrides, portrait style, surface aesthetic)
- Experiential invariants (ceremonies, narrative cadence, micro-interaction patterns)
- Brand and UX guidelines specific to this shard's audience
- Inherits from platform Design vertex (shared design tokens, structural design system axes, accessibility floor)

**Engineering vertex** — shard-specific engineering constraints:
- Compliance regime(s) specific to the shard's domain (e.g., HIPAA-adjacent, fiduciary, IP-isolation, patent-adjacent, voice-synthesis-legal)
- Data retention and isolation requirements per shard
- SLA tier appropriate to shard workload
- Performance budgets specific to shard workload shape
- Shard-specific observability and audit requirements
- Inherits from platform Engineering vertex (shared substrate invariants, tenancy model, agent-routing infrastructure)

**Product vertex** — shard-specific product direction:
- Target audience and persona for this shard
- Problem domain the shard addresses
- Success metrics for this shard's work
- Monetization model per shard
- Endgame phase mapping per platform's lifecycle model

---

## 5. Schema Amendments to `design-intent-document.schema.json`

All amendments are additive optional fields. The current `additionalProperties: false` constraint on `spec` requires explicit recognition of the new fields; no other validator changes required.

### 5.1 The `triad` object (proposed required everywhere; see §13 OQ-1)

```json
{
  "type": "object",
  "required": ["triad"],
  "properties": {
    "triad": {
      "type": "object",
      "required": ["design", "engineering", "product"],
      "properties": {
        "design": {
          "type": "object",
          "properties": {
            "inheritsFrom": { "type": "string", "description": "Path to parent DID's design vertex. Null for top-level Tessellated DID." },
            "imperatives": { "type": "array", "items": { "type": "string" } },
            "overrides": { "type": "object" }
          }
        },
        "engineering": {
          "type": "object",
          "properties": {
            "inheritsFrom": { "type": "string" },
            "complianceRegimes": {
              "type": "array",
              "items": { "type": "string" },
              "description": "Named regulatory or compliance constraints applied at this scope."
            },
            "performanceBudgets": { "type": "object" },
            "dataRetention": { "type": "object" },
            "slaTier": { "type": "string" },
            "substrateInvariants": { "type": "array", "items": { "type": "string" } }
          }
        },
        "product": {
          "type": "object",
          "properties": {
            "inheritsFrom": { "type": "string" },
            "targetAudience": { "type": "string" },
            "problemResonance": { "type": "string", "description": "Source-of-truth for Sα₁ scoring at this DID's scope." },
            "successMetrics": { "type": "array", "items": { "type": "string" } },
            "monetizationModel": { "type": "string" },
            "endgamePhase": { "type": "string" }
          }
        }
      }
    }
  }
}
```

### 5.1.1 DID ownership model (v3.2 strengthening — parallel to PPA v1.1 §4)

The triad object's vertices have categorically different content types and ownership is structurally split accordingly. This ownership model is normative: it determines who initiates, who approves, and what the default direction of drift is when the document evolves over time.

| Role | Authority | Rationale |
|------|-----------|-----------|
| Product Authority | Owner of `product.targetAudience`, `product.problemResonance`, `product.successMetrics`. Must approve all changes. | Product owns identity declaration. The `problemResonance` field feeds Sα₁ scoring at this DID's scope. |
| Design Authority | Owner of `design.imperatives`, `design.overrides`, and design-vertex specialization fields (voice register, visual identity, experiential invariants). Must approve all changes. | Design owns identity expression. The `design.imperatives` field feeds Sα₂ Vibe Coherence scoring. |
| Engineering Authority | Reviewer on all fields. Owns `engineering.complianceRegimes`, `engineering.substrateInvariants`, `engineering.performanceBudgets`. Can block any change only when a measurable signal is technically infeasible or violates substrate invariant. | Engineering owns coherence-maintenance between Identity and Expression at runtime. |

Both Product and Design retain veto power over the full DID through mutual approval requirements. Engineering can block only on technical infeasibility grounds, not on identity or expression preferences (those are Product and Design's authority respectively). The asymmetry — Product and Design have positive authoring authority while Engineering has guardrail-only authority — is the structural manifestation of the Identity / Expression / Coherence framing in §4.1.1.

Drift between DID versions over time defaults toward the owning pillar's perspective. A DID where Product fields have not been touched in 6 months but Design fields evolved monthly indicates Product's strategic intent has gone stale — surface this via `DesignIntentDrift` reconciliation event (parallel to RFC-0006's `TokenDriftDetected`). Quarterly DID review is a minimum floor, not the primary detection mechanism. Continuous semantic-drift monitoring is the actual mechanism.

### 5.2 The `tessellation` object (Tessellated DIDs only)

```json
{
  "tessellation": {
    "type": "object",
    "description": "Present only on Tessellated DIDs (platform roots). Enumerates child Shard DIDs and cross-shard governance.",
    "properties": {
      "shards": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["shardId", "didUri"],
          "properties": {
            "shardId": { "type": "string", "pattern": "^[a-z0-9-]+$" },
            "didUri": { "type": "string", "format": "uri-reference" },
            "status": { "enum": ["active", "deprecated", "draft"] },
            "inheritsSubstrate": { "type": "boolean", "default": true }
          }
        }
      },
      "crossShardScoringRule": {
        "enum": ["min", "weighted-traffic", "weighted-revenue", "max"],
        "default": "min"
      },
      "substrateInvariants": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Named invariants ALL shards must honor. Violations trigger cross-shard drift detection."
      }
    },
    "required": ["shards"]
  }
}
```

### 5.3 The `parentTessellation` field (Shard DIDs only)

```json
{
  "parentTessellation": {
    "type": "string",
    "description": "Present only on Shard DIDs. References the parent Tessellated DID's URI."
  }
}
```

### 5.4 Mutual exclusion

A DID has `tessellation` XOR `parentTessellation` XOR neither. The last is the RFC-0008 base case (single-product DID), fully unchanged. No DID has both.

---

## 6. Admission Composite Extension

RFC-0008 Addendum A §A.5 (Admission Scoring Function) and the live admission composite (`SA × D-pi_adjusted × ER × (1+HC)` per the orchestrator implementation) operate on a single DID. The extension preserves single-DID behavior and adds shard-aware scoring when tessellation is present:

```
For a work item w:

  resolveTargetShards(w) = set of Shard DIDs the work item affects, derived from
    work_item code-area mappings or explicit shard tags.

  If tessellation absent on the resolved DID:
    Behavior unchanged from RFC-0008. Single-DID semantics preserved.

  Else if |resolveTargetShards(w)| == 0:
    // Platform-scoped substrate work
    Sα(w) = min over all shards { Sα(w, shard) }                    // applied across each shard

  Else if |resolveTargetShards(w)| == 1:
    Sα(w) = Sα(w, targetShard)                                       // scored against shard's DSB

  Else:
    Sα(w) = crossShardScoringRule(w, affectedShards)                 // per Tessellated DID rule
```

The same shard-resolution applies to Eρ₄ (Design System Readiness, RFC-0008 §6) which reads against the targeted shard's DSB rather than the platform-aggregate DSB. Empirically: this is the change that lifts the Design pillar from platform-aggregate values toward shard-specific values for shard-bounded work.

---

## 7. New Sub-Dimensions

### 7.1 Eρ₅ Compliance Clearance (proposed)

A new sub-dimension under Eρ:

```
Eρ₅ = shard.triad.engineering.complianceRegimes[].clearance(work_item)
```

Fires zero (gating) when a work item targeting a shard would violate that shard's named compliance regime. Example: a work item that would leak data subject to a shard's privacy regime to a platform-wide analytics pipe receives Eρ₅ = 0, gating execution reality regardless of resource availability or build complexity.

### 7.2 Eτ_tessellation_drift (proposed)

A new sub-dimension under Eτ (Entropy Tax). Fires when a work item:

- Introduces shard-specific conditionals into shared substrate code (`if (shard === '<slug>')` patterns in shared modules)
- Violates a named `substrateInvariant` from the Tessellated DID
- Causes two Shard DIDs to converge (voice register drift, anti-goal overlap, success-metric overlap) without explicit merge decision recorded as a tessellation amendment
- Silently extends one Shard DID's domain into another's territory

Detection signals available without new infrastructure: AST analysis of shared substrate code for shard-name string literals, embedding distance between Shard DIDs over time, cross-shard provenance audits.

### 7.3 Eρ₆ Cost Clearance (proposed; v3.1 — interaction with RFC-0010)

A new sub-dimension under Eρ, parallel to §7.1 Eρ₅ Compliance Clearance. Introduced in v3.1 to honor RFC-0010's `tenantQuotaShare` semantics for tessellated platforms.

```
Eρ₆(w, s) = cost_clearance(w, s.tenantQuotaShare, current_period_burn)
            = 0 if w would exhaust s.tenantQuotaShare for current billing period
            = 1 otherwise
```

Where `s.tenantQuotaShare` is sourced from RFC-0010's `SubscriptionPlan.spec.tenants[<shard-slug>].quotaShare`. Product-pillar position: shards in a tessellated platform map to RFC-0010's `tenant` concept; the sum of all shards' `tenantQuotaShare` on a shared vendor account equals 1.0 (RFC-0010 §"TenantShareInvalid" event invariant).

A work item targeting a shard whose burn-down for the current billing period would be exceeded by this work receives Eρ₆ = 0, gating execution reality regardless of soul alignment, demand pressure, or compliance clearance. This composes with the four cross-shard scoring rules (§5) — substrate work scored under `min` rule against Eρ₆ honors every shard's cost ceiling.

Cost clearance is categorical (gating), not graduated, consistent with Eρ's existing semantics. Soft cost-pressure handling (work that *could* run but *should not* given budget burn rate) belongs in either Dπ₃ Bug Urgency (urgent + costly = different signal than urgent alone) or as a new HC channel — see §13 OQ-12 for the open question.

For single-product platforms, Eρ₆ = 1 always (no tenant share to exceed); for tessellated platforms without RFC-0010 SubscriptionPlan declared, Eρ₆ = 1 always (no tenantQuotaShare data); both degenerate cases preserve v3.0 scoring behavior.

**v3.2 acknowledgment of PPA v1.1 C8 wiring:** PPA v1.1 §7 introduces **C8 Cost Governance Integration** as the eighth triad-edge connection, formally wiring `SubscriptionPlan.spec.tenants[<shard-slug>].quotaShare` (RFC-0010) → ER6 Cost Clearance (PPA v1.1 §3) → §7.3 Eρ₆ (this RFC). C8 is the operational channel that makes §7.3 implementable; without C8, §7.3 has no source of `tenantQuotaShare` data. C8's implementation sequence (PPA v1.1 §7 Phase 3, weeks 9+) coincides with RFC-0010's cost governance adoption. Adopters implementing tessellation without RFC-0010 cost governance can adopt §7.3 as a no-op (Eρ₆ = 1.0 always); adopters implementing both get gating cost-clearance as a structural property of execution reality.

---

## 8. Resource Type Extensions

Each existing RFC-0008 resource type gains an optional shard-scoping field. All optional; absence preserves single-DID behavior.

### 8.1 AgentRole

```yaml
spec:
  scope: platform | shard | tenant       # default: platform
  shardBindings:                          # array of Shard DID URIs
    - <shard-did-uri-1>
    - <shard-did-uri-2>
```

`scope: platform` agents operate across all shards (substrate-scoped roles). `scope: shard` agents are bound to specific Shard DIDs (shard-specific specialists). `scope: tenant` agents are bound to tenant boundaries (orthogonal to shard scoping).

### 8.2 AdapterBinding

```yaml
spec:
  shardOverrides:
    - shard: <shard-did-uri>
      config:
        # Shard-specific adapter config (e.g., per-shard issue tracker
        # channel, per-shard customer-signal source)
```

Allows the same AdapterBinding to read from different concrete sources per shard. Necessary when, e.g., the issue tracker hosts shard-distinct customer-signal channels.

### 8.3 ProvenanceRecord

```yaml
targetedShards:
  - <shard-did-uri>
substrateScoped: false
```

Every provenance record captures which shard(s) the work served. Closes the per-shard Cκ calibration loop: outcomes can be attributed to the correct shard's calibration cells.

### 8.4 QualityGate

```yaml
shardScope: <shard-did-uri>          # optional; absent = platform-scoped
```

Allows per-shard quality criteria (e.g., a shard whose voice register is load-bearing can ship a "voice coherence" gate that applies only to that shard's outputs).

### 8.5 SubscriptionPlan (RFC-0010; v3.1 interaction)

RFC-0010 introduces `SubscriptionPlan` (vendor billing model declaration). Tessellated platforms extend it with a `tenants` map keyed by shard slug, with each shard's `quotaShare` summing to 1.0 across the account:

```yaml
# subscription-plans/<vendor>.yaml
spec:
  tenants:
    <shard-slug-A>:
      quotaShare: 0.45
      pipelineRef: pipelines/<shard-A>.yaml
    <shard-slug-B>:
      quotaShare: 0.35
      pipelineRef: pipelines/<shard-B>.yaml
    <shard-slug-C>:
      quotaShare: 0.20
      pipelineRef: pipelines/<shard-C>.yaml
```

Product-pillar position: SubscriptionPlan is **platform-scoped** (one per vendor account); the `tenants` map is the tessellation surface. Sum-to-1.0 invariant is enforced by RFC-0010's `TenantShareInvalid` Critical event. This is the source of truth for §7.3 Eρ₆ Cost Clearance scoring.

### 8.6 WorktreePool (RFC-0010; v3.1 interaction)

RFC-0010's `WorktreePool` manages parallel agent worktrees. **Default platform-scoped** — worktrees are git-level shared substrate; no tessellation per shard required. A tessellated platform may optionally declare per-shard pools if shard-distinct branch-naming or pool-root isolation is required:

```yaml
# worktree-pool.yaml (default — platform-shared, recommended)
spec:
  parallelism:
    maxConcurrent: 4
  poolRoot: .worktrees/

# worktree-pool-<shard>.yaml (optional — only if per-shard isolation needed)
spec:
  shardScope: <shard-did-uri>
  parallelism:
    maxConcurrent: 2
  poolRoot: .worktrees/<shard-slug>/
```

Product-pillar position: per-shard worktree pools are **opt-in escape valve**, not default. Most tessellated platforms benefit from a single shared pool; per-shard pools serve unusual cases (compliance regimes requiring physical worktree isolation, e.g., one shard's substrate access must not commingle).

### 8.7 DatabaseBranchPool (RFC-0010; v3.1 interaction)

RFC-0010's `DatabaseBranchPool` provides per-branch DB isolation for parallel pipelines with `databaseAccess: write/migrate`. Tessellation policy depends on the platform's tenant model — see OQ-11 below for the genuinely open question.

```yaml
# database-branch-pools/<adapter>.yaml
spec:
  shardScope: <shard-did-uri>          # optional; absent = platform-shared pool
  adapter: supabase | neon | rds
  upstream: <project-ref>
  lifecycle:
    branchTtl: 24h
  migrations:
    command: <migration-runner>
```

Two patterns supported, both backwards-compatible:

| Pattern | Tessellation | When |
|---|---|---|
| Shared pool, RLS isolation | `shardScope` absent | Shards are RLS-isolated within one DB project (default for early-stage tessellated platforms) |
| Per-shard pool | `shardScope` present | Shards are physically separate DB projects (mature tessellated platforms with strict tenant isolation requirements) |

Product-pillar position: the **shared pool with RLS isolation** is the default; **per-shard pools opt-in** when audit/compliance/cost-attribution requirements demand physical separation. See OQ-11 for the boundary condition.

### 8.8 Operator role scope (RFC-0010; v3.1 interaction)

RFC-0010 defines a fourth pillar role: **Operator** (config + cost posture + calibration + event triage; explicitly NOT engineer/reviewer/PM/SRE/maintainer). Product-pillar position on tessellation:

**The Operator role is platform-scoped, NOT tessellated.** One operator per platform, judging the *pipeline* not the *product soul*. Shards inherit operator decisions (subscription posture, calibration drift policy, event triage rules). Shard DIDs do NOT carry an operator vertex on their fractal triad.

Justification: the four pillars in v3 (`design`, `engineering`, `product`) describe the **product soul** of a shard — what the shard is, who it serves, how it speaks. Operator describes the **pipeline operation** — burn rate, harness availability, calibration drift. Pipeline operation is a property of the platform, not of any individual shard.

Implication for v3 §4 (Fractal Triad): triad remains `{ design, engineering, product }`; Operator is acknowledged as a **platform-only role** that operates on the pipeline running across all shards. Where RFC-0008 §A.8 defined design-authority signal monitoring per Shard DID, Operator decisions (e.g., "raise this shard's hardCap" or "extend off-peak window for this shard") are made at the platform-pipeline level by referencing shard slugs in the pipeline.yaml, not by adding fields to the Shard DID itself.

For tessellated platforms, the Operator role typically aligns with the **Engineering Authority of the platform** (cost posture + calibration are engineering concerns), with Product Authority consulted on cross-shard tradeoffs (e.g., "should we shift quotaShare from Shard-A to Shard-B given the burn-rate trends?"). This is the pattern observed in the reference implementation (Appendix A): Engineering Authority and Operator role collapse to the same person.

---

## 9. Migration Path

Fully backwards-compatible. Single-product RFC-0008 adopters require zero changes; their DIDs continue to validate and admit composite scores compute identically.

Migration to tessellated governance is opt-in and incremental:

1. Author a Tessellated DID at the platform level (or extend the existing platform DID with a `tessellation` field and the `triad` object).
2. Author Shard DIDs for each soul-distinct product face. Source material may be copied or referenced from existing scattered docs; schema validates either approach.
3. Extend AgentRole, AdapterBinding, ProvenanceRecord, and QualityGate manifests with shard-scoping where relevant.
4. Optionally run both single-DID and tessellated scoring in parallel for one sprint cycle; compare results; switch over when confident.

Migration is reversible at any step. A platform that authors Shard DIDs but later decides single-DID was sufficient can remove the `tessellation` field from the platform DID without removing the `triad` object.

---

## 10. Implementation Sequencing

### Phase 1 — Schema PR (Week 1)

- Add `triad`, `tessellation`, `parentTessellation` field definitions to `design-intent-document.schema.json`
- Widen `additionalProperties` posture on `spec` to admit the new fields
- Existing fixtures continue to validate; new fixtures with tessellation fields validate
- Mixed-fixture compatibility test: Tessellated DID with Shard DIDs that omit optional fields validate
- Reference implementation provides four production fixtures (one Tessellated DID + three Shard DIDs) for the framework's test suite

### Phase 2 — Admission Composite + Reader Extensions (Week 2)

- Admission composite recognizes `tessellation` and routes Sα + Eρ₄ resolution through shard scope
- Per-shard DSB authoring becomes possible (one DSB per Shard DID at `.ai-sdlc/shards/<slug>/design-system-binding.yaml`)
- Reference implementation produces before/after admit invocations demonstrating the Design pillar lift on shard-bounded work
- Cκ calibration aggregates per-shard, per-dimension (N shards × M dimensions cells)

### Phase 3 — Sub-Structure Resource Extensions (Week 3)

- AgentRole, AdapterBinding, ProvenanceRecord, QualityGate gain shard-scoping fields
- Variant + journey patterns recognized as in-shard sub-structures (proposed as separate optional sub-RFC; see §13 OQ-7)

### Phase 4 — Sub-Dimensions Activation (Week 4+)

- Eρ₅ Compliance Clearance activates when shards declare `complianceRegimes`
- Eτ_tessellation_drift activates with the substrate-conditional detection rules
- Both gated on adopter opt-in initially; promotion to default behavior subject to ecosystem feedback

---

## 11. Worked Example

### 11.1 Setup — generic three-shard platform

Platform name: Platform-X. Three soul-distinct shards: Shard-A (audience: alpha cohort, compliance: alpha-regime), Shard-B (audience: beta cohort, compliance: beta-regime), Shard-C (audience: gamma cohort, compliance: gamma-regime). All three share the same engineering substrate (event bus, shared knowledge graph, common identity service).

### 11.2 Tessellated DID for Platform-X

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignIntentDocument
metadata:
  name: platform-x
spec:
  did: did:platform-x:platform
  triad:
    design:
      imperatives: ["accessibility-floor: WCAG-AA", "shared-design-tokens-v3"]
    engineering:
      substrateInvariants: ["event-bus-v2", "shared-graph-schema-152", "tenant-isolation-rls"]
      complianceRegimes: []  # Platform-level baseline; shards add their own
    product:
      targetAudience: "Platform serving multiple distinct audiences via Shard DIDs"
      successMetrics: ["per-shard success metrics aggregate; no platform-level metric"]
  tessellation:
    shards:
      - shardId: shard-a
        didUri: did:platform-x:shard:shard-a
        status: active
      - shardId: shard-b
        didUri: did:platform-x:shard:shard-b
        status: active
      - shardId: shard-c
        didUri: did:platform-x:shard:shard-c
        status: active
    crossShardScoringRule: min
    substrateInvariants: ["no-shard-conditionals-in-substrate", "tenant-rls-required"]
```

### 11.3 Shard DID for Shard-A

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignIntentDocument
metadata:
  name: shard-a
spec:
  did: did:platform-x:shard:shard-a
  parentTessellation: did:platform-x:platform
  triad:
    design:
      inheritsFrom: did:platform-x:platform/triad/design
      imperatives: ["voice-register: alpha-specific", "visual-identity: alpha-aesthetic"]
    engineering:
      inheritsFrom: did:platform-x:platform/triad/engineering
      complianceRegimes: ["alpha-regime"]
    product:
      inheritsFrom: did:platform-x:platform/triad/product
      targetAudience: "alpha cohort"
      problemResonance: "alpha-cohort problem statement (source-of-truth for Sα₁)"
      successMetrics: ["alpha-specific success metric 1", "alpha-specific success metric 2"]
```

### 11.4 Admission for a single-shard work item

A work item targeting only Shard-A:

```
Targeted shard: did:platform-x:shard:shard-a
Sα(w) = Sα(w, shard-a)              // scored against Shard-A's DSB, not platform-aggregate
Eρ₄ = readiness(shard-a's DSB)      // shard-specific Design System Readiness
Eρ₅ = clearance(alpha-regime)       // shard-specific Compliance Clearance
```

If Shard-A's DSB has lifecycle `established` and pattern coverage 0.85, Eρ₄ scores 0.80. The platform-aggregate DSB at lifecycle `stabilizing` and coverage 0.40 would score 0.40. The shard-bounded work correctly receives the higher pillar value.

### 11.5 Admission for substrate work

A work item targeting platform substrate (no specific shard):

```
Targeted shards: []
Sα(w) = min(Sα(w, shard-a), Sα(w, shard-b), Sα(w, shard-c))
```

The minimum-over-shards rule forces substrate work to honor every shard's soul. If Shard-A's product vertex would score 0.4 while Shard-B and Shard-C would score 0.9, the substrate work scores 0.4 — surfacing that the work compromises Shard-A's distinct soul even if it serves the others well.

---

## 12. Security and Authority Considerations

### 12.1 Cross-shard data isolation

Shard DIDs MUST NOT grant implicit read access across tessellation boundaries. A tenant authorized to one shard's data is not implicitly authorized to another shard's data, even on the same Tessellated DID. Existing RFC-0008 tenant-RLS patterns apply unchanged at the shard boundary.

### 12.2 Shard authority

The shard authority pattern (analogous to RFC-0008 §A.8 Design Authority Signal Monitoring) extends per-shard. A shard's design authority signals into HC_design for that shard's work scope, not platform-wide. Implementations choose whether to allow authority cascade (platform authority → shard authority by default) or require explicit shard-authority designation.

### 12.3 Compliance regime conflicts

When a substrate work item targets multiple shards with conflicting compliance regimes (e.g., one shard's `must-log-all-access` vs another's `must-not-log-personal-content`), the cross-shard scoring rule applied to Eρ₅ produces 0 (gating). The work item cannot proceed without a tessellation amendment explicitly resolving the conflict.

---

## 13. Open Questions

The following require resolution before Phase 1 schema PR opens. Each carries the implementation's preferred position and the reasoning to motivate review.

Open Questions are framed in two categories: **Position-stated** (the implementation takes a strong product-pillar stand and asks reviewers to confirm or counter with concrete reasoning) and **Genuinely open** (mechanism is fixed but a surface-level choice — naming, sequencing — remains).

### OQ-1 (Position-stated): The `triad` object is required everywhere

**Position**: Required on every DID, including single-product DIDs. **Reasoning**: RFC-0008 §3 establishes the three-pillar architecture (Engineering × Design × Product) as foundational. Making `triad` optional erodes that foundational claim — adopters who omit `triad` operate without the architecture RFC-0008 requires, and the pillar-perspective breakdown (RFC-0008 Amendment 6) becomes unspecified for them. The product-pillar position is that the triad is the framework's structural commitment, not a feature toggle. **Counter-position to defend if rejected**: `triad` is optional initially; single-product DIDs continue without; required-everywhere migration becomes a v1.x bump. Reviewer needs to articulate why erosion of foundational architecture is acceptable.

### OQ-2 (Position-stated): Default `crossShardScoringRule` is `min`

**Position**: `min`. **Reasoning**: PPA v1.0 §3 establishes that the composite is multiplicative because every dimension is a necessary condition. By the same logic, when substrate work affects multiple shards, every affected shard's soul is a necessary condition — the work cannot be more aligned than its weakest-aligned shard. `min` enforces this. `weighted-traffic` and `weighted-revenue` are post-calibration optimizations; `max` produces incorrect product-pillar behavior (substrate work that breaks one shard while serving others scores high). Other rules supported as opt-in escape valves; `min` is the default the framework should ship.

### OQ-3 (Position-stated): Variant and journey patterns belong in RFC-0009 main

**Position**: Variant pattern and journey pattern are first-class in-shard sub-structures and ship in RFC-0009 main, not as follow-on RFCs. **Reasoning**: separating them gives reviewers an excuse to under-think the in-shard nesting. The complete pattern (sub-theme < journey < variant < shard) is the framework's structural claim about how multi-soul platforms organize internally. Splitting it across RFCs invites partial adoption that loses the pattern's coherence. The fractal triad is the architecture; sub-themes, journeys, variants are how it nests within shards. All belong in the same RFC.

### OQ-4 (Genuinely open): Naming — "Tessellated" / "Shard" vs alternatives

The implementation has used "Tessellated" and "Shard" internally; the mechanism (parent DID composed of N child DIDs sharing substrate, each soul-complete) is fixed regardless of naming. Alternatives offered for review: faceted/facet, multi-domain/domain, multi-product/product, multi-soul/soul, federated/federation. Whatever the framework prefers; implementation will adopt without resistance. **The vocabulary surface is the only genuinely open question; the structural commitment is product-pillar fixed.**

### OQ-5 (Position-stated): Eρ₅ Compliance Clearance is gating, not weighted

**Position**: Eρ₅ = 0 when a violation is detected. **Reasoning**: PPA v1.0 §3 establishes that Eρ is a pure gating function ("can only reduce priority, never increase it"; "the minimum of resource availability, inverse build complexity, and dependency clearance ensures the tightest constraint wins"). Compliance violations are categorical — a work item either satisfies a regulatory regime or it doesn't. Graduated severity tiers fit Dπ₃ Bug Urgency or other demand signals, but Eρ's existing semantics are gating. Adding compliance clearance as a gating sub-dimension preserves PPA's mathematical structure.

### OQ-6 (Position-stated): Eτ_tessellation_drift detection is orchestrator-side

**Position**: Orchestrator-side detection rules (AST scan for shard-name string literals in shared substrate, embedding distance between Shard DIDs over time, cross-shard provenance audits). **Reasoning**: adapter-side detection puts the burden on every adapter author to instrument drift signals consistently. The framework cannot guarantee detection coverage if it depends on N adapter implementations correctly tagging shard-affecting work. Orchestrator-side is the only path to framework-wide consistency. Adapter-side detection can supplement (adapters can volunteer additional drift signals) but cannot be the primary detection layer.

### OQ-7 (Position-stated): §13.5 folds into RFC-0009 main as Addendum A; §13.6 ships as RFC-0009.2

**Position**: §13.5 (session-bug + severity scoring rule) is a Dπ₃ refinement with practitioner validation (caught a real P1→P0 mis-prioritization in a live backlog scoring pass). It belongs in RFC-0009 main as Addendum A (parallel to RFC-0008's Addendum A pattern). §13.6 (incident monitoring + root-cause analysis) requires post-pilot adopter incident volume to validate; ship as RFC-0009.2 follow-on, deferred until that data exists. **Reasoning**: §13.5 has the same evidence quality as the main RFC; §13.6 is correctly speculative until live load arrives.

### OQ-8 (Practitioner observation, separate framework issue): HC composite stewardship.designAuthority → HC_design wiring

When an adopter's DSB carries `stewardship.designAuthority.principals: [name]`, the orchestrator's `pillarBreakdown.shared.hcComposite.design` value did not populate. May be: (a) an orchestrator wiring gap in `enrichAdmissionInput`, (b) an unspecified explicit signal channel requirement, or (c) intentional behavior misunderstood by the adopter. Resolution affects how shard-level design authority signals into HC for shard-bounded work. **Track as a separate framework issue; not gating for RFC-0009.**

### OQ-9 (Practitioner observation, separate framework issue): admit confidence ceiling at 0.5 with all readers loaded

With DID + DSB + maintainers + soul-tracks all loaded, admit confidence stayed at 0.5 (expected ≥0.7 given enrichment richness). Suggests confidence is computed from `PriorityInput` field defaults rather than enrichment success. **Track as a separate framework issue; not gating for RFC-0009.**

### OQ-10 (v3.1; Position-stated): Operator role is platform-scoped, NOT tessellated per shard

Product-pillar position: RFC-0010's Operator role describes pipeline operation (burn rate, harness availability, calibration drift, event triage) which is a property of the platform-level pipeline, not of any individual shard. The fractal triad in §4 stays `{ design, engineering, product }`; Operator is acknowledged as a fourth pillar role that operates at platform scope. Counter-position: shards with radically different operational profiles (e.g., one shard high-volume cheap-stage; another shard low-volume expensive-stage) might warrant per-shard operator overrides. Position-stated rationale: in practice, even radically-different operational profiles are tuned via SubscriptionPlan `tenantQuotaShare` and per-shard `costBudget` declarations rather than by separate operator humans. See §8.8.

### OQ-11 (v3.1; Genuinely open): DatabaseBranchPool tessellation policy default

When should `DatabaseBranchPool` carry `shardScope`? Two patterns are both valid: (a) shared pool with RLS isolation (default for early-stage tessellated platforms), (b) per-shard pool with physical isolation (mature platforms with strict tenant audit/compliance/cost-attribution requirements). The boundary condition — at what platform maturity does (b) become required, not optional — is genuinely open. Engineering pillar (Dom-as-Operator) is the right authority on this; product-pillar has no firm position. See §8.7.

### OQ-12 (v3.1; Genuinely open): Where does soft cost-pressure feed into the composite?

§7.3 Eρ₆ Cost Clearance is **gating** (categorical 0/1) — work that would exhaust `tenantQuotaShare` is denied. But what about **soft** cost pressure — work that *could* run but *should not* given burn-rate trends? Three candidates: (a) extend Dπ₃ Bug Urgency semantics to include cost-urgency (urgent + costly → different signal than urgent alone), (b) add a new HC channel `HC_cost` that the operator can ratchet to defer expensive work without changing soul/demand scoring, (c) accept that soft cost-pressure is purely operator-managed via `cli-tier-recommendation` + `costBudget` adjustments and doesn't enter the composite at all. Genuinely open; product-pillar has no preference. Engineering authority + Operator (Dom) decides.

### OQ-13 (v3.2; Resolved against title rename): Taxonomy — "multi-soul" + "soul sharding" coexist

**Initial concern (v3.1):** the framing "soul sharding" arguably more accurately describes the pattern than "multi-soul platform." A tessellated platform is not N independent souls; it is one platform soul that shards into N coherent faces, each retaining the parent platform's substrate inheritance while specializing for a distinct audience.

**Resolution (v3.2; PPA v1.1 §12 resolved-against-rename):** product pillar landed on **"multi-soul scoring"** terminology in PPA v1.1 (title + body). The alternate framing **"soul sharding"** survives as accurate vocabulary for the *pattern itself* (mechanism — how it works), complementing **"multi-soul platform"** which describes the *architectural shape* (output — what it produces). Both labels describe the same phenomenon at different abstraction levels and may be used interchangeably depending on emphasis: explain mechanism with "soul sharding"; describe architecture with "multi-soul platform."

The mechanism is fixed; both naming surfaces are accepted. No title rename in v3.2 or PPA v1.1. Future revisions may converge on a single label after broader adopter feedback; until then, both are canonical. Adopters preferring different terminology entirely (faceted/facet, federated/federation, multi-domain/domain) may substitute; the mechanism is what matters.

---

## 14. References

- **PPA v1.0**: Product Priority Algorithm (Alexander Kline, March 2026). The seven-dimension composite formula, per-dimension definitions, and §8 Open Questions including the "Multi-Product Portfolio" question this RFC closes.
- **PPA v1.1**: Product Priority Algorithm — Triad Integration + Tessellation (Alexander Kline, April 2026). Generalizes PPA v1.0 to shard-indexed scoring P(w, s); §3 ER6 Cost Clearance; §4 Design Intent Document ownership model; §5 Tessellated Platforms Multi-Soul Scoring; §7 C8 Cost Governance Integration; §8 HC_product per shard; §9 Pillar Perspective Breakdown with Identity / Expression / Coherence framing; §11 shard-scoped CK; §12 resolved Multi-Product Portfolio question. This RFC is the framework-substrate companion to PPA v1.1's product-pillar architecture.
- **RFC-0005**: Product Priority Algorithm (Alexander Kline, AI-SDLC Contributors). The framework's PPA spec embedding PPA v1.0 as `Pipeline.spec.priorityPolicy`. Lists "Multi-product portfolio-level resource allocation" as a Non-Goal / future work; this RFC is that future work.
- **RFC-0008**: PPA Triad Integration. The DID resource, three-pillar architecture, admission composite, design system binding. §17 PPA v1.1 Direction is the pattern §16 below mirrors.
- **RFC-0010**: Parallel Execution + Worktree Pooling (Dom Legault, April 2026). The cost governance substrate (`SubscriptionPlan`, `WorktreePool`, `DatabaseBranchPool`, `tenantQuotaShare`) that §7.3 Eρ₆ + PPA v1.1 §7 C8 wire into. Operator role specification (operator runbook).
- **RFC-0006**: Design System Governance. The DSB resource's broader governance context.
- **RFC-0001**: Template. Format conventions followed by this RFC.

---

## 16. PPA v1.1 Direction

> **Pattern mirrored from RFC-0008 §17.** This RFC's interim solution embeds in RFC-0008's DID schema what PPA v1.0's architecture cannot express without modification. These are queued for PPA v1.1. They are documented here rather than in PPA v1.0 directly because this RFC is the source of the requirement. When PPA v1.1 is authored, this section is the requirements input.

### v1.1-6: Per-Shard Sα Vector

PPA v1.0 §3 defines Sα as a scalar function `Sα(w)` computed against a single soul purpose definition document. This RFC's interim solution embeds shard-aware Sα in the admission composite (§6) using cross-shard scoring rules on Tessellated DIDs. The architecturally-correct long-term shape is Sα as a vector indexed by shard:

```
Sα(w) → Sα(w, shard_did)
```

with cross-shard aggregation rules (min, weighted-traffic, weighted-revenue, max) declared on the Tessellated DID's `crossShardScoringRule` field becoming PPA v1.1 first-class scoring policy, not a per-RFC schema field.

**Interim (this RFC):** Shard-aware Sα handled at admission composite via cross-shard scoring rules in tessellation manifest. Sufficient for v1.

**v1.1 work:** Define Sα as a `Map<ShardDid, ScalarScore>` type. Per-shard scoring is the canonical form; scalar `Sα(w)` becomes the single-shard degenerate case. Cross-shard aggregation rules become standard PPA primitives, not RFC-0009 schema.

### v1.1-7: Per-Shard Cκ Tensor

PPA v1.0 §7 defines Cκ as a single scalar calibration coefficient bounded [0.7, 1.3]. RFC-0008 §17 v1.1-2 already proposes per-dimension Cκ. This RFC requires Cκ to additionally be per-shard: each shard's calibration history evolves independently because outcomes can be attributed per-shard via tessellated provenance records (§8.3).

The architecturally-correct long-term shape is Cκ as a tensor indexed by `(shard_did, dimension)`:

```
Cκ → Cκ[shard_did][dimension]
```

For an N-shard, M-dimension PPA, the calibration tensor has N×M cells. Each cell evolves independently, bounded [0.7, 1.3] per cell.

**Interim (this RFC):** Per-shard Cκ aggregation handled in calibration service via tessellation-aware aggregation. Cell count is N×M when tessellation is present; falls back to RFC-0008 §17 v1.1-2's per-dimension scalar when tessellation is absent.

**v1.1 work:** Define Cκ as a `Map<(ShardDid, Dimension), CalibrationCoefficient>` type. Per-shard-per-dimension is the canonical form; the v1.0 scalar and v1.1-2 per-dimension cases become degenerate forms.

### v1.1-8 (forward note): HC_product Channel Per Shard

RFC-0008 §A.8 formalizes Design Authority Signal Monitoring as the channel feeding HC_design. The product-pillar parallel — Product Authority Signal Monitoring per shard — is not yet specified in any RFC. PPA v1.1 should define it: each shard's product authority (the human or team accountable for that shard's product direction) signals into HC_product per shard, parallel to how design authority signals into HC_design.

**Interim (this RFC):** Product authority signals enter the existing HC composite without per-shard differentiation.

**v1.1 work:** Define Product Authority Signal Monitoring per shard. Each Shard DID's `triad.product` may declare a `productAuthority.principals` list; signals from those principals route to HC_product for that shard's work scope.

---

## 15. Appendix A: Reference Implementation — Empirical Proof-by-Existence

This RFC was authored after observing the framework's current shape fail under multi-soul load on a real production multi-product platform. The Appendix documents that observation as empirical proof-by-existence; it is not the proposal's justification. The proposal stands on its own merits per §1-§13 and §16; the Reference Implementation provides additional empirical evidence for review confidence.

A live multi-product platform implementation has authored a Tessellated DID + four Shard DIDs against the patterns proposed in this RFC. The implementation predates the framework's schema acceptance of these fields; all material currently lives at the architecture layer (not in `.ai-sdlc/` config) because the existing `design-intent-document.schema.json` `additionalProperties: false` constraint rejects `tessellation` / `parentTessellation` / `triad` fields. The implementation has authored ~60 backlog items with shard-scoped work and runs the orchestrator's admit pipeline against the live config.

**Empirical observation**: Design pillar locked at 0.40 across all single-shard work. The framework is technically correct given the current schema (one platform-aggregate DSB describing the worst-case shard's coverage); the abstraction is incorrect for the input (single-shard work being scored against platform-aggregate DSB). The implementation's prediction, testable in approximately 5 minutes of admit re-invocation once Phase 1 schema PR lands and per-shard DSBs become authorable: Design pillar lifts from 0.40 → 0.7+ for shard-bounded work. The 0.30-0.30+ delta per-task is the validation evidence.

The implementation's fractal-triad ownership surfaced two practitioner observations relevant to OQ-8 and OQ-9; both are framework issues separable from RFC-0009 acceptance.

The implementation team commits to:
1. Land per-shard DSBs in `.ai-sdlc/shards/<slug>/design-system-binding.yaml` immediately after Phase 1 schema PR merges
2. Re-run admit invocations against TASK-175 + TASK-176 (single-shard work items) and publish before/after Design pillar values as validation evidence
3. Run Phase 4 (Cκ flywheel) for one sprint cycle and publish per-shard, per-dimension calibration data

**The reference implementation does not require special framework consideration; it asks the framework to recognize the structural distinction the implementation has empirically validated.** Multi-product platforms with shared substrate are common (Stripe, Notion, Figma, Shopify cited in §2.2). The implementation's value to the framework is empirical confidence that the proposal works as designed at scale on a real codebase, not a request for accommodation.

---

*v3 authored 2026-04-26 with strengthened product-pillar voice. PPA v1.0 §8 Multi-Product Portfolio open question explicitly closed. RFC-0005 Multi-product portfolio-level resource allocation non-goal addressed. RFC-0008 §17 PPA v1.1 Direction extended with v1.1-6, v1.1-7, v1.1-8 (forward note). Open questions where implementation has a strong product position state that position with reasoning; pure-naming questions remain open. Reference Implementation reframed as empirical proof-by-existence. Awaits Engineering + Design pillar review.*
