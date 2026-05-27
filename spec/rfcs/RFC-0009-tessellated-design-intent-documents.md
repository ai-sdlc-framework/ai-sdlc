---
id: RFC-0009
title: Tessellated Design Intent Documents for Multi-Soul Platforms
status: Draft
lifecycle: Implemented
author: Alexander Kline
created: 2026-04-24
updated: 2026-05-27
targetSpecVersion: v1alpha1
requiresDocs: []
implementedBy:
  - AISDLC-312 (Phase 1 — DID schema amendments + init scaffolding)
  - AISDLC-313 (Phase 2.1 — Admission composite tessellation routing)
  - AISDLC-314 (Phase 2.2 — Per-soul DSB + Cκ calibration)
  - AISDLC-315 (Phase 3 — Resource soul-scoping)
  - AISDLC-316 (Phase 4.1 — Eρ₅ Compliance Clearance)
  - AISDLC-317 (Phase 4.2 — Eτ_tessellation_drift rules)
  - AISDLC-318 (Phase 4.3 — HC_cost channel)
  - AISDLC-319 (Phase 4.4 — DatabaseBranchPool + Operator role wiring)
---

<!-- ai-sdlc:lifecycle-jump-approved-by:deefactorial reason:All 13 OQs resolved in v3.4 (2026-05-04). All 3 owners signed v3.4 (Dominique Engineering+Operator, Morgan Design w/ documented C1-C3 follow-on commitments, Alex Product). All 8 implementation phases shipped (AISDLC-312/313/314/315/316/317/318/319 — see implementedBy). Lifecycle ladder skip (Ready for Review → Implemented) authorized because: (a) all required sign-offs already present in §Sign-Off table, (b) Design conditions C1-C3 explicitly recorded as "follow-on commitments, not a blocker on RFC-0009", (c) implementation is fully shipped and merged. The intermediate "Signed Off" step is procedurally redundant given the sign-off table state pre-dates this lifecycle bump. -->


# RFC-0009: Tessellated Design Intent Documents for Multi-Soul Platforms

**Document type:** Normative (draft)
**Status:** Ready for Review v3.4 — Operator walkthrough resolved the remaining 7 of 13 open questions (OQ-6 through OQ-12); all 13 OQs now resolved (OQ-1-5 + OQ-13 in v3.3; OQ-6-12 in v3.4). §13.5 (session-bug + severity scoring rule) and §13.6 (incident monitoring + root-cause analysis) carved out to RFC-0020 (Draft) and RFC-0021 (Reserved) respectively per OQ-7 reversal of Position-stated. Eτ_tessellation_drift detection is orchestrator-side (OQ-6) — rule #1 (AST scan) ships in RFC-0009 implementation phase; rule #2 (embedding distance) deferred to RFC-0019 implementation; rule #3 (cross-soul provenance) deferred to RFC-0009 implementation phase. OQ-8 + OQ-9 filed as standalone framework bugs AISDLC-171 + AISDLC-172. OQ-10 affirmed: Operator role is platform-scoped, not tessellated. OQ-11: shared+RLS pool default with explicit per-shard trigger checklist (regulatory hard requirement, customer contract, operator security review) cross-referencing RFC-0022 (Compliance Posture + Audit Surface). OQ-12: new `HC_cost` channel (operator-tunable, default 1.0) gated on RFC-0016 calibration data quality for accurate per-task cost prediction. Lifecycle: Ready for Review (Engineering + Design + Product all signed 2026-05-04).
**Created:** 2026-04-24
**Revised:** 2026-05-04
**Authors:** Alexander Kline (Product Authority, author of PPA v1.0 + RFC-0005)
**Reviewers:** [Engineering Authority — ✅ Signed v3.4 (Dominique, 2026-05-04)], [Design Authority — ✅ Signed v3.4 with conditions (Morgan, 2026-05-04)], [Product Authority — ✅ Signed v3.4 (Alexander, 2026-05-04)]
**Spec version:** v1alpha1
**Requires:** RFC-0005 (Product Priority Algorithm), RFC-0008 (PPA Triad Integration), PPA v1.0
**Closes:** PPA v1.0 §8 "Multi-Product Portfolio" open question; RFC-0005 "Multi-product portfolio-level resource allocation" non-goal; RFC-0008 §17 v1.1 Direction (extends with v1.1-6 + v1.1-7)

---

## Sign-Off

| Person | Role | Status | Date |
|--------|------|--------|------|
| Dominique Legault | CTO / Engineering Authority + AI-SDLC Operator | ✅ Lifecycle → Implemented confirmation v3.5 (all 8 phases shipped per implementedBy frontmatter; Design C1-C3 conditions remain follow-on commitments not blockers) | 2026-05-27 |
| Dominique Legault | CTO / Engineering Authority + AI-SDLC Operator | ✅ Signed v3.4 (Engineering + Operator) | 2026-05-04 |
| Morgan Hirtle | Chief of Design / Design Authority | ✅ Signed v3.4 with conditions | 2026-05-04 |
| Alexander Kline | Head of Product Strategy / Product Authority | ✅ Signed v3.4 (authored v3.2 + PPA v1.0/v1.1) | 2026-05-04 |

### Design Authority Sign-Off Conditions

Signed with the following conditions recorded for resolution before `lifecycle: Implemented`:

**C1 — §4.1.1 Identity framing:** "Design expresses identity" should read "Design co-declares and expresses identity." Design authority is not downstream of Product's identity declaration; user research and experience definition are co-authorship functions. Propose amendment to §4.1.1 before spec update lands.

**C2 — §5.1.1 Ownership model:** Design Authority requires co-review rights on `product.targetAudience` and `product.problemResonance`. Sα₁ scoring is grounded in audience definition and problem resonance validation — both are UX research functions. Co-review is not veto; it is recognition that these fields cannot be validly authored without design input.

**C3 — Design vertex underspecification:** The design vertex carries 2 unstructured fields against Engineering's 6 and Product's 5. Design Authority commits to authoring design vertex schema enrichment (accessibility floor, component catalog reference, design token version, voice register structure, interaction principles) as RFC-0027 (reserved below). This is a follow-on commitment, not a blocker on RFC-0009.

---

## Revision History

