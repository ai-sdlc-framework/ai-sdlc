---
id: RFC-0029
title: Product Pillar — Architectural Vision (Design Principles, Framework Positions, Strategic Direction)
status: Draft
lifecycle: Draft
author: Alexander Kline
created: 2026-05-04
updated: 2026-05-04
targetSpecVersion: v1alpha1
requires:
  - RFC-0005
  - RFC-0008
  - RFC-0009
requiresDocs: []
---

# RFC-0029: Product Pillar — Architectural Vision

**Document type:** Standing reference (non-normative)
**Status:** Draft v1 — Standing reference document. Cited by future Product-Authority RFC reviews rather than re-derived per RFC.
**Lifecycle:** Draft
**Author:** Alexander Kline (Head of Product Strategy / Product Authority; PPA v1.0/v1.1 author + RFC-0009 v3.2 author)
**Audience:** Dom Legault (CTO / Engineering Authority) + Morgan Hirtle (Chief of Design / Design Authority)
**Requires:** RFC-0005 (PPA), RFC-0008 (PPA Triad Integration), RFC-0009 (Tessellated DIDs)

> The bold-style status block above is preserved for human readability. The YAML frontmatter at the top of the file is the source of truth for tooling.

---

## Sign-Off

| Person | Role | Status | Date |
|--------|------|--------|------|
| Alexander Kline | Head of Product Strategy / Product Authority | ✅ Authored + endorsed v1 | 2026-05-04 |
| Dominique Legault | CTO / Engineering Authority | ⏸ Pending | — |
| Morgan Hirtle | Chief of Design / Design Authority | ⏸ Pending | — |

## Revision History

| Version | Date | Author | Notes |
|---------|------|--------|-------|
| v1 | 2026-05-04 | Alexander | Initial draft. Standing reference articulating the Product pillar's design principles, positions on all active RFCs (0014, 0015, 0016, 0017, 0018, 0019, 0022, 0023, 0024, 0025, 0026, 0027), and strategic direction. Composed to reduce the need to re-derive positions in future RFC reviews. |

---

## 1. Purpose

This document states the Product pillar's architectural vision for the AI-SDLC framework. It articulates the design principles that govern PPA and the triad integration, provides Product positions on all active RFCs, and describes the strategic direction the framework is heading.

It is intended as a standing reference that future RFC reviews, PPA revisions, and implementation decisions can cite rather than re-derive.

---

## Part I: Design Principles

These are not negotiable preferences. They are structural properties of the framework that, if violated, break the governance model. Each principle has been validated through the PPA v1.0–v1.3 development cycle and the RFC-0006 through RFC-0027 review process.

### Principle 1: The Three-Axis Basis

The framework operates on three orthogonal axes of authorship. Each pillar has structural sovereignty over one axis.

**Identity (Product).** What the product IS. Who it serves, what scope it occupies, what constraints it will not violate. Product DECLARES identity. The DID's mission, experiential targets, scope boundaries, and constraints are Product's authorship surface. SA1 (Problem Resonance), D (Demand Pressure), M (Market Force), and ET (Entropy Tax) are Product-governed dimensions.

**Expression (Design).** How the product APPEARS, FEELS, SOUNDS. The visible manifestation of identity. Design EXPRESSES identity. The DID's design principles, brand identity, and visual identity are Design's authorship surface. SA2 (Vibe Coherence) and ER4 (Design System Readiness) are Design-governed dimensions.

**Execution (Engineering).** Engineering MAINTAINS coherence between Identity and Expression at runtime. Engineering does not declare new intent. Engineering's function is enforcement: quality gates, compliance regimes, autonomy policies, cost governance, merge coordination, pipeline orchestration. ER1–3 (Resource Availability, Build Complexity, Dependency Clearance), ER5 (Compliance Clearance), ER6 (Cost Clearance), and CK (Calibration) are Engineering-governed dimensions.

**The asymmetry is the load-bearing wall.** Engineering is deliberately not symmetric with Product and Design. It authors at the enforcement layer because enforcement IS its function. Adding intent-layer fields to Engineering (e.g., "executionPrinciples" in the DID) would break the basis by giving three pillars the same kind of authority when they structurally need different kinds of authority. This asymmetry replicates fractally: a shard-level Engineering authority maintains shard-level coherence, just as platform-level Engineering maintains platform-level coherence.

**The multiplicative composite enforces orthogonality.** Zero on any axis zeros the whole score. Product can veto via SA1. Design can veto via ER4. Engineering can veto via ER2. Each veto is the same formal operation (multiplication by zero) but a different functional operation (identity violation, expression incoherence, execution infeasibility).

### Principle 2: Deterministic-First

Every evaluation in the framework follows the same layered pattern: deterministic checks first, structural analysis second, LLM evaluation last. Each layer handles only what the layer below cannot.

This pattern appears in:

- **PPA SA scoring (v1.2):** Layer 1 compiled DID rules, Layer 2 BM25, Layer 3 structured LLM assessment
- **RFC-0006 design review:** Deterministic token compliance, then structural component coverage, then LLM design review
- **RFC-0007 prototype validation:** Structural integrity, token compliance, catalog coverage, then DID traceability, then design authority checkpoint
- **RFC-0011 DoR gate:** Regex/link/structure checks (Stage A), then binary LLM yes/no per gate (Stage B)

Four documents, same architecture. This is not coincidence. It is a design principle. Deterministic checks are cheap, reproducible, and auditable. LLM checks are expensive, non-deterministic, and opaque. The framework minimizes its dependence on LLM judgment by resolving everything it can without one.

Any future RFC that introduces an evaluation mechanism SHOULD follow this pattern. If it doesn't, it should explain why deterministic-first doesn't apply.

### Principle 3: The DID as Canonical Soul Reference

The Design Intent Document is the framework's shared root of identity. It is not a PPA artifact. It is a framework artifact that PPA, RFC-0006, RFC-0007, and every future governance mechanism references.

- PPA scores work items against the DID
- RFC-0006 design system enforcement is grounded in the DID
- RFC-0007 grounds prototype generation prompts in the DID's design principles
- RFC-0011 DoR gate evaluates actionability, then PPA evaluates soul alignment against the DID
- RFC-0009 tessellates the DID into platform + shard levels

Any future RFC that introduces a new governance evaluation SHOULD consume the DID rather than creating a parallel soul document. Parallel soul documents create divergence problems. The DID is the single source of truth for "what this product is."

The DID is the best available articulation of the product's identity, not the identity itself. The identity is the convergence of what was stated, what was built, what was validated, and what the market rewarded. A well-written DID has high fidelity to this convergence. A poorly written DID has low fidelity. The DID Evolution Loop (PPA v1.3) is the mechanism that keeps the DID's fidelity high by proposing revisions when accumulated evidence shows the articulation has drifted from reality.

### Principle 4: The Soul Holds

Demand that contradicts the product's identity is surfaced, not amplified. The signal ingestion pipeline filters demand through SA resonance before it enters D1. High-SA demand gets full weight. Low-SA demand gets discounted and flagged for Product review. Zero-SA demand is excluded.

This is the mechanism that prevents the product from becoming whatever the loudest customer asks for. The algorithm listens to the market. It does not obey the market. Product Lead reviews low-SA demand and decides: is this legitimate scope expansion (update the DID) or is this demand for a different product?

The SoulDriftDetected event fires when aggregate SA resonance declines. But not all drift is bad. Drift in response to real customer needs is the system working. The product evolves naturally toward the sunlight. v1.3's healthy/unhealthy drift classification distinguishes between a DID that hasn't kept up with legitimate evolution (healthy: update the DID) and a product being pulled off course by noise (unhealthy: tighten admission thresholds).

### Principle 5: Governance by Composition, Not by Monolith

The admission chain is a series of independent, orthogonal gates composed in sequence:

```
Signal Ingestion → DoR Gate (RFC-0011) → PPA Admission (v1.1) → PPA Runtime (v1.1)
  → Execution (RFC-0010) → Review (RFC-0010) → Merge Gate (RFC-0010)
    → Calibration (v1.2 flywheel) → DID Evolution (v1.3)
```

Each gate evaluates one axis. Each gate's failure has a distinct remediation. Conflating gates (e.g., baking DoR into PPA, or cost governance into soul alignment) produces composite scores that don't tell you which axis failed or what to do about it.

Any future RFC that introduces a new gate SHOULD compose with the existing chain rather than replacing or duplicating an existing gate's function.