| Version | Date | Summary |
|---------|------|---------|
| v1 | 2026-04-24 | Initial proposal. Introduces Tessellated DID + Soul DID + Fractal Triad as backwards-compatible additive extension to RFC-0008. Surfaced from practitioner pass against a real multi-soul platform implementation. |
| v1.1 | 2026-04-25 | Two follow-on candidate sections added: §13.5 session-bug + severity scoring rule, §13.6 incident monitoring + root-cause analysis. Asymmetric-risk closing argument added to §1. |
| v2 | 2026-04-26 | Rewritten in-place per Engineering review feedback (S190): reference-implementation-specific terminology stripped from normative body, format aligned to RFC-0008 convention, open questions enumerated, implementation sequencing made discrete. |
| v3 | 2026-04-26 | Product-pillar voice strengthened. Reframes RFC-0009 as a PPA architectural amendment (not just RFC-0008 schema additions): explicitly closes PPA v1.0 §8 "Multi-Product Portfolio" open question and RFC-0005 "Multi-product portfolio-level resource allocation" non-goal. Open questions where the implementation has a strong product position now state that position with reasoning instead of hedging; pure-naming questions (OQ-4) remain genuinely open. New §16 PPA v1.1 Direction section mirroring RFC-0008 §17 pattern adds v1.1-6 (per-soul Sα vector) and v1.1-7 (per-soul Cκ tensor). Reference Implementation appendix reframed as empirical proof-by-existence, not framework-supplicant. |
| v3.1 | 2026-04-27 | Additive-only patch acknowledging upstream's RFC-0010 (Parallel Execution + Worktree Pooling, published 2026-04-27 by Dom). New §7.3 Eρ₆ Cost Clearance gating sub-component (parallel to Eρ₅ Compliance Clearance) honoring RFC-0010 `tenantQuotaShare` per soul. New §8.5 SubscriptionPlan, §8.6 WorktreePool, §8.7 DatabaseBranchPool, §8.8 Operator role scope sections enumerating RFC-0010 resource interaction at platform vs soul scopes. New OQ-10 (Operator role tessellation), OQ-11 (DatabaseBranchPool per-soul policy), OQ-12 (Eρ₆ vs Dπ₃ — which dimension cost-pressure feeds into). No changes to v3's normative spec. |
| v3.2 | 2026-04-27 | Parity pass with PPA v1.1 (Alexander, same day). Strengthens §4 Fractal Triad with the Identity / Expression / Coherence framing for the structural pillar asymmetry — Product declares identity, Design expresses identity, Engineering maintains coherence between Identity and Expression at runtime; the asymmetry is a structural property of the basis, not a gap to fix. Strengthens §5.1 design vertex with explicit DID ownership-model parallel to PPA v1.1 §4 (Product owns mission/experientialTargets feeding SA1; Design owns designPrinciples/brandIdentity/visualIdentity feeding SA2; Engineering reviews and may block only on technical infeasibility of measurable signals). Adds §7.3 explicit acknowledgment of PPA v1.1's C8 Cost Governance Integration as the operational channel wiring SubscriptionPlan.tenantQuotaShare → Eρ₆. Marks OQ-13 resolved-against-rename: PPA v1.1 landed on "multi-soul scoring" terminology in body + title; "soul sharding" survives as accurate vocabulary for the *pattern itself* (mechanism), complementing "multi-soul platform" which describes the *architectural shape* (output). Adds PPA v1.1 to References. No normative content changed from v3 or v3.1; v3.2 is purely strengthening + cross-reference parity. |
| v3.3 | 2026-05-03 | Operator walkthrough resolved 5 of 13 open questions: OQ-1 (Option D — required-with-defaults), OQ-2 (Option A — `min` with affected-souls scope filter), OQ-3 (REVERSAL — variant + journey carved out to RFC-0017/0018, NOT bundled here), OQ-4 (Variant B — Tessellated Platform / Soul / Tessellation; retire `shard` as noun), OQ-5 (Option A — gating, hard regulatory only). OQ-6 through OQ-12 remain open for future walkthrough. OQ-13 re-affirmed unchanged. Lifecycle remains Draft pending OQ-6-12 + Engineering + Design sign-off. Rename pass applied throughout: `shard` (noun) → `soul`; `Shard DID` → `Soul DID`; `crossShardScoringRule` → `crossSoulScoringRule`; `shardId/shardScope/shardOverrides/shardBindings/targetedShards` → `soulId/soulScope/soulOverrides/soulBindings/targetedSouls`; example slugs `shard-a/b/c` → `soul-a/b/c`; DID URI segments `did:platform-x:shard:*` → `did:platform-x:soul:*`. `soul sharding` retained as mechanism verb form per OQ-13. Sections of v3.2 main that normatively spec variant + journey patterns deleted and replaced with pointer to RFC-0017/0018. |
| **v3.4** | **2026-05-04** | **Operator walkthrough resolved remaining 7 of 13 open questions: OQ-6 (Option A — orchestrator-side detection; rule #1 ships, rule #2 awaits RFC-0019, rule #3 awaits RFC-0009 impl), OQ-7 (REVERSAL — §13.5+§13.6 carved to RFC-0020+RFC-0021), OQ-8 (filed as AISDLC-171 bug), OQ-9 (filed as AISDLC-172 bug), OQ-10 (Option A — platform-scoped), OQ-11 (Option A — shared+RLS default with trigger checklist; cross-references RFC-0022), OQ-12 (Option B — new HC_cost channel with RFC-0016 data dependency). All 13 OQs now resolved (OQ-1-12 active + OQ-13 already resolved against title rename). Lifecycle: Ready for Review (Engineering + Design + Product all signed 2026-05-04).** |
| **v3.5** | **2026-05-27** | **Lifecycle promoted Ready for Review → Implemented. All 8 implementation phases shipped (AISDLC-312/313/314/315/316/317/318/319 — see implementedBy frontmatter). Design Authority conditions C1-C3 remain follow-on commitments per Morgan's 2026-05-04 sign-off (not blockers). Operator-authorized lifecycle-jump override marker included (Dominique = Engineering + Operator approver).** |

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

This RFC is that future work. It amends the PPA architecture (and consequently the DID schema, the admission composite, the resource type definitions) to support platforms running multiple soul-distinct products on shared engineering substrate. The amendment introduces three concepts:

- **Tessellated DID** — a parent DID describing a platform whose soul is composed of multiple Soul DIDs tiled together. Carries platform-level invariants and a tessellation manifest enumerating child souls.
- **Soul DID** — a soul-complete DID for one product face of a Tessellated Platform. Inherits substrate invariants from its parent Tessellated DID; specializes its own Sα / compliance / audience.
- **Fractal Triad** — every DID (Tessellated OR Soul) carries a required `triad: { design, engineering, product }` object. The triad is fractal: it exists at the platform level AND at each soul level, with inheritance from parent to child.

**Note on backwards compatibility (v3.3):** Per OQ-1 resolution, the `triad` object is now required everywhere, including on single-product DIDs. This is a BREAKING CHANGE relative to RFC-0008's `triad`-optional draft. The framework's small user base makes this the right time to break. `init` scaffolds defaults for single-product adopters (operator wears all three pillars unless explicit roles for design/engineering/product are present), so the migration cost is one `init` re-run plus one schema validation pass per existing DID.

Closes the architectural gap that locks the Design pillar at platform-aggregate values when work is single-soul-scoped (empirically observed: 0.40 vs the soul-bounded 0.7+ that per-soul DSBs would correctly produce). Per-soul DSBs become authorable; per-soul Sα scoring becomes meaningful; per-soul Cκ calibration becomes possible.

This RFC also queues two PPA v1.1 directions (§16 v1.1-6 + v1.1-7) that formalize what the interim solution embeds structurally.

---

## 2. Motivation

### 2.1 The single-DID assumption breaks at platform scale

RFC-0008 §3 (Triad Architecture) and §4 (Design Intent Document) assume one DID per Pipeline. This assumption is correct for single-product SaaS and for tightly-coupled product suites. It produces meaningful Sα scores, sensible Cκ calibration, and addressable QualityGate criteria when the platform serves one soul-distinct audience with one shared compliance regime.

The assumption breaks when a platform serves multiple soul-distinct products on shared engineering substrate.

Concrete observable failure mode: when a multi-product platform has one DSB (DesignSystemBinding) covering platform-aggregate design system maturity, all single-soul work scores against the platform-aggregate Design pillar value. Empirically observed: Design pillar locked at 0.40 (lifecycle: stabilizing) when product-soul-specific DSBs would correctly score 0.7+ for soul-bounded work. The framework is technically correct; the abstraction is incorrect for the input.

### 2.2 The pattern is general, not implementation-specific

Multi-product platforms with shared substrate are common at scale:

- Payment platforms with multiple product lines (transactions, marketplace platform, lending, fraud-detection, card issuance) where each line carries categorically distinct compliance regimes (PCI, marketplace fund-flow, lending regulations, ML governance, BIN sponsorship)
- Productivity platforms with multiple product faces (documents, databases, AI assistance, calendaring) sharing a block-based substrate but diverging on user value and success metrics
- Commerce platforms with multiple verticals (storefront, point-of-sale, shipping, capital, workflow) where the lending vertical's compliance cannot be expressed in the same DID as the payment-card-present vertical's
- Design tool platforms with multiple product surfaces (design canvas, collaborative whiteboarding, developer mode, presentation) where success criteria diverge sharply

Each of these eventually hits the multi-soul governance wall. Without framework-level support, adopters either: (a) average soul signals across products (Sα becomes meaningless per product), (b) fragment into separate pipelines (loses substrate-sharing advantage), or (c) author side-channel governance docs the framework can't see (silent fragmentation).

### 2.3 Concrete drift modes single-DID misses

1. **Substrate code encoding soul-specific identity strings as fallbacks.** Single-DID has no way to express "substrate code must not name any specific soul" because there's only one soul in its mental model. Pattern compounds with every new product added.
2. **Persisted state from one product silently appearing in another product's surface during hydration.** Cross-product visual identity bleed at the presentation layer. Single-DID can't model the cross-product isolation invariant.
3. **Type unification gaps where the same shape is declared multiple times across substrate code paths.** Substrate-vs-product type drift is invisible without the substrate/soul distinction.
4. **Compliance regime conflicts** that single-DID can't express simultaneously. Multiple categorically-distinct regimes get forced into one bucket; the framework's QualityGate model either passes everything or blocks everything.
5. **Per-product Cκ calibration impossible.** Without tessellation, calibration data averages outcomes across categorically different products. The "did this work succeed?" signal becomes noise.

### 2.4 Cost shape

The cost is **slow-then-cliff**. Single-DID looks fine for years, then one day a specific drift pattern (cross-tenant write, regulatory-regime conflict, schema mis-attribution) causes a real incident that forces the platform team to retrofit governance under load. Tessellated DID lets the framework absorb this growth gracefully.

### 2.5 The asymmetric risk and the framework's commercial trajectory

Multi-product platforms with shared substrate are the target market for AI-SDLC at scale. Single-product adopters benefit from the framework today; multi-product adopters are the bigger commercial opportunity. Without RFC-0009, the framework's effective ceiling is single-product adopters — which does not match the platform-company shape that produces the framework's largest contracts and most visible reference customers.

Three asymmetric costs accrue from inaction, not incidentally but structurally:

1. **Vocabulary leadership transfers to whoever ships first.** Some adopter hits the multi-soul wall in the next 6-18 months. If the framework hasn't adopted RFC-0009, that adopter ships their own version under their own naming — the framework either absorbs a less-coherent proposal later or watches the ecosystem fork. Adopting now means the framework gets to shape the vocabulary while the proposal is mature, backwards-compatible (modulo OQ-1's triad-required break, mitigated by `init` defaults), and field-validated by an existing reference implementation. Adopting later means inheriting the next adopter's compromise.

2. **Adopters that hit the wall route around the framework or abandon it.** Concretely, a team using AI-SDLC for their first product launches successfully → adds a second product → hits single-soul Sα incoherence → has three options: (a) author side-channel governance docs the framework can't see (silent fragmentation; framework loses authority), (b) fork the framework with their own multi-DID extension (loud fragmentation; framework loses ecosystem coherence), or (c) abandon AI-SDLC for something more accommodating (commercial loss). All three reduce the framework's commercial trajectory. RFC-0009 absorbs the growth curve gracefully and keeps adopters inside the framework's authority.

3. **Competitive lead window is narrow.** No competing AI-SDLC-adjacent governance framework (CrewAI, AutoGen, SmythOS, the various agentic-platform startups) has solved multi-product governance. Most haven't even named it as a problem. AI-SDLC adopting RFC-0009 first means the framework has a structural differentiator that takes a competitor 6-12 months to credibly match — and by then the framework has compound-interest credibility from real adopters governing real multi-product platforms on it.

The product-pillar position: **single-soul governance feels safe today and becomes a liability tomorrow.** Tessellation is the cheapest insurance: validated by an existing reference implementation, with vocabulary the framework gets to own.

---

## 3. Definitions

Terms used throughout this RFC. Per OQ-4 resolution (v3.3), the framework canonicalizes on **Tessellated Platform / Soul / Tessellation**. The noun "shard" is retired; "soul sharding" survives as the mechanism verb form (per OQ-13).

| Term | Meaning |
|---|---|
| **Tessellated Platform** | A platform whose soul is composed of multiple soul-distinct product faces tiled together onto shared engineering substrate. The architectural shape that this RFC governs. |
| **Tessellated DID** | A parent DID describing a Tessellated Platform composed of N Soul DIDs. Carries platform-level invariants, a tessellation manifest enumerating child souls, and cross-soul governance rules. |
| **Soul DID** | A soul-complete DID for one product face of a Tessellated Platform. Conforms to the same `design-intent-document.schema.json` as a single-product DID, with the addition of a `parentTessellation` field. |
| **Tessellation** | The pattern by which N Soul DIDs tile into a Tessellated DID, sharing substrate invariants while specializing identity, expression, and compliance. |
| **Soul sharding** (verb) | The mechanism by which one platform soul shards into N coherent faces — what tessellation *does* internally. Verb form retained per OQ-13; do not use "shard" as a noun. |
| **Fractal Triad** | The PPA Triad (Engineering × Design × Product) replicated at multiple scopes: at the platform level on the Tessellated DID, and at each soul level on each Soul DID. Each triad vertex inherits from its parent. |
| **Tessellation Drift** | A class of Eτ-firing events: substrate code encoding soul-specific identifiers, cross-soul isolation invariant violations, or cross-soul convergence without explicit merge decision. |

In-soul variation patterns (sub-theme, variant, journey) are out of scope for RFC-0009 main per OQ-3 resolution. **See RFC-0017 (In-Shard Variant Pattern, reserved) and RFC-0018 (In-Shard Journey Pattern, reserved) — both pending normative spec when practitioner validation exists.**

---

## 4. The Fractal Triad

RFC-0008 §3 establishes the PPA Triad: **Engineering × Design × Product** as the three pillars of governance. RFC-0008 §C5 establishes HC_design as a design-pillar signal channel. This RFC extends the triad concept structurally: **the triad is fractal** — it exists at multiple scopes within a Tessellated Platform.

### 4.1 Geometry

A tessellation of triangles is a canonical mosaic pattern, used here as structural metaphor:

- Every **Soul DID is a triangle** with three vertices: `{ design, engineering, product }`
- Every **Tessellated DID is a larger triangle** with the same three vertices at platform scale
- Soul triangles tile into the platform triangle; each vertex of each soul triangle inherits from (and may extend) the corresponding platform-vertex
- A substrate invariant declared at a platform vertex propagates to all soul vertices of the same type
- A soul-specific specialization declared at a soul vertex remains local unless explicitly promoted to the platform vertex

### 4.1.1 The structural pillar asymmetry (v3.2 strengthening — Identity / Expression / Coherence)

The three pillars play structurally distinct roles at every scope of the tessellation. This asymmetry is a structural property of the basis, not a gap to fix:

- **Product declares identity** — what this soul is for, who it serves, what problem it exists to solve. The mission/audience/scope fields on the product vertex are the load-bearing identity declaration.
- **Design expresses identity** — how this soul appears, feels, and sounds. The design principles, brand identity, visual identity, and voice register on the design vertex are the load-bearing expression of identity that Product declared.
- **Engineering maintains coherence between Identity and Expression at runtime** — enforcement, quality gates, compliance, drift detection. Engineering's authority at any scope is to maintain what the other two pillars have declared. The compliance regimes, performance budgets, observability requirements, and substrate invariants on the engineering vertex are the load-bearing coherence-maintenance functions.

Engineering's offensive power in the PPA composite is gating, not amplifying — and that is correct. The market decides what is urgent (Product owns Demand Pressure, Market Force, Entropy Tax — dimensions that can amplify priority); Design and Engineering ensure the system only builds what it can build well (gating dimensions: ER₁–ER₆ on Engineering, ER₄ on Design via DesignSystemBinding readiness). The asymmetry replicates fractally: a soul-level Engineering authority maintains soul-level coherence, just as the platform-level Engineering authority maintains platform-level coherence.

This asymmetry is the formal structural answer to the question "why does the triad have three pillars in this specific configuration." Identity / Expression / Coherence is not a hierarchy of authority — all three pillars retain veto power through the multiplicative composite — but a hierarchy of what each pillar's authority is *over*. PPA v1.1 §5 ("Fractal Triad") and §9 ("Pillar Perspective Breakdown") formalize this asymmetry in the scoring model.