### Principle 6: Executive Layer Above, Not Within

The triad is {Product, Design, Engineering}. The Operator role aligns with Engineering authority at platform scope. But cost posture, budget allocation, subscription tier decisions, and cross-shard resource tradeoffs are ultimately executive functions. CEOs, board directors, and budget holders set these from quarterly patterns.

The framework's interface to the executive layer is currently the burst mechanism's `onDisagreement: escalate-to-executive` (PPA v1.3 Change 1). When Product and Operator disagree on spend, neither wins. The decision elevates above both.

Specifying the executive layer fully (who occupies it, cadence, decision format) is deferred. But the principle is stated: the executive layer operates above the triad as context and constraint, not as a fourth pillar within it. The triad governs what gets built and how. The executive layer governs how much can be spent and what strategic direction the triad should be heading.

---

## Part II: Product Positions on Active RFCs

Positions on RFCs not previously formally responded to.

### RFC-0014: Dependency Graph Composition

**Position: Endorse.** The formal dependency graph feeds ER3 (Dependency Clearance) with structured data instead of manual tracking. When RFC-0014 ships, PPA's ER3 should consume its graph output. This is Engineering-axis infrastructure that Product has no concerns about. No PPA spec changes needed until implementation, at which point ER3's dependency resolution mechanism gets a formal adapter.

### RFC-0015: Autonomous Pipeline Orchestrator

**Position: Endorse with framing.** PPA's governance chain (signal ingestion, DoR, admission, scoring, execution, calibration, DID evolution) IS the decision substrate that RFC-0015 orchestrates. The autonomous pipeline is not a separate system. It is the composition of every gate in the admission chain running continuously without human intervention except at the points where human judgment is structurally required: soul authorship, merge approval, burst spend arbitration, and drift classification triage.

The human's role in the autonomous pipeline is: author the initial soul, approve identity evolution proposals, handle ambiguous drift classifications, approve burst spend requests, and click merge. Soul authorship plus exception handling.

### RFC-0016: Estimation Calibration with T-Shirt Sizes

**Position: Endorse.** T-shirt estimation gives ER2 better bootstrap values before the AI-SDLC's complexity assessment runs. The interaction with PPA is clean: RFC-0016 produces estimation data, ER2 consumes it. No governance concerns. Note: t-shirt sizes also inform the SubscriptionLedger's headroom calculations (RFC-0010 Section 14) and should be cross-referenced there.

### RFC-0017: In-Soul Variant Pattern

**Position: Endorse pending v0.2 review completion.** Variant=audience-specific carries SA1 (audience definition) implications. Co-review per Mo's RFC-0009 v3.4 C2 condition applies: variants reach into `product.targetAudience` + `product.problemResonance` territory, which are Product-Design co-authorship fields. PPA v1.1 §5 already incorporates variant scoring (inherits shard, may add ER5 gates). Engineering pass to v0.2 is in flight; Product endorsement contingent on the v0.2 + v1.0+ normative spec preserving the parent-soul tightening-only inheritance for compliance regimes.

### RFC-0018: In-Soul Journey Pattern

**Position: Endorse pending v0.2 review completion.** Journey=success metrics implies SA1 (problem resonance per stage) + ER4 (design system readiness per journey state) entanglement. PPA's Pillar Perspective Breakdown applies cleanly to journeys: a journey can have Product HIGH / Design LOW (right need, system not ready) or Engineering HIGH / Product LOW (easy to build, weak strategic value). PPA v1.1 §5 already incorporates journey scoring (may affect SA2). Endorsement contingent on the v0.2 + v1.0+ normative spec preserving accessibility floors per Mo's C3 commitment.

### RFC-0019: Embedding Provider Adapter

**Position: Endorse with note.** PPA v1.2's structural layer uses BM25 (deterministic, model-independent). If embedding-based retrieval is ever added as a supplement (not replacement) to BM25, RFC-0019's adapter framework provides the pluggable interface. The structural weight floor (`w_structural >= 0.20`) ensures BM25 always contributes regardless of what other retrieval mechanisms are added.

Product position: BM25 remains the primary structural scorer. Embedding providers are enrichment, not replacement.

### RFC-0022: Compliance Posture + Audit Surface

**Position: Endorse strongly.** This is the implementation surface for PPA v1.1's ER5 (Compliance Clearance). PPA introduced ER5 as a dimension but never specified how compliance regimes are declared. RFC-0022 IS that specification. The Product pillar endorses RFC-0022 as a required companion to ER5. Every tessellated platform with shard-specific compliance regimes needs this.

Additionally, RFC-0022's audit evidence packs are the compliance counterpart to PPA v1.3's governance reporting layer. The governance report's cost section and the compliance audit pack should share a common evidence format so operators don't maintain two parallel reporting surfaces.

### RFC-0023: Operator TUI

**Position: Endorse, no PPA concerns.** The TUI consumes PPA output (pillar breakdown, burn-down reports, drift events, DoR verdicts). It does not influence PPA scoring. This is a pure observability surface.

Product's only note: the TUI should surface the healthy/unhealthy drift classification (PPA v1.3 Change 5) prominently. Operators need to see at a glance whether drift is the system working or the system failing.

### RFC-0024: Emergent Issue Capture + Triage

**Position: Endorse with PPA integration.** Emergent issues discovered mid-execution are a real workflow. PPA v1.3 adds `sourceType: emergent` to AdmissionInput for these. The critical interaction: emergent issues bypass DoR (they're findings from in-flight work, not authored issues) and enter PPA admission directly. RFC-0024's triage rubric (quick-fix vs scope-creep vs new strategic item) determines whether the emergent issue stays in the current execution context, gets rejected back to backlog via normal DoR, or enters PPA admission as a new item.

Product endorses this three-way triage. The fourth disposition ("not actionable") should also be supported as a first-class outcome — operators discover findings that are real but not work-shaped (e.g., "this whole approach is wrong, file a new RFC"). Treating these as "new strategic item" creates noise; treating them as "discard" loses the finding. A "park for later" disposition with a structured findings log preserves the signal.

### RFC-0025: Framework Quality Monitoring

**Position: Endorse with calibration note.** The distinction between "operator under-decided" and "framework misbehaved" is important for PPA's calibration loop. A bad score caused by a framework bug is not evidence of a bad scoring model. When RFC-0025's failure taxonomy identifies a framework failure, the corresponding scoring decision should be excluded from CK calibration data. Otherwise the flywheel learns from noise.

PPA v1.3 notes this as a v1.4 deferral; Product wants it tracked. The exclusion mechanism should be a one-bit flag on the calibration log entry (`frameworkFailureExcluded: true`) rather than a separate routing pipeline — keeps the data simple, lets the calibration aggregator decide whether to honor the flag.

### RFC-0026: Exploration Workstream Pattern

**Position: Endorse with PPA integration specified.** PPA v1.3 Change 9 defines exploration scoring mode: exploration work bypasses DoR and the standard PPA composite, enters a separate queue scored by SA1 × time-box-urgency only, and re-enters the standard pipeline when it produces a handoff artifact. This preserves PPA's integrity (the composite scores what it's designed to score) while giving exploration a governed pathway.

Product's philosophical position: exploration is pre-strategic work. Its purpose is to produce the knowledge that makes strategic scoring possible. PPA should not score exploration with the full composite because the full composite requires exactly the inputs that exploration is trying to discover (testable criteria, bounded scope, demand signal, execution feasibility). Scoring exploration through the execution-ready composite produces near-zero scores, which means the autonomous pipeline would never pick up exploration work. That's wrong.

### RFC-0027: Design Coherence Drift Detection

**Position: Endorse as ET_tessellation extension (when filed).** This is the fourth detection rule for ET_tessellation_drift (PPA v1.1 §3). It fires when the delta between a soul's design imperatives and what the DSB/component catalog implements exceeds threshold. This is a Design-axis drift signal that ET surfaces to the triad.

Product endorses Morgan's authorship of this RFC and notes that the drift signal should flow into the SoulDriftDetected event's `driftSource.expressionDrift` field (PPA v1.2/v1.3).

### RFC-0009 v3.4: Tessellated DIDs

**Position: Sign-off DELIVERED.** Product authored v3.2; v3.4 incorporates Engineering + Design feedback and resolves all 13 OQs. Sign-off filed and merged into main on 2026-05-04. PPA v1.1 §5 already incorporates the tessellation architecture.