### 4.2 The three vertices per soul

For any Soul DID, the triad object specializes:

**Design vertex** — soul-specific design intent:
- Voice register specific to the soul's audience and domain
- Visual identity specialization (chrome tokens overrides, portrait style, surface aesthetic)
- Experiential invariants (ceremonies, narrative cadence, micro-interaction patterns)
- Brand and UX guidelines specific to this soul's audience
- Inherits from platform Design vertex (shared design tokens, structural design system axes, accessibility floor)

**Engineering vertex** — soul-specific engineering constraints:
- Compliance regime(s) specific to the soul's domain (e.g., HIPAA, GDPR, SOC2, PCI-DSS, FedRAMP, regional data-residency)
- Data retention and isolation requirements per soul
- SLA tier appropriate to soul workload
- Performance budgets specific to soul workload shape
- Soul-specific observability and audit requirements
- Inherits from platform Engineering vertex (shared substrate invariants, tenancy model, agent-routing infrastructure)

**Product vertex** — soul-specific product direction:
- Target audience and persona for this soul
- Problem domain the soul addresses
- Success metrics for this soul's work
- Monetization model per soul
- Endgame phase mapping per platform's lifecycle model

---

## 5. Schema Amendments to `design-intent-document.schema.json`

### 5.1 The `triad` object — REQUIRED EVERYWHERE WITH AUTO-FILLABLE DEFAULTS [RESOLVED 2026-05-03 — Option D]

Per OQ-1 resolution (v3.3), the `triad` object is **required on every DID** — single-product DIDs included. This is a BREAKING CHANGE relative to RFC-0008's optional-`triad` draft. The framework's small user base makes this the right time to break.