---

## Part III: Strategic Direction

### Where We Are

PPA v1.1 defines the governance structure: what gets scored, who has authority, how multi-soul platforms are handled. Seven dimensions, eight triad connections, tessellated DID hierarchy, cross-shard scoring rules, in-shard sub-structures.

PPA v1.2 (drafted, pending Design Authority Addendum B sign-off) defines the scoring intelligence: how soul alignment is measured. Three-layer deterministic-first assessment, identity classification, drift detection, feedback flywheel.

PPA v1.3 (drafted, internal working draft) defines the closed-loop governance: how the system learns and evolves. Signal ingestion, DID evolution proposals, cost-effort governance, healthy/unhealthy drift classification, exploration workstream, DoR/PPA composition, governance reporting.

### Where We're Going

The framework is building toward a system where:

1. **Signals enter automatically.** Support tickets, community discussions, CRM data, competitive intelligence, in-app feedback flow through classified, clustered, SA-filtered pipelines into the demand surface. No human manually creates backlog items from customer conversations.

2. **Quality is gated automatically.** DoR checks actionability. PPA checks strategic alignment. Design system governance checks expression coherence. Compliance posture checks regulatory constraints. Each gate evaluates one axis. Each gate's failure has a distinct remediation.

3. **Execution is parallel and cost-governed.** N agents on M shards, each on the right model and harness for their stage, scheduled to maximize subscription utilization, with independent cross-harness review catching what same-harness review misses.

4. **The soul evolves from evidence.** The DID is not a static document. The feedback flywheel accumulates human judgment signals. Demand clusters reveal what users actually need. Calibration data reveals what scoring decisions were wrong. The DID Evolution Loop proposes revisions. The triad approves. The soul stays true to its gravitational center while evolving its expression.

5. **Drift is classified, not just detected.** Healthy drift (the product responding to real needs) triggers DID revision proposals. Unhealthy drift (noise overwhelming signal) triggers admission tightening. Ambiguous drift triggers triad review. The system doesn't just say "you're drifting." It says "here's why, here's what kind of drift it is, and here's the recommended response."

6. **The human tends the soul.** The human's role is: author the initial identity, approve evolution proposals, handle ambiguous drift, approve burst spend, click merge. Soul authorship plus exception handling. Everything else is governed by the composition of gates, each doing its job on its axis.

This is not a future state. It is the architecture that PPA v1.1 through v1.3 and RFC-0002 through RFC-0027 collectively describe. The pieces are in place. Implementation and calibration remain.

### The Gravitational Center

The framework's structures (DID with identity classification, feedback flywheel, demand clusters with SA resonance, calibration outcomes, drift detection with axis breakdown) are all data streams that could, in a future revision, feed a computed representation of "what this product actually is" derived from accumulated evidence rather than a single authored document.

The DID would remain the best available articulation of this computed identity, but the identity itself would be the convergence of: what was stated (DID core fields, weighted highest as the gravitational anchor), what was built (calibration outcomes), what was validated (demand cluster patterns and ICP resonance), and what the market rewarded (adoption, retention, revenue impact from post-ship calibration data).

PPA v1.3 does not compute this. It lays the architectural foundation so that computing it is possible without changing the governance surface. The interfaces are stable. The detection mechanisms can evolve behind them. The DID Evolution Loop is the first step: it proposes DID revisions based on accumulated evidence, which is a human-mediated version of the same convergence computation.

The computed identity is the long-term direction. The DID is the bridge. The governance chain is what makes the bridge traversable.

---

## How this document is used

This document is a **standing reference**. Specifically:

- Future RFC reviews from the Product pillar SHOULD cite the relevant Part I principle and Part II position rather than re-deriving the position.
- New RFCs that introduce evaluation mechanisms SHOULD map themselves to Principle 2 (Deterministic-First) and explain any deviation.
- New RFCs that introduce governance gates SHOULD map themselves to Principle 5 (Governance by Composition) and explain how they compose with the existing chain.
- New RFCs that introduce intent-layer concepts SHOULD map themselves to Principle 1 (Three-Axis Basis) and clarify which axis they extend.
- This document is revised when new design principles emerge or existing principles are challenged by production evidence.

---

**End of RFC-0029.**