**`init` scaffolding behavior (single-product DIDs):** the `init` command auto-fills `triad.design.authority`, `triad.engineering.authority`, and `triad.product.authority` with `${operator}` (operator wears all three pillars by default). If explicit roles for design/engineering/product are present in the project's `roles.yaml` (or equivalent), those roles override the operator default for the matching pillars. Tessellation forces the operator to differentiate authority across pillars at the platform level.

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
          "required": ["authority"],
          "properties": {
            "authority": { "type": "string", "description": "Principal accountable for the design vertex at this DID's scope. Defaults to ${operator} on init for single-product DIDs." },
            "inheritsFrom": { "type": "string", "description": "Path to parent DID's design vertex. Null for top-level Tessellated DID." },
            "imperatives": { "type": "array", "items": { "type": "string" } },
            "overrides": { "type": "object" }
          }
        },
        "engineering": {
          "type": "object",
          "required": ["authority"],
          "properties": {
            "authority": { "type": "string", "description": "Principal accountable for the engineering vertex at this DID's scope. Defaults to ${operator} on init for single-product DIDs." },
            "inheritsFrom": { "type": "string" },
            "complianceRegimes": {
              "type": "array",
              "items": { "type": "string" },
              "description": "Named regulatory or compliance constraints applied at this scope. Eρ₅ scope per §7.1: HARD regulatory frameworks ONLY (GDPR, HIPAA, SOC2, PCI-DSS, FedRAMP, regional data-residency, regulated-industry rules)."
            },
            "performanceBudgets": { "type": "object" },
            "dataRetention": { "type": "object" },
            "slaTier": { "type": "string" },
            "substrateInvariants": { "type": "array", "items": { "type": "string" } }
          }
        },
        "product": {
          "type": "object",
          "required": ["authority"],
          "properties": {
            "authority": { "type": "string", "description": "Principal accountable for the product vertex at this DID's scope. Defaults to ${operator} on init for single-product DIDs." },
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

For single-product DIDs initialized with `${operator}` defaults across all three vertex `authority` fields (per §5.1), the operator implicitly owns all three roles. The asymmetry is preserved — the operator simply wears all three hats — and the moment the operator differentiates (assigns a separate Design Authority, for example), the asymmetric review/approval rules immediately apply per the table above.

Drift between DID versions over time defaults toward the owning pillar's perspective. A DID where Product fields have not been touched in 6 months but Design fields evolved monthly indicates Product's strategic intent has gone stale — surface this via `DesignIntentDrift` reconciliation event (parallel to RFC-0006's `TokenDriftDetected`). Quarterly DID review is a minimum floor, not the primary detection mechanism. Continuous semantic-drift monitoring is the actual mechanism.

### 5.2 The `tessellation` object (Tessellated DIDs only)

```json
{
  "tessellation": {
    "type": "object",
    "description": "Present only on Tessellated DIDs (platform roots). Enumerates child Soul DIDs and cross-soul governance.",
    "properties": {
      "souls": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["soulId", "didUri"],
          "properties": {
            "soulId": { "type": "string", "pattern": "^[a-z0-9-]+$" },
            "didUri": { "type": "string", "format": "uri-reference" },
            "status": { "enum": ["active", "deprecated", "draft"] },
            "inheritsSubstrate": { "type": "boolean", "default": true }
          }
        }
      },
      "crossSoulScoringRule": {
        "enum": ["min", "max", "mean", "weighted-traffic", "weighted-revenue"],
        "default": "min",
        "description": "Aggregation rule when substrate work affects multiple souls. Default `min` per OQ-2 resolution (v3.3). Other rules ship as opt-in escape valves; weighted variants are advanced — they require a data source the adopter must provide."
      },
      "substrateInvariants": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Named invariants ALL souls must honor. Violations trigger cross-soul drift detection."
      }
    },
    "required": ["souls"]
  }
}
```

### 5.3 The `parentTessellation` field (Soul DIDs only)

```json
{
  "parentTessellation": {
    "type": "string",
    "description": "Present only on Soul DIDs. References the parent Tessellated DID's URI."
  }
}
```

### 5.4 Mutual exclusion

A DID has `tessellation` XOR `parentTessellation` XOR neither. The last is the RFC-0008 base case (single-product DID). All three categories now require the `triad` object per §5.1 (v3.3 OQ-1 resolution); only the tessellation/parentTessellation fields differentiate the three.

---

## 6. Admission Composite Extension

RFC-0008 Addendum A §A.5 (Admission Scoring Function) and the live admission composite (`SA × D-pi_adjusted × ER × (1+HC)` per the orchestrator implementation) operate on a single DID. The extension preserves single-DID behavior and adds soul-aware scoring when tessellation is present:

```
For a work item w:

  resolveAffectedSouls(w) = set of Soul DIDs the work item affects, computed from
    the dependency graph: souls that import or depend on the substrate file/module
    being changed (NOT all souls in the platform). See OQ-2 resolution
    [RESOLVED 2026-05-03 — Option A with sub-decision].

  If tessellation absent on the resolved DID:
    Behavior unchanged from RFC-0008. Single-DID semantics preserved.

  Else if |resolveAffectedSouls(w)| == 0:
    // Pure substrate work touching no soul-importing module
    Sα(w) = min over all souls { Sα(w, soul) }                          // applied across each soul

  Else if |resolveAffectedSouls(w)| == 1:
    Sα(w) = Sα(w, targetSoul)                                            // scored against soul's DSB

  Else:
    Sα(w) = crossSoulScoringRule(w, affectedSouls)                       // per Tessellated DID rule
                                                                          // default `min` scoped to AFFECTED souls,
                                                                          // not all souls in the platform
```

**OQ-2 sub-decision (v3.3):** "affected" means souls that import or depend on the substrate file/module being changed (computed from the dependency graph). A substrate change to `payment-validator.ts` affects all souls that import payment validation, NOT all souls in the platform. This scope filter prevents the `min` rule from over-pessimizing scores on substrate work that demonstrably touches only a subset of souls.

The same soul-resolution applies to Eρ₄ (Design System Readiness, RFC-0008 §6) which reads against the targeted soul's DSB rather than the platform-aggregate DSB. Empirically: this is the change that lifts the Design pillar from platform-aggregate values toward soul-specific values for soul-bounded work.

---

## 7. New Sub-Dimensions

### 7.1 Eρ₅ Compliance Clearance — GATING, HARD REGULATORY ONLY [RESOLVED 2026-05-03 — Option A with sub-decision]

A new sub-dimension under Eρ:

```
Eρ₅ = soul.triad.engineering.complianceRegimes[].clearance(work_item)
    = 0 if any named regime is violated
    = 1 otherwise
```

**Categorical 0/1, gating** — fires zero when a work item targeting a soul would violate that soul's named compliance regime. Example: a work item that would leak data subject to a soul's privacy regime to a platform-wide analytics pipe receives Eρ₅ = 0, gating execution reality regardless of resource availability or build complexity.

**Sub-decision (v3.3) — what counts as "compliance":** HARD regulatory frameworks ONLY. The exhaustive in-scope list:

- GDPR (EU data protection)
- HIPAA (US healthcare)
- SOC2 (audit trust framework)
- PCI-DSS (payment card data)
- FedRAMP (US federal cloud)
- Regional data-residency rules (e.g., Schrems II / EU data-localization, China PIPL, Canadian PIPEDA cross-border)
- Regulated-industry rules (financial services KYC/AML, healthcare device certification, telecom regulations, etc.)

Anything with **formal external-audit consequences** qualifies. Internal best-practices, code style, architectural preferences, and team conventions are **out of scope** for Eρ₅ — they belong to other mechanisms (code review, lint, separate quality gates).

**Boundary test:** "would an external regulator or auditor have grounds to act on a violation?" Yes → Eρ₅. No → other mechanism.

**Customer-audit-by-proxy qualifies:** when a customer's own SOC2 (or equivalent) audit asks vendors about their data-handling policy, that qualifies as regulatory-by-proxy and falls inside Eρ₅. The transitive audit-trail consequence is what matters, not the direct regulatory relationship.

### 7.2 Eτ_tessellation_drift — ORCHESTRATOR-SIDE DETECTION [RESOLVED 2026-05-04 — Option A with sub-decision]

A new sub-dimension under Eτ (Entropy Tax). Fires when a work item:

- Introduces soul-specific conditionals into shared substrate code (`if (soul === '<slug>')` patterns in shared modules)
- Violates a named `substrateInvariant` from the Tessellated DID
- Causes two Soul DIDs to converge (voice register drift, anti-goal overlap, success-metric overlap) without explicit merge decision recorded as a tessellation amendment
- Silently extends one Soul DID's domain into another's territory

**Detection lives orchestrator-side, not adapter-side** (per OQ-6 resolution). Adapter-side detection puts the burden on every adapter author to instrument drift signals consistently; the framework cannot guarantee detection coverage if it depends on N adapter implementations correctly tagging soul-affecting work. Orchestrator-side is the only path to framework-wide consistency. Adapter-side detection MAY supplement (adapters can volunteer additional drift signals) but is not the primary detection layer.

**Sub-decision (v3.4) — three detection rules with staggered ship dates:**

| Rule | Mechanism | Ships when |
|---|---|---|
| **Rule #1: AST scan for soul-name string literals** | Scan shared substrate code for soul-slug string literals + `if (soul === '<slug>')` conditionals. Static analysis at admission time. | **Ships now in RFC-0009 implementation phase** — no new infrastructure required; AST tooling is already a framework primitive. |
| **Rule #2: Embedding distance between Soul DIDs over time** | Compute embedding vectors for each Soul DID; track inter-soul distance across versions; flag convergence below configured threshold without explicit merge amendment. | **Deferred to RFC-0019 implementation** (Embedding Provider Adapter Framework). RFC-0019 has just landed to main as Draft (2026-05-03); rule #2 becomes ship-able when RFC-0019's adapter surface lands and `embedDocument(text)` is callable from orchestrator. |
| **Rule #3: Cross-soul provenance audits** | Walk provenance records (§8.3) and flag work items whose `targetedSouls` set crosses tessellation boundaries without recorded amendment; flag substrate work whose downstream provenance shows soul-distinct outcomes diverge sharply. | **Deferred to RFC-0009 implementation phase** (provenance tagging needs the substrate-vs-soul partition to exist in code first). Ships once §8.3 ProvenanceRecord extension lands and the first generation of tessellated provenance records accumulates. |

The staggered roll-out means RFC-0009's implementation phase ships rule #1 immediately (covers the highest-frequency drift mode — soul-name leakage in substrate); rule #3 follows naturally as provenance data accumulates; rule #2 unlocks once RFC-0019's embedding adapter is implementable.

### 7.3 Eρ₆ Cost Clearance (proposed; v3.1 — interaction with RFC-0010)

A new sub-dimension under Eρ, parallel to §7.1 Eρ₅ Compliance Clearance. Introduced in v3.1 to honor RFC-0010's `tenantQuotaShare` semantics for Tessellated Platforms.

```
Eρ₆(w, s) = cost_clearance(w, s.tenantQuotaShare, current_period_burn)
            = 0 if w would exhaust s.tenantQuotaShare for current billing period
            = 1 otherwise
```

Where `s.tenantQuotaShare` is sourced from RFC-0010's `SubscriptionPlan.spec.tenants[<soul-slug>].quotaShare`. Product-pillar position: souls in a Tessellated Platform map to RFC-0010's `tenant` concept; the sum of all souls' `tenantQuotaShare` on a shared vendor account equals 1.0 (RFC-0010 §"TenantShareInvalid" event invariant).

A work item targeting a soul whose burn-down for the current billing period would be exceeded by this work receives Eρ₆ = 0, gating execution reality regardless of soul alignment, demand pressure, or compliance clearance. This composes with the cross-soul scoring rules (§5) — substrate work scored under `min` rule against Eρ₆ honors every affected soul's cost ceiling.

Cost clearance is categorical (gating), not graduated, consistent with Eρ's existing semantics. Soft cost-pressure handling (work that *could* run but *should not* given budget burn rate) is handled by the new **HC_cost channel** added per OQ-12 resolution — see §7.4 below.

For single-product platforms, Eρ₆ = 1 always (no tenant share to exceed); for Tessellated Platforms without RFC-0010 SubscriptionPlan declared, Eρ₆ = 1 always (no tenantQuotaShare data); both degenerate cases preserve v3.0 scoring behavior.

**v3.2 acknowledgment of PPA v1.1 C8 wiring:** PPA v1.1 §7 introduces **C8 Cost Governance Integration** as the eighth triad-edge connection, formally wiring `SubscriptionPlan.spec.tenants[<soul-slug>].quotaShare` (RFC-0010) → ER6 Cost Clearance (PPA v1.1 §3) → §7.3 Eρ₆ (this RFC). C8 is the operational channel that makes §7.3 implementable; without C8, §7.3 has no source of `tenantQuotaShare` data. C8's implementation sequence (PPA v1.1 §7 Phase 3, weeks 9+) coincides with RFC-0010's cost governance adoption. Adopters implementing tessellation without RFC-0010 cost governance can adopt §7.3 as a no-op (Eρ₆ = 1.0 always); adopters implementing both get gating cost-clearance as a structural property of execution reality.

### 7.4 HC_cost channel — SOFT COST-PRESSURE LEVER [RESOLVED 2026-05-04 — Option B with RFC-0016 dependency]

A new HC (Human Choice) channel — `HC_cost` — added per OQ-12 resolution. Where §7.3 Eρ₆ Cost Clearance is **gating** (categorical 0/1 — refuses if hard-budget exceeded), `HC_cost` is **soft pressure** — operator-tunable multiplier on cost-sensitive tasks that defers expensive work without refusing it.

**Definition:**

```
HC_cost ∈ [0.0, 1.0]
  default 1.0   = neutral; no cost-based de-prioritization
  ratchet down  = the operator wants to defer expensive work
  HC_cost = 0.5 = halve the priority signal contribution from cost-sensitive tasks
  HC_cost = 0.0 = fully suppress cost-sensitive tasks (advisory; not gating)

For a work item w, applied as multiplicative weight in the HC composite:
  HC_total(w) ← HC_total(w) × HC_cost^isCostSensitive(w)
  where isCostSensitive(w) = 1 if w carries Stage.maxBudgetUsd (RFC-0010 §11.4); 0 otherwise.
```

**Sub-decisions (v3.4):**

- **What counts as a cost-sensitive task?** Tasks that carry `Stage.maxBudgetUsd` (RFC-0010 §11.4 — the per-stage hard budget cap that admission already reads). `HC_cost` is a **no-op** for tasks without that field. This keeps the channel scoped to work where cost is already declared as load-bearing; it does not insinuate cost into work the operator hasn't explicitly tagged as cost-sensitive.
- **Interaction with Eρ₆ (the §7.3 hard gate)?** Independent. Eρ₆ refuses execution when the hard `tenantQuotaShare` budget would be exceeded; `HC_cost` reduces priority but does not refuse. **Eρ₆ wins on hard exceedance** — the operator cannot un-gate a regulatory-or-cost-hard-cap by lowering `HC_cost`. The two mechanisms are orthogonal: Eρ₆ enforces the floor; `HC_cost` shapes the slope.
- **Configuration:** `Pipeline.spec.humanChoice.cost: 1.0` (default neutral); env override `AI_SDLC_HC_COST=0.5`.
- **Orchestrator (RFC-0015) integration:** the orchestrator emits an `OrchestratorCostPolicyApplied` event whenever `HC_cost ≠ 1.0` is in effect (per RFC-0015 §7 observability surface). The event carries the current `HC_cost` value, the count of cost-sensitive tasks affected this tick, and the priority delta induced by the multiplier — making the soft-pressure intervention visible in the same observability stream as Eρ₆ refusals.

**Critical RFC-0016 dependency — what `HC_cost` reads as the cost estimate:**

`HC_cost` ships as the **lever** (the operator's tuning surface); the **per-task cost-data quality** that the lever multiplies against grows with RFC-0016 (Estimation Calibration with T-Shirt Sizes) calibration maturity. Today the lever is crude because the data is crude; as RFC-0016 calibration ripens, the same lever produces increasingly accurate cost-shaped priority signals without any change to `HC_cost` semantics.

| RFC-0016 phase | What `HC_cost` reads | Quality |
|---|---|---|
| **Today** (RFC-0016 lifecycle: Ready for Review; no calibration data yet) | `Stage.maxBudgetUsd` only — the hard-cap value, not a per-task estimate | Crude — `HC_cost` either applies because the field exists, or doesn't. No graduated cost signal. |
| **RFC-0016 Phase 1** (Stage A signals shipped, class-default fallback active per RFC-0016 §6.1) | Class-default cost estimate from RFC-0016 §6.1: `wall_clock_minutes × token_rate` for the work item's class | Moderate — work classes get default estimates that already differentiate "small refactor" from "large feature build." `HC_cost` produces meaningful per-class priority shaping. |
| **RFC-0016 Phase 3+** (calibration log flowing, per-class bias multipliers active) | Accurate per-task cost prediction from RFC-0016 calibration tensor (per-class × per-soul bias multipliers) | High — `HC_cost` produces accurate per-task cost-shaped priority signals; the operator's lever produces predictable, calibrated outcomes. |

This dependency is **explicit and load-bearing**: shipping `HC_cost` before RFC-0016 Phase 1 is fine — adopters get the lever and the no-op-without-`Stage.maxBudgetUsd` semantics — but the lever's accuracy is bounded by RFC-0016's calibration quality. Operators tuning `HC_cost` before RFC-0016 Phase 1 should treat it as a coarse override; once Phase 3+ ships, the same configuration produces precise results.

For Tessellated Platforms specifically, `HC_cost` composes with RFC-0010's `tenantQuotaShare`: the operator may tune `HC_cost` globally (platform-wide soft pressure) while per-soul Eρ₆ enforces hard caps from `tenantQuotaShare`. Per-soul `HC_cost` overrides are **not in scope for v3.4** — global `HC_cost` is sufficient for the soft-pressure use case; per-soul tuning is a future extension if practitioner demand surfaces.

---

## 8. Resource Type Extensions

Each existing RFC-0008 resource type gains an optional soul-scoping field. All optional; absence preserves single-DID behavior.

### 8.1 AgentRole

```yaml
spec:
  scope: platform | soul | tenant       # default: platform
  soulBindings:                          # array of Soul DID URIs
    - <soul-did-uri-1>
    - <soul-did-uri-2>
```

`scope: platform` agents operate across all souls (substrate-scoped roles). `scope: soul` agents are bound to specific Soul DIDs (soul-specific specialists). `scope: tenant` agents are bound to tenant boundaries (orthogonal to soul scoping).

### 8.2 AdapterBinding

```yaml
spec:
  soulOverrides:
    - soul: <soul-did-uri>
      config:
        # Soul-specific adapter config (e.g., per-soul issue tracker
        # channel, per-soul customer-signal source)
```

Allows the same AdapterBinding to read from different concrete sources per soul. Necessary when, e.g., the issue tracker hosts soul-distinct customer-signal channels.

### 8.3 ProvenanceRecord

```yaml
targetedSouls:
  - <soul-did-uri>
substrateScoped: false
```

Every provenance record captures which soul(s) the work served. Closes the per-soul Cκ calibration loop: outcomes can be attributed to the correct soul's calibration cells.

### 8.4 QualityGate

```yaml
soulScope: <soul-did-uri>          # optional; absent = platform-scoped
```

Allows per-soul quality criteria (e.g., a soul whose voice register is load-bearing can ship a "voice coherence" gate that applies only to that soul's outputs).

### 8.5 SubscriptionPlan (RFC-0010; v3.1 interaction)

RFC-0010 introduces `SubscriptionPlan` (vendor billing model declaration). Tessellated Platforms extend it with a `tenants` map keyed by soul slug, with each soul's `quotaShare` summing to 1.0 across the account:

```yaml
# subscription-plans/<vendor>.yaml
spec:
  tenants:
    <soul-slug-A>:
      quotaShare: 0.45
      pipelineRef: pipelines/<soul-A>.yaml
    <soul-slug-B>:
      quotaShare: 0.35
      pipelineRef: pipelines/<soul-B>.yaml
    <soul-slug-C>:
      quotaShare: 0.20
      pipelineRef: pipelines/<soul-C>.yaml
```

Product-pillar position: SubscriptionPlan is **platform-scoped** (one per vendor account); the `tenants` map is the tessellation surface. Sum-to-1.0 invariant is enforced by RFC-0010's `TenantShareInvalid` Critical event. This is the source of truth for §7.3 Eρ₆ Cost Clearance scoring.

### 8.6 WorktreePool (RFC-0010; v3.1 interaction)

RFC-0010's `WorktreePool` manages parallel agent worktrees. **Default platform-scoped** — worktrees are git-level shared substrate; no tessellation per soul required. A Tessellated Platform may optionally declare per-soul pools if soul-distinct branch-naming or pool-root isolation is required:

```yaml
# worktree-pool.yaml (default — platform-shared, recommended)
spec:
  parallelism:
    maxConcurrent: 4
  poolRoot: .worktrees/

# worktree-pool-<soul>.yaml (optional — only if per-soul isolation needed)
spec:
  soulScope: <soul-did-uri>
  parallelism:
    maxConcurrent: 2
  poolRoot: .worktrees/<soul-slug>/
```

Product-pillar position: per-soul worktree pools are **opt-in escape valve**, not default. Most Tessellated Platforms benefit from a single shared pool; per-soul pools serve unusual cases (compliance regimes requiring physical worktree isolation, e.g., one soul's substrate access must not commingle).

### 8.7 DatabaseBranchPool — SHARED+RLS DEFAULT WITH PER-SOUL OPT-IN [RESOLVED 2026-05-04 — Option A with trigger checklist]

RFC-0010's `DatabaseBranchPool` provides per-branch DB isolation for parallel pipelines with `databaseAccess: write/migrate`.

**Resolution (Option A — shared pool + RLS isolation default; per-soul pool opt-in via init wizard):** the default is shared pool with row-level-security (RLS) isolation; per-soul pools are an opt-in escape valve walked by the `init` wizard.

```yaml
# database-branch-pools/<adapter>.yaml
spec:
  soulScope: <soul-did-uri>          # optional; absent = platform-shared pool (default)
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
| Shared pool, RLS isolation | `soulScope` absent | **DEFAULT.** Souls are RLS-isolated within one DB project. Sufficient for the vast majority of Tessellated Platforms regardless of maturity. |
| Per-soul pool | `soulScope` present | Souls are physically separate DB projects. Required only when one or more triggers below fires. |

**Trigger checklist — when shared+RLS is INSUFFICIENT and per-soul pool is REQUIRED:**

The framework defaults to shared+RLS because RLS-with-correctly-configured-policies provides logical tenant isolation that satisfies the majority of compliance and engineering requirements. The trigger checklist below enumerates the exhaustive set of conditions under which an operator MUST switch to per-soul pools. **If ANY trigger fires, the operator switches to per-soul.** The framework cannot auto-detect these triggers (they are adopter-declared, not orchestrator-observable); the `init` wizard walks the checklist and the operator declares.

1. **Regulatory hard requirement.** A regulatory framework the platform operates under explicitly requires tenant *physical* isolation (not logical/RLS). The exhaustive in-scope list:
   - HIPAA covered entity status (PHI separation requirement)
   - PCI-DSS Level 1 merchant (cardholder data physical-isolation control)
   - FedRAMP Moderate or High (system boundary controls)
   - SOC2 with a formal physical-isolation control declared in the audit boundary
   - Regional data residency (GDPR Art. 49 cross-border restrictions, Schrems II EU data-localization, China PIPL, Canadian PIPEDA cross-border) — when the regulatory requirement is *physical region pinning* rather than RLS-policy-region-flag

2. **Customer contract.** A vendor agreement with a specific customer explicitly requires tenant physical isolation as a contractual term, regardless of regulatory baseline. The contract supersedes the framework's default.

3. **Operator security review.** An explicit risk identified during operator security review that RLS cannot mitigate (e.g., side-channel concerns, supply-chain compromise scenarios, regulator-pre-approval where the regulator has formally stated RLS is insufficient for the specific data class).

If ANY trigger fires → operator MUST switch to per-soul pool. The framework can advise via the `init` wizard checklist but cannot auto-detect (adopter declares the regimes + contracts; operator declares the security-review outcome).

**Cross-reference to RFC-0022 (Compliance Posture + Audit Surface):** RFC-0022 (just drafted via AISDLC-173) is the canonical surface for declaring regulatory regimes. When an adopter declares HIPAA / PCI-DSS Level 1 / FedRAMP / SOC2-with-physical-isolation / regional-data-residency in their RFC-0022 `CompliancePosture` resource, the OQ-11 trigger checklist above becomes a **derivedGate computation** in RFC-0022's regime → DerivedGates mapping — the framework reads the declared posture and surfaces the per-soul-pool requirement automatically. Operators using RFC-0022 do not re-declare the trigger conditions; the regime declaration drives the gate.

For platforms not yet on RFC-0022, the operator declares the per-soul-pool decision directly via the `init` wizard checklist and persists it in the pipeline configuration.

Product-pillar position: the **shared pool with RLS isolation** is the default; **per-soul pools opt-in** when one of the three triggers above fires. The default protects the majority of adopters from operational complexity they don't need; the trigger checklist makes the escape valve explicit and audit-traceable.

### 8.8 Operator role scope — PLATFORM-SCOPED, NOT TESSELLATED [RESOLVED 2026-05-04 — Option A]

RFC-0010 defines a fourth pillar role: **Operator** (config + cost posture + calibration + event triage; explicitly NOT engineer/reviewer/PM/SRE/maintainer).

**Resolution (Option A — accept Alex's position):** The Operator role is **platform-scoped**, NOT tessellated per soul. One operator per platform, judging the *pipeline* not the *product soul*. Souls inherit operator decisions (subscription posture, calibration drift policy, event triage rules). Soul DIDs do NOT carry an operator vertex on their fractal triad.

Justification: the three pillars in v3 (`design`, `engineering`, `product`) describe the **product soul** of a soul — what the soul is, who it serves, how it speaks. Operator describes the **pipeline operation** — burn rate, harness availability, calibration drift. Pipeline operation is a property of the platform, not of any individual soul.

**Per-soul operational differences are tuned via the existing RFC-0010 mechanisms** — `SubscriptionPlan.spec.tenants[<soul-slug>].quotaShare` (per-soul cost allocation) and per-soul `costBudget` declarations (per-soul stage caps). Even radically-different operational profiles (e.g., one soul high-volume cheap-stage; another soul low-volume expensive-stage) are tuned via these knobs rather than by separate operator humans.

A per-soul Operator role can be added later via a future RFC if/when enterprise demand surfaces (e.g., a Tessellated Platform with so many souls that a single human operator cannot retain context across all of them, requiring delegation). For v3.4, the platform-scoped Operator is sufficient and matches the reference implementation pattern (Engineering Authority + Operator role collapse to the same person).

Implication for v3 §4 (Fractal Triad): triad remains `{ design, engineering, product }`; Operator is acknowledged as a **platform-only role** that operates on the pipeline running across all souls. Where RFC-0008 §A.8 defined design-authority signal monitoring per Soul DID, Operator decisions (e.g., "raise this soul's hardCap" or "extend off-peak window for this soul") are made at the platform-pipeline level by referencing soul slugs in the pipeline.yaml, not by adding fields to the Soul DID itself.

For Tessellated Platforms, the Operator role typically aligns with the **Engineering Authority of the platform** (cost posture + calibration are engineering concerns), with Product Authority consulted on cross-soul tradeoffs (e.g., "should we shift quotaShare from Soul-A to Soul-B given the burn-rate trends?"). This is the pattern observed in the reference implementation (Appendix A): Engineering Authority and Operator role collapse to the same person.

---

## 9. Migration Path

Migration to tessellated governance is opt-in and incremental. The triad-required-everywhere change (OQ-1 resolution, v3.3) is the only breaking step; `init` scaffolds defaults so existing single-product adopters can migrate with one re-run plus one schema-validation pass per existing DID.

1. **Required for all DIDs (OQ-1, v3.3):** every existing DID must add a `triad: { design.authority, engineering.authority, product.authority }` block. `init` scaffolds defaults: operator wears all three pillars unless explicit roles for design/engineering/product are present in the project's `roles.yaml`. Existing single-product DIDs get the migration mechanically.
2. Author a Tessellated DID at the platform level (or extend the existing platform DID with a `tessellation` field).
3. Author Soul DIDs for each soul-distinct product face. Source material may be copied or referenced from existing scattered docs; schema validates either approach.
4. Extend AgentRole, AdapterBinding, ProvenanceRecord, and QualityGate manifests with soul-scoping where relevant.
5. Optionally run both single-DID and tessellated scoring in parallel for one sprint cycle; compare results; switch over when confident.

Steps 2-5 are reversible at any step. A platform that authors Soul DIDs but later decides single-DID was sufficient can remove the `tessellation` field from the platform DID without removing the `triad` object (which is now required regardless).

---

## 10. Implementation Sequencing

### Phase 1 — Schema PR (Week 1)

- Add `triad`, `tessellation`, `parentTessellation` field definitions to `design-intent-document.schema.json`
- Mark `triad` as required (OQ-1 resolution); ship `init` scaffolding for the required-with-defaults pattern (operator-wears-all-three-pillars baseline; explicit-role override)
- Existing fixtures gain auto-scaffolded `triad` blocks via `init` re-run; new fixtures with tessellation fields validate
- Mixed-fixture compatibility test: Tessellated DID with Soul DIDs that omit optional fields validate
- Reference implementation provides four production fixtures (one Tessellated DID + three Soul DIDs) for the framework's test suite

### Phase 2 — Admission Composite + Reader Extensions (Week 2)

- Admission composite recognizes `tessellation` and routes Sα + Eρ₄ resolution through soul scope
- `resolveAffectedSouls(w)` computed from the dependency graph (OQ-2 sub-decision); substrate-only changes that touch no soul-importing module fall through to the `min`-over-all-souls degenerate case
- Per-soul DSB authoring becomes possible (one DSB per Soul DID at `.ai-sdlc/souls/<slug>/design-system-binding.yaml`)
- Reference implementation produces before/after admit invocations demonstrating the Design pillar lift on soul-bounded work
- Cκ calibration aggregates per-soul, per-dimension (N souls × M dimensions cells)

### Phase 3 — Resource Extensions (Week 3)

- AgentRole, AdapterBinding, ProvenanceRecord, QualityGate gain soul-scoping fields
- In-soul variation patterns (variant + journey) are NOT in scope for RFC-0009 Phase 3 — see RFC-0017 (In-Shard Variant Pattern) and RFC-0018 (In-Shard Journey Pattern), both reserved per AISDLC-165, pending normative spec when practitioner validation exists.

### Phase 4 — Sub-Dimensions Activation (Week 4+)

- Eρ₅ Compliance Clearance activates when souls declare `complianceRegimes` against the hard-regulatory-only scope (OQ-5 sub-decision)
- Eτ_tessellation_drift **rule #1 (AST scan)** activates orchestrator-side per §7.2 (OQ-6 sub-decision); **rule #3 (cross-soul provenance audits)** activates once the §8.3 ProvenanceRecord extension lands and tessellated provenance accumulates; **rule #2 (embedding distance)** is deferred to RFC-0019 implementation
- HC_cost channel ships per §7.4 (OQ-12 resolution) as the operator-tunable lever; per-task cost-data quality grows with RFC-0016 calibration phases (crude → moderate → high)
- DatabaseBranchPool default = shared+RLS per §8.7 (OQ-11 resolution); init wizard walks the trigger checklist for per-soul opt-in; RFC-0022 declarations drive the gate automatically when adopters use it
- Operator role wiring confirmed platform-scoped per §8.8 (OQ-10 resolution); no soul-vertex Operator field shipped
- All sub-dimension activations are gated on adopter opt-in initially; promotion to default behavior subject to ecosystem feedback

---

## 11. Worked Example

### 11.1 Setup — generic three-soul platform

Platform name: Platform-X. Three soul-distinct souls: Soul-A (audience: alpha cohort, compliance: HIPAA), Soul-B (audience: beta cohort, compliance: SOC2), Soul-C (audience: gamma cohort, compliance: PCI-DSS). All three share the same engineering substrate (event bus, shared knowledge graph, common identity service).

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
      authority: dominique           # operator wears design pillar at platform scope
      imperatives: ["accessibility-floor: WCAG-AA", "shared-design-tokens-v3"]
    engineering:
      authority: dominique           # operator wears engineering pillar at platform scope
      substrateInvariants: ["event-bus-v2", "shared-graph-schema-152", "tenant-isolation-rls"]
      complianceRegimes: []          # Platform-level baseline; souls add their own
    product:
      authority: dominique           # operator wears product pillar at platform scope
      targetAudience: "Platform serving multiple distinct audiences via Soul DIDs"
      successMetrics: ["per-soul success metrics aggregate; no platform-level metric"]
  tessellation:
    souls:
      - soulId: soul-a
        didUri: did:platform-x:soul:soul-a
        status: active
      - soulId: soul-b
        didUri: did:platform-x:soul:soul-b
        status: active
      - soulId: soul-c
        didUri: did:platform-x:soul:soul-c
        status: active
    crossSoulScoringRule: min        # default per OQ-2 (v3.3)
    substrateInvariants: ["no-soul-conditionals-in-substrate", "tenant-rls-required"]
```

### 11.3 Soul DID for Soul-A

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignIntentDocument
metadata:
  name: soul-a
spec:
  did: did:platform-x:soul:soul-a
  parentTessellation: did:platform-x:platform
  triad:
    design:
      authority: dominique
      inheritsFrom: did:platform-x:platform/triad/design
      imperatives: ["voice-register: alpha-specific", "visual-identity: alpha-aesthetic"]
    engineering:
      authority: dominique
      inheritsFrom: did:platform-x:platform/triad/engineering
      complianceRegimes: ["HIPAA"]   # hard regulatory framework — Eρ₅ scope per OQ-5
    product:
      authority: dominique
      inheritsFrom: did:platform-x:platform/triad/product
      targetAudience: "alpha cohort"
      problemResonance: "alpha-cohort problem statement (source-of-truth for Sα₁)"
      successMetrics: ["alpha-specific success metric 1", "alpha-specific success metric 2"]
```

### 11.4 Admission for a single-soul work item

A work item targeting only Soul-A:

```
Affected souls (from dependency graph): { did:platform-x:soul:soul-a }
Sα(w) = Sα(w, soul-a)              // scored against Soul-A's DSB, not platform-aggregate
Eρ₄ = readiness(soul-a's DSB)      // soul-specific Design System Readiness
Eρ₅ = clearance(HIPAA)             // soul-specific Compliance Clearance (hard regulatory)
```

If Soul-A's DSB has lifecycle `established` and pattern coverage 0.85, Eρ₄ scores 0.80. The platform-aggregate DSB at lifecycle `stabilizing` and coverage 0.40 would score 0.40. The soul-bounded work correctly receives the higher pillar value.

### 11.5 Admission for substrate work

A work item modifying `payment-validator.ts` (substrate code imported by Soul-B and Soul-C, not Soul-A):

```
Affected souls (from dependency graph): { soul-b, soul-c }   // NOT all souls
Sα(w) = min(Sα(w, soul-b), Sα(w, soul-c))                    // affected-souls scope per OQ-2
```

The minimum-over-affected-souls rule forces substrate work to honor every soul that depends on it. If Soul-B's product vertex would score 0.4 while Soul-C would score 0.9, the substrate work scores 0.4 — surfacing that the work compromises Soul-B's distinct soul even if it serves Soul-C well. Crucially, Soul-A is NOT in the aggregation because it does not depend on `payment-validator.ts`; the dependency-graph filter prevents over-pessimization.

For a pure-substrate change touching no soul-importing module (rare but possible — e.g., infrastructure-only refactor), the affected-souls set is empty and the score falls through to `min` over ALL souls per §6.

---

## 12. Security and Authority Considerations

### 12.1 Cross-soul data isolation

Soul DIDs MUST NOT grant implicit read access across tessellation boundaries. A tenant authorized to one soul's data is not implicitly authorized to another soul's data, even on the same Tessellated DID. Existing RFC-0008 tenant-RLS patterns apply unchanged at the soul boundary.

### 12.2 Soul authority

The soul authority pattern (analogous to RFC-0008 §A.8 Design Authority Signal Monitoring) extends per-soul. A soul's design authority signals into HC_design for that soul's work scope, not platform-wide. Implementations choose whether to allow authority cascade (platform authority → soul authority by default) or require explicit soul-authority designation.

### 12.3 Compliance regime conflicts

When a substrate work item targets multiple souls with conflicting compliance regimes (e.g., one soul's `HIPAA must-log-all-access` vs another soul's `GDPR right-to-erasure`), the cross-soul scoring rule applied to Eρ₅ produces 0 (gating). The work item cannot proceed without a tessellation amendment explicitly resolving the conflict. Both regimes are in-scope for Eρ₅ per OQ-5 (hard regulatory frameworks).

---

## 13. Open Questions

> **Status (v3.4, 2026-05-04):** ALL 13 open questions RESOLVED. OQ-1 through OQ-5 + OQ-13 resolved 2026-05-03; OQ-6 through OQ-12 resolved 2026-05-04 (see resolution markers per question). RFC-0009 is now structurally complete pending Engineering + Design pillar sign-off.

The following list is preserved as historical record. Each question retains the original framing followed by an explicit `[RESOLVED ...]` marker and the operator decision.

> **§13.5 + §13.6 carve-out notice (OQ-7 resolution, v3.4):** Earlier drafts of this RFC referenced a §13.5 (session-bug + severity scoring rule) and a §13.6 (incident monitoring + root-cause analysis) as candidate sub-sections to fold into RFC-0009 main. Per OQ-7 reversal of Position-stated, both have been carved out. **See RFC-0020 (Session-bug + severity scoring rule, Draft) and RFC-0021 (Incident monitoring + root-cause analysis, RESERVED — pending adopter incident data) — both carved out per OQ-7 reversal of Position-stated stance.** RFC-0009 stays focused on tessellation/multi-soul architecture; Dπ₃ refinements + generic PPA additions belong in their own RFCs.

### OQ-1 [RESOLVED 2026-05-03 — Option D]: The `triad` object — required everywhere with auto-fillable defaults

**Original position:** Required on every DID, including single-product DIDs. Reasoning: RFC-0008 §3 establishes the three-pillar architecture (Engineering × Design × Product) as foundational. Making `triad` optional erodes that foundational claim — adopters who omit `triad` operate without the architecture RFC-0008 requires.

**Resolution (Option D — required everywhere with auto-fillable defaults):** `triad` is **required on every DID**. `init` scaffolds defaults: `{ design.authority: ${operator}, engineering.authority: ${operator}, product.authority: ${operator} }` for single-product DIDs. The operator wears all three pillars unless explicit roles for design/engineering/product are present (in which case use those). Tessellation forces the operator to differentiate authority across pillars at the platform level.

**BREAKING CHANGE acknowledged.** The framework's small user base makes this the right time to break. Migration cost: one `init` re-run plus one schema-validation pass per existing DID.

### OQ-2 [RESOLVED 2026-05-03 — Option A with sub-decision]: Default `crossSoulScoringRule` is `min` with affected-souls scope filter

**Original position:** `min`. Reasoning: PPA v1.0 §3 establishes that the composite is multiplicative because every dimension is a necessary condition. By the same logic, when substrate work affects multiple souls, every affected soul's soul is a necessary condition — the work cannot be more aligned than its weakest-aligned soul.

**Resolution (Option A with sub-decision):** `min` is the default. **Sub-decision on scope:** "affected" = souls that import or depend on the substrate file/module being changed (computed from the dependency graph). A substrate change to `payment-validator.ts` affects all souls that import payment validation, NOT all souls in the platform. This scope filter prevents the `min` rule from over-pessimizing scores on substrate work that demonstrably touches only a subset of souls.

Other rules (`max`, `weighted-traffic`, `weighted-revenue`, `mean`) ship as opt-in escape valves with weighted variants documented as **"advanced — requires data source you must provide."**

### OQ-3 [RESOLVED 2026-05-03 — Option B; reverses original Position-stated stance]: Variant + journey patterns carve out to RFC-0017/RFC-0018

**Original position (Alex, v3):** Variant pattern and journey pattern are first-class in-soul sub-structures and ship in RFC-0009 main, not as follow-on RFCs. Reasoning: separating them gives reviewers an excuse to under-think the in-soul nesting; the complete pattern (sub-theme < journey < variant < soul) is the framework's structural claim about how multi-soul platforms organize internally.

**Resolution (Option B — separate follow-on RFCs):** Variant + journey are **NOT in RFC-0009 main**. They ship as **RFC-0017 (In-Shard Variant Pattern)** and **RFC-0018 (In-Shard Journey Pattern)** as separate follow-on RFCs (already reserved per AISDLC-165). Both pending normative spec when practitioner validation exists.

**Reasoning (operator):** the operator weighed Alex's coherence argument against the scope-creep argument and the latter won because: (a) variant + journey aren't unique to multi-soul — patterns exist in single-product platforms too, so they're not multi-soul-specific; (b) zero practitioner validation in dogfood project; (c) ~700 line bloat unjustified for un-validated patterns; (d) the "fractal triad" architectural claim is about TESSELLATION specifically, not internal organization which is orthogonal — the coherence argument is "broken" anyway by orthogonality to tessellation.

**This is a REVERSAL of Alex's original Position-stated stance.** Recorded explicitly so future readers see that the operator weighed the original coherence argument against the scope-creep argument and chose scope-creep avoidance.

**Action taken:** sections of v3.2 that normatively spec variant + journey patterns (Definitions §3 sub-theme/variant/journey rows and the four-scope nesting paragraph; Phase 3 sub-RFC pointer) have been deleted and replaced with: "**See RFC-0017 (In-Shard Variant Pattern, reserved) and RFC-0018 (In-Shard Journey Pattern, reserved) — both pending normative spec when practitioner validation exists.**"

### OQ-4 [RESOLVED 2026-05-03 — Variant B]: Naming — Tessellated Platform / Soul / Tessellation (with `soul sharding` as mechanism verb)

**Original framing (v3.2):** the implementation has used "Tessellated" and "Shard" internally; the mechanism is fixed regardless of naming. Genuinely open on the surface vocabulary.

**Resolution (Variant B):** rename `shard` (noun) → `soul` throughout the RFC. Keep "Tessellated Platform" as the parent term. "Tessellation" as the pattern term. **Retire `shard` as a noun entirely;** preserve **"soul sharding"** as the mechanism verb form (per OQ-13 already-resolved framing). Title stays as-is ("RFC-0009: Tessellated Design Intent Documents for Multi-Soul Platforms" — already correct).

**Action taken (v3.3):** rename pass applied throughout the document. `shardId/shardScope/shardOverrides/shardBindings/targetedShards/crossShardScoringRule` → `soulId/soulScope/soulOverrides/soulBindings/targetedSouls/crossSoulScoringRule`. Example slugs `shard-a/b/c` → `soul-a/b/c`. DID URI segments `did:platform-x:shard:*` → `did:platform-x:soul:*`. Compound forms (`per-shard`, `cross-shard`, `single-shard`, `multi-shard`, `shard-aware`, `shard-bounded`, `shard-specific`, `shard-distinct`, `shard-name`, `shard-slug`, `shard-conditionals`, `shard-resolution`) replaced with their `-soul` counterparts.

### OQ-5 [RESOLVED 2026-05-03 — Option A with sub-decision]: Eρ₅ Compliance Clearance is gating, hard regulatory only

**Original position:** Eρ₅ = 0 when a violation is detected. Reasoning: PPA v1.0 §3 establishes that Eρ is a pure gating function ("can only reduce priority, never increase it"). Compliance violations are categorical — a work item either satisfies a regulatory regime or it doesn't.

**Resolution (Option A — gating):** Eρ₅ = 0 when violated (categorical 0/1, gating).

**Sub-decision (v3.3) — what counts as "compliance":** HARD regulatory frameworks ONLY (GDPR, HIPAA, SOC2, PCI-DSS, FedRAMP, regional data-residency, regulated-industry rules — anything with formal external-audit consequences). Internal best-practices, code style, architectural preferences are OUT OF SCOPE for Eρ₅ — they belong to other mechanisms (code review, lint, separate quality gates).

**Boundary test:** "would an external regulator/auditor have grounds to act on a violation?" Yes → Eρ₅. No → other mechanism. **Customer-audit-by-proxy** (e.g., customer's SOC2 audit asks about vendor policy) qualifies as regulatory-by-proxy.

See §7.1 for the normative scope and the exhaustive in-scope list.

### OQ-6 [RESOLVED 2026-05-04 — Option A with sub-decision]: Eτ_tessellation_drift detection is orchestrator-side

**Original position**: Orchestrator-side detection rules (AST scan for soul-name string literals in shared substrate, embedding distance between Soul DIDs over time, cross-soul provenance audits). **Reasoning**: adapter-side detection puts the burden on every adapter author to instrument drift signals consistently. The framework cannot guarantee detection coverage if it depends on N adapter implementations correctly tagging soul-affecting work. Orchestrator-side is the only path to framework-wide consistency. Adapter-side detection can supplement (adapters can volunteer additional drift signals) but cannot be the primary detection layer.

**Resolution (Option A — orchestrator-side, with sub-decision on staggered rule ship dates):** Detection lives orchestrator-side, not adapter-side. Sub-decision on which rules ship when:

- **Rule #1 (AST scan for soul-name string literals in shared substrate):** ships now in the RFC-0009 implementation phase. No new infrastructure required — AST tooling is already a framework primitive. Covers the highest-frequency drift mode (soul-name leakage in substrate code).
- **Rule #2 (embedding distance between Soul DIDs over time):** deferred to RFC-0019 (Embedding Provider Adapter Framework, just shipped to main as Draft 2026-05-03). When RFC-0019's adapter surface lands and `embedDocument(text)` is callable from the orchestrator, rule #2 becomes ship-able.
- **Rule #3 (cross-soul provenance audits):** deferred to the RFC-0009 implementation phase itself — provenance tagging needs the substrate-vs-soul partition to exist in code (per §8.3 ProvenanceRecord extension) before cross-soul provenance can be audited. Ships once the first generation of tessellated provenance records accumulates.

See §7.2 for the normative table and per-rule mechanism.

### OQ-7 [RESOLVED 2026-05-04 — Carve out; reverses Position-stated]: §13.5 + §13.6 carve out to separate RFCs

**Original position**: §13.5 (session-bug + severity scoring rule) is a Dπ₃ refinement with practitioner validation (caught a real P1→P0 mis-prioritization in a live backlog scoring pass). It belongs in RFC-0009 main as Addendum A (parallel to RFC-0008's Addendum A pattern). §13.6 (incident monitoring + root-cause analysis) requires post-pilot adopter incident volume to validate; ship as RFC-0009.2 follow-on, deferred until that data exists. **Reasoning**: §13.5 has the same evidence quality as the main RFC; §13.6 is correctly speculative until live load arrives.

**Resolution (Carve out to separate RFCs — REVERSAL of Position-stated stance):** Same scope-creep principle as OQ-3 (variant + journey carve-out). Both §13.5 and §13.6 carve out:

- **§13.5 (session-bug + severity scoring rule)** → **RFC-0020** (Draft, has practitioner validation per Alex). RFC-0020 file ships in a follow-on PR; this PR reserves the registry slot.
- **§13.6 (incident monitoring + root-cause analysis)** → **RFC-0021** (RESERVED placeholder, no draft yet — pending adopter incident data).

Sections of v3.2 that referenced §13.5 + §13.6 as candidate sub-sections to fold into RFC-0009 main have been removed. Replaced with the single notice line in §13's header: **"See RFC-0020 (Session-bug + severity scoring rule, Draft) and RFC-0021 (Incident monitoring + root-cause analysis, RESERVED — pending adopter incident data) — both carved out per OQ-7 reversal of Position-stated stance."**

**Reasoning (operator):** RFC-0009 stays focused on tessellation/multi-soul architecture. Dπ₃ refinements + generic PPA additions belong in their own RFCs. The same coherence-vs-scope-creep tension that drove OQ-3's reversal applies here — RFC-0009's normative claim is about tessellation; bundling unrelated PPA refinements gives reviewers an excuse to defer the whole thing while the unrelated material gets re-debated.

**This is a REVERSAL of the original Position-stated stance.** Recorded explicitly so future readers see that the operator weighed the original "same evidence quality" argument against the scope-creep argument and chose scope-creep avoidance.

### OQ-8 [RESOLVED 2026-05-04 — Filed as standalone bug]: HC composite stewardship.designAuthority → HC_design wiring

When an adopter's DSB carries `stewardship.designAuthority.principals: [name]`, the orchestrator's `pillarBreakdown.shared.hcComposite.design` value did not populate. May be: (a) an orchestrator wiring gap in `enrichAdmissionInput`, (b) an unspecified explicit signal channel requirement, or (c) intentional behavior misunderstood by the adopter. Resolution affects how soul-level design authority signals into HC for soul-bounded work.

**Resolution (Filed as standalone framework bug):** Confirmed Alex's triage. Bug filed as **AISDLC-171 (HC composite design pillar wiring)** against RFC-0008/orchestrator. Not in scope for RFC-0009 — RFC-0009 inherits the wiring contract from RFC-0008 unchanged; if the contract has a defect, it gets fixed against RFC-0008 + orchestrator code, not by encoding a workaround in RFC-0009.

### OQ-9 [RESOLVED 2026-05-04 — Filed as standalone bug]: admit confidence ceiling at 0.5 with all readers loaded

With DID + DSB + maintainers + soul-tracks all loaded, admit confidence stayed at 0.5 (expected ≥0.7 given enrichment richness). Suggests confidence is computed from `PriorityInput` field defaults rather than enrichment success.

**Resolution (Filed as standalone framework bug):** Confirmed Alex's triage. Bug filed as **AISDLC-172 (Admit confidence stuck at 0.5 ceiling)** against RFC-0008/orchestrator. Not in scope for RFC-0009 — admit confidence is a PriorityInput-layer concern; RFC-0009's tessellation extensions feed enriched data into that layer but do not change confidence computation. The fix lives against the confidence-computation code path, separable from RFC-0009 acceptance.

### OQ-10 [RESOLVED 2026-05-04 — Option A]: Operator role is platform-scoped, NOT tessellated per soul

**Original position (Alex)**: RFC-0010's Operator role describes pipeline operation (burn rate, harness availability, calibration drift, event triage) which is a property of the platform-level pipeline, not of any individual soul. The fractal triad in §4 stays `{ design, engineering, product }`; Operator is acknowledged as a fourth pillar role that operates at platform scope. Counter-position: souls with radically different operational profiles (e.g., one soul high-volume cheap-stage; another soul low-volume expensive-stage) might warrant per-soul operator overrides. Position-stated rationale: in practice, even radically-different operational profiles are tuned via SubscriptionPlan `tenantQuotaShare` and per-soul `costBudget` declarations rather than by separate operator humans. See §8.8.

**Resolution (Option A — accept Alex's position):** Operator role is **platform-scoped**, NOT tessellated per soul. Per-soul operational differences are tuned via the existing RFC-0010 `SubscriptionPlan.tenantQuotaShare` + per-soul `costBudget` mechanisms. A per-soul Operator role can be added later via a future RFC if/when enterprise demand surfaces (e.g., a Tessellated Platform with so many souls that a single human operator cannot retain context across all of them).

See §8.8 for the normative spec.

### OQ-11 [RESOLVED 2026-05-04 — Option A with trigger checklist]: DatabaseBranchPool tessellation policy default

**Original framing**: When should `DatabaseBranchPool` carry `soulScope`? Two patterns are both valid: (a) shared pool with RLS isolation (default for early-stage Tessellated Platforms), (b) per-soul pool with physical isolation (mature platforms with strict tenant audit/compliance/cost-attribution requirements). The boundary condition — at what platform maturity does (b) become required, not optional — is genuinely open. Engineering pillar (Dom-as-Operator) is the right authority on this; product-pillar has no firm position. See §8.7.

**Resolution (Option A — shared+RLS default; per-shard opt-in via init wizard, with explicit trigger checklist):** Default = shared pool with RLS isolation. Per-shard opt-in is walked by the `init` wizard. Three triggers REQUIRE switching to per-shard:

1. **Regulatory hard requirement** — HIPAA covered entity, PCI-DSS Level 1 merchant, FedRAMP Moderate or High, SOC2 with formal physical-isolation control, regional data residency (GDPR Art. 49, Schrems II, China PIPL, Canadian PIPEDA cross-border).
2. **Customer contract** — vendor agreement explicitly requires tenant physical isolation.
3. **Operator security review** — explicit risk identified that RLS cannot mitigate.

If ANY trigger fires → operator MUST switch to per-shard pool. The framework can advise via the `init` wizard checklist but cannot auto-detect (adopter declares regimes + contracts; operator declares the security-review outcome).

**Cross-reference to RFC-0022 (Compliance Posture + Audit Surface):** RFC-0022 (just drafted via AISDLC-173) is the canonical surface for declaring regulatory regimes; the OQ-11 trigger checklist becomes a **derivedGate computation** in RFC-0022's regime → DerivedGates mapping when adopters use RFC-0022. See §8.7 for the normative spec and the RFC-0022 wiring detail.

### OQ-12 [RESOLVED 2026-05-04 — Option B with RFC-0016 dependency]: Where does soft cost-pressure feed into the composite?

**Original framing**: §7.3 Eρ₆ Cost Clearance is **gating** (categorical 0/1) — work that would exhaust `tenantQuotaShare` is denied. But what about **soft** cost pressure — work that *could* run but *should not* given burn-rate trends? Three candidates: (a) extend Dπ₃ Bug Urgency semantics to include cost-urgency (urgent + costly → different signal than urgent alone), (b) add a new HC channel `HC_cost` that the operator can ratchet to defer expensive work without changing soul/demand scoring, (c) accept that soft cost-pressure is purely operator-managed via `cli-tier-recommendation` + `costBudget` adjustments and doesn't enter the composite at all. Genuinely open; product-pillar has no preference. Engineering authority + Operator (Dom) decides.

**Resolution (Option B — new HC_cost channel, with RFC-0016 data dependency):** New HC channel `HC_cost`. Operator-tunable (default `1.0` = neutral; ratchet down to defer expensive work). Range `0.0–1.0` multiplier on cost-sensitive tasks.

Sub-decisions:

- **What counts as a cost-sensitive task?** Tasks carrying `Stage.maxBudgetUsd` (RFC-0010 §11.4); `HC_cost` is a no-op for tasks without that field.
- **Interaction with Eρ₆ (hard gate)?** Independent — Eρ₆ refuses if hard-budget exceeded; `HC_cost` reduces priority but doesn't refuse. Eρ₆ wins on hard exceedance.
- **Configuration**: `Pipeline.spec.humanChoice.cost: 1.0` (default neutral); env override `AI_SDLC_HC_COST=0.5`.
- **Orchestrator (RFC-0015) integration**: emits `OrchestratorCostPolicyApplied` event when `HC_cost ≠ 1.0` (per RFC-0015 §7 observability).

**Critical RFC-0016 dependency:** `HC_cost` ships as the **lever**; per-task cost data quality grows with RFC-0016 calibration:

- **Today** (RFC-0016 Ready for Review, no calibration data yet): `HC_cost` reads `Stage.maxBudgetUsd` only — crude.
- **RFC-0016 Phase 1** (Stage A signals shipped, class-default fallback): `HC_cost` reads class-default cost estimate from §6.1 wall-clock × token-rate.
- **RFC-0016 Phase 3+** (calibration log flowing, per-class bias multipliers active): `HC_cost` reads accurate per-task cost prediction.

This dependency is explicit and load-bearing. See §7.4 for the normative spec including the per-RFC-0016-phase data quality table.

### OQ-13 [RESOLVED 2026-05-03 — re-affirmed unchanged; Resolved against title rename]: Taxonomy — "multi-soul" + "soul sharding" coexist

**Initial concern (v3.1):** the framing "soul sharding" arguably more accurately describes the pattern than "multi-soul platform." A Tessellated Platform is not N independent souls; it is one platform soul that shards into N coherent faces, each retaining the parent platform's substrate inheritance while specializing for a distinct audience.

**Resolution (v3.2; PPA v1.1 §12 resolved-against-rename; re-affirmed unchanged in v3.3):** product pillar landed on **"multi-soul scoring"** terminology in PPA v1.1 (title + body). The alternate framing **"soul sharding"** survives as accurate vocabulary for the *pattern itself* (mechanism — how it works), complementing **"multi-soul platform"** which describes the *architectural shape* (output — what it produces). Both labels describe the same phenomenon at different abstraction levels and may be used interchangeably depending on emphasis: explain mechanism with "soul sharding"; describe architecture with "multi-soul platform."

The mechanism is fixed; both naming surfaces are accepted. No title rename in v3.2, v3.3, or PPA v1.1. The OQ-4 v3.3 resolution adds: `shard` is retired as a noun entirely; "soul sharding" survives **only as the verb form**, not as a noun substitute.

---

## 14. References

- **PPA v1.0**: Product Priority Algorithm (Alexander Kline, March 2026). The seven-dimension composite formula, per-dimension definitions, and §8 Open Questions including the "Multi-Product Portfolio" question this RFC closes.
- **PPA v1.1**: Product Priority Algorithm — Triad Integration + Tessellation (Alexander Kline, April 2026). Generalizes PPA v1.0 to soul-indexed scoring P(w, s); §3 ER6 Cost Clearance; §4 Design Intent Document ownership model; §5 Tessellated Platforms Multi-Soul Scoring; §7 C8 Cost Governance Integration; §8 HC_product per soul; §9 Pillar Perspective Breakdown with Identity / Expression / Coherence framing; §11 soul-scoped CK; §12 resolved Multi-Product Portfolio question. This RFC is the framework-substrate companion to PPA v1.1's product-pillar architecture.
- **RFC-0005**: Product Priority Algorithm (Alexander Kline, AI-SDLC Contributors). The framework's PPA spec embedding PPA v1.0 as `Pipeline.spec.priorityPolicy`. Lists "Multi-product portfolio-level resource allocation" as a Non-Goal / future work; this RFC is that future work.
- **RFC-0008**: PPA Triad Integration. The DID resource, three-pillar architecture, admission composite, design system binding. §17 PPA v1.1 Direction is the pattern §16 below mirrors.
- **RFC-0010**: Parallel Execution + Worktree Pooling (Dom Legault, April 2026). The cost governance substrate (`SubscriptionPlan`, `WorktreePool`, `DatabaseBranchPool`, `tenantQuotaShare`) that §7.3 Eρ₆ + PPA v1.1 §7 C8 wire into. Operator role specification (operator runbook).
- **RFC-0015** (Autonomous Pipeline Orchestrator, Ready for Review): the orchestrator surface that emits the `OrchestratorCostPolicyApplied` event when §7.4 `HC_cost ≠ 1.0` is in effect (per OQ-12 resolution).
- **RFC-0016** (Estimation Calibration with T-Shirt Sizes, Ready for Review): the calibration substrate that supplies per-task cost predictions to §7.4 `HC_cost`. The data quality of `HC_cost`'s lever effect grows through RFC-0016's phases (crude `Stage.maxBudgetUsd`-only → class-default → calibrated per-task). Critical dependency per OQ-12 resolution.
- **RFC-0017** (reserved per AISDLC-165): In-Shard Variant Pattern. Carved out of RFC-0009 main per OQ-3 (v3.3). Pending normative spec when practitioner validation exists.
- **RFC-0018** (reserved per AISDLC-165): In-Shard Journey Pattern. Carved out of RFC-0009 main per OQ-3 (v3.3). Pending normative spec when practitioner validation exists.
- **RFC-0019** (Embedding Provider Adapter Framework, Draft): supplies the embedding adapter surface that §7.2 detection rule #2 (embedding distance between Soul DIDs over time) depends on. Rule #2 ships when RFC-0019's `embedDocument(text)` adapter call is implementable from the orchestrator (per OQ-6 sub-decision).
- **RFC-0020** (Session-bug + Severity Scoring Rule, Draft — file ships in follow-on PR): carved out of RFC-0009 §13.5 per OQ-7 reversal. Dπ₃ refinement with practitioner validation.
- **RFC-0021** (Incident Monitoring + Root-Cause Analysis, Reserved): carved out of RFC-0009 §13.6 per OQ-7 reversal. Pending adopter incident data before normative spec.
- **RFC-0022** (Compliance Posture + Audit Surface, Draft): canonical surface for declaring regulatory regimes; §8.7 OQ-11 trigger checklist becomes a derivedGate computation in RFC-0022's regime → DerivedGates mapping when adopters use it.
- **RFC-0006**: Design System Governance. The DSB resource's broader governance context.
- **RFC-0001**: Template. Format conventions followed by this RFC.

---

## 16. PPA v1.1 Direction

> **Pattern mirrored from RFC-0008 §17.** This RFC's interim solution embeds in RFC-0008's DID schema what PPA v1.0's architecture cannot express without modification. These are queued for PPA v1.1. They are documented here rather than in PPA v1.0 directly because this RFC is the source of the requirement. When PPA v1.1 is authored, this section is the requirements input.

### v1.1-6: Per-Soul Sα Vector

PPA v1.0 §3 defines Sα as a scalar function `Sα(w)` computed against a single soul purpose definition document. This RFC's interim solution embeds soul-aware Sα in the admission composite (§6) using cross-soul scoring rules on Tessellated DIDs. The architecturally-correct long-term shape is Sα as a vector indexed by soul:

```
Sα(w) → Sα(w, soul_did)
```

with cross-soul aggregation rules (`min`, `max`, `mean`, `weighted-traffic`, `weighted-revenue`) declared on the Tessellated DID's `crossSoulScoringRule` field becoming PPA v1.1 first-class scoring policy, not a per-RFC schema field. The affected-souls scope filter (OQ-2 sub-decision) becomes a primitive of the aggregation rule application rather than an admission-composite-only rule.

**Interim (this RFC):** Soul-aware Sα handled at admission composite via cross-soul scoring rules in tessellation manifest, scoped by dependency-graph affected-souls computation. Sufficient for v1.

**v1.1 work:** Define Sα as a `Map<SoulDid, ScalarScore>` type. Per-soul scoring is the canonical form; scalar `Sα(w)` becomes the single-soul degenerate case. Cross-soul aggregation rules become standard PPA primitives, not RFC-0009 schema.

### v1.1-7: Per-Soul Cκ Tensor

PPA v1.0 §7 defines Cκ as a single scalar calibration coefficient bounded [0.7, 1.3]. RFC-0008 §17 v1.1-2 already proposes per-dimension Cκ. This RFC requires Cκ to additionally be per-soul: each soul's calibration history evolves independently because outcomes can be attributed per-soul via tessellated provenance records (§8.3).

The architecturally-correct long-term shape is Cκ as a tensor indexed by `(soul_did, dimension)`:

```
Cκ → Cκ[soul_did][dimension]
```

For an N-soul, M-dimension PPA, the calibration tensor has N×M cells. Each cell evolves independently, bounded [0.7, 1.3] per cell.

**Interim (this RFC):** Per-soul Cκ aggregation handled in calibration service via tessellation-aware aggregation. Cell count is N×M when tessellation is present; falls back to RFC-0008 §17 v1.1-2's per-dimension scalar when tessellation is absent.

**v1.1 work:** Define Cκ as a `Map<(SoulDid, Dimension), CalibrationCoefficient>` type. Per-soul-per-dimension is the canonical form; the v1.0 scalar and v1.1-2 per-dimension cases become degenerate forms.

### v1.1-8 (forward note): HC_product Channel Per Soul

RFC-0008 §A.8 formalizes Design Authority Signal Monitoring as the channel feeding HC_design. The product-pillar parallel — Product Authority Signal Monitoring per soul — is not yet specified in any RFC. PPA v1.1 should define it: each soul's product authority (the human or team accountable for that soul's product direction) signals into HC_product per soul, parallel to how design authority signals into HC_design.

**Interim (this RFC):** Product authority signals enter the existing HC composite without per-soul differentiation.

**v1.1 work:** Define Product Authority Signal Monitoring per soul. Each Soul DID's `triad.product` may declare a `productAuthority.principals` list; signals from those principals route to HC_product for that soul's work scope.

---

## 15. Appendix A: Reference Implementation — Empirical Proof-by-Existence

This RFC was authored after observing the framework's current shape fail under multi-soul load on a real production multi-product platform. The Appendix documents that observation as empirical proof-by-existence; it is not the proposal's justification. The proposal stands on its own merits per §1-§13 and §16; the Reference Implementation provides additional empirical evidence for review confidence.

A live multi-product platform implementation has authored a Tessellated DID + four Soul DIDs against the patterns proposed in this RFC. The implementation predates the framework's schema acceptance of these fields; all material currently lives at the architecture layer (not in `.ai-sdlc/` config) because the existing `design-intent-document.schema.json` `additionalProperties: false` constraint rejects `tessellation` / `parentTessellation` / `triad` fields. The implementation has authored ~60 backlog items with soul-scoped work and runs the orchestrator's admit pipeline against the live config.

**Empirical observation**: Design pillar locked at 0.40 across all single-soul work. The framework is technically correct given the current schema (one platform-aggregate DSB describing the worst-case soul's coverage); the abstraction is incorrect for the input (single-soul work being scored against platform-aggregate DSB). The implementation's prediction, testable in approximately 5 minutes of admit re-invocation once Phase 1 schema PR lands and per-soul DSBs become authorable: Design pillar lifts from 0.40 → 0.7+ for soul-bounded work. The 0.30-0.30+ delta per-task is the validation evidence.

The implementation's fractal-triad ownership surfaced two practitioner observations relevant to OQ-8 and OQ-9; both are framework issues separable from RFC-0009 acceptance.

The implementation team commits to:
1. Land per-soul DSBs in `.ai-sdlc/souls/<slug>/design-system-binding.yaml` immediately after Phase 1 schema PR merges
2. Re-run admit invocations against TASK-175 + TASK-176 (single-soul work items) and publish before/after Design pillar values as validation evidence
3. Run Phase 4 (Cκ flywheel) for one sprint cycle and publish per-soul, per-dimension calibration data

**The reference implementation does not require special framework consideration; it asks the framework to recognize the structural distinction the implementation has empirically validated.** Multi-product platforms with shared substrate are common (Stripe, Notion, Figma, Shopify cited in §2.2). The implementation's value to the framework is empirical confidence that the proposal works as designed at scale on a real codebase, not a request for accommodation.

---

*v3.3 authored 2026-05-03 by Dominique (operator walkthrough). Resolved OQ-1 through OQ-5 + re-affirmed OQ-13. Variant + journey patterns carved out to RFC-0017/0018 (REVERSAL of Alex's original Position-stated stance per OQ-3). Naming landed on Tessellated Platform / Soul / Tessellation; `shard` retired as noun, `soul sharding` retained as mechanism verb form. Triad now required everywhere with `init`-scaffolded defaults (BREAKING CHANGE acknowledged). Eρ₅ scope clarified to hard regulatory frameworks only with formal external-audit consequences. crossSoulScoringRule default `min` now explicitly scoped to dependency-graph-computed affected souls, not all souls in the platform.*

*v3.4 authored 2026-05-04 by Dominique (operator walkthrough). Resolved the remaining 7 of 13 open questions: OQ-6 (Option A — orchestrator-side detection with staggered rule ship dates: rule #1 in RFC-0009 impl, rule #2 awaits RFC-0019 impl, rule #3 awaits RFC-0009 impl provenance), OQ-7 (REVERSAL — §13.5 + §13.6 carved to RFC-0020 + RFC-0021 per same scope-creep principle as OQ-3), OQ-8 (filed as AISDLC-171 framework bug), OQ-9 (filed as AISDLC-172 framework bug), OQ-10 (Option A — Operator role platform-scoped, not tessellated), OQ-11 (Option A — shared+RLS pool default with explicit trigger checklist; cross-references RFC-0022 for adopters using compliance-posture declarations), OQ-12 (Option B — new HC_cost soft-pressure channel, lever-and-data-quality split with RFC-0016 calibration dependency). All 13 OQs now resolved (OQ-1-12 active + OQ-13 already resolved against title rename in v3.2). RFC-0009 is structurally complete; awaits Engineering + Design pillar sign-off.*
